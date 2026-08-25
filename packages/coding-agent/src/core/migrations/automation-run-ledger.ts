import { canonicalFoundationJson } from "@aos-agent/agent-core";
import {
	parseRunBindingAssociation,
	type RunBindingAssociation,
} from "../binding-handles.ts";
import {
	createPrivateMigrationPlanV1,
	PrivateMigrationError,
	type PrivateMigrationPlanV1,
} from "./session-entry.ts";

export interface LegacyAutomationRunLedgerSourceEntryV1 {
	readonly sequence: number;
	readonly entryId: string;
	readonly data: unknown;
}

export type LegacyAutomationRunStatusV1 = "accepted" | "running" | "completed" | "failed" | "cancelled";
export type LegacyAutomationRunTerminalStatusV1 = "completed" | "failed" | "cancelled";
export type LegacyThinkingLevelV1 = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LegacyAutomationErrorV1 {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}

export interface LegacyAutomationRunModelReferenceV1 {
	readonly provider: string;
	readonly id: string;
	readonly thinkingLevel: LegacyThinkingLevelV1;
}

export interface LegacyAutomationRunRecordV1 {
	readonly id: string;
	readonly sessionId: string;
	readonly sourceRunId?: string;
	readonly attempt: number;
	readonly status: LegacyAutomationRunStatusV1;
	readonly model: LegacyAutomationRunModelReferenceV1;
	readonly bindingAssociation?: RunBindingAssociation;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly terminalError?: LegacyAutomationErrorV1;
}

export interface LegacyAutomationRunUsageV1 {
	readonly input: number;
	readonly output: number;
	readonly total: number;
}

export interface LegacyAutomationRunReceiptV1 {
	readonly runId: string;
	readonly sessionId: string;
	readonly status: LegacyAutomationRunTerminalStatusV1;
	readonly finalText?: string;
	readonly usage: LegacyAutomationRunUsageV1;
	readonly sessionFile?: string;
	readonly terminalError?: LegacyAutomationErrorV1;
	readonly bindingAssociation?: RunBindingAssociation;
}

export type LegacyAutomationRunLedgerEntryV1 =
	| { readonly schemaVersion: 1; readonly kind: "accepted"; readonly record: LegacyAutomationRunRecordV1 }
	| { readonly schemaVersion: 1; readonly kind: "started"; readonly runId: string; readonly startedAt: string }
	| {
			readonly schemaVersion: 1;
			readonly kind: "terminal";
			readonly receipt: LegacyAutomationRunReceiptV1;
			readonly endedAt: string;
	  };

export interface HistoricalAutomationRunProjectionV1 {
	readonly runId: string;
	readonly sessionId: string;
	readonly attempt: number;
	readonly status: LegacyAutomationRunStatusV1;
	readonly model: LegacyAutomationRunModelReferenceV1;
	readonly sourceRunId?: string;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly terminal?: Omit<LegacyAutomationRunReceiptV1, "bindingAssociation">;
	/** Historical handle/association data is retained only as a read view. */
	readonly bindingAssociationView?: RunBindingAssociation;
	readonly recovery?: "interrupted";
}

export interface AutomationRunLedgerMigrationResultV1 {
	readonly schemaVersion: 1;
	readonly sourceKind: "automation.run";
	readonly runs: readonly HistoricalAutomationRunProjectionV1[];
}

const SOURCE_KEYS = ["sequence", "entryId", "data"] as const;
const ACCEPTED_KEYS = ["schemaVersion", "kind", "record"] as const;
const STARTED_KEYS = ["schemaVersion", "kind", "runId", "startedAt"] as const;
const TERMINAL_KEYS = ["schemaVersion", "kind", "receipt", "endedAt"] as const;
const RECORD_REQUIRED_KEYS = ["id", "sessionId", "attempt", "status", "model"] as const;
const RECORD_OPTIONAL_KEYS = [
	"sourceRunId",
	"bindingAssociation",
	"startedAt",
	"endedAt",
	"terminalError",
] as const;
const RECEIPT_REQUIRED_KEYS = ["runId", "sessionId", "status", "usage"] as const;
const RECEIPT_OPTIONAL_KEYS = ["finalText", "sessionFile", "terminalError", "bindingAssociation"] as const;

const LEGACY_AUTOMATION_ERROR_CODES = new Set([
	"unsupported_protocol_version",
	"host_not_initialized",
	"session_busy",
	"start_rejected",
	"run_not_found",
	"run_not_cancellable",
	"session_not_persistent",
	"source_run_not_found",
	"source_run_not_resumable",
	"session_switch_cancelled",
	"ledger_persistence_failed",
	"model_error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function cloneCanonical<TValue>(value: TValue, label: string): TValue {
	try {
		return JSON.parse(canonicalFoundationJson(value)) as TValue;
	} catch {
		throw new PrivateMigrationError(`${label} is not canonical JSON`);
	}
}

function canonicalEqual(left: unknown, right: unknown): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isThinkingLevel(value: unknown): value is LegacyThinkingLevelV1 {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function isTerminalStatus(value: unknown): value is LegacyAutomationRunTerminalStatusV1 {
	return value === "completed" || value === "failed" || value === "cancelled";
}

function decodeError(value: unknown): LegacyAutomationErrorV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["code", "message", "retryable"]) ||
		!isNonEmptyString(value.code) ||
		!LEGACY_AUTOMATION_ERROR_CODES.has(value.code) ||
		typeof value.message !== "string" ||
		typeof value.retryable !== "boolean"
	) {
		throw new PrivateMigrationError("Historical automation error has an invalid exact shape");
	}
	return { code: value.code, message: value.message, retryable: value.retryable };
}

function decodeModel(value: unknown): LegacyAutomationRunModelReferenceV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["provider", "id", "thinkingLevel"]) ||
		!isNonEmptyString(value.provider) ||
		!isNonEmptyString(value.id) ||
		!isThinkingLevel(value.thinkingLevel)
	) {
		throw new PrivateMigrationError("Historical automation model has an invalid exact shape");
	}
	return { provider: value.provider, id: value.id, thinkingLevel: value.thinkingLevel };
}

function decodeAssociation(value: unknown, runId: string): RunBindingAssociation | undefined {
	if (value === undefined) return undefined;
	const association = parseRunBindingAssociation(value);
	if (association === undefined || association.runId !== runId) {
		throw new PrivateMigrationError("Historical automation binding association is invalid");
	}
	return association;
}

function decodeRunRecord(value: unknown): LegacyAutomationRunRecordV1 {
	if (!isRecord(value) || !hasExactKeys(value, RECORD_REQUIRED_KEYS, RECORD_OPTIONAL_KEYS)) {
		throw new PrivateMigrationError("Historical automation accepted record has an invalid exact shape");
	}
	if (
		!isNonEmptyString(value.id) ||
		!isNonEmptyString(value.sessionId) ||
		!Number.isSafeInteger(value.attempt) ||
		(value.attempt as number) < 0 ||
		value.status !== "accepted" ||
		(value.sourceRunId !== undefined && !isNonEmptyString(value.sourceRunId)) ||
		value.startedAt !== undefined ||
		value.endedAt !== undefined ||
		value.terminalError !== undefined
	) {
		throw new PrivateMigrationError("Historical automation accepted record violates accepted-state invariants");
	}
	const record: LegacyAutomationRunRecordV1 = {
		id: value.id,
		sessionId: value.sessionId,
		attempt: value.attempt as number,
		status: "accepted",
		model: decodeModel(value.model),
	};
	if (typeof value.sourceRunId === "string") return { ...record, sourceRunId: value.sourceRunId, ...(value.bindingAssociation === undefined ? {} : { bindingAssociation: decodeAssociation(value.bindingAssociation, value.id) }) };
	if (value.bindingAssociation !== undefined) return { ...record, bindingAssociation: decodeAssociation(value.bindingAssociation, value.id) };
	return record;
}

function decodeUsage(value: unknown): LegacyAutomationRunUsageV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["input", "output", "total"])) {
		throw new PrivateMigrationError("Historical automation usage has an invalid exact shape");
	}
	for (const field of ["input", "output", "total"] as const) {
		if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0) {
			throw new PrivateMigrationError("Historical automation usage contains an invalid value");
		}
	}
	return { input: value.input as number, output: value.output as number, total: value.total as number };
}

function decodeReceipt(value: unknown): LegacyAutomationRunReceiptV1 {
	if (!isRecord(value) || !hasExactKeys(value, RECEIPT_REQUIRED_KEYS, RECEIPT_OPTIONAL_KEYS)) {
		throw new PrivateMigrationError("Historical automation terminal receipt has an invalid exact shape");
	}
	if (
		!isNonEmptyString(value.runId) ||
		!isNonEmptyString(value.sessionId) ||
		!isTerminalStatus(value.status) ||
		(value.finalText !== undefined && typeof value.finalText !== "string") ||
		(value.sessionFile !== undefined && typeof value.sessionFile !== "string")
	) {
		throw new PrivateMigrationError("Historical automation terminal receipt is invalid");
	}
	const receipt: LegacyAutomationRunReceiptV1 = {
		runId: value.runId,
		sessionId: value.sessionId,
		status: value.status,
		usage: decodeUsage(value.usage),
	};
	return {
		...receipt,
		...(typeof value.finalText === "string" ? { finalText: value.finalText } : {}),
		...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}),
		...(value.terminalError === undefined ? {} : { terminalError: decodeError(value.terminalError) }),
		...(value.bindingAssociation === undefined
			? {}
			: { bindingAssociation: decodeAssociation(value.bindingAssociation, value.runId) }),
	};
}

export function decodeLegacyAutomationRunLedgerEntryV1(value: unknown): LegacyAutomationRunLedgerEntryV1 {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== "string") {
		throw new PrivateMigrationError("Historical automation.run entry is invalid");
	}
	if (value.kind === "accepted") {
		if (!hasExactKeys(value, ACCEPTED_KEYS)) throw new PrivateMigrationError("Historical accepted fact has an invalid exact shape");
		return { schemaVersion: 1, kind: "accepted", record: decodeRunRecord(value.record) };
	}
	if (value.kind === "started") {
		if (!hasExactKeys(value, STARTED_KEYS) || !isNonEmptyString(value.runId) || !isNonEmptyString(value.startedAt)) {
			throw new PrivateMigrationError("Historical started fact has an invalid exact shape");
		}
		return { schemaVersion: 1, kind: "started", runId: value.runId, startedAt: value.startedAt };
	}
	if (value.kind === "terminal") {
		if (!hasExactKeys(value, TERMINAL_KEYS) || !isNonEmptyString(value.endedAt)) {
			throw new PrivateMigrationError("Historical terminal fact has an invalid exact shape");
		}
		return { schemaVersion: 1, kind: "terminal", receipt: decodeReceipt(value.receipt), endedAt: value.endedAt };
	}
	throw new PrivateMigrationError(`Historical automation.run kind ${value.kind} is unsupported`);
}

function normalizeSourceEntries(source: readonly LegacyAutomationRunLedgerSourceEntryV1[]): LegacyAutomationRunLedgerSourceEntryV1[] {
	const entries = source.map((candidate) => {
		if (
			!isRecord(candidate) ||
			!hasExactKeys(candidate, SOURCE_KEYS) ||
			!Number.isSafeInteger(candidate.sequence) ||
			(candidate.sequence as number) < 0 ||
			!isNonEmptyString(candidate.entryId)
		) {
			throw new PrivateMigrationError("Historical automation.run source entry has an invalid exact shape");
		}
		return cloneCanonical(candidate, "Historical automation.run source entry");
	});
	entries.sort((left, right) => left.sequence - right.sequence || left.entryId.localeCompare(right.entryId));
	const sequences = new Set<number>();
	const entryIds = new Set<string>();
	for (const entry of entries) {
		if (sequences.has(entry.sequence)) throw new PrivateMigrationError(`Historical automation.run repeats sequence ${entry.sequence}`);
		if (entryIds.has(entry.entryId)) throw new PrivateMigrationError(`Historical automation.run repeats entry id ${entry.entryId}`);
		sequences.add(entry.sequence);
		entryIds.add(entry.entryId);
	}
	return entries;
}

interface MutableRunFold {
	accepted: LegacyAutomationRunRecordV1;
	acceptedSequence: number;
	startedAt?: string;
	terminal?: LegacyAutomationRunReceiptV1;
	endedAt?: string;
	bindingAssociationView?: RunBindingAssociation;
}

function withoutAssociation(receipt: LegacyAutomationRunReceiptV1): Omit<LegacyAutomationRunReceiptV1, "bindingAssociation"> {
	const { bindingAssociation: _bindingAssociation, ...view } = receipt;
	return view;
}

export function migrateLegacyAutomationRunLedgerV1(
	sessionId: string,
	source: readonly LegacyAutomationRunLedgerSourceEntryV1[],
): AutomationRunLedgerMigrationResultV1 {
	if (!isNonEmptyString(sessionId)) throw new PrivateMigrationError("Historical automation.run Session id is invalid");
	const entries = normalizeSourceEntries(source);
	const folds = new Map<string, MutableRunFold>();
	for (const sourceEntry of entries) {
		const fact = decodeLegacyAutomationRunLedgerEntryV1(sourceEntry.data);
		if (fact.kind === "accepted") {
			if (fact.record.sessionId !== sessionId) throw new PrivateMigrationError("Historical accepted fact belongs to another Session");
			const existing = folds.get(fact.record.id);
			if (existing !== undefined) {
				if (!canonicalEqual(existing.accepted, fact.record)) {
					throw new PrivateMigrationError(`Historical accepted fact conflicts for run ${fact.record.id}`);
				}
				continue;
			}
			folds.set(fact.record.id, {
				accepted: fact.record,
				acceptedSequence: sourceEntry.sequence,
				...(fact.record.bindingAssociation === undefined
					? {}
					: { bindingAssociationView: fact.record.bindingAssociation }),
			});
			continue;
		}

		const runId = fact.kind === "started" ? fact.runId : fact.receipt.runId;
		const fold = folds.get(runId);
		if (fold === undefined) throw new PrivateMigrationError(`Historical ${fact.kind} fact is orphaned for run ${runId}`);
		if (fact.kind === "started") {
			if (fold.startedAt !== undefined) {
				if (fold.startedAt !== fact.startedAt) throw new PrivateMigrationError(`Historical started fact conflicts for run ${runId}`);
				continue;
			}
			if (fold.terminal !== undefined) throw new PrivateMigrationError(`Historical started fact follows terminal for run ${runId}`);
			fold.startedAt = fact.startedAt;
			continue;
		}

		if (fact.receipt.sessionId !== sessionId) throw new PrivateMigrationError("Historical terminal receipt belongs to another Session");
		if (fold.terminal !== undefined) {
			if (!canonicalEqual({ receipt: fold.terminal, endedAt: fold.endedAt }, { receipt: fact.receipt, endedAt: fact.endedAt })) {
				throw new PrivateMigrationError(`Historical terminal fact conflicts for run ${runId}`);
			}
			continue;
		}
		if (
			fold.bindingAssociationView !== undefined &&
			fact.receipt.bindingAssociation !== undefined &&
			!canonicalEqual(fold.bindingAssociationView, fact.receipt.bindingAssociation)
		) {
			throw new PrivateMigrationError(`Historical binding association view conflicts for run ${runId}`);
		}
		fold.terminal = fact.receipt;
		fold.endedAt = fact.endedAt;
		fold.bindingAssociationView ??= fact.receipt.bindingAssociation;
	}

	const runs = [...folds.values()]
		.sort((left, right) => left.acceptedSequence - right.acceptedSequence || left.accepted.id.localeCompare(right.accepted.id))
		.map((fold): HistoricalAutomationRunProjectionV1 => {
			const terminal = fold.terminal;
			return {
				runId: fold.accepted.id,
				sessionId: fold.accepted.sessionId,
				attempt: fold.accepted.attempt,
				status: terminal?.status ?? (fold.startedAt === undefined ? "accepted" : "running"),
				model: fold.accepted.model,
				...(fold.accepted.sourceRunId === undefined ? {} : { sourceRunId: fold.accepted.sourceRunId }),
				...(fold.startedAt === undefined ? {} : { startedAt: fold.startedAt }),
				...(fold.endedAt === undefined ? {} : { endedAt: fold.endedAt }),
				...(terminal === undefined ? {} : { terminal: withoutAssociation(terminal) }),
				...(fold.bindingAssociationView === undefined
					? {}
					: { bindingAssociationView: fold.bindingAssociationView }),
				...(terminal === undefined ? { recovery: "interrupted" as const } : {}),
			};
		});
	return { schemaVersion: 1, sourceKind: "automation.run", runs: cloneCanonical(runs, "Historical automation.run result") };
}

export function planLegacyAutomationRunLedgerMigrationV1(
	sessionId: string,
	source: readonly LegacyAutomationRunLedgerSourceEntryV1[],
): PrivateMigrationPlanV1<AutomationRunLedgerMigrationResultV1> {
	const normalizedSource = normalizeSourceEntries(source);
	const result = migrateLegacyAutomationRunLedgerV1(sessionId, normalizedSource);
	return createPrivateMigrationPlanV1({
		migrationName: "automation-run-ledger-v1",
		sourceIdentity: { sessionId },
		sourceKind: "automation.run",
		sourceSchemaVersion: 1,
		targetSchemaVersion: 1,
		source: normalizedSource,
		result,
	});
}
