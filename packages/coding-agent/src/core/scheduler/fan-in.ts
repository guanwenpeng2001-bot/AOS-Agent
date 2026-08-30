/**
 * Scheduler v1 fan-in and Host TaskResult settlement.
 *
 * AttemptReceipt and predecessor TaskResult facts are read only through
 * LayeredResultSettlement. The immutable join snapshot is stored on the
 * same Session ledger before settlement, and TaskResult creation remains
 * sealed behind LayeredResultSettlement.settle. This module never writes a
 * RunReceipt or a Host/Graph terminal fact.
 */
import {
	type AcceptanceFact,
	type ArtifactRef,
	canonicalFoundationJson,
	type Fingerprint,
	FoundationError,
	fingerprintFoundationValue,
	LayeredResultSettlement,
	Result,
	type ResultProvenance,
	type ResultValidation,
	type ResultValue,
	type Session,
	SessionLedger,
	type SessionLedgerWriter,
	type TaskEnvelope,
	type TaskResult,
	type ValidationResult,
	validateAttemptReceipt,
	validateTaskEnvelope,
	validateTaskResult,
} from "../../../../agent/src/internal.ts";
import {
	parseSchedulerJoinPlan,
	type SchedulerJoinPlan,
	type SchedulerJoinPolicy,
	type SchedulerNodeRef,
} from "./host.ts";

export const SCHEDULER_JOIN_SNAPSHOT_OBJECT_TYPE = "scheduler.join_snapshot";
export const SCHEDULER_FAN_IN_HOST_PROVIDER_ID = "aos.scheduler.host";

export interface SchedulerFanInSnapshot {
	readonly schemaVersion: 1;
	readonly joinId: string;
	readonly taskId: string;
	readonly taskResultId: string;
	readonly taskFingerprint: Fingerprint;
	readonly policy: SchedulerJoinPolicy;
	readonly predecessorNodeIds: readonly string[];
	readonly predecessorTaskResultIds: readonly string[];
	readonly missingPredecessorNodeIds: readonly string[];
	readonly degradedPredecessorNodeIds: readonly string[];
	readonly sourceAttemptReceiptIds: readonly string[];
	readonly summary: string;
	readonly artifacts: readonly ArtifactRef[];
	readonly diff?: ArtifactRef;
	readonly tests: readonly ValidationResult[];
	readonly evidence: readonly AcceptanceFact[];
	readonly validation?: ResultValidation;
	readonly producer: ResultProvenance;
	readonly inputDigest: Fingerprint;
	readonly createdAt: string;
}

export interface SchedulerFanInSettleRequest {
	readonly task: TaskEnvelope;
	readonly nodeRef: SchedulerNodeRef;
	readonly currentAttemptReceiptIds: readonly string[];
	readonly plan?: SchedulerJoinPlan;
	readonly summary: string;
	readonly artifacts?: readonly ArtifactRef[];
	readonly diff?: ArtifactRef;
	readonly tests: readonly ValidationResult[];
	readonly evidence: readonly AcceptanceFact[];
	readonly validation?: ResultValidation;
}

export interface SchedulerFanInSettlement {
	readonly snapshot: SchedulerFanInSnapshot;
	readonly taskResult: TaskResult;
	readonly snapshotReplayed: boolean;
}

export interface SchedulerFanInOptions {
	readonly session: Session;
	readonly sessionId: string;
	readonly ownerId: string;
	readonly writer?: SessionLedgerWriter;
	readonly laneId?: string;
	readonly now?: () => string;
}

interface CollectedFanInV1 {
	readonly policy: SchedulerJoinPolicy;
	readonly predecessorNodeIds: readonly string[];
	readonly predecessorTaskResultIds: readonly string[];
	readonly missingPredecessorNodeIds: readonly string[];
	readonly degradedPredecessorNodeIds: readonly string[];
	readonly sourceAttemptReceiptIds: readonly string[];
	readonly artifacts: readonly ArtifactRef[];
}

function fail<T>(code: "scheduler_fanin_invalid" | "scheduler_settlement_rejected"): ResultValue<T, FoundationError> {
	return Result.err(
		new FoundationError(
			code,
			code === "scheduler_fanin_invalid"
				? "Scheduler join input is invalid."
				: "Scheduler settlement was rejected by the host gate.",
		),
	);
}

function uniqueNonEmpty(values: readonly string[]): boolean {
	return values.every((value) => value.length > 0) && new Set(values).size === values.length;
}

function artifactKey(artifact: ArtifactRef): string {
	return `${artifact.artifactId}\0${artifact.digest}`;
}

function copyArtifact(artifact: ArtifactRef): ArtifactRef {
	return {
		schemaVersion: 1,
		artifactId: artifact.artifactId,
		mediaType: artifact.mediaType,
		digest: artifact.digest,
		...(artifact.producer === undefined ? {} : { producer: artifact.producer }),
		...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
	};
}

function copyValidation(test: ValidationResult): ValidationResult {
	return {
		name: test.name,
		required: test.required,
		status: test.status,
		...(test.summary === undefined ? {} : { summary: test.summary }),
		...(test.evidenceRefs === undefined ? {} : { evidenceRefs: test.evidenceRefs.map(copyArtifact) }),
	};
}

function copyEvidence(fact: AcceptanceFact): AcceptanceFact {
	return {
		schemaVersion: 1,
		factId: fact.factId,
		...(fact.criterionId === undefined ? {} : { criterionId: fact.criterionId }),
		outcome: fact.outcome,
		...(fact.evidenceRefs === undefined ? {} : { evidenceRefs: fact.evidenceRefs.map(copyArtifact) }),
		recordedAt: fact.recordedAt,
		...(fact.recordedBy === undefined ? {} : { recordedBy: fact.recordedBy }),
	};
}

function copyResultValidation(value: ResultValidation): ResultValidation {
	return {
		schemaValid: value.schemaValid,
		artifactDigestsValid: value.artifactDigestsValid,
		acceptanceVerified: value.acceptanceVerified,
		requiredEvidencePresent: value.requiredEvidencePresent,
		...(value.notes === undefined ? {} : { notes: [...value.notes] }),
	};
}

function copyProducer(value: ResultProvenance): ResultProvenance {
	return {
		producerKind: value.producerKind,
		providerId: value.providerId,
		producedAt: value.producedAt,
		...(value.lineage === undefined ? {} : { lineage: { ...value.lineage } }),
		...(value.correlation === undefined ? {} : { correlation: { ...value.correlation } }),
	};
}

function copySnapshot(value: SchedulerFanInSnapshot): SchedulerFanInSnapshot {
	return {
		schemaVersion: 1,
		joinId: value.joinId,
		taskId: value.taskId,
		taskResultId: value.taskResultId,
		taskFingerprint: { ...value.taskFingerprint },
		policy: value.policy,
		predecessorNodeIds: [...value.predecessorNodeIds],
		predecessorTaskResultIds: [...value.predecessorTaskResultIds],
		missingPredecessorNodeIds: [...value.missingPredecessorNodeIds],
		degradedPredecessorNodeIds: [...value.degradedPredecessorNodeIds],
		sourceAttemptReceiptIds: [...value.sourceAttemptReceiptIds],
		summary: value.summary,
		artifacts: value.artifacts.map(copyArtifact),
		...(value.diff === undefined ? {} : { diff: copyArtifact(value.diff) }),
		tests: value.tests.map(copyValidation),
		evidence: value.evidence.map(copyEvidence),
		...(value.validation === undefined ? {} : { validation: copyResultValidation(value.validation) }),
		producer: copyProducer(value.producer),
		inputDigest: { ...value.inputDigest },
		createdAt: value.createdAt,
	};
}

export function schedulerNodeJoinId(nodeRef: SchedulerNodeRef): string {
	return `join_${fingerprintFoundationValue(nodeRef).value}`;
}

export function schedulerNodeTaskResultId(nodeRef: SchedulerNodeRef): string {
	return `task_result_${fingerprintFoundationValue(nodeRef).value}`;
}

function stableInput(snapshot: Omit<SchedulerFanInSnapshot, "inputDigest" | "createdAt" | "producer">): unknown {
	return {
		...snapshot,
		producerKind: "host",
		producerId: SCHEDULER_FAN_IN_HOST_PROVIDER_ID,
	};
}

export class SchedulerFanInController {
	private readonly settlement: LayeredResultSettlement;
	private readonly ledger: SessionLedger;
	private readonly sessionId: string;
	private readonly laneId: string;
	private readonly nowFn: () => string;

	constructor(options: SchedulerFanInOptions) {
		const laneId = options.laneId ?? "main";
		if (
			options.writer !== undefined &&
			(options.writer.session !== options.session ||
				options.writer.ownerId !== options.ownerId ||
				options.writer.lane !== laneId)
		) {
			throw new TypeError("Scheduler Fan-in writer must match the Session, owner, and lane");
		}
		this.settlement = new LayeredResultSettlement(options.session, {
			ownerId: options.ownerId,
			...(options.writer === undefined ? {} : { writer: options.writer }),
		});
		this.ledger = new SessionLedger(options.session, {
			ownerId: options.ownerId,
			...(options.writer === undefined ? {} : { writer: options.writer }),
			laneId: options.laneId,
		});
		this.sessionId = options.sessionId;
		this.laneId = laneId;
		this.nowFn = options.now ?? (() => new Date().toISOString());
	}

	async settle(
		request: SchedulerFanInSettleRequest,
	): Promise<ResultValue<SchedulerFanInSettlement, FoundationError>> {
		const checkedTask = validateTaskEnvelope(request.task);
		if (!checkedTask.ok) return checkedTask;
		if (request.nodeRef.taskId !== checkedTask.value.taskId || !uniqueNonEmpty(request.currentAttemptReceiptIds)) {
			return fail("scheduler_fanin_invalid");
		}
		const joinId = request.plan?.joinId ?? schedulerNodeJoinId(request.nodeRef);
		if (request.plan !== undefined) {
			const checkedPlan = parseSchedulerJoinPlan(request.plan);
			if (
				!checkedPlan.ok ||
				checkedPlan.value.taskId !== checkedTask.value.taskId ||
				checkedPlan.value.nodeRef?.nodeId !== request.nodeRef.nodeId ||
				checkedPlan.value.nodeRef?.graphRevision !== request.nodeRef.graphRevision
			) {
				return fail("scheduler_fanin_invalid");
			}
		}
		const collected = await this.collect(request);
		if (!collected.ok) return collected;
		const taskResultId = schedulerNodeTaskResultId(request.nodeRef);
		const createdAt = this.nowFn();
		const artifactsByKey = new Map(
			collected.value.artifacts.map((artifact) => [artifactKey(artifact), copyArtifact(artifact)]),
		);
		for (const artifact of request.artifacts ?? []) artifactsByKey.set(artifactKey(artifact), copyArtifact(artifact));
		const artifacts = [...artifactsByKey.values()];
		const base = {
			schemaVersion: 1 as const,
			joinId,
			taskId: checkedTask.value.taskId,
			taskResultId,
			taskFingerprint: fingerprintFoundationValue(checkedTask.value),
			policy: collected.value.policy,
			predecessorNodeIds: [...collected.value.predecessorNodeIds],
			predecessorTaskResultIds: [...collected.value.predecessorTaskResultIds],
			missingPredecessorNodeIds: [...collected.value.missingPredecessorNodeIds],
			degradedPredecessorNodeIds: [...collected.value.degradedPredecessorNodeIds],
			sourceAttemptReceiptIds: [...collected.value.sourceAttemptReceiptIds],
			summary: request.summary,
			artifacts,
			...(request.diff === undefined ? {} : { diff: copyArtifact(request.diff) }),
			tests: request.tests.map(copyValidation),
			evidence: request.evidence.map(copyEvidence),
			...(request.validation === undefined ? {} : { validation: copyResultValidation(request.validation) }),
		};
		const inputDigest = fingerprintFoundationValue(stableInput(base));
		const existing = await this.ledger.get(SCHEDULER_JOIN_SNAPSHOT_OBJECT_TYPE, joinId);
		let snapshot: SchedulerFanInSnapshot;
		let snapshotReplayed = false;
		if (existing !== undefined) {
			if (existing.kind !== "fact") return fail("scheduler_fanin_invalid");
			const stored = existing.payload as unknown as SchedulerFanInSnapshot;
			if (
				stored.schemaVersion !== 1 ||
				stored.joinId !== joinId ||
				stored.inputDigest?.value !== inputDigest.value
			) {
				return fail("scheduler_fanin_invalid");
			}
			snapshot = copySnapshot(stored);
			snapshotReplayed = true;
		} else {
			const producer: ResultProvenance = {
				producerKind: "host",
				providerId: SCHEDULER_FAN_IN_HOST_PROVIDER_ID,
				producedAt: createdAt,
				correlation: {
					sessionId: this.sessionId,
					laneId: this.laneId,
					revision: 1,
					taskId: checkedTask.value.taskId,
					taskResultId,
				},
			};
			snapshot = { ...base, producer, inputDigest, createdAt };
			try {
				const written = await this.ledger.appendFact(
					SCHEDULER_JOIN_SNAPSHOT_OBJECT_TYPE,
					joinId,
					copySnapshot(snapshot),
					{
						clientRequestId: `scheduler.join_snapshot:${joinId}`,
						expectedRevision: 0,
						correlation: { taskId: checkedTask.value.taskId, taskResultId },
					},
				);
				snapshot = copySnapshot(written.payload);
				snapshotReplayed = written.replayed;
			} catch {
				return fail("scheduler_fanin_invalid");
			}
		}
		const settled = await this.settlement.settle({
			taskResultId: snapshot.taskResultId,
			task: checkedTask.value,
			sourceAttemptReceiptIds: snapshot.sourceAttemptReceiptIds,
			summary: snapshot.summary,
			artifacts: snapshot.artifacts,
			...(snapshot.diff === undefined ? {} : { diff: snapshot.diff }),
			tests: snapshot.tests,
			evidence: snapshot.evidence,
			producer: snapshot.producer,
			...(snapshot.validation === undefined ? {} : { validation: snapshot.validation }),
		});
		if (!settled.ok) return settled;
		return Result.ok({ snapshot: copySnapshot(snapshot), taskResult: settled.value, snapshotReplayed });
	}

	async getSnapshot(joinId: string): Promise<SchedulerFanInSnapshot | undefined> {
		const stored = await this.ledger.get(SCHEDULER_JOIN_SNAPSHOT_OBJECT_TYPE, joinId);
		if (stored === undefined || stored.kind !== "fact") return undefined;
		return copySnapshot(stored.payload as unknown as SchedulerFanInSnapshot);
	}

	async release(): Promise<void> {
		await this.settlement.release();
		await this.ledger.release();
	}

	private async collect(
		request: SchedulerFanInSettleRequest,
	): Promise<ResultValue<CollectedFanInV1, FoundationError>> {
		const policy = request.plan?.policy ?? "require_all";
		const predecessorNodeIds = request.plan?.predecessorTaskIds ?? [];
		const predecessorTaskResultIds: string[] = [];
		const missingPredecessorNodeIds: string[] = [];
		const degradedPredecessorNodeIds: string[] = [];
		const selectedReceiptIds = [...request.currentAttemptReceiptIds];
		const artifacts = new Map<string, ArtifactRef>();
		for (const predecessorNodeId of predecessorNodeIds) {
			const predecessorRef: SchedulerNodeRef = {
				taskId: request.nodeRef.taskId,
				graphRevision: request.nodeRef.graphRevision,
				nodeId: predecessorNodeId,
			};
			const taskResultId = schedulerNodeTaskResultId(predecessorRef);
			const result = await this.settlement.getTaskResult(taskResultId);
			if (result === undefined) {
				missingPredecessorNodeIds.push(predecessorNodeId);
				degradedPredecessorNodeIds.push(predecessorNodeId);
				continue;
			}
			const checked = validateTaskResult(result);
			if (!checked.ok || checked.value.taskId !== request.task.taskId) {
				return fail("scheduler_fanin_invalid");
			}
			predecessorTaskResultIds.push(taskResultId);
			if (checked.value.status !== "succeeded") {
				degradedPredecessorNodeIds.push(predecessorNodeId);
				continue;
			}
			selectedReceiptIds.push(...checked.value.sourceAttemptReceiptIds);
			for (const artifact of checked.value.artifacts) artifacts.set(artifactKey(artifact), copyArtifact(artifact));
		}
		if (policy === "require_all" && (missingPredecessorNodeIds.length > 0 || degradedPredecessorNodeIds.length > 0)) {
			return fail("scheduler_settlement_rejected");
		}
		if (!uniqueNonEmpty(selectedReceiptIds)) return fail("scheduler_fanin_invalid");
		for (const receiptId of selectedReceiptIds) {
			const receipt = await this.settlement.getAttemptReceipt(receiptId);
			if (receipt === undefined) return fail("scheduler_fanin_invalid");
			const checked = validateAttemptReceipt(receipt);
			if (!checked.ok || checked.value.taskId !== request.task.taskId) {
				return fail("scheduler_fanin_invalid");
			}
			for (const artifact of checked.value.artifacts) artifacts.set(artifactKey(artifact), copyArtifact(artifact));
		}
		if (policy === "allow_partial" && selectedReceiptIds.length === 0) {
			return fail("scheduler_settlement_rejected");
		}
		return Result.ok({
			policy,
			predecessorNodeIds: [...predecessorNodeIds],
			predecessorTaskResultIds,
			missingPredecessorNodeIds,
			degradedPredecessorNodeIds,
			sourceAttemptReceiptIds: selectedReceiptIds,
			artifacts: [...artifacts.values()],
		});
	}
}

export function schedulerFanInSnapshotsEqual(left: SchedulerFanInSnapshot, right: SchedulerFanInSnapshot): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}
