/** Durable ExternalAgentConnector operation state and Session-backed storage. */

import {
	canonicalFoundationJson,
	FoundationError,
	type SessionLedger,
	validateAttempt,
	validateAttemptReceiptForProvider,
	validateExecutionCorrelation,
	validateImmutableAgentBinding,
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
	type ExecutionCorrelation,
	type Fingerprint,
} from "@aos-agent/agent-core";
import {
	cloneCanonicalExternalConnectorMapping,
	isCanonicalExternalConnectorMappingTimestamp,
	isExternalConnectorMappingIdentifier,
	type CanonicalExternalConnectorMapping,
} from "./external-session-mapping.ts";
import {
	fingerprintCanonicalExternalAgentInput,
	validateCanonicalExternalAgentInput,
	type CanonicalExternalAgentInput,
	type CanonicalExternalAgentRequestFingerprint,
} from "./external-agent-input.ts";
import {
	isExternalResolvedModelProjection,
	isExternalTranslatedModelProjection,
	type ExternalResolvedModelProjection,
	type ExternalTranslatedModelProjection,
} from "./external-model-projection.ts";

export const EXTERNAL_CONNECTOR_OPERATION_OBJECT_TYPE = "external_connector_operation" as const;
export const EXTERNAL_CONNECTOR_MAPPING_OBJECT_TYPE = "external_connector_mapping" as const;
export const EXTERNAL_CONNECTOR_EXECUTION_INPUT_OBJECT_TYPE = "external_connector_execution_input" as const;
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
	| "driver_state_missing"
	| "driver_state_ambiguous"
	| "driver_failure";

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
	"receiptId",
	"reconcileReason",
]);
const EXTERNAL_CONNECTOR_FINGERPRINT_KEYS = new Set(["algorithm", "value"]);
const EXTERNAL_CONNECTOR_SHA256_DIGEST = /^[a-f0-9]{64}$/;
const EXTERNAL_CONNECTOR_RECONCILE_REASONS: ReadonlySet<ExternalConnectorReconcileReason> = new Set([
	"start_outcome_unknown",
	"mapping_persistence_unknown",
	"mapping_missing",
	"mapping_conflict",
	"capability_drift",
	"binding_drift",
	"driver_state_missing",
	"driver_state_ambiguous",
	"driver_failure",
]);

function operationRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
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
	if (
		!checked.ok ||
		!Number.isSafeInteger(checked.value.revision) ||
		checked.value.agentInstanceId !== undefined
	) {
		return undefined;
	}
	for (const [key, candidate] of Object.entries(checked.value)) {
		if (key === "revision") continue;
		if (key === "ancestorIds") {
			if (!Array.isArray(candidate) || candidate.some((id) => !isExternalConnectorMappingIdentifier(id))) return undefined;
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
		throw new FoundationError("session_ledger_corrupt", "Durable external connector operation correlation is invalid");
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
		...(value.receiptId === undefined ? {} : { receiptId: value.receiptId }),
		...(value.reconcileReason === undefined ? {} : { reconcileReason: value.reconcileReason }),
	});
}

const OPERATION_TRANSITIONS: Readonly<Record<ExternalConnectorOperationStatus, ReadonlySet<ExternalConnectorOperationStatus>>> = {
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
	const canonicalCurrent = cloneExternalConnectorOperation(current);
	if (!EXTERNAL_CONNECTOR_OPERATION_STATUSES.includes(status)) {
		throw new FoundationError("scheduler_attempt_recovery_failed", "External connector operation status is invalid", {
			details: { attemptId: canonicalCurrent.attemptId },
		});
	}
	if (!OPERATION_TRANSITIONS[canonicalCurrent.status].has(status)) {
		throw new FoundationError("scheduler_attempt_recovery_failed", "External connector operation transition is invalid", {
			details: { attemptId: canonicalCurrent.attemptId, from: canonicalCurrent.status, to: status },
		});
	}
	if (status === "terminal" && options.receiptId === undefined) {
		throw new FoundationError("scheduler_attempt_recovery_failed", "Terminal external connector operation requires a receipt", {
			details: { attemptId: canonicalCurrent.attemptId },
		});
	}
	if (status === "reconcile_required" && options.reconcileReason === undefined) {
		throw new FoundationError("scheduler_attempt_recovery_failed", "External connector reconciliation requires a reason", {
			details: { attemptId: canonicalCurrent.attemptId },
		});
	}
	if (
		(status !== "terminal" && options.receiptId !== undefined) ||
		(status !== "reconcile_required" && options.reconcileReason !== undefined)
	) {
		throw new FoundationError("scheduler_attempt_recovery_failed", "External connector transition metadata is invalid", {
			details: { attemptId: canonicalCurrent.attemptId, status },
		});
	}
	return cloneExternalConnectorOperation({
		schemaVersion: canonicalCurrent.schemaVersion,
		providerId: canonicalCurrent.providerId,
		attemptId: canonicalCurrent.attemptId,
		bindingId: canonicalCurrent.bindingId,
		bindingEpochId: canonicalCurrent.bindingEpochId,
		bindingDigest: canonicalCurrent.bindingDigest,
		bindingRevision: canonicalCurrent.bindingRevision,
		capabilityDigest: canonicalCurrent.capabilityDigest,
		capabilityRevision: canonicalCurrent.capabilityRevision,
		operationNonce: canonicalCurrent.operationNonce,
		correlation: canonicalCurrent.correlation,
		status,
		revision: canonicalCurrent.revision + 1,
		updatedAt: options.now,
		...(status === "terminal" && options.receiptId !== undefined ? { receiptId: options.receiptId } : {}),
		...(status === "reconcile_required" && options.reconcileReason !== undefined
			? { reconcileReason: options.reconcileReason }
			: status === "terminal" && canonicalCurrent.reconcileReason !== undefined
				? { reconcileReason: canonicalCurrent.reconcileReason }
				: {}),
	});
}

function operationMatches(left: ExternalConnectorOperation, right: ExternalConnectorOperation): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

function operationImmutableFactsMatch(
	left: ExternalConnectorOperation,
	right: ExternalConnectorOperation,
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
		canonicalFoundationJson(left.correlation) === canonicalFoundationJson(right.correlation)
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
		if (payload === undefined || typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
		const record = payload as Record<string, unknown>;
		const checked = validateCanonicalExternalAgentInput(record.input);
		const modelProjection = record.modelProjection === undefined
			? undefined
			: isExternalResolvedModelProjection(record.modelProjection) ? record.modelProjection : null;
		const modelTranslation = record.modelTranslation === undefined
			? undefined
			: isExternalTranslatedModelProjection(record.modelTranslation) ? record.modelTranslation : null;
		if (
			!checked.ok ||
			modelProjection === null ||
			modelTranslation === null ||
			(modelProjection === undefined) !== (modelTranslation === undefined) ||
			(modelProjection !== undefined && modelTranslation !== undefined &&
				modelProjection.bindingDigest.value !== modelTranslation.sourceBindingDigest.value) ||
			Reflect.ownKeys(record).some(
				(key) => typeof key !== "string" || !["schemaVersion", "taskId", "requestFingerprint", "input", "modelProjection", "modelTranslation"].includes(key),
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
				throw new FoundationError("session_ledger_missing_intent", "External connector operation must begin as prepared", {
					details: { attemptId: proposed.attemptId },
				});
			}
		} else {
			if (operationMatches(current, proposed)) return current;
			if (
				proposed.revision !== current.revision + 1 ||
				!operationImmutableFactsMatch(current, proposed) ||
				!OPERATION_TRANSITIONS[current.status].has(proposed.status)
			) {
				throw new FoundationError("session_ledger_conflict", "External connector operation conflicts with durable history", {
					details: { attemptId: proposed.attemptId },
				});
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
		const checkedPersisted = cloneExternalConnectorOperation(persisted.payload);
		if (!operationMatches(checkedPersisted, proposed)) {
			throw new FoundationError("session_ledger_corrupt", "Persisted external connector operation changed shape", {
				details: { attemptId: proposed.attemptId },
			});
		}
		return checkedPersisted;
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
				throw new FoundationError("session_ledger_conflict", "Attempt already has a different external connector mapping", {
					details: { attemptId: proposed.attemptId },
				});
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
				throw new FoundationError("session_ledger_corrupt", "Canonical external connector mapping history is invalid");
			}
			if (
				candidate.providerId === proposed.providerId &&
				candidate.externalSessionId === proposed.externalSessionId &&
				candidate.externalTurnId === proposed.externalTurnId &&
				candidate.attemptId !== proposed.attemptId
			) {
				throw new FoundationError("session_ledger_conflict", "External execution already belongs to another Attempt", {
					details: { attemptId: proposed.attemptId },
				});
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
			providerClass: "external_connector",
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
			providerClass: "external_connector",
		});
		if (!checked.ok || receipt.attemptReceiptId !== expectedId) {
			throw new FoundationError("worker_receipt_invalid_producer", "External terminal evidence did not produce a canonical AttemptReceipt", {
				details: { attemptId: receipt.attemptId },
			});
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
