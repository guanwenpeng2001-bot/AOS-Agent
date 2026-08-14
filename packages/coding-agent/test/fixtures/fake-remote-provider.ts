import {
	REMOTE_OPERATION_SCHEMA_VERSION,
	type RemoteArtifactReference,
	type RemoteOperationErrorCategory,
	RemoteOperationError,
	type RemoteOperationExecutionContext,
	type RemoteOperationHeartbeat,
	type RemoteOperationInvoker,
	type RemoteOperationLease,
	type RemoteOperationProvider,
	type RemoteOperationRequest,
	type RemoteOperationResult,
	type RemoteOperationTransport,
} from "../../src/core/remote-operation.ts";

export const FAKE_REMOTE_PROVIDER_ID = "fake-remote-provider";

export interface FakeRemoteInvocation {
	readonly operationId: string;
	readonly runId?: string;
	readonly sessionId?: string;
	readonly artifactRefs: ReadonlyArray<RemoteArtifactReference>;
}

export interface FakeRemoteSideEffect {
	readonly operationId: string;
	readonly artifactRefs: ReadonlyArray<RemoteArtifactReference>;
}

export interface FakeRemoteProviderState {
	readonly invocations: FakeRemoteInvocation[];
	readonly cancellations: string[];
	readonly heartbeats: RemoteOperationHeartbeat[];
	readonly leases: RemoteOperationLease[];
	readonly sideEffects: FakeRemoteSideEffect[];
}

export interface FakeRemoteProviderOptions {
	readonly id?: string;
	readonly now?: () => string;
	readonly outputArtifacts?: ReadonlyArray<RemoteArtifactReference>;
	readonly failureCategory?: RemoteOperationErrorCategory;
	readonly failureSideEffects?: "none" | "associated" | "unknown";
	readonly delayMs?: number;
	/** Hold after dispatch until release(operationId) is called. */
	readonly hold?: boolean;
	/** Record an associated side effect before the optional hold. */
	readonly sideEffectBeforeHold?: boolean;
}

interface PendingExecution {
	readonly resolve: () => void;
}

const DEFAULT_OUTPUT_ARTIFACT: RemoteArtifactReference = {
	id: "fake-output-1",
	kind: "output",
	digest: "sha256:fake-output-1",
	sizeBytes: 1,
	mediaType: "application/octet-stream",
};

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cloneArtifacts(artifacts: ReadonlyArray<RemoteArtifactReference>): RemoteArtifactReference[] {
	return artifacts.map((artifact) => ({ ...artifact }));
}

/** In-process transport with no sockets, framing, credentials, or persistence. */
export class FakeRemoteTransport implements RemoteOperationTransport {
	readonly state: FakeRemoteProviderState = {
		invocations: [],
		cancellations: [],
		heartbeats: [],
		leases: [],
		sideEffects: [],
	};
	readonly #options: FakeRemoteProviderOptions;
	readonly #pending = new Map<string, PendingExecution>();

	constructor(options: FakeRemoteProviderOptions = {}) {
		this.#options = options;
	}

	async execute(request: RemoteOperationRequest, context: RemoteOperationExecutionContext): Promise<RemoteOperationResult> {
		const outputArtifacts = cloneArtifacts(this.#options.outputArtifacts ?? [DEFAULT_OUTPUT_ARTIFACT]);
		this.state.invocations.push({
			operationId: request.operationId,
			...(request.runId === undefined ? {} : { runId: request.runId }),
			...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
			artifactRefs: cloneArtifacts(request.artifactRefs ?? []),
		});

		if (this.#options.delayMs !== undefined && this.#options.delayMs > 0) await delay(this.#options.delayMs);
		if (this.#options.sideEffectBeforeHold === true) this.#recordSideEffect(request, context, outputArtifacts);
		if (this.#options.hold === true) {
			await new Promise<void>((resolve) => this.#pending.set(request.operationId, { resolve }));
		}
		if (context.signal.aborted) {
			throw new RemoteOperationError("cancelled", { sideEffects: this.#options.sideEffectBeforeHold === true ? "associated" : "none" });
		}
		if (this.#options.failureCategory !== undefined) {
			throw new RemoteOperationError(this.#options.failureCategory, {
				sideEffects: this.#options.failureSideEffects ?? "none",
			});
		}
		if (this.#options.sideEffectBeforeHold !== true) this.#recordSideEffect(request, context, outputArtifacts);
		return { artifactRefs: outputArtifacts, sideEffects: outputArtifacts.length === 0 ? "none" : "associated" };
	}

	async cancel(operationId: string): Promise<void> {
		this.state.cancellations.push(operationId);
	}

	async heartbeat(heartbeat: RemoteOperationHeartbeat): Promise<RemoteOperationLease> {
		this.state.heartbeats.push({ ...heartbeat });
		const expiresAt = new Date(Date.parse(this.#options.now?.() ?? new Date().toISOString()) + 60_000).toISOString();
		const lease = { leaseId: heartbeat.leaseId, expiresAt };
		this.state.leases.push(lease);
		return lease;
	}

	release(operationId: string): void {
		const pending = this.#pending.get(operationId);
		if (pending === undefined) return;
		this.#pending.delete(operationId);
		pending.resolve();
	}

	#recordSideEffect(
		request: RemoteOperationRequest,
		context: RemoteOperationExecutionContext,
		artifacts: ReadonlyArray<RemoteArtifactReference>,
	): void {
		context.recordSideEffect(artifacts);
		this.state.sideEffects.push({ operationId: request.operationId, artifactRefs: cloneArtifacts(artifacts) });
	}
}

/** Provider adapter over the same in-process transport used by contract tests. */
export class FakeRemoteProvider implements RemoteOperationProvider {
	readonly id: string;
	readonly transport: FakeRemoteTransport;

	constructor(options: FakeRemoteProviderOptions = {}) {
		this.id = options.id ?? FAKE_REMOTE_PROVIDER_ID;
		this.transport = new FakeRemoteTransport(options);
	}

	execute(request: RemoteOperationRequest, context: RemoteOperationExecutionContext): Promise<RemoteOperationResult> {
		return this.transport.execute(request, context);
	}

	cancel(operationId: string): Promise<void> {
		return this.transport.cancel(operationId);
	}

	heartbeat(heartbeat: RemoteOperationHeartbeat): Promise<RemoteOperationLease> {
		return this.transport.heartbeat(heartbeat);
	}

	release(operationId: string): void {
		this.transport.release(operationId);
	}

	get state(): FakeRemoteProviderState {
		return this.transport.state;
	}
}

/** Make a local provider from an arbitrary invoker while retaining the same contract. */
export function createLocalRemoteProvider(invoker: RemoteOperationInvoker): RemoteOperationProvider {
	return {
		id: "local-operation-provider",
		execute: (request, context) => invoker.execute(request, context),
		cancel: (operationId) => invoker.cancel(operationId),
		heartbeat: (heartbeat) => invoker.heartbeat(heartbeat),
	};
}

/** Stable fixture metadata used by tests to ensure no second ledger is implied. */
export const FAKE_REMOTE_CONTRACT_FIXTURE = {
	schemaVersion: REMOTE_OPERATION_SCHEMA_VERSION,
	providerId: FAKE_REMOTE_PROVIDER_ID,
	transport: "in-process",
} as const;
