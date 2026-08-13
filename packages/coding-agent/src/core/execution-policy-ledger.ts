/**
 * Append-only execution policy ledger.
 *
 * This adapter persists and replays policy facts only. It accepts already
 * resolved policy values and deliberately drops operation requests, provider
 * internals, process handles, paths, environment values, credentials, and
 * agent self-report text.
 */

import {
	EXECUTION_POLICY_SCHEMA_VERSION,
	POLICY_BINDING_CUSTOM_TYPE,
	PolicyError,
	type PolicyAction,
	type PolicyApprovalOutcome,
	type PolicyApprovalRequest,
	type PolicyApprovalSource,
	type PolicyBinding,
	type PolicyDecision,
	type PolicyDecisionOutcome,
	type PolicyEnforcement,
	type PolicyErrorCode,
	type PolicyResource,
	type PolicyTrust,
	type POLICY_LEDGER_EVENT_TYPES,
	type PublicPolicySummary,
	type SandboxCapabilities,
	type SandboxStatus,
	type WorkspaceScope,
} from "./execution-policy.ts";

export const EXECUTION_POLICY_LEDGER_SCHEMA_VERSION = 1;
export const POLICY_DECISION_CUSTOM_TYPE = "policy.decision";
export const POLICY_APPROVAL_CUSTOM_TYPE = "policy.approval";
export const SANDBOX_LIFECYCLE_CUSTOM_TYPE = "sandbox.lifecycle";
export const POLICY_VIOLATION_CUSTOM_TYPE = "policy.violation";

export type PolicyLedgerEventType = (typeof POLICY_LEDGER_EVENT_TYPES)[number];

export interface PolicyLedgerSession {
	appendCustomEntry(customType: string, data?: unknown): string;
	getEntries(): ReadonlyArray<PolicyLedgerSessionEntry>;
}

export interface PolicyLedgerSessionEntry {
	id?: string;
	type?: string;
	customType?: string;
	data?: unknown;
}

export interface PolicyLedgerEventBase {
	readonly sequence: number;
	readonly entryId?: string;
	readonly customType: PolicyLedgerEventType;
	readonly schemaVersion: typeof EXECUTION_POLICY_LEDGER_SCHEMA_VERSION;
	readonly timestamp: string;
}

export interface PolicyBindingLedgerRecord {
	readonly schemaVersion: typeof EXECUTION_POLICY_SCHEMA_VERSION;
	readonly id: string;
	readonly profileId: string;
	readonly profileRevision: string;
	readonly projectTrust: PolicyTrust;
	readonly capabilityBindingId?: string;
	readonly enforcement: PolicyEnforcement;
	readonly sandboxProviderId?: string;
	readonly sandboxCapabilities: SandboxCapabilities;
	readonly sandboxStatus: SandboxStatus;
	readonly runId: string;
	readonly createdAt: string;
	readonly previousPolicyBindingId?: string;
	readonly workspaceIdentity: string;
	readonly constraints: {
		readonly workspace: {
			readonly read: ReadonlyArray<WorkspaceScope>;
			readonly write: ReadonlyArray<WorkspaceScope>;
			readonly deny: ReadonlyArray<WorkspaceScope>;
		};
		readonly process: {
			readonly action: PolicyAction;
			readonly inheritEnvironment: boolean;
			readonly allowedEnvironmentCount: number;
			readonly cwdScopes?: ReadonlyArray<WorkspaceScope>;
		};
		readonly network: {
			readonly action: PolicyAction;
			readonly allowedDestinationCount: number;
		};
		readonly credentials: {
			readonly action: PolicyAction;
			readonly allowedNameCount: number;
		};
	};
	readonly bindingHash: string;
}

export interface PolicyDecisionLedgerRecord {
	readonly bindingId: string;
	readonly profileId: string;
	readonly profileRevision: string;
	readonly projectTrust: PolicyTrust;
	readonly enforcement: PolicyEnforcement;
	readonly resource: PolicyResource;
	readonly action: PolicyAction;
	readonly outcome: PolicyDecisionOutcome;
	readonly reasonCode?: PolicyErrorCode;
	readonly requestId?: string;
	readonly timestamp: string;
}

export interface PolicyApprovalLedgerRecord {
	readonly id: string;
	/** Stable request identifier; `id` is retained as the legacy alias. */
	readonly requestId?: string;
	readonly bindingId: string;
	readonly resource: PolicyResource;
	readonly reasonCode: "policy_approval_required";
	readonly createdAt: string;
	/** Present only after the request has been resolved. */
	readonly outcome?: PolicyApprovalOutcome;
	/** Interaction source that resolved the request; present with `outcome`. */
	readonly source?: PolicyApprovalSource;
	readonly scope: {
		readonly resource: PolicyResource;
		readonly workspaceScopes?: ReadonlyArray<WorkspaceScope>;
		readonly environmentCount?: number;
		readonly destinationCount?: number;
		readonly credentialCount?: number;
	};
}

export interface SandboxLifecycleLedgerRecord {
	readonly bindingId: string;
	readonly status: SandboxStatus;
	readonly timestamp: string;
	readonly providerId?: string;
	readonly capabilities?: SandboxCapabilities;
	readonly reasonCode?: PolicyErrorCode;
}

export interface PolicyViolationLedgerRecord {
	readonly bindingId: string;
	readonly timestamp: string;
	readonly reasonCode: PolicyErrorCode;
	readonly resource?: PolicyResource;
	readonly requestId?: string;
}

export type PolicyLedgerRecord =
	| PolicyBindingLedgerRecord
	| PolicyDecisionLedgerRecord
	| PolicyApprovalLedgerRecord
	| SandboxLifecycleLedgerRecord
	| PolicyViolationLedgerRecord;

export type PolicyLedgerEvent =
	| (PolicyLedgerEventBase & { readonly customType: typeof POLICY_BINDING_CUSTOM_TYPE; readonly record: PolicyBindingLedgerRecord })
	| (PolicyLedgerEventBase & { readonly customType: typeof POLICY_DECISION_CUSTOM_TYPE; readonly record: PolicyDecisionLedgerRecord })
	| (PolicyLedgerEventBase & { readonly customType: typeof POLICY_APPROVAL_CUSTOM_TYPE; readonly record: PolicyApprovalLedgerRecord })
	| (PolicyLedgerEventBase & { readonly customType: typeof SANDBOX_LIFECYCLE_CUSTOM_TYPE; readonly record: SandboxLifecycleLedgerRecord })
	| (PolicyLedgerEventBase & { readonly customType: typeof POLICY_VIOLATION_CUSTOM_TYPE; readonly record: PolicyViolationLedgerRecord });

export interface PolicyLedgerQuery {
	readonly customType?: PolicyLedgerEventType;
	readonly bindingId?: string;
	readonly sinceSequence?: number;
}

export interface PersistedPolicyLedgerEntry {
	readonly schemaVersion: typeof EXECUTION_POLICY_LEDGER_SCHEMA_VERSION;
	readonly sequence: number;
	readonly record: PolicyLedgerRecord;
}

export interface PolicyApprovalLedgerResolution {
	readonly outcome: PolicyApprovalOutcome;
	readonly source: PolicyApprovalSource;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function cloneSandboxCapabilities(capabilities: SandboxCapabilities): SandboxCapabilities {
	return {
		filesystem: capabilities.filesystem,
		process: capabilities.process,
		network: capabilities.network,
		credentialIsolation: capabilities.credentialIsolation,
	};
}

function clonePolicyBinding(binding: PolicyBinding): PolicyBindingLedgerRecord {
	if (binding.previousPolicyBindingId !== undefined && binding.previousPolicyBindingId === binding.id) {
		throw new PolicyError("policy_binding_failed");
	}
	return deepFreeze({
		schemaVersion: EXECUTION_POLICY_SCHEMA_VERSION,
		id: binding.id,
		profileId: binding.profileId,
		profileRevision: binding.profileRevision,
		projectTrust: binding.projectTrust,
		...(binding.capabilityBindingId === undefined ? {} : { capabilityBindingId: binding.capabilityBindingId }),
		enforcement: binding.enforcement,
		...(binding.sandboxProviderId === undefined ? {} : { sandboxProviderId: binding.sandboxProviderId }),
		sandboxCapabilities: cloneSandboxCapabilities(binding.sandboxCapabilities),
		sandboxStatus: binding.sandboxStatus,
		runId: binding.runId,
		createdAt: binding.createdAt,
		...(binding.previousPolicyBindingId === undefined ? {} : { previousPolicyBindingId: binding.previousPolicyBindingId }),
		workspaceIdentity: binding.workspaceIdentity,
		constraints: {
			workspace: {
				read: [...binding.constraints.workspace.read],
				write: [...binding.constraints.workspace.write],
				deny: [...binding.constraints.workspace.deny],
			},
			process: {
				action: binding.constraints.process.action,
				inheritEnvironment: binding.constraints.process.inheritEnvironment,
				allowedEnvironmentCount: binding.constraints.process.allowedEnvironmentCount,
				...(binding.constraints.process.cwdScopes === undefined
					? {}
					: { cwdScopes: [...binding.constraints.process.cwdScopes] }),
			},
			network: {
				action: binding.constraints.network.action,
				allowedDestinationCount: binding.constraints.network.allowedDestinationCount,
			},
			credentials: {
				action: binding.constraints.credentials.action,
				allowedNameCount: binding.constraints.credentials.allowedNameCount,
			},
		},
		bindingHash: binding.bindingHash,
	});
}

function clonePolicyDecision(decision: PolicyDecision): PolicyDecisionLedgerRecord {
	return deepFreeze({
		bindingId: decision.bindingId,
		profileId: decision.profileId,
		profileRevision: decision.profileRevision,
		projectTrust: decision.projectTrust,
		enforcement: decision.enforcement,
		resource: decision.resource,
		action: decision.action,
		outcome: decision.outcome,
		...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
		...(decision.requestId === undefined ? {} : { requestId: decision.requestId }),
		timestamp: decision.timestamp,
	});
}

function clonePolicyApproval(
	approval: PolicyApprovalRequest,
	resolution?: PolicyApprovalLedgerResolution,
): PolicyApprovalLedgerRecord {
	return deepFreeze({
		id: approval.id,
		requestId: approval.id,
		bindingId: approval.bindingId,
		resource: approval.resource,
		reasonCode: approval.reasonCode,
		createdAt: approval.createdAt,
		...(resolution === undefined ? {} : { outcome: resolution.outcome, source: resolution.source }),
		scope: {
			resource: approval.scope.resource,
			...(approval.scope.workspaceScopes === undefined ? {} : { workspaceScopes: [...approval.scope.workspaceScopes] }),
			...(approval.scope.environmentCount === undefined ? {} : { environmentCount: approval.scope.environmentCount }),
			...(approval.scope.destinationCount === undefined ? {} : { destinationCount: approval.scope.destinationCount }),
			...(approval.scope.credentialCount === undefined ? {} : { credentialCount: approval.scope.credentialCount }),
		},
	});
}

function cloneSandboxLifecycle(record: SandboxLifecycleLedgerRecord): SandboxLifecycleLedgerRecord {
	return deepFreeze({
		bindingId: record.bindingId,
		status: record.status,
		timestamp: record.timestamp,
		...(record.providerId === undefined ? {} : { providerId: record.providerId }),
		...(record.capabilities === undefined ? {} : { capabilities: cloneSandboxCapabilities(record.capabilities) }),
		...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
	});
}

function clonePolicyViolation(record: PolicyViolationLedgerRecord): PolicyViolationLedgerRecord {
	return deepFreeze({
		bindingId: record.bindingId,
		timestamp: record.timestamp,
		reasonCode: record.reasonCode,
		...(record.resource === undefined ? {} : { resource: record.resource }),
		...(record.requestId === undefined ? {} : { requestId: record.requestId }),
	});
}

function bindingIdFrom(record: PolicyLedgerRecord): string {
	return "id" in record && "bindingHash" in record ? record.id : record.bindingId;
}

function timestampFrom(record: PolicyLedgerRecord): string {
	if ("timestamp" in record) return record.timestamp;
	if ("createdAt" in record) return record.createdAt;
	return "1970-01-01T00:00:00.000Z";
}

function persistedData(sequence: number, record: PolicyLedgerRecord): PersistedPolicyLedgerEntry {
	return { schemaVersion: EXECUTION_POLICY_LEDGER_SCHEMA_VERSION, sequence, record };
}

function persist(session: PolicyLedgerSession | undefined, customType: PolicyLedgerEventType, data: PersistedPolicyLedgerEntry): string | undefined {
	if (session === undefined) return undefined;
	try {
		return session.appendCustomEntry(customType, data);
	} catch {
		throw new PolicyError("policy_ledger_persistence_failed");
	}
}

export function createPolicyBindingLedgerRecord(binding: PolicyBinding): PolicyBindingLedgerRecord {
	return clonePolicyBinding(binding);
}

export function createPolicyDecisionLedgerRecord(decision: PolicyDecision): PolicyDecisionLedgerRecord {
	return clonePolicyDecision(decision);
}

export function createPolicyApprovalLedgerRecord(
	approval: PolicyApprovalRequest,
	resolution?: PolicyApprovalLedgerResolution,
): PolicyApprovalLedgerRecord {
	return clonePolicyApproval(approval, resolution);
}

export class InMemoryExecutionPolicyLedger {
	private readonly session?: PolicyLedgerSession;
	private readonly events: PolicyLedgerEvent[] = [];
	private nextSequence = 1;

	constructor(session?: PolicyLedgerSession) {
		this.session = session;
	}

	appendBinding(binding: PolicyBinding): PolicyLedgerEvent {
		return this.append(POLICY_BINDING_CUSTOM_TYPE, clonePolicyBinding(binding));
	}

	appendDecision(decision: PolicyDecision): PolicyLedgerEvent {
		return this.append(POLICY_DECISION_CUSTOM_TYPE, clonePolicyDecision(decision));
	}

	appendApproval(approval: PolicyApprovalRequest): PolicyLedgerEvent {
		return this.append(POLICY_APPROVAL_CUSTOM_TYPE, clonePolicyApproval(approval));
	}

	appendApprovalOutcome(
		approval: PolicyApprovalRequest,
		resolution: PolicyApprovalLedgerResolution,
	): PolicyLedgerEvent {
		return this.append(POLICY_APPROVAL_CUSTOM_TYPE, clonePolicyApproval(approval, resolution));
	}

	appendSandboxLifecycle(record: SandboxLifecycleLedgerRecord): PolicyLedgerEvent {
		return this.append(SANDBOX_LIFECYCLE_CUSTOM_TYPE, cloneSandboxLifecycle(record));
	}

	appendViolation(record: PolicyViolationLedgerRecord): PolicyLedgerEvent {
		return this.append(POLICY_VIOLATION_CUSTOM_TYPE, clonePolicyViolation(record));
	}

	query(filter: PolicyLedgerQuery = {}): ReadonlyArray<PolicyLedgerEvent> {
		return this.events.filter((event) => {
			if (filter.customType !== undefined && event.customType !== filter.customType) return false;
			if (filter.bindingId !== undefined && bindingIdFrom(event.record) !== filter.bindingId) return false;
			return filter.sinceSequence === undefined || event.sequence >= filter.sinceSequence;
		});
	}

	publicSummaries(): ReadonlyArray<PublicPolicySummary> {
		return this.events.flatMap((event) => publicSummaryFromEvent(event));
	}

	private append<T extends PolicyLedgerEventType>(customType: T, record: PolicyLedgerRecord): PolicyLedgerEvent {
		const sequence = this.nextSequence;
		const entryId = persist(this.session, customType, persistedData(sequence, record));
		this.nextSequence += 1;
		const event = deepFreeze({
			sequence,
			...(entryId === undefined ? {} : { entryId }),
			customType,
			schemaVersion: EXECUTION_POLICY_LEDGER_SCHEMA_VERSION,
			timestamp: timestampFrom(record),
			record,
		}) as PolicyLedgerEvent;
		this.events.push(event);
		return event;
	}
}

function publicSummaryFromEvent(event: PolicyLedgerEvent): ReadonlyArray<PublicPolicySummary> {
	if (event.customType === POLICY_BINDING_CUSTOM_TYPE) {
		const binding = event.record;
		return [
			deepFreeze({
				bindingId: binding.id,
				profileId: binding.profileId,
				profileRevision: binding.profileRevision,
				projectTrust: binding.projectTrust,
				enforcement: binding.enforcement,
				...(binding.sandboxProviderId === undefined ? {} : { sandboxProviderId: binding.sandboxProviderId }),
				sandboxStatus: binding.sandboxStatus,
				sandboxCapabilities: cloneSandboxCapabilities(binding.sandboxCapabilities),
			}),
		];
	}
	if (event.customType !== POLICY_DECISION_CUSTOM_TYPE) return [];
	const decision = event.record;
	return [
		deepFreeze({
			bindingId: decision.bindingId,
			profileId: decision.profileId,
			profileRevision: decision.profileRevision,
			projectTrust: decision.projectTrust,
			enforcement: decision.enforcement,
			sandboxStatus: "not_required",
			sandboxCapabilities: { filesystem: false, process: false, network: false, credentialIsolation: false },
			resource: decision.resource,
			action: decision.action,
			outcome: decision.outcome,
			...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
			...(decision.requestId === undefined ? {} : { requestId: decision.requestId }),
			timestamp: decision.timestamp,
		}),
	];
}

export function appendPolicyBindingEntry(session: PolicyLedgerSession, binding: PolicyBinding): string {
	return persist(session, POLICY_BINDING_CUSTOM_TYPE, persistedData(1, clonePolicyBinding(binding))) ?? "";
}

export function appendPolicyDecisionEntry(session: PolicyLedgerSession, decision: PolicyDecision): string {
	return persist(session, POLICY_DECISION_CUSTOM_TYPE, persistedData(1, clonePolicyDecision(decision))) ?? "";
}

export function appendPolicyApprovalEntry(
	session: PolicyLedgerSession,
	approval: PolicyApprovalRequest,
	resolution?: PolicyApprovalLedgerResolution,
): string {
	return persist(session, POLICY_APPROVAL_CUSTOM_TYPE, persistedData(1, clonePolicyApproval(approval, resolution))) ?? "";
}

export const createExecutionPolicyLedger = (session?: PolicyLedgerSession): InMemoryExecutionPolicyLedger =>
	new InMemoryExecutionPolicyLedger(session);
