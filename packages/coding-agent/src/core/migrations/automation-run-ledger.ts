import { canonicalFoundationJson } from "@aos-agent/agent-core";
import {
	parseRunBindingAssociation,
	type RunBindingAssociation,
} from "../binding-handles.ts";
import { isExternalExecutionRef } from "../external-session-mapping.ts";
import { POLICY_RESOURCE_CATEGORIES } from "../execution-policy.ts";
import {
	isAutomationErrorCode,
	isRunClientRequestId,
	isRunRequestFingerprint,
	isRunTimestamp,
	type AutomationError,
	type PersistedRunLedgerEntry,
	type RunModelAttemptSummary,
	type RunModelBudgetSummary,
	type RunModelReference,
	type RunReceipt,
	type RunRecord,
	type RunUsage,
} from "../run-lifecycle.ts";
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

export type LegacyAutomationRunStatusV1 = RunRecord["status"];
export type LegacyAutomationRunTerminalStatusV1 = RunReceipt["status"];
export type LegacyThinkingLevelV1 = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type LegacyAutomationErrorV1 = AutomationError;
export type LegacyAutomationRunModelReferenceV1 = RunModelReference;
export type LegacyAutomationRunRecordV1 = RunRecord;
export type LegacyAutomationRunUsageV1 = RunUsage;
export type LegacyAutomationRunReceiptV1 = RunReceipt;
export type LegacyAutomationRunLedgerEntryV1 = PersistedRunLedgerEntry;

export type HistoricalAutomationRunProjectionV1 = Omit<
	LegacyAutomationRunRecordV1,
	"id" | "status" | "bindingAssociation" | "startedAt" | "endedAt" | "terminalError"
> & {
	readonly runId: string;
	readonly status: LegacyAutomationRunStatusV1;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly terminal?: Omit<LegacyAutomationRunReceiptV1, "bindingAssociation">;
	/** Historical handle/association data is retained only as a read view. */
	readonly bindingAssociationView?: RunBindingAssociation;
	readonly recovery?: "interrupted";
};

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
	"requestScope",
	"clientRequestId",
	"requestFingerprint",
	"external",
	"deadlineAt",
	"sourceRunId",
	"previousBindingId",
	"capabilityBindingId",
	"modelBindingId",
	"previousModelBindingId",
	"policyBindingId",
	"previousPolicyBindingId",
	"finalModel",
	"modelAttempts",
	"modelBudget",
	"policySummary",
	"bindingAssociation",
	"startedAt",
	"endedAt",
	"terminalError",
] as const;
const RECEIPT_REQUIRED_KEYS = ["runId", "sessionId", "status", "usage"] as const;
const RECEIPT_OPTIONAL_KEYS = [
	"external",
	"deadlineAt",
	"finalText",
	"sessionFile",
	"terminalError",
	"contextSnapshotId",
	"capabilityBindingId",
	"modelBindingId",
	"previousModelBindingId",
	"policyBindingId",
	"previousPolicyBindingId",
	"attachments",
	"finalModel",
	"modelAttempts",
	"modelBudget",
	"policySummary",
	"bindingAssociation",
] as const;

const MODEL_USAGE_KEYS = ["input", "output", "total", "inputTokens", "outputTokens", "totalTokens", "costUsd", "cost"] as const;
const MODEL_ATTEMPT_REQUIRED_KEYS = ["attemptId", "bindingId", "candidate", "order", "status", "startedAt"] as const;
const MODEL_ATTEMPT_OPTIONAL_KEYS = ["endedAt", "failureCategory", "usage", "visibleOutput", "contextSnapshotId", "summary"] as const;
const MODEL_BUDGET_KEYS = [
	"modelCalls",
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"costUsd",
	"maxModelCalls",
	"maxInputTokens",
	"maxOutputTokens",
	"maxTotalTokens",
	"maxCostUsd",
	"exceeded",
] as const;
const POLICY_REQUIRED_KEYS = [
	"bindingId",
	"profileId",
	"profileRevision",
	"projectTrust",
	"enforcement",
	"sandboxStatus",
	"sandboxCapabilities",
] as const;
const POLICY_OPTIONAL_KEYS = [
	"sandboxProviderId",
	"resource",
	"action",
	"outcome",
	"reasonCode",
	"requestId",
	"timestamp",
] as const;
const SANDBOX_CAPABILITY_REQUIRED_KEYS = ["filesystem", "process", "network", "credentialIsolation"] as const;
const SANDBOX_CAPABILITY_OPTIONAL_KEYS = ["credentialDelivery"] as const;
const POLICY_RESOURCES = new Set<string>(POLICY_RESOURCE_CATEGORIES);
const ATTACHMENT_REQUIRED_KEYS = ["sourceId", "kind", "contentDigest", "byteCount", "blockCount"] as const;
const ATTACHMENT_OPTIONAL_KEYS = [
	"descriptorId",
	"revision",
	"capabilityBindingId",
	"policyBindingId",
	"mimeTypes",
] as const;

const RUN_METADATA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RUN_METADATA_TEXT_PATTERN = /^[^\u0000-\u001f\u007f\r\n]{1,512}$/u;
const RUN_ATTACHMENT_DIGEST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RUN_ATTACHMENT_CONTENT_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const OPAQUE_BINDING_ID_PATTERN = /^binding:[A-Za-z0-9_-]{43}$/u;
const OPAQUE_REVISION_PATTERN = /^rev:[A-Za-z0-9_-]{43}$/u;
const OPAQUE_DESCRIPTOR_ID_PATTERN = /^([a-z_]+):source:[A-Za-z0-9_-]{43}:(.+)$/u;
const OPAQUE_CAPABILITY_KINDS = new Set([
	"builtin_tool",
	"extension_tool",
	"sdk_tool",
	"skill",
	"extension",
	"mcp_server",
	"mcp_tool",
	"mcp_resource",
	"mcp_resource_template",
	"mcp_prompt",
]);
const POLICY_ERROR_CODES = new Set([
	"policy_settings_invalid",
	"policy_profile_not_found",
	"policy_profile_untrusted",
	"policy_binding_failed",
	"policy_approval_required",
	"policy_denied",
	"policy_violation",
	"workspace_boundary_violation",
	"network_policy_violation",
	"credential_policy_violation",
	"sandbox_required",
	"sandbox_unavailable",
	"sandbox_start_failed",
	"sandbox_capability_insufficient",
	"policy_ledger_persistence_failed",
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

function isRunMetadataId(value: unknown): value is string {
	return typeof value === "string" && RUN_METADATA_ID_PATTERN.test(value);
}

function isRunMetadataText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		RUN_METADATA_TEXT_PATTERN.test(value) &&
		!value.includes("://") &&
		!value.includes("@")
	);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOpaqueCapabilityBindingId(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_BINDING_ID_PATTERN.test(value);
}

function isOpaqueCapabilityRevision(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_REVISION_PATTERN.test(value);
}

function isOpaqueCapabilityDescriptorId(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = OPAQUE_DESCRIPTOR_ID_PATTERN.exec(value);
	return match !== null && OPAQUE_CAPABILITY_KINDS.has(match[1]);
}

function decodeError(value: unknown): LegacyAutomationErrorV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["code", "message", "retryable"]) ||
		!isAutomationErrorCode(value.code) ||
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

function decodeFinalModel(value: unknown): RunRecord["finalModel"] {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["provider"], ["id", "modelId", "thinkingLevel"]) ||
		!isRunMetadataText(value.provider) ||
		(value.id === undefined && value.modelId === undefined) ||
		(value.id !== undefined && !isRunMetadataText(value.id)) ||
		(value.modelId !== undefined && !isRunMetadataText(value.modelId)) ||
		(value.thinkingLevel !== undefined && !isThinkingLevel(value.thinkingLevel))
	) {
		throw new PrivateMigrationError("Historical automation final model has an invalid exact shape");
	}
	return cloneCanonical(value, "Historical automation final model") as unknown as NonNullable<RunRecord["finalModel"]>;
}

function decodeModelUsage(value: unknown): NonNullable<RunModelAttemptSummary["usage"]> {
	if (!isRecord(value) || !hasExactKeys(value, [], MODEL_USAGE_KEYS)) {
		throw new PrivateMigrationError("Historical automation model usage has an invalid exact shape");
	}
	for (const key of MODEL_USAGE_KEYS) {
		if (value[key] !== undefined && !isNonNegativeFiniteNumber(value[key])) {
			throw new PrivateMigrationError("Historical automation model usage contains an invalid value");
		}
	}
	return cloneCanonical(value, "Historical automation model usage") as NonNullable<RunModelAttemptSummary["usage"]>;
}

function decodeModelAttempt(value: unknown): RunModelAttemptSummary {
	if (!isRecord(value) || !hasExactKeys(value, MODEL_ATTEMPT_REQUIRED_KEYS, MODEL_ATTEMPT_OPTIONAL_KEYS)) {
		throw new PrivateMigrationError("Historical automation model attempt has an invalid exact shape");
	}
	if (
		!isRunMetadataId(value.attemptId) ||
		!isRunMetadataId(value.bindingId) ||
		!Number.isInteger(value.order) ||
		(value.order as number) < 0 ||
		(value.status !== "started" && value.status !== "completed" && value.status !== "failed" && value.status !== "cancelled") ||
		!isRunMetadataText(value.startedAt) ||
		(value.endedAt !== undefined && !isRunMetadataText(value.endedAt)) ||
		(value.failureCategory !== undefined && !isRunMetadataId(value.failureCategory)) ||
		(value.visibleOutput !== undefined && typeof value.visibleOutput !== "boolean") ||
		(value.contextSnapshotId !== undefined && !isRunMetadataId(value.contextSnapshotId)) ||
		(value.summary !== undefined && !isRunMetadataText(value.summary))
	) {
		throw new PrivateMigrationError("Historical automation model attempt is invalid");
	}
	decodeFinalModel(value.candidate);
	if (value.usage !== undefined) decodeModelUsage(value.usage);
	return cloneCanonical(value, "Historical automation model attempt") as unknown as RunModelAttemptSummary;
}

function decodeModelAttempts(value: unknown): ReadonlyArray<RunModelAttemptSummary> {
	if (!Array.isArray(value)) {
		throw new PrivateMigrationError("Historical automation model attempts are invalid");
	}
	return value.map(decodeModelAttempt);
}

function decodeModelBudget(value: unknown): RunModelBudgetSummary {
	if (!isRecord(value) || !hasExactKeys(value, [], MODEL_BUDGET_KEYS)) {
		throw new PrivateMigrationError("Historical automation model budget has an invalid exact shape");
	}
	for (const key of MODEL_BUDGET_KEYS) {
		const candidate = value[key];
		if (key === "exceeded") {
			if (candidate !== undefined && typeof candidate !== "boolean") {
				throw new PrivateMigrationError("Historical automation model budget contains an invalid value");
			}
		} else if (candidate !== undefined && !isNonNegativeFiniteNumber(candidate)) {
			throw new PrivateMigrationError("Historical automation model budget contains an invalid value");
		}
	}
	return cloneCanonical(value, "Historical automation model budget") as RunModelBudgetSummary;
}

function decodePolicySummary(value: unknown): NonNullable<RunRecord["policySummary"]> {
	if (!isRecord(value) || !hasExactKeys(value, POLICY_REQUIRED_KEYS, POLICY_OPTIONAL_KEYS)) {
		throw new PrivateMigrationError("Historical automation policy summary has an invalid exact shape");
	}
	if (
		!isRunMetadataId(value.bindingId) ||
		!isRunMetadataId(value.profileId) ||
		!isRunMetadataId(value.profileRevision) ||
		(value.projectTrust !== "trusted" && value.projectTrust !== "untrusted") ||
		(value.enforcement !== "legacy" && value.enforcement !== "host" && value.enforcement !== "sandbox") ||
		(value.sandboxProviderId !== undefined && !isRunMetadataId(value.sandboxProviderId)) ||
		(value.sandboxStatus !== "not_required" &&
			value.sandboxStatus !== "unavailable" &&
			value.sandboxStatus !== "preparing" &&
			value.sandboxStatus !== "ready" &&
			value.sandboxStatus !== "failed" &&
			value.sandboxStatus !== "disposed") ||
		!isRecord(value.sandboxCapabilities) ||
		!hasExactKeys(value.sandboxCapabilities, SANDBOX_CAPABILITY_REQUIRED_KEYS, SANDBOX_CAPABILITY_OPTIONAL_KEYS) ||
		SANDBOX_CAPABILITY_REQUIRED_KEYS.some((key) => typeof (value.sandboxCapabilities as Record<string, unknown>)[key] !== "boolean") ||
		((value.sandboxCapabilities as Record<string, unknown>).credentialDelivery !== undefined &&
			typeof (value.sandboxCapabilities as Record<string, unknown>).credentialDelivery !== "boolean") ||
		(value.resource !== undefined && (typeof value.resource !== "string" || !POLICY_RESOURCES.has(value.resource))) ||
		(value.action !== undefined && value.action !== "allow" && value.action !== "ask" && value.action !== "deny") ||
		(value.outcome !== undefined &&
			value.outcome !== "allow" &&
			value.outcome !== "ask" &&
			value.outcome !== "deny" &&
			value.outcome !== "sandbox_required") ||
		(value.reasonCode !== undefined &&
			(typeof value.reasonCode !== "string" || !POLICY_ERROR_CODES.has(value.reasonCode))) ||
		(value.requestId !== undefined && !isRunMetadataId(value.requestId)) ||
		(value.timestamp !== undefined && !isRunMetadataText(value.timestamp))
	) {
		throw new PrivateMigrationError("Historical automation policy summary is invalid");
	}
	return cloneCanonical(value, "Historical automation policy summary") as unknown as NonNullable<RunRecord["policySummary"]>;
}

function decodeAttachment(value: unknown): NonNullable<RunReceipt["attachments"]>[number] {
	if (!isRecord(value) || !hasExactKeys(value, ATTACHMENT_REQUIRED_KEYS, ATTACHMENT_OPTIONAL_KEYS)) {
		throw new PrivateMigrationError("Historical automation attachment has an invalid exact shape");
	}
	if (
		typeof value.sourceId !== "string" ||
		!RUN_ATTACHMENT_DIGEST_ID_PATTERN.test(value.sourceId) ||
		(value.kind !== "resource" && value.kind !== "prompt") ||
		(value.descriptorId !== undefined && !isOpaqueCapabilityDescriptorId(value.descriptorId)) ||
		(value.revision !== undefined && !isOpaqueCapabilityRevision(value.revision)) ||
		(value.capabilityBindingId !== undefined && !isOpaqueCapabilityBindingId(value.capabilityBindingId)) ||
		(value.policyBindingId !== undefined && !isRunMetadataId(value.policyBindingId)) ||
		typeof value.contentDigest !== "string" ||
		!RUN_ATTACHMENT_CONTENT_DIGEST_PATTERN.test(value.contentDigest) ||
		!Number.isInteger(value.byteCount) ||
		(value.byteCount as number) < 0 ||
		!Number.isInteger(value.blockCount) ||
		(value.blockCount as number) < 0 ||
		(value.mimeTypes !== undefined &&
			(!Array.isArray(value.mimeTypes) ||
				value.mimeTypes.length > 16 ||
				value.mimeTypes.some((mimeType) => !isRunMetadataText(mimeType))))
	) {
		throw new PrivateMigrationError("Historical automation attachment is invalid");
	}
	return cloneCanonical(value, "Historical automation attachment") as unknown as NonNullable<RunReceipt["attachments"]>[number];
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
	const hasRequestRelation =
		value.requestScope !== undefined || value.clientRequestId !== undefined || value.requestFingerprint !== undefined;
	if (
		!isNonEmptyString(value.id) ||
		!isNonEmptyString(value.sessionId) ||
		!Number.isSafeInteger(value.attempt) ||
		(value.attempt as number) < 0 ||
		value.status !== "accepted" ||
		(hasRequestRelation &&
			((value.requestScope !== "start" && value.requestScope !== "resume") ||
				!isRunClientRequestId(value.clientRequestId) ||
				!isRunRequestFingerprint(value.requestFingerprint))) ||
		(value.external !== undefined && !isExternalExecutionRef(value.external)) ||
		(value.deadlineAt !== undefined && !isRunTimestamp(value.deadlineAt)) ||
		(value.sourceRunId !== undefined && !isNonEmptyString(value.sourceRunId)) ||
		(value.previousBindingId !== undefined && typeof value.previousBindingId !== "string") ||
		(value.capabilityBindingId !== undefined && typeof value.capabilityBindingId !== "string") ||
		(value.modelBindingId !== undefined && !isRunMetadataId(value.modelBindingId)) ||
		(value.previousModelBindingId !== undefined && !isRunMetadataId(value.previousModelBindingId)) ||
		(value.policyBindingId !== undefined && !isRunMetadataId(value.policyBindingId)) ||
		(value.previousPolicyBindingId !== undefined && !isRunMetadataId(value.previousPolicyBindingId)) ||
		value.startedAt !== undefined ||
		value.endedAt !== undefined ||
		value.terminalError !== undefined
	) {
		throw new PrivateMigrationError("Historical automation accepted record violates accepted-state invariants");
	}
	decodeModel(value.model);
	if (value.finalModel !== undefined) decodeFinalModel(value.finalModel);
	if (value.modelAttempts !== undefined) decodeModelAttempts(value.modelAttempts);
	if (value.modelBudget !== undefined) decodeModelBudget(value.modelBudget);
	if (value.policySummary !== undefined) decodePolicySummary(value.policySummary);
	const bindingAssociation = decodeAssociation(value.bindingAssociation, value.id);
	return cloneCanonical(
		bindingAssociation === undefined ? value : { ...value, bindingAssociation },
		"Historical automation accepted record",
	) as unknown as LegacyAutomationRunRecordV1;
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
		(value.external !== undefined && !isExternalExecutionRef(value.external)) ||
		(value.deadlineAt !== undefined && !isRunTimestamp(value.deadlineAt)) ||
		(value.finalText !== undefined && typeof value.finalText !== "string") ||
		(value.sessionFile !== undefined && typeof value.sessionFile !== "string") ||
		(value.contextSnapshotId !== undefined && typeof value.contextSnapshotId !== "string") ||
		(value.capabilityBindingId !== undefined && typeof value.capabilityBindingId !== "string") ||
		(value.modelBindingId !== undefined && !isRunMetadataId(value.modelBindingId)) ||
		(value.previousModelBindingId !== undefined && !isRunMetadataId(value.previousModelBindingId)) ||
		(value.policyBindingId !== undefined && !isRunMetadataId(value.policyBindingId)) ||
		(value.previousPolicyBindingId !== undefined && !isRunMetadataId(value.previousPolicyBindingId))
	) {
		throw new PrivateMigrationError("Historical automation terminal receipt is invalid");
	}
	decodeUsage(value.usage);
	if (value.terminalError !== undefined) decodeError(value.terminalError);
	const bindingAssociation = decodeAssociation(value.bindingAssociation, value.runId);
	if (value.attachments !== undefined) {
		if (!Array.isArray(value.attachments)) {
			throw new PrivateMigrationError("Historical automation attachments are invalid");
		}
		value.attachments.map(decodeAttachment);
	}
	if (value.finalModel !== undefined) decodeFinalModel(value.finalModel);
	if (value.modelAttempts !== undefined) decodeModelAttempts(value.modelAttempts);
	if (value.modelBudget !== undefined) decodeModelBudget(value.modelBudget);
	if (value.policySummary !== undefined) decodePolicySummary(value.policySummary);
	return cloneCanonical(
		bindingAssociation === undefined ? value : { ...value, bindingAssociation },
		"Historical automation terminal receipt",
	) as unknown as LegacyAutomationRunReceiptV1;
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
		if (!hasExactKeys(value, STARTED_KEYS) || !isNonEmptyString(value.runId) || !isRunTimestamp(value.startedAt)) {
			throw new PrivateMigrationError("Historical started fact has an invalid exact shape");
		}
		return { schemaVersion: 1, kind: "started", runId: value.runId, startedAt: value.startedAt };
	}
	if (value.kind === "terminal") {
		if (!hasExactKeys(value, TERMINAL_KEYS) || !isRunTimestamp(value.endedAt)) {
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
		if (fold.startedAt === undefined) {
			throw new PrivateMigrationError(`Historical terminal fact precedes started for run ${runId}`);
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
			const {
				id: runId,
				status: _acceptedStatus,
				bindingAssociation: _bindingAssociation,
				startedAt: _acceptedStartedAt,
				endedAt: _acceptedEndedAt,
				terminalError: _acceptedTerminalError,
				...acceptedMetadata
			} = fold.accepted;
			return {
				...acceptedMetadata,
				runId,
				status: terminal?.status ?? (fold.startedAt === undefined ? "accepted" : "running"),
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
