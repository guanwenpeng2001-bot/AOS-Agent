/**
 * Read-only decoder for the historical cross-ledger association record.
 *
 * Context snapshots, ModelBroker attempts, policy bindings, and capability
 * bindings are intentionally written by separate ledgers. This small fact
 * Legacy ledgers may still contain this migration input. New execution must
 * use AgentBinding/BindingEpoch and must never persist this second aggregate.
 */

import type { ModelBrokerLedgerEntry } from "../runtime/model-broker-ledger.ts";

export const EXECUTION_ASSOCIATION_SCHEMA_VERSION = 1 as const;
export const EXECUTION_ASSOCIATION_CUSTOM_TYPE = "execution.association" as const;

export interface ExecutionAssociationRecord {
	readonly schemaVersion: typeof EXECUTION_ASSOCIATION_SCHEMA_VERSION;
	readonly associationId: string;
	readonly sessionId: string;
	readonly modelAttemptId: string;
	readonly modelBindingId: string;
	readonly contextSnapshotId?: string;
	readonly policyBindingId?: string;
	readonly capabilityBindingId?: string;
	readonly runId?: string;
	readonly createdAt: string;
}

export interface PersistedExecutionAssociationEntry {
	readonly schemaVersion: typeof EXECUTION_ASSOCIATION_SCHEMA_VERSION;
	readonly association: ExecutionAssociationRecord;
}

export type ExecutionAssociationSession = Pick<SessionAssociationEntries, "getEntries">;

interface SessionAssociationEntries {
	getEntries(): ReadonlyArray<ModelBrokerLedgerEntry & { customType?: string }>;
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isExecutionAssociationRecord(value: unknown): value is ExecutionAssociationRecord {
	if (!isRecord(value) || value.schemaVersion !== EXECUTION_ASSOCIATION_SCHEMA_VERSION) return false;
	for (const key of ["associationId", "sessionId", "modelAttemptId", "modelBindingId"] as const) {
		if (!isSafeIdentifier(value[key])) return false;
	}
	for (const key of ["contextSnapshotId", "policyBindingId", "capabilityBindingId", "runId"] as const) {
		if (value[key] !== undefined && !isSafeIdentifier(value[key])) return false;
	}
	return isTimestamp(value.createdAt);
}

export function parseExecutionAssociation(value: unknown): ExecutionAssociationRecord | undefined {
	if (!isRecord(value)) return undefined;
	const association = value.association ?? value.record ?? value;
	return isExecutionAssociationRecord(association) ? association : undefined;
}

export function getExecutionAssociations(session: ExecutionAssociationSession): ExecutionAssociationRecord[] {
	const associations: ExecutionAssociationRecord[] = [];
	for (const entry of session.getEntries()) {
		if (entry.customType !== EXECUTION_ASSOCIATION_CUSTOM_TYPE) continue;
		const association = parseExecutionAssociation(entry.data);
		if (association !== undefined) associations.push(Object.freeze({ ...association }));
	}
	return associations;
}
