import { createHash } from "node:crypto";
import {
	canonicalFoundationJson,
	FoundationError,
	Result,
	validateSandboxOperationRequestV1,
	validateFoundationProviderCapabilityV1,
	validateWorkerReceiptForProviderV1,
	type ExecutionCorrelationV1,
	type FoundationJsonValue,
	type FoundationErrorCode,
	type FoundationProviderCapabilityV1,
	type FoundationProviderExecutionOptionsV1,
	type Result as ResultValue,
	type SandboxOperationProvider,
	type SandboxOperationRequestV1,
	type WorkerReceiptV1,
} from "@aos-agent/agent-core";
import {
	WorkerSupervisorV1,
	type WorkerSupervisorConfigV1,
} from "./worker-supervisor.ts";
import type { WorkerCancelReasonV1 } from "./worker-protocol.ts";
import {
	parseWorkerRecordV1,
	serializeWorkerRecordV1,
	validateWorkerBindingV1,
	type WorkerBindingV1,
	type WorkerRecordV1,
	type WorkerTransitionReceiptV1,
} from "./worker.ts";

export interface WorkerSandboxProfileV1 {
	readonly profileId: string;
	readonly profileRevision: number;
	readonly trusted: true;
	readonly supervisor: WorkerSupervisorConfigV1;
}

/** Read-only Host authority facts resolved before a Supervisor may be created. */
export interface WorkerSandboxPreflightFactsV1 {
	readonly binding: WorkerBindingV1;
	readonly runAccepted: boolean;
	readonly sessionOwned: boolean;
	readonly laneOwned: boolean;
	readonly bindingAuthorized: boolean;
	readonly policyAuthorized: boolean;
	readonly sandboxAuthorized: boolean;
	readonly credentialLeaseActive: boolean;
}

export interface WorkerSandboxProviderOptionsV1 {
	readonly providerId: string;
	/** Omission is the default inline/Host path and creates no Supervisor or child process. */
	readonly profile?: WorkerSandboxProfileV1;
	readonly capabilities?: readonly FoundationProviderCapabilityV1[];
	/** This callback must only read Host authority state. */
	readonly resolvePreflight: (
		request: SandboxOperationRequestV1,
		options: FoundationProviderExecutionOptionsV1,
	) => WorkerSandboxPreflightFactsV1 | Promise<WorkerSandboxPreflightFactsV1>;
	readonly createSupervisor?: (config: WorkerSupervisorConfigV1) => WorkerSupervisorV1;
	readonly requireRegisteredPayload?: boolean;
	readonly onWorkerRecord?: (record: WorkerRecordV1) => void;
	readonly maxRetainedRecords?: number;
}

export type WorkerSandboxFactV1 =
	| {
		readonly type: "record";
		readonly record: WorkerRecordV1;
		readonly transitions: readonly WorkerTransitionReceiptV1[];
		readonly transitionRecords?: readonly WorkerRecordV1[];
	}
	| {
		readonly type: "operation";
		readonly workerId: string;
		readonly providerId: string;
		readonly sessionId: string;
		readonly laneId: string;
		readonly operationId: string;
		readonly revision: number;
		readonly recordedAt: string;
	}
	| { readonly type: "receipt"; readonly workerId: string; readonly terminalRecordRevision: number; readonly receipt: WorkerReceiptV1 };

interface ActiveWorkerOperationV1 {
	readonly request: SandboxOperationRequestV1;
	readonly supervisor: WorkerSupervisorV1;
	readonly runId?: string;
}

interface StagedWorkerFactsV1 {
	readonly records: Map<string, WorkerRecordV1>;
	readonly receipts: Map<string, WorkerReceiptV1>;
	readonly completedOperationIds: Set<string>;
	readonly consumedWorkerIds: Set<string>;
}

type WorkerInvalidationReasonV1 = WorkerCancelReasonV1 | "terminal";

interface WorkerOperationReservationV1 {
	readonly operationId: string;
	runId?: string;
	invalidated?: WorkerInvalidationReasonV1;
	readonly pendingRunInvalidations: Map<string, WorkerInvalidationReasonV1>;
	readonly invalidation: Promise<void>;
	readonly resolveInvalidation: () => void;
	readonly settled: Promise<void>;
	readonly resolveSettled: () => void;
}

export interface WorkerSandboxRecoveryV1 {
	readonly records?: readonly WorkerRecordV1[];
	readonly receipts?: readonly WorkerReceiptV1[];
	readonly operationIds?: readonly string[];
	readonly workerIds?: readonly string[];
}

function providerError(code: FoundationErrorCode, message: string): FoundationError {
	return new FoundationError(code, message);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
}

function freezeFoundationJson(value: FoundationJsonValue): FoundationJsonValue {
	if (Array.isArray(value)) {
		const items = value.map((item) => freezeFoundationJson(item));
		Object.freeze(items);
		return items;
	}
	if (value !== null && typeof value === "object") {
		const record = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeFoundationJson(item)]));
		Object.freeze(record);
		return record;
	}
	return value;
}

function snapshotFoundationJson(value: FoundationJsonValue): FoundationJsonValue {
	return freezeFoundationJson(JSON.parse(canonicalFoundationJson(value)) as FoundationJsonValue);
}

function snapshotProfile(profile: WorkerSandboxProfileV1 | undefined): WorkerSandboxProfileV1 | undefined {
	if (profile === undefined) return undefined;
	const supervisor = Object.freeze({
		...profile.supervisor,
		capabilities: Object.freeze([...profile.supervisor.capabilities]),
		...(profile.supervisor.environment === undefined
			? {}
			: { environment: Object.freeze({ ...profile.supervisor.environment }) }),
	});
	return Object.freeze({
		profileId: profile.profileId,
		profileRevision: profile.profileRevision,
		trusted: profile.trusted,
		supervisor,
	});
}

function sameWorkerIdentity(left: WorkerRecordV1, right: WorkerRecordV1): boolean {
	return left.providerId === right.providerId &&
		left.sessionId === right.sessionId &&
		left.laneId === right.laneId &&
		left.runId === right.runId &&
		left.bindingId === right.bindingId &&
		left.bindingEpochId === right.bindingEpochId &&
		left.attemptId === right.attemptId &&
		left.profileId === right.profileId;
}

function correlationMatchesBinding(
	correlation: ExecutionCorrelationV1 | undefined,
	binding: WorkerBindingV1,
	request: SandboxOperationRequestV1,
	providerId: string,
): boolean {
	if (correlation === undefined) return true;
	return correlation.sessionId === binding.sessionId &&
		correlation.laneId === binding.laneId &&
		correlation.operationId === request.operationId &&
		correlation.providerId === providerId &&
		correlation.revision === 0 &&
		(correlation.runId === undefined || correlation.runId === binding.runId) &&
		(correlation.bindingId === undefined || correlation.bindingId === binding.bindingId) &&
		(correlation.bindingEpochId === undefined || correlation.bindingEpochId === binding.bindingEpochId) &&
		(correlation.attemptId === undefined || correlation.attemptId === binding.attemptId) &&
		(correlation.toolCallId === undefined || correlation.toolCallId === request.toolCallId) &&
		(correlation.taskId === undefined || correlation.taskId === request.taskId) &&
		(correlation.dispatchId === undefined || correlation.dispatchId === request.dispatchId) &&
		(correlation.agentInstanceId === undefined || correlation.agentInstanceId === request.agentInstanceId);
}

function requestMatchesBinding(request: SandboxOperationRequestV1, binding: WorkerBindingV1): boolean {
	return binding.providerId.length > 0 &&
		(request.providerId === undefined || request.providerId === binding.providerId) &&
		(request.bindingId === undefined || request.bindingId === binding.bindingId) &&
		(request.bindingEpochId === undefined || request.bindingEpochId === binding.bindingEpochId) &&
		(request.attemptId === undefined || request.attemptId === binding.attemptId) &&
		sameStrings(request.credentialTargets ?? [], binding.credentialTargetRefs) &&
		(request.deadlineAt === undefined || binding.deadlineAt !== undefined && binding.deadlineAt <= request.deadlineAt);
}

export function createWorkerRequestFingerprintV1(request: SandboxOperationRequestV1): string {
	return `sha256:${createHash("sha256").update(canonicalFoundationJson(request)).digest("hex")}`;
}

/**
 * Host-side implementation of the frozen SandboxOperationProvider contract.
 * A profile must be explicitly configured; otherwise every start fails before
 * Supervisor construction and the existing inline/Host path remains inert.
 */
export class WorkerSandboxProviderV1 implements SandboxOperationProvider {
	readonly schemaVersion = 1 as const;
	readonly providerClass = "operation_worker" as const;
	readonly providerId: string;

	private readonly options: WorkerSandboxProviderOptionsV1;
	private readonly declaredCapabilities: readonly FoundationProviderCapabilityV1[];
	private readonly capabilityConfigurationValid: boolean;
	private readonly maxRetainedRecords: number;
	private readonly operations = new Map<string, ActiveWorkerOperationV1>();
	private readonly reservations = new Map<string, WorkerOperationReservationV1>();
	private readonly completedOperationIds = new Set<string>();
	private readonly consumedWorkerIds = new Set<string>();
	private readonly operationPayloads = new Map<string, FoundationJsonValue>();
	private readonly records = new Map<string, WorkerRecordV1>();
	private readonly receipts = new Map<string, WorkerReceiptV1>();
	private readonly factSubscribers = new Set<(fact: WorkerSandboxFactV1) => void>();
	private durableFactOwner: string | undefined;
	private durableFactSink: ((fact: WorkerSandboxFactV1) => void) | undefined;
	private disposed = false;
	private disposeCompletion: Promise<void> | undefined;

	constructor(options: WorkerSandboxProviderOptionsV1) {
		const profile = snapshotProfile(options.profile);
		this.options = Object.freeze({ ...options, ...(profile === undefined ? { profile: undefined } : { profile }) });
		this.providerId = options.providerId;
		const profileCapabilityIds = profile?.supervisor.capabilities ?? [];
		this.declaredCapabilities = Object.freeze((options.capabilities ?? profileCapabilityIds.map((id) => ({ schemaVersion: 1 as const, id, version: 1 })))
			.map((capability) => Object.freeze({ ...capability })));
		const declaredIds = this.declaredCapabilities.map((capability) => capability.id);
		this.capabilityConfigurationValid =
			this.declaredCapabilities.every((capability) => validateFoundationProviderCapabilityV1(capability).ok) &&
			new Set(declaredIds).size === declaredIds.length &&
			(options.profile === undefined || sameStringSet(declaredIds, profileCapabilityIds));
		this.maxRetainedRecords = options.maxRetainedRecords ?? 256;
		if (!Number.isSafeInteger(this.maxRetainedRecords) || this.maxRetainedRecords < 1) {
			throw new RangeError("maxRetainedRecords must be a positive safe integer");
		}
	}

	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> {
		return Object.freeze(this.declaredCapabilities.map((capability) => Object.freeze({ ...capability })));
	}

	/** ToolGateway payload callback. It records provider-neutral JSON only. */
	onOperationPayload(operationId: string, payload: FoundationJsonValue): void {
		if (
			this.disposed ||
			operationId.length === 0 ||
			this.operations.has(operationId) ||
			this.reservations.has(operationId) ||
			this.completedOperationIds.has(operationId) ||
			this.operationPayloads.has(operationId) ||
			this.operationPayloads.size >= this.maxRetainedRecords
		) return;
		canonicalFoundationJson(payload);
		this.operationPayloads.set(operationId, snapshotFoundationJson(payload));
	}

	getWorkerRecord(workerId: string): WorkerRecordV1 | undefined {
		const record = this.records.get(workerId);
		return record === undefined ? undefined : this.cloneRecord(record);
	}

	listWorkerRecords(): readonly WorkerRecordV1[] {
		return [...this.records.values()].map((record) => this.cloneRecord(record));
	}

	getWorkerReceipt(workerReceiptId: string): WorkerReceiptV1 | undefined {
		const receipt = this.receipts.get(workerReceiptId);
		return receipt === undefined ? undefined : this.cloneReceipt(receipt);
	}

	listWorkerReceipts(): readonly WorkerReceiptV1[] {
		return [...this.receipts.values()].map((receipt) => this.cloneReceipt(receipt));
	}

	subscribeFacts(subscriber: (fact: WorkerSandboxFactV1) => void): () => void {
		this.factSubscribers.add(subscriber);
		return () => this.factSubscribers.delete(subscriber);
	}

	/** Bind the single Host-owned durable writer. Its failures cross the operation boundary. */
	bindDurableFactSink(ownerId: string, sink: (fact: WorkerSandboxFactV1) => void): () => void {
		if (this.disposed || ownerId.length === 0 || this.durableFactSink !== undefined) {
			throw providerError("service_conflict", "Operation Worker durable fact owner is already bound");
		}
		this.durableFactOwner = ownerId;
		this.durableFactSink = sink;
		return () => {
			if (this.durableFactOwner !== ownerId || this.durableFactSink !== sink) return;
			this.durableFactOwner = undefined;
			this.durableFactSink = undefined;
		};
	}

	hasDurableFactOwner(): boolean {
		return this.durableFactSink !== undefined;
	}

	/** Validate recovery atomically before a ControlPlane writes convergence facts. */
	validateWorkerFactsForRestore(recovery: WorkerSandboxRecoveryV1): ResultValue<void, FoundationError> {
		const staged = this.stageWorkerFacts(recovery);
		return staged.ok ? Result.ok(undefined) : Result.err(staged.error);
	}

	/** Restore terminal safe summaries only; no Supervisor, process, or lease state is recreated. */
	restoreWorkerFacts(recovery: WorkerSandboxRecoveryV1): ResultValue<void, FoundationError> {
		const staged = this.stageWorkerFacts(recovery);
		if (!staged.ok) return Result.err(staged.error);
		const {
			records: stagedRecords,
			receipts: stagedReceipts,
			completedOperationIds: stagedCompletedOperationIds,
			consumedWorkerIds: stagedConsumedWorkerIds,
		} = staged.value;
		this.records.clear();
		for (const [workerId, record] of stagedRecords) this.records.set(workerId, record);
		this.receipts.clear();
		for (const [receiptId, receipt] of stagedReceipts) this.receipts.set(receiptId, receipt);
		this.completedOperationIds.clear();
		for (const operationId of stagedCompletedOperationIds) this.completedOperationIds.add(operationId);
		this.consumedWorkerIds.clear();
		for (const workerId of stagedConsumedWorkerIds) this.consumedWorkerIds.add(workerId);
		this.evictRetainedFacts();
		return Result.ok(undefined);
	}

	private stageWorkerFacts(recovery: WorkerSandboxRecoveryV1): ResultValue<StagedWorkerFactsV1, FoundationError> {
		if (this.disposed) {
			return Result.err(providerError("worker_persistence_failed", "Disposed Operation Worker cannot restore durable facts"));
		}
		const stagedRecords = new Map(this.records);
		const stagedReceipts = new Map(this.receipts);
		const stagedCompletedOperationIds = new Set(this.completedOperationIds);
		const stagedConsumedWorkerIds = new Set(this.consumedWorkerIds);
		for (const recordValue of recovery.records ?? []) {
			let record: WorkerRecordV1;
			try {
				record = this.cloneRecord(recordValue);
			} catch {
				return Result.err(providerError("worker_persistence_failed", "Historical Operation Worker record is invalid"));
			}
			if (!["completed", "failed", "cancelled", "lost", "reclaimed", "reclaim_unknown"].includes(record.status)) {
				return Result.err(providerError("worker_persistence_failed", "Historical Operation Worker record is not terminal"));
			}
			if (record.providerId !== this.providerId) {
				return Result.err(providerError("worker_persistence_failed", "Historical Operation Worker provider identity is invalid"));
			}
			const current = stagedRecords.get(record.workerId);
			if (current !== undefined) {
				if (!sameWorkerIdentity(record, current)) {
					return Result.err(providerError("worker_persistence_failed", "Historical Operation Worker identity drifted"));
				}
				if (record.revision < current.revision) continue;
				if (record.revision === current.revision) {
					if (serializeWorkerRecordV1(record) !== serializeWorkerRecordV1(current)) {
						return Result.err(providerError("worker_persistence_failed", "Historical Operation Worker record conflicts at the same revision"));
					}
					continue;
				}
			}
			stagedRecords.delete(record.workerId);
			stagedRecords.set(record.workerId, record);
			stagedConsumedWorkerIds.add(record.workerId);
		}
		for (const receiptValue of recovery.receipts ?? []) {
			const validated = validateWorkerReceiptForProviderV1(receiptValue, {
				providerId: this.providerId,
				providerClass: this.providerClass,
			});
			if (!validated.ok) return Result.err(providerError("worker_persistence_failed", "Historical Operation Worker receipt is invalid"));
			const receipt = this.cloneReceipt(validated.value);
			const current = stagedReceipts.get(receipt.workerReceiptId);
			if (current !== undefined && canonicalFoundationJson(current) !== canonicalFoundationJson(receipt)) {
				return Result.err(providerError("worker_persistence_failed", "Historical Operation Worker receipt conflicts"));
			}
			stagedReceipts.delete(receipt.workerReceiptId);
			stagedReceipts.set(receipt.workerReceiptId, receipt);
			stagedCompletedOperationIds.add(receipt.operationId);
		}
		for (const operationId of recovery.operationIds ?? []) {
			if (operationId.length === 0) {
				return Result.err(providerError("worker_persistence_failed", "Historical Operation Worker operation identity is invalid"));
			}
			stagedCompletedOperationIds.add(operationId);
		}
		for (const workerId of recovery.workerIds ?? []) {
			if (workerId.length === 0) {
				return Result.err(providerError("worker_persistence_failed", "Historical Operation Worker identity is invalid"));
			}
			stagedConsumedWorkerIds.add(workerId);
		}
		while (stagedRecords.size > this.maxRetainedRecords) {
			const oldest = stagedRecords.keys().next().value;
			if (oldest === undefined) break;
			stagedRecords.delete(oldest);
		}
		while (stagedReceipts.size > this.maxRetainedRecords) {
			const oldest = stagedReceipts.keys().next().value;
			if (oldest === undefined) break;
			stagedReceipts.delete(oldest);
		}
		return Result.ok({
			records: stagedRecords,
			receipts: stagedReceipts,
			completedOperationIds: stagedCompletedOperationIds,
			consumedWorkerIds: stagedConsumedWorkerIds,
		});
	}

	async reclaimWorker(workerId: string): Promise<ResultValue<WorkerRecordV1, FoundationError>> {
		const active = [...this.operations.values()].find((operation) => operation.supervisor.snapshot.record?.workerId === workerId);
		if (active !== undefined) {
			const activeRecord = active.supervisor.snapshot.record;
			if (
				activeRecord === undefined ||
				!["completed", "failed", "cancelled", "lost", "reclaiming", "reclaimed", "reclaim_unknown"].includes(activeRecord.status)
			) {
				return Result.err(providerError("worker_conflict", "Live Operation Worker cannot be reclaimed before execution is terminal"));
			}
			const reclaimed = await active.supervisor.reclaim();
			const factError = this.publishRecord(active.supervisor);
			if (factError !== undefined) return Result.err(factError);
			return reclaimed;
		}
		const retained = this.records.get(workerId);
		if (retained === undefined) return Result.err(providerError("worker_not_found", "Operation Worker was not found"));
		if (retained.status === "reclaimed" || retained.status === "reclaim_unknown") {
			return Result.ok(this.cloneRecord(retained));
		}
		if (!["completed", "failed", "cancelled", "lost"].includes(retained.status) || retained.endedAt === undefined) {
			return Result.err(providerError("worker_conflict", "Historical Operation Worker cannot be reclaimed"));
		}
		const reclaimingRecord = this.cloneRecord({
			...retained,
			status: "reclaiming",
			revision: retained.revision + 1,
		});
		const unknownRecord = this.cloneRecord({
			...reclaimingRecord,
			status: "reclaim_unknown",
			revision: reclaimingRecord.revision + 1,
		});
		const transitions: readonly WorkerTransitionReceiptV1[] = Object.freeze([
			Object.freeze({
				schemaVersion: 1,
				clientRequestId: `historical-reclaim:${workerId}:${reclaimingRecord.revision}`,
				requestFingerprint: `sha256:${createHash("sha256").update(`${workerId}:${reclaimingRecord.revision}`).digest("hex")}`,
				from: retained.status,
				to: "reclaiming",
				previousRevision: retained.revision,
				revision: reclaimingRecord.revision,
				at: retained.endedAt,
			}),
			Object.freeze({
				schemaVersion: 1,
				clientRequestId: `historical-reclaim:${workerId}:${unknownRecord.revision}`,
				requestFingerprint: `sha256:${createHash("sha256").update(`${workerId}:${unknownRecord.revision}`).digest("hex")}`,
				from: "reclaiming",
				to: "reclaim_unknown",
				previousRevision: reclaimingRecord.revision,
				revision: unknownRecord.revision,
				at: retained.endedAt,
			}),
		]);
		const fact: WorkerSandboxFactV1 = {
			type: "record",
			record: this.cloneRecord(unknownRecord),
			transitions,
			transitionRecords: Object.freeze([this.cloneRecord(reclaimingRecord), this.cloneRecord(unknownRecord)]),
		};
		const durableError = this.persistFact(fact);
		if (durableError !== undefined) return Result.err(durableError);
		this.records.delete(workerId);
		this.records.set(workerId, unknownRecord);
		this.evictRetainedFacts();
		try {
			this.options.onWorkerRecord?.(this.cloneRecord(unknownRecord));
		} catch {
			// Observation cannot cross the provider Result boundary.
		}
		this.publishObservationalFact(fact);
		return Result.ok(this.cloneRecord(unknownRecord));
	}

	async start(
		requestValue: SandboxOperationRequestV1,
		executionOptions: FoundationProviderExecutionOptionsV1 = {},
	): Promise<ResultValue<WorkerReceiptV1, FoundationError>> {
		if (this.disposed) return Result.err(providerError("worker_unavailable", "Operation Worker provider is disposed"));
		const request = validateSandboxOperationRequestV1(requestValue);
		if (!request.ok) {
			const rawRequest: unknown = requestValue;
			const rawOperationId = rawRequest !== null && typeof rawRequest === "object" && "operationId" in rawRequest
				? rawRequest.operationId
				: undefined;
			if (typeof rawOperationId === "string") this.operationPayloads.delete(rawOperationId);
			return request;
		}
		let requestSnapshot: typeof request;
		try {
			requestSnapshot = Object.freeze({
				...request,
				value: snapshotFoundationJson(request.value as unknown as FoundationJsonValue) as unknown as SandboxOperationRequestV1,
			});
		} catch {
			this.operationPayloads.delete(request.value.operationId);
			return Result.err(providerError("foundation_schema_invalid_shape", "Operation Worker request is not canonical"));
		}
		const signal = executionOptions.signal;
		let correlationSnapshot: ExecutionCorrelationV1 | undefined;
		try {
			correlationSnapshot = executionOptions.correlation === undefined
				? undefined
				: snapshotFoundationJson(executionOptions.correlation as unknown as FoundationJsonValue) as unknown as ExecutionCorrelationV1;
		} catch {
			this.operationPayloads.delete(requestSnapshot.value.operationId);
			return Result.err(providerError("invalid_correlation", "Operation Worker correlation is invalid"));
		}
		const stableExecutionOptions: FoundationProviderExecutionOptionsV1 = Object.freeze({
			...(correlationSnapshot === undefined ? {} : { correlation: correlationSnapshot }),
			...(signal === undefined ? {} : { signal }),
		});
		if (
			this.reservations.has(requestSnapshot.value.operationId) ||
			this.operations.has(requestSnapshot.value.operationId) ||
			this.completedOperationIds.has(requestSnapshot.value.operationId)
		) {
			return Result.err(providerError("worker_conflict", "Operation Worker operation identity is already used"));
		}
		const profile = this.options.profile;
		if (profile === undefined) {
			this.operationPayloads.delete(requestSnapshot.value.operationId);
			return Result.err(providerError("worker_unavailable", "Operation Worker profile is not enabled"));
		}
		if (
			profile.trusted !== true ||
			profile.profileId !== profile.supervisor.profileId ||
			profile.profileRevision !== profile.supervisor.profileRevision ||
			!this.capabilityConfigurationValid
		) {
			this.operationPayloads.delete(requestSnapshot.value.operationId);
			return Result.err(providerError("worker_profile_untrusted", "Operation Worker profile is not trusted"));
		}
		if (signal?.aborted) {
			this.operationPayloads.delete(requestSnapshot.value.operationId);
			return Result.err(providerError("worker_cancel_failed", "Operation Worker operation was cancelled before activation"));
		}
		if (requestSnapshot.value.deadlineAt !== undefined && requestSnapshot.value.deadlineAt <= Date.now()) {
			this.operationPayloads.delete(requestSnapshot.value.operationId);
			return Result.err(providerError("worker_deadline_exceeded", "Operation Worker deadline elapsed before preflight"));
		}

		const registeredPayload = this.operationPayloads.get(requestSnapshot.value.operationId);
		if (this.options.requireRegisteredPayload && registeredPayload === undefined) {
			this.operationPayloads.delete(requestSnapshot.value.operationId);
			return Result.err(providerError("worker_operation_invalid", "Operation Worker payload was not registered"));
		}
		if (
			registeredPayload !== undefined &&
			(requestSnapshot.value.payload === undefined || canonicalFoundationJson(registeredPayload) !== canonicalFoundationJson(requestSnapshot.value.payload))
		) {
			this.operationPayloads.delete(requestSnapshot.value.operationId);
			return Result.err(providerError("worker_operation_invalid", "Operation Worker payload correlation is invalid"));
		}
		if (this.reservations.size >= this.maxRetainedRecords) {
			this.operationPayloads.delete(requestSnapshot.value.operationId);
			return Result.err(providerError("worker_unavailable", "Operation Worker registry capacity is exhausted"));
		}

		let resolveReservation: () => void = () => undefined;
		const reservationSettled = new Promise<void>((resolve) => { resolveReservation = resolve; });
		let resolveInvalidation: () => void = () => undefined;
		const invalidation = new Promise<void>((resolve) => { resolveInvalidation = resolve; });
		const reservation: WorkerOperationReservationV1 = {
			operationId: requestSnapshot.value.operationId,
			...(correlationSnapshot?.runId === undefined ? {} : { runId: correlationSnapshot.runId }),
			pendingRunInvalidations: new Map(),
			invalidation,
			resolveInvalidation,
			settled: reservationSettled,
			resolveSettled: resolveReservation,
		};
		this.reservations.set(requestSnapshot.value.operationId, reservation);
		let supervisor: WorkerSupervisorV1 | undefined;
		let cancellation: Promise<void> | undefined;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let identityConsumed = false;
		let outcome: ResultValue<WorkerReceiptV1, FoundationError> = Result.err(
			providerError("worker_unavailable", "Operation Worker operation did not start"),
		);
		const invalidateLiveReservation = (reason: WorkerInvalidationReasonV1): void => {
			this.invalidateReservation(reservation, reason);
			if (supervisor === undefined || cancellation !== undefined) return;
			cancellation = this.convergeInvalidation(supervisor, reason, requestSnapshot.value.operationId)
				.then(() => undefined, () => undefined);
		};
		const abort = (): void => invalidateLiveReservation("cancel");
		signal?.addEventListener("abort", abort, { once: true });
		const armDeadline = (): void => {
			const deadlineAt = requestSnapshot.value.deadlineAt;
			if (deadlineAt === undefined) return;
			const remaining = deadlineAt - Date.now();
			if (remaining <= 0) {
				invalidateLiveReservation("deadline");
				return;
			}
			deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
		};
		armDeadline();
		try {
			outcome = await (async (): Promise<ResultValue<WorkerReceiptV1, FoundationError>> => {
				const preflight = Promise.resolve()
					.then(() => this.options.resolvePreflight(requestSnapshot.value, stableExecutionOptions))
					.then(
						(facts) => ({ kind: "resolved" as const, facts }),
						() => ({ kind: "failed" as const }),
					);
				const preflightOutcome = await Promise.race([
					preflight,
					reservation.invalidation.then(() => ({ kind: "invalidated" as const })),
				]);
				if (preflightOutcome.kind === "invalidated") {
					return Result.err(this.reservationError(reservation) ?? providerError("worker_cancel_failed", "Operation Worker preflight was invalidated"));
				}
				if (preflightOutcome.kind === "failed") {
					return Result.err(providerError("worker_unavailable", "Operation Worker preflight failed"));
				}
				let facts: WorkerSandboxPreflightFactsV1;
				try {
					const snapshot = snapshotFoundationJson(
						preflightOutcome.facts as unknown as FoundationJsonValue,
					);
					if (
						snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot) ||
						!validateWorkerBindingV1(snapshot.binding) ||
						typeof snapshot.runAccepted !== "boolean" ||
						typeof snapshot.sessionOwned !== "boolean" ||
						typeof snapshot.laneOwned !== "boolean" ||
						typeof snapshot.bindingAuthorized !== "boolean" ||
						typeof snapshot.policyAuthorized !== "boolean" ||
						typeof snapshot.sandboxAuthorized !== "boolean" ||
						typeof snapshot.credentialLeaseActive !== "boolean"
					) {
						return Result.err(providerError("worker_binding_invalid", "Operation Worker preflight facts are invalid"));
					}
					facts = snapshot as unknown as WorkerSandboxPreflightFactsV1;
				} catch {
					return Result.err(providerError("worker_binding_invalid", "Operation Worker preflight facts are invalid"));
				}
				reservation.runId ??= facts.binding.runId;
				const runInvalidation = reservation.runId === undefined
					? undefined
					: reservation.pendingRunInvalidations.get(reservation.runId);
				if (runInvalidation !== undefined) this.invalidateReservation(reservation, runInvalidation);
				reservation.pendingRunInvalidations.clear();
				if (signal?.aborted) this.invalidateReservation(reservation, "cancel");
				const invalidatedBeforeSpawn = this.reservationError(reservation);
				if (invalidatedBeforeSpawn !== undefined) return Result.err(invalidatedBeforeSpawn);
				const preflightError = this.validatePreflight(requestSnapshot.value, correlationSnapshot, profile, facts);
				if (preflightError !== undefined) return Result.err(preflightError);
				if (this.durableFactSink === undefined || this.durableFactOwner !== facts.binding.sessionId) {
					return Result.err(providerError("worker_persistence_failed", "Operation Worker durable fact owner is unavailable"));
				}
				if (this.consumedWorkerIds.has(facts.binding.workerId)) {
					return Result.err(providerError("worker_conflict", "Operation Worker identity is already used"));
				}
				this.consumedWorkerIds.add(facts.binding.workerId);
				identityConsumed = true;
				try {
					supervisor = (this.options.createSupervisor ?? ((config) => new WorkerSupervisorV1(config)))(profile.supervisor);
				} catch {
					return Result.err(providerError("worker_start_failed", "Operation Worker Supervisor construction failed"));
				}
				const normalizedBinding: WorkerBindingV1 = Object.freeze({
					...facts.binding,
					capabilitySummary: Object.freeze([...profile.supervisor.capabilities]),
				});
				const planned = supervisor.preflight({ binding: normalizedBinding, runAccepted: facts.runAccepted });
				if (!planned.ok) return planned;
				const active: ActiveWorkerOperationV1 = {
					request: requestSnapshot.value,
					supervisor,
					...(normalizedBinding.runId === undefined ? {} : { runId: normalizedBinding.runId }),
				};
				this.operations.set(requestSnapshot.value.operationId, active);
				const activated = await supervisor.activate(planned.value);
				const activationFactError = this.publishRecord(supervisor);
				if (activationFactError !== undefined) return Result.err(activationFactError);
				const invalidatedAfterActivation = this.reservationError(reservation);
				if (invalidatedAfterActivation !== undefined) {
					cancellation ??= this.convergeInvalidation(
						supervisor,
						reservation.invalidated ?? "cancel",
						requestSnapshot.value.operationId,
					).then(() => undefined, () => undefined);
					await cancellation;
					return Result.err(invalidatedAfterActivation);
				}
				if (!activated.ok) return activated;
				if (signal?.aborted) this.invalidateReservation(reservation, "cancel");
				const invalidatedBeforeExecute = this.reservationError(reservation);
				if (invalidatedBeforeExecute !== undefined) {
					await this.convergeInvalidation(
						supervisor,
						reservation.invalidated ?? "cancel",
						requestSnapshot.value.operationId,
					);
					return Result.err(invalidatedBeforeExecute);
				}
				const operationFenceError = this.publishOperationFence(supervisor, requestSnapshot.value.operationId);
				if (operationFenceError !== undefined) return Result.err(operationFenceError);
				if (signal?.aborted) this.invalidateReservation(reservation, "cancel");
				const invalidatedAfterFence = this.reservationError(reservation);
				if (invalidatedAfterFence !== undefined) {
					cancellation ??= this.convergeInvalidation(
						supervisor,
						reservation.invalidated ?? "cancel",
						requestSnapshot.value.operationId,
					).then(() => undefined, () => undefined);
					await cancellation;
					return Result.err(invalidatedAfterFence);
				}
				const executed = await supervisor.execute(requestSnapshot.value);
				const executionTerminalRecord = supervisor.snapshot.record;
				const executionFactError = this.publishRecord(supervisor);
				if (executionFactError !== undefined) return Result.err(executionFactError);
				if (!executed.ok) return executed;
				const receipt = validateWorkerReceiptForProviderV1(executed.value, {
					providerId: this.providerId,
					providerClass: this.providerClass,
				});
				if (!receipt.ok) return Result.err(receipt.error);
				if (
					executionTerminalRecord === undefined ||
					!["completed", "failed", "cancelled"].includes(executionTerminalRecord.status)
				) return Result.err(providerError("worker_receipt_invalid", "Operation Worker terminal record is invalid"));
				const receiptFactError = this.retainReceipt(
					executionTerminalRecord.workerId,
					executionTerminalRecord.revision,
					receipt.value,
				);
				if (receiptFactError !== undefined) return Result.err(receiptFactError);
				return Result.ok(this.cloneReceipt(receipt.value));
			})();
		} catch {
			outcome = Result.err(providerError("worker_operation_invalid", "Operation Worker callback failed"));
		} finally {
			signal?.removeEventListener("abort", abort);
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			if (cancellation !== undefined) await cancellation;
			if (supervisor !== undefined) {
				await supervisor.reclaim().catch(() => undefined);
				const cleanupFactError = this.publishRecord(supervisor);
				if (cleanupFactError !== undefined) outcome = Result.err(cleanupFactError);
			}
			this.operations.delete(requestSnapshot.value.operationId);
			this.reservations.delete(requestSnapshot.value.operationId);
			this.operationPayloads.delete(requestSnapshot.value.operationId);
			if (identityConsumed || reservation.invalidated !== undefined) this.retainCompletedOperationId(requestSnapshot.value.operationId);
			reservation.resolveSettled();
		}
		return outcome;
	}

	async cancel(operationId: string): Promise<ResultValue<void, FoundationError>> {
		if (this.completedOperationIds.has(operationId)) return Result.ok(undefined);
		const reservation = this.reservations.get(operationId);
		if (reservation !== undefined) this.invalidateReservation(reservation, "cancel");
		const active = this.operations.get(operationId);
		if (active === undefined) {
			return reservation === undefined
				? Result.err(providerError("worker_not_found", "Operation Worker operation was not found"))
				: Result.ok(undefined);
		}
		const cancelled = await this.convergeInvalidation(active.supervisor, "cancel", operationId);
		const factError = this.publishRecord(active.supervisor);
		if (factError !== undefined) return Result.err(factError);
		return cancelled;
	}

	async notifyRun(runId: string, reason: WorkerCancelReasonV1 | "terminal"): Promise<void> {
		for (const reservation of this.reservations.values()) {
			if (reservation.runId === runId) this.invalidateReservation(reservation, reason);
			else if (reservation.runId === undefined && !reservation.pendingRunInvalidations.has(runId)) {
				reservation.pendingRunInvalidations.set(runId, reason);
			}
		}
		const operations = [...this.operations.values()].filter((operation) => operation.runId === runId);
		await Promise.all(operations.map(async (operation) => {
			await this.convergeInvalidation(operation.supervisor, reason, operation.request.operationId);
			const factError = this.publishRecord(operation.supervisor);
			if (factError !== undefined) throw factError;
		}));
	}

	async terminateAll(reason: "shutdown" | "detach"): Promise<void> {
		for (const reservation of this.reservations.values()) this.invalidateReservation(reservation, reason);
		const operations = [...this.operations.values()];
		await Promise.all(operations.map(async (operation) => {
			await this.convergeInvalidation(operation.supervisor, reason, operation.request.operationId);
			const factError = this.publishRecord(operation.supervisor);
			if (factError !== undefined) throw factError;
		}));
	}

	async cancelAll(reason: "cancel" | "deadline" = "cancel"): Promise<void> {
		for (const reservation of this.reservations.values()) this.invalidateReservation(reservation, reason);
		const operations = [...this.operations.values()];
		await Promise.all(operations.map(async (operation) => {
			await this.convergeInvalidation(operation.supervisor, reason, operation.request.operationId);
			const factError = this.publishRecord(operation.supervisor);
			if (factError !== undefined) throw factError;
		}));
	}

	async dispose(): Promise<void> {
		if (this.disposeCompletion !== undefined) return this.disposeCompletion;
		this.disposed = true;
		for (const reservation of this.reservations.values()) this.invalidateReservation(reservation, "shutdown");
		const reservations = [...this.reservations.values()].map((reservation) => reservation.settled);
		this.disposeCompletion = (async () => {
			let failure: FoundationError | undefined;
			try {
				await this.terminateAll("shutdown");
			} catch {
				failure = providerError("worker_persistence_failed", "Operation Worker shutdown persistence failed");
			}
			await Promise.all(reservations);
			try {
				this.operations.clear();
				this.reservations.clear();
				this.operationPayloads.clear();
				this.factSubscribers.clear();
			} finally {
				this.durableFactOwner = undefined;
				this.durableFactSink = undefined;
			}
			if (failure !== undefined) throw failure;
		})();
		return this.disposeCompletion;
	}

	private validatePreflight(
		request: SandboxOperationRequestV1,
		correlation: ExecutionCorrelationV1 | undefined,
		profile: WorkerSandboxProfileV1,
		facts: WorkerSandboxPreflightFactsV1,
	): FoundationError | undefined {
		if (!facts.runAccepted) return providerError("worker_unavailable", "Operation Worker requires an accepted Run");
		if (!facts.sessionOwned || !facts.laneOwned || !correlationMatchesBinding(correlation, facts.binding, request, this.providerId)) {
			return providerError("worker_binding_invalid", "Operation Worker session or lane identity is invalid");
		}
		if (!facts.bindingAuthorized || !requestMatchesBinding(request, facts.binding)) {
			return providerError("worker_binding_invalid", "Operation Worker binding identity is invalid");
		}
		if (!facts.policyAuthorized) return providerError("worker_unavailable", "Operation Worker policy preflight failed");
		if (!facts.sandboxAuthorized) return providerError("sandbox_capability_insufficient", "Operation Worker sandbox preflight failed");
		if (!facts.credentialLeaseActive) return providerError("task_credential_target_unavailable", "Operation Worker credential lease preflight failed");
		if (
			facts.binding.providerId !== this.providerId ||
			facts.binding.profileId !== profile.profileId ||
			facts.binding.profileRevision !== profile.profileRevision ||
			facts.binding.requestFingerprint !== createWorkerRequestFingerprintV1(request) ||
			!sameStringSet(facts.binding.capabilitySummary, profile.supervisor.capabilities)
		) {
			return providerError("worker_binding_invalid", "Operation Worker profile or request identity is invalid");
		}
		return undefined;
	}

	private reservationError(reservation: WorkerOperationReservationV1): FoundationError | undefined {
		if (this.disposed && reservation.invalidated === undefined) this.invalidateReservation(reservation, "shutdown");
		if (reservation.invalidated === undefined) return undefined;
		return reservation.invalidated === "deadline"
			? providerError("worker_deadline_exceeded", "Operation Worker deadline elapsed before execution")
			: providerError("worker_cancel_failed", "Operation Worker was invalidated before execution");
	}

	private invalidateReservation(reservation: WorkerOperationReservationV1, reason: WorkerInvalidationReasonV1): void {
		if (reservation.invalidated !== undefined) return;
		reservation.invalidated = reason;
		reservation.resolveInvalidation();
	}

	private async convergeInvalidation(
		supervisor: WorkerSupervisorV1,
		reason: WorkerInvalidationReasonV1,
		operationId: string,
	): Promise<ResultValue<void, FoundationError>> {
		const status = supervisor.snapshot.record?.status;
		const converged = status === "running" || status === "cancelling"
			? reason === "cancel" || reason === "deadline"
				? await supervisor.cancel(reason, operationId)
				: await supervisor.terminate(reason === "detach" ? "detach" : "shutdown")
			: await supervisor.reclaim();
		return converged.ok ? Result.ok(undefined) : Result.err(converged.error);
	}

	private publishRecord(supervisor: WorkerSupervisorV1): FoundationError | undefined {
		const record = supervisor.snapshot.record;
		if (record === undefined) return undefined;
		const safeRecord = this.cloneRecord(record);
		const fact: WorkerSandboxFactV1 = {
			type: "record",
			record: this.cloneRecord(safeRecord),
			transitions: Object.freeze((supervisor.lifecycleState?.transitions ?? []).map((transition) => Object.freeze({ ...transition }))),
		};
		const durableError = this.persistFact(fact);
		if (durableError !== undefined) return durableError;
		this.records.delete(safeRecord.workerId);
		this.records.set(safeRecord.workerId, safeRecord);
		this.evictRetainedFacts();
		try {
			this.options.onWorkerRecord?.(this.cloneRecord(safeRecord));
		} catch {
			// Observation cannot cross the provider Result boundary.
		}
		this.publishObservationalFact(fact);
		return undefined;
	}

	private publishOperationFence(supervisor: WorkerSupervisorV1, operationId: string): FoundationError | undefined {
		const record = supervisor.snapshot.record;
		if (record === undefined) return providerError("worker_persistence_failed", "Operation Worker fence has no durable identity");
		const fact: WorkerSandboxFactV1 = Object.freeze({
			type: "operation",
			workerId: record.workerId,
			providerId: record.providerId,
			sessionId: record.sessionId,
			laneId: record.laneId,
			operationId,
			revision: record.revision,
			recordedAt: new Date().toISOString(),
		});
		const durableError = this.persistFact(fact);
		if (durableError !== undefined) return durableError;
		this.publishObservationalFact(fact);
		return undefined;
	}

	private retainReceipt(workerId: string, terminalRecordRevision: number, receipt: WorkerReceiptV1): FoundationError | undefined {
		const safeReceipt = this.cloneReceipt(receipt);
		const fact: WorkerSandboxFactV1 = {
			type: "receipt",
			workerId,
			terminalRecordRevision,
			receipt: this.cloneReceipt(safeReceipt),
		};
		const durableError = this.persistFact(fact);
		if (durableError !== undefined) return durableError;
		this.receipts.delete(safeReceipt.workerReceiptId);
		this.receipts.set(safeReceipt.workerReceiptId, safeReceipt);
		this.evictRetainedFacts();
		this.publishObservationalFact(fact);
		return undefined;
	}

	private persistFact(fact: WorkerSandboxFactV1): FoundationError | undefined {
		if (this.durableFactSink === undefined) {
			return providerError("worker_persistence_failed", "Operation Worker durable fact owner is unavailable");
		}
		try {
			this.durableFactSink(fact);
		} catch {
			return providerError("worker_persistence_failed", "Operation Worker durable fact persistence failed");
		}
		return undefined;
	}

	private publishObservationalFact(fact: WorkerSandboxFactV1): void {
		for (const subscriber of this.factSubscribers) {
			try {
				subscriber(fact);
			} catch {
				// Host sinks are observational and fail isolated.
			}
		}
	}

	private evictRetainedFacts(): void {
		const activeWorkerIds = new Set(
			[...this.operations.values()].flatMap((operation) => {
				const workerId = operation.supervisor.snapshot.record?.workerId;
				return workerId === undefined ? [] : [workerId];
			}),
		);
		while (this.records.size > this.maxRetainedRecords) {
			const candidate = [...this.records.keys()].find((workerId) => !activeWorkerIds.has(workerId));
			if (candidate === undefined) break;
			this.records.delete(candidate);
		}
		while (this.receipts.size > this.maxRetainedRecords) {
			const oldest = this.receipts.keys().next().value;
			if (oldest === undefined) break;
			this.receipts.delete(oldest);
		}
	}

	private retainCompletedOperationId(operationId: string): void {
		this.completedOperationIds.add(operationId);
	}

	private cloneRecord(record: WorkerRecordV1): WorkerRecordV1 {
		const parsed = parseWorkerRecordV1(serializeWorkerRecordV1(record));
		if (!parsed.ok) throw parsed.error;
		return parsed.value;
	}

	private cloneReceipt(receipt: WorkerReceiptV1): WorkerReceiptV1 {
		return JSON.parse(canonicalFoundationJson(receipt)) as WorkerReceiptV1;
	}
}

export const SandboxOperationWorkerProviderV1 = WorkerSandboxProviderV1;
