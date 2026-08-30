import { createHash } from "node:crypto";
import {
	canonicalFoundationJson,
	FoundationError,
	Result,
	validateSandboxOperationRequest,
	validateFoundationProviderCapability,
	validateWorkerReceiptForProvider,
	type ExecutionCorrelation,
	type FoundationJsonValue,
	type FoundationErrorCode,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type ResultValue,
	type SandboxOperationProvider,
	type SandboxOperationRequest,
	type WorkerReceipt,
} from "../../../../agent/src/internal.ts";
import {
	OperationWorkerSupervisor,
	type WorkerSupervisorConfig,
} from "./supervisor.ts";
import {
	validateOperationWorkerLeaseProjection,
	validateOperationWorkerLeaseReference,
	type SafeLeaseProjection,
	type SafeLeaseReference,
	type WorkerCancelReason,
} from "./protocol.ts";
import {
	parseWorkerRecord,
	serializeWorkerRecord,
	validateWorkerBinding,
	type WorkerBinding,
	type WorkerRecord,
	type WorkerTransitionReceipt,
} from "./lifecycle.ts";

export interface WorkerSandboxProfile {
	readonly profileId: string;
	readonly profileRevision: number;
	readonly trusted: true;
	readonly supervisor: WorkerSupervisorConfig;
}

/** Read-only Host authority facts resolved before a Supervisor may be created. */
export interface WorkerSandboxPreflightFacts {
	readonly binding: WorkerBinding;
	readonly runAccepted: boolean;
	readonly sessionOwned: boolean;
	readonly laneOwned: boolean;
	readonly bindingAuthorized: boolean;
	readonly policyAuthorized: boolean;
	readonly sandboxAuthorized: boolean;
	readonly credentialLeaseActive: boolean;
}

export interface WorkerSandboxProviderOptions {
	readonly providerId: string;
	/** Omission is the default inline/Host path and creates no Supervisor or child process. */
	readonly profile?: WorkerSandboxProfile;
	readonly capabilities?: readonly FoundationProviderCapability[];
	/** This callback must only read Host authority state. */
	readonly resolvePreflight: (
		request: SandboxOperationRequest,
		options: FoundationProviderExecutionOptions,
	) => WorkerSandboxPreflightFacts | Promise<WorkerSandboxPreflightFacts>;
	readonly createSupervisor?: (config: WorkerSupervisorConfig) => OperationWorkerSupervisor;
	readonly requireRegisteredPayload?: boolean;
	readonly onWorkerRecord?: (record: WorkerRecord) => void;
	readonly maxRetainedRecords?: number;
}

/** Material-free synchronous target used by TaskCredentialService. */
export interface WorkerCredentialQueueTarget {
	project(lease: SafeLeaseProjection): { readonly ok: boolean };
	renew(lease: SafeLeaseProjection): { readonly ok: boolean };
	revoke(lease: SafeLeaseReference): { readonly ok: boolean };
}

export type WorkerCredentialDetachReason = WorkerInvalidationReasonV1 | "lost" | "reclaim";

export interface WorkerCredentialDetach {
	readonly workerId: string;
	readonly runId?: string;
	readonly reason: WorkerCredentialDetachReason;
}

export type WorkerSandboxFact =
	| {
		readonly type: "record";
		readonly record: WorkerRecord;
		readonly transitions: readonly WorkerTransitionReceipt[];
		readonly transitionRecords?: readonly WorkerRecord[];
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
	| { readonly type: "receipt"; readonly workerId: string; readonly terminalRecordRevision: number; readonly receipt: WorkerReceipt };

interface ActiveWorkerOperationV1 {
	readonly request: SandboxOperationRequest;
	readonly supervisor: OperationWorkerSupervisor;
	readonly runId?: string;
}

type WorkerCredentialCommandV1 =
	| { readonly type: "project" | "renew"; readonly lease: SafeLeaseProjection }
	| { readonly type: "revoke"; readonly lease: SafeLeaseReference };

interface WorkerCredentialQueueV1 {
	readonly workerId: string;
	readonly target: WorkerCredentialQueueTarget;
	readonly commands: WorkerCredentialCommandV1[];
	supervisor?: OperationWorkerSupervisor;
	drain?: Promise<ResultValue<void, FoundationError>>;
	liveDrain?: Promise<void>;
	failure?: Promise<FoundationError | undefined>;
	accepting: boolean;
	quarantined: boolean;
	detachNotified: boolean;
}

interface StagedWorkerFactsV1 {
	readonly records: Map<string, WorkerRecord>;
	readonly receipts: Map<string, WorkerReceipt>;
	readonly completedOperationIds: Set<string>;
	readonly consumedWorkerIds: Set<string>;
}

type WorkerInvalidationReasonV1 = WorkerCancelReason | "terminal";

class WorkerCredentialTargetRegistryV1 implements ReadonlyMap<string, WorkerCredentialQueueTarget> {
	private readonly targets: Map<string, WorkerCredentialQueueTarget>;
	private readonly resolveTarget: (workerId: string) => WorkerCredentialQueueTarget | undefined;

	constructor(
		targets: Map<string, WorkerCredentialQueueTarget>,
		resolveTarget: (workerId: string) => WorkerCredentialQueueTarget | undefined,
	) {
		this.targets = targets;
		this.resolveTarget = resolveTarget;
	}

	get size(): number { return this.targets.size; }
	get(workerId: string): WorkerCredentialQueueTarget | undefined { return this.resolveTarget(workerId); }
	has(workerId: string): boolean { return this.targets.has(workerId); }
	entries(): MapIterator<[string, WorkerCredentialQueueTarget]> { return this.targets.entries(); }
	keys(): MapIterator<string> { return this.targets.keys(); }
	values(): MapIterator<WorkerCredentialQueueTarget> { return this.targets.values(); }
	[Symbol.iterator](): MapIterator<[string, WorkerCredentialQueueTarget]> { return this.targets[Symbol.iterator](); }
	forEach(
		callbackfn: (value: WorkerCredentialQueueTarget, key: string, map: ReadonlyMap<string, WorkerCredentialQueueTarget>) => void,
		thisArg?: unknown,
	): void {
		for (const [key, value] of this.targets) callbackfn.call(thisArg, value, key, this);
	}
}

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

export interface WorkerSandboxRecovery {
	readonly records?: readonly WorkerRecord[];
	readonly receipts?: readonly WorkerReceipt[];
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

function snapshotProfile(profile: WorkerSandboxProfile | undefined): WorkerSandboxProfile | undefined {
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

function sameWorkerIdentity(left: WorkerRecord, right: WorkerRecord): boolean {
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
	correlation: ExecutionCorrelation | undefined,
	binding: WorkerBinding,
	request: SandboxOperationRequest,
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

function requestMatchesBinding(request: SandboxOperationRequest, binding: WorkerBinding): boolean {
	return binding.providerId.length > 0 &&
		(request.providerId === undefined || request.providerId === binding.providerId) &&
		(request.bindingId === undefined || request.bindingId === binding.bindingId) &&
		(request.bindingEpochId === undefined || request.bindingEpochId === binding.bindingEpochId) &&
		(request.attemptId === undefined || request.attemptId === binding.attemptId) &&
		sameStrings(request.credentialTargets ?? [], binding.credentialTargetRefs) &&
		(request.deadlineAt === undefined || binding.deadlineAt !== undefined && binding.deadlineAt <= request.deadlineAt);
}

export function createWorkerRequestFingerprint(request: SandboxOperationRequest): string {
	return `sha256:${createHash("sha256").update(canonicalFoundationJson(request)).digest("hex")}`;
}

/**
 * Host-side implementation of the frozen SandboxOperationProvider contract.
 * A profile must be explicitly configured; otherwise every start fails before
 * Supervisor construction and the existing inline/Host path remains inert.
 */
export class WorkerSandboxProvider implements SandboxOperationProvider {
	readonly schemaVersion = 1 as const;
	readonly providerClass = "operation_worker" as const;
	readonly providerId: string;

	private readonly options: WorkerSandboxProviderOptions;
	private readonly declaredCapabilities: readonly FoundationProviderCapability[];
	private readonly capabilityConfigurationValid: boolean;
	private readonly maxRetainedRecords: number;
	private readonly operations = new Map<string, ActiveWorkerOperationV1>();
	private readonly reservations = new Map<string, WorkerOperationReservationV1>();
	private readonly completedOperationIds = new Set<string>();
	private readonly consumedWorkerIds = new Set<string>();
	private readonly operationPayloads = new Map<string, FoundationJsonValue>();
	private readonly records = new Map<string, WorkerRecord>();
	private readonly receipts = new Map<string, WorkerReceipt>();
	private readonly credentialQueues = new Map<string, WorkerCredentialQueueV1>();
	private readonly credentialTargets = new Map<string, WorkerCredentialQueueTarget>();
	private readonly credentialTargetRegistry: ReadonlyMap<string, WorkerCredentialQueueTarget>;
	private readonly factSubscribers = new Set<(fact: WorkerSandboxFact) => void>();
	private durableFactOwner: string | undefined;
	private durableFactSink: ((fact: WorkerSandboxFact) => void) | undefined;
	private credentialDetachOwner: string | undefined;
	private credentialDetachSink: ((detach: WorkerCredentialDetach) => void) | undefined;
	private disposed = false;
	private disposeCompletion: Promise<void> | undefined;

	constructor(options: WorkerSandboxProviderOptions) {
		const profile = snapshotProfile(options.profile);
		this.options = Object.freeze({ ...options, ...(profile === undefined ? { profile: undefined } : { profile }) });
		this.providerId = options.providerId;
		const profileCapabilityIds = profile?.supervisor.capabilities ?? [];
		this.declaredCapabilities = Object.freeze((options.capabilities ?? profileCapabilityIds.map((id) => ({ schemaVersion: 1 as const, id, version: 1 })))
			.map((capability) => Object.freeze({ ...capability })));
		const declaredIds = this.declaredCapabilities.map((capability) => capability.id);
		this.capabilityConfigurationValid =
			this.declaredCapabilities.every((capability) => validateFoundationProviderCapability(capability).ok) &&
			new Set(declaredIds).size === declaredIds.length &&
			(options.profile === undefined || sameStringSet(declaredIds, profileCapabilityIds));
		this.maxRetainedRecords = options.maxRetainedRecords ?? 256;
		if (!Number.isSafeInteger(this.maxRetainedRecords) || this.maxRetainedRecords < 1) {
			throw new RangeError("maxRetainedRecords must be a positive safe integer");
		}
		this.credentialTargetRegistry = new WorkerCredentialTargetRegistryV1(
			this.credentialTargets,
			(workerId) => this.resolveCredentialTarget(workerId),
		);
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
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

	getWorkerRecord(workerId: string): WorkerRecord | undefined {
		const record = this.records.get(workerId);
		return record === undefined ? undefined : this.cloneRecord(record);
	}

	listWorkerRecords(): readonly WorkerRecord[] {
		return [...this.records.values()].map((record) => this.cloneRecord(record));
	}

	getWorkerReceipt(workerReceiptId: string): WorkerReceipt | undefined {
		const receipt = this.receipts.get(workerReceiptId);
		return receipt === undefined ? undefined : this.cloneReceipt(receipt);
	}

	listWorkerReceipts(): readonly WorkerReceipt[] {
		return [...this.receipts.values()].map((receipt) => this.cloneReceipt(receipt));
	}

	subscribeFacts(subscriber: (fact: WorkerSandboxFact) => void): () => void {
		this.factSubscribers.add(subscriber);
		return () => this.factSubscribers.delete(subscriber);
	}

	/** Bind the single Host-owned durable writer. Its failures cross the operation boundary. */
	bindDurableFactSink(ownerId: string, sink: (fact: WorkerSandboxFact) => void): () => void {
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

	/** Bind the Host credential lifecycle owner for issuer-side detach revocation. */
	bindCredentialDetachSink(ownerId: string, sink: (detach: WorkerCredentialDetach) => void): () => void {
		if (this.disposed || ownerId.length === 0 || this.credentialDetachSink !== undefined) {
			throw providerError("service_conflict", "Operation Worker credential lifecycle owner is already bound");
		}
		this.credentialDetachOwner = ownerId;
		this.credentialDetachSink = sink;
		return () => {
			if (this.credentialDetachOwner !== ownerId || this.credentialDetachSink !== sink) return;
			this.credentialDetachOwner = undefined;
			this.credentialDetachSink = undefined;
		};
	}

	/** Dynamic safe-target registry. Reading a Worker id creates only a bounded Host queue. */
	getCredentialWorkerTargets(): ReadonlyMap<string, WorkerCredentialQueueTarget> {
		return this.credentialTargetRegistry;
	}

	/** Validate recovery atomically before a ControlPlane writes convergence facts. */
	validateWorkerFactsForRestore(recovery: WorkerSandboxRecovery): ResultValue<void, FoundationError> {
		const staged = this.stageWorkerFacts(recovery);
		return staged.ok ? Result.ok(undefined) : Result.err(staged.error);
	}

	/** Restore terminal safe summaries only; no Supervisor, process, or lease state is recreated. */
	restoreWorkerFacts(recovery: WorkerSandboxRecovery): ResultValue<void, FoundationError> {
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

	private stageWorkerFacts(recovery: WorkerSandboxRecovery): ResultValue<StagedWorkerFactsV1, FoundationError> {
		if (this.disposed) {
			return Result.err(providerError("worker_persistence_failed", "Disposed Operation Worker cannot restore durable facts"));
		}
		const stagedRecords = new Map(this.records);
		const stagedReceipts = new Map(this.receipts);
		const stagedCompletedOperationIds = new Set(this.completedOperationIds);
		const stagedConsumedWorkerIds = new Set(this.consumedWorkerIds);
		for (const recordValue of recovery.records ?? []) {
			let record: WorkerRecord;
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
					if (serializeWorkerRecord(record) !== serializeWorkerRecord(current)) {
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
			const validated = validateWorkerReceiptForProvider(receiptValue, {
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

	async reclaimWorker(workerId: string): Promise<ResultValue<WorkerRecord, FoundationError>> {
		const active = [...this.operations.values()].find((operation) => operation.supervisor.snapshot.record?.workerId === workerId);
		if (active !== undefined) {
			const activeRecord = active.supervisor.snapshot.record;
			if (
				activeRecord === undefined ||
				!["completed", "failed", "cancelled", "lost", "reclaiming", "reclaimed", "reclaim_unknown"].includes(activeRecord.status)
			) {
				return Result.err(providerError("worker_conflict", "Live Operation Worker cannot be reclaimed before execution is terminal"));
			}
			await this.detachCredentialWorker(active.supervisor, "reclaim");
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
		const transitions: readonly WorkerTransitionReceipt[] = Object.freeze([
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
		const fact: WorkerSandboxFact = {
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
		requestValue: SandboxOperationRequest,
		executionOptions: FoundationProviderExecutionOptions = {},
	): Promise<ResultValue<WorkerReceipt, FoundationError>> {
		if (this.disposed) return Result.err(providerError("worker_unavailable", "Operation Worker provider is disposed"));
		const request = validateSandboxOperationRequest(requestValue);
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
				value: snapshotFoundationJson(request.value as unknown as FoundationJsonValue) as unknown as SandboxOperationRequest,
			});
		} catch {
			this.operationPayloads.delete(request.value.operationId);
			return Result.err(providerError("foundation_schema_invalid_shape", "Operation Worker request is not canonical"));
		}
		const signal = executionOptions.signal;
		let correlationSnapshot: ExecutionCorrelation | undefined;
		try {
			correlationSnapshot = executionOptions.correlation === undefined
				? undefined
				: snapshotFoundationJson(executionOptions.correlation as unknown as FoundationJsonValue) as unknown as ExecutionCorrelation;
		} catch {
			this.operationPayloads.delete(requestSnapshot.value.operationId);
			return Result.err(providerError("invalid_correlation", "Operation Worker correlation is invalid"));
		}
		const stableExecutionOptions: FoundationProviderExecutionOptions = Object.freeze({
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
		let supervisor: OperationWorkerSupervisor | undefined;
		let cancellation: Promise<void> | undefined;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let identityConsumed = false;
		let outcome: ResultValue<WorkerReceipt, FoundationError> = Result.err(
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
			outcome = await (async (): Promise<ResultValue<WorkerReceipt, FoundationError>> => {
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
				let facts: WorkerSandboxPreflightFacts;
				try {
					const snapshot = snapshotFoundationJson(
						preflightOutcome.facts as unknown as FoundationJsonValue,
					);
					if (
						snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot) ||
						!validateWorkerBinding(snapshot.binding) ||
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
					facts = snapshot as unknown as WorkerSandboxPreflightFacts;
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
					supervisor = (this.options.createSupervisor ?? ((config) => new OperationWorkerSupervisor(config)))(profile.supervisor);
				} catch {
					return Result.err(providerError("worker_start_failed", "Operation Worker Supervisor construction failed"));
				}
				const normalizedBinding: WorkerBinding = Object.freeze({
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
				const credentialDrain = await this.drainWorkerCredentials(normalizedBinding.workerId, supervisor);
				if (!credentialDrain.ok) {
					const convergenceError = await this.failCredentialDrain(normalizedBinding.workerId, supervisor);
					return Result.err(convergenceError ?? providerError(
						"task_credential_target_unavailable",
						"Operation Worker credential projection failed",
					));
				}
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
				const receipt = validateWorkerReceiptForProvider(executed.value, {
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
				const status = supervisor.snapshot.record?.status;
				await this.detachCredentialWorker(supervisor, status === "lost" ? "lost" : "reclaim");
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

	async notifyRun(runId: string, reason: WorkerCancelReason | "terminal"): Promise<void> {
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
			const convergence = new Set<Promise<unknown>>();
			for (const queue of this.credentialQueues.values()) {
				if (queue.liveDrain !== undefined) convergence.add(queue.liveDrain);
				if (queue.failure !== undefined) convergence.add(queue.failure);
			}
			await Promise.all(convergence);
			try {
				this.operations.clear();
				this.reservations.clear();
				this.operationPayloads.clear();
				for (const queue of this.credentialQueues.values()) {
					queue.accepting = false;
					queue.commands.length = 0;
				}
				this.credentialQueues.clear();
				this.credentialTargets.clear();
				this.factSubscribers.clear();
			} finally {
				this.durableFactOwner = undefined;
				this.durableFactSink = undefined;
				this.credentialDetachOwner = undefined;
				this.credentialDetachSink = undefined;
			}
			if (failure !== undefined) throw failure;
		})();
		return this.disposeCompletion;
	}

	private resolveCredentialTarget(workerId: string): WorkerCredentialQueueTarget | undefined {
		if (this.disposed || workerId.length === 0) return undefined;
		const existing = this.credentialQueues.get(workerId);
		if (existing !== undefined) return existing.target;
		if (this.credentialQueues.size >= this.maxRetainedRecords) return undefined;
		const queue = {} as WorkerCredentialQueueV1;
		const enqueueProjection = (
			type: "project" | "renew",
			leaseValue: SafeLeaseProjection,
		): { readonly ok: boolean } => {
			if (!validateOperationWorkerLeaseProjection(leaseValue)) return Object.freeze({ ok: false });
			const lease = snapshotFoundationJson(
				leaseValue as unknown as FoundationJsonValue,
			) as unknown as SafeLeaseProjection;
			return Object.freeze({ ok: this.enqueueCredentialCommand(queue, Object.freeze({ type, lease })) });
		};
		const target: WorkerCredentialQueueTarget = Object.freeze({
			project: (lease: SafeLeaseProjection) => enqueueProjection("project", lease),
			renew: (lease: SafeLeaseProjection) => enqueueProjection("renew", lease),
			revoke: (leaseValue: SafeLeaseReference) => {
				if (!validateOperationWorkerLeaseReference(leaseValue)) return Object.freeze({ ok: false });
				const lease = snapshotFoundationJson(
					leaseValue as unknown as FoundationJsonValue,
				) as unknown as SafeLeaseReference;
				return Object.freeze({
					ok: this.enqueueCredentialCommand(queue, Object.freeze({ type: "revoke", lease })),
				});
			},
		});
		Object.assign(queue, {
			workerId,
			target,
			commands: [],
			accepting: true,
			quarantined: false,
			detachNotified: false,
		});
		this.credentialQueues.set(workerId, queue);
		this.credentialTargets.set(workerId, target);
		return target;
	}

	private enqueueCredentialCommand(queue: WorkerCredentialQueueV1, command: WorkerCredentialCommandV1): boolean {
		if (
			this.disposed || !queue.accepting || queue.quarantined ||
			queue.commands.length >= this.maxRetainedRecords
		) return false;
		queue.commands.push(command);
		if (queue.supervisor !== undefined) this.startLiveCredentialDrain(queue, queue.supervisor);
		return true;
	}

	private startLiveCredentialDrain(queue: WorkerCredentialQueueV1, supervisor: OperationWorkerSupervisor): void {
		if (queue.liveDrain !== undefined) return;
		queue.liveDrain = this.convergeLiveCredentialDrain(queue, supervisor);
	}

	private async convergeLiveCredentialDrain(
		queue: WorkerCredentialQueueV1,
		supervisor: OperationWorkerSupervisor,
	): Promise<void> {
		try {
			const drained = await this.drainWorkerCredentials(queue.workerId, supervisor);
			if (!drained.ok) await this.failCredentialDrain(queue.workerId, supervisor);
		} catch {
			await this.failCredentialDrain(queue.workerId, supervisor);
		} finally {
			queue.liveDrain = undefined;
			if (queue.accepting && queue.commands.length > 0) this.startLiveCredentialDrain(queue, supervisor);
		}
	}

	private async drainWorkerCredentials(
		workerId: string,
		supervisor: OperationWorkerSupervisor,
	): Promise<ResultValue<void, FoundationError>> {
		const queue = this.credentialQueues.get(workerId);
		if (queue === undefined) return Result.ok(undefined);
		if (queue.quarantined) {
			return Result.err(providerError("task_credential_target_unavailable", "Operation Worker credential target is quarantined"));
		}
		queue.supervisor ??= supervisor;
		if (queue.supervisor !== supervisor) {
			return Result.err(providerError("worker_conflict", "Operation Worker credential queue identity conflicts"));
		}
		if (queue.drain !== undefined) return queue.drain;
		const drain = (async (): Promise<ResultValue<void, FoundationError>> => {
			while (queue.commands.length > 0) {
				const command = queue.commands[0]!;
				const written = command.type === "project"
					? await supervisor.projectCredential(command.lease)
					: command.type === "renew"
						? await supervisor.renewCredential(command.lease)
						: await supervisor.revokeCredential(command.lease);
				if (!written.ok) return Result.err(written.error);
				queue.commands.shift();
			}
			return Result.ok(undefined);
		})();
		queue.drain = drain;
		const result = await drain;
		if (queue.drain === drain) queue.drain = undefined;
		if (result.ok && queue.commands.length > 0) return this.drainWorkerCredentials(workerId, supervisor);
		return result;
	}

	private failCredentialDrain(
		workerId: string,
		supervisor: OperationWorkerSupervisor,
	): Promise<FoundationError | undefined> {
		const queue = this.credentialQueues.get(workerId);
		if (queue === undefined) return Promise.resolve(undefined);
		queue.accepting = false;
		queue.commands.length = 0;
		queue.failure ??= (async () => {
			let convergenceError: FoundationError | undefined;
			let lostPersisted = false;
			try {
				const lost = await supervisor.failCredentialDelivery(workerId);
				if (lost.ok) lostPersisted = lost.value.status === "lost";
				else convergenceError = lost.error;
			} catch {
				convergenceError = providerError(
					"worker_persistence_failed",
					"Operation Worker credential failure convergence failed",
				);
			}
			const factError = this.publishRecord(supervisor);
			convergenceError ??= factError;
			this.publishCredentialDetach(queue, supervisor, lostPersisted && factError === undefined ? "lost" : "reclaim");
			queue.quarantined = true;
			return convergenceError;
		})();
		return queue.failure;
	}

	private async detachCredentialWorker(
		supervisor: OperationWorkerSupervisor,
		reason: WorkerCredentialDetachReason,
	): Promise<void> {
		const record = supervisor.snapshot.record;
		if (record === undefined) return;
		const queue = this.credentialQueues.get(record.workerId);
		if (queue === undefined) return;
		if (queue.liveDrain !== undefined) await queue.liveDrain;
		if (queue.detachNotified) return;
		const currentRecord = supervisor.snapshot.record;
		const canDrain = !queue.quarantined &&
			currentRecord !== undefined &&
			["ready", "running", "cancelling"].includes(currentRecord.status);
		if (canDrain) {
			this.publishCredentialDetach(queue, supervisor, reason);
			const drained = await this.drainWorkerCredentials(record.workerId, supervisor);
			if (!drained.ok) await this.failCredentialDrain(record.workerId, supervisor);
			queue.accepting = false;
			return;
		}
		queue.accepting = false;
		queue.commands.length = 0;
		this.publishCredentialDetach(queue, supervisor, reason);
	}

	private publishCredentialDetach(
		queue: WorkerCredentialQueueV1,
		supervisor: OperationWorkerSupervisor,
		reason: WorkerCredentialDetachReason,
	): void {
		if (queue.detachNotified) return;
		queue.detachNotified = true;
		const record = supervisor.snapshot.record;
		try {
			this.credentialDetachSink?.(Object.freeze({
				workerId: queue.workerId,
				...(record?.runId === undefined ? {} : { runId: record.runId }),
				reason,
			}));
		} catch {
			// Host teardown remains best effort; queue failure is already fail closed.
		}
	}

	private validatePreflight(
		request: SandboxOperationRequest,
		correlation: ExecutionCorrelation | undefined,
		profile: WorkerSandboxProfile,
		facts: WorkerSandboxPreflightFacts,
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
			facts.binding.requestFingerprint !== createWorkerRequestFingerprint(request) ||
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
		supervisor: OperationWorkerSupervisor,
		reason: WorkerInvalidationReasonV1,
		operationId: string,
	): Promise<ResultValue<void, FoundationError>> {
		await this.detachCredentialWorker(supervisor, reason);
		const status = supervisor.snapshot.record?.status;
		const converged = status === "running" || status === "cancelling"
			? reason === "cancel" || reason === "deadline"
				? await supervisor.cancel(reason, operationId)
				: await supervisor.terminate(reason === "detach" ? "detach" : "shutdown")
			: await supervisor.reclaim();
		return converged.ok ? Result.ok(undefined) : Result.err(converged.error);
	}

	private publishRecord(supervisor: OperationWorkerSupervisor): FoundationError | undefined {
		const record = supervisor.snapshot.record;
		if (record === undefined) return undefined;
		const safeRecord = this.cloneRecord(record);
		const fact: WorkerSandboxFact = {
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

	private publishOperationFence(supervisor: OperationWorkerSupervisor, operationId: string): FoundationError | undefined {
		const record = supervisor.snapshot.record;
		if (record === undefined) return providerError("worker_persistence_failed", "Operation Worker fence has no durable identity");
		const fact: WorkerSandboxFact = Object.freeze({
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

	private retainReceipt(workerId: string, terminalRecordRevision: number, receipt: WorkerReceipt): FoundationError | undefined {
		const safeReceipt = this.cloneReceipt(receipt);
		const fact: WorkerSandboxFact = {
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

	private persistFact(fact: WorkerSandboxFact): FoundationError | undefined {
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

	private publishObservationalFact(fact: WorkerSandboxFact): void {
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

	private cloneRecord(record: WorkerRecord): WorkerRecord {
		const parsed = parseWorkerRecord(serializeWorkerRecord(record));
		if (!parsed.ok) throw parsed.error;
		return parsed.value;
	}

	private cloneReceipt(receipt: WorkerReceipt): WorkerReceipt {
		return JSON.parse(canonicalFoundationJson(receipt)) as WorkerReceipt;
	}
}

export const SandboxOperationWorkerProvider = WorkerSandboxProvider;
