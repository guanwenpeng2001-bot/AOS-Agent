import {
	canonicalFoundationJson,
	validateAttemptReceipt,
	validateDurableEvent,
	validateRunReceipt,
	validateTaskResult,
	type AttemptReceipt,
	type CanonicalRunResult,
	type DurableEventEnvelope,
	type PublicExecutionError,
	type PublicExecutionErrorCategory,
	type RunReceipt,
	type SideEffectState,
	type TaskResult,
} from "@aos-agent/agent-core";

export type AutomationRunStatus = "completed" | "failed" | "cancelled";

/** Safe error projection copied only from the final canonical RunReceipt. */
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

/** Provenance attached only to a current record migrated from a legacy automation.run entry. */
export interface AutomationRunMigrationProvenance {
	readonly sourceKind: "automation.run";
	readonly sourceSchemaVersion: 1;
	readonly disposition: "legacy_migrated";
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
	/** Present only when a complete legacy entry was migrated without a canonical receipt. */
	readonly migration?: AutomationRunMigrationProvenance;
}

export interface CanonicalAutomationRunProjection extends AutomationRunProjection {
	readonly terminal: CanonicalAutomationRunTerminalProjection;
	readonly canonicalResult: AutomationRunCanonicalResultProjection;
	readonly migration?: never;
}

export interface AutomationRunProjectionInput {
	readonly canonicalRuns: readonly CanonicalRunResult[];
	/** Supplemental events recover optional attempt start times and detect event conflicts. */
	readonly events?: readonly DurableEventEnvelope[];
}

export class AutomationRunProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutomationRunProjectionError";
	}
}

interface ValidatedCanonicalRun {
	readonly result: CanonicalRunResult;
	readonly sessionId: string;
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

function hasExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

function requireProvenanceSession(
	sessionId: string,
	kind: string,
	provenance: AttemptReceipt["provenance"] | TaskResult["provenance"],
): void {
	if (provenance.correlation?.sessionId !== sessionId) {
		fail(`Canonical ${kind} provenance belongs to another Session`);
	}
}

function taskStatusFromAttempts(attempts: readonly AttemptReceipt[]): TaskResult["status"] {
	if (attempts.some((attempt) => attempt.status === "failed")) return "failed";
	if (attempts.every((attempt) => attempt.status === "cancelled")) return "cancelled";
	if (attempts.some((attempt) => attempt.status === "suspended")) return "suspended";
	return "succeeded";
}

function validateCanonicalRunResult(candidate: CanonicalRunResult): ValidatedCanonicalRun {
	if (
		!isRecord(candidate) ||
		!hasExactKeys(candidate, ["schemaVersion", "runReceipt", "attemptReceipts", "writtenEvent"], ["taskResult"]) ||
		candidate.schemaVersion !== 1
	) {
		fail("Canonical Run result has an invalid exact shape");
	}

	const checkedReceipt = validateRunReceipt(candidate.runReceipt);
	if (!checkedReceipt.ok) fail("Canonical RunReceipt has an invalid exact shape");
	const receipt = checkedReceipt.value;
	if (!isCanonicalTimestamp(receipt.completedAt)) {
		fail(`Canonical RunReceipt ${receipt.runReceiptId} has an invalid completion time`);
	}

	const checkedEvent = validateDurableEvent(candidate.writtenEvent);
	if (
		!checkedEvent.ok ||
		checkedEvent.value.category !== "run_receipt.written" ||
		!isCanonicalTimestamp(checkedEvent.value.timestamp) ||
		!isRecord(checkedEvent.value.payload)
	) {
		fail(`Canonical RunReceipt ${receipt.runReceiptId} has an invalid written event`);
	}
	const sessionId = checkedEvent.value.correlation.sessionId;
	if (sessionId.length === 0) fail(`Canonical RunReceipt ${receipt.runReceiptId} has no Session correlation`);
	if (
		checkedEvent.value.payload.runId !== receipt.runId ||
		checkedEvent.value.payload.runReceiptId !== receipt.runReceiptId ||
		checkedEvent.value.correlation.runId !== receipt.runId ||
		(checkedEvent.value.correlation.runReceiptId !== undefined &&
			checkedEvent.value.correlation.runReceiptId !== receipt.runReceiptId)
	) {
		fail(`Canonical run_receipt.written event conflicts for Run ${receipt.runId}`);
	}

	if (!Array.isArray(candidate.attemptReceipts)) {
		fail(`Canonical RunReceipt ${receipt.runReceiptId} has invalid AttemptReceipt references`);
	}
	const attempts = candidate.attemptReceipts.map((value) => {
		const checked = validateAttemptReceipt(value);
		if (!checked.ok) fail(`Canonical RunReceipt ${receipt.runReceiptId} has a malformed AttemptReceipt`);
		requireProvenanceSession(sessionId, `AttemptReceipt ${checked.value.attemptReceiptId}`, checked.value.provenance);
		return checked.value;
	});
	const attemptsById = new Map(attempts.map((attempt) => [attempt.attemptReceiptId, attempt]));
	if (
		attemptsById.size !== attempts.length ||
		receipt.attemptReceiptIds.length !== attempts.length ||
		receipt.attemptReceiptIds.some((id) => !attemptsById.has(id))
	) {
		fail(`Canonical RunReceipt ${receipt.runReceiptId} has missing or duplicate AttemptReceipt references`);
	}
	const taskIds = new Set(attempts.map((attempt) => attempt.taskId));
	if (taskIds.size !== 1) fail(`Canonical RunReceipt ${receipt.runReceiptId} references Attempts from different Tasks`);

	let taskResult: TaskResult | undefined;
	if (candidate.taskResult !== undefined) {
		const checked = validateTaskResult(candidate.taskResult);
		if (!checked.ok || checked.value.provenance.producerKind !== "host") {
			fail(`Canonical RunReceipt ${receipt.runReceiptId} has a malformed or non-Host TaskResult`);
		}
		taskResult = checked.value;
		requireProvenanceSession(sessionId, `TaskResult ${taskResult.taskResultId}`, taskResult.provenance);
	}
	if (receipt.taskResultId === undefined ? taskResult !== undefined : taskResult?.taskResultId !== receipt.taskResultId) {
		fail(`Canonical RunReceipt ${receipt.runReceiptId} has a conflicting TaskResult reference`);
	}
	if (taskResult !== undefined) {
		if (!taskIds.has(taskResult.taskId)) {
			fail(`Canonical TaskResult ${taskResult.taskResultId} belongs to another Run chain`);
		}
		if (
			taskResult.sourceAttemptReceiptIds.length === 0 ||
			new Set(taskResult.sourceAttemptReceiptIds).size !== taskResult.sourceAttemptReceiptIds.length ||
			taskResult.sourceAttemptReceiptIds.some((id) => !attemptsById.has(id))
		) {
			fail(`Canonical TaskResult ${taskResult.taskResultId} has invalid AttemptReceipt references`);
		}
		const sourceAttempts = taskResult.sourceAttemptReceiptIds.map((id) => {
			const attempt = attemptsById.get(id);
			if (attempt === undefined) fail(`Canonical TaskResult ${taskResult.taskResultId} references missing AttemptReceipt ${id}`);
			return attempt;
		});
		if (taskStatusFromAttempts(sourceAttempts) !== taskResult.status) {
			fail(`Canonical TaskResult ${taskResult.taskResultId} conflicts with its Attempt outcomes`);
		}
	} else if (receipt.terminalStatus === "completed") {
		fail(`Completed Run ${receipt.runId} is missing its TaskResult`);
	}

	return {
		result: {
			schemaVersion: 1,
			runReceipt: receipt,
			...(taskResult === undefined ? {} : { taskResult }),
			attemptReceipts: attempts,
			writtenEvent: candidate.writtenEvent,
		},
		sessionId,
	};
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

function errorProjection(value: PublicExecutionError): AutomationRunErrorProjection {
	return {
		code: value.code,
		message: value.message,
		...(value.category === undefined ? {} : { category: value.category }),
		retryable: value.retryable,
	};
}

function startedAtForRun(
	runId: string,
	sessionId: string,
	attempts: readonly AttemptReceipt[],
	events: readonly DurableEventEnvelope[],
): string | undefined {
	const attemptIds = new Set(attempts.map((attempt) => attempt.attemptId));
	const starts: string[] = [];
	for (const event of events) {
		if (event.category !== "attempt.started" || !isRecord(event.payload)) continue;
		const attemptId = event.payload.attemptId;
		if (typeof attemptId !== "string" || !attemptIds.has(attemptId)) continue;
		if (event.correlation.sessionId !== sessionId) {
			fail(`Canonical attempt.started event for ${attemptId} belongs to another Session`);
		}
		if (event.correlation.runId !== undefined && event.correlation.runId !== runId) {
			fail(`Canonical attempt.started event for ${attemptId} belongs to another Run`);
		}
		starts.push(event.timestamp);
	}
	starts.sort();
	return starts[0];
}

function validateOutcome(
	receipt: RunReceipt,
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

function verifyWrittenEvents(receipt: RunReceipt, events: readonly DurableEventEnvelope[]): void {
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
	validated: ValidatedCanonicalRun,
	events: readonly DurableEventEnvelope[],
): CanonicalAutomationRunProjection {
	const { result, sessionId } = validated;
	const { runReceipt: receipt, taskResult, attemptReceipts: attempts } = result;
	let sideEffectState: SideEffectState = "none";
	for (const attempt of attempts) sideEffectState = mergeSideEffectState(sideEffectState, attempt.sideEffectState);
	const terminalError = receipt.terminalError === undefined ? undefined : errorProjection(receipt.terminalError);
	validateOutcome(receipt, taskResult, sideEffectState, terminalError);
	verifyWrittenEvents(receipt, events);
	const startedAt = startedAtForRun(receipt.runId, sessionId, attempts, events);
	const usage: AutomationRunUsageProjection = {
		input: receipt.usage.inputTokens,
		output: receipt.usage.outputTokens,
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

/** Deterministically project terminal Automation Runs from canonical Foundation results. */
export function projectAutomationRuns(input: AutomationRunProjectionInput): readonly CanonicalAutomationRunProjection[] {
	const byRunId = new Map<string, ValidatedCanonicalRun>();
	for (const candidate of input.canonicalRuns) {
		const validated = validateCanonicalRunResult(candidate);
		const existing = byRunId.get(validated.result.runReceipt.runId);
		if (existing !== undefined && !canonicalEqual(existing.result, validated.result)) {
			fail(`Canonical Run result conflicts for ${validated.result.runReceipt.runId}`);
		}
		if (existing === undefined) byRunId.set(validated.result.runReceipt.runId, validated);
	}
	const events = normalizeEvents([
		...[...byRunId.values()].map(({ result }) => result.writtenEvent),
		...(input.events ?? []),
	]);
	return [...byRunId.values()]
		.sort(
			(left, right) =>
				left.result.writtenEvent.sequence - right.result.writtenEvent.sequence ||
				left.result.runReceipt.runId.localeCompare(right.result.runReceipt.runId),
		)
		.map((validated) => projectRun(validated, events));
}
