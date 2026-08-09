/**
 * Cursor provider: auth (OAuth import + API key), dynamic model discovery, and
 * execution via the user-installed `cursor-agent` CLI.
 *
 * There is no static `cursor.models.ts` catalog — models come from
 * `cursor-agent models` at refresh time.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadCursorOAuth } from "../auth/oauth/load.ts";
import type { Provider } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	Usage,
} from "../types.ts";
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";

export const CURSOR_ID = "cursor" as const;
export const CURSOR_NAME = "Cursor" as const;
export const CURSOR_COMMAND = "cursor-agent" as const;
export const CURSOR_API = "cursor-cli" as const;

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIST_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_STATUS_TIMEOUT_MS = 15_000;
const UNKNOWN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * Resolve an argv-safe Cursor CLI invocation.
 *
 * On Windows, `shell: true` + concatenated args breaks multi-line prompts and
 * auth env handling. Prefer the installed node.exe + index.js so args stay
 * argv-separated without a shell.
 */
function resolveCursorInvocation(): { command: string; prefixArgs: string[]; shell: boolean } {
	const localApp = process.env.LOCALAPPDATA;
	if (localApp) {
		const versionsDir = join(localApp, "cursor-agent", "versions");
		if (existsSync(versionsDir)) {
			const versions = readdirSync(versionsDir)
				.filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}/.test(name))
				.sort()
				.reverse();
			for (const version of versions) {
				const nodePath = join(versionsDir, version, "node.exe");
				const indexPath = join(versionsDir, version, "index.js");
				if (existsSync(nodePath) && existsSync(indexPath)) {
					return { command: nodePath, prefixArgs: [indexPath], shell: false };
				}
			}
		}
		const rootNode = join(localApp, "cursor-agent", "node.exe");
		const rootIndex = join(localApp, "cursor-agent", "index.js");
		if (existsSync(rootNode) && existsSync(rootIndex)) {
			return { command: rootNode, prefixArgs: [rootIndex], shell: false };
		}
	}

	// Non-Windows / non-standard installs: rely on PATH (no shell needed for real binaries).
	return {
		command: CURSOR_COMMAND,
		prefixArgs: [],
		// Windows shims are .cmd/.ps1; shell is required only when we could not
		// resolve a direct node entrypoint above.
		shell: process.platform === "win32",
	};
}

// ---------------------------------------------------------------------------
// CLI process adapter (injected in tests)
// ---------------------------------------------------------------------------

export interface CursorCliRunOptions {
	env?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
	stdio?: "inherit" | "ignore" | "pipe";
}

export type CursorCliResult =
	| { status: "completed"; code: 0 }
	| { status: "not_installed"; message: string }
	| { status: "aborted"; message: string }
	| { status: "failed"; code: number | null; message: string };

export type CursorCliCaptureResult = CursorCliResult & {
	stdout: string;
	stderr: string;
};

export type CursorCliExecutor = (
	args: readonly string[],
	cwd: string,
	options?: CursorCliRunOptions,
) => Promise<CursorCliResult>;

export type CursorCliCaptureExecutor = (
	args: readonly string[],
	cwd: string,
	options?: CursorCliRunOptions,
) => Promise<CursorCliCaptureResult>;

export interface CursorStatusJson {
	status?: string;
	isAuthenticated?: boolean;
	hasAccessToken?: boolean;
	hasRefreshToken?: boolean;
	userInfo?: {
		email?: string;
		userId?: number | string;
		firstName?: string;
		lastName?: string;
		createdAt?: string;
	};
}

export interface CursorCli {
	readonly id: typeof CURSOR_ID;
	readonly name: typeof CURSOR_NAME;
	login(cwd: string, signal?: AbortSignal): Promise<CursorCliResult>;
	logout(cwd: string, signal?: AbortSignal): Promise<CursorCliResult>;
	status(cwd: string, signal?: AbortSignal): Promise<CursorCliCaptureResult>;
	listModels(cwd: string, options?: { apiKey?: string; signal?: AbortSignal }): Promise<CursorCliCaptureResult>;
	execute(
		modelId: string,
		prompt: string,
		cwd: string,
		options?: { apiKey?: string; signal?: AbortSignal },
	): Promise<CursorCliCaptureResult>;
}

export interface CursorModelReference {
	id: string;
	name: string;
}

export type CursorSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

function describeSpawnFailure(error: unknown): CursorCliResult {
	const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
	if (code === "ENOENT") {
		return {
			status: "not_installed",
			message: `Cursor CLI command "${CURSOR_COMMAND}" was not found on PATH.`,
		};
	}
	return {
		status: "failed",
		code: null,
		message: error instanceof Error ? error.message : String(error),
	};
}

function mergeChildEnvironment(env: Record<string, string> | undefined): NodeJS.ProcessEnv | undefined {
	return env ? { ...process.env, ...env } : undefined;
}

/** Session JWTs are not User API keys; only real keys go through CURSOR_API_KEY. */
function isJwtLike(value: string): boolean {
	const parts = value.split(".");
	return parts.length === 3 && parts.every((part) => part.length > 0);
}

export function cursorCliApiKey(apiKey: string | undefined): string | undefined {
	if (!apiKey || isJwtLike(apiKey)) return undefined;
	return apiKey;
}

function withCursorApiKey(apiKey?: string): Record<string, string> | undefined {
	const key = cursorCliApiKey(apiKey);
	return key ? { CURSOR_API_KEY: key } : undefined;
}

/**
 * When AOS holds an OAuth session access token, re-hydrate Cursor private
 * auth.json so print-mode CLI can authenticate without a separate CLI login.
 * No-op for User API keys (those use CURSOR_API_KEY).
 */
async function hydrateCursorPrivateAuthFromSessionToken(apiKey: string | undefined): Promise<void> {
	if (!apiKey || !isJwtLike(apiKey)) return;
	const path =
		process.platform === "win32"
			? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cursor", "auth.json")
			: process.platform === "darwin"
				? join(homedir(), "Library", "Application Support", "Cursor", "auth.json")
				: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cursor", "auth.json");
	await mkdir(dirname(path), { recursive: true });
	// Preserve refresh when the file already has one; only ensure accessToken is present.
	let refreshToken = apiKey;
	try {
		const existing = JSON.parse(await readFile(path, "utf8")) as { refreshToken?: unknown };
		if (typeof existing.refreshToken === "string" && existing.refreshToken.length > 0) {
			refreshToken = existing.refreshToken;
		}
	} catch {
		// create fresh file
	}
	await writeFile(path, `${JSON.stringify({ accessToken: apiKey, refreshToken }, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

function runCursorProcess(
	args: readonly string[],
	cwd: string,
	options: CursorCliRunOptions,
	spawnImpl: CursorSpawn,
): Promise<CursorCliCaptureResult> {
	return new Promise((resolve) => {
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;
		let stdout = "";
		let stderr = "";

		const finish = (result: CursorCliCaptureResult) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener);
			resolve(result);
		};

		if (options.signal?.aborted) {
			finish({ status: "aborted", message: "Cursor CLI command was aborted.", stdout, stderr });
			return;
		}

		let child: ChildProcess;
		try {
			const invocation = resolveCursorInvocation();
			const spawnOptions: SpawnOptions = {
				cwd,
				stdio: options.stdio ?? "pipe",
				shell: invocation.shell,
				windowsHide: true,
				...(options.env ? { env: mergeChildEnvironment(options.env) } : {}),
			};
			child = spawnImpl(invocation.command, [...invocation.prefixArgs, ...args], spawnOptions);
		} catch (error) {
			const result = describeSpawnFailure(error);
			finish({ ...result, stdout, stderr });
			return;
		}

		const append = (target: "stdout" | "stderr", chunk: unknown) => {
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
			if (target === "stdout") stdout += text;
			else stderr += text;
			if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_CAPTURE_BYTES) {
				child.kill();
				finish({
					status: "failed",
					code: null,
					message: "Cursor CLI output exceeded the safe limit.",
					stdout: "",
					stderr: "",
				});
			}
		};

		if (options.stdio !== "inherit" && options.stdio !== "ignore") {
			child.stdout?.on("data", (chunk) => append("stdout", chunk));
			child.stderr?.on("data", (chunk) => append("stderr", chunk));
		}

		const abort = () => {
			child.kill();
			finish({ status: "aborted", message: "Cursor CLI command was aborted.", stdout, stderr });
		};
		abortListener = abort;
		options.signal?.addEventListener("abort", abort, { once: true });

		if (options.timeoutMs !== undefined) {
			timeout = setTimeout(() => {
				child.kill();
				finish({
					status: "failed",
					code: null,
					message: "Cursor CLI command timed out.",
					stdout,
					stderr,
				});
			}, options.timeoutMs);
		}

		child.once("error", (error) => {
			const result = describeSpawnFailure(error);
			finish({ ...result, stdout, stderr });
		});
		child.once("close", (code) => {
			if (settled) return;
			if (code === 0) {
				finish({ status: "completed", code: 0, stdout, stderr });
			} else {
				const detail = stderr.trim() || stdout.trim();
				finish({
					status: "failed",
					code,
					message: detail
						? `Cursor CLI exited with code ${code ?? "unknown"}: ${detail.slice(0, 500)}`
						: `Cursor CLI exited with code ${code ?? "unknown"}.`,
					stdout,
					stderr,
				});
			}
		});
	});
}

/** Interactive Cursor command; AOS does not capture terminal output. */
export function runCursorCli(
	args: readonly string[],
	cwd: string,
	options: CursorCliRunOptions = {},
	spawnImpl: CursorSpawn = spawn,
): Promise<CursorCliResult> {
	return runCursorProcess(args, cwd, { ...options, stdio: options.stdio ?? "inherit" }, spawnImpl).then(
		({ stdout: _stdout, stderr: _stderr, ...result }) => result,
	);
}

/** Capture bounded CLI stdout/stderr for status, model list, and stream-json. */
export function runCursorCliCapture(
	args: readonly string[],
	cwd: string,
	options: CursorCliRunOptions = {},
	spawnImpl: CursorSpawn = spawn,
): Promise<CursorCliCaptureResult> {
	return runCursorProcess(args, cwd, { ...options, stdio: "pipe" }, spawnImpl);
}

function createCursorCli(
	execute: CursorCliExecutor = runCursorCli,
	capture: CursorCliCaptureExecutor = runCursorCliCapture,
): CursorCli {
	return {
		id: CURSOR_ID,
		name: CURSOR_NAME,
		login: (cwd, signal) => execute(["login"], cwd, { signal, stdio: "inherit" }),
		logout: (cwd, signal) => execute(["logout"], cwd, { signal, stdio: "inherit" }),
		status: (cwd, signal) =>
			capture(["status", "--format", "json"], cwd, {
				signal,
				timeoutMs: DEFAULT_STATUS_TIMEOUT_MS,
			}),
		listModels: async (cwd, options) => {
			await hydrateCursorPrivateAuthFromSessionToken(options?.apiKey);
			return capture(["models"], cwd, {
				env: withCursorApiKey(options?.apiKey),
				signal: options?.signal,
				timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
			});
		},
		execute: async (modelId, prompt, cwd, options) => {
			await hydrateCursorPrivateAuthFromSessionToken(options?.apiKey);
			return capture(
				// -f / --force: allow non-interactive tool use when the agent needs it
				["-p", prompt, "--model", modelId, "--output-format", "stream-json", "-f"],
				cwd,
				{
					env: withCursorApiKey(options?.apiKey),
					signal: options?.signal,
					timeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS,
				},
			);
		},
	};
}

export const cursorCli = createCursorCli();
export { createCursorCli };

// ---------------------------------------------------------------------------
// Dynamic model catalog (no static cursor.models.ts)
// ---------------------------------------------------------------------------

function hasUnsafeControlCharacters(value: string): boolean {
	return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

/**
 * Parse `cursor-agent models` line-oriented output.
 * Shape changes fail closed instead of guessing metadata.
 */
export function parseCursorModelList(stdout: string): CursorModelReference[] {
	if (!stdout || Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES || hasUnsafeControlCharacters(stdout)) {
		throw new Error("Cursor CLI returned an invalid model catalog.");
	}

	const lines = stdout
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length < 3 || lines[0] !== "Available models") {
		throw new Error("Cursor CLI model catalog format is unsupported.");
	}

	const footer = lines.at(-1) ?? "";
	const entries = lines.slice(1, -1);
	if (entries.length === 0 || !/--model\s+<?[^>\s]+>?/u.test(footer)) {
		throw new Error("Cursor CLI model catalog format is unsupported.");
	}

	const seen = new Set<string>();
	const models: CursorModelReference[] = [];
	for (const entry of entries) {
		const separator = entry.indexOf(" - ");
		if (separator <= 0 || separator !== entry.lastIndexOf(" - ")) {
			throw new Error("Cursor CLI model catalog contains an unsupported entry.");
		}
		const id = entry.slice(0, separator).trim();
		const name = entry.slice(separator + 3).trim();
		if (!id || !name || hasUnsafeControlCharacters(id) || hasUnsafeControlCharacters(name) || seen.has(id)) {
			throw new Error("Cursor CLI model catalog contains an invalid or duplicate entry.");
		}
		seen.add(id);
		models.push({ id, name });
	}

	return models;
}

export function normalizeCursorModels(references: readonly CursorModelReference[]): Model<typeof CURSOR_API>[] {
	if (references.length === 0) throw new Error("Cursor CLI returned no usable models.");
	return references.map((reference) => ({
		id: reference.id,
		name: reference.name,
		api: CURSOR_API,
		provider: CURSOR_ID,
		baseUrl: "cursor-cli://local",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		// Zero means unknown; not a claim the model is free or unlimited.
		cost: UNKNOWN_COST,
		contextWindow: 0,
		maxTokens: 0,
	}));
}

export function parseCursorStatusJson(stdout: string): CursorStatusJson {
	if (!stdout || Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES || hasUnsafeControlCharacters(stdout)) {
		throw new Error("Cursor CLI status output is invalid.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("Cursor CLI status output is not valid JSON.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Cursor CLI status output is not a JSON object.");
	}
	return parsed as CursorStatusJson;
}

export function isCursorStatusAuthenticated(status: CursorStatusJson): boolean {
	if (status.isAuthenticated === true) return true;
	if (status.isAuthenticated === false) return false;
	return status.status === "authenticated";
}

// ---------------------------------------------------------------------------
// Stream execution
// ---------------------------------------------------------------------------

export interface CursorExecutionSummary {
	text: string;
	responseModel?: string;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as Record<string, unknown>;
			return typeof value.text === "string" ? value.text : "";
		})
		.join("");
}

/** Parse Cursor stream-json execution events. */
export function parseCursorExecutionOutput(stdout: string): CursorExecutionSummary {
	if (!stdout || Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES) {
		throw new Error("Cursor CLI returned an invalid execution stream.");
	}

	let assistantText = "";
	let resultText: string | undefined;
	let responseModel: string | undefined;
	let sawResult = false;
	for (const line of stdout.replace(/\r\n?/gu, "\n").split("\n")) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			throw new Error("Cursor CLI returned malformed stream output.");
		}
		if (!event || typeof event !== "object") throw new Error("Cursor CLI returned malformed stream output.");
		const value = event as Record<string, unknown>;
		const type = value.type;
		if (type === "system") {
			const model = value.model;
			if (model !== undefined && typeof model !== "string") {
				throw new Error("Cursor CLI returned an invalid model name.");
			}
			if (typeof model === "string") responseModel = model;
			continue;
		}
		if (type === "assistant") {
			const message = value.message;
			if (!message || typeof message !== "object") {
				throw new Error("Cursor CLI returned an invalid assistant event.");
			}
			assistantText += textFromContent((message as Record<string, unknown>).content);
			continue;
		}
		if (type === "result") {
			if (sawResult) throw new Error("Cursor CLI returned duplicate result events.");
			sawResult = true;
			if (value.subtype !== "success" || value.is_error === true || typeof value.result !== "string") {
				throw new Error("Cursor CLI returned an unsuccessful result.");
			}
			resultText = value.result;
			continue;
		}
		// Ignore protocol noise: thinking deltas, tool calls, user echoes, etc.
		if (
			type === "user" ||
			type === "tool_call" ||
			type === "thinking" ||
			type === "tool_result" ||
			type === "tool-call" ||
			type === "tool-result"
		) {
		}
	}

	if (!sawResult) throw new Error("Cursor CLI stream ended without a result.");
	return { text: assistantText || resultText || "", responseModel };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export interface CursorProviderOptions {
	cli?: CursorCli;
	cwd?: string;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(model: Model<typeof CURSOR_API>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function cursorCliError(
	result: CursorCliCaptureResult | { status: string; message?: string },
	operation: string,
): Error {
	if (result.status === "not_installed") {
		return new Error(`Cursor CLI is not installed; cannot ${operation}.`);
	}
	if (result.status === "aborted") {
		return new Error(`Cursor CLI ${operation} was aborted.`);
	}
	if (result.status === "failed") {
		return new Error(`Cursor CLI ${operation} failed${result.message ? `: ${result.message}` : "."}`);
	}
	return new Error(`Cursor CLI ${operation} returned an invalid result.`);
}

function restoreCursorModels(stored: { models: readonly Model<Api>[] } | undefined): Model<typeof CURSOR_API>[] {
	if (!stored) return [];
	return stored.models
		.filter(
			(model) =>
				model.provider === CURSOR_ID &&
				model.api === CURSOR_API &&
				typeof model.id === "string" &&
				typeof model.name === "string" &&
				model.id.trim().length > 0 &&
				model.name.trim().length > 0,
		)
		.map((model) => normalizeCursorModels([{ id: model.id, name: model.name }])[0]!);
}

function modelListFromCapture(result: CursorCliCaptureResult): Model<typeof CURSOR_API>[] {
	if (result.status !== "completed") throw cursorCliError(result, "refresh its model catalog");
	return normalizeCursorModels(parseCursorModelList(result.stdout));
}

function contextMessageText(context: Context): string {
	const sections: string[] = [];
	if (context.systemPrompt) sections.push(`System:\n${context.systemPrompt}`);
	for (const message of context.messages) {
		if (message.role === "user") {
			sections.push(
				`User:\n${typeof message.content === "string" ? message.content : textFromContent(message.content)}`,
			);
		} else if (message.role === "assistant") {
			sections.push(`Assistant:\n${textFromContent(message.content)}`);
		} else {
			sections.push(`Tool result (${message.toolName}):\n${textFromContent(message.content)}`);
		}
	}
	if (sections.length === 0) throw new Error("Cursor CLI requires a non-empty prompt context.");
	return sections.join("\n\n");
}

function streamCursorModel(
	cli: CursorCli,
	cwd: string,
	model: Model<typeof CURSOR_API>,
	context: Context,
	options?: StreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message = createAssistantMessage(model);
	stream.push({ type: "start", partial: message });

	void (async () => {
		try {
			const prompt = contextMessageText(context);
			const result = await cli.execute(model.id, prompt, cwd, {
				apiKey: cursorCliApiKey(options?.apiKey),
				signal: options?.signal,
			});
			if (result.status !== "completed") throw cursorCliError(result, "execute the selected model");
			const summary = parseCursorExecutionOutput(result.stdout);
			message.responseModel = summary.responseModel;
			if (summary.text) {
				const contentIndex = message.content.length;
				message.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex, partial: message });
				stream.push({ type: "text_delta", contentIndex, delta: summary.text, partial: message });
				(message.content[contentIndex] as { type: "text"; text: string }).text = summary.text;
				stream.push({ type: "text_end", contentIndex, content: summary.text, partial: message });
			}
			message.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message });
		} catch (error) {
			const aborted = options?.signal?.aborted ?? false;
			message.stopReason = aborted ? "aborted" : "error";
			message.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: message.stopReason, error: message });
		}
	})();

	return stream;
}

/** Cursor provider: OAuth imports private CLI credentials; models/execution use cursor-agent. */
export function cursorProvider(options: CursorProviderOptions = {}): Provider<typeof CURSOR_API> {
	const cli = options.cli ?? cursorCli;
	const cwd = options.cwd ?? process.cwd();
	let models: readonly Model<typeof CURSOR_API>[] = [];

	return {
		id: CURSOR_ID,
		name: CURSOR_NAME,
		baseUrl: "cursor-cli://local",
		auth: {
			apiKey: envApiKeyAuth("Cursor API key", ["CURSOR_API_KEY"]),
			oauth: lazyOAuth({
				name: "Cursor",
				isSubscription: true,
				loginLabel: "Sign in with Cursor (import CLI credentials)",
				load: loadCursorOAuth,
			}),
		},
		getModels: () => models,
		refreshModels: async (context) => {
			const restored = restoreCursorModels(context.stored);
			if (restored.length > 0) {
				if (
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				) {
					return;
				}
			}
			if (!context.allowNetwork || context.signal.aborted) return;

			const apiKey =
				context.credential?.type === "api_key"
					? context.credential.key
					: context.credential?.type === "oauth"
						? context.credential.access
						: undefined;
			const result = await cli.listModels(cwd, { apiKey, signal: context.signal });
			const refreshed = modelListFromCapture(result);
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, requestOptions) => streamCursorModel(cli, cwd, model, context, requestOptions),
		streamSimple: (model, context, requestOptions: SimpleStreamOptions | undefined) =>
			streamCursorModel(cli, cwd, model, context, requestOptions),
	};
}
