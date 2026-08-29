import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type { FoundationJsonValue } from "@aos-agent/agent-core";
import {
	type PolicyBinding,
	PolicyError,
	type PolicyErrorCode,
	type PolicyResource,
	type SandboxCapabilities,
} from "./execution.ts";
import {
	TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH,
	TASK_CREDENTIAL_MAX_SCOPES,
	TASK_CREDENTIAL_MAX_TTL_MS,
	TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH,
	TASK_CREDENTIAL_SCHEMA_VERSION,
	TaskCredentialError,
	calculateScopeDigest,
	isTaskCredentialDeliveryReceipt,
	isTaskCredentialIdentifier,
	isTaskCredentialIsoTimestamp,
	isTaskCredentialScope,
	normalizeTaskCredentialScopes,
	serializeTaskCredentialDeliveryReceipt,
	type TaskCredentialDeliveryReceipt,
	type TaskCredentialErrorCode,
	type TaskCredentialGrant,
	type TaskCredentialScope,
} from "./task-credential-lease.ts";
import {
	isTaskCredentialProviderReceipt,
	isTaskCredentialTargetCapabilities,
	serializeTaskCredentialProviderReceipt,
	serializeTaskCredentialTargetCapabilities,
	type TaskCredentialProviderReceipt,
	type TaskCredentialTargetCapabilities,
} from "./task-credential-provider.ts";
import {
	createBindingHandle,
	createBindingRevision,
	isBindingHandle,
	type BindingHandle,
	type PublicBindingSummary,
} from "../binding-handles.ts";
import type { MCPServerConfig } from "../runtime/mcp-types.ts";

export interface SandboxOperationRequest {
	readonly bindingId: string;
	readonly resource: PolicyResource;
	readonly operation?: "file.read" | "file.write" | "directory.list" | "filesystem.find" | "filesystem.grep";
	readonly command?: string;
	readonly cwd?: string;
	readonly timeoutMs?: number;
	readonly env?: NodeJS.ProcessEnv;
	readonly args?: ReadonlyArray<string>;
	readonly path?: string;
	readonly targetPath?: string;
	readonly content?: string;
	readonly pattern?: string;
	readonly glob?: string;
	readonly ignoreCase?: boolean;
	readonly literal?: boolean;
	readonly context?: number;
	readonly limit?: number;
	readonly signal?: AbortSignal;
	readonly onData?: (data: Buffer) => void;
}

export interface SandboxDirectoryEntry {
	readonly name: string;
	readonly isDirectory?: boolean;
}

export interface SandboxOperationResult {
	readonly exitCode?: number | null;
	readonly content?: Buffer | string;
	readonly stdout?: Buffer | string;
	readonly stderr?: Buffer | string;
	readonly killed?: boolean;
	readonly entries?: ReadonlyArray<string | SandboxDirectoryEntry>;
	readonly isDirectory?: boolean;
	readonly mimeType?: string;
}

const WORKER_OPERATION_PAYLOAD_KEYS = new Set([
	"resource",
	"operation",
	"command",
	"cwd",
	"timeoutMs",
	"args",
	"path",
	"content",
	"pattern",
	"glob",
	"ignoreCase",
	"literal",
	"context",
	"limit",
]);

const WORKER_OPERATION_RESOURCES: readonly PolicyResource[] = [
	"filesystem.read",
	"filesystem.write",
	"filesystem.find",
	"filesystem.grep",
	"process.spawn",
];

/** Convert provider-neutral ToolGateway JSON into the existing Sandbox handle contract. */
export function resolveWorkerSandboxOperation(
	bindingId: string,
	payload: FoundationJsonValue | undefined,
	signal?: AbortSignal,
): SandboxOperationRequest | undefined {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const value = payload as Record<string, FoundationJsonValue>;
	if (!Object.keys(value).every((key) => WORKER_OPERATION_PAYLOAD_KEYS.has(key))) return undefined;
	if (typeof value.resource !== "string" || !WORKER_OPERATION_RESOURCES.includes(value.resource as PolicyResource)) return undefined;
	const stringFields = ["operation", "command", "cwd", "path", "content", "pattern", "glob"] as const;
	if (stringFields.some((field) => value[field] !== undefined && typeof value[field] !== "string")) return undefined;
	const numberFields = ["timeoutMs", "context", "limit"] as const;
	if (numberFields.some((field) => value[field] !== undefined && (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0))) return undefined;
	if (["ignoreCase", "literal"].some((field) => value[field] !== undefined && typeof value[field] !== "boolean")) return undefined;
	if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string"))) return undefined;
	const operation = value.operation;
	if (operation !== undefined && !["file.read", "file.write", "directory.list", "filesystem.find", "filesystem.grep"].includes(operation as string)) return undefined;
	const nonEmptyString = (field: keyof typeof value): boolean => typeof value[field] === "string" && value[field].length > 0;
	const hasProcessFallbackField = value.command !== undefined || value.cwd !== undefined ||
		value.args !== undefined || value.timeoutMs !== undefined;
	const processFallbackShapeValid = !hasProcessFallbackField || nonEmptyString("command") && nonEmptyString("cwd");
	const operationMatchesResource =
		value.resource === "filesystem.read"
			? (operation === "file.read" || operation === "directory.list") && nonEmptyString("path")
			: value.resource === "filesystem.write"
				? operation === "file.write" && nonEmptyString("path") && typeof value.content === "string"
				: value.resource === "filesystem.find"
					? operation === "filesystem.find" && nonEmptyString("path") && nonEmptyString("pattern") && processFallbackShapeValid
					: value.resource === "filesystem.grep"
						? operation === "filesystem.grep" && nonEmptyString("path") && nonEmptyString("pattern") && processFallbackShapeValid
						: operation === undefined && nonEmptyString("command") && nonEmptyString("cwd");
	if (!operationMatchesResource) return undefined;
	const allowedKeys = value.resource === "filesystem.read"
		? operation === "file.read"
			? new Set(["resource", "operation", "path"])
			: new Set(["resource", "operation", "path", "limit"])
		: value.resource === "filesystem.write"
			? new Set(["resource", "operation", "path", "content"])
			: value.resource === "filesystem.find"
				? new Set(["resource", "operation", "command", "args", "cwd", "timeoutMs", "path", "pattern", "limit"])
				: value.resource === "filesystem.grep"
					? new Set(["resource", "operation", "command", "args", "cwd", "timeoutMs", "path", "pattern", "glob", "ignoreCase", "literal", "context", "limit"])
					: new Set(["resource", "command", "args", "cwd", "timeoutMs"]);
	if (!Object.keys(value).every((key) => allowedKeys.has(key))) return undefined;
	return {
		bindingId,
		resource: value.resource as PolicyResource,
		...(operation === undefined ? {} : { operation: operation as SandboxOperationRequest["operation"] }),
		...(typeof value.command === "string" ? { command: value.command } : {}),
		...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
		...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
		...(Array.isArray(value.args) ? { args: value.args as string[] } : {}),
		...(typeof value.path === "string" ? { path: value.path } : {}),
		...(typeof value.content === "string" ? { content: value.content } : {}),
		...(typeof value.pattern === "string" ? { pattern: value.pattern } : {}),
		...(typeof value.glob === "string" ? { glob: value.glob } : {}),
		...(typeof value.ignoreCase === "boolean" ? { ignoreCase: value.ignoreCase } : {}),
		...(typeof value.literal === "boolean" ? { literal: value.literal } : {}),
		...(typeof value.context === "number" ? { context: value.context } : {}),
		...(typeof value.limit === "number" ? { limit: value.limit } : {}),
		...(signal === undefined ? {} : { signal }),
	};
}

export interface SandboxMCPTransportRequest {
	readonly bindingId: string;
	readonly serverId: string;
	readonly config: MCPServerConfig;
	readonly environment: Readonly<Record<string, string>>;
	readonly headers: Readonly<Record<string, string>>;
}

/**
 * Provider-neutral Task Credential delivery (project) into the sandbox
 * target. The request carries only safe facts — lease and grant identity,
 * the Task Execution Binding id that authorized the delivery, the Policy
 * Binding id of the sandbox session, the credential target, the normalized
 * scope allowlist, and the canonical expiry — never material, environment
 * values, paths, prompts, or provider internals. The handle implements the
 * actual target-side injection.
 */
export interface SandboxCredentialDeliveryRequest {
	/** The Task Execution Binding id that authorized this delivery. */
	readonly bindingId: string;
	/** The Policy Binding id of the sandbox session the channel is bound to. */
	readonly sandboxBindingId: string;
	readonly leaseId: string;
	readonly grantId: string;
	/** The credential target of the lease; a foreign target fails closed. */
	readonly targetId: string;
	/** Normalized (deduped, sorted) scope allowlist of the grant. */
	readonly scopes: ReadonlyArray<TaskCredentialScope>;
	/** Canonical lease expiry; the target must honor it. */
	readonly expiresAt: string;
	readonly clientRequestId: string;
}

/** Provider-neutral renewal: the handle rotates material inside the target. */
export interface SandboxCredentialRenewRequest {
	readonly bindingId: string;
	readonly sandboxBindingId: string;
	readonly leaseId: string;
	readonly grantId: string;
	readonly targetId: string;
	/** The extended canonical lease expiry the target must honor. */
	readonly expiresAt: string;
	readonly clientRequestId: string;
}

/** Provider-neutral revocation inside the target. */
export interface SandboxCredentialRevokeRequest {
	readonly bindingId: string;
	readonly sandboxBindingId: string;
	readonly leaseId: string;
	readonly grantId: string;
	readonly targetId: string;
	readonly reasonCode?: string;
	readonly clientRequestId: string;
}

/** Outcome-only handle report for delivery and renewal; material never crosses this boundary. */
export type SandboxCredentialDeliveryOutcome = "succeeded" | "failed" | "unknown";

export interface SandboxCredentialDeliveryResult {
	readonly outcome: SandboxCredentialDeliveryOutcome;
}

/** Outcome-only handle report for revocation; material never crosses this boundary. */
export interface SandboxCredentialRevokeResult {
	readonly outcome: "confirmed" | "unknown";
}

export interface SandboxHandle {
	readonly id: string;
	readonly capabilities: SandboxCapabilities;
	/** Optional metadata lets the host reject a handle returned for another run. */
	readonly bindingId?: string;
	readonly providerId?: string;
	readonly status?: "ready" | "closing" | "closed" | "failed";
	execute(request: SandboxOperationRequest): Promise<SandboxOperationResult>;
	createMcpTransport?(request: SandboxMCPTransportRequest): Promise<Transport> | Transport;
	/**
	 * Task Credential delivery into the target. Present only when the
	 * provider declares `credentialDelivery`; absence fails closed and never
	 * falls back to Host environment, command line, or temporary files.
	 */
	projectCredential?(request: SandboxCredentialDeliveryRequest): Promise<SandboxCredentialDeliveryResult> | SandboxCredentialDeliveryResult;
	renewCredential?(request: SandboxCredentialRenewRequest): Promise<SandboxCredentialDeliveryResult> | SandboxCredentialDeliveryResult;
	revokeCredential?(request: SandboxCredentialRevokeRequest): Promise<SandboxCredentialRevokeResult> | SandboxCredentialRevokeResult;
}

export interface SandboxProvider {
	readonly id: string;
	readonly capabilities: SandboxCapabilities;
	prepare(binding: PolicyBinding, signal?: AbortSignal): Promise<SandboxHandle>;
	dispose(handle: SandboxHandle): Promise<void>;
}

/**
 * Inputs needed to create a stable Sandbox binding reference. The live
 * SandboxHandle is optional and its process/runtime id is never serialized.
 */
export interface SandboxBindingHandleOptions {
	readonly binding: Pick<PolicyBinding, "id" | "sandboxProviderId" | "sandboxCapabilities" | "sandboxStatus">;
	readonly handle?: Pick<SandboxHandle, "providerId" | "status" | "capabilities">;
}

/**
 * Build a stable Sandbox handle from the persisted policy binding and public
 * provider capabilities. A provider's live handle id is intentionally not a
 * part of the identity because it changes across restart/replay.
 */
export function toSandboxBindingHandle(options: SandboxBindingHandleOptions): BindingHandle {
	const providerId = options.handle?.providerId ?? options.binding.sandboxProviderId;
	const capabilities = options.handle?.capabilities ?? options.binding.sandboxCapabilities;
	const status = options.handle?.status ?? options.binding.sandboxStatus;
	const summary: PublicBindingSummary = {
		policyBindingId: options.binding.id,
		status,
		filesystem: capabilities.filesystem,
		process: capabilities.process,
		network: capabilities.network,
		credentialIsolation: capabilities.credentialIsolation,
		...(providerId === undefined ? {} : { providerId }),
	};
	return createBindingHandle({
		domain: "sandbox",
		bindingId: options.binding.id,
		revision: createBindingRevision({
			policyBindingId: options.binding.id,
			providerId,
			status,
			capabilities,
		}),
		relation: "policy.sandbox",
		...(providerId === undefined ? {} : { role: providerId }),
		summary,
	});
}

export const createSandboxBindingHandle = toSandboxBindingHandle;
export const toPublicSandboxBindingHandle = toSandboxBindingHandle;
export const serializePublicSandboxBindingHandle = toSandboxBindingHandle;

export function isSandboxBindingHandle(value: unknown): value is BindingHandle {
	return isBindingHandle(value) && value.domain === "sandbox";
}

export type SandboxLifecycleStatus = "new" | "preparing" | "ready" | "disposed" | "failed";

export class SandboxError extends PolicyError {
	readonly providerId?: string;
	readonly handleId?: string;

	constructor(code: PolicyErrorCode, message?: string, options?: { providerId?: string; handleId?: string }) {
		super(code, message);
		this.name = "SandboxError";
		this.providerId = options?.providerId;
		this.handleId = options?.handleId;
	}
}

export class SandboxCapabilityError extends SandboxError {
	constructor(providerId: string, capability: keyof SandboxCapabilities) {
		super("sandbox_capability_insufficient", `Sandbox provider "${providerId}" lacks ${capability} capability.`, {
			providerId,
		});
		this.name = "SandboxCapabilityError";
	}
}

export class SandboxHandleDisposedError extends SandboxError {
	constructor(handleId: string) {
		super("sandbox_unavailable", `Sandbox handle "${handleId}" has been disposed.`, { handleId });
		this.name = "SandboxHandleDisposedError";
	}
}

function sandboxAbortError(signal: AbortSignal): DOMException {
	return new DOMException(
		signal.reason instanceof Error ? signal.reason.message : "Sandbox operation aborted",
		"AbortError",
	);
}

export function requireSandboxCapability(
	providerId: string,
	capabilities: SandboxCapabilities,
	capability: keyof SandboxCapabilities,
): void {
	if (!capabilities[capability]) throw new SandboxCapabilityError(providerId, capability);
}

export class SandboxSession {
	private status: SandboxLifecycleStatus = "new";
	private handle: SandboxHandle | undefined;
	readonly provider: SandboxProvider;
	readonly binding: PolicyBinding;

	constructor(provider: SandboxProvider, binding: PolicyBinding) {
		this.provider = provider;
		this.binding = binding;
	}

	get currentStatus(): SandboxLifecycleStatus {
		return this.status;
	}

	get currentHandle(): SandboxHandle | undefined {
		return this.handle;
	}

	async prepare(signal?: AbortSignal): Promise<SandboxHandle> {
		if (this.status === "disposed") throw new SandboxError("sandbox_unavailable", "Sandbox session is disposed.");
		if (this.handle !== undefined) return this.handle;
		if (signal?.aborted) {
			this.status = "failed";
			throw sandboxAbortError(signal);
		}
		this.status = "preparing";
		for (const capability of Object.keys(this.provider.capabilities) as Array<keyof SandboxCapabilities>) {
			if (this.binding.sandboxCapabilities[capability] && !this.provider.capabilities[capability]) {
				this.status = "failed";
				throw new SandboxCapabilityError(this.provider.id, capability);
			}
		}
		let preparedHandle: SandboxHandle | undefined;
		try {
			const handle = await this.provider.prepare(this.binding, signal);
			preparedHandle = handle;
			if (signal?.aborted) {
				await this.provider.dispose(handle).catch(() => undefined);
				preparedHandle = undefined;
				throw sandboxAbortError(signal);
			}
			if (handle.bindingId !== undefined && handle.bindingId !== this.binding.id) {
				throw new SandboxError("sandbox_start_failed", "Sandbox handle does not match the policy binding.", {
					providerId: this.provider.id,
					handleId: handle.id,
				});
			}
			if (handle.providerId !== undefined && handle.providerId !== this.provider.id) {
				throw new SandboxError("sandbox_start_failed", "Sandbox handle does not match the provider.", {
					providerId: this.provider.id,
					handleId: handle.id,
				});
			}
			if (handle.status !== undefined && handle.status !== "ready") {
				throw new SandboxError("sandbox_start_failed", "Sandbox handle is not ready.", {
					providerId: this.provider.id,
					handleId: handle.id,
				});
			}
			this.handle = handle;
			this.status = "ready";
			return this.handle;
		} catch (error) {
			this.status = "failed";
			if (signal?.aborted) {
				if (preparedHandle !== undefined) await this.provider.dispose(preparedHandle).catch(() => undefined);
				throw sandboxAbortError(signal);
			}
			if (error instanceof SandboxError || error instanceof PolicyError) throw error;
			throw new SandboxError("sandbox_start_failed", "The sandbox provider failed to prepare a handle.", {
				providerId: this.provider.id,
			});
		}
	}

	async dispose(): Promise<void> {
		if (this.status === "disposed") return;
		const handle = this.handle;
		this.handle = undefined;
		this.status = "disposed";
		if (handle !== undefined) await this.provider.dispose(handle);
	}
}

/**
 * Task Credential / Lease delivery preflight (read-only).
 *
 * Pure lease check for one sandbox delivery operation: the grant must exist
 * with matching lease, grant, binding, and target identity, the status must
 * be live (`active` / `renewing`), and `now` must be a canonical timestamp
 * before the grant expiry. It never calls the handle, the provider, or the
 * wall clock (`now` is injected) and never appends anything.
 */
export type TaskCredentialDeliveryPreflightResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: TaskCredentialErrorCode };

export function preflightTaskCredentialDelivery(
	grant: TaskCredentialGrant | undefined,
	request: SandboxCredentialDeliveryRequest | SandboxCredentialRenewRequest | SandboxCredentialRevokeRequest,
	now: string,
): TaskCredentialDeliveryPreflightResult {
	if (grant === undefined) return { ok: false, code: "task_credential_not_found" };
	if (!isTaskCredentialIsoTimestamp(now)) return { ok: false, code: "task_credential_invalid" };
	if (grant.leaseId !== request.leaseId || grant.grantId !== request.grantId) {
		return { ok: false, code: "task_credential_not_found" };
	}
	if (grant.bindingId !== request.bindingId) {
		// Per-binding delivery: only the binding that authorized the lease may
		// deliver, renew, or revoke it.
		return { ok: false, code: "task_credential_binding_invalid" };
	}
	if ((grant.targetId ?? null) !== request.targetId) {
		// Wrong target: material must land on the lease's own target only.
		return { ok: false, code: "task_credential_binding_invalid" };
	}
	switch (grant.status) {
		case "active":
		case "renewing":
			break;
		case "expired":
			return { ok: false, code: "task_lease_expired" };
		case "revoked":
		case "settled":
			return { ok: false, code: "task_credential_conflict" };
		case "revocation_unknown":
			return { ok: false, code: "task_credential_revocation_unknown" };
	}
	if (Date.parse(now) >= Date.parse(grant.expiresAt)) {
		return { ok: false, code: "task_lease_expired" };
	}
	return { ok: true };
}

/**
 * Per-binding Task Credential delivery channel into a sandbox session.
 *
 * The channel is the only delivery surface for lease material inside the
 * sandbox target. It is constructed with the execution binding identity
 * (`bindingId`), the Capability Binding identity of the execution context
 * (`capabilityBindingId`, a separately checked identity), the Policy Binding
 * identity of the session it is bound to (`sandboxBindingId`, which must
 * equal `session.binding.id`), the credential `targetId`, and the safe
 * resolved `targetCapabilities`; every request is checked against all of
 * them before any handle call, so a wrong binding or a wrong target fails
 * closed. The constructor validates the raw option shape first — including
 * the target capability snapshot — so malformed runtime data yields only the
 * stable `task_credential_invalid` error, never a TypeError or raw provider
 * text.
 *
 * Guards run before every operation: request shape, session dispose, binding
 * identity, target identity and quarantine, session/handle readiness, the
 * provider's declared `credentialDelivery` capability, the matching handle
 * method, and the resolved per-operation target capability (per-binding
 * isolation for every operation, short-lived delivery + delivery receipts
 * for project, renew/revoke for their operations). Every operation also
 * requires a read-only live `TaskCredentialGrant` preflight (lease/grant/
 * binding/target/status/expiry) plus the operation correlation: project
 * verifies the scope digest/count and canonical expiry against the grant,
 * and renew verifies the proposed expiry strictly extends the current lease
 * within the absolute ceiling. A handle that does not declare the
 * capability or method fails closed with
 * `task_credential_target_unavailable` — the channel never falls back to
 * Host environment, command line, or temporary files. After a
 * delivery/renewal outcome of `failed` or `unknown`, a revoke outcome of
 * `unknown`, or any handle failure, the target is quarantined: every later
 * operation against it fails closed without touching the handle, and
 * provider-specific errors are mapped to stable Task Credential codes
 * without raw text. The channel never persists anything; receipts are
 * built from handle outcomes alone and validated exactly before they
 * leave.
 */
export interface SandboxCredentialChannelOptions {
	readonly session: SandboxSession;
	/** Task Execution Binding id of the execution context that owns the lease. */
	readonly bindingId: string;
	/** Capability Binding id; the resolved target capabilities must address it. */
	readonly capabilityBindingId: string;
	/** Policy Binding id of the sandbox session; must equal `session.binding.id`. */
	readonly sandboxBindingId: string;
	/** The credential target this channel delivers into. */
	readonly targetId: string;
	/**
	 * Safe resolved per-binding target capability facts; required so the
	 * channel can enforce the operation-specific capability and per-binding
	 * isolation before any handle call. `targetId` must match the channel's
	 * `targetId` and `bindingId` must match the channel's `bindingId` (the
	 * Task Execution Binding id), never the capability binding id.
	 */
	readonly targetCapabilities: TaskCredentialTargetCapabilities;
	/** Server timestamp source; must return a canonical UTC ISO timestamp. */
	readonly now?: () => string;
}

export type SandboxCredentialPreflightResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: TaskCredentialErrorCode | "sandbox_unavailable" };

type CredentialDeliveryOperation = "project" | "renew" | "revoke";

/** The target capability flag that gates one channel operation. */
function targetOperationCapability(operation: CredentialDeliveryOperation): keyof TaskCredentialTargetCapabilities {
	switch (operation) {
		case "project":
			return "canReceiveShortLivedCredential";
		case "renew":
			return "canRenewCredential";
		case "revoke":
			return "canRevokeCredential";
	}
}

const DELIVERY_REQUEST_KEYS = new Set([
	"bindingId",
	"sandboxBindingId",
	"leaseId",
	"grantId",
	"targetId",
	"scopes",
	"expiresAt",
	"clientRequestId",
]);
const CHANNEL_OPTIONS_KEYS = new Set([
	"session",
	"bindingId",
	"capabilityBindingId",
	"sandboxBindingId",
	"targetId",
	"targetCapabilities",
	"now",
]);
const RENEW_REQUEST_KEYS = new Set([
	"bindingId",
	"sandboxBindingId",
	"leaseId",
	"grantId",
	"targetId",
	"expiresAt",
	"clientRequestId",
]);
const REVOKE_REQUEST_KEYS = new Set([
	"bindingId",
	"sandboxBindingId",
	"leaseId",
	"grantId",
	"targetId",
	"reasonCode",
	"clientRequestId",
]);
const OUTCOME_KEYS = new Set(["outcome"]);

function invalidCredentialRequest(): TaskCredentialError {
	return new TaskCredentialError("task_credential_invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isClientRequestId(value: unknown): value is string {
	return isTaskCredentialIdentifier(value) && value.length <= TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH;
}

function isOptionalReasonCode(value: unknown): value is string | undefined {
	return value === undefined || (isTaskCredentialIdentifier(value) && value.length <= TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH);
}

function isTaskCredentialScopeList(value: unknown): value is ReadonlyArray<TaskCredentialScope> {
	if (!Array.isArray(value) || value.length === 0 || value.length > TASK_CREDENTIAL_MAX_SCOPES) return false;
	return value.every((item) => isTaskCredentialScope(item));
}

function isDeliveryResult(value: unknown): value is SandboxCredentialDeliveryResult {
	if (!isRecord(value) || !hasOnlyKeys(value, OUTCOME_KEYS)) return false;
	return value.outcome === "succeeded" || value.outcome === "failed" || value.outcome === "unknown";
}

function isRevokeResult(value: unknown): value is SandboxCredentialRevokeResult {
	if (!isRecord(value) || !hasOnlyKeys(value, OUTCOME_KEYS)) return false;
	return value.outcome === "confirmed" || value.outcome === "unknown";
}

function isDeliveryRequest(value: unknown): value is SandboxCredentialDeliveryRequest {
	return isRecord(value) && "scopes" in value;
}

function isRenewRequest(value: unknown): value is SandboxCredentialRenewRequest {
	return isRecord(value) && !("scopes" in value) && !("reasonCode" in value);
}

function validateDeliveryRequest(value: SandboxCredentialDeliveryRequest): void {
	const raw: unknown = value;
	if (!isRecord(raw) || !hasOnlyKeys(raw, DELIVERY_REQUEST_KEYS)) throw invalidCredentialRequest();
	if (
		!isTaskCredentialIdentifier(value.bindingId) ||
		!isTaskCredentialIdentifier(value.sandboxBindingId) ||
		!isTaskCredentialIdentifier(value.leaseId) ||
		!isTaskCredentialIdentifier(value.grantId) ||
		!isTaskCredentialIdentifier(value.targetId) ||
		!isTaskCredentialScopeList(value.scopes) ||
		!isTaskCredentialIsoTimestamp(value.expiresAt) ||
		!isClientRequestId(value.clientRequestId)
	) {
		throw invalidCredentialRequest();
	}
}

function validateRenewRequest(value: SandboxCredentialRenewRequest): void {
	const raw: unknown = value;
	if (!isRecord(raw) || !hasOnlyKeys(raw, RENEW_REQUEST_KEYS)) throw invalidCredentialRequest();
	if (
		!isTaskCredentialIdentifier(value.bindingId) ||
		!isTaskCredentialIdentifier(value.sandboxBindingId) ||
		!isTaskCredentialIdentifier(value.leaseId) ||
		!isTaskCredentialIdentifier(value.grantId) ||
		!isTaskCredentialIdentifier(value.targetId) ||
		!isTaskCredentialIsoTimestamp(value.expiresAt) ||
		!isClientRequestId(value.clientRequestId)
	) {
		throw invalidCredentialRequest();
	}
}

function validateRevokeRequest(value: SandboxCredentialRevokeRequest): void {
	const raw: unknown = value;
	if (!isRecord(raw) || !hasOnlyKeys(raw, REVOKE_REQUEST_KEYS)) throw invalidCredentialRequest();
	if (
		!isTaskCredentialIdentifier(value.bindingId) ||
		!isTaskCredentialIdentifier(value.sandboxBindingId) ||
		!isTaskCredentialIdentifier(value.leaseId) ||
		!isTaskCredentialIdentifier(value.grantId) ||
		!isTaskCredentialIdentifier(value.targetId) ||
		!isOptionalReasonCode(value.reasonCode) ||
		!isClientRequestId(value.clientRequestId)
	) {
		throw invalidCredentialRequest();
	}
}

export class SandboxCredentialChannel {
	readonly session: SandboxSession;
	readonly bindingId: string;
	readonly capabilityBindingId: string;
	readonly sandboxBindingId: string;
	readonly targetId: string;
	readonly targetCapabilities: TaskCredentialTargetCapabilities;
	private readonly quarantinedTargets = new Set<string>();
	private readonly nowFn: () => string;

	constructor(options: SandboxCredentialChannelOptions) {
		// The raw option shape is validated before any property is read or
		// serialized: malformed runtime data (null, primitives, unknown keys,
		// a broken session, or a malformed target capability snapshot) yields
		// only the stable TaskCredentialError, never a TypeError or raw
		// provider text.
		const raw: unknown = options;
		if (
			!isRecord(raw) ||
			!hasOnlyKeys(raw, CHANNEL_OPTIONS_KEYS) ||
			!isRecord(options.session) ||
			!isRecord(options.session.binding) ||
			!isTaskCredentialIdentifier(options.session.binding.id) ||
			!isTaskCredentialIdentifier(options.bindingId) ||
			!isTaskCredentialIdentifier(options.capabilityBindingId) ||
			!isTaskCredentialIdentifier(options.sandboxBindingId) ||
			!isTaskCredentialIdentifier(options.targetId) ||
			!isTaskCredentialTargetCapabilities(options.targetCapabilities)
		) {
			throw invalidCredentialRequest();
		}
		this.session = options.session;
		this.bindingId = options.bindingId;
		this.capabilityBindingId = options.capabilityBindingId;
		this.sandboxBindingId = options.sandboxBindingId;
		this.targetId = options.targetId;
		this.targetCapabilities = serializeTaskCredentialTargetCapabilities(options.targetCapabilities);
		this.nowFn = options.now ?? (() => new Date().toISOString());
		if (this.targetCapabilities.targetId !== this.targetId || this.targetCapabilities.bindingId !== this.bindingId) {
			// The resolved target facts must address exactly this channel's
			// target under the channel's Task Execution Binding; the capability
			// binding id is a separate execution-context identity.
			throw new TaskCredentialError("task_credential_binding_invalid");
		}
		if (this.sandboxBindingId !== this.session.binding.id) {
			// The channel is bound to exactly one Policy Binding: the session's.
			throw new TaskCredentialError("task_credential_binding_invalid");
		}
	}

	/** Whether the target is quarantined; quarantined targets fail closed. */
	isTargetQuarantined(targetId: string): boolean {
		return this.quarantinedTargets.has(targetId);
	}

	/** Host-driven quarantine: no further delivery/renew/revoke to the target. */
	quarantineTarget(targetId: string): void {
		if (!isTaskCredentialIdentifier(targetId)) throw invalidCredentialRequest();
		this.quarantinedTargets.add(targetId);
	}

	/** Snapshot of every currently quarantined target id. */
	quarantined(): readonly string[] {
		return [...this.quarantinedTargets];
	}

	/**
	 * Read-only preflight for one delivery operation. Combines the pure lease
	 * preflight, the channel guards, and the operation-specific grant
	 * correlation (project scope digest/count and expiry, renew bounds). Never
	 * calls the handle, never appends, and never mutates quarantine state.
	 * Malformed requests throw the stable `task_credential_invalid` error.
	 */
	preflight(
		grant: TaskCredentialGrant | undefined,
		request: SandboxCredentialDeliveryRequest | SandboxCredentialRenewRequest | SandboxCredentialRevokeRequest,
		now: string,
	): SandboxCredentialPreflightResult {
		if (isDeliveryRequest(request)) {
			validateDeliveryRequest(request);
			return this.preflightChecked(grant, request, now, "project");
		}
		if (isRenewRequest(request)) {
			validateRenewRequest(request);
			return this.preflightChecked(grant, request, now, "renew");
		}
		validateRevokeRequest(request);
		return this.preflightChecked(grant, request, now, "revoke");
	}

	/**
	 * Deliver the lease's material into the sandbox target. The live grant is
	 * required: without a read-only preflight that passes lease/grant/binding/
	 * target/status/expiry plus scope digest/count and expiry correlation, the
	 * handle is never reached.
	 */
	async project(grant: TaskCredentialGrant, request: SandboxCredentialDeliveryRequest): Promise<TaskCredentialDeliveryReceipt> {
		validateDeliveryRequest(request);
		const handle = this.assertGrantPreflight(grant, request, "project");
		const method = handle.projectCredential;
		if (method === undefined) throw new TaskCredentialError("task_credential_target_unavailable");
		let result: SandboxCredentialDeliveryResult;
		try {
			const outcome = await method.call(handle, request);
			if (!isDeliveryResult(outcome)) throw invalidCredentialRequest();
			result = outcome;
		} catch (error) {
			throw this.mapHandleError(error, request.targetId, "project");
		}
		if (result.outcome !== "succeeded") {
			// A failed or unknown delivery quarantines the target: the lease
			// state inside the target is untrusted, so nothing else may touch it.
			this.quarantineTarget(request.targetId);
		}
		return this.buildDeliveryReceipt(request, result.outcome);
	}

	/**
	 * Rotate the lease's material inside the sandbox target. The live grant is
	 * required, and the proposed expiry must extend the current lease without
	 * pushing it past the absolute lease ceiling.
	 */
	async renew(grant: TaskCredentialGrant, request: SandboxCredentialRenewRequest): Promise<TaskCredentialDeliveryReceipt> {
		validateRenewRequest(request);
		const handle = this.assertGrantPreflight(grant, request, "renew");
		const method = handle.renewCredential;
		if (method === undefined) throw new TaskCredentialError("task_credential_target_unavailable");
		let result: SandboxCredentialDeliveryResult;
		try {
			const outcome = await method.call(handle, request);
			if (!isDeliveryResult(outcome)) throw invalidCredentialRequest();
			result = outcome;
		} catch (error) {
			throw this.mapHandleError(error, request.targetId, "renew");
		}
		if (result.outcome !== "succeeded") {
			this.quarantineTarget(request.targetId);
		}
		return this.buildDeliveryReceipt(request, result.outcome);
	}

	/**
	 * Revoke the lease's material inside the sandbox target. The live grant is
	 * required; an unknown revoke outcome quarantines the target.
	 */
	async revoke(grant: TaskCredentialGrant, request: SandboxCredentialRevokeRequest): Promise<TaskCredentialProviderReceipt> {
		validateRevokeRequest(request);
		const handle = this.assertGrantPreflight(grant, request, "revoke");
		const method = handle.revokeCredential;
		if (method === undefined) throw new TaskCredentialError("task_credential_target_unavailable");
		let result: SandboxCredentialRevokeResult;
		try {
			const outcome = await method.call(handle, request);
			if (!isRevokeResult(outcome)) throw invalidCredentialRequest();
			result = outcome;
		} catch (error) {
			throw this.mapHandleError(error, request.targetId, "revoke");
		}
		if (result.outcome !== "confirmed") {
			// Unknown revocation: the target state is untrusted, so it is
			// quarantined until a provider-confirmed reconciliation.
			this.quarantineTarget(request.targetId);
		}
		return this.buildRevokeReceipt(request, result.outcome);
	}

	// ---- Internals ---------------------------------------------------------

	private channelFailureCode(
		request: SandboxCredentialDeliveryRequest | SandboxCredentialRenewRequest | SandboxCredentialRevokeRequest,
		operation: CredentialDeliveryOperation,
	): TaskCredentialErrorCode | "sandbox_unavailable" | undefined {
		// Capability-first per-operation guard: every operation re-checks the
		// declared delivery capability, the resolved target capabilities, and
		// the matching handle method before any handle call; a disposed
		// session fails every later operation.
		if (this.session.currentStatus === "disposed") return "sandbox_unavailable";
		if (request.sandboxBindingId !== this.sandboxBindingId || request.bindingId !== this.bindingId) {
			return "task_credential_binding_invalid";
		}
		if (request.targetId !== this.targetId || this.quarantinedTargets.has(request.targetId)) {
			return "task_credential_binding_invalid";
		}
		const handle = this.session.currentHandle;
		if (handle === undefined || this.session.currentStatus !== "ready") return "sandbox_unavailable";
		if (handle.status !== undefined && handle.status !== "ready") return "sandbox_unavailable";
		// Strict missing capability: the provider never declared the delivery
		// channel, so the target is unavailable. There is no Host environment,
		// command line, or temporary-file fallback.
		if (!handle.capabilities.credentialDelivery) return "task_credential_target_unavailable";
		if (handle[`${operation}Credential`] === undefined) return "task_credential_target_unavailable";
		// Strict target capability: the resolved per-binding facts must declare
		// per-binding isolation plus the operation's own capability, and
		// delivery additionally needs receipt support.
		if (!this.targetCapabilities.supportsPerBindingIsolation) return "task_credential_target_unavailable";
		if (!this.targetCapabilities[targetOperationCapability(operation)]) return "task_credential_target_unavailable";
		if (operation === "project" && !this.targetCapabilities.supportsDeliveryReceipt) {
			return "task_credential_target_unavailable";
		}
		return undefined;
	}

	/**
	 * Run the full read-only preflight (lease identity/status/expiry, channel
	 * guards, and the operation-specific grant correlation) and return the
	 * ready handle; a failure throws the stable provider-neutral error.
	 */
	private assertGrantPreflight(
		grant: TaskCredentialGrant,
		request: SandboxCredentialDeliveryRequest | SandboxCredentialRenewRequest | SandboxCredentialRevokeRequest,
		operation: CredentialDeliveryOperation,
	): SandboxHandle {
		const preflight = this.preflightChecked(grant, request, this.nextTimestamp(), operation);
		if (preflight.ok) return this.session.currentHandle as SandboxHandle;
		const code = preflight.code;
		if (code === "sandbox_unavailable") {
			throw new SandboxError("sandbox_unavailable", "The sandbox session is not available for credential delivery.", {
				handleId: this.session.currentHandle?.id,
			});
		}
		throw new TaskCredentialError(code);
	}

	private preflightChecked<T extends SandboxCredentialDeliveryRequest | SandboxCredentialRenewRequest | SandboxCredentialRevokeRequest>(
		grant: TaskCredentialGrant | undefined,
		request: T,
		now: string,
		operation: CredentialDeliveryOperation,
	): SandboxCredentialPreflightResult {
		const leaseCheck = preflightTaskCredentialDelivery(grant, request, now);
		if (!leaseCheck.ok) return leaseCheck;
		const channelCode = this.channelFailureCode(request, operation);
		if (channelCode !== undefined) return { ok: false, code: channelCode };
		// The grant passed the lease check, so it is a live grant; correlation
		// is enforced per operation before any handle call.
		const correlation =
			operation === "project"
				? this.projectGrantCorrelation(grant as TaskCredentialGrant, request as SandboxCredentialDeliveryRequest)
				: operation === "renew"
					? this.renewGrantBounds(grant as TaskCredentialGrant, request as SandboxCredentialRenewRequest)
					: undefined;
		if (correlation !== undefined) return { ok: false, code: correlation };
		return { ok: true };
	}

	private projectGrantCorrelation(
		grant: TaskCredentialGrant,
		request: SandboxCredentialDeliveryRequest,
	): TaskCredentialErrorCode | undefined {
		// The projected scope set must be exactly the grant's normalized scope
		// set (same digest and same count), and the projected expiry must be
		// the grant's canonical expiry.
		if (request.expiresAt !== grant.expiresAt) return "task_credential_conflict";
		let normalized: ReadonlyArray<TaskCredentialScope>;
		try {
			normalized = normalizeTaskCredentialScopes(request.scopes);
		} catch {
			return "task_credential_invalid";
		}
		if (normalized.length !== grant.scopeCount) return "task_credential_conflict";
		let digest: string;
		try {
			digest = calculateScopeDigest(normalized);
		} catch {
			return "task_credential_invalid";
		}
		if (digest !== grant.scopeDigest) return "task_credential_conflict";
		return undefined;
	}

	private renewGrantBounds(grant: TaskCredentialGrant, request: SandboxCredentialRenewRequest): TaskCredentialErrorCode | undefined {
		// The proposed renewal expiry must strictly extend the current lease
		// but never push it past the absolute lease ceiling measured from
		// issuance; both bounds use only the safe grant context.
		const currentExpiryMs = Date.parse(grant.expiresAt);
		const proposedMs = Date.parse(request.expiresAt);
		if (!Number.isFinite(currentExpiryMs) || !Number.isFinite(proposedMs)) return "task_credential_invalid";
		if (proposedMs <= currentExpiryMs) return "task_credential_ttl_invalid";
		const ceilingMs = Date.parse(grant.issuedAt) + TASK_CREDENTIAL_MAX_TTL_MS;
		if (proposedMs > ceilingMs) return "task_credential_ttl_invalid";
		return undefined;
	}

	private mapHandleError(error: unknown, targetId: string, operation: CredentialDeliveryOperation): Error {
		// Every handle failure leaves the target's lease state untrusted, so
		// the target is quarantined before anything else. Provider-specific
		// errors never surface raw text; they map to stable Task Credential
		// codes.
		this.quarantineTarget(targetId);
		if (error instanceof TaskCredentialError) return error;
		return new TaskCredentialError(
			operation === "revoke" ? "task_credential_revocation_unknown" : "task_credential_delivery_failed",
		);
	}

	private buildDeliveryReceipt(
		request: SandboxCredentialDeliveryRequest | SandboxCredentialRenewRequest,
		outcome: SandboxCredentialDeliveryOutcome,
	): TaskCredentialDeliveryReceipt {
		const receipt: TaskCredentialDeliveryReceipt = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			targetId: request.targetId,
			status: outcome,
			recordedAt: this.nextTimestamp(),
		};
		if (!isTaskCredentialDeliveryReceipt(receipt)) {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		return serializeTaskCredentialDeliveryReceipt(receipt);
	}

	private buildRevokeReceipt(request: SandboxCredentialRevokeRequest, outcome: "confirmed" | "unknown"): TaskCredentialProviderReceipt {
		const receipt: TaskCredentialProviderReceipt = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: outcome === "confirmed" ? "revoked" : "revocation_unknown",
			recordedAt: this.nextTimestamp(),
		};
		if (request.reasonCode !== undefined) (receipt as { reasonCode?: string }).reasonCode = request.reasonCode;
		if (!isTaskCredentialProviderReceipt(receipt)) {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		return serializeTaskCredentialProviderReceipt(receipt);
	}

	private nextTimestamp(): string {
		let timestamp: string;
		try {
			timestamp = this.nowFn();
		} catch {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		if (!isTaskCredentialIsoTimestamp(timestamp)) {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		return timestamp;
	}
}
