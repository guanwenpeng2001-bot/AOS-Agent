import {
	canonicalFoundationJson,
	fingerprintFoundationValue,
	validateAttemptReceipt,
	validateDurableEvent,
	validatePublicExecutionError,
	validateRunReceipt,
	validateTaskResult,
	validateWorkerReceipt,
	type AttemptReceipt,
	type DurableEventEnvelope,
	type FoundationFactRecord,
	type FoundationRecord,
	type PublicExecutionError,
	type PublicExecutionErrorCategory,
	type RunReceipt,
	type SideEffectState,
	type TaskResult,
	type WorkerReceipt,
} from "@aos-agent/agent-core";

const RESULT_OBJECT_TYPES = new Set(["run_receipt", "task_result", "attempt_receipt", "worker_receipt"]);

export type AutomationRunStatus = "completed" | "failed" | "cancelled";

/**
 * Safe error projection. Canonical projections carry all fields directly from
 * RunReceipt; private legacy migration views may omit the entire error.
 */
export interface AutomationRunErrorProjection {
	readonly code: string;
	readonly message?: string;
	readonly category?: PublicExecutionErrorCategory;
	readonly retryable?: boolean;
}

/** Legacy public token counters projected from canonical RunReceipt usage. */
export interface AutomationRunUsageProjection {
	readonly input: number;
	readonly output: number;
	readonly total: number;
}

/** Temporary structural seam for the canonical T2A RunReceipt additions. */
export type CanonicalAutomationRunReceiptSource = Omit<RunReceipt, "usage" | "terminalError"> & {
	readonly usage: {
		readonly input: number;
		readonly output: number;
		readonly totalTokens: number;
	};
	readonly terminalError?: PublicExecutionError;
};

export interface AutomationRunTerminalProjection {
	readonly runId: string;
	readonly sessionId: string;
	readonly status: AutomationRunStatus;
	readonly terminalError?: AutomationRunErrorProjection;
	readonly usage?: AutomationRunUsageProjection;
}

export interface CanonicalAutomationRunTerminalProjection extends AutomationRunTerminalProjection {
	readonly usage: AutomationRunUsageProjection;
}

export interface AutomationRunCanonicalResultProjection {
	readonly runReceiptId: string;
	readonly taskResultId?: string;
	readonly attemptReceiptIds: readonly string[];
	readonly taskSummary?: string;
	readonly sideEffectState: SideEffectState;
}

/**
 * Automation's read-only Run view. It intentionally omits legacy model,
 * binding, request, file, and final-text fields that the Foundation result
 * chain does not canonically support.
 */
export interface AutomationRunProjection {
	readonly id: string;
	readonly sessionId: string;
	readonly status: AutomationRunStatus;
	readonly startedAt?: string;
	readonly endedAt: string;
	readonly terminalError?: AutomationRunErrorProjection;
	readonly terminal: AutomationRunTerminalProjection;
	/** Present only for a projection backed by a canonical Foundation RunReceipt. */
	readonly canonicalResult?: AutomationRunCanonicalResultProjection;
}

export interface CanonicalAutomationRunProjection extends AutomationRunProjection {
	readonly terminal: CanonicalAutomationRunTerminalProjection;
	readonly canonicalResult: AutomationRunCanonicalResultProjection;
}

export interface AutomationRunProjectionInput {
	readonly records: readonly FoundationRecord[];
	readonly events?: readonly DurableEventEnvelope[];
}

export class AutomationRunProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutomationRunProjectionError";
	}
}

interface StoredFact<TPayload> {
	readonly record: FoundationFactRecord;
	readonly payload: TPayload;
}

interface ResultFacts {
	readonly runs: Map<string, StoredFact<CanonicalAutomationRunReceiptSource>>;
	readonly tasks: Map<string, StoredFact<TaskResult>>;
	readonly attempts: Map<string, StoredFact<AttemptReceipt>>;
	readonly workers: Map<string, StoredFact<WorkerReceipt>>;
}

function fail(message: string): never {
	throw new AutomationRunProjectionError(message);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

function isCanonicalTimestamp(value: string): boolean {
	const time = new Date(value);
	return Number.isFinite(time.valueOf()) && time.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalRunReceipt(value: unknown): CanonicalAutomationRunReceiptSource {
	if (!isRecord(value) || !Object.hasOwn(value, "usage")) fail("Canonical run_receipt is missing usage");
	const { usage, terminalError, ...base } = value;
	const checked = validateRunReceipt(base);
	if (!checked.ok) fail("Canonical run_receipt has an invalid exact shape");
	if (
		!isRecord(usage) ||
		!hasExactKeys(usage, ["input", "output", "totalTokens"]) ||
		![usage.input, usage.output, usage.totalTokens].every(
			(candidate) => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0,
		)
	) {
		fail(`Canonical run_receipt ${checked.value.runReceiptId} has invalid usage`);
	}
	const checkedError = terminalError === undefined ? undefined : validatePublicExecutionError(terminalError);
	if (checkedError !== undefined && !checkedError.ok) {
		fail(`Canonical run_receipt ${checked.value.runReceiptId} has an invalid terminal error`);
	}
	if (checked.value.terminalStatus === "completed") {
		if (terminalError !== undefined || checked.value.terminalErrorCode !== undefined) {
			fail(`Completed Run ${checked.value.runId} carries a terminal error`);
		}
	} else if (
		checkedError === undefined ||
		checked.value.terminalErrorCode === undefined ||
		checkedError.value.code !== checked.value.terminalErrorCode
	) {
		fail(`Terminal error conflicts for Run ${checked.value.runId}`);
	}
	return {
		...checked.value,
		usage: {
			input: usage.input as number,
			output: usage.output as number,
			totalTokens: usage.totalTokens as number,
		},
		...(checkedError === undefined ? {} : { terminalError: checkedError.value }),
	};
}

function insertFact<TPayload>(
	map: Map<string, StoredFact<TPayload>>,
	identity: string,
	record: FoundationFactRecord,
	payload: TPayload,
): void {
	const existing = map.get(identity);
	if (existing === undefined) {
		map.set(identity, { record, payload });
		return;
	}
	if (
		existing.record.objectId !== record.objectId ||
		existing.record.revision !== record.revision ||
		existing.record.correlation.sessionId !== record.correlation.sessionId ||
		!canonicalEqual(existing.payload, payload)
	) {
		fail(`Canonical ${record.objectType} conflicts for ${identity}`);
	}
	if (record.seq < existing.record.seq || record.seq === existing.record.seq && record.id.localeCompare(existing.record.id) < 0) {
		map.set(identity, { record, payload });
	}
}

function requireFactRecord(record: FoundationRecord): FoundationFactRecord {
	if (record.kind !== "fact") fail("Canonical result record is not an immutable fact");
	if (record.correlation.sessionId.length === 0) fail(`Canonical ${record.objectType} has no Session correlation`);
	return record;
}

function requireProvenanceSession(
	record: FoundationFactRecord,
	provenance: AttemptReceipt["provenance"] | TaskResult["provenance"] | WorkerReceipt["provenance"],
): void {
	if (provenance.correlation?.sessionId !== record.correlation.sessionId) {
		fail(`Canonical ${record.objectType} provenance belongs to another Session`);
	}
}

function collectResultFacts(records: readonly FoundationRecord[]): ResultFacts {
	const facts: ResultFacts = {
		runs: new Map(),
		tasks: new Map(),
		attempts: new Map(),
		workers: new Map(),
	};
	for (const candidate of records) {
		if (!("objectType" in candidate) || !RESULT_OBJECT_TYPES.has(candidate.objectType)) continue;
		const record = requireFactRecord(candidate);
		if (record.objectType === "run_receipt") {
			const receipt = canonicalRunReceipt(record.payload);
			if (receipt.runId !== record.objectId || record.correlation.runId !== receipt.runId) {
				fail(`Canonical run_receipt ${record.objectId} has conflicting Run identity`);
			}
			if (!isCanonicalTimestamp(receipt.completedAt)) fail(`Canonical run_receipt ${record.objectId} has an invalid completion time`);
			insertFact(facts.runs, receipt.runId, record, receipt);
			continue;
		}
		if (record.objectType === "task_result") {
			const checked = validateTaskResult(record.payload);
			if (!checked.ok || checked.value.provenance.producerKind !== "host") {
				fail(`Canonical task_result ${record.objectId} is malformed or was not settled by the Host`);
			}
			if (checked.value.taskResultId !== record.objectId) fail(`Canonical task_result ${record.objectId} has conflicting identity`);
			requireProvenanceSession(record, checked.value.provenance);
			insertFact(facts.tasks, checked.value.taskResultId, record, checked.value);
			continue;
		}
		if (record.objectType === "attempt_receipt") {
			const checked = validateAttemptReceipt(record.payload);
			if (!checked.ok) fail(`Canonical attempt_receipt ${record.objectId} is malformed`);
			if (checked.value.attemptReceiptId !== record.objectId) fail(`Canonical attempt_receipt ${record.objectId} has conflicting identity`);
			requireProvenanceSession(record, checked.value.provenance);
			insertFact(facts.attempts, checked.value.attemptReceiptId, record, checked.value);
			continue;
		}
		const checked = validateWorkerReceipt(record.payload);
		if (!checked.ok) fail(`Canonical worker_receipt ${record.objectId} is malformed`);
		if (checked.value.workerReceiptId !== record.objectId) fail(`Canonical worker_receipt ${record.objectId} has conflicting identity`);
		requireProvenanceSession(record, checked.value.provenance);
		insertFact(facts.workers, checked.value.workerReceiptId, record, checked.value);
	}
	return facts;
}

function normalizeEvents(events: readonly DurableEventEnvelope[]): DurableEventEnvelope[] {
	const byId = new Map<string, DurableEventEnvelope>();
	const bySequence = new Map<string, DurableEventEnvelope>();
	for (const candidate of events) {
		const checked = validateDurableEvent(candidate);
		if (!checked.ok || !isCanonicalTimestamp(candidate.timestamp)) fail("Canonical durable event is malformed");
		const existingId = byId.get(candidate.eventId);
		if (existingId !== undefined) {
			if (!canonicalEqual(existingId, candidate)) fail(`Canonical durable event ${candidate.eventId} conflicts`);
			continue;
		}
		const sequenceKey = `${candidate.streamId}\u0000${candidate.sequence}`;
		const existingSequence = bySequence.get(sequenceKey);
		if (existingSequence !== undefined && !canonicalEqual(existingSequence, candidate)) {
			fail(`Canonical durable event sequence ${candidate.sequence} conflicts in stream ${candidate.streamId}`);
		}
		byId.set(candidate.eventId, checked.value);
		bySequence.set(sequenceKey, checked.value);
	}
	return [...byId.values()].sort(
		(left, right) => left.sequence - right.sequence || left.streamId.localeCompare(right.streamId) || left.eventId.localeCompare(right.eventId),
	);
}

function mergeSideEffectState(left: SideEffectState, right: SideEffectState): SideEffectState {
	if (left === "side_effect_unknown" || right === "side_effect_unknown") return "side_effect_unknown";
	if (left === "unknown" || right === "unknown") return "unknown";
	return "none";
}

function taskStatusFromAttempts(attempts: readonly AttemptReceipt[]): TaskResult["status"] {
	if (attempts.some((attempt) => attempt.status === "failed")) return "failed";
	if (attempts.every((attempt) => attempt.status === "cancelled")) return "cancelled";
	if (attempts.some((attempt) => attempt.status === "suspended")) return "suspended";
	return "succeeded";
}

function errorProjection(value: PublicExecutionError): AutomationRunErrorProjection {
	return {
		code: value.code,
		message: value.message,
		...(value.category === undefined ? {} : { category: value.category }),
		retryable: value.retryable,
	};
}

function terminalErrorFromReceipt(
	receipt: CanonicalAutomationRunReceiptSource,
): AutomationRunErrorProjection | undefined {
	return receipt.terminalError === undefined ? undefined : errorProjection(receipt.terminalError);
}

function startedAtForRun(
	runId: string,
	attempts: readonly AttemptReceipt[],
	events: readonly DurableEventEnvelope[],
): string | undefined {
	const attemptIds = new Set(attempts.map((attempt) => attempt.attemptId));
	const starts: string[] = [];
	for (const event of events) {
		if (event.category !== "attempt.started" || !isRecord(event.payload)) continue;
		const attemptId = event.payload.attemptId;
		if (typeof attemptId !== "string" || !attemptIds.has(attemptId)) continue;
		if (event.correlation.runId !== undefined && event.correlation.runId !== runId) {
			fail(`Canonical attempt.started event for ${attemptId} belongs to another Run`);
		}
		starts.push(event.timestamp);
	}
	starts.sort();
	return starts[0];
}

function requireWorkerChain(
	sessionId: string,
	attempt: AttemptReceipt,
	facts: ResultFacts,
): SideEffectState {
	let state = attempt.sideEffectState;
	for (const reference of attempt.workerReceiptRefs) {
		const stored = facts.workers.get(reference.id);
		if (stored === undefined) fail(`Canonical attempt_receipt ${attempt.attemptReceiptId} references missing WorkerReceipt ${reference.id}`);
		const worker = stored.payload;
		if (
			stored.record.revision !== reference.revision ||
			stored.record.correlation.sessionId !== sessionId ||
			(reference.providerId !== undefined && reference.providerId !== worker.provenance.providerId) ||
			(reference.fingerprint !== undefined && reference.fingerprint.value !== fingerprintFoundationValue(worker).value) ||
			(worker.taskId !== undefined && worker.taskId !== attempt.taskId) ||
			(worker.dispatchId !== undefined && worker.dispatchId !== attempt.dispatchId) ||
			(worker.attemptId !== undefined && worker.attemptId !== attempt.attemptId)
		) {
			fail(`Canonical WorkerReceipt ${reference.id} conflicts with AttemptReceipt ${attempt.attemptReceiptId}`);
		}
		state = mergeSideEffectState(state, worker.sideEffectState);
	}
	return state;
}

function validateOutcome(
	receipt: CanonicalAutomationRunReceiptSource,
	taskResult: TaskResult | undefined,
	sideEffectState: SideEffectState,
	terminalError: AutomationRunErrorProjection | undefined,
): void {
	if (receipt.terminalStatus === "completed") {
		if (taskResult?.status !== "succeeded") fail(`Completed Run ${receipt.runId} has no succeeded TaskResult`);
		if (receipt.terminalErrorCode !== undefined || sideEffectState !== "none") {
			fail(`Completed Run ${receipt.runId} carries terminal error or unknown side effects`);
		}
		return;
	}
	if (receipt.terminalStatus === "cancelled") {
		if (taskResult !== undefined && taskResult.status !== "cancelled") {
			fail(`Cancelled Run ${receipt.runId} has a non-cancelled TaskResult`);
		}
		if (sideEffectState !== "none") fail(`Cancelled Run ${receipt.runId} carries unknown side effects`);
		if (terminalError?.category === "deadline" || receipt.terminalErrorCode?.includes("deadline") === true) {
			fail(`Cancelled Run ${receipt.runId} conflicts with a deadline outcome`);
		}
		return;
	}
	if (taskResult !== undefined && taskResult.status !== "failed" && taskResult.status !== "suspended") {
		fail(`Failed Run ${receipt.runId} has a successful or cancelled TaskResult`);
	}
}

function verifyWrittenEvent(receipt: RunReceipt, events: readonly DurableEventEnvelope[]): void {
	for (const event of events) {
		if (event.category !== "run_receipt.written" || !isRecord(event.payload)) continue;
		if (event.payload.runId !== receipt.runId && event.correlation.runId !== receipt.runId) continue;
		if (
			event.payload.runId !== receipt.runId ||
			event.payload.runReceiptId !== receipt.runReceiptId ||
			event.correlation.runId !== receipt.runId ||
			(event.correlation.runReceiptId !== undefined && event.correlation.runReceiptId !== receipt.runReceiptId)
		) {
			fail(`Canonical run_receipt.written event conflicts for Run ${receipt.runId}`);
		}
	}
}

function projectRun(
	storedRun: StoredFact<CanonicalAutomationRunReceiptSource>,
	facts: ResultFacts,
	events: readonly DurableEventEnvelope[],
): CanonicalAutomationRunProjection {
	const receipt = storedRun.payload;
	const sessionId = storedRun.record.correlation.sessionId;
	if (receipt.attemptReceiptIds.length === 0 || new Set(receipt.attemptReceiptIds).size !== receipt.attemptReceiptIds.length) {
		fail(`Canonical RunReceipt ${receipt.runReceiptId} has missing or duplicate AttemptReceipt references`);
	}
	const attempts = receipt.attemptReceiptIds.map((attemptReceiptId) => {
		const stored = facts.attempts.get(attemptReceiptId);
		if (stored === undefined) fail(`Canonical RunReceipt ${receipt.runReceiptId} references missing AttemptReceipt ${attemptReceiptId}`);
		if (stored.record.correlation.sessionId !== sessionId) fail(`Canonical AttemptReceipt ${attemptReceiptId} belongs to another Session`);
		return stored.payload;
	});
	const taskIds = new Set(attempts.map((attempt) => attempt.taskId));
	if (taskIds.size !== 1) fail(`Canonical RunReceipt ${receipt.runReceiptId} references Attempts from different Tasks`);

	let taskResult: TaskResult | undefined;
	if (receipt.taskResultId !== undefined) {
		const stored = facts.tasks.get(receipt.taskResultId);
		if (stored === undefined) fail(`Canonical RunReceipt ${receipt.runReceiptId} references missing TaskResult ${receipt.taskResultId}`);
		if (stored.record.correlation.sessionId !== sessionId || !taskIds.has(stored.payload.taskId)) {
			fail(`Canonical TaskResult ${receipt.taskResultId} belongs to another Run chain`);
		}
		if (
			stored.payload.sourceAttemptReceiptIds.length === 0 ||
			new Set(stored.payload.sourceAttemptReceiptIds).size !== stored.payload.sourceAttemptReceiptIds.length ||
			stored.payload.sourceAttemptReceiptIds.some((id) => !receipt.attemptReceiptIds.includes(id))
		) {
			fail(`Canonical TaskResult ${receipt.taskResultId} has invalid AttemptReceipt references`);
		}
		const sourceAttempts = stored.payload.sourceAttemptReceiptIds.map((id) => {
			const source = facts.attempts.get(id);
			if (source === undefined) fail(`Canonical TaskResult ${receipt.taskResultId} references missing AttemptReceipt ${id}`);
			return source.payload;
		});
		if (taskStatusFromAttempts(sourceAttempts) !== stored.payload.status) {
			fail(`Canonical TaskResult ${receipt.taskResultId} conflicts with its Attempt outcomes`);
		}
		taskResult = stored.payload;
	} else if (receipt.terminalStatus === "completed") {
		fail(`Completed Run ${receipt.runId} is missing its TaskResult`);
	}

	let sideEffectState: SideEffectState = "none";
	for (const attempt of attempts) {
		sideEffectState = mergeSideEffectState(sideEffectState, requireWorkerChain(sessionId, attempt, facts));
	}
	const terminalError = terminalErrorFromReceipt(receipt);
	validateOutcome(receipt, taskResult, sideEffectState, terminalError);
	verifyWrittenEvent(receipt, events);
	const startedAt = startedAtForRun(receipt.runId, attempts, events);
	const usage: AutomationRunUsageProjection = {
		input: receipt.usage.input,
		output: receipt.usage.output,
		total: receipt.usage.totalTokens,
	};
	const terminal: CanonicalAutomationRunTerminalProjection = {
		runId: receipt.runId,
		sessionId,
		status: receipt.terminalStatus,
		...(terminalError === undefined ? {} : { terminalError }),
		usage,
	};
	return {
		id: receipt.runId,
		sessionId,
		status: receipt.terminalStatus,
		...(startedAt === undefined ? {} : { startedAt }),
		endedAt: receipt.completedAt,
		...(terminalError === undefined ? {} : { terminalError }),
		terminal,
		canonicalResult: {
			runReceiptId: receipt.runReceiptId,
			...(receipt.taskResultId === undefined ? {} : { taskResultId: receipt.taskResultId }),
			attemptReceiptIds: [...receipt.attemptReceiptIds],
			...(taskResult === undefined ? {} : { taskSummary: taskResult.summary }),
			sideEffectState,
		},
	};
}

/** Deterministically project terminal Automation Runs from canonical Foundation facts. */
export function projectAutomationRuns(input: AutomationRunProjectionInput): readonly CanonicalAutomationRunProjection[] {
	const facts = collectResultFacts(input.records);
	const events = normalizeEvents(input.events ?? []);
	return [...facts.runs.values()]
		.sort((left, right) => left.record.seq - right.record.seq || left.payload.runId.localeCompare(right.payload.runId))
		.map((stored) => projectRun(stored, facts, events));
}
