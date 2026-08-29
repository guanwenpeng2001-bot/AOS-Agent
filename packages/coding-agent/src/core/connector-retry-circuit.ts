import {
	fingerprintFoundationValue,
	FoundationError,
	type PublicExecutionError,
	Result,
	type Result as ResultValue,
	type SessionLedger,
	type SideEffectState,
} from "@aos-agent/agent-core";
import { runtimeClockFor, type RuntimeClock } from "./runtime-clock.ts";

export const CONNECTOR_RETRY_DECISION_OBJECT_TYPE = "scheduler.connector.retry_decision";
export const CONNECTOR_RETRY_CIRCUIT_OBJECT_TYPE = "scheduler.connector.retry_circuit";
export const CONNECTOR_RETRY_RESET_OBJECT_TYPE = "scheduler.connector.retry_reset";

export type ConnectorRetryGuarantee = "idempotent" | "resumable";
export type ConnectorRetryDecisionKind = "retry" | "stop";
export type ConnectorCircuitState = "closed" | "open" | "half_open";
export type ConnectorCircuitTransition =
	| "none"
	| "failure_recorded"
	| "closed_to_open"
	| "open_to_half_open"
	| "half_open_expired"
	| "half_open_to_open"
	| "half_open_to_closed"
	| "success_recorded"
	| "operator_reset";
export type ConnectorRetryReason =
	| "eligible"
	| "missing_operation_eligibility"
	| "side_effect_unknown"
	| "missing_error_eligibility"
	| "ineligible_error"
	| "max_attempts_exhausted"
	| "retry_time_budget_exhausted";

export interface ConnectorRetryPolicy {
	readonly maxAttempts: number;
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
	readonly totalRetryTimeMs: number;
	readonly jitterPermille: number;
	readonly failureThreshold: number;
	readonly openDurationMs: number;
	readonly halfOpenProbeTimeoutMs: number;
}

export const DEFAULT_CONNECTOR_RETRY_POLICY: ConnectorRetryPolicy = Object.freeze({
	maxAttempts: 4,
	baseDelayMs: 1_000,
	maxDelayMs: 30_000,
	totalRetryTimeMs: 120_000,
	jitterPermille: 200,
	failureThreshold: 3,
	openDurationMs: 30_000,
	halfOpenProbeTimeoutMs: 15_000,
});

export interface ConnectorRetryDecision {
	readonly schemaVersion: 1;
	readonly operationId: string;
	readonly targetId: string;
	readonly decision: ConnectorRetryDecisionKind;
	readonly reasonCode: ConnectorRetryReason;
	readonly attemptCount: number;
	readonly guarantee?: ConnectorRetryGuarantee;
	readonly sideEffectState: SideEffectState;
	readonly errorCode?: string;
	readonly decidedAt: string;
	readonly retryStartedAt: string;
	readonly retryDeadlineAt: string;
	readonly remainingRetryTimeMs: number;
	readonly exponentialDelayMs?: number;
	readonly jitterSeed?: string;
	readonly jitterMs?: number;
	readonly delayMs?: number;
	readonly nextEligibleAt?: string;
	readonly circuitState: ConnectorCircuitState;
	readonly circuitTransition: ConnectorCircuitTransition;
	readonly policy: ConnectorRetryPolicy;
}

export interface ConnectorCircuitFact {
	readonly schemaVersion: 1;
	readonly targetId: string;
	readonly state: ConnectorCircuitState;
	readonly failureCount: number;
	readonly updatedAt: string;
	readonly transition: ConnectorCircuitTransition;
	readonly policy: ConnectorRetryPolicy;
	readonly nextProbeAt?: string;
	readonly probeOperationId?: string;
	readonly probeExpiresAt?: string;
	readonly lastFailureCode?: string;
	readonly lastFailureOperationId?: string;
	readonly lastFailureAttemptCount?: number;
	readonly lastResetId?: string;
}

export interface ConnectorRetryResetFact {
	readonly schemaVersion: 1;
	readonly resetId: string;
	readonly targetId: string;
	readonly operatorId: string;
	readonly reasonCode: string;
	readonly requestedAt: string;
	readonly observedState: ConnectorCircuitState;
}

export interface ConnectorCircuitAdmission {
	readonly targetId: string;
	readonly operationId: string;
	readonly state: "closed" | "half_open";
	readonly probe: boolean;
	readonly transition: ConnectorCircuitTransition;
}

export interface ConnectorRetryFailureInput {
	readonly operationId: string;
	readonly targetId: string;
	readonly attemptCount: number;
	readonly guarantee?: ConnectorRetryGuarantee;
	readonly sideEffectState: SideEffectState;
	readonly error?: PublicExecutionError;
}

export interface ConnectorRetryCircuitOptions {
	readonly ledger: SessionLedger;
	readonly taskId: string;
	readonly policy?: ConnectorRetryPolicy;
}

interface StoredCircuit {
	readonly revision: number;
	readonly fact: ConnectorCircuitFact;
}

interface StoredDecision {
	readonly revision: number;
	readonly fact: ConnectorRetryDecision;
}

const CIRCUIT_STATES: readonly ConnectorCircuitState[] = ["closed", "open", "half_open"];
const CIRCUIT_TRANSITIONS: readonly ConnectorCircuitTransition[] = [
	"none",
	"failure_recorded",
	"closed_to_open",
	"open_to_half_open",
	"half_open_expired",
	"half_open_to_open",
	"half_open_to_closed",
	"success_recorded",
	"operator_reset",
];
const RETRY_REASONS: readonly ConnectorRetryReason[] = [
	"eligible",
	"missing_operation_eligibility",
	"side_effect_unknown",
	"missing_error_eligibility",
	"ineligible_error",
	"max_attempts_exhausted",
	"retry_time_budget_exhausted",
];
const GUARANTEES: readonly ConnectorRetryGuarantee[] = ["idempotent", "resumable"];
const SIDE_EFFECT_STATES: readonly SideEffectState[] = ["none", "unknown", "side_effect_unknown"];
const NEVER_RETRY_ERROR_CODES = new Set<string>([
	"side_effect_unknown",
	"external_binding_invalid",
	"external_capability_mismatch",
	"external_connector_readiness_stale",
	"external_tool_route_denied",
	"external_path_outside_workspace",
	"external_review_required",
	"external_review_rejected",
	"external_credential_unavailable",
	"task_credential_target_unavailable",
	"binding_epoch_mismatch",
	"binding_required_fact",
	"binding_task_before_binding",
	"scheduler_dispatch_invalid",
	"scheduler_executor_unavailable",
	"tool_guard_denied",
	"tool_pre_hook_denied",
	"worker_cancel_failed",
	"subagent_cancel_failed",
	"cancelled",
	"abort",
	"aborted",
	"user_abort",
	"user_aborted",
]);
const NEVER_RETRY_ERROR_CATEGORIES = new Set<string>([
	"permission",
	"parameter",
	"cancelled",
	"side_effect_unknown",
]);
const MAX_CAS_ATTEMPTS = 4;
const MAX_RUNTIME_DURATION_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafePositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function errorCode(error: unknown): string {
	if (error instanceof FoundationError) return error.code;
	if (isRecord(error) && typeof error.code === "string") return error.code;
	return "scheduler_persistence_failed";
}

function persistenceError(error: unknown): FoundationError {
	return error instanceof FoundationError
		? error
		: new FoundationError("scheduler_persistence_failed", errorCode(error));
}

function isStaleRevision(error: unknown): boolean {
	return errorCode(error) === "session_writer_stale_revision";
}

function requireIdentity(value: string, field: string): void {
	if (value.length === 0 || value.length > 256) {
		throw new FoundationError("external_connector_config_invalid", `${field} must be a bounded non-empty identity`);
	}
}

function validatePolicy(value: ConnectorRetryPolicy): ConnectorRetryPolicy {
	if (
		!isSafePositiveInteger(value.maxAttempts) ||
		value.maxAttempts > 100 ||
		!isSafePositiveInteger(value.baseDelayMs) ||
		!isSafePositiveInteger(value.maxDelayMs) ||
		value.maxDelayMs > MAX_RUNTIME_DURATION_MS ||
		value.baseDelayMs > value.maxDelayMs ||
		!isSafePositiveInteger(value.totalRetryTimeMs) ||
		value.totalRetryTimeMs > MAX_RUNTIME_DURATION_MS ||
		value.maxDelayMs > value.totalRetryTimeMs ||
		!isSafeNonNegativeInteger(value.jitterPermille) ||
		value.jitterPermille > 1_000 ||
		!isSafePositiveInteger(value.failureThreshold) ||
		value.failureThreshold > 100 ||
		!isSafePositiveInteger(value.openDurationMs) ||
		value.openDurationMs > value.maxDelayMs ||
		!isSafePositiveInteger(value.halfOpenProbeTimeoutMs) ||
		value.halfOpenProbeTimeoutMs > value.maxDelayMs
	) {
		throw new FoundationError("external_connector_config_invalid", "Connector retry policy must contain finite bounded values");
	}
	return Object.freeze({ ...value });
}

function parsePolicy(value: unknown): ConnectorRetryPolicy {
	if (!isRecord(value)) {
		throw new FoundationError("foundation_schema_invalid_shape", "Stored connector retry policy is invalid");
	}
	return validatePolicy({
		maxAttempts: value.maxAttempts as number,
		baseDelayMs: value.baseDelayMs as number,
		maxDelayMs: value.maxDelayMs as number,
		totalRetryTimeMs: value.totalRetryTimeMs as number,
		jitterPermille: value.jitterPermille as number,
		failureThreshold: value.failureThreshold as number,
		openDurationMs: value.openDurationMs as number,
		halfOpenProbeTimeoutMs: value.halfOpenProbeTimeoutMs as number,
	});
}

function validIso(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseCircuit(value: unknown, targetId: string): ConnectorCircuitFact {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.targetId !== targetId ||
		typeof value.state !== "string" ||
		!CIRCUIT_STATES.includes(value.state as ConnectorCircuitState) ||
		!isSafeNonNegativeInteger(value.failureCount) ||
		!validIso(value.updatedAt) ||
		typeof value.transition !== "string" ||
		!CIRCUIT_TRANSITIONS.includes(value.transition as ConnectorCircuitTransition)
	) {
		throw new FoundationError("foundation_schema_invalid_shape", "Stored connector circuit fact is invalid");
	}
	const state = value.state as ConnectorCircuitState;
	if (state === "open" && !validIso(value.nextProbeAt)) {
		throw new FoundationError("foundation_schema_invalid_shape", "Open connector circuit is missing its next probe time");
	}
	if (
		state === "half_open" &&
		(typeof value.probeOperationId !== "string" || value.probeOperationId.length === 0 || !validIso(value.probeExpiresAt))
	) {
		throw new FoundationError("foundation_schema_invalid_shape", "Half-open connector circuit is missing its bounded probe");
	}
	return {
		schemaVersion: 1,
		targetId,
		state,
		failureCount: value.failureCount,
		updatedAt: value.updatedAt,
		transition: value.transition as ConnectorCircuitTransition,
		policy: parsePolicy(value.policy),
		...(typeof value.nextProbeAt === "string" ? { nextProbeAt: value.nextProbeAt } : {}),
		...(typeof value.probeOperationId === "string" ? { probeOperationId: value.probeOperationId } : {}),
		...(typeof value.probeExpiresAt === "string" ? { probeExpiresAt: value.probeExpiresAt } : {}),
		...(typeof value.lastFailureCode === "string" ? { lastFailureCode: value.lastFailureCode } : {}),
		...(typeof value.lastFailureOperationId === "string" ? { lastFailureOperationId: value.lastFailureOperationId } : {}),
		...(isSafePositiveInteger(value.lastFailureAttemptCount) ? { lastFailureAttemptCount: value.lastFailureAttemptCount } : {}),
		...(typeof value.lastResetId === "string" ? { lastResetId: value.lastResetId } : {}),
	};
}

function parseDecision(value: unknown, operationId: string): ConnectorRetryDecision {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.operationId !== operationId ||
		typeof value.targetId !== "string" ||
		(value.decision !== "retry" && value.decision !== "stop") ||
		typeof value.reasonCode !== "string" ||
		!RETRY_REASONS.includes(value.reasonCode as ConnectorRetryReason) ||
		!isSafePositiveInteger(value.attemptCount) ||
		typeof value.sideEffectState !== "string" ||
		!SIDE_EFFECT_STATES.includes(value.sideEffectState as SideEffectState) ||
		!validIso(value.decidedAt) ||
		!validIso(value.retryStartedAt) ||
		!validIso(value.retryDeadlineAt) ||
		!isSafeNonNegativeInteger(value.remainingRetryTimeMs) ||
		typeof value.circuitState !== "string" ||
		!CIRCUIT_STATES.includes(value.circuitState as ConnectorCircuitState) ||
		typeof value.circuitTransition !== "string" ||
		!CIRCUIT_TRANSITIONS.includes(value.circuitTransition as ConnectorCircuitTransition)
	) {
		throw new FoundationError("foundation_schema_invalid_shape", "Stored connector retry decision is invalid");
	}
	if (
		value.decision === "retry" &&
		(!isSafePositiveInteger(value.delayMs) ||
			!isSafePositiveInteger(value.exponentialDelayMs) ||
			typeof value.jitterSeed !== "string" ||
			!isSafeNonNegativeInteger(Math.abs(value.jitterMs as number)) ||
			!validIso(value.nextEligibleAt))
	) {
		throw new FoundationError("foundation_schema_invalid_shape", "Stored connector retry timing is invalid");
	}
	return {
		schemaVersion: 1,
		operationId,
		targetId: value.targetId,
		decision: value.decision,
		reasonCode: value.reasonCode as ConnectorRetryReason,
		attemptCount: value.attemptCount,
		...(typeof value.guarantee === "string" && GUARANTEES.includes(value.guarantee as ConnectorRetryGuarantee)
			? { guarantee: value.guarantee as ConnectorRetryGuarantee }
			: {}),
		sideEffectState: value.sideEffectState as SideEffectState,
		...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
		decidedAt: value.decidedAt,
		retryStartedAt: value.retryStartedAt,
		retryDeadlineAt: value.retryDeadlineAt,
		remainingRetryTimeMs: value.remainingRetryTimeMs,
		...(isSafePositiveInteger(value.exponentialDelayMs) ? { exponentialDelayMs: value.exponentialDelayMs } : {}),
		...(typeof value.jitterSeed === "string" ? { jitterSeed: value.jitterSeed } : {}),
		...(typeof value.jitterMs === "number" && Number.isSafeInteger(value.jitterMs) ? { jitterMs: value.jitterMs } : {}),
		...(isSafePositiveInteger(value.delayMs) ? { delayMs: value.delayMs } : {}),
		...(typeof value.nextEligibleAt === "string" ? { nextEligibleAt: value.nextEligibleAt } : {}),
		circuitState: value.circuitState as ConnectorCircuitState,
		circuitTransition: value.circuitTransition as ConnectorCircuitTransition,
		policy: parsePolicy(value.policy),
	};
}

function parseReset(value: unknown, resetId: string): ConnectorRetryResetFact {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.resetId !== resetId ||
		typeof value.targetId !== "string" ||
		typeof value.operatorId !== "string" ||
		typeof value.reasonCode !== "string" ||
		!validIso(value.requestedAt) ||
		typeof value.observedState !== "string" ||
		!CIRCUIT_STATES.includes(value.observedState as ConnectorCircuitState)
	) {
		throw new FoundationError("foundation_schema_invalid_shape", "Stored connector retry reset audit is invalid");
	}
	return {
		schemaVersion: 1,
		resetId,
		targetId: value.targetId,
		operatorId: value.operatorId,
		reasonCode: value.reasonCode,
		requestedAt: value.requestedAt,
		observedState: value.observedState as ConnectorCircuitState,
	};
}

function withoutCircuitGate(
	fact: ConnectorCircuitFact,
): Omit<ConnectorCircuitFact, "nextProbeAt" | "probeOperationId" | "probeExpiresAt"> {
	return {
		schemaVersion: 1,
		targetId: fact.targetId,
		state: fact.state,
		failureCount: fact.failureCount,
		updatedAt: fact.updatedAt,
		transition: fact.transition,
		policy: fact.policy,
		...(fact.lastFailureCode === undefined ? {} : { lastFailureCode: fact.lastFailureCode }),
		...(fact.lastFailureOperationId === undefined ? {} : { lastFailureOperationId: fact.lastFailureOperationId }),
		...(fact.lastFailureAttemptCount === undefined ? {} : { lastFailureAttemptCount: fact.lastFailureAttemptCount }),
		...(fact.lastResetId === undefined ? {} : { lastResetId: fact.lastResetId }),
	};
}

function objectId(prefix: string, identity: string): string {
	return `${prefix}_${fingerprintFoundationValue(identity).value.slice(0, 32)}`;
}

function toIso(epochMs: number): string {
	if (!Number.isFinite(epochMs)) {
		throw new FoundationError("external_connector_config_invalid", "Runtime clock returned a non-finite wall time");
	}
	return new Date(epochMs).toISOString();
}

function deterministicJitter(seed: string, maximum: number): number {
	if (maximum === 0) return 0;
	let hash = 2_166_136_261;
	for (const character of seed) {
		hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
	}
	return hash % (maximum * 2 + 1) - maximum;
}

function exponentialDelay(policy: ConnectorRetryPolicy, attemptCount: number): number {
	let delay = policy.baseDelayMs;
	for (let attempt = 1; attempt < attemptCount; attempt += 1) {
		delay = Math.min(policy.maxDelayMs, delay * 2);
	}
	return delay;
}

function retryEligibility(input: ConnectorRetryFailureInput): ConnectorRetryReason {
	if (input.guarantee === undefined || !GUARANTEES.includes(input.guarantee)) {
		return "missing_operation_eligibility";
	}
	if (input.sideEffectState === "side_effect_unknown") return "side_effect_unknown";
	if (input.error === undefined || input.error.retryable !== true) return "missing_error_eligibility";
	if (
		NEVER_RETRY_ERROR_CODES.has(input.error.code) ||
		(input.error.category !== undefined && NEVER_RETRY_ERROR_CATEGORIES.has(input.error.category))
	) {
		return "ineligible_error";
	}
	return "eligible";
}

function circuitOpenError(): FoundationError {
	return new FoundationError("external_connector_circuit_open", "Connector target circuit does not admit this operation", {
		retryable: false,
		details: { reasonCode: "circuit_open" },
	});
}

export class ConnectorRetryCircuit {
	private readonly ledger: SessionLedger;
	private readonly taskId: string;
	private readonly configuredPolicy: ConnectorRetryPolicy;
	private readonly clock: RuntimeClock;

	constructor(options: ConnectorRetryCircuitOptions) {
		requireIdentity(options.taskId, "taskId");
		this.ledger = options.ledger;
		this.taskId = options.taskId;
		this.configuredPolicy = validatePolicy(options.policy ?? DEFAULT_CONNECTOR_RETRY_POLICY);
		this.clock = runtimeClockFor(options);
	}

	async decision(operationId: string): Promise<ResultValue<ConnectorRetryDecision | undefined, FoundationError>> {
		try {
			const stored = await this.readDecision(operationId);
			return Result.ok(stored?.fact);
		} catch (error) {
			return Result.err(persistenceError(error));
		}
	}

	async snapshot(targetId: string): Promise<ResultValue<ConnectorCircuitFact | undefined, FoundationError>> {
		try {
			const stored = await this.readCircuit(targetId);
			return Result.ok(stored?.fact);
		} catch (error) {
			return Result.err(persistenceError(error));
		}
	}

	async resetAudit(resetId: string): Promise<ResultValue<ConnectorRetryResetFact | undefined, FoundationError>> {
		try {
			requireIdentity(resetId, "resetId");
			const stored = await this.ledger.getFact<ConnectorRetryResetFact>(
				CONNECTOR_RETRY_RESET_OBJECT_TYPE,
				objectId("reset", resetId),
			);
			return Result.ok(stored === undefined ? undefined : parseReset(stored.payload, resetId));
		} catch (error) {
			return Result.err(persistenceError(error));
		}
	}

	async admit(targetId: string, operationId: string): Promise<ResultValue<ConnectorCircuitAdmission, FoundationError>> {
		try {
			requireIdentity(targetId, "targetId");
			requireIdentity(operationId, "operationId");
			for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
				const stored = await this.readCircuit(targetId);
				if (stored === undefined || stored.fact.state === "closed") {
					return Result.ok({ targetId, operationId, state: "closed", probe: false, transition: "none" });
				}
				const nowMs = this.clock.wallNow();
				const nowIso = toIso(nowMs);
				if (stored.fact.state === "open") {
					if (Date.parse(stored.fact.nextProbeAt ?? nowIso) > nowMs) return Result.err(circuitOpenError());
					const next: ConnectorCircuitFact = {
						...withoutCircuitGate(stored.fact),
						state: "half_open",
						updatedAt: nowIso,
						transition: "open_to_half_open",
						probeOperationId: operationId,
						probeExpiresAt: toIso(nowMs + stored.fact.policy.halfOpenProbeTimeoutMs),
					};
					const written = await this.writeCircuit(next, stored.revision, `admit:${operationId}`);
					if (!written.ok) {
						if (written.error.code === "session_writer_stale_revision") continue;
						return written;
					}
					return Result.ok({ targetId, operationId, state: "half_open", probe: true, transition: "open_to_half_open" });
				}
				if (stored.fact.probeOperationId === operationId && Date.parse(stored.fact.probeExpiresAt ?? nowIso) > nowMs) {
					return Result.ok({ targetId, operationId, state: "half_open", probe: true, transition: "none" });
				}
				if (Date.parse(stored.fact.probeExpiresAt ?? nowIso) > nowMs) return Result.err(circuitOpenError());
				const reopened: ConnectorCircuitFact = {
					...withoutCircuitGate(stored.fact),
					state: "open",
					updatedAt: nowIso,
					transition: "half_open_expired",
					nextProbeAt: toIso(nowMs + stored.fact.policy.openDurationMs),
				};
				const written = await this.writeCircuit(reopened, stored.revision, `expire:${stored.fact.probeOperationId ?? "probe"}`);
				if (!written.ok && written.error.code === "session_writer_stale_revision") continue;
				if (!written.ok) return written;
				return Result.err(circuitOpenError());
			}
			return Result.err(new FoundationError("scheduler_persistence_failed", "Connector circuit admission contention exceeded its finite bound"));
		} catch (error) {
			return Result.err(persistenceError(error));
		}
	}

	async recordFailure(input: ConnectorRetryFailureInput): Promise<ResultValue<ConnectorRetryDecision, FoundationError>> {
		try {
			requireIdentity(input.operationId, "operationId");
			requireIdentity(input.targetId, "targetId");
			if (!isSafePositiveInteger(input.attemptCount)) {
				throw new FoundationError("external_connector_config_invalid", "Connector retry attemptCount must be a positive safe integer");
			}
			const existing = await this.readDecision(input.operationId);
			if (existing !== undefined) {
				if (existing.fact.targetId !== input.targetId) {
					throw new FoundationError("external_connector_config_invalid", "Connector retry operation is already bound to another target");
				}
				if (existing.fact.attemptCount >= input.attemptCount) return Result.ok(existing.fact);
			}
			const eligibility = retryEligibility(input);
			const beforeCircuit = await this.readCircuit(input.targetId);
			const policy = existing?.fact.policy ?? beforeCircuit?.fact.policy ?? this.configuredPolicy;
			let circuit = beforeCircuit?.fact;
			let circuitTransition: ConnectorCircuitTransition = "none";
			if (eligibility === "eligible") {
				const updated = await this.recordCircuitFailure(input, policy);
				if (!updated.ok) return updated;
				circuit = updated.value;
				circuitTransition = updated.value.transition;
			}
			const nowMs = this.clock.wallNow();
			const nowIso = toIso(nowMs);
			const retryStartedAt = existing?.fact.retryStartedAt ?? nowIso;
			const retryDeadlineAt = existing?.fact.retryDeadlineAt ?? toIso(nowMs + policy.totalRetryTimeMs);
			const remainingBeforeDelay = Math.max(0, Date.parse(retryDeadlineAt) - nowMs);
			let reasonCode = eligibility;
			if (reasonCode === "eligible" && input.attemptCount >= policy.maxAttempts) reasonCode = "max_attempts_exhausted";
			const exponentialDelayMs = exponentialDelay(policy, input.attemptCount);
			const jitterSeed = fingerprintFoundationValue({
				targetId: input.targetId,
				operationId: input.operationId,
				attemptCount: input.attemptCount,
			}).value;
			const maximumJitter = Math.floor((exponentialDelayMs * policy.jitterPermille) / 1_000);
			const jitterMs = deterministicJitter(jitterSeed, maximumJitter);
			const jitteredDelayMs = Math.min(policy.maxDelayMs, Math.max(1, exponentialDelayMs + jitterMs));
			let nextEligibleMs = nowMs + jitteredDelayMs;
			if (circuit?.state === "open" && circuit.nextProbeAt !== undefined) {
				nextEligibleMs = Math.max(nextEligibleMs, Date.parse(circuit.nextProbeAt));
			}
			if (circuit?.state === "half_open" && circuit.probeOperationId !== input.operationId && circuit.probeExpiresAt !== undefined) {
				nextEligibleMs = Math.max(nextEligibleMs, Date.parse(circuit.probeExpiresAt));
			}
			const delayMs = nextEligibleMs - nowMs;
			if (
				reasonCode === "eligible" &&
				(delayMs > policy.maxDelayMs || delayMs > remainingBeforeDelay || remainingBeforeDelay === 0)
			) {
				reasonCode = "retry_time_budget_exhausted";
			}
			const shouldRetry = reasonCode === "eligible";
			const decision: ConnectorRetryDecision = {
				schemaVersion: 1,
				operationId: input.operationId,
				targetId: input.targetId,
				decision: shouldRetry ? "retry" : "stop",
				reasonCode,
				attemptCount: input.attemptCount,
				...(input.guarantee === undefined ? {} : { guarantee: input.guarantee }),
				sideEffectState: input.sideEffectState,
				...(input.error === undefined ? {} : { errorCode: input.error.code }),
				decidedAt: nowIso,
				retryStartedAt,
				retryDeadlineAt,
				remainingRetryTimeMs: shouldRetry ? Math.max(0, Date.parse(retryDeadlineAt) - nextEligibleMs) : remainingBeforeDelay,
				...(shouldRetry
					? {
							exponentialDelayMs,
							jitterSeed,
							jitterMs,
							delayMs,
							nextEligibleAt: toIso(nextEligibleMs),
						}
					: {}),
				circuitState: circuit?.state ?? "closed",
				circuitTransition,
				policy,
			};
			return this.writeDecision(decision, existing?.revision ?? 0);
		} catch (error) {
			return Result.err(persistenceError(error));
		}
	}

	async recordSuccess(targetId: string, operationId: string): Promise<ResultValue<ConnectorCircuitFact | undefined, FoundationError>> {
		try {
			requireIdentity(targetId, "targetId");
			requireIdentity(operationId, "operationId");
			for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
				const stored = await this.readCircuit(targetId);
				if (stored === undefined) return Result.ok(undefined);
				if (stored.fact.state === "open") return Result.ok(stored.fact);
				if (stored.fact.state === "half_open" && stored.fact.probeOperationId !== operationId) {
					return Result.ok(stored.fact);
				}
				if (stored.fact.state === "closed" && stored.fact.failureCount === 0) return Result.ok(stored.fact);
				const nowMs = this.clock.wallNow();
				if (
					stored.fact.state === "half_open" &&
					Date.parse(stored.fact.probeExpiresAt ?? toIso(nowMs)) <= nowMs
				) {
					const expired: ConnectorCircuitFact = {
						...withoutCircuitGate(stored.fact),
						state: "open",
						updatedAt: toIso(nowMs),
						transition: "half_open_expired",
						nextProbeAt: toIso(nowMs + stored.fact.policy.openDurationMs),
					};
					const written = await this.writeCircuit(expired, stored.revision, `late-success:${operationId}`);
					if (!written.ok && written.error.code === "session_writer_stale_revision") continue;
					return written;
				}
				const transition: ConnectorCircuitTransition =
					stored.fact.state === "half_open" ? "half_open_to_closed" : "success_recorded";
				const next: ConnectorCircuitFact = {
					...withoutCircuitGate(stored.fact),
					state: "closed",
					failureCount: 0,
					updatedAt: toIso(nowMs),
					transition,
				};
				const written = await this.writeCircuit(next, stored.revision, `success:${operationId}`);
				if (!written.ok && written.error.code === "session_writer_stale_revision") continue;
				return written;
			}
			return Result.err(new FoundationError("scheduler_persistence_failed", "Connector circuit success contention exceeded its finite bound"));
		} catch (error) {
			return Result.err(persistenceError(error));
		}
	}

	async reset(input: {
		readonly resetId: string;
		readonly targetId: string;
		readonly operatorId: string;
		readonly reasonCode: string;
	}): Promise<ResultValue<ConnectorCircuitFact, FoundationError>> {
		try {
			requireIdentity(input.resetId, "resetId");
			requireIdentity(input.targetId, "targetId");
			requireIdentity(input.operatorId, "operatorId");
			requireIdentity(input.reasonCode, "reasonCode");
			let audit = await this.ledger.getFact<ConnectorRetryResetFact>(
				CONNECTOR_RETRY_RESET_OBJECT_TYPE,
				objectId("reset", input.resetId),
			);
			const observed = await this.readCircuit(input.targetId);
			if (audit === undefined) {
				const fact: ConnectorRetryResetFact = {
					schemaVersion: 1,
					resetId: input.resetId,
					targetId: input.targetId,
					operatorId: input.operatorId,
					reasonCode: input.reasonCode,
					requestedAt: toIso(this.clock.wallNow()),
					observedState: observed?.fact.state ?? "closed",
				};
				try {
					audit = await this.ledger.appendFact(
						CONNECTOR_RETRY_RESET_OBJECT_TYPE,
						objectId("reset", input.resetId),
						fact,
						{
							clientRequestId: `scheduler.connector.reset:${objectId("request", input.resetId)}`,
							expectedRevision: 0,
							correlation: { taskId: this.taskId },
						},
					);
				} catch (error) {
					if (!isStaleRevision(error)) throw error;
					audit = await this.ledger.getFact<ConnectorRetryResetFact>(
						CONNECTOR_RETRY_RESET_OBJECT_TYPE,
						objectId("reset", input.resetId),
					);
				}
			}
			if (audit === undefined) {
				throw new FoundationError("scheduler_persistence_failed", "Connector reset audit was not durable");
			}
			const parsedAudit = parseReset(audit.payload, input.resetId);
			if (
				parsedAudit.targetId !== input.targetId ||
				parsedAudit.operatorId !== input.operatorId ||
				parsedAudit.reasonCode !== input.reasonCode
			) {
				throw new FoundationError("external_connector_config_invalid", "Connector reset id is already bound to another request");
			}
			for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
				const current = await this.readCircuit(input.targetId);
				if (current?.fact.lastResetId === input.resetId) return Result.ok(current.fact);
				const next: ConnectorCircuitFact = {
					schemaVersion: 1,
					targetId: input.targetId,
					state: "closed",
					failureCount: 0,
					updatedAt: toIso(this.clock.wallNow()),
					transition: "operator_reset",
					policy: current?.fact.policy ?? this.configuredPolicy,
					lastResetId: input.resetId,
				};
				const written = await this.writeCircuit(next, current?.revision ?? 0, `reset:${input.resetId}`);
				if (!written.ok && written.error.code === "session_writer_stale_revision") continue;
				return written;
			}
			return Result.err(new FoundationError("scheduler_persistence_failed", "Connector reset contention exceeded its finite bound"));
		} catch (error) {
			return Result.err(persistenceError(error));
		}
	}

	private async recordCircuitFailure(
		input: ConnectorRetryFailureInput,
		policy: ConnectorRetryPolicy,
	): Promise<ResultValue<ConnectorCircuitFact, FoundationError>> {
		for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
			const stored = await this.readCircuit(input.targetId);
			if (
				stored?.fact.lastFailureOperationId === input.operationId &&
				stored.fact.lastFailureAttemptCount === input.attemptCount
			) {
				return Result.ok(stored.fact);
			}
			const effectivePolicy = stored?.fact.policy ?? policy;
			const currentState = stored?.fact.state ?? "closed";
			const failureCount = (stored?.fact.failureCount ?? 0) + 1;
			const nowMs = this.clock.wallNow();
			let state = currentState;
			let transition: ConnectorCircuitTransition = "failure_recorded";
			let nextProbeAt = stored?.fact.nextProbeAt;
			let probeOperationId = stored?.fact.probeOperationId;
			let probeExpiresAt = stored?.fact.probeExpiresAt;
			if (currentState === "half_open" && stored?.fact.probeOperationId === input.operationId) {
				state = "open";
				transition = "half_open_to_open";
				nextProbeAt = toIso(nowMs + effectivePolicy.openDurationMs);
				probeOperationId = undefined;
				probeExpiresAt = undefined;
			} else if (currentState === "closed" && failureCount >= effectivePolicy.failureThreshold) {
				state = "open";
				transition = "closed_to_open";
				nextProbeAt = toIso(nowMs + effectivePolicy.openDurationMs);
			}
			const next: ConnectorCircuitFact = {
				schemaVersion: 1,
				targetId: input.targetId,
				state,
				failureCount,
				updatedAt: toIso(nowMs),
				transition,
				policy: effectivePolicy,
				...(nextProbeAt === undefined ? {} : { nextProbeAt }),
				...(probeOperationId === undefined ? {} : { probeOperationId }),
				...(probeExpiresAt === undefined ? {} : { probeExpiresAt }),
				...(input.error === undefined ? {} : { lastFailureCode: input.error.code }),
				lastFailureOperationId: input.operationId,
				lastFailureAttemptCount: input.attemptCount,
				...(stored?.fact.lastResetId === undefined ? {} : { lastResetId: stored.fact.lastResetId }),
			};
			const written = await this.writeCircuit(next, stored?.revision ?? 0, `failure:${input.operationId}:${input.attemptCount}`);
			if (!written.ok && written.error.code === "session_writer_stale_revision") continue;
			return written;
		}
		return Result.err(new FoundationError("scheduler_persistence_failed", "Connector circuit failure contention exceeded its finite bound"));
	}

	private async readCircuit(targetId: string): Promise<StoredCircuit | undefined> {
		requireIdentity(targetId, "targetId");
		const stored = await this.ledger.getFact<ConnectorCircuitFact>(
			CONNECTOR_RETRY_CIRCUIT_OBJECT_TYPE,
			objectId("target", targetId),
		);
		return stored === undefined ? undefined : { revision: stored.record.revision, fact: parseCircuit(stored.payload, targetId) };
	}

	private async readDecision(operationId: string): Promise<StoredDecision | undefined> {
		requireIdentity(operationId, "operationId");
		const stored = await this.ledger.getFact<ConnectorRetryDecision>(
			CONNECTOR_RETRY_DECISION_OBJECT_TYPE,
			objectId("operation", operationId),
		);
		return stored === undefined ? undefined : { revision: stored.record.revision, fact: parseDecision(stored.payload, operationId) };
	}

	private async writeCircuit(
		fact: ConnectorCircuitFact,
		expectedRevision: number,
		requestStem: string,
	): Promise<ResultValue<ConnectorCircuitFact, FoundationError>> {
		try {
			const written = await this.ledger.appendFact(
				CONNECTOR_RETRY_CIRCUIT_OBJECT_TYPE,
				objectId("target", fact.targetId),
				fact,
				{
					clientRequestId: `scheduler.connector.circuit:${objectId("request", requestStem)}:${expectedRevision}`,
					expectedRevision,
					correlation: { taskId: this.taskId },
				},
			);
			return Result.ok(parseCircuit(written.payload, fact.targetId));
		} catch (error) {
			return Result.err(persistenceError(error));
		}
	}

	private async writeDecision(
		fact: ConnectorRetryDecision,
		expectedRevision: number,
	): Promise<ResultValue<ConnectorRetryDecision, FoundationError>> {
		for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
			try {
				const written = await this.ledger.appendFact(
					CONNECTOR_RETRY_DECISION_OBJECT_TYPE,
					objectId("operation", fact.operationId),
					fact,
					{
						clientRequestId: `scheduler.connector.retry:${objectId("request", fact.operationId)}:${fact.attemptCount}:${expectedRevision}`,
						expectedRevision,
						correlation: { taskId: this.taskId },
					},
				);
				return Result.ok(parseDecision(written.payload, fact.operationId));
			} catch (error) {
				if (!isStaleRevision(error)) return Result.err(persistenceError(error));
				const current = await this.readDecision(fact.operationId);
				if (current !== undefined && current.fact.attemptCount >= fact.attemptCount) return Result.ok(current.fact);
				expectedRevision = current?.revision ?? 0;
			}
		}
		return Result.err(new FoundationError("scheduler_persistence_failed", "Connector retry decision contention exceeded its finite bound"));
	}
}
