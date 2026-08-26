/** Durable ExternalAgentConnector operation state and Session-backed storage. */

import {
	canonicalFoundationJson,
	FoundationError,
	type SessionLedger,
	validateAttempt,
	validateAttemptReceiptForProvider,
	validateImmutableAgentBinding,
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
	type ExecutionCorrelation,
	type Fingerprint,
} from "@aos-agent/agent-core";
import {
	cloneCanonicalExternalConnectorMapping,
	type CanonicalExternalConnectorMapping,
} from "./external-session-mapping.ts";

export const EXTERNAL_CONNECTOR_OPERATION_OBJECT_TYPE = "external_connector_operation" as const;
export const EXTERNAL_CONNECTOR_MAPPING_OBJECT_TYPE = "external_connector_mapping" as const;
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

export interface ExternalConnectorDurableStore {
	readAttempt(attemptId: string): Promise<Attempt | undefined>;
	readBinding(bindingId: string): Promise<AgentBinding | undefined>;
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

const OPERATION_TRANSITIONS: Readonly<Record<ExternalConnectorOperationStatus, ReadonlySet<ExternalConnectorOperationStatus>>> = {
	prepared: new Set(["start_intent", "reconcile_required"]),
	start_intent: new Set(["running", "reconcile_required"]),
	running: new Set(["cancelling", "terminal", "reconcile_required"]),
	cancelling: new Set(["terminal", "reconcile_required"]),
	terminal: new Set(),
	reconcile_required: new Set(["terminal"]),
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
	if (!OPERATION_TRANSITIONS[current.status].has(status)) {
		throw new FoundationError("scheduler_attempt_recovery_failed", "External connector operation transition is invalid", {
			details: { attemptId: current.attemptId, from: current.status, to: status },
		});
	}
	if (status === "terminal" && options.receiptId === undefined) {
		throw new FoundationError("scheduler_attempt_recovery_failed", "Terminal external connector operation requires a receipt", {
			details: { attemptId: current.attemptId },
		});
	}
	if (status === "reconcile_required" && options.reconcileReason === undefined) {
		throw new FoundationError("scheduler_attempt_recovery_failed", "External connector reconciliation requires a reason", {
			details: { attemptId: current.attemptId },
		});
	}
	return Object.freeze({
		...current,
		status,
		revision: current.revision + 1,
		updatedAt: options.now,
		...(options.receiptId === undefined ? {} : { receiptId: options.receiptId }),
		...(options.reconcileReason === undefined ? {} : { reconcileReason: options.reconcileReason }),
	});
}

function operationMatches(left: ExternalConnectorOperation, right: ExternalConnectorOperation): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
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

	async readOperation(attemptId: string): Promise<ExternalConnectorOperation | undefined> {
		const payload = requireFactPayload(
			await this.#ledger.get(EXTERNAL_CONNECTOR_OPERATION_OBJECT_TYPE, attemptId),
			EXTERNAL_CONNECTOR_OPERATION_OBJECT_TYPE,
		);
		if (payload === undefined) return undefined;
		const operation = payload as ExternalConnectorOperation;
		if (
			operation.schemaVersion !== 1 ||
			operation.attemptId !== attemptId ||
			!EXTERNAL_CONNECTOR_OPERATION_STATUSES.includes(operation.status) ||
			!Number.isSafeInteger(operation.revision) ||
			operation.revision < 1
		) {
			throw new FoundationError("session_ledger_corrupt", "Durable external connector operation is invalid", {
				details: { attemptId },
			});
		}
		return operation;
	}

	async writeOperation(operation: ExternalConnectorOperation): Promise<ExternalConnectorOperation> {
		const current = await this.readOperation(operation.attemptId);
		if (current === undefined) {
			if (operation.status !== "prepared" || operation.revision !== 1) {
				throw new FoundationError("session_ledger_missing_intent", "External connector operation must begin as prepared", {
					details: { attemptId: operation.attemptId },
				});
			}
		} else {
			if (operationMatches(current, operation)) return current;
			if (
				operation.revision !== current.revision + 1 ||
				operation.providerId !== current.providerId ||
				operation.bindingId !== current.bindingId ||
				operation.operationNonce !== current.operationNonce ||
				!OPERATION_TRANSITIONS[current.status].has(operation.status)
			) {
				throw new FoundationError("session_ledger_conflict", "External connector operation conflicts with durable history", {
					details: { attemptId: operation.attemptId },
				});
			}
		}
		const persisted = await this.#ledger.appendFact(
			EXTERNAL_CONNECTOR_OPERATION_OBJECT_TYPE,
			operation.attemptId,
			operation,
			{
				clientRequestId: `external-connector-operation:${operation.attemptId}:${operation.revision}`,
				expectedRevision: current?.revision ?? 0,
				correlation: operation.correlation,
			},
		);
		return persisted.payload;
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
