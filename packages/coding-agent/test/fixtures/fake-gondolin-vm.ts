import path from "node:path";

import type {
	GondolinGuestFilesystem,
	GondolinGuestStat,
} from "../../examples/extensions/gondolin/filesystem-operations.ts";
import type {
	GondolinVmFactory,
	GondolinVmFactoryOptions,
	GondolinVmLike,
} from "../../examples/extensions/gondolin/vm-types.ts";

export interface FakeGondolinFilesystemCall {
	readonly operation: "access" | "mkdir" | "listDir" | "stat" | "readFile" | "writeFile";
	readonly path: string;
	readonly encoding?: BufferEncoding | null;
	readonly content?: string | Buffer;
}

export interface FakeGondolinExecCall {
	readonly command: string | ReadonlyArray<string>;
	readonly cwd?: string;
	readonly env: Readonly<Record<string, string>>;
	readonly signal?: AbortSignal;
	aborted: boolean;
}

export interface FakeGondolinExecOutputChunk {
	readonly stream: "stdout" | "stderr";
	readonly data: Buffer;
}

export interface FakeGondolinExecPlan {
	readonly exitCode?: number;
	readonly signal?: number;
	readonly stdout?: string | Buffer;
	readonly stderr?: string | Buffer;
	readonly chunks?: ReadonlyArray<FakeGondolinExecOutputChunk>;
	readonly waitForAbort?: boolean;
	readonly error?: Error;
}

export interface FakeGondolinVmOptions {
	readonly id?: string;
	readonly files?: Readonly<Record<string, string | Buffer>>;
	readonly directories?: ReadonlyArray<string>;
	readonly onExec?: (call: FakeGondolinExecCall) => FakeGondolinExecPlan;
}

export interface FakeGondolinFilesystemState {
	readonly filesystem: GondolinGuestFilesystem;
	readonly calls: FakeGondolinFilesystemCall[];
	readonly files: Map<string, Buffer>;
	readonly directories: Set<string>;
}

export interface FakeGondolinVmState {
	readonly vm: GondolinVmLike;
	readonly filesystem: FakeGondolinFilesystemState;
	readonly execCalls: FakeGondolinExecCall[];
	readonly factoryCalls: GondolinVmFactoryOptions[];
	readonly closeCount: () => number;
	readonly isClosed: () => boolean;
}

interface MissingPathError extends Error {
	readonly code: "ENOENT";
}

function missingPath(pathName: string): MissingPathError {
	return Object.assign(new Error(`Guest path does not exist: ${pathName}`), { code: "ENOENT" as const });
}

function normalizeGuestPath(pathName: string): string {
	const normalized = path.posix.normalize(pathName);
	if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) {
		throw new Error(`Guest path outside mount: ${pathName}`);
	}
	return normalized;
}

function parentDirectories(pathName: string): string[] {
	const parents: string[] = [];
	let current = path.posix.dirname(pathName);
	while (current !== "/workspace") {
		parents.push(current);
		current = path.posix.dirname(current);
	}
	parents.push("/workspace");
	return parents;
}

function asBuffer(value: string | Buffer | undefined): Buffer {
	if (value === undefined) return Buffer.alloc(0);
	return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
}

function createGuestStat(isDirectory: boolean): GondolinGuestStat {
	return { isDirectory: () => isDirectory };
}

function readGuestFile(
	files: Map<string, Buffer>,
	calls: FakeGondolinFilesystemCall[],
): GondolinGuestFilesystem["readFile"] {
	const readFile = async (
		pathName: string,
		options: { readonly encoding: BufferEncoding | null; readonly signal?: AbortSignal },
	): Promise<Buffer | string> => {
		const normalized = normalizeGuestPath(pathName);
		calls.push({ operation: "readFile", path: normalized, encoding: options.encoding });
		const content = files.get(normalized);
		if (content === undefined) throw missingPath(normalized);
		return options.encoding === null ? Buffer.from(content) : content.toString(options.encoding);
	};
	return readFile as unknown as GondolinGuestFilesystem["readFile"];
}

function createFilesystem(options: FakeGondolinVmOptions): FakeGondolinFilesystemState {
	const calls: FakeGondolinFilesystemCall[] = [];
	const files = new Map<string, Buffer>();
	const directories = new Set<string>(["/workspace"]);

	for (const directory of options.directories ?? []) {
		const normalized = normalizeGuestPath(directory);
		directories.add(normalized);
	}
	for (const [filePath, content] of Object.entries(options.files ?? {})) {
		const normalized = normalizeGuestPath(filePath);
		files.set(normalized, asBuffer(content));
		for (const parent of parentDirectories(normalized)) directories.add(parent);
	}

	const filesystem: GondolinGuestFilesystem = {
		async access(pathName, _options) {
			const normalized = normalizeGuestPath(pathName);
			calls.push({ operation: "access", path: normalized });
			if (!files.has(normalized) && !directories.has(normalized)) throw missingPath(normalized);
		},
		async mkdir(pathName, _options) {
			const normalized = normalizeGuestPath(pathName);
			calls.push({ operation: "mkdir", path: normalized });
			directories.add(normalized);
		},
		async listDir(pathName, _options) {
			const normalized = normalizeGuestPath(pathName);
			calls.push({ operation: "listDir", path: normalized });
			if (!directories.has(normalized)) throw missingPath(normalized);
			const prefix = `${normalized}/`;
			const children = new Set<string>();
			for (const directory of directories) {
				if (!directory.startsWith(prefix)) continue;
				const child = directory.slice(prefix.length).split("/")[0];
				if (child) children.add(child);
			}
			for (const filePath of files.keys()) {
				if (!filePath.startsWith(prefix)) continue;
				const child = filePath.slice(prefix.length).split("/")[0];
				if (child) children.add(child);
			}
			return [...children].sort();
		},
		async stat(pathName, _options) {
			const normalized = normalizeGuestPath(pathName);
			calls.push({ operation: "stat", path: normalized });
			if (directories.has(normalized)) return createGuestStat(true);
			if (files.has(normalized)) return createGuestStat(false);
			throw missingPath(normalized);
		},
		readFile: readGuestFile(files, calls),
		async writeFile(pathName, data, options) {
			const normalized = normalizeGuestPath(pathName);
			calls.push({
				operation: "writeFile",
				path: normalized,
				encoding: options?.encoding,
				content: typeof data === "string" ? data : Buffer.from(data),
			});
			for (const parent of parentDirectories(normalized)) directories.add(parent);
			files.set(normalized, typeof data === "string" ? Buffer.from(data, options?.encoding ?? "utf8") : Buffer.from(data));
		},
	};

	return { filesystem, calls, files, directories };
}

function defaultPlan(call: FakeGondolinExecCall): FakeGondolinExecPlan {
	if (Array.isArray(call.command) && call.command.join(" ") === "/bin/sh -lc true") return { exitCode: 0 };
	return { exitCode: 0, stdout: "fake stdout\n", stderr: "" };
}

function createExecProcess(
	call: FakeGondolinExecCall,
	plan: FakeGondolinExecPlan,
): ReturnType<GondolinVmLike["exec"]> {
	const abortPromise = new Promise<never>((_resolve, reject) => {
		call.signal?.addEventListener("abort", () => {
			call.aborted = true;
			reject(new Error("exec aborted"));
		}, { once: true });
	});
	const result = plan.waitForAbort
		? abortPromise
		: plan.error !== undefined
			? Promise.reject(plan.error)
			: Promise.resolve({ exitCode: plan.exitCode ?? 0, ...(plan.signal === undefined ? {} : { signal: plan.signal }) });
	const chunks = plan.chunks ?? [
		...(plan.stdout === undefined ? [] : [{ stream: "stdout" as const, data: asBuffer(plan.stdout) }]),
		...(plan.stderr === undefined ? [] : [{ stream: "stderr" as const, data: asBuffer(plan.stderr) }]),
	];

	const process = {
		result,
		output: async function* (): AsyncGenerator<FakeGondolinExecOutputChunk> {
			for (const chunk of chunks) yield chunk;
			if (plan.waitForAbort) await abortPromise;
		},
	};
	return process as unknown as ReturnType<GondolinVmLike["exec"]>;
}

export function createFakeGondolinVm(options: FakeGondolinVmOptions = {}): FakeGondolinVmState {
	const filesystem = createFilesystem(options);
	const execCalls: FakeGondolinExecCall[] = [];
	const factoryCalls: GondolinVmFactoryOptions[] = [];
	let closed = false;
	let closeCalls = 0;

	const vm = {
		id: options.id ?? "fake-gondolin-vm",
		fs: filesystem.filesystem,
		exec(command: string | string[], execOptions?: {
			readonly cwd?: string;
			readonly env?: Record<string, string>;
			readonly signal?: AbortSignal;
		}): ReturnType<GondolinVmLike["exec"]> {
			const call: FakeGondolinExecCall = {
				command: Array.isArray(command) ? [...command] : command,
				...(execOptions?.cwd === undefined ? {} : { cwd: execOptions.cwd }),
				env: { ...(execOptions?.env ?? {}) },
				...(execOptions?.signal === undefined ? {} : { signal: execOptions.signal }),
				aborted: false,
			};
			execCalls.push(call);
			return createExecProcess(call, options.onExec?.(call) ?? defaultPlan(call));
		},
		async close(): Promise<void> {
			closeCalls++;
			closed = true;
		},
	};

	const typedVm = vm as unknown as GondolinVmLike;
	const state: FakeGondolinVmState = {
		vm: typedVm,
		filesystem,
		execCalls,
		factoryCalls,
		closeCount: () => closeCalls,
		isClosed: () => closed,
	};
	return state;
}

export function createFakeGondolinVmFactory(
	state: FakeGondolinVmState,
	callback?: (options: GondolinVmFactoryOptions) => void,
): GondolinVmFactory {
	return async (options) => {
		state.factoryCalls.push(options);
		callback?.(options);
		return state.vm;
	};
}
