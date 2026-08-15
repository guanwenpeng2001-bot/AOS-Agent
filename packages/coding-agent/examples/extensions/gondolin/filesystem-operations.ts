import path from "node:path";
import type {
	SandboxDirectoryEntry,
	SandboxOperationRequest,
	SandboxOperationResult,
} from "../../../src/core/sandbox.ts";
import {
	GondolinAdapterError,
	createGondolinPathMapper,
	type GondolinPathMapper,
	type GondolinPathMapperOptions,
	type GuestPathOptions,
} from "./path-mapper.ts";
import type { GondolinVmLike } from "./vm-types.ts";

const DEFAULT_MAX_RESULTS = 1000;
const DEFAULT_MAX_GREP_MATCHES = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
const DEFAULT_MAX_LINE_LENGTH = 500;
const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export interface GondolinGuestStat {
	isDirectory(): boolean;
}

export interface GondolinGuestFilesystem {
	access(pathName: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
	mkdir(pathName: string, options?: { readonly recursive?: boolean; readonly signal?: AbortSignal }): Promise<void>;
	listDir(pathName: string, options?: { readonly signal?: AbortSignal }): Promise<string[]>;
	stat(pathName: string, options?: { readonly signal?: AbortSignal }): Promise<GondolinGuestStat>;
	readFile(pathName: string, options: { readonly encoding: null; readonly signal?: AbortSignal }): Promise<Buffer>;
	readFile(pathName: string, options: { readonly encoding: BufferEncoding; readonly signal?: AbortSignal }): Promise<string>;
	writeFile(
		pathName: string,
		data: string | Buffer,
		options?: { readonly encoding?: BufferEncoding; readonly signal?: AbortSignal },
	): Promise<void>;
}

export interface GondolinFilesystemVm {
	readonly fs: GondolinGuestFilesystem;
}

export interface GondolinFilesystemOperationOptions {
	readonly maxResults?: number;
	readonly maxGrepMatches?: number;
	readonly maxOutputBytes?: number;
	readonly maxLineLength?: number;
	readonly ignoredDirectories?: ReadonlySet<string>;
	readonly onSideEffectStart?: () => void;
}

/** Shared provider-to-adapter context. It contains no host I/O capability. */
export interface GondolinOperationContext {
	readonly vm: GondolinVmLike;
	readonly workspaceRoot: string;
	readonly pathMapper?: GondolinPathMapper;
	readonly pathMapperOptions?: Omit<GondolinPathMapperOptions, "workspaceRoot">;
	readonly onSideEffectStart?: () => void;
}

export interface GondolinFilesystemOperations {
	readonly execute: (request: SandboxOperationRequest) => Promise<SandboxOperationResult>;
	readonly readFile: (pathName: string, signal?: AbortSignal) => Promise<Buffer>;
	readonly writeFile: (pathName: string, content: string, signal?: AbortSignal) => Promise<void>;
	readonly listDirectory: (
		pathName: string,
		limit?: number,
		signal?: AbortSignal,
	) => Promise<SandboxOperationResult>;
	readonly find: (request: SandboxOperationRequest) => Promise<SandboxOperationResult>;
	readonly grep: (request: SandboxOperationRequest) => Promise<SandboxOperationResult>;
}

type GuestVisit = (
	guestPath: string,
	relativePath: string,
	stat: GondolinGuestStat,
) => Promise<boolean>;

function safeFilesystemError(): GondolinAdapterError {
	return new GondolinAdapterError("sandbox_unavailable", "The guest filesystem operation failed.");
}

function safePolicyError(): GondolinAdapterError {
	return new GondolinAdapterError("policy_violation", "The guest filesystem request is invalid.");
}

function abortedError(): GondolinAdapterError {
	return new GondolinAdapterError("sandbox_unavailable", "Operation aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortedError();
}

function positiveLimit(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

async function guestCall<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	try {
		const result = await operation();
		throwIfAborted(signal);
		return result;
	} catch (error) {
		if (error instanceof GondolinAdapterError) throw error;
		if (signal?.aborted) throw abortedError();
		throw safeFilesystemError();
	}
}

function requirePath(request: SandboxOperationRequest): string {
	if (typeof request.path !== "string" || request.path.length === 0) throw safePolicyError();
	return request.path;
}

function normalizeGuestCandidate(root: string, candidate: string): string | undefined {
	const normalizedRoot = path.posix.normalize(root);
	const normalizedCandidate = path.posix.normalize(candidate);
	if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}/`)) return undefined;
	return normalizedCandidate;
}

function matchesGlob(relativePath: string, pattern: string): boolean {
	const normalizedPath = relativePath.split("\\").join("/");
	const normalizedPattern = pattern.split("\\").join("/");
	try {
		if (normalizedPattern.includes("/")) {
			return (
				path.posix.matchesGlob(normalizedPath, normalizedPattern) ||
				path.posix.matchesGlob(normalizedPath, `**/${normalizedPattern}`)
			);
		}
		return path.posix.matchesGlob(path.posix.basename(normalizedPath), normalizedPattern);
	} catch {
		return false;
	}
}

function createLineMatcher(
	pattern: string,
	literal: boolean | undefined,
	ignoreCase: boolean | undefined,
): (line: string) => boolean {
	if (CONTROL_CHARACTER_PATTERN.test(pattern)) throw safePolicyError();
	if (literal) {
		const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
		return (line: string): boolean => (ignoreCase ? line.toLocaleLowerCase() : line).includes(needle);
	}
	try {
		const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
		return (line: string): boolean => regex.test(line);
	} catch {
		throw safePolicyError();
	}
}

function truncateLine(line: string, maxLineLength: number): string {
	const normalized = line.replace(/\r/g, "");
	return normalized.length > maxLineLength ? normalized.slice(0, maxLineLength) : normalized;
}

function mimeTypeForPath(guestPath: string): string | undefined {
	switch (path.posix.extname(guestPath).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".bmp":
			return "image/bmp";
		default:
			return undefined;
	}
}

async function walkGuestFiles(
	filesystem: GondolinGuestFilesystem,
	root: string,
	visit: GuestVisit,
	ignoredDirectories: ReadonlySet<string>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	const rootStat = await guestCall(() => filesystem.stat(root, { signal }), signal);
	if (!rootStat.isDirectory()) {
		await visit(root, path.posix.basename(root), rootStat);
		return;
	}

	const walkDirectory = async (directory: string, relativeDirectory: string): Promise<boolean> => {
		throwIfAborted(signal);
		const entries = await guestCall(() => filesystem.listDir(directory, { signal }), signal);
		for (const entry of entries) {
			throwIfAborted(signal);
			if (ignoredDirectories.has(entry)) continue;
			const guestPath = normalizeGuestCandidate(root, path.posix.join(directory, entry));
			if (guestPath === undefined) continue;
			const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry) : entry;
			let entryStat: GondolinGuestStat;
			try {
				entryStat = await guestCall(() => filesystem.stat(guestPath, { signal }), signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				continue;
			}
			if (entryStat.isDirectory()) {
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath, entryStat))) {
				return false;
			}
		}
		return true;
	};

	await walkDirectory(root, "");
}

function appendBoundedLine(lines: string[], line: string, currentBytes: number, maxBytes: number): number | undefined {
	const next = `${lines.length === 0 ? "" : "\n"}${line}`;
	const nextBytes = Buffer.byteLength(next, "utf8");
	if (currentBytes + nextBytes > maxBytes) return undefined;
	lines.push(line);
	return currentBytes + nextBytes;
}

function isFilesystemVm(value: GondolinFilesystemVm | GondolinGuestFilesystem): value is GondolinFilesystemVm {
	return "fs" in value;
}

function guestFilesystemFrom(value: GondolinFilesystemVm | GondolinGuestFilesystem): GondolinGuestFilesystem {
	return isFilesystemVm(value) ? value.fs : value;
}

function mapOptionsForPath(options: GuestPathOptions = {}): GuestPathOptions {
	return { allowMissing: options.allowMissing ?? true };
}

export function createGondolinFilesystemOperations(
	vmOrFilesystem: GondolinFilesystemVm | GondolinGuestFilesystem,
	pathMapper: GondolinPathMapper,
	options: GondolinFilesystemOperationOptions = {},
): GondolinFilesystemOperations {
	const filesystem = guestFilesystemFrom(vmOrFilesystem);
	const maxResults = positiveLimit(options.maxResults, DEFAULT_MAX_RESULTS);
	const maxGrepMatches = positiveLimit(options.maxGrepMatches, DEFAULT_MAX_GREP_MATCHES);
	const maxOutputBytes = positiveLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
	const maxLineLength = positiveLimit(options.maxLineLength, DEFAULT_MAX_LINE_LENGTH);
	const ignoredDirectories = options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES;
	const onSideEffectStart = options.onSideEffectStart;

	const readFile = async (pathName: string, signal?: AbortSignal): Promise<Buffer> => {
		const guestPath = await pathMapper.toGuestPath(pathName, mapOptionsForPath());
		const content = await guestCall(() => filesystem.readFile(guestPath, { encoding: null, signal }), signal);
		return Buffer.isBuffer(content) ? content : Buffer.from(content);
	};

	const writeFile = async (pathName: string, content: string, signal?: AbortSignal): Promise<void> => {
		const guestPath = await pathMapper.toGuestPath(pathName, mapOptionsForPath());
		const parent = path.posix.dirname(guestPath);
		onSideEffectStart?.();
		await guestCall(() => filesystem.mkdir(parent, { recursive: true, signal }), signal);
		await guestCall(() => filesystem.writeFile(guestPath, content, { encoding: "utf8", signal }), signal);
	};

	const listDirectory = async (
		pathName: string,
		limit?: number,
		signal?: AbortSignal,
	): Promise<SandboxOperationResult> => {
		const guestPath = await pathMapper.toGuestPath(pathName, mapOptionsForPath());
		const stat = await guestCall(() => filesystem.stat(guestPath, { signal }), signal);
		if (!stat.isDirectory()) return { isDirectory: false, entries: [] };
		const entries = await guestCall(() => filesystem.listDir(guestPath, { signal }), signal);
		const effectiveLimit = Math.min(positiveLimit(limit, maxResults), maxResults);
		const boundedEntries: SandboxDirectoryEntry[] = [];
		for (const entry of entries.slice(0, effectiveLimit)) {
			throwIfAborted(signal);
			const childPath = normalizeGuestCandidate(guestPath, path.posix.join(guestPath, entry));
			if (childPath === undefined) continue;
			let childStat: GondolinGuestStat;
			try {
				childStat = await guestCall(() => filesystem.stat(childPath, { signal }), signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				continue;
			}
			boundedEntries.push({ name: entry, isDirectory: childStat.isDirectory() });
		}
		return { isDirectory: true, entries: boundedEntries };
	};

	const find = async (request: SandboxOperationRequest): Promise<SandboxOperationResult> => {
		const rootInput = request.path ?? request.cwd ?? pathMapper.workspaceRoot;
		const root = await pathMapper.toGuestPath(rootInput, mapOptionsForPath());
		const pattern = request.pattern ?? request.glob ?? "*";
		const effectiveLimit = Math.min(positiveLimit(request.limit, maxResults), maxResults);
		const results: string[] = [];
		await walkGuestFiles(filesystem, root, async (_guestPath, relativePath) => {
			if (results.length >= effectiveLimit) return false;
			if (matchesGlob(relativePath, pattern)) results.push(relativePath);
			return results.length < effectiveLimit;
		}, ignoredDirectories, request.signal);
		return { exitCode: 0, entries: results };
	};

	const grep = async (request: SandboxOperationRequest): Promise<SandboxOperationResult> => {
		const rootInput = request.path ?? request.cwd ?? pathMapper.workspaceRoot;
		const root = await pathMapper.toGuestPath(rootInput, mapOptionsForPath());
		const rootStat = await guestCall(() => filesystem.stat(root, { signal: request.signal }), request.signal);
		const rootIsDirectory = rootStat.isDirectory();
		if (typeof request.pattern !== "string") throw safePolicyError();
		const matcher = createLineMatcher(request.pattern, request.literal, request.ignoreCase);
		const resultRoot = await pathMapper.toSafeHostPath(rootInput, mapOptionsForPath());
		const glob = request.glob;
		const effectiveLimit = Math.min(positiveLimit(request.limit, maxGrepMatches), maxGrepMatches);
		const lines: string[] = [];
		let outputBytes = 0;
		let matches = 0;

		await walkGuestFiles(filesystem, root, async (guestPath, relativePath) => {
			if (matches >= effectiveLimit) return false;
			if (glob !== undefined && !matchesGlob(relativePath, glob)) return true;
			let content: string;
			try {
				content = await guestCall(
					() => filesystem.readFile(guestPath, { encoding: "utf8", signal: request.signal }),
					request.signal,
				);
			} catch (error) {
				if (request.signal?.aborted) throw error;
				return true;
			}
			const fileLines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const resultPath = rootIsDirectory ? path.resolve(resultRoot, relativePath) : resultRoot;
			for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex++) {
				throwIfAborted(request.signal);
				if (!matcher(fileLines[lineIndex] ?? "")) continue;
				const lineText = truncateLine(fileLines[lineIndex] ?? "", maxLineLength);
				const matchRecord = JSON.stringify({
					type: "match",
					data: {
						path: { text: resultPath },
						line_number: lineIndex + 1,
						lines: { text: `${lineText}\n` },
					},
				});
				const nextBytes = appendBoundedLine(lines, matchRecord, outputBytes, maxOutputBytes);
				if (nextBytes === undefined) return false;
				outputBytes = nextBytes;
				matches++;
				if (matches >= effectiveLimit) return false;
			}
			return true;
		}, ignoredDirectories, request.signal);

		if (matches === 0) return { exitCode: 1 };
		return { exitCode: 0, stdout: lines.join("\n") };
	};

	const execute = async (request: SandboxOperationRequest): Promise<SandboxOperationResult> => {
		throwIfAborted(request.signal);
		switch (request.operation) {
			case "file.read": {
				const requestPath = requirePath(request);
				const guestPath = await pathMapper.toGuestPath(requestPath, mapOptionsForPath());
				const content = await guestCall(() => filesystem.readFile(guestPath, { encoding: null, signal: request.signal }), request.signal);
				const mimeType = mimeTypeForPath(guestPath);
				return {
					content: Buffer.isBuffer(content) ? content : Buffer.from(content),
					...(mimeType === undefined ? {} : { mimeType }),
				};
			}
			case "file.write":
				if (typeof request.content !== "string") throw safePolicyError();
				await writeFile(requirePath(request), request.content, request.signal);
				return {};
			case "directory.list":
				return listDirectory(requirePath(request), request.limit, request.signal);
			case "filesystem.find":
				return find(request);
			case "filesystem.grep":
				return grep(request);
			default:
				throw safePolicyError();
		}
	};

	return { execute, readFile, writeFile, listDirectory, find, grep };
}

export async function executeGondolinFilesystemOperation(
	vmOrFilesystem: GondolinFilesystemVm | GondolinGuestFilesystem,
	pathMapper: GondolinPathMapper,
	request: SandboxOperationRequest,
	options?: GondolinFilesystemOperationOptions,
): Promise<SandboxOperationResult> {
	return createGondolinFilesystemOperations(vmOrFilesystem, pathMapper, options).execute(request);
}

/** Execute one request through the provider's guest-only context. */
export async function executeFilesystemOperation(
	context: GondolinOperationContext,
	request: SandboxOperationRequest,
	options?: GondolinFilesystemOperationOptions,
): Promise<SandboxOperationResult> {
	const pathMapper = context.pathMapper ?? createGondolinPathMapper({
		workspaceRoot: context.workspaceRoot,
		...context.pathMapperOptions,
	});
	return executeGondolinFilesystemOperation(context.vm, pathMapper, request, {
		...options,
		onSideEffectStart: context.onSideEffectStart,
	});
}
