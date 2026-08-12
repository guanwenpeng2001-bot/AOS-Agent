/**
 * Persistence adapter for ModelBroker binding and attempt facts.
 *
 * The adapter deliberately knows only the structural Session custom-entry
 * contract. It does not own a provider, a credential, a stream, or a live
 * broker object. Replaying this ledger reconstructs safe audit facts only.
 */

import type { ThinkingLevel } from "@aos-agent/agent-core";

export const MODEL_BROKER_LEDGER_SCHEMA_VERSION = 1;
export const MODEL_BINDING_SCHEMA_VERSION = 1;
export const MODEL_ATTEMPT_SCHEMA_VERSION = 1;
export const MODEL_BINDING_CUSTOM_TYPE = "model.binding";
export const MODEL_ATTEMPT_CUSTOM_TYPE = "model.attempt";

export type ModelBindingMode = "manual" | "route" | "direct";
export type ModelAttemptStatus = "started" | "completed" | "failed" | "cancelled";

/** Safe model identity shared structurally with ModelBroker. */
export interface ModelReference {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * A route candidate. The `model` form is the canonical form used by the
 * ledger. Optional flattened fields are accepted at the adapter boundary so
 * the ledger can consume an early ModelBroker implementation without copying
 * provider configuration into the entry.
 */
export interface ModelRouteCandidate {
	order: number;
	model: ModelReference;
}

/** Alias used by callers that name route candidates as binding candidates. */
export type ModelBindingCandidate = ModelRouteCandidate;

export type ModelFailureCategory =
	| "provider_unavailable"
	| "transient_provider_error"
	| "authentication_required"
	| "authentication"
	| "auth_error"
	| "configuration_error"
	| "configuration"
	| "config_error"
	| "context_error"
	| "context"
	| "budget_exceeded"
	| "budget"
	| "budget_error"
	| "cancelled"
	| "cancellation"
	| "aborted"
	| "tool_error"
	| "tool"
	| "partial_output"
	| "invalid_request"
	| "unknown";

export interface ModelFallbackPolicy {
	maxAttempts: number;
	on: ReadonlyArray<"provider_unavailable" | "transient_provider_error">;
}

export interface ModelBudgetLimit {
	maxModelCalls?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxTotalTokens?: number;
	maxCostUsd?: number;
}

/** Metadata-only usage from one actual candidate dispatch. */
export interface ModelUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	/** Compatibility aliases for the existing Run usage vocabulary. */
	input?: number;
	output?: number;
	total?: number;
	cost?: number;
}

export interface ModelBindingLedgerRecord {
	bindingId: string;
	mode: ModelBindingMode;
	routeId?: string;
	role?: string;
	candidates: ReadonlyArray<ModelRouteCandidate>;
	fallback: ModelFallbackPolicy;
	budget: ModelBudgetLimit;
	configRevision: string;
	createdAt: string;
	previousModelBindingId?: string;
}

/** Alias used by callers that refer to a binding as a value object. */
export type ModelBinding = ModelBindingLedgerRecord;

export interface ModelAttemptLedgerRecord {
	attemptId: string;
	bindingId: string;
	candidate: ModelReference;
	order: number;
	status: ModelAttemptStatus;
	startedAt: string;
	endedAt?: string;
	failureCategory?: ModelFailureCategory | string;
	usage?: ModelUsage;
	visibleOutput?: boolean;
	contextSnapshotId?: string;
	/** Short, already-safe audit summary; raw provider errors are not accepted. */
	summary?: string;
}

/** Alias used by callers that refer to an attempt as a value object. */
export type ModelAttempt = ModelAttemptLedgerRecord;

export interface PersistedModelBindingEntry {
	schemaVersion: 1;
	binding: ModelBindingLedgerRecord;
}

export interface PersistedModelAttemptEntry {
	schemaVersion: 1;
	attempt: ModelAttemptLedgerRecord;
}

export type PersistedModelBrokerLedgerEntry =
	| { customType: typeof MODEL_BINDING_CUSTOM_TYPE; data: PersistedModelBindingEntry }
	| { customType: typeof MODEL_ATTEMPT_CUSTOM_TYPE; data: PersistedModelAttemptEntry };

export interface ModelBrokerLedgerSession {
	appendCustomEntry(customType: string, data?: unknown): string;
	getEntries(): ReadonlyArray<ModelBrokerLedgerEntry>;
}

/** Minimal entry shape accepted by the ledger; full SessionEntry values fit it. */
export interface ModelBrokerLedgerEntry {
	id?: string;
	type?: string;
	customType?: string;
	data?: unknown;
}

export type ModelBrokerLedgerDiagnostic =
	| { kind: "malformed"; entryId: string; customType: string; detail: string }
	| { kind: "unknown-schema-version"; entryId: string; customType: string; version: number }
	| { kind: "unknown-ledger-kind"; entryId: string; customType: string }
	| { kind: "orphan-attempt"; entryId: string; attemptId: string; bindingId: string }
	| { kind: "duplicate-terminal"; entryId: string; attemptId: string }
	| { kind: "duplicate-binding"; entryId: string; bindingId: string };

export interface ModelBrokerLedgerReplay {
	bindings: ReadonlyMap<string, ModelBindingLedgerRecord>;
	attempts: ReadonlyMap<string, ModelAttemptLedgerRecord>;
	diagnostics: readonly ModelBrokerLedgerDiagnostic[];
}

export interface PublicModelReference {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

export interface PublicModelRouteCandidate {
	order: number;
	model: PublicModelReference;
}

export interface PublicModelBindingLedgerRecord {
	bindingId: string;
	mode: ModelBindingMode;
	routeId?: string;
	role?: string;
	candidates: ReadonlyArray<PublicModelRouteCandidate>;
	fallback: {
		maxAttempts: number;
		on: ReadonlyArray<string>;
	};
	budget: ModelBudgetLimit;
	configRevision: string;
	createdAt: string;
	previousModelBindingId?: string;
}

export interface PublicModelAttemptLedgerRecord {
	attemptId: string;
	bindingId: string;
	candidate: PublicModelReference;
	order: number;
	status: ModelAttemptStatus;
	startedAt: string;
	endedAt?: string;
	failureCategory?: string;
	usage?: ModelUsage;
	visibleOutput?: boolean;
	contextSnapshotId?: string;
	summary?: string;
}

export type ModelBrokerLedgerErrorCode = "model_binding_invalid" | "model_attempt_invalid" | "ledger_persistence_failed";

/** Error with a stable code and a message that never embeds the source error. */
export class ModelBrokerLedgerError extends Error {
	readonly code: ModelBrokerLedgerErrorCode;

	constructor(code: ModelBrokerLedgerErrorCode, message: string) {
		super(message);
		this.name = "ModelBrokerLedgerError";
		this.code = code;
	}
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_MODEL_TEXT_PATTERN = /^[^\u0000-\u001f\u007f\r\n]{1,512}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID_PATTERN.test(value) && !value.includes("://") && !value.includes("@") && !value.includes("?");
}

function isSafeLabel(value: unknown): value is string {
	return typeof value === "string" && SAFE_LABEL_PATTERN.test(value);
}

function isSafeModelText(value: unknown): value is string {
	return typeof value === "string" && SAFE_MODEL_TEXT_PATTERN.test(value) && !value.includes("://") && !value.includes("@");
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value);
}

function cloneModelReference(reference: ModelReference): ModelReference {
	const copy: ModelReference = { provider: reference.provider, modelId: reference.modelId };
	if (reference.thinkingLevel !== undefined) copy.thinkingLevel = reference.thinkingLevel;
	return copy;
}

function parseModelReference(value: unknown): ModelReference | undefined {
	if (!isRecord(value) || !isSafeModelText(value.provider) || !isSafeModelText(value.modelId)) return undefined;
	if (value.thinkingLevel !== undefined && !isThinkingLevel(value.thinkingLevel)) return undefined;
	const reference: ModelReference = { provider: value.provider, modelId: value.modelId };
	if (value.thinkingLevel !== undefined) reference.thinkingLevel = value.thinkingLevel;
	return reference;
}

function modelFromCandidate(value: unknown): ModelReference | undefined {
	if (!isRecord(value)) return undefined;
	const nested = value.model;
	if (nested !== undefined) return parseModelReference(nested);
	return parseModelReference(value);
}

function parseCandidate(value: unknown): ModelRouteCandidate | undefined {
	if (!isRecord(value) || !isNonNegativeInteger(value.order)) return undefined;
	const model = modelFromCandidate(value);
	if (model === undefined) return undefined;
	return { order: value.order, model };
}

function cloneCandidate(candidate: ModelRouteCandidate): ModelRouteCandidate {
	const model = modelFromCandidate(candidate);
	if (model === undefined) {
		throw new ModelBrokerLedgerError("model_binding_invalid", "model binding candidate is invalid");
	}
	return { order: candidate.order, model: cloneModelReference(model) };
}

function parseFallback(value: unknown): ModelFallbackPolicy | undefined {
	if (!isRecord(value) || !isNonNegativeInteger(value.maxAttempts) || value.maxAttempts < 1) return undefined;
	if (
		!Array.isArray(value.on) ||
		value.on.some((category) => category !== "provider_unavailable" && category !== "transient_provider_error")
	) {
		return undefined;
	}
	return { maxAttempts: value.maxAttempts, on: [...value.on] };
}

function cloneFallback(fallback: ModelFallbackPolicy): ModelFallbackPolicy {
	const parsed = parseFallback(fallback);
	if (parsed === undefined) throw new ModelBrokerLedgerError("model_binding_invalid", "model binding fallback is invalid");
	return { maxAttempts: parsed.maxAttempts, on: [...parsed.on] };
}

function parseBudget(value: unknown): ModelBudgetLimit | undefined {
	if (!isRecord(value)) return undefined;
	const fields: (keyof ModelBudgetLimit)[] = [
		"maxModelCalls",
		"maxInputTokens",
		"maxOutputTokens",
		"maxTotalTokens",
		"maxCostUsd",
	];
	const budget: ModelBudgetLimit = {};
	for (const field of fields) {
		if (value[field] !== undefined) {
			if (!isFiniteNonNegative(value[field])) return undefined;
			budget[field] = value[field] as number;
		}
	}
	return budget;
}

function cloneBudget(budget: ModelBudgetLimit): ModelBudgetLimit {
	const parsed = parseBudget(budget);
	if (parsed === undefined) throw new ModelBrokerLedgerError("model_binding_invalid", "model binding budget is invalid");
	return { ...parsed };
}

function parseBinding(value: unknown): ModelBindingLedgerRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (!isSafeIdentifier(value.bindingId) || (value.mode !== "manual" && value.mode !== "route" && value.mode !== "direct")) {
		return undefined;
	}
	if (value.routeId !== undefined && !isSafeLabel(value.routeId)) return undefined;
	if (value.role !== undefined && !isSafeLabel(value.role)) return undefined;
	if (!Array.isArray(value.candidates) || value.candidates.length === 0) return undefined;
	const candidates = value.candidates.map(parseCandidate);
	if (candidates.some((candidate) => candidate === undefined)) return undefined;
	const parsedCandidates = candidates.filter((candidate): candidate is ModelRouteCandidate => candidate !== undefined);
	const orders = new Set<number>();
	for (const candidate of parsedCandidates) {
		if (orders.has(candidate.order)) return undefined;
		orders.add(candidate.order);
	}
	if (value.mode !== "route" && parsedCandidates.length !== 1) return undefined;
	const fallback = parseFallback(value.fallback);
	const budget = parseBudget(value.budget);
	if (fallback === undefined || budget === undefined || !isSafeLabel(value.configRevision) || !isSafeModelText(value.createdAt)) {
		return undefined;
	}
	if (value.previousModelBindingId !== undefined && !isSafeIdentifier(value.previousModelBindingId)) return undefined;
	const binding: ModelBindingLedgerRecord = {
		bindingId: value.bindingId,
		mode: value.mode,
		candidates: parsedCandidates.map((candidate) => cloneCandidate(candidate)),
		fallback: cloneFallback(fallback),
		budget: cloneBudget(budget),
		configRevision: value.configRevision,
		createdAt: value.createdAt,
	};
	if (value.routeId !== undefined) binding.routeId = value.routeId;
	if (value.role !== undefined) binding.role = value.role;
	if (value.previousModelBindingId !== undefined) binding.previousModelBindingId = value.previousModelBindingId;
	return binding;
}

function parseUsage(value: unknown): ModelUsage | undefined {
	if (!isRecord(value)) return undefined;
	const fields: (keyof ModelUsage)[] = [
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"costUsd",
		"input",
		"output",
		"total",
		"cost",
	];
	const usage: ModelUsage = {};
	let hasValue = false;
	for (const field of fields) {
		if (value[field] !== undefined) {
			if (!isFiniteNonNegative(value[field])) return undefined;
			usage[field] = value[field] as number;
			hasValue = true;
		}
	}
	return hasValue ? usage : undefined;
}

function cloneUsage(usage: ModelUsage): ModelUsage {
	const parsed = parseUsage(usage);
	if (parsed === undefined) throw new ModelBrokerLedgerError("model_attempt_invalid", "model attempt usage is invalid");
	return { ...parsed };
}

function safeSummary(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.replace(/[\u0000-\u001f\u007f\r\n]+/g, " ").trim();
	if (trimmed.length === 0) return undefined;
	if (/[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return undefined;
	const redacted = trimmed
		.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, (_match) => "[redacted]@")
		.replace(/\b(bearer|token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*(?:bearer\s+)?[^\s"'`,;]+/gi, (_match, key: string) => `${key}=[redacted]`)
		.replace(/\bbearer\s+[^\s"'`,;]+/gi, "[redacted]");
	if (redacted.includes("://") || redacted.includes("\\") || redacted.includes("/")) return undefined;
	return redacted.slice(0, 512);
}

function parseAttempt(value: unknown): ModelAttemptLedgerRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (!isSafeIdentifier(value.attemptId) || !isSafeIdentifier(value.bindingId)) return undefined;
	if (!isNonNegativeInteger(value.order)) return undefined;
	if (
		value.status !== "started" &&
		value.status !== "completed" &&
		value.status !== "failed" &&
		value.status !== "cancelled"
	) {
		return undefined;
	}
	const candidate = modelFromCandidate(value.candidate);
	if (candidate === undefined || !isSafeModelText(value.startedAt)) return undefined;
	if (value.endedAt !== undefined && !isSafeModelText(value.endedAt)) return undefined;
	if (value.failureCategory !== undefined && !isSafeLabel(value.failureCategory)) return undefined;
	if (value.visibleOutput !== undefined && typeof value.visibleOutput !== "boolean") return undefined;
	if (value.contextSnapshotId !== undefined && !isSafeIdentifier(value.contextSnapshotId)) return undefined;
	const usage = value.usage === undefined ? undefined : parseUsage(value.usage);
	if (value.usage !== undefined && usage === undefined) return undefined;
	const summary = value.summary === undefined ? undefined : safeSummary(value.summary);
	if (value.summary !== undefined && typeof value.summary !== "string") return undefined;
	const attempt: ModelAttemptLedgerRecord = {
		attemptId: value.attemptId,
		bindingId: value.bindingId,
		candidate,
		order: value.order,
		status: value.status,
		startedAt: value.startedAt,
	};
	if (value.endedAt !== undefined) attempt.endedAt = value.endedAt;
	if (value.failureCategory !== undefined) attempt.failureCategory = value.failureCategory;
	if (usage !== undefined) attempt.usage = usage;
	if (value.visibleOutput !== undefined) attempt.visibleOutput = value.visibleOutput;
	if (value.contextSnapshotId !== undefined) attempt.contextSnapshotId = value.contextSnapshotId;
	if (summary !== undefined) attempt.summary = summary;
	return attempt;
}

function cloneAttempt(attempt: ModelAttemptLedgerRecord): ModelAttemptLedgerRecord {
	const parsed = parseAttempt(attempt);
	if (parsed === undefined) throw new ModelBrokerLedgerError("model_attempt_invalid", "model attempt is invalid");
	const candidate = modelFromCandidate(parsed.candidate);
	if (candidate === undefined) throw new ModelBrokerLedgerError("model_attempt_invalid", "model attempt candidate is invalid");
	return {
		...parsed,
		candidate: cloneModelReference(candidate),
		...(parsed.usage === undefined ? {} : { usage: cloneUsage(parsed.usage) }),
	};
}

function parseEntryData(value: unknown, customType: string):
	| { ok: true; value: ModelBindingLedgerRecord | ModelAttemptLedgerRecord }
	| { ok: false; reason: "malformed" | "unknown-schema-version"; version?: number; detail: string } {
	if (!isRecord(value)) return { ok: false, reason: "malformed", detail: "data is not an object" };
	if (typeof value.schemaVersion !== "number") {
		return { ok: false, reason: "malformed", detail: "schemaVersion is missing" };
	}
	if (value.schemaVersion !== MODEL_BROKER_LEDGER_SCHEMA_VERSION) {
		return {
			ok: false,
			reason: "unknown-schema-version",
			version: value.schemaVersion,
			detail: "unsupported schema version",
		};
	}
	if (customType === MODEL_BINDING_CUSTOM_TYPE) {
		const binding = parseBinding(value.binding ?? value.record);
		return binding === undefined
			? { ok: false, reason: "malformed", detail: "binding is invalid" }
			: { ok: true, value: binding };
	}
	const attempt = parseAttempt(value.attempt ?? value.record);
	return attempt === undefined
		? { ok: false, reason: "malformed", detail: "attempt is invalid" }
		: { ok: true, value: attempt };
}

function persistEntry(session: ModelBrokerLedgerSession, customType: string, data: unknown, code: ModelBrokerLedgerErrorCode): string {
	try {
		return session.appendCustomEntry(customType, data);
	} catch {
		throw new ModelBrokerLedgerError(code, "failed to persist model broker ledger entry");
	}
}

/** Persist one immutable, metadata-only model.binding fact. */
export function persistModelBinding(session: ModelBrokerLedgerSession, binding: ModelBindingLedgerRecord): string {
	const parsed = parseBinding(binding);
	if (parsed === undefined) throw new ModelBrokerLedgerError("model_binding_invalid", "model binding is invalid");
	const data: PersistedModelBindingEntry = { schemaVersion: MODEL_BINDING_SCHEMA_VERSION, binding: parsed };
	return persistEntry(session, MODEL_BINDING_CUSTOM_TYPE, data, "ledger_persistence_failed");
}

/** Persist one immutable, metadata-only model.attempt fact. */
export function persistModelAttempt(session: ModelBrokerLedgerSession, attempt: ModelAttemptLedgerRecord): string {
	const parsed = parseAttempt(attempt);
	if (parsed === undefined) throw new ModelBrokerLedgerError("model_attempt_invalid", "model attempt is invalid");
	const data: PersistedModelAttemptEntry = { schemaVersion: MODEL_ATTEMPT_SCHEMA_VERSION, attempt: cloneAttempt(parsed) };
	return persistEntry(session, MODEL_ATTEMPT_CUSTOM_TYPE, data, "ledger_persistence_failed");
}

export const appendModelBindingEntry = persistModelBinding;
export const appendModelAttemptEntry = persistModelAttempt;
export const appendModelBinding = persistModelBinding;
export const appendModelAttempt = persistModelAttempt;

/** Parse a model.binding custom entry without exposing its unknown fields. */
export function parseModelBindingEntry(value: unknown): ModelBindingLedgerRecord | undefined {
	const parsed = parseEntryData(value, MODEL_BINDING_CUSTOM_TYPE);
	return parsed.ok && "mode" in parsed.value ? parsed.value : undefined;
}

/** Parse a model.attempt custom entry without exposing its unknown fields. */
export function parseModelAttemptEntry(value: unknown): ModelAttemptLedgerRecord | undefined {
	const parsed = parseEntryData(value, MODEL_ATTEMPT_CUSTOM_TYPE);
	return parsed.ok && "status" in parsed.value ? parsed.value : undefined;
}

/** Parse a direct model.binding record using the same whitelist as replay. */
export function parseModelBindingLedgerRecord(value: unknown): ModelBindingLedgerRecord | undefined {
	return parseBinding(value);
}

/** Parse a direct model.attempt record using the same whitelist as replay. */
export function parseModelAttemptLedgerRecord(value: unknown): ModelAttemptLedgerRecord | undefined {
	return parseAttempt(value);
}

/** Runtime predicate for strict, safe binding records. */
export function isModelBindingLedgerRecord(value: unknown): value is ModelBindingLedgerRecord {
	return parseBinding(value) !== undefined;
}

/** Runtime predicate for strict, safe attempt records. */
export function isModelAttemptLedgerRecord(value: unknown): value is ModelAttemptLedgerRecord {
	return parseAttempt(value) !== undefined;
}

function entriesFrom(input: ModelBrokerLedgerSession | ReadonlyArray<ModelBrokerLedgerEntry>): ReadonlyArray<ModelBrokerLedgerEntry> {
	return "getEntries" in input ? input.getEntries() : input;
}

/**
 * Replay binding and attempt facts in append order. Replay never reconstructs
 * a stream or a provider object; it returns only cloned metadata and fixed
 * diagnostics. Attempts are keyed by attempt id so a started fact can be
 * replaced by its terminal settlement fact.
 */
export function replayModelBrokerLedger(
	input: ModelBrokerLedgerSession | ReadonlyArray<ModelBrokerLedgerEntry>,
	 diagnostics?: (diagnostic: ModelBrokerLedgerDiagnostic) => void,
): ModelBrokerLedgerReplay {
	const bindings = new Map<string, ModelBindingLedgerRecord>();
	const attempts = new Map<string, ModelAttemptLedgerRecord>();
	const diagnosticsList: ModelBrokerLedgerDiagnostic[] = [];
	const terminalAttempts = new Set<string>();
	const report = (diagnostic: ModelBrokerLedgerDiagnostic): void => {
		diagnosticsList.push(diagnostic);
		diagnostics?.(diagnostic);
	};

	for (const entry of entriesFrom(input)) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== MODEL_BINDING_CUSTOM_TYPE && entry.customType !== MODEL_ATTEMPT_CUSTOM_TYPE) {
			report({ kind: "unknown-ledger-kind", entryId: entry.id ?? "unknown", customType: entry.customType ?? "unknown" });
			continue;
		}
		const parsed = parseEntryData(entry.data, entry.customType);
		if (!parsed.ok) {
			if (parsed.reason === "unknown-schema-version") {
				report({
					kind: "unknown-schema-version",
					entryId: entry.id ?? "unknown",
					customType: entry.customType,
					version: parsed.version ?? -1,
				});
			} else {
				report({ kind: "malformed", entryId: entry.id ?? "unknown", customType: entry.customType, detail: parsed.detail });
			}
			continue;
		}
		if (entry.customType === MODEL_BINDING_CUSTOM_TYPE && "mode" in parsed.value) {
			if (bindings.has(parsed.value.bindingId)) {
				report({ kind: "duplicate-binding", entryId: entry.id ?? "unknown", bindingId: parsed.value.bindingId });
			}
			bindings.set(parsed.value.bindingId, cloneBinding(parsed.value));
			continue;
		}
		if (!("status" in parsed.value)) continue;
		const attempt = parsed.value;
		if (!bindings.has(attempt.bindingId)) {
			report({ kind: "orphan-attempt", entryId: entry.id ?? "unknown", attemptId: attempt.attemptId, bindingId: attempt.bindingId });
			continue;
		}
		if (terminalAttempts.has(attempt.attemptId)) {
			report({ kind: "duplicate-terminal", entryId: entry.id ?? "unknown", attemptId: attempt.attemptId });
			continue;
		}
		if (attempts.get(attempt.attemptId)?.status !== undefined && attempt.status === "started") {
			report({ kind: "malformed", entryId: entry.id ?? "unknown", customType: entry.customType, detail: "duplicate started attempt" });
			continue;
		}
		attempts.set(attempt.attemptId, cloneAttempt(attempt));
		if (attempt.status !== "started") terminalAttempts.add(attempt.attemptId);
	}

	return { bindings, attempts, diagnostics: diagnosticsList };
}

/** Fold only binding facts; later valid snapshots for an id replace earlier ones. */
export function foldModelBindingEntries(
	input: ModelBrokerLedgerSession | ReadonlyArray<ModelBrokerLedgerEntry>,
	diagnostics?: (diagnostic: ModelBrokerLedgerDiagnostic) => void,
): ReadonlyMap<string, ModelBindingLedgerRecord> {
	return replayModelBrokerLedger(input, diagnostics).bindings;
}

/** Fold only attempt facts; later valid settlements for an id replace earlier ones. */
export function foldModelAttemptEntries(
	input: ModelBrokerLedgerSession | ReadonlyArray<ModelBrokerLedgerEntry>,
	diagnostics?: (diagnostic: ModelBrokerLedgerDiagnostic) => void,
): ReadonlyMap<string, ModelAttemptLedgerRecord> {
	return replayModelBrokerLedger(input, diagnostics).attempts;
}

export const foldModelBrokerLedger = replayModelBrokerLedger;
export const readModelBrokerLedger = replayModelBrokerLedger;

function cloneBinding(binding: ModelBindingLedgerRecord): ModelBindingLedgerRecord {
	const parsed = parseBinding(binding);
	if (parsed === undefined) throw new ModelBrokerLedgerError("model_binding_invalid", "model binding is invalid");
	return {
		...parsed,
		candidates: parsed.candidates.map((candidate) => cloneCandidate(candidate)),
		fallback: cloneFallback(parsed.fallback),
		budget: cloneBudget(parsed.budget),
	};
}

/** Build a public-safe model.binding value by explicit allowlist mapping. */
export function serializePublicModelBinding(value: unknown): PublicModelBindingLedgerRecord | undefined {
	const binding = parseBinding(value);
	if (binding === undefined) return undefined;
	return {
		bindingId: binding.bindingId,
		mode: binding.mode,
		...(binding.routeId === undefined ? {} : { routeId: binding.routeId }),
		...(binding.role === undefined ? {} : { role: binding.role }),
		candidates: binding.candidates.map((candidate) => {
			const model = modelFromCandidate(candidate);
			if (model === undefined) throw new ModelBrokerLedgerError("model_binding_invalid", "model binding candidate is invalid");
			return { order: candidate.order, model: cloneModelReference(model) };
		}),
		fallback: {
			maxAttempts: binding.fallback.maxAttempts,
			on: [...binding.fallback.on],
		},
		budget: cloneBudget(binding.budget),
		configRevision: binding.configRevision,
		createdAt: binding.createdAt,
		...(binding.previousModelBindingId === undefined ? {} : { previousModelBindingId: binding.previousModelBindingId }),
	};
}

/** Build a public-safe model.attempt value by explicit allowlist mapping. */
export function serializePublicModelAttempt(value: unknown): PublicModelAttemptLedgerRecord | undefined {
	const attempt = parseAttempt(value);
	if (attempt === undefined) return undefined;
	const candidate = modelFromCandidate(attempt.candidate);
	if (candidate === undefined) return undefined;
	const summary = attempt.summary === undefined ? undefined : safeSummary(attempt.summary);
	return {
		attemptId: attempt.attemptId,
		bindingId: attempt.bindingId,
		candidate: cloneModelReference(candidate),
		order: attempt.order,
		status: attempt.status,
		startedAt: attempt.startedAt,
		...(attempt.endedAt === undefined ? {} : { endedAt: attempt.endedAt }),
		...(attempt.failureCategory === undefined ? {} : { failureCategory: attempt.failureCategory }),
		...(attempt.usage === undefined ? {} : { usage: cloneUsage(attempt.usage) }),
		...(attempt.visibleOutput === undefined ? {} : { visibleOutput: attempt.visibleOutput }),
		...(attempt.contextSnapshotId === undefined ? {} : { contextSnapshotId: attempt.contextSnapshotId }),
		...(summary === undefined ? {} : { summary }),
	};
}

/** Serialize a Session custom entry; unrelated custom entries lose their data. */
export function serializePublicModelBrokerLedgerEntry(entry: ModelBrokerLedgerEntry): ModelBrokerLedgerEntry {
	if (entry.type !== "custom") return { ...entry };
	const { data: _data, ...publicEntry } = entry;
	if (entry.customType === MODEL_BINDING_CUSTOM_TYPE) {
		const parsed = parseEntryData(entry.data, MODEL_BINDING_CUSTOM_TYPE);
		if (!parsed.ok || !("mode" in parsed.value)) return publicEntry;
		const binding = serializePublicModelBinding(parsed.value);
		return binding === undefined ? publicEntry : { ...publicEntry, data: { schemaVersion: 1, binding } };
	}
	if (entry.customType === MODEL_ATTEMPT_CUSTOM_TYPE) {
		const parsed = parseEntryData(entry.data, MODEL_ATTEMPT_CUSTOM_TYPE);
		if (!parsed.ok || !("status" in parsed.value)) return publicEntry;
		const attempt = serializePublicModelAttempt(parsed.value);
		return attempt === undefined ? publicEntry : { ...publicEntry, data: { schemaVersion: 1, attempt } };
	}
	return publicEntry;
}

/** Short alias retained for callers that name the adapter's public entry view. */
export const serializePublicModelLedgerEntry = serializePublicModelBrokerLedgerEntry;
export const serializePublicModelBrokerEntry = serializePublicModelBrokerLedgerEntry;
