/**
 * Automation Host v1 run lifecycle: per-session run reservation, the frozen
 * accepted/running/completed/failed/cancelled state machine, sequenced stream
 * events, final-text capture, usage deltas, terminal receipts, and a ledger
 * folded from the SessionManager's `automation.run` custom entries.
 *
 * The coordinator owns a {@link RunLedgerSession} binding (a structural subset
 * of `SessionManager`) and persists only schemaVersion 1 facts via
 * `appendCustomEntry("automation.run", entry)`. Recovery replays custom entries
 * in order; an accepted/running run with no terminal fact is returned with the
 * read-only `recovery: "interrupted"` flag and is never given a fabricated
 * terminal. Diagnostics go to stderr.
 *
 * Erasable TypeScript only (no enums, namespaces, or parameter properties).
 */

import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@aos-agent/agent-core";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { SessionEntry } from "./session-manager.ts";

export type SessionId = string;
export type RunId = string;

// ---- Status ----------------------------------------------------------------

export type RunStatus = "accepted" | "running" | "completed" | "failed" | "cancelled";
export type RunTerminalStatus = "completed" | "failed" | "cancelled";
export type RunRecoveryState = "interrupted";

export function isTerminalStatus(status: RunStatus): status is RunTerminalStatus {
	return status === "completed" || status === "failed" || status === "cancelled";
}

// ---- Ledger -----------------------------------------------------------------

export const RUN_LEDGER_SCHEMA_VERSION = 1;
export const RUN_LEDGER_CUSTOM_TYPE = "automation.run";

/**
 * Session custom entry type for the frozen capability binding of a run. Written
 * once per accepted run that carries a binding; folded back into a redacted
 * binding history so a restarted host can audit which capability binding each
 * attempt used and can verify a resume's successor binding.
 */
export const CAPABILITY_BINDING_SCHEMA_VERSION = 1;
export const CAPABILITY_BINDING_CUSTOM_TYPE = "capability.binding";

export interface RunModelReference {
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel;
}

export interface RunRecord {
	id: RunId;
	sessionId: SessionId;
	sourceRunId?: RunId;
	/**
	 * Binding id of the source run this attempt resumes from. Set on run.resume
	 * when the source run's receipt carried a capabilityBindingId.
	 */
	previousBindingId?: string;
	/**
	 * Id of the frozen capability binding this run used. Set at accept time so an
	 * interrupted (never-terminal) run still carries it. Additive; older ledgers
	 * omit it. Metadata-only — never carries credentials, headers, or MCP config.
	 */
	capabilityBindingId?: string;
	attempt: number;
	status: RunStatus;
	model: RunModelReference;
	startedAt?: string;
	endedAt?: string;
	terminalError?: AutomationError;
}

export interface RunUsage {
	input: number;
	output: number;
	total: number;
}

export interface RunUsageSnapshot {
	input: number;
	output: number;
	total: number;
}

export function createRunUsage(): RunUsage {
	return { input: 0, output: 0, total: 0 };
}

export interface RunReceipt {
	runId: RunId;
	sessionId: SessionId;
	status: RunTerminalStatus;
	finalText?: string;
	usage: RunUsage;
	sessionFile?: string;
	terminalError?: AutomationError;
	/**
	 * Context Engine snapshot id bound to this run's model call(s).
	 * Additive; older ledgers omit it. Metadata-only — never carries raw context bodies.
	 */
	contextSnapshotId?: string;
	/**
	 * Id of the frozen CapabilityBinding this run used. Additive; older ledgers
	 * omit it. Metadata-only — never carries credentials, headers, or MCP config.
	 */
	capabilityBindingId?: string;
}

export type RunStreamEvent =
	| { type: "run.started"; runId: RunId; sessionId: SessionId; sequence: number; timestamp: string }
	| { type: "run.event"; runId: RunId; sessionId: SessionId; sequence: number; timestamp: string; event: AgentSessionEvent }
	| { type: "run.completed"; runId: RunId; sessionId: SessionId; sequence: number; timestamp: string; receipt: RunReceipt }
	| { type: "run.failed"; runId: RunId; sessionId: SessionId; sequence: number; timestamp: string; receipt: RunReceipt }
	| { type: "run.cancelled"; runId: RunId; sessionId: SessionId; sequence: number; timestamp: string; receipt: RunReceipt };

export type PersistedRunLedgerEntry =
	| { schemaVersion: 1; kind: "accepted"; record: RunRecord }
	| { schemaVersion: 1; kind: "started"; runId: RunId; startedAt: string }
	| { schemaVersion: 1; kind: "terminal"; receipt: RunReceipt; endedAt: string };

/**
 * Metadata-only capability binding snapshot persisted as a Session custom entry.
 * Mirrors the shape of the Registry's redacted binding view; it deliberately
 * carries no environment values, header values, tokens, MCP config, server
 * instructions, or tool call payloads.
 */
export interface CapabilityBindingLedgerRecord {
	id: string;
	profile: string;
	createdAt: string;
	descriptors: ReadonlyArray<{ id: string; revision: string; exposedToolName?: string }>;
	decisionSummary: { allowed: number; awaitingApproval: number; denied: number };
	toolAllowlist: ReadonlyArray<string>;
}

export interface PersistedCapabilityBindingEntry {
	schemaVersion: 1;
	binding: CapabilityBindingLedgerRecord;
}

// ---- Errors ----------------------------------------------------------------

export type AutomationErrorCode =
	| "unsupported_protocol_version"
	| "host_not_initialized"
	| "session_busy"
	| "start_rejected"
	| "run_not_found"
	| "run_not_cancellable"
	| "session_not_persistent"
	| "source_run_not_found"
	| "source_run_not_resumable"
	| "session_switch_cancelled"
	| "ledger_persistence_failed"
	// Capability preflight / resume failures. These keep profile, connection,
	// authorization and binding problems in the structured Automation Host error
	// contract instead of degrading them into generic model failures.
	| "capability_profile_not_found"
	| "capability_denied"
	| "capability_approval_required"
	| "capability_name_conflict"
	| "capability_mcp_connect_failed"
	| "capability_mcp_auth_required"
	| "capability_mcp_unavailable"
	| "capability_binding_unavailable"
	// Terminal run.failed receipt code; not a command-level error.
	| "model_error";

export interface AutomationError {
	code: AutomationErrorCode;
	message: string;
	retryable: boolean;
}

export function createAutomationError(code: AutomationErrorCode, message: string, retryable: boolean): AutomationError {
	return { code, message, retryable };
}

export function isAutomationErrorCode(value: unknown): value is AutomationErrorCode {
	return (
		value === "unsupported_protocol_version" ||
		value === "host_not_initialized" ||
		value === "session_busy" ||
		value === "start_rejected" ||
		value === "run_not_found" ||
		value === "run_not_cancellable" ||
		value === "session_not_persistent" ||
		value === "source_run_not_found" ||
		value === "source_run_not_resumable" ||
		value === "session_switch_cancelled" ||
		value === "ledger_persistence_failed" ||
		value === "capability_profile_not_found" ||
		value === "capability_denied" ||
		value === "capability_approval_required" ||
		value === "capability_name_conflict" ||
		value === "capability_mcp_connect_failed" ||
		value === "capability_mcp_auth_required" ||
		value === "capability_mcp_unavailable" ||
		value === "capability_binding_unavailable" ||
		value === "model_error"
	);
}

// ---- Secret redaction ---------------------------------------------------------

/** Scheme with optional URL userinfo (user:pass@) — group 1 is kept, group 2 is the host/path. */
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)(?:[^/@\s]+@)?([^\s?#]*)/gi;
/** Well-known secret assignments such as `token=...` / `authorization: Bearer <jwt>` / `api_key=...`. */
const SECRET_ASSIGNMENT_PATTERN = /\b(bearer|token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*(?:bearer\s+)?[^\s"'`,;]+/gi;
/** A bare `Bearer <token>` not preceded by a secret key assignment. */
const BEARER_TOKEN_PATTERN = /\bbearer\s+[^\s"'`,;]+/gi;

/**
 * Scrub obvious secrets from free text so error messages serialized to stdout
 * never echo credentials, header values, URL userinfo, or Bearer tokens. The
 * entire secret value is removed or replaced — it is never left partially
 * visible. Conservative: only well-known secret shapes are masked; ordinary
 * messages pass through unchanged.
 */
export function redactErrorText(text: string): string {
	const urlRedacted = text.replace(URL_USERINFO_PATTERN, "$1$2");
	const assignmentsRedacted = urlRedacted.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[redacted]`);
	return assignmentsRedacted.replace(BEARER_TOKEN_PATTERN, "[redacted]");
}

/** Clone an AutomationError with a secret-free message. */
export function redactAutomationError(error: AutomationError): AutomationError {
	const message = redactErrorText(error.message);
	return message === error.message ? error : createAutomationError(error.code, message, error.retryable);
}

// ---- Diagnostics ------------------------------------------------------------

export type LedgerDiagnostic =
	| { kind: "malformed"; entryId: string; detail: string }
	| { kind: "unknown-schema-version"; entryId: string; version: number }
	| { kind: "unknown-ledger-kind"; entryId: string; ledgerKind: string }
	| { kind: "orphan-fact"; entryId: string; runId: RunId; fact: "started" | "terminal" }
	| { kind: "duplicate-terminal"; runId: RunId }
	| { kind: "malformed-binding"; entryId: string; detail: string };

export function formatDiagnostic(diag: LedgerDiagnostic): string {
	switch (diag.kind) {
		case "malformed":
			return `automation.run ledger: custom entry ${diag.entryId} is malformed (${diag.detail}); skipped`;
		case "unknown-schema-version":
			return `automation.run ledger: custom entry ${diag.entryId} uses schemaVersion ${diag.version}; skipped`;
		case "unknown-ledger-kind":
			return `automation.run ledger: custom entry ${diag.entryId} has unknown kind ${diag.ledgerKind}; skipped`;
		case "orphan-fact":
			return `automation.run ledger: ${diag.fact} fact for unknown run ${diag.runId} (entry ${diag.entryId}); skipped`;
		case "duplicate-terminal":
			return `automation.run: run ${diag.runId} is already terminal; second terminal ignored`;
		case "malformed-binding":
			return `capability.binding ledger: custom entry ${diag.entryId} is malformed (${diag.detail}); skipped`;
	}
}

// ---- Coordinator contract ----------------------------------------------------

/** Structural subset of `SessionManager` used to persist and fold the run ledger. */
export interface RunLedgerSession {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	appendCustomEntry(customType: string, data?: unknown): string;
	getEntries(): SessionEntry[];
}

export interface RunResult {
	record: RunRecord;
	receipt?: RunReceipt;
	recovery?: RunRecoveryState;
}

export interface AcceptOptions {
	runId?: RunId;
	sourceRunId?: RunId;
	/** Binding id of the source run this attempt resumes from. */
	previousBindingId?: string;
	attempt: number;
	model: RunModelReference;
	/**
	 * Metadata-only binding snapshot to persist as a capability.binding custom
	 * entry. Its id becomes the run receipt's capabilityBindingId.
	 */
	capabilityBinding?: CapabilityBindingLedgerRecord;
}

export interface RunReservation {
	readonly sessionId: SessionId;
	/** Buffer a session event observed during preflight; flushed by start(). */
	captureSessionEvent(event: AgentSessionEvent): void;
	/** Persist the accepted fact and create the run. Throws if already accepted/released. */
	accept(options: AcceptOptions): RunHandle;
	/** Discard the reservation without persisting anything. */
	release(): void;
}

export interface SettleInput {
	outcome: "completed" | "failed";
	terminalError?: AutomationError;
	finalText?: string;
	currentUsage?: RunUsageSnapshot;
	/** Snapshot id explicitly bound to this run's model call(s). */
	contextSnapshotId?: string;
}

export interface RunHandle {
	readonly runId: RunId;
	readonly sessionId: SessionId;
	readonly record: RunRecord;
	/** Highest sequence emitted so far (0 before start()). */
	readonly sequence: number;
	readonly cancelled: boolean;
	readonly emitted: readonly RunStreamEvent[];
	readonly terminal: RunStreamEvent | undefined;
	/** Persist the started fact and flush the buffered session events. */
	start(): RunStreamEvent[];
	/**
	 * Buffer a session event before start, or wrap it as a run.event while running.
	 * Returns the emitted event when running; undefined when buffered or terminal.
	 */
	captureSessionEvent(event: AgentSessionEvent): RunStreamEvent | undefined;
	/** Record cancellation intent only; the terminal event is produced by settle(). */
	requestCancel(): void;
	setUsageBaseline(baseline: RunUsageSnapshot): void;
	computeUsageDelta(current: RunUsageSnapshot): RunUsage;
	finalText(): string;
	/** Persist the unique terminal fact and emit the unique terminal event. */
	settle(input: SettleInput): RunStreamEvent | undefined;
	receipt(): RunReceipt | undefined;
	result(): RunResult;
}

export interface RunLifecycleCoordinatorOptions {
	/** ISO timestamp source. Defaults to Date.now().toISOString(). */
	now?: () => string;
	/** Run id generator for auto-assigned ids. Defaults to a fresh randomUUID per coordinator. */
	runId?: () => RunId;
	/** Diagnostics sink; defaults to stderr. */
	diagnostics?: (message: string) => void;
}

export interface RunLifecycleCoordinator {
	readonly sessionId: SessionId;
	readonly activeRun: RunResult | undefined;
	/** Synchronously lock the session; throws session_busy when a run is active. */
	reserve(): RunReservation;
	getRun(runId: RunId): RunResult | undefined;
	getActiveRun(): RunResult | undefined;
	rebuildIndex(): ReadonlyMap<RunId, RunResult>;
	/** Fold the Session's capability.binding custom entries into a redacted history. */
	getCapabilityBindings(): ReadonlyMap<string, CapabilityBindingLedgerRecord>;
	/** Append a schemaVersion 1 capability.binding custom entry. */
	persistCapabilityBinding(binding: CapabilityBindingLedgerRecord): void;
	diagnostics(): readonly LedgerDiagnostic[];
}

// ---- Ledger parsing ----------------------------------------------------------

type ParsedLedgerEntry =
	| { ok: true; entry: PersistedRunLedgerEntry }
	| { ok: false; reason: "malformed"; detail: string }
	| { ok: false; reason: "unknown-schema-version"; version: number }
	| { ok: false; reason: "unknown-ledger-kind"; kind: string };

function isThinkingLevel(value: unknown): value is ThinkingLevel {
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

function isRunStatus(value: unknown): value is RunStatus {
	return (
		value === "accepted" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled"
	);
}

function isRunTerminalStatus(value: unknown): value is RunTerminalStatus {
	return value === "completed" || value === "failed" || value === "cancelled";
}

function isAutomationError(value: unknown): value is AutomationError {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return isAutomationErrorCode(obj.code) && typeof obj.message === "string" && typeof obj.retryable === "boolean";
}

function isRunModelReference(value: unknown): value is RunModelReference {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return typeof obj.provider === "string" && typeof obj.id === "string" && isThinkingLevel(obj.thinkingLevel);
}

function isRunUsage(value: unknown): value is RunUsage {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return typeof obj.input === "number" && typeof obj.output === "number" && typeof obj.total === "number";
}

function isRunRecord(value: unknown): value is RunRecord {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.id !== "string" || typeof obj.sessionId !== "string") return false;
	if (typeof obj.attempt !== "number") return false;
	if (!isRunStatus(obj.status)) return false;
	if (!isRunModelReference(obj.model)) return false;
	if (obj.sourceRunId !== undefined && typeof obj.sourceRunId !== "string") return false;
	if (obj.previousBindingId !== undefined && typeof obj.previousBindingId !== "string") return false;
	if (obj.capabilityBindingId !== undefined && typeof obj.capabilityBindingId !== "string") return false;
	if (obj.startedAt !== undefined && typeof obj.startedAt !== "string") return false;
	if (obj.endedAt !== undefined && typeof obj.endedAt !== "string") return false;
	if (obj.terminalError !== undefined && !isAutomationError(obj.terminalError)) return false;
	return true;
}

function isRunReceipt(value: unknown): value is RunReceipt {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.runId !== "string" || typeof obj.sessionId !== "string") return false;
	if (!isRunTerminalStatus(obj.status)) return false;
	if (!isRunUsage(obj.usage)) return false;
	if (obj.finalText !== undefined && typeof obj.finalText !== "string") return false;
	if (obj.sessionFile !== undefined && typeof obj.sessionFile !== "string") return false;
	if (obj.terminalError !== undefined && !isAutomationError(obj.terminalError)) return false;
	if (obj.contextSnapshotId !== undefined && typeof obj.contextSnapshotId !== "string") return false;
	if (obj.capabilityBindingId !== undefined && typeof obj.capabilityBindingId !== "string") return false;
	return true;
}

function parseLedgerEntry(value: unknown): ParsedLedgerEntry {
	if (typeof value !== "object" || value === null) {
		return { ok: false, reason: "malformed", detail: "data is not an object" };
	}
	const obj = value as Record<string, unknown>;
	const schemaVersion = obj.schemaVersion;
	if (typeof schemaVersion !== "number") {
		return { ok: false, reason: "malformed", detail: "schemaVersion is not a number" };
	}
	if (schemaVersion !== RUN_LEDGER_SCHEMA_VERSION) {
		return { ok: false, reason: "unknown-schema-version", version: schemaVersion };
	}
	const kind = obj.kind;
	if (typeof kind !== "string") {
		return { ok: false, reason: "malformed", detail: "kind is missing" };
	}
	if (kind === "accepted") {
		if (!isRunRecord(obj.record)) {
			return { ok: false, reason: "malformed", detail: "accepted entry has an invalid record" };
		}
		return { ok: true, entry: { schemaVersion: 1, kind: "accepted", record: obj.record } };
	}
	if (kind === "started") {
		if (typeof obj.runId !== "string" || typeof obj.startedAt !== "string") {
			return { ok: false, reason: "malformed", detail: "started entry lacks runId/startedAt" };
		}
		return { ok: true, entry: { schemaVersion: 1, kind: "started", runId: obj.runId, startedAt: obj.startedAt } };
	}
	if (kind === "terminal") {
		if (typeof obj.endedAt !== "string" || !isRunReceipt(obj.receipt)) {
			return { ok: false, reason: "malformed", detail: "terminal entry has an invalid receipt/endedAt" };
		}
		return { ok: true, entry: { schemaVersion: 1, kind: "terminal", receipt: obj.receipt, endedAt: obj.endedAt } };
	}
	return { ok: false, reason: "unknown-ledger-kind", kind };
}

function toDiagnostic(parsed: Extract<ParsedLedgerEntry, { ok: false }>, entryId: string): LedgerDiagnostic {
	if (parsed.reason === "malformed") {
		return { kind: "malformed", entryId, detail: parsed.detail };
	}
	if (parsed.reason === "unknown-schema-version") {
		return { kind: "unknown-schema-version", entryId, version: parsed.version };
	}
	return { kind: "unknown-ledger-kind", entryId, ledgerKind: parsed.kind };
}

// ---- Capability binding ledger parsing -----------------------------------------

function isCapabilityBindingLedgerRecord(value: unknown): value is CapabilityBindingLedgerRecord {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.id !== "string" || typeof obj.profile !== "string" || typeof obj.createdAt !== "string") return false;
	if (!Array.isArray(obj.descriptors)) return false;
	for (const descriptor of obj.descriptors) {
		if (typeof descriptor !== "object" || descriptor === null) return false;
		const ref = descriptor as Record<string, unknown>;
		if (typeof ref.id !== "string" || typeof ref.revision !== "string") return false;
		if (ref.exposedToolName !== undefined && typeof ref.exposedToolName !== "string") return false;
	}
	const summary = obj.decisionSummary;
	if (typeof summary !== "object" || summary === null) return false;
	const decisionSummary = summary as Record<string, unknown>;
	if (
		typeof decisionSummary.allowed !== "number" ||
		typeof decisionSummary.awaitingApproval !== "number" ||
		typeof decisionSummary.denied !== "number"
	) {
		return false;
	}
	if (!Array.isArray(obj.toolAllowlist) || obj.toolAllowlist.some((name) => typeof name !== "string")) return false;
	return true;
}

function parseCapabilityBindingEntry(
	value: unknown,
	entryId: string,
): { ok: true; entry: PersistedCapabilityBindingEntry } | { ok: false; diag: { kind: "malformed-binding"; entryId: string; detail: string } } {
	if (typeof value !== "object" || value === null) {
		return { ok: false, diag: { kind: "malformed-binding", entryId, detail: "data is not an object" } };
	}
	const obj = value as Record<string, unknown>;
	if (obj.schemaVersion !== CAPABILITY_BINDING_SCHEMA_VERSION) {
		return {
			ok: false,
			diag: {
				kind: "malformed-binding",
				entryId,
				detail: `schemaVersion is not ${CAPABILITY_BINDING_SCHEMA_VERSION}`,
			},
		};
	}
	if (!isCapabilityBindingLedgerRecord(obj.binding)) {
		return { ok: false, diag: { kind: "malformed-binding", entryId, detail: "binding is invalid" } };
	}
	return { ok: true, entry: { schemaVersion: 1, binding: obj.binding } };
}

/**
 * Fold the Session's `capability.binding` custom entries into a redacted binding
 * history keyed by binding id (later records for the same id win). Malformed
 * entries are skipped and reported through the optional diagnostics sink.
 */
export function foldCapabilityBindingEntries(
	entries: ReadonlyArray<SessionEntry>,
	diagnostics?: (diag: LedgerDiagnostic) => void,
): ReadonlyMap<string, CapabilityBindingLedgerRecord> {
	const bindings = new Map<string, CapabilityBindingLedgerRecord>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CAPABILITY_BINDING_CUSTOM_TYPE) continue;
		const parsed = parseCapabilityBindingEntry(entry.data, entry.id);
		if (!parsed.ok) {
			diagnostics?.(parsed.diag);
			continue;
		}
		bindings.set(parsed.entry.binding.id, parsed.entry.binding);
	}
	return bindings;
}

// ---- Text and usage helpers --------------------------------------------------

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") text += candidate.text;
	}
	return text;
}

function extractAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return extractTextContent(message.content);
}

function nonNegative(value: number): number {
	return value > 0 ? value : 0;
}

function cloneAutomationError(error: AutomationError): AutomationError {
	// Always produce a fresh, secret-free object so replay never re-exposes a raw
	// terminalError that may have been persisted by an older version.
	return redactAutomationError({ code: error.code, message: error.message, retryable: error.retryable });
}

function cloneRunRecord(record: RunRecord): RunRecord {
	const copy: RunRecord = {
		id: record.id,
		sessionId: record.sessionId,
		attempt: record.attempt,
		status: record.status,
		model: { ...record.model },
	};
	if (record.sourceRunId !== undefined) copy.sourceRunId = record.sourceRunId;
	if (record.previousBindingId !== undefined) copy.previousBindingId = record.previousBindingId;
	if (record.capabilityBindingId !== undefined) copy.capabilityBindingId = record.capabilityBindingId;
	if (record.startedAt !== undefined) copy.startedAt = record.startedAt;
	if (record.endedAt !== undefined) copy.endedAt = record.endedAt;
	if (record.terminalError !== undefined) copy.terminalError = cloneAutomationError(record.terminalError);
	return copy;
}

function cloneRunReceipt(receipt: RunReceipt): RunReceipt {
	const copy: RunReceipt = {
		runId: receipt.runId,
		sessionId: receipt.sessionId,
		status: receipt.status,
		usage: { input: receipt.usage.input, output: receipt.usage.output, total: receipt.usage.total },
	};
	if (receipt.finalText !== undefined) copy.finalText = receipt.finalText;
	if (receipt.sessionFile !== undefined) copy.sessionFile = receipt.sessionFile;
	if (receipt.terminalError !== undefined) copy.terminalError = cloneAutomationError(receipt.terminalError);
	if (receipt.contextSnapshotId !== undefined) copy.contextSnapshotId = receipt.contextSnapshotId;
	if (receipt.capabilityBindingId !== undefined) copy.capabilityBindingId = receipt.capabilityBindingId;
	return copy;
}

// ---- Run handle --------------------------------------------------------------

class RunHandleImpl implements RunHandle {
	readonly runId: RunId;
	readonly sessionId: SessionId;

	private readonly coordinator: RunLifecycleCoordinatorImpl;
	private readonly _record: RunRecord;
	private readonly _capabilityBindingId: string | undefined;
	private _sequence = 0;
	private _cancelled = false;
	private _finalText = "";
	private _usageBaseline: RunUsageSnapshot | undefined;
	private readonly _buffered: AgentSessionEvent[] = [];
	private readonly _emitted: RunStreamEvent[] = [];
	private _receipt: RunReceipt | undefined;

	constructor(coordinator: RunLifecycleCoordinatorImpl, sessionId: SessionId, options: AcceptOptions) {
		this.coordinator = coordinator;
		this.sessionId = sessionId;
		this.runId = options.runId ?? coordinator.nextRunId();
		this._capabilityBindingId = options.capabilityBinding?.id;
		this._record = {
			id: this.runId,
			sessionId,
			attempt: options.attempt,
			status: "accepted",
			model: options.model,
		};
		if (options.sourceRunId !== undefined) {
			this._record.sourceRunId = options.sourceRunId;
		}
		if (options.previousBindingId !== undefined) {
			this._record.previousBindingId = options.previousBindingId;
		}
		if (options.capabilityBinding !== undefined) {
			this._record.capabilityBindingId = options.capabilityBinding.id;
		}
	}

	get record(): RunRecord {
		return { ...this._record };
	}

	get sequence(): number {
		return this._sequence;
	}

	get cancelled(): boolean {
		return this._cancelled;
	}

	get emitted(): readonly RunStreamEvent[] {
		return this._emitted;
	}

	get terminal(): RunStreamEvent | undefined {
		for (let i = this._emitted.length - 1; i >= 0; i -= 1) {
			const event = this._emitted[i];
			if (
				event.type === "run.completed" ||
				event.type === "run.failed" ||
				event.type === "run.cancelled"
			) {
				return event;
			}
		}
		return undefined;
	}

	start(): RunStreamEvent[] {
		if (this._record.status === "running" || isTerminalStatus(this._record.status)) return [];
		const startedAt = this.coordinator.now();
		this.coordinator.persist({ schemaVersion: 1, kind: "started", runId: this.runId, startedAt });
		this._record.status = "running";
		this._record.startedAt = startedAt;
		const events: RunStreamEvent[] = [this.emitStream("run.started")];
		for (const event of this._buffered.splice(0)) {
			events.push(this.emitRunEvent(event));
		}
		return events;
	}

	captureSessionEvent(event: AgentSessionEvent): RunStreamEvent | undefined {
		this.captureFinalText(event);
		if (isTerminalStatus(this._record.status)) return undefined;
		if (this._record.status === "running") {
			return this.emitRunEvent(event);
		}
		this._buffered.push(event);
		return undefined;
	}

	requestCancel(): void {
		this._cancelled = true;
	}

	setUsageBaseline(baseline: RunUsageSnapshot): void {
		this._usageBaseline = { input: baseline.input, output: baseline.output, total: baseline.total };
	}

	computeUsageDelta(current: RunUsageSnapshot): RunUsage {
		const baseline = this._usageBaseline;
		return {
			input: nonNegative(current.input - (baseline?.input ?? 0)),
			output: nonNegative(current.output - (baseline?.output ?? 0)),
			total: nonNegative(current.total - (baseline?.total ?? 0)),
		};
	}

	finalText(): string {
		return this._finalText;
	}

	settle(input: SettleInput): RunStreamEvent | undefined {
		if (this._receipt !== undefined) {
			this.coordinator.recordDiagnostic({ kind: "duplicate-terminal", runId: this.runId });
			return undefined;
		}
		// Redact the terminal error once so the persisted receipt, the retained
		// record, and the emitted terminal event all carry a secret-free message.
		const terminalError = input.terminalError !== undefined ? redactAutomationError(input.terminalError) : undefined;
		const status: RunTerminalStatus = this._cancelled ? "cancelled" : input.outcome;
		const endedAt = this.coordinator.now();
		const receipt: RunReceipt = {
			runId: this.runId,
			sessionId: this.sessionId,
			status,
			usage: this.computeUsageDelta(input.currentUsage ?? { input: 0, output: 0, total: 0 }),
		};
		const finalText = input.finalText ?? this._finalText;
		if (finalText !== "") receipt.finalText = finalText;
		const sessionFile = this.coordinator.session.getSessionFile();
		if (sessionFile !== undefined) receipt.sessionFile = sessionFile;
		if (terminalError !== undefined) receipt.terminalError = terminalError;
		const contextSnapshotId = input.contextSnapshotId;
		if (contextSnapshotId !== undefined) receipt.contextSnapshotId = contextSnapshotId;
		const capabilityBindingId = this._capabilityBindingId;
		if (capabilityBindingId !== undefined) receipt.capabilityBindingId = capabilityBindingId;
		this.coordinator.persist({ schemaVersion: 1, kind: "terminal", receipt, endedAt });
		this._receipt = receipt;
		this._record.status = status;
		this._record.endedAt = endedAt;
		if (terminalError !== undefined) this._record.terminalError = terminalError;
		const event = this.emitTerminal(status, receipt);
		this.coordinator.onTerminal(this);
		return event;
	}

	receipt(): RunReceipt | undefined {
		return this._receipt === undefined ? undefined : { ...this._receipt };
	}

	result(): RunResult {
		const result: RunResult = { record: this.record };
		if (this._receipt !== undefined) result.receipt = { ...this._receipt };
		if (!isTerminalStatus(this._record.status)) result.recovery = "interrupted";
		return result;
	}

	private emitStream(type: "run.started"): RunStreamEvent {
		this._sequence += 1;
		const event: RunStreamEvent = {
			type,
			runId: this.runId,
			sessionId: this.sessionId,
			sequence: this._sequence,
			timestamp: this.coordinator.now(),
		};
		this._emitted.push(event);
		return event;
	}

	private emitRunEvent(event: AgentSessionEvent): RunStreamEvent {
		this._sequence += 1;
		const wrapped: RunStreamEvent = {
			type: "run.event",
			runId: this.runId,
			sessionId: this.sessionId,
			sequence: this._sequence,
			timestamp: this.coordinator.now(),
			event,
		};
		this._emitted.push(wrapped);
		return wrapped;
	}

	private emitTerminal(status: RunTerminalStatus, receipt: RunReceipt): RunStreamEvent {
		this._sequence += 1;
		const event: RunStreamEvent = {
			type: status === "completed" ? "run.completed" : status === "failed" ? "run.failed" : "run.cancelled",
			runId: this.runId,
			sessionId: this.sessionId,
			sequence: this._sequence,
			timestamp: this.coordinator.now(),
			receipt,
		};
		this._emitted.push(event);
		return event;
	}

	private captureFinalText(event: AgentSessionEvent): void {
		if (event.type === "message_end") {
			const text = extractAssistantText(event.message);
			if (text !== "") this._finalText = text;
		} else if (event.type === "agent_end") {
			for (let i = event.messages.length - 1; i >= 0; i -= 1) {
				const text = extractAssistantText(event.messages[i]);
				if (text !== "") {
					this._finalText = text;
					break;
				}
			}
		}
	}
}

// ---- Reservation --------------------------------------------------------------

class RunReservationImpl implements RunReservation {
	readonly sessionId: SessionId;

	private readonly coordinator: RunLifecycleCoordinatorImpl;
	private readonly _buffered: AgentSessionEvent[] = [];
	private consumed = false;

	constructor(coordinator: RunLifecycleCoordinatorImpl) {
		this.coordinator = coordinator;
		this.sessionId = coordinator.sessionId;
	}

	captureSessionEvent(event: AgentSessionEvent): void {
		if (!this.consumed) this._buffered.push(event);
	}

	accept(options: AcceptOptions): RunHandle {
		if (this.consumed) {
			throw createAutomationError("start_rejected", "reservation has already been accepted or released", false);
		}
		const run = new RunHandleImpl(this.coordinator, this.sessionId, options);
		try {
			this.coordinator.persist({ schemaVersion: 1, kind: "accepted", record: run.record });
			if (options.capabilityBinding !== undefined) {
				this.coordinator.persistCapabilityBinding(options.capabilityBinding);
			}
		} catch (error) {
			// Consume and release the held reservation so the session is free for the next reserve.
			this.consumed = true;
			this.coordinator.confirmRelease(this);
			throw error;
		}
		this.consumed = true;
		this.coordinator.confirmAccept(run);
		for (const event of this._buffered.splice(0)) {
			run.captureSessionEvent(event);
		}
		return run;
	}

	release(): void {
		if (this.consumed) return;
		this.consumed = true;
		this.coordinator.confirmRelease(this);
	}
}

// ---- Coordinator --------------------------------------------------------------

class RunLifecycleCoordinatorImpl implements RunLifecycleCoordinator {
	readonly sessionId: SessionId;
	readonly session: RunLedgerSession;

	private readonly nowFn: () => string;
	private readonly runIdFn: () => RunId;
	private readonly diagnosticsSink: (message: string) => void;
	private readonly runs = new Map<RunId, RunHandleImpl>();
	private readonly diagnosedEntries = new Set<string>();
	private readonly _diagnostics: LedgerDiagnostic[] = [];
	private _capabilityBindings = new Map<string, CapabilityBindingLedgerRecord>();
	private _active: RunHandleImpl | undefined;
	private _reserved: RunReservationImpl | undefined;

	constructor(session: RunLedgerSession, options: RunLifecycleCoordinatorOptions = {}) {
		this.session = session;
		this.sessionId = session.getSessionId();
		this.nowFn = options.now ?? (() => new Date().toISOString());
		this.runIdFn = options.runId ?? (() => randomUUID());
		this.diagnosticsSink = options.diagnostics ?? ((message) => console.error(message));
	}

	get activeRun(): RunResult | undefined {
		return this._active?.result();
	}

	now(): string {
		return this.nowFn();
	}

	nextRunId(): RunId {
		return this.runIdFn();
	}

	reserve(): RunReservation {
		if (this._active !== undefined) {
			throw createAutomationError(
				"session_busy",
				`Session ${this.sessionId} already has an active run (${this._active.runId})`,
				true,
			);
		}
		if (this._reserved !== undefined) {
			throw createAutomationError("session_busy", `Session ${this.sessionId} already has a pending reservation`, true);
		}
		const reservation = new RunReservationImpl(this);
		this._reserved = reservation;
		return reservation;
	}

	getActiveRun(): RunResult | undefined {
		return this.activeRun;
	}

	getRun(runId: RunId): RunResult | undefined {
		const live = this.runs.get(runId);
		if (live !== undefined) return live.result();
		return this.rebuildIndex().get(runId);
	}

	rebuildIndex(): ReadonlyMap<RunId, RunResult> {
		const results = new Map<RunId, RunResult>();
		const bindings = new Map<string, CapabilityBindingLedgerRecord>();
		for (const entry of this.session.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === CAPABILITY_BINDING_CUSTOM_TYPE) {
				const parsed = parseCapabilityBindingEntry(entry.data, entry.id);
				if (!parsed.ok) {
					this.emitIfNew(entry.id, parsed.diag);
					continue;
				}
				bindings.set(parsed.entry.binding.id, parsed.entry.binding);
				continue;
			}
			if (entry.customType !== RUN_LEDGER_CUSTOM_TYPE) continue;
			const parsed = parseLedgerEntry(entry.data);
			if (!parsed.ok) {
				this.emitIfNew(entry.id, toDiagnostic(parsed, entry.id));
				continue;
			}
			const fact = parsed.entry;
			if (fact.kind === "accepted") {
				const existing = results.get(fact.record.id);
				// Clone before applying later facts so the persisted entry.data is never mutated.
				const record = cloneRunRecord(fact.record);
				if (existing === undefined) {
					results.set(fact.record.id, { record });
				} else {
					existing.record = record;
				}
			} else if (fact.kind === "started") {
				const result = results.get(fact.runId);
				if (result === undefined) {
					this.emitIfNew(entry.id, { kind: "orphan-fact", entryId: entry.id, runId: fact.runId, fact: "started" });
					continue;
				}
				result.record.startedAt = fact.startedAt;
				result.record.status = "running";
			} else {
				const result = results.get(fact.receipt.runId);
				if (result === undefined) {
					this.emitIfNew(entry.id, {
						kind: "orphan-fact",
						entryId: entry.id,
						runId: fact.receipt.runId,
						fact: "terminal",
					});
					continue;
				}
				if (result.receipt !== undefined) {
					// Already terminal; first receipt wins and the duplicate is a diagnostic.
					this.emitIfNew(entry.id, { kind: "duplicate-terminal", runId: fact.receipt.runId });
					continue;
				}
				result.receipt = cloneRunReceipt(fact.receipt);
				result.record.status = fact.receipt.status;
				result.record.endedAt = fact.endedAt;
				if (fact.receipt.terminalError !== undefined) {
					result.record.terminalError = cloneAutomationError(fact.receipt.terminalError);
				}
			}
		}
		for (const result of results.values()) {
			if (result.receipt === undefined) result.recovery = "interrupted";
		}
		this._capabilityBindings = bindings;
		return results;
	}

	diagnostics(): readonly LedgerDiagnostic[] {
		return this._diagnostics;
	}

	persist(entry: PersistedRunLedgerEntry): void {
		try {
			this.session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, entry);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw createAutomationError("ledger_persistence_failed", `failed to persist run ledger entry: ${detail}`, false);
		}
	}

	getCapabilityBindings(): ReadonlyMap<string, CapabilityBindingLedgerRecord> {
		// Re-fold from the session ledger so persisted bindings written by an
		// earlier coordinator (or a previous process) are visible.
		this.rebuildIndex();
		return this._capabilityBindings;
	}

	persistCapabilityBinding(binding: CapabilityBindingLedgerRecord): void {
		try {
			this.session.appendCustomEntry(CAPABILITY_BINDING_CUSTOM_TYPE, {
				schemaVersion: CAPABILITY_BINDING_SCHEMA_VERSION,
				binding,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw createAutomationError("ledger_persistence_failed", `failed to persist capability binding entry: ${detail}`, false);
		}
	}

	recordDiagnostic(diag: LedgerDiagnostic): void {
		this._diagnostics.push(diag);
		this.diagnosticsSink(formatDiagnostic(diag));
	}

	confirmAccept(run: RunHandleImpl): void {
		this._reserved = undefined;
		this.registerRun(run);
	}

	confirmRelease(reservation: RunReservationImpl): void {
		if (this._reserved === reservation) this._reserved = undefined;
	}

	registerRun(run: RunHandleImpl): void {
		this.runs.set(run.runId, run);
		this._active = run;
	}

	onTerminal(run: RunHandleImpl): void {
		if (this._active === run) this._active = undefined;
	}

	private emitIfNew(entryId: string, diag: LedgerDiagnostic): void {
		if (this.diagnosedEntries.has(entryId)) return;
		this.diagnosedEntries.add(entryId);
		this.recordDiagnostic(diag);
	}
}

export function createRunLifecycleCoordinator(
	session: RunLedgerSession,
	options?: RunLifecycleCoordinatorOptions,
): RunLifecycleCoordinator {
	return new RunLifecycleCoordinatorImpl(session, options);
}
