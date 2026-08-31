import {
	FoundationError,
	Result,
	type ExecutionCorrelation,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type ResultValue,
	type SandboxOperationRequest,
	type WorkerReceipt,
} from "../../../agent/src/internal.ts";
import type {
	SafeLeaseProjection,
	SafeLeaseReference,
} from "../../src/core/worker/protocol.ts";
import type { WorkerRuntimeSandboxOperationProvider } from "../../src/core/worker/runtime.ts";

export type FakeWorkerStartBehavior = "success" | "provider-error" | "throw" | "correlation-drift" | "oversized-frame" | "pending";
export type FakeWorkerCredentialAction = "project" | "renew" | "revoke";

export interface FakeWorkerProviderOptions {
	readonly providerId?: string;
	readonly capabilities?: readonly string[];
	readonly startBehavior?: FakeWorkerStartBehavior;
	readonly failedCredentialActions?: readonly FakeWorkerCredentialAction[];
	readonly cancelFails?: boolean;
	readonly disposeThrows?: boolean;
}

export class FakeWorkerProvider implements WorkerRuntimeSandboxOperationProvider {
	readonly schemaVersion = 1 as const;
	readonly providerClass = "operation_worker" as const;
	readonly providerId: string;
	readonly starts: Array<{ readonly request: SandboxOperationRequest; readonly correlation: ExecutionCorrelation }> = [];
	readonly cancellations: string[] = [];
	readonly projectedLeases: SafeLeaseProjection[] = [];
	readonly renewedLeases: SafeLeaseProjection[] = [];
	readonly revokedLeases: SafeLeaseReference[] = [];
	readonly receipts: WorkerReceipt[] = [];
	capabilityCalls = 0;
	disposeCalls = 0;

	private readonly capabilityIds: readonly string[];
	private readonly startBehavior: FakeWorkerStartBehavior;
	private readonly failedCredentialActions: ReadonlySet<FakeWorkerCredentialAction>;
	private readonly cancelFails: boolean;
	private readonly disposeThrows: boolean;
	private pendingResolve?: (receipt: WorkerReceipt) => void;
	private pendingRequest?: SandboxOperationRequest;
	private pendingCorrelation?: ExecutionCorrelation;

	constructor(options: FakeWorkerProviderOptions = {}) {
		this.providerId = options.providerId ?? "sandbox-worker";
		this.capabilityIds = options.capabilities ?? ["filesystem.read", "process.spawn"];
		this.startBehavior = options.startBehavior ?? "success";
		this.failedCredentialActions = new Set(options.failedCredentialActions ?? []);
		this.cancelFails = options.cancelFails ?? false;
		this.disposeThrows = options.disposeThrows ?? false;
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		this.capabilityCalls += 1;
		return this.capabilityIds.map((id) => ({ schemaVersion: 1, id, version: 1 }));
	}

	async start(request: SandboxOperationRequest, options?: FoundationProviderExecutionOptions): Promise<ResultValue<WorkerReceipt, FoundationError>> {
		const correlation = options?.correlation;
		if (correlation === undefined) throw new Error("fake provider requires execution correlation");
		this.starts.push({ request, correlation });
		if (this.startBehavior === "throw") throw new Error("secret=worker-runtime-secret C:\\private\\provider.ts");
		if (this.startBehavior === "provider-error") return Result.err(new FoundationError("worker_start_failed", "fake provider rejected operation"));
		if (this.startBehavior === "pending") {
			this.pendingRequest = request;
			this.pendingCorrelation = correlation;
			return new Promise((resolve) => {
				this.pendingResolve = (receipt) => resolve(Result.ok(receipt));
			});
		}
		const receiptCorrelation = this.startBehavior === "correlation-drift" ? { ...correlation, laneId: "drifted-lane" } : correlation;
		const receipt = this.receipt(request, receiptCorrelation);
		this.receipts.push(receipt);
		return Result.ok(receipt);
	}

	async cancel(operationId: string): Promise<ResultValue<void, FoundationError>> {
		this.cancellations.push(operationId);
		return this.cancelFails
			? Result.err(new FoundationError("worker_cancel_failed", "fake provider rejected cancel"))
			: Result.ok(undefined);
	}

	async projectCredential(lease: SafeLeaseProjection): Promise<ResultValue<void, FoundationError>> {
		this.projectedLeases.push(lease);
		return this.credentialResult("project");
	}

	async renewCredential(lease: SafeLeaseProjection): Promise<ResultValue<void, FoundationError>> {
		this.renewedLeases.push(lease);
		return this.credentialResult("renew");
	}

	async revokeCredential(lease: SafeLeaseReference): Promise<ResultValue<void, FoundationError>> {
		this.revokedLeases.push(lease);
		return this.credentialResult("revoke");
	}

	async dispose(): Promise<void> {
		this.disposeCalls += 1;
		if (this.disposeThrows) throw new Error("token=dispose-secret C:\\private\\dispose.ts");
	}

	completePending(): void {
		const request = this.pendingRequest;
		const correlation = this.pendingCorrelation;
		const resolve = this.pendingResolve;
		if (request === undefined || correlation === undefined || resolve === undefined) throw new Error("fake provider has no pending operation");
		this.pendingRequest = undefined;
		this.pendingCorrelation = undefined;
		this.pendingResolve = undefined;
		const receipt = this.receipt(request, correlation);
		this.receipts.push(receipt);
		resolve(receipt);
	}

	private credentialResult(action: FakeWorkerCredentialAction): ResultValue<void, FoundationError> {
		return this.failedCredentialActions.has(action)
			? Result.err(new FoundationError("worker_unavailable", "fake credential target rejected operation"))
			: Result.ok(undefined);
	}

	private receipt(request: SandboxOperationRequest, correlation: ExecutionCorrelation): WorkerReceipt {
		const artifacts = this.startBehavior === "oversized-frame"
			? Array.from({ length: 64 }, (_, index) => {
					const marker = "oversized-provider-result";
					return {
						schemaVersion: 1 as const,
						artifactId: `artifact-${String(index).padStart(2, "0")}-${"a".repeat(244)}`,
						mediaType: `${marker}${"\u0000".repeat(128 - marker.length)}`,
						digest: `sha256:${"b".repeat(64)}`,
						producer: "p".repeat(256),
						sizeBytes: Number.MAX_SAFE_INTEGER,
					};
				})
			: undefined;
		return {
			schemaVersion: 1,
			workerReceiptId: `receipt-${this.starts.length}`,
			sandboxProviderId: this.providerId,
			operationId: request.operationId,
			...(request.taskId === undefined ? {} : { taskId: request.taskId }),
			...(request.dispatchId === undefined ? {} : { dispatchId: request.dispatchId }),
			...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
			status: "succeeded",
			sideEffectState: "none",
			...(artifacts === undefined ? {} : { artifacts }),
			provenance: {
				producerKind: "operation_worker",
				providerId: this.providerId,
				producedAt: "2026-08-21T00:00:02.000Z",
				correlation,
			},
			startedAt: "2026-08-21T00:00:01.000Z",
			completedAt: "2026-08-21T00:00:02.000Z",
		};
	}
}
