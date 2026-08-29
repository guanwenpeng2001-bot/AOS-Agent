import { randomUUID } from "node:crypto";
import {
	canonicalFoundationJson,
	FoundationError,
	Result,
	validateFoundationProviderCapability,
	validateSandboxOperationRequest,
	validateWorkerReceiptForProvider,
	type ArtifactRef,
	type ExecutionCorrelation,
	type FoundationError as FoundationErrorValue,
	type FoundationJsonValue,
	type FoundationProviderCapability,
	type Result as ResultValue,
	type WorkerReceipt,
} from "@aos-agent/agent-core";
import {
	PolicyError,
	authorizePolicyOperation,
	type ExecutionPolicyProfile,
	type PolicyBinding,
	type PolicyDecision,
	type PolicyOperationSource,
	type PolicyResource,
	type WorkspaceScope,
} from "./execution-policy.ts";
import {
	type FilesystemAccessKind,
	type HostFilesystemRoots,
	resolveHostPathForPolicy,
} from "./policy-filesystem.ts";
import {
	assertProcessEnvironmentAllowed,
	assertProcessTimeoutAllowed,
	createExplicitProcessEnvironment,
} from "./policy-process.ts";
import {
	resolveWorkerSandboxOperation,
	type SandboxHandle,
	type SandboxOperationRequest,
	type SandboxOperationResult,
} from "./sandbox.ts";
import type { SafeLeaseProjection, SafeLeaseReference } from "./worker-protocol.ts";
import type { WorkerRuntimeSandboxOperationProvider } from "./worker-runtime.ts";

export interface SandboxHandleOperationProviderOptions {
	readonly providerId: string;
	/** Trusted child-side Policy Binding and its already-prepared sandbox handle. */
	readonly policy: BuiltinToolPolicy;
	readonly correlation: Pick<ExecutionCorrelation, "sessionId" | "laneId">;
	readonly capabilities: readonly FoundationProviderCapability[];
	/** Bounded trusted mapping; raw handle output never enters the Worker receipt. */
	readonly mapResult: (
		result: SandboxOperationResult,
		operation: SandboxOperationRequest,
	) => readonly ArtifactRef[] | Promise<readonly ArtifactRef[]>;
	readonly credentialTarget?: {
		readonly project?: (lease: SafeLeaseProjection) => Promise<ResultValue<void, FoundationErrorValue>>;
		readonly renew?: (lease: SafeLeaseProjection) => Promise<ResultValue<void, FoundationErrorValue>>;
		readonly revoke?: (lease: SafeLeaseReference) => Promise<ResultValue<void, FoundationErrorValue>>;
	};
	readonly now?: () => string;
	readonly receiptId?: (operationId: string) => string;
}

function requiredWorkerCapability(operation: SandboxOperationRequest): string {
	if (operation.resource === "filesystem.write") return "filesystem.write";
	if (operation.resource === "filesystem.find") return "filesystem.find";
	if (operation.resource === "filesystem.grep") return "filesystem.grep";
	if (operation.resource === "process.spawn") return "process.spawn";
	return "filesystem.read";
}

function freezeSandboxJson(value: FoundationJsonValue): FoundationJsonValue {
	if (Array.isArray(value)) {
		const items = value.map((item) => freezeSandboxJson(item));
		Object.freeze(items);
		return items;
	}
	if (value !== null && typeof value === "object") {
		return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeSandboxJson(item)])));
	}
	return value;
}

function snapshotSandboxJson<T>(value: T): T {
	return freezeSandboxJson(JSON.parse(canonicalFoundationJson(value as FoundationJsonValue)) as FoundationJsonValue) as T;
}

/**
 * Child-side provider that authorizes each request against a prepared Sandbox
 * handle. It never executes on the Host when the handle is absent or invalid.
 */
export function createSandboxHandleOperationProvider(
	options: SandboxHandleOperationProviderOptions,
): WorkerRuntimeSandboxOperationProvider {
	const active = new Map<string, AbortController>();
	const reserved = new Map<string, AbortController>();
	const completed = new Set<string>();
	let disposed = false;
	const providerId = options.providerId;
	const now = options.now ?? (() => new Date().toISOString());
	const receiptId = options.receiptId;
	const mapResult = options.mapResult;
	const policy = options.policy;
	const authorizeFilesystem = policy.authorizeFilesystem.bind(policy);
	const authorizeProcess = policy.authorizeProcess.bind(policy);
	const correlationIdentity = Object.freeze({ ...options.correlation });
	const policyIdentity = Object.freeze({
		bindingId: policy.binding.id,
		bindingEnforcement: policy.binding.enforcement,
		bindingSandboxProviderId: policy.binding.sandboxProviderId,
		bindingSandboxStatus: policy.binding.sandboxStatus,
		bindingRunId: policy.binding.runId,
		profileEnforcement: policy.profile.enforcement,
		profileSandboxProviderId: policy.profile.sandboxProvider,
	});
	const handle = policy.sandbox;
	const capabilities = Object.freeze(options.capabilities.map((capability) => Object.freeze({ ...capability })));
	const capabilityIds = new Set(capabilities.map((capability) => capability.id));
	const capabilityConfigurationValid = capabilities.every((capability) => validateFoundationProviderCapability(capability).ok) &&
		capabilityIds.size === capabilities.length;
	const projectCredential = options.credentialTarget?.project;
	const renewCredential = options.credentialTarget?.renew;
	const revokeCredential = options.credentialTarget?.revoke;
	const awaitAuthorization = async <T>(authorization: Promise<T>, signal: AbortSignal): Promise<T> => {
		let rejectCancellation: (reason: DOMException) => void = () => undefined;
		const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
		const abortAuthorization = (): void => {
			rejectCancellation(new DOMException("Operation Worker authorization cancelled", "AbortError"));
		};
		if (signal.aborted) abortAuthorization();
		else signal.addEventListener("abort", abortAuthorization, { once: true });
		try {
			return await Promise.race([authorization, cancellation]);
		} finally {
			signal.removeEventListener("abort", abortAuthorization);
		}
	};
	return {
		schemaVersion: 1,
		providerId,
		providerClass: "operation_worker",
		async capabilities() {
			return Object.freeze(capabilities.map((capability) => Object.freeze({ ...capability })));
		},
		async start(requestValue, executionOptions = {}) {
			if (disposed) return Result.err(new FoundationError("worker_unavailable", "Operation Worker provider is disposed"));
			const validatedRequest = validateSandboxOperationRequest(requestValue);
			if (!validatedRequest.ok) return validatedRequest;
			let request: typeof validatedRequest;
			try {
				request = Object.freeze({
					...validatedRequest,
					value: snapshotSandboxJson(validatedRequest.value),
				});
			} catch {
				return Result.err(new FoundationError("worker_operation_invalid", "Operation Worker request is not canonical"));
			}
			const signal = executionOptions.signal;
			let suppliedCorrelation: ExecutionCorrelation | undefined;
			try {
				suppliedCorrelation = executionOptions.correlation === undefined
					? undefined
					: snapshotSandboxJson(executionOptions.correlation);
			} catch {
				return Result.err(new FoundationError("invalid_correlation", "Operation Worker correlation is invalid"));
			}
			if (
				handle === undefined ||
				request.value.providerId !== undefined && request.value.providerId !== providerId ||
				request.value.bindingId === undefined ||
				policyIdentity.bindingId !== request.value.bindingId ||
				policyIdentity.bindingEnforcement !== "sandbox" ||
				policyIdentity.bindingSandboxProviderId !== providerId ||
				policyIdentity.bindingSandboxStatus !== "ready" ||
				policyIdentity.profileEnforcement !== "sandbox" ||
				policyIdentity.profileSandboxProviderId !== providerId ||
				handle.bindingId !== undefined && handle.bindingId !== request.value.bindingId ||
				handle.providerId !== undefined && handle.providerId !== providerId ||
				handle.status !== undefined && handle.status !== "ready"
			) {
				return Result.err(new FoundationError("worker_binding_invalid", "Operation Worker sandbox binding is invalid"));
			}
			if (reserved.has(request.value.operationId) || active.has(request.value.operationId) || completed.has(request.value.operationId)) {
				return Result.err(new FoundationError("worker_conflict", "Operation Worker operation identity is already used"));
			}
			const controller = new AbortController();
			const abort = (): void => controller.abort(signal?.reason);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			reserved.set(request.value.operationId, controller);
			try {
			const operation = resolveWorkerSandboxOperation(
				request.value.bindingId,
				request.value.payload,
			);
			if (operation === undefined) {
				return Result.err(new FoundationError("worker_operation_invalid", "Operation Worker payload is invalid"));
			}
			if (
				suppliedCorrelation !== undefined && (
					suppliedCorrelation.sessionId !== correlationIdentity.sessionId ||
					suppliedCorrelation.laneId !== correlationIdentity.laneId ||
					suppliedCorrelation.operationId !== request.value.operationId ||
					suppliedCorrelation.providerId !== undefined && suppliedCorrelation.providerId !== providerId ||
					suppliedCorrelation.bindingId !== undefined && suppliedCorrelation.bindingId !== request.value.bindingId ||
					suppliedCorrelation.bindingEpochId !== request.value.bindingEpochId ||
					suppliedCorrelation.runId !== undefined && suppliedCorrelation.runId !== policyIdentity.bindingRunId ||
					suppliedCorrelation.agentInstanceId !== undefined && suppliedCorrelation.agentInstanceId !== request.value.agentInstanceId ||
					suppliedCorrelation.toolCallId !== undefined && suppliedCorrelation.toolCallId !== request.value.toolCallId ||
					suppliedCorrelation.taskId !== undefined && suppliedCorrelation.taskId !== request.value.taskId ||
					suppliedCorrelation.dispatchId !== undefined && suppliedCorrelation.dispatchId !== request.value.dispatchId ||
					suppliedCorrelation.attemptId !== undefined && suppliedCorrelation.attemptId !== request.value.attemptId
				)
			) {
				return Result.err(new FoundationError("invalid_correlation", "Operation Worker correlation is incomplete"));
			}
			const correlation: ExecutionCorrelation = {
				sessionId: correlationIdentity.sessionId,
				laneId: correlationIdentity.laneId,
				...(policyIdentity.bindingRunId === undefined ? {} : { runId: policyIdentity.bindingRunId }),
				bindingId: request.value.bindingId,
				operationId: request.value.operationId,
				providerId,
				...(request.value.bindingEpochId === undefined ? {} : { bindingEpochId: request.value.bindingEpochId }),
				...(request.value.toolCallId === undefined ? {} : { toolCallId: request.value.toolCallId }),
				...(request.value.taskId === undefined ? {} : { taskId: request.value.taskId }),
				...(request.value.dispatchId === undefined ? {} : { dispatchId: request.value.dispatchId }),
				...(request.value.attemptId === undefined ? {} : { attemptId: request.value.attemptId }),
				revision: suppliedCorrelation?.revision ?? 0,
			};
			if (!capabilityConfigurationValid || !capabilityIds.has(requiredWorkerCapability(operation))) {
				return Result.err(new FoundationError("sandbox_capability_insufficient", "Operation Worker declared capability is insufficient"));
			}
			const usesProcess = operation.resource === "process.spawn" ||
				(operation.resource === "filesystem.find" || operation.resource === "filesystem.grep") && operation.command !== undefined;
			if (usesProcess && !capabilityIds.has("process.spawn")) {
				return Result.err(new FoundationError("sandbox_capability_insufficient", "Operation Worker process capability is insufficient"));
			}
			if (
				operation.resource !== "process.spawn" && !handle.capabilities.filesystem ||
				usesProcess && (!handle.capabilities.process || !handle.capabilities.credentialIsolation)
			) {
				return Result.err(new FoundationError("sandbox_capability_insufficient", "Operation Worker sandbox capability is unavailable"));
			}
			let authorizedOperation: SandboxOperationRequest;
			try {
				if (operation.resource === "process.spawn") {
					const processAuthorization = await awaitAuthorization(authorizeProcess({
						command: operation.command!,
						args: operation.args,
						cwd: operation.cwd!,
						env: {},
						timeout: operation.timeoutMs,
						requestId: request.value.operationId,
					}), controller.signal);
					if (disposed || controller.signal.aborted) throw new DOMException("Operation Worker authorization cancelled", "AbortError");
					if (processAuthorization.sandbox !== handle) throw new Error("Sandbox authorization returned another handle");
					authorizedOperation = {
						...operation,
						cwd: processAuthorization.cwd ?? operation.cwd!,
						env: processAuthorization.env,
					};
				} else {
					const filesystemAuthorization = await awaitAuthorization(authorizeFilesystem({
						resource: operation.resource as "filesystem.read" | "filesystem.write" | "filesystem.find" | "filesystem.grep",
						requestedPath: operation.path!,
						access: operation.resource === "filesystem.write" ? "write" : "read",
						requestId: request.value.operationId,
					}), controller.signal);
					if (disposed || controller.signal.aborted) throw new DOMException("Operation Worker authorization cancelled", "AbortError");
					if (filesystemAuthorization.sandbox !== handle) throw new Error("Sandbox authorization returned another handle");
					if ((operation.resource === "filesystem.find" || operation.resource === "filesystem.grep") && operation.command !== undefined) {
						const processAuthorization = await awaitAuthorization(authorizeProcess({
							command: operation.command!,
							args: operation.args,
							cwd: operation.cwd!,
							env: {},
							timeout: operation.timeoutMs,
							requestId: request.value.operationId,
						}), controller.signal);
						if (disposed || controller.signal.aborted) throw new DOMException("Operation Worker authorization cancelled", "AbortError");
						if (processAuthorization.sandbox !== handle) throw new Error("Sandbox authorization returned another handle");
						authorizedOperation = {
							...operation,
							path: filesystemAuthorization.realPath,
							cwd: processAuthorization.cwd ?? operation.cwd!,
							env: processAuthorization.env,
						};
					} else {
						authorizedOperation = { ...operation, path: filesystemAuthorization.realPath };
					}
				}
			} catch {
				if (disposed || controller.signal.aborted) {
					return Result.err(new FoundationError("worker_cancel_failed", "Operation Worker operation was cancelled during authorization"));
				}
				return Result.err(new FoundationError("worker_operation_invalid", "Operation Worker policy denied the operation"));
			}
			if (disposed || controller.signal.aborted) {
				return Result.err(new FoundationError("worker_cancel_failed", "Operation Worker operation was cancelled before execution"));
			}
			reserved.delete(request.value.operationId);
			active.set(request.value.operationId, controller);
			try {
				let startedAt: string;
				try {
					startedAt = now();
				} catch {
					return Result.err(new FoundationError("worker_operation_invalid", "Operation Worker clock callback failed"));
				}
				let receipt: WorkerReceipt;
				try {
					if (disposed || controller.signal.aborted) {
						return Result.err(new FoundationError("worker_cancel_failed", "Operation Worker operation was cancelled before execution"));
					}
					const result = await handle.execute({ ...authorizedOperation, signal: controller.signal });
					if (disposed) controller.abort(new DOMException("Operation Worker provider disposed", "AbortError"));
					if (controller.signal.aborted) throw new DOMException("Operation Worker execution cancelled", "AbortError");
					const artifacts = await mapResult(result, authorizedOperation);
					if (disposed) controller.abort(new DOMException("Operation Worker provider disposed", "AbortError"));
					if (controller.signal.aborted) throw new DOMException("Operation Worker result mapping cancelled", "AbortError");
					const completedAt = now();
					const workerReceiptId = receiptId?.(request.value.operationId) ?? `worker-receipt:${randomUUID()}`;
					const cancelledWithoutProof = controller.signal.aborted;
					receipt = {
					schemaVersion: 1,
					workerReceiptId,
					sandboxProviderId: providerId,
					operationId: request.value.operationId,
					...(request.value.taskId === undefined ? {} : { taskId: request.value.taskId }),
					...(request.value.dispatchId === undefined ? {} : { dispatchId: request.value.dispatchId }),
					...(request.value.attemptId === undefined ? {} : { attemptId: request.value.attemptId }),
					status: cancelledWithoutProof ? "failed" : "succeeded",
					sideEffectState: cancelledWithoutProof ? "side_effect_unknown" : "none",
					...(artifacts.length === 0 ? {} : { artifacts }),
					...(cancelledWithoutProof
						? { error: { code: "worker_cancel_failed", message: "Cancellation did not prove side effects closed", retryable: false } }
						: {}),
					provenance: {
						producerKind: "operation_worker",
						providerId,
						producedAt: completedAt,
						correlation,
					},
					startedAt,
					completedAt,
					};
				} catch {
					let completedAt: string;
					let workerReceiptId: string;
					try {
						completedAt = now();
						workerReceiptId = receiptId?.(request.value.operationId) ?? `worker-receipt:${randomUUID()}`;
					} catch {
						return Result.err(new FoundationError("worker_operation_invalid", "Operation Worker receipt callback failed"));
					}
					receipt = {
					schemaVersion: 1,
					workerReceiptId,
					sandboxProviderId: providerId,
					operationId: request.value.operationId,
					...(request.value.taskId === undefined ? {} : { taskId: request.value.taskId }),
					...(request.value.dispatchId === undefined ? {} : { dispatchId: request.value.dispatchId }),
						...(request.value.attemptId === undefined ? {} : { attemptId: request.value.attemptId }),
						status: "failed",
						sideEffectState: "side_effect_unknown",
						error: controller.signal.aborted
							? { code: "worker_cancel_failed", message: "Operation failed while cancellation was requested", retryable: false }
							: { code: "worker_operation_invalid", message: "Operation failed", retryable: false },
					provenance: {
						producerKind: "operation_worker",
						providerId,
						producedAt: completedAt,
						correlation,
					},
					startedAt,
					completedAt,
					};
				}
				return validateWorkerReceiptForProvider(receipt, {
					providerId,
					providerClass: "operation_worker",
				});
			} finally {
				active.delete(request.value.operationId);
			}
			} finally {
				signal?.removeEventListener("abort", abort);
				reserved.delete(request.value.operationId);
				active.delete(request.value.operationId);
				completed.add(request.value.operationId);
			}
		},
		async cancel(operationId) {
			if (completed.has(operationId)) return Result.ok(undefined);
			const controller = active.get(operationId) ?? reserved.get(operationId);
			if (controller === undefined) return Result.err(new FoundationError("worker_not_found", "Operation Worker operation was not found"));
			controller.abort(new DOMException("Operation Worker cancellation requested", "AbortError"));
			return Result.ok(undefined);
		},
		async dispose() {
			disposed = true;
			for (const controller of reserved.values()) {
				controller.abort(new DOMException("Operation Worker provider disposed", "AbortError"));
			}
			for (const controller of active.values()) {
				controller.abort(new DOMException("Operation Worker provider disposed", "AbortError"));
			}
			reserved.clear();
			active.clear();
		},
		...(projectCredential === undefined
			? {}
			: { projectCredential: (lease: SafeLeaseProjection) => projectCredential(lease) }),
		...(renewCredential === undefined
			? {}
			: { renewCredential: (lease: SafeLeaseProjection) => renewCredential(lease) }),
		...(revokeCredential === undefined
			? {}
			: { revokeCredential: (lease: SafeLeaseReference) => revokeCredential(lease) }),
	};
}

export interface BuiltinToolPolicyHooks {
	onDecision?: (decision: PolicyDecision) => void;
}

export interface BuiltinToolPolicy {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly roots: HostFilesystemRoots;
	readonly source?: PolicyOperationSource;
	readonly sandbox?: SandboxHandle;
	authorizeFilesystem(input: {
		readonly resource: "filesystem.read" | "filesystem.write" | "filesystem.find" | "filesystem.grep";
		readonly requestedPath: string;
		readonly access: FilesystemAccessKind;
		readonly requestId?: string;
	}): Promise<{ readonly absolutePath: string; readonly realPath: string; readonly sandbox?: SandboxHandle }>;
	authorizeProcess(input: {
		readonly command: string;
		readonly args?: ReadonlyArray<string>;
		readonly cwd: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly timeout?: number;
		readonly requestId?: string;
	}): Promise<{ readonly cwd?: string; readonly env: NodeJS.ProcessEnv; readonly sandbox?: SandboxHandle }>;
	authorizeRaw(input: {
		readonly resource: PolicyResource;
		readonly scope?: WorkspaceScope;
		readonly requestId?: string;
		readonly path?: string;
		readonly targetPath?: string;
		readonly command?: string;
		readonly args?: ReadonlyArray<string>;
		readonly cwd?: string;
		readonly environmentNames?: ReadonlyArray<string>;
	}): PolicyDecision;
}

export interface BuiltinToolPolicyOptions {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly roots: HostFilesystemRoots;
	readonly source?: PolicyOperationSource;
	readonly sandbox?: SandboxHandle;
	readonly approvedRequestIds?: ReadonlyArray<string>;
	readonly rejectedRequestIds?: ReadonlyArray<string>;
	readonly hooks?: BuiltinToolPolicyHooks;
}

function assertAllowedDecision(
	decision: PolicyDecision,
	approvedRequestIds: ReadonlySet<string>,
	rejectedRequestIds: ReadonlySet<string>,
): void {
	if (decision.outcome === "allow") return;
	if (decision.outcome === "ask" && decision.requestId !== undefined) {
		if (rejectedRequestIds.has(decision.requestId)) {
			throw new PolicyError("policy_denied", "The operation was rejected by execution policy approval.");
		}
		if (approvedRequestIds.has(decision.requestId)) {
			return;
		}
	}
	throw new PolicyError(decision.reasonCode ?? "policy_denied", decision.reason);
}

function assertSandboxForStrictProcess(policy: {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly sandbox?: SandboxHandle;
}): SandboxHandle | undefined {
	if (policy.profile.enforcement !== "sandbox") return undefined;
	const sandbox = policy.sandbox;
	if (sandbox === undefined || sandbox.id.length === 0) throw new PolicyError("sandbox_required");
	if (sandbox.bindingId !== undefined && sandbox.bindingId !== policy.binding.id) throw new PolicyError("sandbox_unavailable");
	if (sandbox.providerId !== undefined && sandbox.providerId !== policy.binding.sandboxProviderId) throw new PolicyError("sandbox_unavailable");
	if (sandbox.status !== undefined && sandbox.status !== "ready") throw new PolicyError("sandbox_unavailable");
	if (!sandbox.capabilities.process || !sandbox.capabilities.credentialIsolation) {
		throw new PolicyError("sandbox_capability_insufficient");
	}
	if (policy.binding.sandboxStatus !== "ready") throw new PolicyError("sandbox_unavailable");
	return sandbox;
}

function assertSandboxForStrictFilesystem(policy: {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly sandbox?: SandboxHandle;
}): SandboxHandle | undefined {
	if (policy.profile.enforcement !== "sandbox") return undefined;
	const sandbox = policy.sandbox;
	if (sandbox === undefined || sandbox.id.length === 0) throw new PolicyError("sandbox_required");
	if (sandbox.bindingId !== undefined && sandbox.bindingId !== policy.binding.id) throw new PolicyError("sandbox_unavailable");
	if (sandbox.providerId !== undefined && sandbox.providerId !== policy.binding.sandboxProviderId) throw new PolicyError("sandbox_unavailable");
	if (sandbox.status !== undefined && sandbox.status !== "ready") throw new PolicyError("sandbox_unavailable");
	if (!sandbox.capabilities.filesystem) {
		throw new PolicyError("sandbox_capability_insufficient");
	}
	if (policy.binding.sandboxStatus !== "ready") throw new PolicyError("sandbox_unavailable");
	return sandbox;
}

export function createBuiltinToolPolicy(options: BuiltinToolPolicyOptions): BuiltinToolPolicy {
	const source = options.source ?? "builtin";
	const approvedRequestIds = new Set(options.approvedRequestIds ?? []);
	const rejectedRequestIds = new Set(options.rejectedRequestIds ?? []);
	const authorizeRaw = (input: {
		readonly resource: PolicyResource;
		readonly scope?: WorkspaceScope;
		readonly requestId?: string;
		readonly path?: string;
		readonly targetPath?: string;
		readonly command?: string;
		readonly args?: ReadonlyArray<string>;
		readonly cwd?: string;
		readonly environmentNames?: ReadonlyArray<string>;
	}) => {
		const decision = authorizePolicyOperation({
			profile: options.profile,
			binding: options.binding,
			operation: {
				resource: input.resource,
				source,
				...(input.scope === undefined ? {} : { scope: input.scope }),
				...(input.requestId === undefined ? {} : { id: input.requestId }),
				...(input.path === undefined ? {} : { path: input.path }),
				...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
				...(input.command === undefined ? {} : { command: input.command }),
				...(input.args === undefined ? {} : { args: input.args }),
				...(input.cwd === undefined ? {} : { cwd: input.cwd }),
				...(input.environmentNames === undefined ? {} : { environmentNames: input.environmentNames }),
			},
		});
		options.hooks?.onDecision?.(decision);
		assertAllowedDecision(decision, approvedRequestIds, rejectedRequestIds);
		return decision;
	};
	return {
		profile: options.profile,
		binding: options.binding,
		roots: options.roots,
		source,
		...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
		authorizeRaw,
		async authorizeFilesystem(input) {
			const resolved = await resolveHostPathForPolicy({
				cwd: options.roots.workspace,
				targetPath: input.requestedPath,
				roots: options.roots,
				access: input.access,
			});
			const sandbox = assertSandboxForStrictFilesystem(options);
			const decision = authorizePolicyOperation({
				profile: options.profile,
				binding: options.binding,
				operation: {
					resource: input.resource,
					source,
					scope: resolved.scope,
					...(input.requestId === undefined ? {} : { id: input.requestId }),
					path: resolved.realPath,
				},
			});
			options.hooks?.onDecision?.(decision);
			assertAllowedDecision(decision, approvedRequestIds, rejectedRequestIds);
			return { absolutePath: resolved.absolutePath, realPath: resolved.realPath, ...(sandbox === undefined ? {} : { sandbox }) };
		},
		async authorizeProcess(input) {
			const cwdResolution = await resolveHostPathForPolicy({
				cwd: options.roots.workspace,
				targetPath: input.cwd,
				roots: options.roots,
				access: "read",
			});
			const environment = createExplicitProcessEnvironment(options.profile, input.env);
			assertProcessEnvironmentAllowed(options.profile, environment.names);
			assertProcessTimeoutAllowed(options.profile, input.timeout);
			const sandbox = assertSandboxForStrictProcess(options);
			const decision = authorizePolicyOperation({
				profile: options.profile,
				binding: options.binding,
				operation: {
					resource: "process.spawn",
					source: source === "builtin" ? "user_bash" : source,
					...(input.requestId === undefined ? {} : { id: input.requestId }),
					scope: cwdResolution.scope,
					command: input.command,
					...(input.args === undefined ? {} : { args: input.args }),
					cwd: cwdResolution.realPath,
					environmentNames: environment.names,
				},
			});
			options.hooks?.onDecision?.(decision);
			assertAllowedDecision(decision, approvedRequestIds, rejectedRequestIds);
			return { cwd: cwdResolution.realPath, env: environment.env, ...(sandbox === undefined ? {} : { sandbox }) };
		},
	};
}
