import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import {
	type PolicyBinding,
	PolicyError,
	type PolicyErrorCode,
	type PolicyResource,
	type SandboxCapabilities,
} from "./execution-policy.ts";
import {
	createBindingHandle,
	createBindingRevision,
	isBindingHandle,
	type BindingHandle,
	type PublicBindingSummary,
} from "./binding-handles.ts";
import type { MCPServerConfig } from "./mcp-types.ts";

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

export interface SandboxMCPTransportRequest {
	readonly bindingId: string;
	readonly serverId: string;
	readonly config: MCPServerConfig;
	readonly environment: Readonly<Record<string, string>>;
	readonly headers: Readonly<Record<string, string>>;
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
