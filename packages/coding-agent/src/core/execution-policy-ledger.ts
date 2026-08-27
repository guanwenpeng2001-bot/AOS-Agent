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
	POLICY_APPROVAL_OUTCOMES,
	POLICY_APPROVAL_SOURCES,
	POLICY_BINDING_CUSTOM_TYPE,
	POLICY_RESOURCE_CATEGORIES,
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
import {
	createPolicyReviewEvidence,
	isCanonicalPolicyTimestamp,
	isCanonicalReviewScopeDigest,
	isPolicyReviewEvidence,
	isPolicyReviewRequirement,
	isSafeReviewerId,
	type PolicyEffect,
	type PolicyReviewEvidence,
	type PolicyReviewerIdentity,
	type PolicyReviewRequirement,
} from "./protected-path-policy.ts";

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
		readonly protectedPaths?: {
			readonly ruleCount: number;
			readonly managedLockCount: number;
			readonly policyDigest: string;
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
	readonly effects?: ReadonlyArray<PolicyEffect>;
	readonly protectedPathCount?: number;
	readonly matchedProtectedRuleIds?: ReadonlyArray<string>;
	readonly reviewRequirement?: PolicyReviewRequirement;
	readonly scopeDigest?: string;
}

export interface PolicyApprovalLedgerRecord {
	readonly id: string;
	/** Stable request identifier; `id` is retained as the legacy alias. */
	readonly requestId?: string;
	readonly bindingId: string;
	readonly resource: PolicyResource;
	readonly reasonCode: "policy_approval_required" | "policy_review_required";
	readonly createdAt: string;
	readonly reviewRequirement?: Exclude<PolicyReviewRequirement, "none">;
	readonly scopeDigest?: string;
	/** Present only after the request has been resolved. */
	readonly outcome?: PolicyApprovalOutcome;
	/** Interaction source that resolved the request; present with `outcome`. */
	readonly source?: PolicyApprovalSource;
	/** Real resolution time; newly written terminal records always include it. */
	readonly resolvedAt?: string;
	readonly reviewer?: PolicyReviewerIdentity;
	readonly scope: {
		readonly resource: PolicyResource;
		readonly workspaceScopes?: ReadonlyArray<WorkspaceScope>;
		readonly environmentCount?: number;
		readonly destinationCount?: number;
		readonly credentialCount?: number;
		readonly effectCount?: number;
		readonly pathCount?: number;
		readonly scopeDigest?: string;
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
	readonly resolvedAt?: string;
	readonly reviewer?: PolicyReviewerIdentity;
	readonly requirement?: Exclude<PolicyReviewRequirement, "none" | "approval">;
	readonly scopeDigest?: string;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isWorkspaceScope(value: unknown): value is WorkspaceScope {
	return value === "workspace" || value === "declared-read-only" || value === "temporary" || value === "credentials" || value === "agent-internal";
}

function cloneSandboxCapabilities(capabilities: SandboxCapabilities): SandboxCapabilities {
	return {
		filesystem: capabilities.filesystem,
		process: capabilities.process,
		network: capabilities.network,
		credentialIsolation: capabilities.credentialIsolation,
		...(capabilities.credentialDelivery === undefined ? {} : { credentialDelivery: capabilities.credentialDelivery }),
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
			...(binding.constraints.protectedPaths === undefined
				? {}
				: { protectedPaths: { ...binding.constraints.protectedPaths } }),
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
		...(decision.effects === undefined ? {} : { effects: [...decision.effects] }),
		...(decision.protectedPathCount === undefined ? {} : { protectedPathCount: decision.protectedPathCount }),
		...(decision.matchedProtectedRuleIds === undefined ? {} : { matchedProtectedRuleIds: [...decision.matchedProtectedRuleIds] }),
		...(decision.reviewRequirement === undefined ? {} : { reviewRequirement: decision.reviewRequirement }),
		...(decision.scopeDigest === undefined ? {} : { scopeDigest: decision.scopeDigest }),
	});
}

function clonePolicyApproval(
	approval: PolicyApprovalRequest,
	resolution?: PolicyApprovalLedgerResolution,
): PolicyApprovalLedgerRecord {
	const resolvedAt = resolution === undefined ? undefined : resolution.resolvedAt ?? new Date().toISOString();
	if (resolvedAt !== undefined && !isCanonicalPolicyTimestamp(resolvedAt)) throw new PolicyError("policy_review_evidence_invalid");
	if (resolution?.reviewer !== undefined) {
		if (
			resolution.requirement === undefined ||
			resolution.scopeDigest === undefined ||
			!isCanonicalReviewScopeDigest(resolution.scopeDigest) ||
			approval.reviewRequirement !== resolution.requirement ||
			approval.scopeDigest !== resolution.scopeDigest ||
			resolvedAt === undefined ||
			Date.parse(resolvedAt) < Date.parse(approval.createdAt) ||
			!isPolicyReviewEvidence({
				requestId: approval.id,
				bindingId: approval.bindingId,
				requirement: resolution.requirement,
				reviewer: resolution.reviewer,
				decision: resolution.outcome,
				resolvedAt,
				scopeDigest: resolution.scopeDigest,
			})
		) {
			throw new PolicyError("policy_review_evidence_invalid");
		}
	}
	return deepFreeze({
		id: approval.id,
		requestId: approval.id,
		bindingId: approval.bindingId,
		resource: approval.resource,
		reasonCode: approval.reasonCode,
		createdAt: approval.createdAt,
		...(approval.reviewRequirement === undefined ? {} : { reviewRequirement: approval.reviewRequirement }),
		...(approval.scopeDigest === undefined ? {} : { scopeDigest: approval.scopeDigest }),
		...(resolution === undefined
			? {}
			: {
				outcome: resolution.outcome,
				source: resolution.source,
				resolvedAt,
				...(resolution.reviewer === undefined ? {} : { reviewer: { ...resolution.reviewer } }),
			}),
		scope: {
			resource: approval.scope.resource,
			...(approval.scope.workspaceScopes === undefined ? {} : { workspaceScopes: [...approval.scope.workspaceScopes] }),
			...(approval.scope.environmentCount === undefined ? {} : { environmentCount: approval.scope.environmentCount }),
			...(approval.scope.destinationCount === undefined ? {} : { destinationCount: approval.scope.destinationCount }),
			...(approval.scope.credentialCount === undefined ? {} : { credentialCount: approval.scope.credentialCount }),
			...(approval.scope.effectCount === undefined ? {} : { effectCount: approval.scope.effectCount }),
			...(approval.scope.pathCount === undefined ? {} : { pathCount: approval.scope.pathCount }),
			...(approval.scope.scopeDigest === undefined ? {} : { scopeDigest: approval.scope.scopeDigest }),
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

function parsePersistedApprovalRecord(value: unknown): PolicyApprovalLedgerRecord | undefined {
	if (!isRecord(value) || !isRecord(value.scope)) return undefined;
	const createdAt = isCanonicalPolicyTimestamp(value.createdAt) ? value.createdAt : undefined;
	const resolvedAt = isCanonicalPolicyTimestamp(value.resolvedAt) ? value.resolvedAt : undefined;
	if (
		!isSafeReviewerId(value.id) ||
		(value.requestId !== undefined && !isSafeReviewerId(value.requestId)) ||
		!isSafeReviewerId(value.bindingId) ||
		!(POLICY_RESOURCE_CATEGORIES as readonly unknown[]).includes(value.resource) ||
		(value.reasonCode !== "policy_approval_required" && value.reasonCode !== "policy_review_required") ||
		createdAt === undefined ||
		value.scope.resource !== value.resource
	) {
		return undefined;
	}
	for (const count of [value.scope.environmentCount, value.scope.destinationCount, value.scope.credentialCount, value.scope.effectCount, value.scope.pathCount]) {
		if (count !== undefined && !isNonNegativeInteger(count)) return undefined;
	}
	if (
		value.scope.workspaceScopes !== undefined &&
		(!Array.isArray(value.scope.workspaceScopes) || !value.scope.workspaceScopes.every(isWorkspaceScope))
	) {
		return undefined;
	}
	if (value.scope.scopeDigest !== undefined && !isCanonicalReviewScopeDigest(value.scope.scopeDigest)) return undefined;
	if (value.reviewRequirement !== undefined && (!isPolicyReviewRequirement(value.reviewRequirement) || value.reviewRequirement === "none")) {
		return undefined;
	}
	if (value.scopeDigest !== undefined && !isCanonicalReviewScopeDigest(value.scopeDigest)) return undefined;
	if (value.scopeDigest !== undefined && value.scope.scopeDigest !== value.scopeDigest) return undefined;
	const terminal = value.outcome !== undefined || value.source !== undefined || value.resolvedAt !== undefined || value.reviewer !== undefined;
	if (terminal) {
		if (
			!(POLICY_APPROVAL_OUTCOMES as readonly unknown[]).includes(value.outcome) ||
			!(POLICY_APPROVAL_SOURCES as readonly unknown[]).includes(value.source) ||
			(value.resolvedAt !== undefined && resolvedAt === undefined)
		) {
			return undefined;
		}
	}
	if (value.reviewer !== undefined) {
		if (
			(value.reviewRequirement !== "reviewer" && value.reviewRequirement !== "team_enforced") ||
			value.scopeDigest === undefined ||
			resolvedAt === undefined ||
			Date.parse(resolvedAt) < Date.parse(createdAt) ||
			!isRecord(value.reviewer) ||
			!isPolicyReviewEvidence({
				requestId: value.requestId ?? value.id,
				bindingId: value.bindingId,
				requirement: value.reviewRequirement,
				reviewer: value.reviewer,
				decision: value.outcome,
				resolvedAt,
				scopeDigest: value.scopeDigest,
			})
		) {
			return undefined;
		}
	}
	return deepFreeze({
		id: value.id,
		...(value.requestId === undefined ? {} : { requestId: value.requestId as string }),
		bindingId: value.bindingId,
		resource: value.resource as PolicyResource,
		reasonCode: value.reasonCode,
		createdAt,
		...(value.reviewRequirement === undefined ? {} : { reviewRequirement: value.reviewRequirement }),
		...(value.scopeDigest === undefined ? {} : { scopeDigest: value.scopeDigest }),
		...(value.outcome === undefined ? {} : { outcome: value.outcome as PolicyApprovalOutcome }),
		...(value.source === undefined ? {} : { source: value.source as PolicyApprovalSource }),
		...(resolvedAt === undefined ? {} : { resolvedAt }),
		...(value.reviewer === undefined ? {} : { reviewer: { ...value.reviewer } as unknown as PolicyReviewerIdentity }),
		scope: {
			resource: value.scope.resource as PolicyResource,
			...(value.scope.workspaceScopes === undefined ? {} : { workspaceScopes: [...value.scope.workspaceScopes] as WorkspaceScope[] }),
			...(value.scope.environmentCount === undefined ? {} : { environmentCount: value.scope.environmentCount as number }),
			...(value.scope.destinationCount === undefined ? {} : { destinationCount: value.scope.destinationCount as number }),
			...(value.scope.credentialCount === undefined ? {} : { credentialCount: value.scope.credentialCount as number }),
			...(value.scope.effectCount === undefined ? {} : { effectCount: value.scope.effectCount as number }),
			...(value.scope.pathCount === undefined ? {} : { pathCount: value.scope.pathCount as number }),
			...(value.scope.scopeDigest === undefined ? {} : { scopeDigest: value.scope.scopeDigest as string }),
		},
	});
}

function replayApprovalEvents(entries: ReadonlyArray<PolicyLedgerSessionEntry>): PolicyLedgerEvent[] {
	const events: PolicyLedgerEvent[] = [];
	const sequences = new Set<number>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== POLICY_APPROVAL_CUSTOM_TYPE || !isRecord(entry.data)) continue;
		if (
			entry.data.schemaVersion !== EXECUTION_POLICY_LEDGER_SCHEMA_VERSION ||
			!Number.isSafeInteger(entry.data.sequence) ||
			(entry.data.sequence as number) < 1 ||
			sequences.has(entry.data.sequence as number)
		) {
			continue;
		}
		const record = parsePersistedApprovalRecord(entry.data.record);
		if (record === undefined) continue;
		const sequence = entry.data.sequence as number;
		sequences.add(sequence);
		events.push(deepFreeze({
			sequence,
			...(entry.id === undefined ? {} : { entryId: entry.id }),
			customType: POLICY_APPROVAL_CUSTOM_TYPE,
			schemaVersion: EXECUTION_POLICY_LEDGER_SCHEMA_VERSION,
			timestamp: record.resolvedAt ?? record.createdAt,
			record,
		}));
	}
	return events.sort((left, right) => left.sequence - right.sequence);
}

function maxPersistedSequence(entries: ReadonlyArray<PolicyLedgerSessionEntry>): number {
	const customTypes = new Set<string>([
		POLICY_BINDING_CUSTOM_TYPE,
		POLICY_DECISION_CUSTOM_TYPE,
		POLICY_APPROVAL_CUSTOM_TYPE,
		SANDBOX_LIFECYCLE_CUSTOM_TYPE,
		POLICY_VIOLATION_CUSTOM_TYPE,
	]);
	let maximum = 0;
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType !== undefined &&
			customTypes.has(entry.customType) &&
			isRecord(entry.data) &&
			entry.data.schemaVersion === EXECUTION_POLICY_LEDGER_SCHEMA_VERSION &&
			Number.isSafeInteger(entry.data.sequence) &&
			(entry.data.sequence as number) > 0 &&
			(entry.data.sequence as number) < Number.MAX_SAFE_INTEGER
		) {
			maximum = Math.max(maximum, entry.data.sequence as number);
		}
	}
	return maximum;
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
		if (session !== undefined) {
			const entries = session.getEntries();
			this.events.push(...replayApprovalEvents(entries));
			this.nextSequence = maxPersistedSequence(entries) + 1;
		}
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

	appendReviewOutcome(
		approval: PolicyApprovalRequest,
		evidence: PolicyReviewEvidence,
		source: PolicyApprovalSource = "system",
	): PolicyLedgerEvent {
		const safeEvidence = createPolicyReviewEvidence(evidence);
		if (
			approval.id !== safeEvidence.requestId ||
			approval.bindingId !== safeEvidence.bindingId ||
			approval.reviewRequirement !== safeEvidence.requirement ||
			approval.scopeDigest !== safeEvidence.scopeDigest ||
			Date.parse(safeEvidence.resolvedAt) < Date.parse(approval.createdAt)
		) {
			throw new PolicyError("policy_review_evidence_invalid");
		}
		return this.append(POLICY_APPROVAL_CUSTOM_TYPE, clonePolicyApproval(approval, {
			outcome: safeEvidence.decision,
			source,
			resolvedAt: safeEvidence.resolvedAt,
			reviewer: safeEvidence.reviewer,
			requirement: safeEvidence.requirement,
			scopeDigest: safeEvidence.scopeDigest,
		}));
	}

	reviewEvidence(filter: { readonly requestId?: string; readonly bindingId?: string; readonly scopeDigest?: string } = {}): ReadonlyArray<PolicyReviewEvidence> {
		return this.events.flatMap((event) => {
			if (event.customType !== POLICY_APPROVAL_CUSTOM_TYPE) return [];
			const record = event.record;
			if (
				record.reviewer === undefined ||
				record.resolvedAt === undefined ||
				record.outcome === undefined ||
				(record.reviewRequirement !== "reviewer" && record.reviewRequirement !== "team_enforced") ||
				record.scopeDigest === undefined ||
				(filter.requestId !== undefined && (record.requestId ?? record.id) !== filter.requestId) ||
				(filter.bindingId !== undefined && record.bindingId !== filter.bindingId) ||
				(filter.scopeDigest !== undefined && record.scopeDigest !== filter.scopeDigest)
			) {
				return [];
			}
			return [createPolicyReviewEvidence({
				requestId: record.requestId ?? record.id,
				bindingId: record.bindingId,
				requirement: record.reviewRequirement,
				reviewer: record.reviewer,
				decision: record.outcome,
				resolvedAt: record.resolvedAt,
				scopeDigest: record.scopeDigest,
			})];
		});
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
