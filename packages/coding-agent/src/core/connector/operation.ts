/** Durable ExternalAgentConnector operation state and Session-backed storage. */

import {
	canonicalFoundationJson,
	cloneDeepFrozen,
	fingerprintFoundationValue,
	FoundationError,
	type SessionLedger,
	validateAttempt,
	validateAttemptReceiptForProvider,
	validateExecutionCorrelation,
	validateImmutableAgentBinding,
	validateToolExecutionResult,
	validateToolGatewayRequest,
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
	type ExecutionCorrelation,
	type Fingerprint,
	type FoundationJsonValue,
	type ToolExecutionResult,
	type ToolGatewayRequest,
} from "@aos-agent/agent-core";
import { PROVIDER_CLASS } from "./provider-class.ts";
import {
	cloneCanonicalExternalConnectorMapping,
	isCanonicalExternalConnectorMappingTimestamp,
	isExternalConnectorMappingIdentifier,
	type CanonicalExternalConnectorMapping,
} from "./session-mapping.ts";
import {
	fingerprintCanonicalExternalAgentInput,
	validateCanonicalExternalAgentInput,
	type CanonicalExternalAgentInput,
	type CanonicalExternalAgentRequestFingerprint,
} from "./input.ts";
import {
	isExternalResolvedModelProjection,
	isExternalTranslatedModelProjection,
	type ExternalResolvedModelProjection,
	type ExternalTranslatedModelProjection,
} from "./model-projection.ts";
import {
	isTaskCredentialDeliveryReceipt,
	serializeTaskCredentialDeliveryReceipt,
	type TaskCredentialDeliveryReceipt,
} from "../policy/task-credential-lease.ts";
import {
	validateOperationWorkerLeaseProjection,
	type SafeLeaseProjection,
} from "../worker/protocol.ts";

export const EXTERNAL_CONNECTOR_OPERATION_OBJECT_TYPE = "external_connector_operation" as const;
export const EXTERNAL_CONNECTOR_MAPPING_OBJECT_TYPE = "external_connector_mapping" as const;
export const EXTERNAL_CONNECTOR_EXECUTION_INPUT_OBJECT_TYPE = "external_connector_execution_input" as const;
export const EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE =
	"external_connector_tool_gateway_execution" as const;
export const EXTERNAL_CONNECTOR_OPERATION_STATUSES = [
	"prepared",
	"start_intent",
	"running",
	"cancelling",
	"terminal",
	"reconcile_required",
] as const;
export type ExternalConnectorOperationStatus = (typeof EXTERNAL_CONNECTOR_OPERATION_STATUSES)[number];

export type ExternalConnectorReconcileReason =
	| "start_outcome_unknown"
	| "mapping_persistence_unknown"
	| "mapping_missing"
	| "mapping_conflict"
	| "capability_drift"
	| "binding_drift"
	| "credential_unavailable"
	| "driver_state_missing"
	| "driver_state_ambiguous"
	| "driver_failure";

/** Safe, immutable target selection captured before credential issue. */
export interface ExternalConnectorCredentialRequirement {
	readonly schemaVersion: 1;
	readonly targetId: string;
	readonly targetKind: string;
	readonly capabilityBindingId: string;
	readonly policyBindingId: string;
	readonly scopeDigest: string;
	readonly scopeCount: number;
}

/**
 * Material-free lease facts delivered to one exact Connector Attempt.
 * Credential material remains behind the Host-owned provider boundary.
 */
export interface ExternalConnectorCredentialLease {
	readonly schemaVersion: 1;
	readonly projection: SafeLeaseProjection;
	readonly leaseDigest: Fingerprint;
	readonly targetId: string;
	readonly targetKind: string;
	readonly scopeCount: number;
	readonly issuedAt: string;
	readonly delivery: TaskCredentialDeliveryReceipt;
}

export interface ExternalConnectorOperation {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly attemptId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly bindingDigest: Fingerprint;
	readonly bindingRevision: number;
	readonly capabilityDigest: Fingerprint;
	readonly capabilityRevision: number;
	readonly operationNonce: string;
	readonly correlation: ExecutionCorrelation;
	readonly status: ExternalConnectorOperationStatus;
	readonly revision: number;
	readonly updatedAt: string;
	readonly credentialRequirement?: ExternalConnectorCredentialRequirement;
	readonly credential?: ExternalConnectorCredentialLease;
	readonly receiptId?: string;
	readonly reconcileReason?: ExternalConnectorReconcileReason;
}

export interface ExternalConnectorExecutionInput {
	readonly schemaVersion: 1;
	readonly taskId: string;
	readonly requestFingerprint: CanonicalExternalAgentRequestFingerprint;
	readonly input: CanonicalExternalAgentInput;
	readonly modelProjection?: ExternalResolvedModelProjection;
	readonly modelTranslation?: ExternalTranslatedModelProjection;
}

export interface ExternalConnectorToolGatewayIntent {
	readonly schemaVersion: 1;
	readonly type: typeof EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE;
	readonly id: string;
	readonly phase: "intent";
	readonly providerId: string;
	readonly attemptId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly correlation: ExecutionCorrelation;
	readonly request: ToolGatewayRequest;
	readonly createdAt: string;
}

export interface ExternalConnectorToolGatewayTerminal {
	readonly schemaVersion: 1;
	readonly type: typeof EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE;
	readonly id: string;
	readonly phase: "terminal";
	readonly providerId: string;
	readonly attemptId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly correlation: ExecutionCorrelation;
	readonly request: ToolGatewayRequest;
	readonly result: ToolExecutionResult;
	readonly createdAt: string;
	readonly completedAt: string;
}

export interface ExternalConnectorToolGatewayExecution {
	readonly intent: ExternalConnectorToolGatewayIntent;
	readonly terminal?: ExternalConnectorToolGatewayTerminal;
}

export interface ExternalConnectorToolGatewayIntentWrite {
	readonly intent: ExternalConnectorToolGatewayIntent;
	/** True only for the process that durably won the pre-effect intent append. */
	readonly claimed: boolean;
}

export interface ExternalConnectorDurableStore {
	readAttempt(attemptId: string): Promise<Attempt | undefined>;
	readBinding(bindingId: string): Promise<AgentBinding | undefined>;
	readExecutionInput(taskId: string): Promise<ExternalConnectorExecutionInput | undefined>;
	readOperation(attemptId: string): Promise<ExternalConnectorOperation | undefined>;
	writeOperation(operation: ExternalConnectorOperation): Promise<ExternalConnectorOperation>;
	readMapping(attemptId: string): Promise<CanonicalExternalConnectorMapping | undefined>;
	writeMapping(
		mapping: CanonicalExternalConnectorMapping,
		correlation: ExecutionCorrelation,
	): Promise<CanonicalExternalConnectorMapping>;
	readReceipt(attemptId: string): Promise<AttemptReceipt | undefined>;
	writeReceipt(receipt: AttemptReceipt): Promise<AttemptReceipt>;
	readToolGatewayExecution(
		attemptId: string,
		toolCallId: string,
	): Promise<ExternalConnectorToolGatewayExecution | undefined>;
	listToolGatewayExecutions(attemptId: string): Promise<readonly ExternalConnectorToolGatewayExecution[]>;
	writeToolGatewayIntent(value: ExternalConnectorToolGatewayIntent): Promise<ExternalConnectorToolGatewayIntentWrite>;
	writeToolGatewayTerminal(value: ExternalConnectorToolGatewayTerminal): Promise<ExternalConnectorToolGatewayTerminal>;
}

const EXTERNAL_CONNECTOR_OPERATION_KEYS = new Set([
	"schemaVersion",
	"providerId",
	"attemptId",
	"bindingId",
	"bindingEpochId",
	"bindingDigest",
	"bindingRevision",
	"capabilityDigest",
	"capabilityRevision",
	"operationNonce",
	"correlation",
	"status",
	"revision",
	"updatedAt",
	"credentialRequirement",
	"credential",
	"receiptId",
	"reconcileReason",
]);
const EXTERNAL_CONNECTOR_FINGERPRINT_KEYS = new Set(["algorithm", "value"]);
const EXTERNAL_CONNECTOR_SHA256_DIGEST = /^[a-f0-9]{64}$/;
const EXTERNAL_CONNECTOR_SCOPE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const EXTERNAL_CONNECTOR_CREDENTIAL_REQUIREMENT_KEYS = new Set([
	"schemaVersion",
	"targetId",
	"targetKind",
	"capabilityBindingId",
	"policyBindingId",
	"scopeDigest",
	"scopeCount",
]);
const EXTERNAL_CONNECTOR_CREDENTIAL_LEASE_KEYS = new Set([
	"schemaVersion",
	"projection",
	"leaseDigest",
	"targetId",
	"targetKind",
	"scopeCount",
	"issuedAt",
	"delivery",
]);
const EXTERNAL_CONNECTOR_RECONCILE_REASONS: ReadonlySet<ExternalConnectorReconcileReason> = new Set([
	"start_outcome_unknown",
	"mapping_persistence_unknown",
	"mapping_missing",
	"mapping_conflict",
	"capability_drift",
	"binding_drift",
	"credential_unavailable",
	"driver_state_missing",
	"driver_state_ambiguous",
	"driver_failure",
]);

export function isExternalConnectorCredentialRequirement(
	value: unknown,
): value is ExternalConnectorCredentialRequirement {
	return (
		operationRecord(value) &&
		operationExactKeys(value, EXTERNAL_CONNECTOR_CREDENTIAL_REQUIREMENT_KEYS) &&
		value.schemaVersion === 1 &&
		isExternalConnectorMappingIdentifier(value.targetId) &&
		isExternalConnectorMappingIdentifier(value.targetKind) &&
		isExternalConnectorMappingIdentifier(value.capabilityBindingId) &&
		isExternalConnectorMappingIdentifier(value.policyBindingId) &&
		typeof value.scopeDigest === "string" &&
		EXTERNAL_CONNECTOR_SCOPE_DIGEST.test(value.scopeDigest) &&
		Number.isSafeInteger(value.scopeCount) &&
		(value.scopeCount as number) > 0
	);
}

export function cloneExternalConnectorCredentialRequirement(
	value: unknown,
): ExternalConnectorCredentialRequirement {
	if (!isExternalConnectorCredentialRequirement(value)) {
		throw new FoundationError("session_ledger_corrupt", "Durable external connector credential requirement is invalid");
	}
	return Object.freeze({ ...value });
}

export function isExternalConnectorCredentialLease(value: unknown): value is ExternalConnectorCredentialLease {
	if (
		!operationRecord(value) ||
		!operationExactKeys(value, EXTERNAL_CONNECTOR_CREDENTIAL_LEASE_KEYS) ||
		value.schemaVersion !== 1 ||
		!validateOperationWorkerLeaseProjection(value.projection) ||
		!operationFingerprint(value.leaseDigest) ||
		!isExternalConnectorMappingIdentifier(value.targetId) ||
		!isExternalConnectorMappingIdentifier(value.targetKind) ||
		!Number.isSafeInteger(value.scopeCount) ||
		(value.scopeCount as number) < 1 ||
		!isCanonicalExternalConnectorMappingTimestamp(value.issuedAt) ||
		!isTaskCredentialDeliveryReceipt(value.delivery)
	) {
		return false;
	}
	const projection = value.projection;
	const delivery = value.delivery;
	if (
		delivery.status !== "succeeded" ||
		delivery.leaseId !== projection.leaseId ||
		delivery.grantId !== projection.grantId ||
		delivery.bindingId !== projection.bindingId ||
		delivery.targetId !== value.targetId
	) {
		return false;
	}
	const expectedDigest = fingerprintFoundationValue({
		projection,
		targetId: value.targetId,
		targetKind: value.targetKind,
		scopeCount: value.scopeCount,
		issuedAt: value.issuedAt,
		delivery,
	});
	return canonicalFoundationJson(expectedDigest) === canonicalFoundationJson(value.leaseDigest);
}

export function cloneExternalConnectorCredentialLease(value: unknown): ExternalConnectorCredentialLease {
	if (!isExternalConnectorCredentialLease(value)) {
		throw new FoundationError("session_ledger_corrupt", "Durable external connector credential lease is invalid");
	}
	return Object.freeze({
		schemaVersion: 1,
		projection: Object.freeze({ ...value.projection }),
		leaseDigest: Object.freeze({ ...value.leaseDigest }),
		targetId: value.targetId,
		targetKind: value.targetKind,
		scopeCount: value.scopeCount,
		issuedAt: value.issuedAt,
		delivery: Object.freeze(serializeTaskCredentialDeliveryReceipt(value.delivery)),
	});
}

function operationRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function operationExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.has(key));
}

function operationFingerprint(value: unknown): value is Fingerprint {
	return (
		operationRecord(value) &&
		operationExactKeys(value, EXTERNAL_CONNECTOR_FINGERPRINT_KEYS) &&
		value.algorithm === "sha256" &&
		typeof value.value === "string" &&
		EXTERNAL_CONNECTOR_SHA256_DIGEST.test(value.value)
	);
}

function cloneOperationCorrelation(value: unknown): ExecutionCorrelation | undefined {
	const checked = validateExecutionCorrelation(value);
	if (!checked.ok || !Number.isSafeInteger(checked.value.revision) || checked.value.agentInstanceId !== undefined) {
		return undefined;
	}
	for (const [key, candidate] of Object.entries(checked.value)) {
		if (key === "revision") continue;
		if (key === "ancestorIds") {
			if (!Array.isArray(candidate) || candidate.some((id) => !isExternalConnectorMappingIdentifier(id)))
				return undefined;
			continue;
		}
		if (!isExternalConnectorMappingIdentifier(candidate)) return undefined;
	}
	return Object.freeze({
		...checked.value,
		...(checked.value.ancestorIds === undefined
			? {}
			: { ancestorIds: Object.freeze([...checked.value.ancestorIds]) }),
	});
}

/** Strict guard for the only durable operation shape accepted by the connector store. */
export function isExternalConnectorOperation(value: unknown): value is ExternalConnectorOperation {
	if (!operationRecord(value) || !operationExactKeys(value, EXTERNAL_CONNECTOR_OPERATION_KEYS)) return false;
	const correlation = cloneOperationCorrelation(value.correlation);
	const credentialRequirement =
		value.credentialRequirement === undefined
			? undefined
			: isExternalConnectorCredentialRequirement(value.credentialRequirement)
				? value.credentialRequirement
				: null;
	const credential =
		value.credential === undefined
			? undefined
			: isExternalConnectorCredentialLease(value.credential)
				? value.credential
				: null;
	const hasReceiptId = Object.hasOwn(value, "receiptId");
	const hasReconcileReason = Object.hasOwn(value, "reconcileReason");
	if (
		value.schemaVersion !== 1 ||
		!isExternalConnectorMappingIdentifier(value.providerId) ||
		!isExternalConnectorMappingIdentifier(value.attemptId) ||
		!isExternalConnectorMappingIdentifier(value.bindingId) ||
		!isExternalConnectorMappingIdentifier(value.bindingEpochId) ||
		!operationFingerprint(value.bindingDigest) ||
		!Number.isSafeInteger(value.bindingRevision) ||
		(value.bindingRevision as number) < 1 ||
		!operationFingerprint(value.capabilityDigest) ||
		!Number.isSafeInteger(value.capabilityRevision) ||
		(value.capabilityRevision as number) < 1 ||
		!isExternalConnectorMappingIdentifier(value.operationNonce) ||
		correlation === undefined ||
		typeof value.status !== "string" ||
		!EXTERNAL_CONNECTOR_OPERATION_STATUSES.includes(value.status as ExternalConnectorOperationStatus) ||
		!Number.isSafeInteger(value.revision) ||
		(value.revision as number) < 1 ||
		!isCanonicalExternalConnectorMappingTimestamp(value.updatedAt) ||
		credentialRequirement === null ||
		credential === null ||
		(credential !== undefined && credentialRequirement === undefined) ||
		(credential !== undefined &&
			(credential.targetId !== credentialRequirement?.targetId ||
				credential.targetKind !== credentialRequirement.targetKind ||
				credential.projection.scopeDigest !== credentialRequirement.scopeDigest ||
				credential.scopeCount !== credentialRequirement.scopeCount)) ||
		(value.status === "prepared" && credential !== undefined) ||
		(hasReceiptId && !isExternalConnectorMappingIdentifier(value.receiptId)) ||
		(hasReconcileReason &&
			(typeof value.reconcileReason !== "string" ||
				!EXTERNAL_CONNECTOR_RECONCILE_REASONS.has(value.reconcileReason as ExternalConnectorReconcileReason))) ||
		correlation.taskId === undefined ||
		correlation.dispatchId === undefined ||
		correlation.attemptId !== value.attemptId ||
		correlation.bindingId !== value.bindingId ||
		correlation.bindingEpochId !== value.bindingEpochId ||
		correlation.providerId !== value.providerId
	) {
		return false;
	}
	if (value.status === "terminal") return hasReceiptId;
	if (value.status === "reconcile_required") return hasReconcileReason && !hasReceiptId;
	return !hasReceiptId && !hasReconcileReason;
}

/** Validate and deeply freeze a canonical durable operation clone. */
export function cloneExternalConnectorOperation(value: unknown): ExternalConnectorOperation {
	if (!isExternalConnectorOperation(value)) {
		throw new FoundationError("session_ledger_corrupt", "Durable external connector operation is invalid");
	}
	const correlation = cloneOperationCorrelation(value.correlation);
	if (correlation === undefined) {
		throw new FoundationError(
			"session_ledger_corrupt",
			"Durable external connector operation correlation is invalid",
		);
	}
	return Object.freeze({
		schemaVersion: 1,
		providerId: value.providerId,
		attemptId: value.attemptId,
		bindingId: value.bindingId,
		bindingEpochId: value.bindingEpochId,
		bindingDigest: Object.freeze({ ...value.bindingDigest }),
		bindingRevision: value.bindingRevision,
		capabilityDigest: Object.freeze({ ...value.capabilityDigest }),
		capabilityRevision: value.capabilityRevision,
		operationNonce: value.operationNonce,
		correlation,
		status: value.status,
		revision: value.revision,
		updatedAt: value.updatedAt,
		...(value.credentialRequirement === undefined
			? {}
			: { credentialRequirement: cloneExternalConnectorCredentialRequirement(value.credentialRequirement) }),
		...(value.credential === undefined
			? {}
			: { credential: cloneExternalConnectorCredentialLease(value.credential) }),
		...(value.receiptId === undefined ? {} : { receiptId: value.receiptId }),
		...(value.reconcileReason === undefined ? {} : { reconcileReason: value.reconcileReason }),
	});
}

const EXTERNAL_CONNECTOR_TOOL_GATEWAY_INTENT_KEYS = new Set([
	"schemaVersion",
	"type",
	"id",
	"phase",
	"providerId",
	"attemptId",
	"bindingId",
	"bindingEpochId",
	"correlation",
	"request",
	"createdAt",
]);
const EXTERNAL_CONNECTOR_TOOL_GATEWAY_TERMINAL_KEYS = new Set([
	...EXTERNAL_CONNECTOR_TOOL_GATEWAY_INTENT_KEYS,
	"result",
	"completedAt",
]);

export function externalConnectorToolGatewayExchangeId(attemptId: string, toolCallId: string): string {
	return `external_tool_exchange_${fingerprintFoundationValue({ attemptId, toolCallId }).value}`;
}

export function externalConnectorToolGatewayRequestMatchesExecution(
	request: ToolGatewayRequest,
	providerId: string,
	attemptId: string,
	bindingId: string,
	bindingEpochId: string,
	correlation: ExecutionCorrelation,
): boolean {
	return (
		correlation.runId !== undefined &&
		correlation.operationId === correlation.runId &&
		correlation.taskId !== undefined &&
		correlation.dispatchId !== undefined &&
		correlation.attemptId === attemptId &&
		correlation.bindingId === bindingId &&
		correlation.bindingEpochId === bindingEpochId &&
		correlation.providerId === providerId &&
		correlation.toolCallId === request.toolCallId &&
		request.context.bindingId === bindingId &&
		request.context.bindingEpochId === bindingEpochId &&
		request.context.taskId === correlation.taskId &&
		request.context.dispatchId === correlation.dispatchId &&
		request.context.providerId === providerId &&
		request.context.attemptId === attemptId &&
		request.context.operationId === correlation.operationId &&
		request.context.agentInstanceId === undefined
	);
}

export function cloneExternalConnectorToolGatewayIntent(value: unknown): ExternalConnectorToolGatewayIntent {
	if (
		!operationRecord(value) ||
		!operationExactKeys(value, EXTERNAL_CONNECTOR_TOOL_GATEWAY_INTENT_KEYS) ||
		value.schemaVersion !== 1 ||
		value.type !== EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE ||
		value.phase !== "intent" ||
		!isExternalConnectorMappingIdentifier(value.id) ||
		!isExternalConnectorMappingIdentifier(value.providerId) ||
		!isExternalConnectorMappingIdentifier(value.attemptId) ||
		!isExternalConnectorMappingIdentifier(value.bindingId) ||
		!isExternalConnectorMappingIdentifier(value.bindingEpochId) ||
		!isCanonicalExternalConnectorMappingTimestamp(value.createdAt)
	) {
		throw new FoundationError("session_ledger_corrupt", "Durable Tool Gateway intent is invalid");
	}
	const correlation = cloneOperationCorrelation(value.correlation);
	const request = validateToolGatewayRequest(value.request);
	if (
		correlation === undefined ||
		!request.ok ||
		value.id !== externalConnectorToolGatewayExchangeId(value.attemptId, request.value.toolCallId) ||
		!externalConnectorToolGatewayRequestMatchesExecution(
			request.value,
			value.providerId,
			value.attemptId,
			value.bindingId,
			value.bindingEpochId,
			correlation,
		)
	) {
		throw new FoundationError("session_ledger_corrupt", "Durable Tool Gateway intent is invalid");
	}
	return Object.freeze({
		schemaVersion: 1,
		type: EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
		id: value.id,
		phase: "intent",
		providerId: value.providerId,
		attemptId: value.attemptId,
		bindingId: value.bindingId,
		bindingEpochId: value.bindingEpochId,
		correlation,
		request: cloneDeepFrozen(request.value),
		createdAt: value.createdAt,
	});
}

export function cloneExternalConnectorToolGatewayTerminal(value: unknown): ExternalConnectorToolGatewayTerminal {
	if (
		!operationRecord(value) ||
		!operationExactKeys(value, EXTERNAL_CONNECTOR_TOOL_GATEWAY_TERMINAL_KEYS) ||
		value.schemaVersion !== 1 ||
		value.type !== EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE ||
		value.phase !== "terminal" ||
		!isExternalConnectorMappingIdentifier(value.id) ||
		!isExternalConnectorMappingIdentifier(value.providerId) ||
		!isExternalConnectorMappingIdentifier(value.attemptId) ||
		!isExternalConnectorMappingIdentifier(value.bindingId) ||
		!isExternalConnectorMappingIdentifier(value.bindingEpochId) ||
		!isCanonicalExternalConnectorMappingTimestamp(value.createdAt) ||
		!isCanonicalExternalConnectorMappingTimestamp(value.completedAt)
	) {
		throw new FoundationError("session_ledger_corrupt", "Durable Tool Gateway terminal result is invalid");
	}
	const correlation = cloneOperationCorrelation(value.correlation);
	const request = validateToolGatewayRequest(value.request);
	const result = validateToolExecutionResult(value.result);
	if (
		correlation === undefined ||
		!request.ok ||
		!result.ok ||
		value.id !== externalConnectorToolGatewayExchangeId(value.attemptId, request.value.toolCallId) ||
		result.value.toolCallId !== request.value.toolCallId ||
		result.value.toolName !== request.value.toolName ||
		!externalConnectorToolGatewayRequestMatchesExecution(
			request.value,
			value.providerId,
			value.attemptId,
			value.bindingId,
			value.bindingEpochId,
			correlation,
		)
	) {
		throw new FoundationError("session_ledger_corrupt", "Durable Tool Gateway terminal result is invalid");
	}
	return Object.freeze({
		schemaVersion: 1,
		type: EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
		id: value.id,
		phase: "terminal",
		providerId: value.providerId,
		attemptId: value.attemptId,
		bindingId: value.bindingId,
		bindingEpochId: value.bindingEpochId,
		correlation,
		request: cloneDeepFrozen(request.value),
		result: cloneDeepFrozen(result.value),
		createdAt: value.createdAt,
		completedAt: value.completedAt,
	});
}

function gatewayTerminalMatchesIntent(
	terminal: ExternalConnectorToolGatewayTerminal,
	intent: ExternalConnectorToolGatewayIntent,
): boolean {
	return (
		terminal.id === intent.id &&
		terminal.providerId === intent.providerId &&
		terminal.attemptId === intent.attemptId &&
		terminal.bindingId === intent.bindingId &&
		terminal.bindingEpochId === intent.bindingEpochId &&
		terminal.createdAt === intent.createdAt &&
		canonicalFoundationJson(terminal.correlation) === canonicalFoundationJson(intent.correlation) &&
		canonicalFoundationJson(terminal.request) === canonicalFoundationJson(intent.request)
	);
}

const OPERATION_TRANSITIONS: Readonly<
	Record<ExternalConnectorOperationStatus, ReadonlySet<ExternalConnectorOperationStatus>>
> = {
	prepared: new Set(["start_intent", "terminal", "reconcile_required"]),
	start_intent: new Set(["running", "terminal", "reconcile_required"]),
	running: new Set(["cancelling", "terminal", "reconcile_required"]),
	cancelling: new Set(["terminal", "reconcile_required"]),
	terminal: new Set(),
	reconcile_required: new Set(["reconcile_required", "terminal"]),
};

export function transitionExternalConnectorOperation(
	current: ExternalConnectorOperation,
	status: ExternalConnectorOperationStatus,
	options: {
		readonly now: string;
		readonly receiptId?: string;
		readonly reconcileReason?: ExternalConnectorReconcileReason;
	},
): ExternalConnectorOperation {
	const operation = cloneExternalConnectorOperation(current);
	if (!EXTERNAL_CONNECTOR_OPERATION_STATUSES.includes(status)) {
		throw new FoundationError("scheduler_attempt_recovery_failed", "External connector operation status is invalid", {
			details: { attemptId: operation.attemptId },
		});
	}
	if (!OPERATION_TRANSITIONS[operation.status].has(status)) {
		throw new FoundationError(
			"scheduler_attempt_recovery_failed",
			"External connector operation transition is invalid",
			{
				details: { attemptId: operation.attemptId, from: operation.status, to: status },
			},
		);
	}
	if (status === "terminal" && options.receiptId === undefined) {
		throw new FoundationError(
			"scheduler_attempt_recovery_failed",
			"Terminal external connector operation requires a receipt",
			{
				details: { attemptId: operation.attemptId },
			},
		);
	}
	if (status === "reconcile_required" && options.reconcileReason === undefined) {
		throw new FoundationError(
			"scheduler_attempt_recovery_failed",
			"External connector reconciliation requires a reason",
			{
				details: { attemptId: operation.attemptId },
			},
		);
	}
	if (
		(status !== "terminal" && options.receiptId !== undefined) ||
		(status !== "reconcile_required" && options.reconcileReason !== undefined)
	) {
		throw new FoundationError(
			"scheduler_attempt_recovery_failed",
			"External connector transition metadata is invalid",
			{
				details: { attemptId: operation.attemptId, status },
			},
		);
	}
	return cloneExternalConnectorOperation({
		schemaVersion: operation.schemaVersion,
		providerId: operation.providerId,
		attemptId: operation.attemptId,
		bindingId: operation.bindingId,
		bindingEpochId: operation.bindingEpochId,
		bindingDigest: operation.bindingDigest,
		bindingRevision: operation.bindingRevision,
		capabilityDigest: operation.capabilityDigest,
		capabilityRevision: operation.capabilityRevision,
		operationNonce: operation.operationNonce,
		correlation: operation.correlation,
		status,
		revision: operation.revision + 1,
		updatedAt: options.now,
		...(operation.credentialRequirement === undefined
			? {}
			: { credentialRequirement: operation.credentialRequirement }),
		...(operation.credential === undefined ? {} : { credential: operation.credential }),
		...(status === "terminal" && options.receiptId !== undefined ? { receiptId: options.receiptId } : {}),
		...(status === "reconcile_required" && options.reconcileReason !== undefined
			? { reconcileReason: options.reconcileReason }
			: status === "terminal" && operation.reconcileReason !== undefined
				? { reconcileReason: operation.reconcileReason }
				: {}),
	});
}

/** Persist a confirmed material-free lease before the vendor start boundary. */
export function attachExternalConnectorCredentialLease(
	current: ExternalConnectorOperation,
	lease: ExternalConnectorCredentialLease,
	now: string,
): ExternalConnectorOperation {
	const operation = cloneExternalConnectorOperation(current);
	const credential = cloneExternalConnectorCredentialLease(lease);
	const requirement = operation.credentialRequirement;
	if (
		operation.status !== "start_intent" ||
		operation.credential !== undefined ||
		requirement === undefined ||
		credential.targetId !== requirement.targetId ||
		credential.targetKind !== requirement.targetKind ||
		credential.projection.scopeDigest !== requirement.scopeDigest ||
		credential.scopeCount !== requirement.scopeCount
	) {
		throw new FoundationError(
			"scheduler_attempt_recovery_failed",
			"External connector credential lease does not match its durable requirement",
			{ details: { attemptId: operation.attemptId } },
		);
	}
	return cloneExternalConnectorOperation({
		...operation,
		credential,
		revision: operation.revision + 1,
		updatedAt: now,
	});
}

function operationMatches(left: ExternalConnectorOperation, right: ExternalConnectorOperation): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

function operationImmutableFactsMatch(
	left: ExternalConnectorOperation,
	right: ExternalConnectorOperation,
	allowCredentialAttachment = false,
): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.providerId === right.providerId &&
		left.attemptId === right.attemptId &&
		left.bindingId === right.bindingId &&
		left.bindingEpochId === right.bindingEpochId &&
		canonicalFoundationJson(left.bindingDigest) === canonicalFoundationJson(right.bindingDigest) &&
		left.bindingRevision === right.bindingRevision &&
		canonicalFoundationJson(left.capabilityDigest) === canonicalFoundationJson(right.capabilityDigest) &&
		left.capabilityRevision === right.capabilityRevision &&
		left.operationNonce === right.operationNonce &&
		canonicalFoundationJson(left.correlation) === canonicalFoundationJson(right.correlation) &&
		((left.credentialRequirement === undefined && right.credentialRequirement === undefined) ||
			(left.credentialRequirement !== undefined &&
				right.credentialRequirement !== undefined &&
				canonicalFoundationJson(left.credentialRequirement) ===
					canonicalFoundationJson(right.credentialRequirement))) &&
		((left.credential === undefined && right.credential === undefined) ||
			(left.credential !== undefined &&
				right.credential !== undefined &&
				canonicalFoundationJson(left.credential) === canonicalFoundationJson(right.credential)) ||
			(allowCredentialAttachment && left.credential === undefined && right.credential !== undefined))
	);
}

function operationIsCredentialAttachment(
	current: ExternalConnectorOperation,
	proposed: ExternalConnectorOperation,
): boolean {
	return (
		current.status === "start_intent" &&
		proposed.status === "start_intent" &&
		current.credentialRequirement !== undefined &&
		current.credential === undefined &&
		proposed.credential !== undefined
	);
}

function mappingMatches(left: CanonicalExternalConnectorMapping, right: CanonicalExternalConnectorMapping): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

function requireFactPayload(record: Awaited<ReturnType<SessionLedger["get"]>>, objectType: string): unknown {
	if (record === undefined) return undefined;
	if (record.kind !== "fact") {
		throw new FoundationError("session_ledger_tombstoned", "External connector durable object is not a fact", {
			details: { objectType, objectId: record.objectId },
		});
	}
	return record.payload;
}

/** Session-backed canonical store used by the connector runtime. */
export class SessionExternalConnectorDurableStore implements ExternalConnectorDurableStore {
	readonly #ledger: SessionLedger;

	constructor(ledger: SessionLedger) {
		this.#ledger = ledger;
	}

	async readAttempt(attemptId: string): Promise<Attempt | undefined> {
		const payload = requireFactPayload(await this.#ledger.get("attempt", attemptId), "attempt");
		if (payload === undefined) return undefined;
		const checked = validateAttempt(payload);
		if (!checked.ok || checked.value.attemptId !== attemptId) {
			throw new FoundationError("invalid_correlation", "Durable external connector Attempt is invalid", {
				details: { attemptId },
			});
		}
		return checked.value;
	}

	async readBinding(bindingId: string): Promise<AgentBinding | undefined> {
		const payload = requireFactPayload(await this.#ledger.get("agent_binding", bindingId), "agent_binding");
		if (payload === undefined) return undefined;
		const checked = validateImmutableAgentBinding(payload);
		if (!checked.ok || checked.value.bindingId !== bindingId) {
			throw new FoundationError("binding_required_fact", "Durable external connector binding is invalid", {
				details: { bindingId },
			});
		}
		return checked.value;
	}

	async readExecutionInput(taskId: string): Promise<ExternalConnectorExecutionInput | undefined> {
		const payload = requireFactPayload(
			await this.#ledger.get(EXTERNAL_CONNECTOR_EXECUTION_INPUT_OBJECT_TYPE, taskId),
			EXTERNAL_CONNECTOR_EXECUTION_INPUT_OBJECT_TYPE,
		);
		if (payload === undefined || typeof payload !== "object" || payload === null || Array.isArray(payload))
			return undefined;
		const record = payload as Record<string, unknown>;
		const checked = validateCanonicalExternalAgentInput(record.input);
		const modelProjection =
			record.modelProjection === undefined
				? undefined
				: isExternalResolvedModelProjection(record.modelProjection)
					? record.modelProjection
					: null;
		const modelTranslation =
			record.modelTranslation === undefined
				? undefined
				: isExternalTranslatedModelProjection(record.modelTranslation)
					? record.modelTranslation
					: null;
		if (
			!checked.ok ||
			modelProjection === null ||
			modelTranslation === null ||
			(modelProjection === undefined) !== (modelTranslation === undefined) ||
			(modelProjection !== undefined &&
				modelTranslation !== undefined &&
				modelProjection.bindingDigest.value !== modelTranslation.sourceBindingDigest.value) ||
			Reflect.ownKeys(record).some(
				(key) =>
					typeof key !== "string" ||
					![
						"schemaVersion",
						"taskId",
						"requestFingerprint",
						"input",
						"modelProjection",
						"modelTranslation",
					].includes(key),
			) ||
			record.schemaVersion !== 1 ||
			record.taskId !== taskId ||
			typeof record.requestFingerprint !== "string" ||
			record.requestFingerprint !== fingerprintCanonicalExternalAgentInput(checked.value)
		) {
			throw new FoundationError("invalid_correlation", "Durable external connector execution input is invalid", {
				details: { taskId },
			});
		}
		return Object.freeze({
			schemaVersion: 1,
			taskId,
			requestFingerprint: record.requestFingerprint as CanonicalExternalAgentRequestFingerprint,
			input: checked.value,
			...(modelProjection === undefined ? {} : { modelProjection }),
			...(modelTranslation === undefined ? {} : { modelTranslation }),
		});
	}

	async readToolGatewayExecution(
		attemptId: string,
		toolCallId: string,
	): Promise<ExternalConnectorToolGatewayExecution | undefined> {
		const exchangeId = externalConnectorToolGatewayExchangeId(attemptId, toolCallId);
		const intentRecords = await this.#ledger.find({
			kind: "intent",
			objectType: EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
			objectId: exchangeId,
			includePruned: true,
			order: "oldestFirst",
		});
		if (intentRecords.length > 1) {
			throw new FoundationError("session_ledger_corrupt", "Tool Gateway execution has multiple durable intents", {
				details: { attemptId },
			});
		}
		const current = await this.#ledger.get(EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE, exchangeId);
		if (intentRecords.length === 0) {
			if (current !== undefined) {
				throw new FoundationError("session_ledger_corrupt", "Tool Gateway terminal result has no durable intent", {
					details: { attemptId },
				});
			}
			return undefined;
		}
		const intentRecord = intentRecords[0]!;
		if (
			intentRecord.kind !== "intent" ||
			intentRecord.objectId !== exchangeId ||
			intentRecord.clientRequestId !== `external-connector-tool-gateway:${exchangeId}`
		) {
			throw new FoundationError("session_ledger_corrupt", "Tool Gateway durable intent identity is invalid", {
				details: { attemptId },
			});
		}
		const intent = cloneExternalConnectorToolGatewayIntent(intentRecord.payload);
		if (intent.attemptId !== attemptId || intent.request.toolCallId !== toolCallId) {
			throw new FoundationError("invalid_correlation", "Tool Gateway durable intent Attempt is invalid", {
				details: { attemptId },
			});
		}
		if (current === undefined) return Object.freeze({ intent });
		const terminal = cloneExternalConnectorToolGatewayTerminal(
			requireFactPayload(current, EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE),
		);
		if (
			current.revision !== 2 ||
			terminal.attemptId !== attemptId ||
			!gatewayTerminalMatchesIntent(terminal, intent)
		) {
			throw new FoundationError("session_ledger_corrupt", "Tool Gateway terminal result conflicts with its intent", {
				details: { attemptId },
			});
		}
		return Object.freeze({ intent, terminal });
	}

	async listToolGatewayExecutions(attemptId: string): Promise<readonly ExternalConnectorToolGatewayExecution[]> {
		const intentRecords = await this.#ledger.find({
			kind: "intent",
			objectType: EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
			includePruned: true,
			order: "oldestFirst",
		});
		const executions: ExternalConnectorToolGatewayExecution[] = [];
		for (const record of intentRecords) {
			if (record.kind !== "intent") continue;
			const intent = cloneExternalConnectorToolGatewayIntent(record.payload);
			if (intent.attemptId !== attemptId) continue;
			const execution = await this.readToolGatewayExecution(attemptId, intent.request.toolCallId);
			if (execution === undefined) {
				throw new FoundationError("session_ledger_corrupt", "Tool Gateway durable intent disappeared", {
					details: { attemptId },
				});
			}
			executions.push(execution);
		}
		return Object.freeze(executions);
	}

	async writeToolGatewayIntent(
		value: ExternalConnectorToolGatewayIntent,
	): Promise<ExternalConnectorToolGatewayIntentWrite> {
		const proposed = cloneExternalConnectorToolGatewayIntent(value);
		const current = await this.readToolGatewayExecution(proposed.attemptId, proposed.request.toolCallId);
		if (current !== undefined) {
			if (canonicalFoundationJson(current.intent) !== canonicalFoundationJson(proposed)) {
				throw new FoundationError("session_ledger_conflict", "Tool Gateway request conflicts with durable intent", {
					details: { attemptId: proposed.attemptId },
				});
			}
			return Object.freeze({ intent: current.intent, claimed: false });
		}
		const persisted = await this.#ledger.appendIntent(
			EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
			proposed.id,
			{
				clientRequestId: `external-connector-tool-gateway:${proposed.id}`,
				expectedRevision: 0,
				intent: "create",
				payload: proposed as unknown as FoundationJsonValue,
				correlation: proposed.correlation,
			},
		);
		const durable = cloneExternalConnectorToolGatewayIntent(persisted.record.payload);
		if (canonicalFoundationJson(durable) !== canonicalFoundationJson(proposed)) {
			throw new FoundationError("session_ledger_conflict", "Tool Gateway request conflicts with durable intent", {
				details: { attemptId: proposed.attemptId },
			});
		}
		return Object.freeze({ intent: durable, claimed: !persisted.replayed });
	}

	async writeToolGatewayTerminal(
		value: ExternalConnectorToolGatewayTerminal,
	): Promise<ExternalConnectorToolGatewayTerminal> {
		const proposed = cloneExternalConnectorToolGatewayTerminal(value);
		const current = await this.readToolGatewayExecution(proposed.attemptId, proposed.request.toolCallId);
		if (current === undefined || !gatewayTerminalMatchesIntent(proposed, current.intent)) {
			throw new FoundationError(
				"session_ledger_missing_intent",
				"Tool Gateway terminal result requires its durable intent",
				{
					details: { attemptId: proposed.attemptId },
				},
			);
		}
		if (current.terminal !== undefined) {
			if (canonicalFoundationJson(current.terminal) !== canonicalFoundationJson(proposed)) {
				throw new FoundationError(
					"session_ledger_conflict",
					"Tool Gateway already has a different terminal result",
					{
						details: { attemptId: proposed.attemptId },
					},
				);
			}
			return current.terminal;
		}
		const persisted = await this.#ledger.appendFact(
			EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
			proposed.id,
			proposed,
			{
				clientRequestId: `external-connector-tool-gateway:${proposed.id}:terminal`,
				expectedRevision: 1,
				correlation: proposed.correlation,
			},
		);
		const durable = cloneExternalConnectorToolGatewayTerminal(persisted.payload);
		if (canonicalFoundationJson(durable) !== canonicalFoundationJson(proposed)) {
			throw new FoundationError("session_ledger_corrupt", "Persisted Tool Gateway terminal result changed shape", {
				details: { attemptId: proposed.attemptId },
			});
		}
		return durable;
	}

	async readOperation(attemptId: string): Promise<ExternalConnectorOperation | undefined> {
		const payload = requireFactPayload(
			await this.#ledger.get(EXTERNAL_CONNECTOR_OPERATION_OBJECT_TYPE, attemptId),
			EXTERNAL_CONNECTOR_OPERATION_OBJECT_TYPE,
		);
		if (payload === undefined) return undefined;
		let operation: ExternalConnectorOperation;
		try {
			operation = cloneExternalConnectorOperation(payload);
		} catch {
			throw new FoundationError("session_ledger_corrupt", "Durable external connector operation is invalid", {
				details: { attemptId },
			});
		}
		if (operation.attemptId !== attemptId) {
			throw new FoundationError("session_ledger_corrupt", "Durable external connector operation is invalid", {
				details: { attemptId },
			});
		}
		return operation;
	}

	async writeOperation(operation: ExternalConnectorOperation): Promise<ExternalConnectorOperation> {
		const proposed = cloneExternalConnectorOperation(operation);
		const current = await this.readOperation(proposed.attemptId);
		if (current === undefined) {
			if (proposed.status !== "prepared" || proposed.revision !== 1) {
				throw new FoundationError(
					"session_ledger_missing_intent",
					"External connector operation must begin as prepared",
					{
						details: { attemptId: proposed.attemptId },
					},
				);
			}
		} else {
			if (operationMatches(current, proposed)) return current;
			const credentialAttachment = operationIsCredentialAttachment(current, proposed);
			if (
				proposed.revision !== current.revision + 1 ||
				!operationImmutableFactsMatch(current, proposed, credentialAttachment) ||
				(!credentialAttachment && !OPERATION_TRANSITIONS[current.status].has(proposed.status))
			) {
				throw new FoundationError(
					"session_ledger_conflict",
					"External connector operation conflicts with durable history",
					{
						details: { attemptId: proposed.attemptId },
					},
				);
			}
		}
		const persisted = await this.#ledger.appendFact(
			EXTERNAL_CONNECTOR_OPERATION_OBJECT_TYPE,
			proposed.attemptId,
			proposed,
			{
				clientRequestId: `external-connector-operation:${proposed.attemptId}:${proposed.revision}`,
				expectedRevision: current?.revision ?? 0,
				correlation: proposed.correlation,
			},
		);
		const persistedOperation = cloneExternalConnectorOperation(persisted.payload);
		if (!operationMatches(persistedOperation, proposed)) {
			throw new FoundationError("session_ledger_corrupt", "Persisted external connector operation changed shape", {
				details: { attemptId: proposed.attemptId },
			});
		}
		return persistedOperation;
	}

	async readMapping(attemptId: string): Promise<CanonicalExternalConnectorMapping | undefined> {
		const payload = requireFactPayload(
			await this.#ledger.get(EXTERNAL_CONNECTOR_MAPPING_OBJECT_TYPE, attemptId),
			EXTERNAL_CONNECTOR_MAPPING_OBJECT_TYPE,
		);
		return payload === undefined ? undefined : cloneCanonicalExternalConnectorMapping(payload);
	}

	async writeMapping(
		mapping: CanonicalExternalConnectorMapping,
		correlation: ExecutionCorrelation,
	): Promise<CanonicalExternalConnectorMapping> {
		const proposed = cloneCanonicalExternalConnectorMapping(mapping);
		const existing = await this.readMapping(proposed.attemptId);
		if (existing !== undefined) {
			if (!mappingMatches(existing, proposed)) {
				throw new FoundationError(
					"session_ledger_conflict",
					"Attempt already has a different external connector mapping",
					{
						details: { attemptId: proposed.attemptId },
					},
				);
			}
			return existing;
		}
		const records = await this.#ledger.find({
			kind: "fact",
			objectType: EXTERNAL_CONNECTOR_MAPPING_OBJECT_TYPE,
			order: "oldestFirst",
		});
		for (const record of records) {
			if (record.kind !== "fact") continue;
			let candidate: CanonicalExternalConnectorMapping;
			try {
				candidate = cloneCanonicalExternalConnectorMapping(record.payload);
			} catch {
				throw new FoundationError(
					"session_ledger_corrupt",
					"Canonical external connector mapping history is invalid",
				);
			}
			if (
				candidate.providerId === proposed.providerId &&
				candidate.externalSessionId === proposed.externalSessionId &&
				candidate.externalTurnId === proposed.externalTurnId &&
				candidate.attemptId !== proposed.attemptId
			) {
				throw new FoundationError(
					"session_ledger_conflict",
					"External execution already belongs to another Attempt",
					{
						details: { attemptId: proposed.attemptId },
					},
				);
			}
		}
		const persisted = await this.#ledger.appendFact(
			EXTERNAL_CONNECTOR_MAPPING_OBJECT_TYPE,
			proposed.attemptId,
			proposed,
			{
				clientRequestId: `external-connector-mapping:${proposed.attemptId}`,
				expectedRevision: 0,
				correlation,
			},
		);
		return cloneCanonicalExternalConnectorMapping(persisted.payload);
	}

	async readReceipt(attemptId: string): Promise<AttemptReceipt | undefined> {
		const receiptId = `attempt_receipt_${attemptId}`;
		const payload = requireFactPayload(await this.#ledger.get("attempt_receipt", receiptId), "attempt_receipt");
		if (payload === undefined) return undefined;
		const checked = validateAttemptReceiptForProvider(payload, {
			providerId: (payload as { readonly providerId?: string }).providerId ?? "invalid",
			providerClass: PROVIDER_CLASS.externalConnector,
		});
		if (!checked.ok || checked.value.attemptId !== attemptId || checked.value.attemptReceiptId !== receiptId) {
			throw new FoundationError("invalid_correlation", "Durable external connector receipt is invalid", {
				details: { attemptId },
			});
		}
		return checked.value;
	}

	async writeReceipt(receipt: AttemptReceipt): Promise<AttemptReceipt> {
		const expectedId = `attempt_receipt_${receipt.attemptId}`;
		const checked = validateAttemptReceiptForProvider(receipt, {
			providerId: receipt.providerId,
			providerClass: PROVIDER_CLASS.externalConnector,
		});
		if (!checked.ok || receipt.attemptReceiptId !== expectedId) {
			throw new FoundationError(
				"worker_receipt_invalid_producer",
				"External terminal evidence did not produce a canonical AttemptReceipt",
				{
					details: { attemptId: receipt.attemptId },
				},
			);
		}
		const existing = await this.readReceipt(receipt.attemptId);
		if (existing !== undefined) {
			if (canonicalFoundationJson(existing) !== canonicalFoundationJson(receipt)) {
				throw new FoundationError("session_ledger_conflict", "Attempt already has a different canonical receipt", {
					details: { attemptId: receipt.attemptId },
				});
			}
			return existing;
		}
		const correlation = receipt.provenance.correlation;
		if (correlation === undefined) {
			throw new FoundationError("invalid_correlation", "External connector receipt requires execution correlation", {
				details: { attemptId: receipt.attemptId },
			});
		}
		const persisted = await this.#ledger.appendFact("attempt_receipt", receipt.attemptReceiptId, receipt, {
			clientRequestId: `external-connector-receipt:${receipt.attemptId}`,
			expectedRevision: 0,
			correlation,
		});
		return persisted.payload;
	}
}
