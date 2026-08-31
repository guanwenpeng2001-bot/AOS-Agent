import {
	ArtifactRefSchema,
	canonicalFoundationJson,
	cloneDeepFrozen,
	type ArtifactRef,
	type ArtifactStoreProvider,
	type AttemptReceipt,
	FingerprintSchema,
	fingerprintFoundationValue,
	FoundationError,
	type FoundationJsonValue,
	type LayeredResultSettlement,
	Result,
	type ResultValue,
	type ResultProvenance,
	type SessionLedger,
	type SettleTaskResultInput,
	type TaskEnvelope,
	type TaskResult,
	validateArtifactRef,
	validateAttemptReceipt,
	validateExactShape,
	validateTaskResult,
} from "@aos-agent/agent-core";
import { type Static, Type } from "typebox";

const MAX_SUMMARY_BYTES = 16_384;
const MAX_ARTIFACTS = 100;
const TRUNCATION_MARKER = "\n[TRUNCATED]";
const RESULT_PROJECTION_OBJECT_TYPE = "subagent_result_projection";

export const SafeChildResultProjectionV1Schema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		childAgentInstanceId: Type.String({ minLength: 1 }),
		attemptReceiptId: Type.String({ minLength: 1 }),
		taskResultId: Type.Optional(Type.String({ minLength: 1 })),
		summary: Type.String(),
		artifacts: Type.Array(ArtifactRefSchema, { maxItems: MAX_ARTIFACTS }),
		trust: Type.Literal("untrusted_child_output"),
		digest: FingerprintSchema,
		producedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export type SafeChildResultProjection = Omit<Static<typeof SafeChildResultProjectionV1Schema>, "artifacts"> & {
	readonly artifacts: readonly ArtifactRef[];
};

const ChildResultTransportInputV1Schema = Type.Union([
	Type.Object(
		{
			schemaVersion: Type.Literal(1),
			type: Type.Literal("attempt_receipt"),
			childAgentInstanceId: Type.String({ minLength: 1 }),
			taskId: Type.String({ minLength: 1 }),
			receipt: Type.Unknown(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			schemaVersion: Type.Literal(1),
			type: Type.Literal("task_result"),
			childAgentInstanceId: Type.String({ minLength: 1 }),
			taskId: Type.String({ minLength: 1 }),
			taskResult: Type.Unknown(),
			sourceReceipts: Type.Array(Type.Unknown(), { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
]);

export type ChildResultTransportInput = Static<typeof ChildResultTransportInputV1Schema>;

export interface ChildResultTransportHost {
	readonly artifactStore: ArtifactStoreProvider;
	readonly ledger: SessionLedger;
	readonly sessionId: string;
	readonly childLaneId: string;
	readonly parentLaneId: string;
	readonly now?: () => number;
}

interface ValidatedChildResult {
	readonly childAgentInstanceId: string;
	readonly taskId: string;
	readonly receipt: AttemptReceipt;
	readonly taskResultId?: string;
	readonly taskResult?: TaskResult;
	readonly sourceReceipts: readonly AttemptReceipt[];
	readonly summary: string;
	readonly artifacts: readonly ArtifactRef[];
}

function untrusted(message: string, cause?: FoundationError): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError("subagent_result_untrusted", message, cause === undefined ? undefined : { cause }));
}

function canonicalTimestamp(now: () => number): ResultValue<string, FoundationError> {
	const milliseconds = now();
	if (!Number.isFinite(milliseconds)) return untrusted("Child result time is invalid");
	try {
		const timestamp = new Date(milliseconds).toISOString();
		return new Date(timestamp).toISOString() === timestamp ? Result.ok(timestamp) : untrusted("Child result time is not canonical");
	} catch {
		return untrusted("Child result time is outside the supported range");
	}
}

function truncateSummary(summary: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(summary).byteLength <= MAX_SUMMARY_BYTES) return summary;
	const available = MAX_SUMMARY_BYTES - encoder.encode(TRUNCATION_MARKER).byteLength;
	let low = 0;
	let high = summary.length;
	while (low < high) {
		const midpoint = Math.ceil((low + high) / 2);
		if (encoder.encode(summary.slice(0, midpoint)).byteLength <= available) low = midpoint;
		else high = midpoint - 1;
	}
	let prefix = summary.slice(0, low);
	const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
	if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
	return `${prefix}${TRUNCATION_MARKER}`;
}

function validateAgentReceipt(value: unknown): ResultValue<AttemptReceipt, FoundationError> {
	const checked = validateAttemptReceipt(value, { providerClass: "agent" });
	if (!checked.ok) return untrusted("Child source is not an exact agent_executor AttemptReceipt", checked.error);
	if (checked.value.provenance.producerKind !== "agent_executor" || checked.value.agentInstanceId === undefined) {
		return untrusted("Child source must be produced by an agent_executor");
	}
	return Result.ok(checked.value);
}

function validateTransportInput(value: unknown): ResultValue<ValidatedChildResult, FoundationError> {
	const input = validateExactShape<ChildResultTransportInput>(ChildResultTransportInputV1Schema, value, "child_result_transport_input");
	if (!input.ok) return untrusted("Child result transport input has an invalid exact shape", input.error);
	if (input.value.type === "attempt_receipt") {
		const receipt = validateAgentReceipt(input.value.receipt);
		if (!receipt.ok) return receipt;
		if (receipt.value.taskId !== input.value.taskId || receipt.value.agentInstanceId !== input.value.childAgentInstanceId) {
			return untrusted("Child AttemptReceipt does not match its task and child identity");
		}
		return Result.ok({
			childAgentInstanceId: input.value.childAgentInstanceId,
			taskId: input.value.taskId,
			receipt: receipt.value,
			sourceReceipts: [receipt.value],
			summary: `Child attempt finished with status: ${receipt.value.status}${receipt.value.error === undefined ? "" : `. Error: ${receipt.value.error.message}`}`,
			artifacts: receipt.value.artifacts,
		});
	}

	const taskResult = validateTaskResult(input.value.taskResult);
	if (!taskResult.ok) return untrusted("Child TaskResult has an invalid exact shape or correlation", taskResult.error);
	if (taskResult.value.taskId !== input.value.taskId) return untrusted("Child TaskResult does not match its task identity");
	if (new Set(taskResult.value.sourceAttemptReceiptIds).size !== taskResult.value.sourceAttemptReceiptIds.length) {
		return untrusted("Child TaskResult repeats a source AttemptReceipt");
	}
	const receiptsById = new Map<string, AttemptReceipt>();
	for (const candidate of input.value.sourceReceipts) {
		const receipt = validateAgentReceipt(candidate);
		if (!receipt.ok) return receipt;
		if (receipt.value.taskId !== input.value.taskId || receipt.value.agentInstanceId !== input.value.childAgentInstanceId) {
			return untrusted("Child TaskResult source does not match its task and child identity");
		}
		if (receiptsById.has(receipt.value.attemptReceiptId)) return untrusted("Child TaskResult repeats a supplied source AttemptReceipt");
		receiptsById.set(receipt.value.attemptReceiptId, receipt.value);
	}
	if (receiptsById.size !== taskResult.value.sourceAttemptReceiptIds.length) {
		return untrusted("Child TaskResult does not match its complete source receipt set");
	}
	const receipts: AttemptReceipt[] = [];
	for (const id of taskResult.value.sourceAttemptReceiptIds) {
		const receipt = receiptsById.get(id);
		if (receipt === undefined) return untrusted("Child TaskResult does not match its declared source receipt order");
		receipts.push(receipt);
	}
	return Result.ok({
		childAgentInstanceId: input.value.childAgentInstanceId,
		taskId: input.value.taskId,
		receipt: receipts[0]!,
		taskResultId: taskResult.value.taskResultId,
		taskResult: taskResult.value,
		sourceReceipts: receipts,
		summary: taskResult.value.summary,
		artifacts: taskResult.value.artifacts,
	});
}

async function verifyDurableSources(
	host: ChildResultTransportHost,
	value: ValidatedChildResult,
): Promise<ResultValue<void, FoundationError>> {
	for (const receipt of value.sourceReceipts) {
		const correlation = receipt.provenance.correlation;
		if (
			correlation === undefined ||
			correlation.sessionId !== host.sessionId ||
			correlation.laneId !== host.childLaneId ||
			correlation.taskId !== value.taskId ||
			correlation.dispatchId !== receipt.dispatchId ||
			correlation.attemptId !== receipt.attemptId ||
			correlation.agentInstanceId !== value.childAgentInstanceId
		) return untrusted("Child AttemptReceipt provenance does not match its child Session lane and execution identity");
		const stored = await host.ledger.get("attempt_receipt", receipt.attemptReceiptId);
		if (
			stored === undefined ||
			stored.kind !== "fact" ||
			stored.objectType !== "attempt_receipt" ||
			stored.objectId !== receipt.attemptReceiptId ||
			stored.lane !== host.childLaneId ||
			stored.revision !== 1 ||
			stored.correlation.sessionId !== host.sessionId ||
			stored.correlation.laneId !== host.childLaneId ||
			stored.correlation.taskId !== value.taskId ||
			stored.correlation.dispatchId !== receipt.dispatchId ||
			stored.correlation.attemptId !== receipt.attemptId ||
			stored.correlation.agentInstanceId !== value.childAgentInstanceId ||
			canonicalFoundationJson(stored.payload) !== canonicalFoundationJson(receipt)
		) return untrusted("Child AttemptReceipt does not match its immutable durable source fact");
	}
	if (value.taskResult === undefined) return Result.ok(undefined);
	const resultCorrelation = value.taskResult.provenance.correlation;
	if (
		value.taskResult.provenance.producerKind !== "host" ||
		resultCorrelation === undefined ||
		resultCorrelation.sessionId !== host.sessionId ||
		resultCorrelation.laneId !== host.parentLaneId ||
		resultCorrelation.taskId !== value.taskId ||
		resultCorrelation.taskResultId !== value.taskResult.taskResultId ||
		resultCorrelation.attemptReceiptId !== value.taskResult.sourceAttemptReceiptIds[0]
	) return untrusted("Child TaskResult provenance does not match the parent Host Session lane and declared first source");
	const stored = await host.ledger.get("task_result", value.taskResult.taskResultId);
	if (
		stored === undefined ||
		stored.kind !== "fact" ||
		stored.objectType !== "task_result" ||
		stored.objectId !== value.taskResult.taskResultId ||
		stored.lane !== host.parentLaneId ||
		stored.revision !== 1 ||
		stored.correlation.sessionId !== host.sessionId ||
		stored.correlation.laneId !== host.parentLaneId ||
		stored.correlation.taskId !== value.taskId ||
		stored.correlation.taskResultId !== value.taskResult.taskResultId ||
		stored.correlation.attemptReceiptId !== value.taskResult.sourceAttemptReceiptIds[0] ||
		canonicalFoundationJson(stored.payload) !== canonicalFoundationJson(value.taskResult)
	) return untrusted("Child TaskResult does not match its immutable durable source fact");
	return Result.ok(undefined);
}

async function verifyArtifacts(
	artifactStore: ArtifactStoreProvider,
	artifacts: readonly ArtifactRef[],
): Promise<ResultValue<readonly ArtifactRef[], FoundationError>> {
	const retained = artifacts.slice(0, MAX_ARTIFACTS);
	for (const artifact of retained) {
		const shape = validateArtifactRef(artifact);
		if (!shape.ok) return untrusted("Child result contains an invalid ArtifactRef", shape.error);
		let verified: Awaited<ReturnType<ArtifactStoreProvider["verify"]>>;
		try {
			verified = await artifactStore.verify(artifact.artifactId);
		} catch {
			return untrusted("Child result artifact verification failed closed");
		}
		if (!verified.ok || verified.value.schemaVersion !== 1 || verified.value.digestValid !== true) {
			return untrusted("Child result artifact digest is not verified", verified.ok ? undefined : verified.error);
		}
	}
	return Result.ok(cloneDeepFrozen(retained));
}

function projectionObjectId(value: ValidatedChildResult): string {
	return value.taskResultId === undefined ? `attempt:${value.receipt.attemptReceiptId}` : `task-result:${value.taskResultId}`;
}

function buildProjection(
	value: ValidatedChildResult,
	artifacts: readonly ArtifactRef[],
	producedAt: string,
): SafeChildResultProjection {
	const base = {
		schemaVersion: 1 as const,
		childAgentInstanceId: value.childAgentInstanceId,
		attemptReceiptId: value.receipt.attemptReceiptId,
		...(value.taskResultId === undefined ? {} : { taskResultId: value.taskResultId }),
		summary: truncateSummary(value.summary),
		artifacts,
		trust: "untrusted_child_output" as const,
		producedAt,
	};
	return cloneDeepFrozen({ ...base, digest: fingerprintFoundationValue(base) });
}

function projectionRecordMatches(
	host: ChildResultTransportHost,
	value: ValidatedChildResult,
	record: Awaited<ReturnType<SessionLedger["get"]>>,
): boolean {
	return record !== undefined &&
		record.kind === "fact" &&
		record.objectType === RESULT_PROJECTION_OBJECT_TYPE &&
		record.objectId === projectionObjectId(value) &&
		record.lane === host.parentLaneId &&
		record.revision === 1 &&
		record.correlation.sessionId === host.sessionId &&
		record.correlation.laneId === host.parentLaneId &&
		record.correlation.taskId === value.taskId &&
		record.correlation.dispatchId === value.receipt.dispatchId &&
		record.correlation.attemptId === value.receipt.attemptId &&
		record.correlation.agentInstanceId === value.childAgentInstanceId &&
		record.correlation.attemptReceiptId === value.receipt.attemptReceiptId &&
		record.correlation.taskResultId === value.taskResultId;
}

export async function projectSafeChildResult(
	host: ChildResultTransportHost,
	input: unknown,
): Promise<ResultValue<SafeChildResultProjection, FoundationError>> {
	const validated = validateTransportInput(input);
	if (!validated.ok) return validated;
	let durable: ResultValue<void, FoundationError>;
	try {
		durable = await verifyDurableSources(host, validated.value);
	} catch {
		return untrusted("Child result durable source verification failed closed");
	}
	if (!durable.ok) return durable;
	const artifacts = await verifyArtifacts(host.artifactStore, validated.value.artifacts);
	if (!artifacts.ok) return artifacts;
	const objectId = projectionObjectId(validated.value);
	try {
		const existing = await host.ledger.get(RESULT_PROJECTION_OBJECT_TYPE, objectId);
		if (existing !== undefined) {
			if (!projectionRecordMatches(host, validated.value, existing)) return untrusted("Child result projection durable metadata conflicts with its source");
			if (existing.kind !== "fact") return untrusted("Child result projection durable identity is terminal");
			const checked = validateSafeChildResultProjection(existing.payload);
			if (!checked.ok) return checked;
			const expected = buildProjection(validated.value, artifacts.value, checked.value.producedAt);
			if (canonicalFoundationJson(checked.value) !== canonicalFoundationJson(expected)) {
				return untrusted("Child result projection replay conflicts with its exact source content");
			}
			return checked;
		}

		const producedAt = canonicalTimestamp(host.now ?? Date.now);
		if (!producedAt.ok) return producedAt;
		const projection = buildProjection(validated.value, artifacts.value, producedAt.value);
		const stored = await host.ledger.appendFact(RESULT_PROJECTION_OBJECT_TYPE, objectId, projection as unknown as FoundationJsonValue, {
			clientRequestId: `subagent-result-projection:${objectId}`,
			expectedRevision: 0,
			correlation: {
				taskId: validated.value.taskId,
				dispatchId: validated.value.receipt.dispatchId,
				attemptId: validated.value.receipt.attemptId,
				agentInstanceId: validated.value.childAgentInstanceId,
				attemptReceiptId: validated.value.receipt.attemptReceiptId,
				...(validated.value.taskResultId === undefined ? {} : { taskResultId: validated.value.taskResultId }),
			},
		});
		if (!projectionRecordMatches(host, validated.value, stored.record)) return untrusted("Persisted child result projection metadata is invalid");
		const checked = validateSafeChildResultProjection(stored.payload);
		if (!checked.ok || canonicalFoundationJson(checked.value) !== canonicalFoundationJson(projection)) {
			return untrusted("Persisted child result projection content is invalid");
		}
		return checked;
	} catch (error) {
		return untrusted("Child result projection could not be persisted", error instanceof FoundationError ? error : undefined);
	}
}

export function validateSafeChildResultProjection(
	value: unknown,
): ResultValue<SafeChildResultProjection, FoundationError> {
	const checked = validateExactShape<SafeChildResultProjection>(SafeChildResultProjectionV1Schema, value, "safe_child_result_projection");
	if (!checked.ok) return untrusted("Child result projection has an invalid exact shape", checked.error);
	if (new TextEncoder().encode(checked.value.summary).byteLength > MAX_SUMMARY_BYTES) return untrusted("Child result projection summary exceeds its byte bound");
	try {
		if (new Date(checked.value.producedAt).toISOString() !== checked.value.producedAt) return untrusted("Child result projection time is not canonical");
	} catch {
		return untrusted("Child result projection time is outside the supported range");
	}
	for (const artifact of checked.value.artifacts) {
		const artifactResult = validateArtifactRef(artifact);
		if (!artifactResult.ok) return untrusted("Child result projection contains an invalid ArtifactRef", artifactResult.error);
	}
	const detached = cloneDeepFrozen(checked.value);
	const { digest, ...base } = detached;
	const expected = fingerprintFoundationValue(base);
	if (digest.algorithm !== expected.algorithm || digest.value !== expected.value) return untrusted("Child result projection digest does not match its content");
	return Result.ok(detached);
}

export type ChildTaskSettlementPolicy =
	| { readonly type: "all_succeed" }
	| { readonly type: "quorum"; readonly minimumSucceeded: number }
	| { readonly type: "partial" };

export interface ChildTaskSettlementAdapterInput {
	readonly taskResultId: string;
	readonly task: TaskEnvelope;
	readonly receipts: readonly AttemptReceipt[];
	readonly policy: ChildTaskSettlementPolicy;
	readonly summary: string;
	readonly artifacts?: SettleTaskResultInput["artifacts"];
	readonly diff?: SettleTaskResultInput["diff"];
	readonly tests: SettleTaskResultInput["tests"];
	readonly evidence: SettleTaskResultInput["evidence"];
	readonly producer: ResultProvenance;
	readonly validation?: SettleTaskResultInput["validation"];
}

function selectSettlementReceipts(
	input: ChildTaskSettlementAdapterInput,
): ResultValue<readonly AttemptReceipt[], FoundationError> {
	if (input.producer.producerKind !== "host") return Result.err(new FoundationError("task_result_validation_failed", "Only the Host settlement gate may synthesize child results"));
	if (input.receipts.length === 0) return Result.err(new FoundationError("task_result_no_source_receipts", "Child result synthesis requires provider receipts"));
	const byId = new Map<string, AttemptReceipt>();
	for (const candidate of input.receipts) {
		const checked = validateAttemptReceipt(candidate, { providerClass: "agent" });
		if (!checked.ok) return Result.err(checked.error);
		if (checked.value.taskId !== input.task.taskId) return Result.err(new FoundationError("task_result_receipt_task_mismatch", "Child receipt does not belong to the synthesis task"));
		const previous = byId.get(checked.value.attemptReceiptId);
		if (previous !== undefined) {
			const conflict = canonicalFoundationJson(previous) !== canonicalFoundationJson(checked.value);
			return Result.err(new FoundationError("task_result_validation_failed", conflict ? "Conflicting child receipts reuse one receipt id" : "Child result synthesis repeats a receipt id"));
		}
		byId.set(checked.value.attemptReceiptId, checked.value);
	}
	const receipts = [...byId.values()];
	const succeeded = receipts.filter((receipt) => receipt.status === "succeeded");
	if (input.policy.type === "all_succeed") {
		return succeeded.length === receipts.length
			? Result.ok(receipts)
			: Result.err(new FoundationError("task_result_validation_failed", "all_succeed requires every child receipt to succeed"));
	}
	if (input.policy.type === "quorum") {
		if (!Number.isSafeInteger(input.policy.minimumSucceeded) || input.policy.minimumSucceeded <= 0 || input.policy.minimumSucceeded > receipts.length) {
			return Result.err(new FoundationError("task_result_validation_failed", "quorum requires a valid explicit success threshold"));
		}
		return succeeded.length >= input.policy.minimumSucceeded
			? Result.ok(succeeded)
			: Result.err(new FoundationError("task_result_validation_failed", "Child receipt quorum was not reached"));
	}
	return succeeded.length > 0
		? Result.ok(succeeded)
		: Result.err(new FoundationError("task_result_validation_failed", "partial settlement requires at least one succeeded child receipt"));
}

export async function settleChildTaskResult(
	hostGate: Pick<LayeredResultSettlement, "getAttemptReceipt" | "settle">,
	input: ChildTaskSettlementAdapterInput,
): Promise<ResultValue<TaskResult, FoundationError>> {
	const selected = selectSettlementReceipts(input);
	if (!selected.ok) return selected;
	for (const receipt of input.receipts) {
		const durable = await hostGate.getAttemptReceipt(receipt.attemptReceiptId);
		if (durable === undefined) return Result.err(new FoundationError("task_result_no_source_receipts", "Child receipt did not cross the provider consumer gate"));
		if (canonicalFoundationJson(durable) !== canonicalFoundationJson(receipt)) {
			return Result.err(new FoundationError("task_result_validation_failed", "Child receipt conflicts with its durable provider-accepted value"));
		}
	}
	return hostGate.settle({
		taskResultId: input.taskResultId,
		task: input.task,
		sourceAttemptReceiptIds: selected.value.map((receipt) => receipt.attemptReceiptId),
		summary: input.summary,
		...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
		...(input.diff === undefined ? {} : { diff: input.diff }),
		tests: input.tests,
		evidence: input.evidence,
		producer: input.producer,
		...(input.validation === undefined ? {} : { validation: input.validation }),
	});
}
