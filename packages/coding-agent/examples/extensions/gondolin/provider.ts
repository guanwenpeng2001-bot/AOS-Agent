import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
	PolicyError,
	createWorkspaceIdentity,
	type PolicyBinding,
	type PolicyErrorView,
	type SandboxCapabilities,
} from "../../../src/core/policy/execution.ts";
import {
	SandboxCapabilityError,
	SandboxError,
	SandboxHandleDisposedError,
	requireSandboxCapability,
	type SandboxHandle,
	type SandboxOperationRequest,
	type SandboxOperationResult,
	type SandboxProvider,
} from "../../../src/core/policy/sandbox.ts";
import {
	executeFilesystemOperation,
	type GondolinOperationContext,
} from "./filesystem-operations.ts";
import { GondolinAdapterError } from "./path-mapper.ts";
import { executeProcessOperation } from "./process-operations.ts";
import {
	closeGondolinVm,
	type GondolinVmFactory,
	type GondolinVmLike,
} from "./vm-types.ts";

export { GONDOLIN_GUEST_WORKSPACE } from "./vm-types.ts";

export const GONDOLIN_SANDBOX_PROVIDER_ID = "gondolin-local";

const CAPABILITY_KEYS: ReadonlyArray<keyof SandboxCapabilities> = [
	"filesystem",
	"process",
	"network",
	"credentialIsolation",
	"credentialDelivery",
];

export const GONDOLIN_SANDBOX_CAPABILITIES: SandboxCapabilities = Object.freeze({
	filesystem: true,
	process: true,
	network: false,
	credentialIsolation: true,
	// Never declared: gondolin-local has no Task Credential delivery channel,
	// so every credential delivery/renew/revoke fails closed instead of
	// falling back to Host environment, command line, or temporary files.
	credentialDelivery: false,
});

export interface GondolinSandboxProviderOptions {
	readonly workspaceRoot: string;
	/** Optional opaque identity supplied by the trusted host composition. */
	readonly workspaceIdentity?: string;
	readonly sessionLabel?: string;
	readonly vmFactory?: GondolinVmFactory;
}

type GondolinHandleStatus = NonNullable<SandboxHandle["status"]>;

interface GondolinHandleState {
	readonly id: string;
	readonly bindingId: string;
	readonly bindingHash: string;
	readonly workspaceRoot: string;
	readonly vm: GondolinVmLike;
	readonly activeOperations: Set<GondolinActiveOperation>;
	handle: SandboxHandle | undefined;
	status: GondolinHandleStatus;
	closePromise: Promise<void> | undefined;
}

interface GondolinActiveOperation {
	readonly controller: AbortController;
	promise: Promise<SandboxOperationResult>;
	readonly sideEffectStarted: { value: boolean };
}

class GondolinUnknownSideEffectError extends SandboxError {
	readonly category = "side-effect-unknown" as const;
	readonly sideEffects = "unknown" as const;
	readonly sideEffectStatus = "unknown" as const;

	constructor(handleId: string) {
		super("policy_violation", undefined, {
			providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
			handleId,
		});
		this.name = "GondolinUnknownSideEffectError";
	}

	toJSON(): PolicyErrorView & {
		readonly category: "side-effect-unknown";
		readonly sideEffects: "unknown";
		readonly sideEffectStatus: "unknown";
	} {
		return {
			...super.toJSON(),
			category: this.category,
			sideEffects: this.sideEffects,
			sideEffectStatus: this.sideEffectStatus,
		};
	}
}

function abortError(): DOMException {
	return new DOMException("Sandbox operation aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function safePrepareError(error: unknown, signal: AbortSignal | undefined): unknown {
	if (signal?.aborted || isAbortError(error)) return abortError();
	if (error instanceof SandboxError) return error;
	if (error instanceof PolicyError) return new PolicyError(error.code);
	return new SandboxError("sandbox_start_failed", undefined, {
		providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
	});
}

function safeOperationError(error: unknown, signal: AbortSignal | undefined): unknown {
	if (signal?.aborted || isAbortError(error)) return abortError();
	if (error instanceof SandboxError) return error;
	if (error instanceof PolicyError) return new PolicyError(error.code);
	if (error instanceof GondolinAdapterError) {
		return new SandboxError(error.code, undefined, {
			providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
		});
	}
	return new SandboxError("policy_violation", undefined, {
		providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
	});
}

function safeDisposeError(error: unknown): SandboxError | PolicyError {
	if (error instanceof SandboxError) return error;
	if (error instanceof PolicyError) return new PolicyError(error.code);
	return new SandboxError("sandbox_unavailable", undefined, {
		providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
	});
}

function validateBinding(binding: PolicyBinding): void {
	if (
		typeof binding.id !== "string" ||
		binding.id.length === 0 ||
		binding.id.includes("\u0000") ||
		binding.enforcement !== "sandbox" ||
		binding.sandboxProviderId !== GONDOLIN_SANDBOX_PROVIDER_ID
	) {
		throw new SandboxError("sandbox_start_failed", undefined, {
			providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
		});
	}
	if (binding.constraints.process.inheritEnvironment) {
		throw new SandboxCapabilityError(GONDOLIN_SANDBOX_PROVIDER_ID, "credentialIsolation");
	}
	if (binding.sandboxStatus === "unavailable" || binding.sandboxStatus === "not_required") {
		throw new SandboxError("sandbox_unavailable", undefined, {
			providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
		});
	}
	if (binding.sandboxStatus === "failed" || binding.sandboxStatus === "disposed") {
		throw new SandboxError("sandbox_unavailable", undefined, {
			providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
		});
	}
}

function validateCapabilities(binding: PolicyBinding): void {
	for (const capability of CAPABILITY_KEYS) {
		if (binding.sandboxCapabilities[capability] && !GONDOLIN_SANDBOX_CAPABILITIES[capability]) {
			throw new SandboxCapabilityError(GONDOLIN_SANDBOX_PROVIDER_ID, capability);
		}
	}
}

function validateWorkspaceIdentity(
	binding: PolicyBinding,
	workspaceRoot: string,
	configuredIdentity: string | undefined,
): void {
	const derivedIdentity = createWorkspaceIdentity(workspaceRoot);
	if (
		binding.workspaceIdentity !== derivedIdentity ||
		(configuredIdentity !== undefined && configuredIdentity !== derivedIdentity)
	) {
		throw new SandboxError("sandbox_start_failed", undefined, {
			providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
		});
	}
}

async function resolveWorkspaceRoot(workspaceRoot: string): Promise<string> {
	try {
		const resolved = realpathSync(workspaceRoot);
		const information = await stat(resolved);
		if (!information.isDirectory()) throw new Error("Workspace root is not a directory.");
		return resolved;
	} catch {
		throw new SandboxError("sandbox_start_failed", undefined, {
			providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
		});
	}
}

function handleId(sequence: number): string {
	return `${GONDOLIN_SANDBOX_PROVIDER_ID}-handle-${sequence}`;
}

function isGondolinVmLike(value: unknown): value is GondolinVmLike {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		readonly id?: unknown;
		readonly fs?: unknown;
		readonly exec?: unknown;
		readonly close?: unknown;
	};
	return (
		typeof candidate.id === "string" &&
		typeof candidate.fs === "object" &&
		candidate.fs !== null &&
		typeof candidate.exec === "function" &&
		typeof candidate.close === "function"
	);
}

function assertHandleRequest(state: GondolinHandleState, request: SandboxOperationRequest): void {
	if (state.status !== "ready" || state.handle === undefined) {
		throw new SandboxHandleDisposedError(state.id);
	}
	if (request.bindingId !== state.bindingId) {
		throw new SandboxError("sandbox_unavailable", undefined, {
			providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
			handleId: state.id,
		});
	}
}

async function dispatchOperation(
	state: GondolinHandleState,
	request: SandboxOperationRequest,
	onSideEffectStart: () => void,
): Promise<SandboxOperationResult> {
	const context: GondolinOperationContext = {
		vm: state.vm,
		workspaceRoot: state.workspaceRoot,
		onSideEffectStart,
	};
	switch (request.resource) {
		case "filesystem.read":
		case "filesystem.write":
		case "filesystem.find":
		case "filesystem.grep":
			return executeFilesystemOperation(context, request);
		case "process.spawn":
			return executeProcessOperation(context, request);
		case "network.connect":
			requireSandboxCapability(
				GONDOLIN_SANDBOX_PROVIDER_ID,
				GONDOLIN_SANDBOX_CAPABILITIES,
				"network",
			);
			throw new SandboxCapabilityError(GONDOLIN_SANDBOX_PROVIDER_ID, "network");
		case "credential.task.project":
		case "credential.task.renew":
		case "credential.task.revoke":
			requireSandboxCapability(
				GONDOLIN_SANDBOX_PROVIDER_ID,
				GONDOLIN_SANDBOX_CAPABILITIES,
				"credentialDelivery",
			);
			throw new SandboxCapabilityError(GONDOLIN_SANDBOX_PROVIDER_ID, "credentialDelivery");
		default:
			throw new SandboxError("policy_violation", undefined, {
				providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
				handleId: state.id,
			});
	}
}

async function executeHandleOperation(
	state: GondolinHandleState,
	request: SandboxOperationRequest,
): Promise<SandboxOperationResult> {
	assertHandleRequest(state, request);
	if (request.signal?.aborted) throw abortError();
	const controller = new AbortController();
	const sideEffectStarted = { value: false };
	const activeOperation = {
		controller,
		promise: Promise.resolve({}) as Promise<SandboxOperationResult>,
		sideEffectStarted,
	};
	const abortListener = (): void => controller.abort();
	request.signal?.addEventListener("abort", abortListener, { once: true });
	const forwardedRequest: SandboxOperationRequest = { ...request, signal: controller.signal };
	const operation = (async () => dispatchOperation(state, forwardedRequest, () => {
		sideEffectStarted.value = true;
	}))();
	activeOperation.promise = operation;
	state.activeOperations.add(activeOperation);
	try {
		return await operation;
	} catch (error) {
		const unknownSideEffect = sideEffectStarted.value;
		const safeError = unknownSideEffect
			? new GondolinUnknownSideEffectError(state.id)
			: safeOperationError(error, request.signal);
		if (
			safeError instanceof SandboxError &&
			(safeError.code === "sandbox_unavailable" || safeError instanceof GondolinUnknownSideEffectError)
		) {
			state.status = "failed";
		}
		throw safeError;
	} finally {
		request.signal?.removeEventListener("abort", abortListener);
		state.activeOperations.delete(activeOperation);
	}
}

function createHandle(
	state: Omit<GondolinHandleState, "handle">,
): { readonly state: GondolinHandleState; readonly handle: SandboxHandle } {
	const mutableState: GondolinHandleState = {
		...state,
		handle: undefined,
	};
	const handle: SandboxHandle = {
		get id() {
			return mutableState.id;
		},
		get capabilities() {
			return GONDOLIN_SANDBOX_CAPABILITIES;
		},
		get bindingId() {
			return mutableState.bindingId;
		},
		get providerId() {
			return GONDOLIN_SANDBOX_PROVIDER_ID;
		},
		get status() {
			return mutableState.status;
		},
		execute: (request) => executeHandleOperation(mutableState, request),
	};
	mutableState.handle = handle;
	return { state: mutableState, handle };
}

async function closeHandle(state: GondolinHandleState): Promise<void> {
	if (state.closePromise !== undefined) return state.closePromise;
	state.status = "closing";
	const closing = (async () => {
		for (const activeOperation of state.activeOperations) activeOperation.controller.abort();
		await Promise.allSettled([...state.activeOperations].map((activeOperation) => activeOperation.promise));
		try {
			await closeGondolinVm(state.vm);
		} catch (error) {
			throw safeDisposeError(error);
		} finally {
			state.status = "closed";
		}
	})();
	state.closePromise = closing;
	return closing;
}

/**
 * Create an explicitly registered Gondolin SandboxProvider. The provider does
 * not register itself with an AgentSession and never falls back to host I/O.
 */
export function createGondolinSandboxProvider(options: GondolinSandboxProviderOptions): SandboxProvider {
	const configuredWorkspaceRoot = path.resolve(options.workspaceRoot);
	const vmFactory = options.vmFactory;
	const preparedHandles = new Map<string, GondolinHandleState>();
	const preparingHandles = new Map<string, { bindingHash: string; promise: Promise<SandboxHandle> }>();
	const handleStates = new WeakMap<SandboxHandle, GondolinHandleState>();
	let nextHandleSequence = 0;

	const provider: SandboxProvider = {
		id: GONDOLIN_SANDBOX_PROVIDER_ID,
		capabilities: GONDOLIN_SANDBOX_CAPABILITIES,
		prepare(binding, signal) {
			const existing = preparedHandles.get(binding.id);
			if (existing !== undefined) {
				if (existing.status !== "ready" || existing.handle === undefined) {
					return Promise.reject(
						new SandboxError("sandbox_unavailable", undefined, {
							providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
							handleId: existing.id,
						}),
					);
				}
				if (existing.bindingHash !== binding.bindingHash) {
					return Promise.reject(
						new SandboxError("sandbox_start_failed", undefined, {
							providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
						}),
					);
				}
				return Promise.resolve(existing.handle as SandboxHandle);
			}
			const pending = preparingHandles.get(binding.id);
			if (pending !== undefined) {
				if (pending.bindingHash !== binding.bindingHash) {
					return Promise.reject(
						new SandboxError("sandbox_start_failed", undefined, {
							providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
						}),
					);
				}
				return pending.promise;
			}
			const promise = (async () => {
				let vm: GondolinVmLike | undefined;
				let handleStored = false;
				try {
					if (signal?.aborted) throw abortError();
					validateBinding(binding);
					validateCapabilities(binding);
					const workspaceRoot = await resolveWorkspaceRoot(configuredWorkspaceRoot);
					validateWorkspaceIdentity(binding, workspaceRoot, options.workspaceIdentity);
					if (signal?.aborted) throw abortError();
					if (vmFactory === undefined) {
						throw new SandboxError("sandbox_start_failed", undefined, {
							providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
						});
					}
					vm = await vmFactory({
						workspaceRoot,
						sessionLabel: options.sessionLabel,
						signal,
					});
					if (!isGondolinVmLike(vm)) throw new Error("Invalid VM factory result.");
					if (signal?.aborted) {
						await closeGondolinVm(vm).catch(() => undefined);
						throw abortError();
					}
					const { state, handle } = createHandle({
						id: handleId(++nextHandleSequence),
						bindingId: binding.id,
						bindingHash: binding.bindingHash,
						workspaceRoot,
						vm,
						activeOperations: new Set(),
						status: "ready",
						closePromise: undefined,
					});
					handleStates.set(handle, state);
					preparedHandles.set(binding.id, state);
					handleStored = true;
					return handle;
				} catch (error) {
					if (vm !== undefined && !handleStored && isGondolinVmLike(vm)) {
						await closeGondolinVm(vm).catch(() => undefined);
					}
					throw safePrepareError(error, signal);
				}
			})();
			preparingHandles.set(binding.id, { bindingHash: binding.bindingHash, promise });
			void promise
				.finally(() => {
					const current = preparingHandles.get(binding.id);
					if (current?.promise === promise) preparingHandles.delete(binding.id);
				})
				.catch(() => undefined);
			return promise;
		},
		async dispose(handle) {
			const state = handleStates.get(handle);
			if (state === undefined) {
				throw new SandboxError("sandbox_unavailable", undefined, {
					providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
				});
			}
			try {
				await closeHandle(state);
			} finally {
				if (preparedHandles.get(state.bindingId) === state) preparedHandles.delete(state.bindingId);
			}
		},
	};

	return provider;
}
