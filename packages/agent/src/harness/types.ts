import type { RetryPolicy, SimpleStreamOptions, Transport } from "@aos-agent/ai";
import type { Static, TSchema } from "typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../types.ts";
import type { SkillMetadataV1 } from "./profile.ts";

/** Result of a fallible operation. Expected failures are returned as `ok: false` instead of thrown. */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** Create a successful {@link Result}. */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

/** Create a failed {@link Result}. */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

/** Return the success value or throw the failure error. Intended for tests and explicit adapter boundaries. */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

/** Return the success value or `undefined`. Only object values are allowed to avoid truthiness bugs with primitives. */
export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}

/** Normalize unknown thrown values into Error instances before using them as typed error causes. */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

/**
 * Skill loaded from a `SKILL.md` file or provided by an application.
 *
 * `name`, `description`, and `filePath` are inserted into the system prompt in an XML-formatted block as suggested by agentskills.io.
 * Use {@link formatSkillsForSystemPrompt} to generate the spec-compatible system prompt block.
 */
export interface Skill {
	/** Stable skill name used for lookup and model-visible listings. */
	name: string;
	/** Short model-visible description of when to use the skill. */
	description: string;
	/** Full skill instructions. */
	content: string;
	/** Absolute path to the skill file. Used for model-visible location and resolving relative references. */
	filePath: string;
	/** Exclude this skill from model-visible skill lists while still allowing explicit application invocation. */
	disableModelInvocation?: boolean;
	/** Optional Foundation profile metadata for skill extensions. */
	metadata?: SkillMetadataV1;
}

/** Prompt template that can be formatted into a prompt for explicit invocation. */
export interface PromptTemplate {
	/** Stable template name used for lookup or application command routing. */
	name: string;
	/** Optional description for command lists or autocomplete. */
	description?: string;
	/** Template content. Argument placeholders are formatted by `formatPromptTemplateInvocation`. */
	content: string;
}

/** Resources made available to explicit invocation methods and system-prompt callbacks. */
export interface AgentHarnessResources<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	/** Prompt templates available for explicit invocation. */
	promptTemplates?: TPromptTemplate[];
	/** Skills available to the model and explicit skill invocation. */
	skills?: TSkill[];
}

/** Tool definition executed by an {@link AgentHarness} with an application-defined context. */
export type AgentHarnessTool<
	TContext extends object | undefined,
	TParameters extends TSchema = TSchema,
	TDetails = unknown,
> = Omit<AgentTool<TParameters, TDetails>, "execute"> & {
	/** Execute the tool call with the context resolved for the current turn snapshot. */
	execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		context: TContext,
	): Promise<AgentToolResult<TDetails>>;
};

/** Static tool context or zero-argument provider resolved for each turn snapshot. */
export type AgentHarnessToolContextSource<TContext extends object | undefined> =
	| TContext
	| (() => TContext | Promise<TContext>);

/** Curated provider request options owned by the harness and snapshotted per turn. */
export interface AgentHarnessStreamOptions {
	/** Preferred transport forwarded to the stream function. */
	transport?: Transport;
	/** Operation-scoped cancellation signal forwarded to the model callback. */
	signal?: AbortSignal;
	/** Absolute deadline forwarded alongside the cancellation signal. */
	deadlineAt?: number;
	/** Provider request timeout in milliseconds. */
	timeoutMs?: number;
	/** Maximum provider retry attempts. */
	maxRetries?: number;
	/** Optional cap for provider-requested retry delays. */
	maxRetryDelayMs?: number;
	/** Additional request headers merged with auth and lifecycle headers. */
	headers?: Record<string, string>;
	/** Provider metadata forwarded with requests. */
	metadata?: SimpleStreamOptions["metadata"];
	/** Provider cache retention hint. */
	cacheRetention?: SimpleStreamOptions["cacheRetention"];
}

/** Per-request stream option patch returned by provider hooks. */
export interface AgentHarnessStreamOptionsPatch
	extends Omit<Partial<AgentHarnessStreamOptions>, "headers" | "metadata"> {
	/** Header patch. `undefined` values delete keys; explicit `headers: undefined` clears all headers. */
	headers?: Record<string, string | undefined>;
	/** Metadata patch. `undefined` values delete keys; explicit `metadata: undefined` clears all metadata. */
	metadata?: Record<string, unknown | undefined>;
}

/** Provider boundary that may be cancelled by the caller or by a deadline. */
export type HarnessProviderKind = "model" | "tool" | "mcp" | "sandbox";

/** Point at which a provider operation failed. */
export type HarnessProviderPhase = "before_request" | "request" | "after_request";

/** Side-effect state known at the time a provider operation failed. */
export type HarnessSideEffectState = "none" | "idempotent" | "unknown";

/** Stable categories used by the harness retry boundary. */
export type HarnessProviderErrorCategory =
	| "transient"
	| "permission"
	| "parameter"
	| "side_effect_unknown"
	| "cancelled"
	| "deadline"
	| "unknown";

/** Context required to classify provider failures without guessing whether a retry is safe. */
export interface HarnessProviderErrorOptions {
	/** Provider-adjacent operation that failed. Defaults to a model request. */
	operation?: HarnessProviderKind;
	/** Whether the request was sent or its side effect may have committed. */
	phase?: HarnessProviderPhase;
	/** Explicit knowledge about side effects. */
	sideEffect?: HarnessSideEffectState;
	/** Caller cancellation signal, when one exists. */
	signal?: AbortSignal;
}

/** Classified provider failure. The original thrown value is retained for diagnostics. */
export interface HarnessProviderErrorClassification {
	category: HarnessProviderErrorCategory;
	message: string;
	operation: HarnessProviderKind;
	phase: HarnessProviderPhase;
	status?: number;
	code?: string;
	/** True only when retrying cannot duplicate an unknown side effect. */
	safeToRetry: boolean;
	cause: unknown;
}

export type HarnessRetryDecisionReason =
	| "retry"
	| "disabled"
	| "exhausted"
	| "cancelled"
	| "deadline"
	| "permission"
	| "parameter"
	| "side_effect_unknown"
	| "unsafe_side_effect"
	| "not_transient";

/** Explain why the current provider attempt may or may not be retried. */
export interface HarnessRetryDecision {
	retry: boolean;
	reason: HarnessRetryDecisionReason;
	classification: HarnessProviderErrorClassification;
}

/** Additional retry context for a provider callback. */
export interface HarnessRetryOptions extends HarnessProviderErrorOptions {
	policy?: RetryPolicy;
	/** Number of retries already consumed for the current durable step. */
	retriesUsed: number;
	/** Tool/MCP/Sandbox replay capability. Model calls do not need this flag. */
	replay?: "never" | "safe";
}

/** Durable operation identity carried to every provider-adjacent callback. */
export interface HarnessOperationContext {
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	branchId: string | null;
	checkpointId?: string;
	attempt: number;
}

/** Provider callback context. A callback must use the same signal and deadline for the whole attempt. */
export interface HarnessProviderContext extends HarnessOperationContext {
	provider: HarnessProviderKind;
	signal?: AbortSignal;
	deadlineAt?: number;
}

/** Generic callback shape shared by model, tool, MCP, and Sandbox adapters. */
export type HarnessProviderCallback<TInput, TResult> = (
	input: TInput,
	context: HarnessProviderContext,
) => TResult | Promise<TResult>;

/** Cancellation and deadline resources owned by one harness operation. */
export interface HarnessCancellation {
	signal?: AbortSignal;
	deadlineAt?: number;
	cleanup(): void;
}

/** Options for {@link createHarnessCancellation}. */
export interface HarnessCancellationOptions {
	signal?: AbortSignal;
	/** Absolute Unix epoch deadline in milliseconds. */
	deadlineAt?: number;
	/** Relative deadline in milliseconds, evaluated using `now`. */
	deadlineMs?: number;
	now?: () => number;
}

/** Error used as the reason when a harness deadline expires. */
export class HarnessDeadlineExceeded extends Error {
	readonly deadlineAt: number;

	constructor(deadlineAt: number) {
		super(`Harness deadline exceeded at ${deadlineAt}`);
		this.name = "HarnessDeadlineExceeded";
		this.deadlineAt = deadlineAt;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
	const property = asRecord(value)?.[key];
	return typeof property === "string" && property.length > 0 ? property : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
	const property = asRecord(value)?.[key];
	return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function providerStatus(error: unknown): number | undefined {
	const direct = numberProperty(error, "status") ?? numberProperty(error, "statusCode");
	if (direct !== undefined) return direct;
	const record = asRecord(error);
	const response = record?.response;
	const metadata = record?.$metadata;
	const nested = record?.error;
	return (
		numberProperty(response, "status") ??
		numberProperty(response, "statusCode") ??
		numberProperty(metadata, "httpStatusCode") ??
		numberProperty(nested, "status") ??
		numberProperty(nested, "statusCode")
	);
}

function providerCode(error: unknown): string | undefined {
	const record = asRecord(error);
	const nested = record?.error;
	return (
		stringProperty(error, "code") ??
		stringProperty(error, "type") ??
		stringProperty(error, "name") ??
		stringProperty(nested, "code") ??
		stringProperty(nested, "type")
	);
}

function providerMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	const record = asRecord(error);
	const nested = record?.error;
	const message =
		stringProperty(error, "message") ??
		stringProperty(error, "errorMessage") ??
		stringProperty(nested, "message") ??
		stringProperty(nested, "errorMessage");
	if (message) return message;
	return toError(error).message;
}

function providerDiagnosticText(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	const seen = new Set<unknown>();
	for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth++) {
		seen.add(current);
		const message = providerMessage(current);
		const code = providerCode(current);
		if (message) parts.push(message);
		if (code && code !== message) parts.push(code);
		const record = asRecord(current);
		current = record?.cause ?? record?.error;
	}
	const status = providerStatus(error);
	if (status !== undefined) parts.push(String(status));
	return parts.join(" ").toLowerCase();
}

function isAbortLike(error: unknown, signal: AbortSignal | undefined, text: string): boolean {
	if (signal?.aborted) return true;
	const name = providerCode(error)?.toLowerCase();
	return name === "aborterror" || name === "cancelled" || name === "canceled" || /\babort(?:ed|ing)?\b|cancelled|canceled/.test(text);
}

function isDeadlineLike(error: unknown, signal: AbortSignal | undefined, text: string): boolean {
	const name = providerCode(error)?.toLowerCase();
	if (name === "agentdeadlineexceeded" || name === "harnessdeadlineexceeded" || name === "deadline_exceeded" || name === "lease_expired") {
		return true;
	}
	if (/deadline|lease.?expir/.test(text)) return true;
	if (signal?.reason !== undefined && signal.reason !== error) {
		return isDeadlineLike(signal.reason, undefined, providerDiagnosticText(signal.reason));
	}
	return false;
}

function isPermissionError(text: string, status: number | undefined): boolean {
	return (
		status === 401 ||
		status === 403 ||
		/permission|forbidden|unauthori[sz]ed|access denied|not allowed|policy denied|capability denied|eacces|eperm/.test(text)
	);
}

function isParameterError(text: string, status: number | undefined): boolean {
	return (
		status === 400 ||
		status === 422 ||
		/invalid[\s_-]*(?:argument|parameter|request|tool|schema)|malformed|validation failed|unsupported parameter|bad request|tool argument/.test(
			text,
		)
	);
}

function isTransientError(text: string, status: number | undefined): boolean {
	return (
		(status !== undefined && (status === 408 || status === 409 || status === 429 || status >= 500)) ||
		/overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|network.?error|connection.?(?:error|refused|lost)|fetch failed|getaddrinfo|eai_again|enotfound|timed? out|timeout|socket hang up|websocket.?closed|stream ended|try your request again|please retry|resourceexhausted/.test(
			text,
		)
	);
}

/** Classify a provider failure before applying the existing bounded RetryPolicy. */
export function classifyHarnessProviderError(
	error: unknown,
	options: HarnessProviderErrorOptions = {},
): HarnessProviderErrorClassification {
	const operation = options.operation ?? "model";
	const phase = options.phase ?? "request";
	const status = providerStatus(error);
	const code = providerCode(error);
	const message = providerMessage(error);
	const text = providerDiagnosticText(error);
	const sideEffectUnknown =
		options.sideEffect === "unknown" ||
		(operation !== "model" && phase === "after_request" && options.sideEffect === undefined);
	let category: HarnessProviderErrorCategory = "unknown";
	if (sideEffectUnknown) category = "side_effect_unknown";
	else if (isDeadlineLike(error, options.signal, text)) category = "deadline";
	else if (isAbortLike(error, options.signal, text)) category = "cancelled";
	else if (isPermissionError(text, status)) category = "permission";
	else if (isParameterError(text, status)) category = "parameter";
	else if (isTransientError(text, status)) category = "transient";

	const safeToRetry =
		category === "transient" &&
		(operation === "model" ||
			options.sideEffect === "none" ||
			options.sideEffect === "idempotent" ||
			phase === "before_request");
	return { category, message, operation, phase, ...(status !== undefined ? { status } : {}), ...(code ? { code } : {}), safeToRetry, cause: error };
}

/** Decide whether a classified provider failure may consume another bounded retry. */
export function decideHarnessRetry(
	error: unknown | HarnessProviderErrorClassification,
	options: HarnessRetryOptions,
): HarnessRetryDecision {
	const classification =
		"category" in (asRecord(error) ?? {})
			? (error as HarnessProviderErrorClassification)
			: classifyHarnessProviderError(error, options);
	const policy = options.policy;
	if (!policy?.enabled) return { retry: false, reason: "disabled", classification };
	if (options.signal?.aborted || classification.category === "cancelled") {
		return { retry: false, reason: "cancelled", classification };
	}
	if (options.retriesUsed >= policy.maxRetries) return { retry: false, reason: "exhausted", classification };
	switch (classification.category) {
		case "permission":
			return { retry: false, reason: "permission", classification };
		case "parameter":
			return { retry: false, reason: "parameter", classification };
		case "side_effect_unknown":
			return { retry: false, reason: "side_effect_unknown", classification };
		case "deadline":
			return { retry: false, reason: "deadline", classification };
		case "transient":
			if (
				classification.operation === "model" ||
				options.replay === "safe" ||
				((options.sideEffect === "none" || options.sideEffect === "idempotent") && classification.safeToRetry)
			) {
				return { retry: true, reason: "retry", classification };
			}
			return { retry: false, reason: "unsafe_side_effect", classification };
		default:
			return { retry: false, reason: "not_transient", classification };
	}
}

/** Create one operation-scoped signal and deadline for every provider callback. */
export function createHarnessCancellation(options: HarnessCancellationOptions = {}): HarnessCancellation {
	const now = options.now ?? Date.now;
	const computedDeadline = options.deadlineAt ?? (options.deadlineMs === undefined ? undefined : now() + options.deadlineMs);
	if (computedDeadline !== undefined && !Number.isFinite(computedDeadline)) {
		throw new RangeError("Harness deadline must be finite");
	}
	if (options.deadlineMs !== undefined && (!Number.isFinite(options.deadlineMs) || options.deadlineMs < 0)) {
		throw new RangeError("Harness deadlineMs must be a non-negative finite number");
	}
	if (computedDeadline === undefined) return { signal: options.signal, cleanup: () => {} };

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let parentListener: (() => void) | undefined;
	const abortForDeadline = () => controller.abort(new HarnessDeadlineExceeded(computedDeadline));
	if (options.signal) {
		if (options.signal.aborted) controller.abort(options.signal.reason);
		else {
			parentListener = () => controller.abort(options.signal?.reason);
			options.signal.addEventListener("abort", parentListener, { once: true });
		}
	}
	const delay = computedDeadline - now();
	if (delay <= 0) abortForDeadline();
	else timer = setTimeout(abortForDeadline, delay);

	return {
		signal: controller.signal,
		deadlineAt: computedDeadline,
		cleanup: () => {
			if (timer !== undefined) clearTimeout(timer);
			if (parentListener && options.signal) options.signal.removeEventListener("abort", parentListener);
		},
	};
}

/** Attach the operation identity and shared cancellation context to a provider callback. */
export function createHarnessProviderContext(
	operation: HarnessOperationContext,
	cancellation: Pick<HarnessCancellation, "signal" | "deadlineAt"> = {},
	provider: HarnessProviderKind = "model",
): HarnessProviderContext {
	return {
		...operation,
		provider,
		...(cancellation.signal ? { signal: cancellation.signal } : {}),
		...(cancellation.deadlineAt !== undefined ? { deadlineAt: cancellation.deadlineAt } : {}),
	};
}

/** Invoke a provider-adjacent callback after honoring an already-aborted operation signal. */
export async function invokeHarnessProvider<TInput, TResult>(
	callback: HarnessProviderCallback<TInput, TResult>,
	input: TInput,
	context: HarnessProviderContext,
): Promise<TResult> {
	if (context.signal?.aborted) {
		throw context.signal.reason ?? new HarnessDeadlineExceeded(context.deadlineAt ?? Date.now());
	}
	return callback(input, context);
}

/** Kind of filesystem object as addressed by a {@link FileSystem}. Symlinks are not followed automatically. */
export type FileKind = "file" | "directory" | "symlink";

/** Stable, backend-independent file error codes returned by {@link FileSystem} file operations. */
export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

/** Error returned by {@link FileSystem} file operations. */
export class FileError extends Error {
	/** Backend-independent error code. */
	public code: FileErrorCode;
	/** Absolute addressed path associated with the failure, when available. */
	public path?: string;

	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

/** Stable, backend-independent execution error codes returned by {@link ExecutionEnv.exec}. */
export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";

/** Error returned by {@link ExecutionEnv.exec}. */
export class ExecutionError extends Error {
	/** Backend-independent error code. */
	public code: ExecutionErrorCode;

	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}

/** Stable compaction error codes returned by compaction helpers. */
export type CompactionErrorCode = "aborted" | "summarization_failed";

/** Error returned by compaction helpers. */
export class CompactionError extends Error {
	/** Backend-independent error code. */
	public code: CompactionErrorCode;

	constructor(code: CompactionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CompactionError";
		this.code = code;
	}
}

/** Stable branch-summary error codes returned by branch summarization helpers. */
export type BranchSummaryErrorCode = "aborted" | "summarization_failed";

/** Error returned by branch summarization helpers. */
export class BranchSummaryError extends Error {
	/** Backend-independent error code. */
	public code: BranchSummaryErrorCode;

	constructor(code: BranchSummaryErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "BranchSummaryError";
		this.code = code;
	}
}

/** Metadata for one filesystem object in a {@link FileSystem}. */
export interface FileInfo {
	/** Basename of {@link path}. */
	name: string;
	/** Absolute, syntactically normalized addressed path in the execution environment. Symlinks are not followed. */
	path: string;
	/** Object kind. Symlink targets are not followed; use {@link FileSystem.canonicalPath} explicitly. */
	kind: FileKind;
	/** Size in bytes for the addressed filesystem object. */
	size: number;
	/** Modification time as milliseconds since Unix epoch. */
	mtimeMs: number;
}

/**
 * Filesystem capability used by the harness.
 *
 * Paths passed to methods may be absolute or relative to {@link cwd}. Paths returned by file operations are addressed paths
 * in the filesystem namespace, but are not canonicalized through symlinks unless returned by {@link canonicalPath}.
 *
 * Operation methods must never throw or reject. All filesystem failures, including unexpected backend failures, must be
 * encoded in the returned {@link Result}. Implementations must preserve this invariant.
 */
export interface FileSystem {
	/** Current working directory for relative paths. */
	cwd: string;

	/** Return an absolute addressed path without requiring it to exist and without resolving symlinks. */
	absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Join path segments in the filesystem namespace without requiring the result to exist. */
	joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Read a UTF-8 text file. */
	readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Read UTF-8 text lines. Implementations should stop once `maxLines` lines have been read. */
	readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>>;
	/** Read a binary file. */
	readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>>;
	/** Create or overwrite a file, creating parent directories when supported. */
	writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** Create or append to a file, creating parent directories when supported. */
	appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** Atomically rename a file, replacing the destination when it exists. Does not copy across filesystems. */
	renameFile(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** Return metadata for the addressed path without following symlinks. */
	fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>>;
	/** List direct children of a directory without following symlinks. */
	listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
	/** Return the canonical path for an existing path, resolving symlinks where supported. */
	canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Return false for missing paths. Other errors, such as permission failures, return a {@link FileError}. */
	exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>>;
	/** Create a directory. Defaults: `recursive: true`, no abort signal. */
	createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>>;
	/** Remove a file or directory. Defaults: `recursive: false`, `force: false`, no abort signal. */
	remove(
		path: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>>;
	/** Create a temporary directory and return its absolute path. Defaults: `prefix: "tmp-"`, no abort signal. */
	createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** Create a temporary file and return its absolute path. Defaults: `prefix: ""`, `suffix: ""`, no abort signal. */
	createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>>;

	/** Release filesystem resources. Must be best-effort and must not throw or reject. */
	cleanup(): Promise<void>;
}

/** Options for {@link Shell.exec}. */
export interface ShellExecOptions {
	/** Working directory for the command. Relative paths are resolved against {@link ExecutionEnv.cwd}. Defaults to {@link ExecutionEnv.cwd}. */
	cwd?: string;
	/** Environment variables for the command. Values override inherited defaults when `inheritEnv` is true. */
	env?: Record<string, string>;
	/** Whether to inherit the execution environment's default variables. Defaults to true. */
	inheritEnv?: boolean;
	/** Timeout in seconds. Implementations should return a timeout error when the command exceeds this duration. Defaults to no timeout. */
	timeout?: number;
	/** Abort signal used to terminate the command. Defaults to no abort signal. */
	abortSignal?: AbortSignal;
	/** Called with stdout chunks as they are produced. */
	onStdout?: (chunk: string) => void;
	/** Called with stderr chunks as they are produced. */
	onStderr?: (chunk: string) => void;
}

/** Shell execution capability used by the harness. */
export interface Shell {
	/** Execute a shell command in {@link FileSystem.cwd} unless `options.cwd` is provided. */
	exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>;
	/** Release shell resources. Must be best-effort and must not throw or reject. */
	cleanup(): Promise<void>;
}

/** Filesystem and process execution environment used by the harness. */
export interface ExecutionEnv extends FileSystem, Shell {}
