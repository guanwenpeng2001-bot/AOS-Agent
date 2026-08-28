import {
	type BudgetUsage,
	canonicalFoundationJson,
	type Fingerprint,
	FoundationError,
	fingerprintFoundationValue,
	type QuotaReservation,
	Result,
	type Result as ResultValue,
	type Session,
	SessionLedger,
	validateBudgetUsage,
	validateFingerprint,
	validateQuotaReservation,
} from "@aos-agent/agent-core";
import type { SchedulerProviderClassV1, SchedulerSelectionScoreV1 } from "./scheduler.ts";

const SCHEDULER_SELECTION_RESERVATIONS_OBJECT_TYPE = "scheduler_selection_reservations";
const SCHEDULER_SELECTION_RESERVATIONS_OBJECT_ID = "session";

export type SchedulerSelectionRejectionStageV1 =
	| "resume_replay"
	| "model_access"
	| "binding_tools"
	| "policy_review"
	| "credential_sandbox"
	| "capacity_quota";

export type SchedulerSelectionReservationStatusV1 = "reserved" | "settling" | "settled" | "reconcile_required";

export type SchedulerSelectionSettlementReasonV1 =
	| "succeeded"
	| "failed"
	| "rejected"
	| "cancelled"
	| "timeout"
	| "runner_throw"
	| "persistence_failure"
	| "restart_reconciled";

export interface SchedulerSelectionDecisionInputsV1 {
	readonly requireResume: boolean;
	readonly modelAccess: "none" | "agent_owned" | "aos_gateway";
	readonly bindingRequirementDigest: Fingerprint;
	readonly toolSelectionDigest: Fingerprint;
	readonly toolGatewayRequired: boolean;
	readonly policyRevisionDigest: Fingerprint;
	readonly reviewRevisionDigest?: Fingerprint;
	readonly credentialTargetRefs: readonly string[];
	readonly sandboxTargetRefs: readonly string[];
}

export interface SchedulerSelectionCandidateDecisionV1 {
	readonly providerId: string;
	readonly capabilityRevision: number;
	readonly capabilityDigest: Fingerprint;
	readonly configRevision: Fingerprint;
	readonly accepted: boolean;
	readonly rejectionStage?: SchedulerSelectionRejectionStageV1;
	readonly score?: number;
}

export interface SchedulerDurableSelectionFactV1 {
	readonly schemaVersion: 1;
	readonly queueEntryId: string;
	readonly taskId: string;
	readonly requestDigest: Fingerprint;
	readonly chosenProviderId: string;
	readonly chosenProviderClass: SchedulerProviderClassV1;
	readonly attemptId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly agentInstanceId?: string;
	readonly capabilityRevision: number;
	readonly capabilityDigest: Fingerprint;
	readonly configRevision: Fingerprint;
	readonly decisionInputs: SchedulerSelectionDecisionInputsV1;
	readonly candidateDecisions: readonly SchedulerSelectionCandidateDecisionV1[];
	readonly scores: readonly SchedulerSelectionScoreV1[];
	readonly reservationId: string;
	readonly quotaReservation?: QuotaReservation;
	readonly decidedAt: string;
	readonly digest: Fingerprint;
}

export interface SchedulerSelectionReservationRecordV1 {
	readonly schemaVersion: 1;
	readonly fact: SchedulerDurableSelectionFactV1;
	readonly status: SchedulerSelectionReservationStatusV1;
	readonly settlementReason?: SchedulerSelectionSettlementReasonV1;
	readonly usage?: BudgetUsage;
	readonly updatedAt: string;
}

export interface SchedulerSelectionReservationStoreOptionsV1 {
	readonly ownerId?: string;
	readonly laneId?: string;
	readonly now?: () => string;
	/** Bound on the current reconciliation aggregate; prior ledger revisions remain durable audit history. */
	readonly maxBacklog?: number;
}

export interface SchedulerSelectionBeginSettlementV1 {
	readonly record: SchedulerSelectionReservationRecordV1;
	readonly shouldSettleQuota: boolean;
}

interface SchedulerSelectionReservationAggregateV1 {
	readonly schemaVersion: 1;
	readonly records: readonly SchedulerSelectionReservationRecordV1[];
}

interface LoadedAggregateV1 {
	readonly aggregate: SchedulerSelectionReservationAggregateV1;
	readonly revision: number;
}

function persistenceFailure(): FoundationError {
	return new FoundationError("scheduler_persistence_failed", "Scheduler selection reservation persistence failed.");
}

function selectionConflict(): FoundationError {
	return new FoundationError("scheduler_queue_conflict", "Scheduler selection fact conflicts with the durable fact.");
}

function capacityExhausted(): FoundationError {
	return new FoundationError("scheduler_backpressure", "Scheduler executor capacity is exhausted.", {
		retryable: true,
	});
}

function invalidShape(message: string): FoundationError {
	return new FoundationError("foundation_schema_invalid_shape", message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
	return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isFingerprint(value: unknown): value is Fingerprint {
	return validateFingerprint(value).ok;
}

function hasExactKeys(
	value: Readonly<Record<string, unknown>>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const keys = Object.keys(value);
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const REJECTION_STAGES: readonly SchedulerSelectionRejectionStageV1[] = [
	"resume_replay",
	"model_access",
	"binding_tools",
	"policy_review",
	"credential_sandbox",
	"capacity_quota",
];
const SETTLEMENT_REASONS: readonly SchedulerSelectionSettlementReasonV1[] = [
	"succeeded",
	"failed",
	"rejected",
	"cancelled",
	"timeout",
	"runner_throw",
	"persistence_failure",
	"restart_reconciled",
];

function validateDecisionInputs(value: unknown): value is SchedulerSelectionDecisionInputsV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(
			value,
			[
				"requireResume",
				"modelAccess",
				"bindingRequirementDigest",
				"toolSelectionDigest",
				"toolGatewayRequired",
				"policyRevisionDigest",
				"credentialTargetRefs",
				"sandboxTargetRefs",
			],
			["reviewRevisionDigest"],
		)
	)
		return false;
	return (
		typeof value.requireResume === "boolean" &&
		["none", "agent_owned", "aos_gateway"].includes(String(value.modelAccess)) &&
		isFingerprint(value.bindingRequirementDigest) &&
		isFingerprint(value.toolSelectionDigest) &&
		typeof value.toolGatewayRequired === "boolean" &&
		isFingerprint(value.policyRevisionDigest) &&
		(value.reviewRevisionDigest === undefined || isFingerprint(value.reviewRevisionDigest)) &&
		Array.isArray(value.credentialTargetRefs) &&
		value.credentialTargetRefs.every((item) => typeof item === "string" && SAFE_REFERENCE.test(item)) &&
		Array.isArray(value.sandboxTargetRefs) &&
		value.sandboxTargetRefs.every((item) => typeof item === "string" && SAFE_REFERENCE.test(item))
	);
}

function validateCandidateDecision(value: unknown): value is SchedulerSelectionCandidateDecisionV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(
			value,
			["providerId", "capabilityRevision", "capabilityDigest", "configRevision", "accepted"],
			["rejectionStage", "score"],
		)
	)
		return false;
	if (
		!isNonEmptyString(value.providerId) ||
		!Number.isSafeInteger(value.capabilityRevision) ||
		(value.capabilityRevision as number) < 1 ||
		!isFingerprint(value.capabilityDigest) ||
		!isFingerprint(value.configRevision) ||
		typeof value.accepted !== "boolean" ||
		(value.rejectionStage !== undefined &&
			!(REJECTION_STAGES as readonly unknown[]).includes(value.rejectionStage)) ||
		(value.score !== undefined && (typeof value.score !== "number" || !Number.isFinite(value.score)))
	)
		return false;
	return value.accepted
		? value.rejectionStage === undefined && value.score !== undefined
		: value.rejectionStage !== undefined;
}

function validateScore(value: unknown): value is SchedulerSelectionScoreV1 {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["providerId", "score"]) &&
		isNonEmptyString(value.providerId) &&
		typeof value.score === "number" &&
		Number.isFinite(value.score)
	);
}

function cloneFrozen<T>(value: T): T {
	const cloned = JSON.parse(canonicalFoundationJson(value)) as T;
	return deepFreeze(cloned);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value !== null && typeof value === "object") {
		if (seen.has(value)) return value;
		seen.add(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
		Object.freeze(value);
	}
	return value;
}

function factBase(fact: SchedulerDurableSelectionFactV1): Omit<SchedulerDurableSelectionFactV1, "digest"> {
	const { digest: _digest, ...base } = fact;
	return base;
}

function validateDurableFact(value: unknown): ResultValue<SchedulerDurableSelectionFactV1, FoundationError> {
	if (!isRecord(value)) return Result.err(invalidShape("Scheduler durable selection fact must be an object."));
	if (
		!hasExactKeys(
			value,
			[
				"schemaVersion",
				"queueEntryId",
				"taskId",
				"requestDigest",
				"chosenProviderId",
				"chosenProviderClass",
				"attemptId",
				"bindingId",
				"bindingEpochId",
				"capabilityRevision",
				"capabilityDigest",
				"configRevision",
				"decisionInputs",
				"candidateDecisions",
				"scores",
				"reservationId",
				"decidedAt",
				"digest",
			],
			["agentInstanceId", "quotaReservation"],
		)
	) {
		return Result.err(invalidShape("Scheduler durable selection fact contains unsupported fields."));
	}
	const candidate = value as unknown as SchedulerDurableSelectionFactV1;
	if (
		candidate.schemaVersion !== 1 ||
		!isNonEmptyString(candidate.queueEntryId) ||
		!isNonEmptyString(candidate.taskId) ||
		!isFingerprint(candidate.requestDigest) ||
		!isNonEmptyString(candidate.chosenProviderId) ||
		!isNonEmptyString(candidate.attemptId) ||
		!isNonEmptyString(candidate.bindingId) ||
		!isNonEmptyString(candidate.bindingEpochId) ||
		(candidate.agentInstanceId !== undefined && !isNonEmptyString(candidate.agentInstanceId)) ||
		!["scheduler", "task_executor", "agent", "external_connector"].includes(candidate.chosenProviderClass) ||
		!Number.isSafeInteger(candidate.capabilityRevision) ||
		candidate.capabilityRevision < 1 ||
		!isFingerprint(candidate.capabilityDigest) ||
		!isFingerprint(candidate.configRevision) ||
		!isNonEmptyString(candidate.reservationId) ||
		!isTimestamp(candidate.decidedAt) ||
		!isFingerprint(candidate.digest) ||
		!Array.isArray(candidate.candidateDecisions) ||
		!candidate.candidateDecisions.every(validateCandidateDecision) ||
		!Array.isArray(candidate.scores) ||
		!candidate.scores.every(validateScore) ||
		!validateDecisionInputs(candidate.decisionInputs)
	) {
		return Result.err(invalidShape("Scheduler durable selection fact has an invalid shape."));
	}
	if (candidate.quotaReservation !== undefined) {
		const checkedQuota = validateQuotaReservation(candidate.quotaReservation);
		if (!checkedQuota.ok) return checkedQuota;
		if (
			checkedQuota.value.attribution.taskId !== candidate.taskId ||
			checkedQuota.value.attribution.attemptId !== candidate.attemptId ||
			checkedQuota.value.attribution.providerId !== candidate.chosenProviderId
		) {
			return Result.err(invalidShape("Scheduler quota reservation does not match its immutable selection."));
		}
	}
	const expectedReservationId = `scheduler_reservation_${
		fingerprintFoundationValue({
			queueEntryId: candidate.queueEntryId,
			requestDigest: candidate.requestDigest,
			providerId: candidate.chosenProviderId,
			attemptId: candidate.attemptId,
		}).value
	}`;
	const chosenDecision = candidate.candidateDecisions.find(
		(decision) => decision.providerId === candidate.chosenProviderId,
	);
	if (
		candidate.reservationId !== expectedReservationId ||
		chosenDecision?.accepted !== true ||
		chosenDecision.capabilityRevision !== candidate.capabilityRevision ||
		chosenDecision.capabilityDigest.value !== candidate.capabilityDigest.value ||
		chosenDecision.configRevision.value !== candidate.configRevision.value ||
		!candidate.scores.some((score) => score.providerId === candidate.chosenProviderId) ||
		new Set(candidate.candidateDecisions.map((decision) => decision.providerId)).size !==
			candidate.candidateDecisions.length ||
		new Set(candidate.scores.map((score) => score.providerId)).size !== candidate.scores.length
	) {
		return Result.err(invalidShape("Scheduler durable selection fact identities are inconsistent."));
	}
	const expectedDigest = fingerprintFoundationValue(factBase(candidate));
	if (expectedDigest.value !== candidate.digest.value) {
		return Result.err(invalidShape("Scheduler durable selection fact digest does not match its immutable fields."));
	}
	return Result.ok(cloneFrozen(candidate));
}

function validateReservationRecord(
	value: unknown,
): ResultValue<SchedulerSelectionReservationRecordV1, FoundationError> {
	if (!isRecord(value)) return Result.err(invalidShape("Scheduler selection reservation must be an object."));
	if (!hasExactKeys(value, ["schemaVersion", "fact", "status", "updatedAt"], ["settlementReason", "usage"])) {
		return Result.err(invalidShape("Scheduler selection reservation contains unsupported fields."));
	}
	const candidate = value as unknown as SchedulerSelectionReservationRecordV1;
	if (
		candidate.schemaVersion !== 1 ||
		!["reserved", "settling", "settled", "reconcile_required"].includes(candidate.status) ||
		!isTimestamp(candidate.updatedAt)
	) {
		return Result.err(invalidShape("Scheduler selection reservation has an invalid shape."));
	}
	const fact = validateDurableFact(candidate.fact);
	if (!fact.ok) return fact;
	if (candidate.usage !== undefined) {
		const usage = validateBudgetUsage(candidate.usage);
		if (!usage.ok) return usage;
	}
	if (
		candidate.settlementReason !== undefined &&
		!(SETTLEMENT_REASONS as readonly unknown[]).includes(candidate.settlementReason)
	) {
		return Result.err(invalidShape("Scheduler selection reservation has an invalid settlement reason."));
	}
	if (candidate.status === "reserved" && (candidate.settlementReason !== undefined || candidate.usage !== undefined)) {
		return Result.err(invalidShape("A reserved Scheduler selection cannot have settlement fields."));
	}
	if (candidate.status !== "reserved" && (candidate.settlementReason === undefined || candidate.usage === undefined)) {
		return Result.err(invalidShape("A settling or terminal Scheduler selection requires settlement fields."));
	}
	return Result.ok(cloneFrozen({ ...candidate, fact: fact.value }));
}

function validateAggregate(value: unknown): ResultValue<SchedulerSelectionReservationAggregateV1, FoundationError> {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schemaVersion", "records"]) ||
		value.schemaVersion !== 1 ||
		!Array.isArray(value.records)
	) {
		return Result.err(invalidShape("Scheduler selection reservation aggregate has an invalid shape."));
	}
	const records: SchedulerSelectionReservationRecordV1[] = [];
	const queueEntryIds = new Set<string>();
	for (const valueRecord of value.records) {
		const record = validateReservationRecord(valueRecord);
		if (!record.ok) return record;
		if (queueEntryIds.has(record.value.fact.queueEntryId)) {
			return Result.err(invalidShape("Scheduler selection reservation aggregate contains duplicate queue entries."));
		}
		queueEntryIds.add(record.value.fact.queueEntryId);
		records.push(record.value);
	}
	if (
		records.some((record, index) => index > 0 && records[index - 1]!.fact.queueEntryId >= record.fact.queueEntryId)
	) {
		return Result.err(invalidShape("Scheduler selection reservation aggregate is not canonical."));
	}
	return Result.ok(deepFreeze({ schemaVersion: 1, records }));
}

function replaceRecord(
	aggregate: SchedulerSelectionReservationAggregateV1,
	record: SchedulerSelectionReservationRecordV1,
): SchedulerSelectionReservationAggregateV1 {
	const records = aggregate.records
		.filter((item) => item.fact.queueEntryId !== record.fact.queueEntryId)
		.concat(record)
		.sort((left, right) => left.fact.queueEntryId.localeCompare(right.fact.queueEntryId));
	return deepFreeze({ schemaVersion: 1, records });
}

/**
 * Session-backed owner for immutable selection facts and their mutable
 * reservation lifecycle. One CAS-protected aggregate makes choosing a slot
 * and reserving `maxConcurrency` one durable operation across queue entries.
 */
export class SchedulerSelectionReservationStore {
	private readonly ledger: SessionLedger;
	private readonly now: () => string;
	private readonly maxBacklog: number;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(session: Session, options: SchedulerSelectionReservationStoreOptionsV1 = {}) {
		this.ledger = new SessionLedger(session, {
			...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
			...(options.laneId === undefined ? {} : { laneId: options.laneId }),
		});
		this.now = options.now ?? (() => new Date().toISOString());
		this.maxBacklog = options.maxBacklog ?? Number.MAX_SAFE_INTEGER;
		if (!Number.isSafeInteger(this.maxBacklog) || this.maxBacklog < 1) {
			throw new RangeError("Scheduler selection maxBacklog must be a positive safe integer");
		}
	}

	async list(): Promise<ResultValue<readonly SchedulerSelectionReservationRecordV1[], FoundationError>> {
		try {
			const loaded = await this.load();
			if (!loaded.ok) return loaded;
			return Result.ok(loaded.value.aggregate.records.map((record) => cloneFrozen(record)));
		} catch {
			return Result.err(persistenceFailure());
		}
	}

	async get(
		queueEntryId: string,
	): Promise<ResultValue<SchedulerSelectionReservationRecordV1 | undefined, FoundationError>> {
		const listed = await this.list();
		if (!listed.ok) return listed;
		return Result.ok(listed.value.find((record) => record.fact.queueEntryId === queueEntryId));
	}

	async activeCounts(): Promise<ResultValue<ReadonlyMap<string, number>, FoundationError>> {
		const listed = await this.list();
		if (!listed.ok) return listed;
		const counts = new Map<string, number>();
		for (const record of listed.value) {
			if (record.status !== "reserved") continue;
			const providerId = record.fact.chosenProviderId;
			counts.set(providerId, (counts.get(providerId) ?? 0) + 1);
		}
		return Result.ok(counts);
	}

	async reserve(
		fact: SchedulerDurableSelectionFactV1,
		maxConcurrency: number,
	): Promise<ResultValue<SchedulerSelectionReservationRecordV1, FoundationError>> {
		return this.mutate(async () => {
			const checkedFact = validateDurableFact(fact);
			if (!checkedFact.ok) return checkedFact;
			if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
				return Result.err(invalidShape("Scheduler executor maxConcurrency must be a positive integer."));
			}
			const loaded = await this.load();
			if (!loaded.ok) return loaded;
			const existing = loaded.value.aggregate.records.find(
				(record) => record.fact.queueEntryId === checkedFact.value.queueEntryId,
			);
			if (existing !== undefined) {
				return canonicalFoundationJson(existing.fact) === canonicalFoundationJson(checkedFact.value)
					? Result.ok(existing)
					: Result.err(selectionConflict());
			}
			const retained = this.retainBoundedBacklog(loaded.value.aggregate);
			if (retained.records.length >= this.maxBacklog) {
				return Result.err(
					new FoundationError("scheduler_backpressure", "Scheduler selection backlog is full.", {
						retryable: true,
					}),
				);
			}
			const active = retained.records.filter(
				(record) =>
					record.status === "reserved" && record.fact.chosenProviderId === checkedFact.value.chosenProviderId,
			).length;
			if (active >= maxConcurrency) return Result.err(capacityExhausted());
			const record = deepFreeze({
				schemaVersion: 1 as const,
				fact: checkedFact.value,
				status: "reserved" as const,
				updatedAt: this.now(),
			});
			const persisted = await this.persist(
				loaded.value,
				replaceRecord(retained, record),
				checkedFact.value.taskId,
				`reserve:${checkedFact.value.reservationId}`,
			);
			return persisted.ok ? Result.ok(record) : persisted;
		});
	}

	private retainBoundedBacklog(
		aggregate: SchedulerSelectionReservationAggregateV1,
	): SchedulerSelectionReservationAggregateV1 {
		if (aggregate.records.length < this.maxBacklog) return aggregate;
		const removable = aggregate.records
			.filter((record) => record.status === "settled")
			.sort((left, right) =>
				left.updatedAt.localeCompare(right.updatedAt) ||
				left.fact.queueEntryId.localeCompare(right.fact.queueEntryId),
			);
		const removeCount = Math.min(
			removable.length,
			aggregate.records.length - this.maxBacklog + 1,
		);
		if (removeCount === 0) return aggregate;
		const removed = new Set(removable.slice(0, removeCount).map((record) => record.fact.queueEntryId));
		return deepFreeze({
			schemaVersion: 1,
			records: aggregate.records.filter((record) => !removed.has(record.fact.queueEntryId)),
		});
	}

	async beginSettlement(
		queueEntryId: string,
		reason: SchedulerSelectionSettlementReasonV1,
		usage: BudgetUsage = {},
	): Promise<ResultValue<SchedulerSelectionBeginSettlementV1, FoundationError>> {
		return this.mutate<SchedulerSelectionBeginSettlementV1>(async () => {
			const checkedUsage = validateBudgetUsage(usage);
			if (!checkedUsage.ok) return checkedUsage;
			const loaded = await this.load();
			if (!loaded.ok) return loaded;
			const existing = loaded.value.aggregate.records.find((record) => record.fact.queueEntryId === queueEntryId);
			if (existing === undefined) {
				return Result.err(
					new FoundationError("scheduler_not_found", "Scheduler selection reservation was not found."),
				);
			}
			if (existing.status !== "reserved") {
				return Result.ok({ record: existing, shouldSettleQuota: false });
			}
			const record = deepFreeze({
				...existing,
				status: "settling" as const,
				settlementReason: reason,
				usage: checkedUsage.value,
				updatedAt: this.now(),
			});
			const persisted = await this.persist(
				loaded.value,
				replaceRecord(loaded.value.aggregate, record),
				existing.fact.taskId,
				`settling:${existing.fact.reservationId}:${reason}`,
			);
			return persisted.ok
				? Result.ok({ record, shouldSettleQuota: existing.fact.quotaReservation !== undefined })
				: persisted;
		});
	}

	async resumeSettlement(
		queueEntryId: string,
	): Promise<ResultValue<SchedulerSelectionBeginSettlementV1, FoundationError>> {
		return this.mutate<SchedulerSelectionBeginSettlementV1>(async () => {
			const loaded = await this.load();
			if (!loaded.ok) return loaded;
			const existing = loaded.value.aggregate.records.find(
				(record) => record.fact.queueEntryId === queueEntryId,
			);
			if (existing === undefined) {
				return Result.err(new FoundationError("scheduler_not_found", "Scheduler selection reservation was not found."));
			}
			if (existing.status === "settled") {
				return Result.ok({ record: existing, shouldSettleQuota: false });
			}
			if (existing.status !== "reconcile_required") {
				return Result.err(selectionConflict());
			}
			const record = deepFreeze({
				...existing,
				status: "settling" as const,
				updatedAt: this.now(),
			});
			const persisted = await this.persist(
				loaded.value,
				replaceRecord(loaded.value.aggregate, record),
				existing.fact.taskId,
				`resume-settlement:${existing.fact.reservationId}`,
			);
			return persisted.ok
				? Result.ok({ record, shouldSettleQuota: existing.fact.quotaReservation !== undefined })
				: persisted;
		});
	}

	async finishSettlement(
		queueEntryId: string,
		settled: boolean,
	): Promise<ResultValue<SchedulerSelectionReservationRecordV1, FoundationError>> {
		return this.mutate(async () => {
			const loaded = await this.load();
			if (!loaded.ok) return loaded;
			const existing = loaded.value.aggregate.records.find((record) => record.fact.queueEntryId === queueEntryId);
			if (existing === undefined) {
				return Result.err(
					new FoundationError("scheduler_not_found", "Scheduler selection reservation was not found."),
				);
			}
			if (existing.status === "settled" || existing.status === "reconcile_required") return Result.ok(existing);
			if (existing.status !== "settling") {
				return Result.err(selectionConflict());
			}
			const record = deepFreeze({
				...existing,
				status: settled ? ("settled" as const) : ("reconcile_required" as const),
				updatedAt: this.now(),
			});
			const persisted = await this.persist(
				loaded.value,
				replaceRecord(loaded.value.aggregate, record),
				existing.fact.taskId,
				`${record.status}:${existing.fact.reservationId}`,
			);
			return persisted.ok ? Result.ok(record) : persisted;
		});
	}

	async markInterruptedSettlementsForReconciliation(): Promise<ResultValue<void, FoundationError>> {
		return this.mutate(async () => {
			const loaded = await this.load();
			if (!loaded.ok) return loaded;
			let aggregate = loaded.value.aggregate;
			let changed = false;
			for (const existing of aggregate.records) {
				if (existing.status !== "settling") continue;
				changed = true;
				aggregate = replaceRecord(
					aggregate,
					deepFreeze({
						...existing,
						status: "reconcile_required" as const,
						updatedAt: this.now(),
					}),
				);
			}
			if (!changed) return Result.ok(undefined);
			return this.persist(loaded.value, aggregate, "scheduler", "restart:interrupted-settlements");
		});
	}

	async release(): Promise<void> {
		await this.ledger.release();
	}

	private async mutate<T>(
		operation: () => Promise<ResultValue<T, FoundationError>>,
	): Promise<ResultValue<T, FoundationError>> {
		const current = this.mutationTail.then(operation, operation);
		this.mutationTail = current.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await current;
		} catch {
			return Result.err(persistenceFailure());
		}
	}

	private async load(): Promise<ResultValue<LoadedAggregateV1, FoundationError>> {
		try {
			const found = await this.ledger.getFact<unknown>(
				SCHEDULER_SELECTION_RESERVATIONS_OBJECT_TYPE,
				SCHEDULER_SELECTION_RESERVATIONS_OBJECT_ID,
			);
			if (found === undefined) {
				return Result.ok({ aggregate: deepFreeze({ schemaVersion: 1, records: [] }), revision: 0 });
			}
			const aggregate = validateAggregate(found.payload);
			if (!aggregate.ok) return aggregate;
			return Result.ok({ aggregate: aggregate.value, revision: found.record.revision });
		} catch {
			return Result.err(persistenceFailure());
		}
	}

	private async persist(
		loaded: LoadedAggregateV1,
		aggregate: SchedulerSelectionReservationAggregateV1,
		taskId: string,
		operationId: string,
	): Promise<ResultValue<void, FoundationError>> {
		const clientRequestId = `scheduler-selection-${
			fingerprintFoundationValue({
				operationId,
				expectedRevision: loaded.revision,
				aggregate,
			}).value
		}`;
		try {
			await this.ledger.appendFact(
				SCHEDULER_SELECTION_RESERVATIONS_OBJECT_TYPE,
				SCHEDULER_SELECTION_RESERVATIONS_OBJECT_ID,
				aggregate,
				{
					clientRequestId,
					expectedRevision: loaded.revision,
					correlation: { revision: 1, taskId },
				},
			);
			return Result.ok(undefined);
		} catch {
			try {
				const current = await this.ledger.getFact<unknown>(
					SCHEDULER_SELECTION_RESERVATIONS_OBJECT_TYPE,
					SCHEDULER_SELECTION_RESERVATIONS_OBJECT_ID,
				);
				if (
					current !== undefined &&
					canonicalFoundationJson(current.payload) === canonicalFoundationJson(aggregate)
				) {
					return Result.ok(undefined);
				}
			} catch {
				return Result.err(persistenceFailure());
			}
			return Result.err(persistenceFailure());
		}
	}
}

export function createSchedulerDurableSelectionFactV1(
	input: Omit<SchedulerDurableSelectionFactV1, "digest">,
): ResultValue<SchedulerDurableSelectionFactV1, FoundationError> {
	const fact = deepFreeze({ ...input, digest: fingerprintFoundationValue(input) });
	return validateDurableFact(fact);
}
