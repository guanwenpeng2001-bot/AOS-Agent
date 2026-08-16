import { writeFile } from "node:fs/promises";
import type { PolicyBinding, SandboxCapabilities } from "../../src/core/execution-policy.ts";
import {
	SandboxError,
	SandboxHandleDisposedError,
	type SandboxCredentialDeliveryRequest,
	type SandboxCredentialRenewRequest,
	type SandboxCredentialRevokeRequest,
	type SandboxHandle,
	type SandboxOperationRequest,
	type SandboxOperationResult,
	type SandboxProvider,
} from "../../src/core/sandbox.ts";

export const FAKE_SANDBOX_PROVIDER_ID = "fake-sandbox";

export interface FakeSandboxCredentialState {
	readonly projects: SandboxCredentialDeliveryRequest[];
	readonly renews: SandboxCredentialRenewRequest[];
	readonly revokes: SandboxCredentialRevokeRequest[];
}

export interface FakeSandboxInvocation {
	readonly bindingId: string;
	readonly resource: SandboxOperationRequest["resource"];
	readonly operation?: SandboxOperationRequest["operation"];
	readonly command?: string;
	readonly args?: ReadonlyArray<string>;
	readonly cwd?: string;
	readonly timeoutMs?: number;
	readonly env: NodeJS.ProcessEnv;
	readonly path?: string;
	readonly targetPath?: string;
	readonly content?: string;
	readonly pattern?: string;
	readonly glob?: string;
	readonly ignoreCase?: boolean;
	readonly literal?: boolean;
	readonly context?: number;
	readonly limit?: number;
}

export interface FakeSandboxProviderState {
	readonly preparedBindings: PolicyBinding[];
	readonly invocations: FakeSandboxInvocation[];
	readonly disposedHandles: string[];
	readonly handles: SandboxHandle[];
	readonly credentialState: FakeSandboxCredentialState;
}

export interface FakeSandboxProviderOptions {
	readonly id?: string;
	readonly capabilities?: Partial<SandboxCapabilities>;
	readonly startFailure?: Error;
	readonly onExecute?: (request: SandboxOperationRequest) => Promise<SandboxOperationResult | undefined>;
	/** Outcome reported by the handle for every credential project/renew; default `succeeded`. */
	readonly credentialDeliveryStatus?: "succeeded" | "failed" | "unknown";
	/** Outcome reported by the handle for every credential revoke; default `confirmed`. */
	readonly credentialRevokeStatus?: "confirmed" | "unknown";
	/** Fail one credential operation with an unknown error; the channel quarantines and maps it. */
	readonly failCredentialOperation?: (operation: "project" | "renew" | "revoke", leaseId: string) => boolean;
}

const FULL_CAPABILITIES: SandboxCapabilities = {
	filesystem: true,
	process: true,
	network: true,
	credentialIsolation: true,
	credentialDelivery: true,
};

function completeCapabilities(capabilities: Partial<SandboxCapabilities> | undefined): SandboxCapabilities {
	return { ...FULL_CAPABILITIES, ...capabilities };
}

export function createFakeSandboxProvider(options: FakeSandboxProviderOptions = {}): {
	readonly provider: SandboxProvider;
	readonly state: FakeSandboxProviderState;
} {
	const capabilities = completeCapabilities(options.capabilities);
	const state: FakeSandboxProviderState = {
		preparedBindings: [],
		invocations: [],
		disposedHandles: [],
		handles: [],
		credentialState: { projects: [], renews: [], revokes: [] },
	};
	const providerId = options.id ?? FAKE_SANDBOX_PROVIDER_ID;

	const provider: SandboxProvider = {
		id: providerId,
		capabilities,
		prepare: async (binding) => {
			state.preparedBindings.push(binding);
			if (options.startFailure !== undefined) {
				throw options.startFailure;
			}
			const handle: SandboxHandle = {
				id: `${providerId}-handle-${state.handles.length + 1}`,
				capabilities,
				execute: async (request) => {
					if (state.disposedHandles.includes(handle.id)) {
						throw new SandboxHandleDisposedError(handle.id);
					}
					state.invocations.push({
						bindingId: request.bindingId,
						resource: request.resource,
						...(request.operation === undefined ? {} : { operation: request.operation }),
						...(request.command === undefined ? {} : { command: request.command }),
						...(request.args === undefined ? {} : { args: [...request.args] }),
						...(request.cwd === undefined ? {} : { cwd: request.cwd }),
						...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
						env: { ...(request.env ?? {}) },
						...(request.path === undefined ? {} : { path: request.path }),
						...(request.targetPath === undefined ? {} : { targetPath: request.targetPath }),
						...(request.content === undefined ? {} : { content: request.content }),
						...(request.pattern === undefined ? {} : { pattern: request.pattern }),
						...(request.glob === undefined ? {} : { glob: request.glob }),
						...(request.ignoreCase === undefined ? {} : { ignoreCase: request.ignoreCase }),
						...(request.literal === undefined ? {} : { literal: request.literal }),
						...(request.context === undefined ? {} : { context: request.context }),
						...(request.limit === undefined ? {} : { limit: request.limit }),
					});
					if (request.signal?.aborted) {
						throw new Error("aborted");
					}
					if (request.resource === "network.connect") {
						throw new SandboxError("network_policy_violation", "Fake sandbox denies network access.");
					}
					if (request.resource === "credential.expose") {
						throw new SandboxError("credential_policy_violation", "Fake sandbox denies credential exposure.");
					}
					if (request.resource === "filesystem.write" && request.path !== undefined && request.content !== undefined) {
						await writeFile(request.path, request.content, "utf-8");
						return {};
					}
					const result = await options.onExecute?.(request);
					if (result?.content !== undefined) {
						request.onData?.(Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content));
					}
					return result ?? { exitCode: 0 };
				},
				// The handle exposes the credential channel only when the provider
				// declares the delivery capability; otherwise the channel fails
				// closed with task_credential_target_unavailable before any call.
				...(capabilities.credentialDelivery === true
					? {
							projectCredential: async (request: SandboxCredentialDeliveryRequest) => {
								if (state.disposedHandles.includes(handle.id)) {
									throw new SandboxHandleDisposedError(handle.id);
								}
								state.credentialState.projects.push({ ...request, scopes: [...request.scopes] });
								if (options.failCredentialOperation?.("project", request.leaseId)) {
									throw new Error("fake sandbox credential delivery failure");
								}
								return { outcome: options.credentialDeliveryStatus ?? "succeeded" };
							},
							renewCredential: async (request: SandboxCredentialRenewRequest) => {
								if (state.disposedHandles.includes(handle.id)) {
									throw new SandboxHandleDisposedError(handle.id);
								}
								state.credentialState.renews.push({ ...request });
								if (options.failCredentialOperation?.("renew", request.leaseId)) {
									throw new Error("fake sandbox credential renew failure");
								}
								return { outcome: options.credentialDeliveryStatus ?? "succeeded" };
							},
							revokeCredential: async (request: SandboxCredentialRevokeRequest) => {
								if (state.disposedHandles.includes(handle.id)) {
									throw new SandboxHandleDisposedError(handle.id);
								}
								state.credentialState.revokes.push({ ...request });
								if (options.failCredentialOperation?.("revoke", request.leaseId)) {
									throw new Error("fake sandbox credential revoke failure");
								}
								return { outcome: options.credentialRevokeStatus ?? "confirmed" };
							},
					  }
					: {}),
			};
			state.handles.push(handle);
			return handle;
		},
		dispose: async (handle) => {
			state.disposedHandles.push(handle.id);
		},
	};

	return { provider, state };
}
