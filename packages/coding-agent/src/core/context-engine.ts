/**
 * Context Engine v1: pure plan, budget, source ordering, snapshot receipt,
 * content digest, and historical drift comparison.
 *
 * This module does not read disk, write Session, or call models. Callers supply
 * already-resolved sources and messages; the engine decides inclusion order,
 * dispositions, and freezes a metadata-only ContextSnapshot.
 *
 * Erasable TypeScript only (no enums, namespaces, or parameter properties).
 */

import { createHash } from "node:crypto";
import type { AgentMessage } from "@aos-agent/agent-core";
import { estimateContextTokens, estimateTokens } from "./compaction/compaction.ts";

// ---- Custom entry type ------------------------------------------------------

/** Session custom entry type for frozen ContextSnapshot payloads. */
export const CONTEXT_SNAPSHOT_CUSTOM_TYPE = "context.snapshot";

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1 as const;

// ---- Purpose / kinds / trust / scope ----------------------------------------

export type ContextPurpose = "agent_turn" | "compaction" | "branch_summary";

export type ContextSourceKind =
	| "system"
	| "instruction"
	| "capability_index"
	| "session_summary"
	| "session_message"
	| "memory"
	| "extension";

export type ContextTrust = "builtin" | "user_owned" | "trusted_project" | "untrusted_project";

export type ContextScope = "global" | "project" | "directory" | "session" | "turn";

export type ContextDisposition = "included" | "trimmed" | "excluded";

export type ContextDispositionReason =
	| "within_budget"
	| "budget_exhausted"
	| "untrusted"
	| "disabled"
	| "revoked"
	| "snapshot_only";

export type ContextSourceDriftStatus = "unchanged" | "source_changed" | "source_unavailable";

// ---- Errors -----------------------------------------------------------------

export type ContextErrorCode =
	| "context_budget_exceeded"
	| "context_snapshot_persistence_failed"
	| "context_snapshot_not_found"
	| "context_source_unavailable"
	| "context_memory_disabled"
	| "context_memory_not_found"
	| "context_memory_write_requires_explicit_action"
	| "context_extension_source_missing";

export interface ContextError {
	code: ContextErrorCode;
	message: string;
	retryable: boolean;
	/** Present when budget validation fails. */
	budget?: ContextBudget;
	/** Present when budget validation fails: required sources that would not fit. */
	offendingSourceIds?: string[];
}

export function createContextError(
	code: ContextErrorCode,
	message: string,
	retryable: boolean,
	extras?: { budget?: ContextBudget; offendingSourceIds?: string[] },
): ContextError {
	const error: ContextError = { code, message, retryable };
	if (extras?.budget !== undefined) {
		error.budget = extras.budget;
	}
	if (extras?.offendingSourceIds !== undefined) {
		error.offendingSourceIds = extras.offendingSourceIds;
	}
	return error;
}

// ---- Source inputs ----------------------------------------------------------

/**
 * Caller-supplied context source before planning. `content` is used only for
 * digest and token estimation in memory; it is never stored on a snapshot.
 */
export interface ContextSourceInput {
	sourceId: string;
	kind: ContextSourceKind;
	scope: ContextScope;
	trust: ContextTrust;
	/** Stable display label for extension sources. */
	label?: string;
	/** Whether an extension source reaches the model or only its snapshot receipt. */
	visibility?: ContextExtensionVisibility;
	path?: string;
	content: string;
	/** Required sources must fit; excess fails with context_budget_exceeded. */
	required: boolean;
	/**
	 * Optional pre-declared disposition reasons applied before budget packing
	 * (e.g. untrusted project rules, disabled/revoked memory).
	 */
	preDisposition?: {
		disposition: "excluded";
		reason: Extract<ContextDispositionReason, "untrusted" | "disabled" | "revoked" | "snapshot_only">;
	};
	/** Memory / extension reference IDs recorded on receipts without body text. */
	refId?: string;
	/**
	 * Where the already-resolved source is injected. System is the default.
	 * Message sources must supply the exact message that is appended to the
	 * in-memory plan; neither the message nor its body is frozen in a snapshot.
	 */
	placement?: "system" | "message";
	message?: AgentMessage;
	/** Multiple model messages contributed by one labeled extension source. */
	messages?: readonly AgentMessage[];
	/** System-prompt append contributed by one labeled extension source. */
	systemPromptAppend?: string;
	/** Exact caller-supplied estimate when one source maps to multiple model inputs. */
	estimatedTokens?: number;
	/** The message is already present in `sessionMessages` or `turnMessages`. */
	alreadyIncludedInMessages?: boolean;
}

export type ContextExtensionVisibility = "snapshot_only" | "model_and_snapshot";

export interface ContextExtensionContribution {
	sourceId: string;
	label: string;
	visibility: ContextExtensionVisibility;
	messages?: AgentMessage[];
	systemPromptAppend?: string;
}

/** Metadata-only extension contribution receipt. Raw bodies are never persisted. */
export interface ContextExtensionContributionReceipt {
	sourceId: string;
	label: string;
	visibility: ContextExtensionVisibility;
	contentDigest: string;
	estimatedTokens: number;
}

export type ContextExtensionContributionValidationResult =
	| { ok: true; contribution: ContextExtensionContribution }
	| { ok: false; error: ContextError };

// ---- Receipts / plan / snapshot ---------------------------------------------

export interface ContextSourceReceipt {
	sourceId: string;
	kind: ContextSourceKind;
	scope: ContextScope;
	trust: ContextTrust;
	label?: string;
	visibility?: ContextExtensionVisibility;
	path?: string;
	contentDigest: string;
	estimatedTokens: number;
	disposition: ContextDisposition;
	reason?: ContextDispositionReason;
	/** Memory or extension reference without body text. */
	refId?: string;
}

export interface ContextBudget {
	contextWindow: number;
	reserveTokens: number;
	inputLimit: number;
	estimatedInputTokens: number;
}

export interface ContextPlan {
	purpose: ContextPurpose;
	sessionId: string;
	runId?: string;
	sources: ContextSourceReceipt[];
	budget: ContextBudget;
	/** In-memory only; never persisted on ContextSnapshot. */
	messages: AgentMessage[];
	/** In-memory only; never persisted on ContextSnapshot. */
	systemPrompt: string;
}

export interface ContextSnapshot {
	schemaVersion: typeof CONTEXT_SNAPSHOT_SCHEMA_VERSION;
	id: string;
	purpose: ContextPurpose;
	sessionId: string;
	runId?: string;
	createdAt: string;
	parentSnapshotId?: string;
	sources: ContextSourceReceipt[];
	budget: ContextBudget;
}

export interface ContextSourceDrift {
	sourceId: string;
	status: ContextSourceDriftStatus;
	previousDigest?: string;
	currentDigest?: string;
	path?: string;
}

export interface ContextResolveInput {
	purpose: ContextPurpose;
	sessionId: string;
	runId?: string;
	contextWindow: number;
	reserveTokens: number;
	sources: readonly ContextSourceInput[];
	/**
	 * Session path messages already selected by SessionManager (summaries + tail).
	 * Included in plan.messages after included sources are applied.
	 */
	sessionMessages: readonly AgentMessage[];
	/** Current-turn user/extension messages that must appear after session messages. */
	turnMessages: readonly AgentMessage[];
}

export type ContextResolveResult =
	| { ok: true; plan: ContextPlan }
	| { ok: false; error: ContextError };

// ---- Digest / token helpers -------------------------------------------------

/** Stable SHA-256 hex digest of UTF-8 text content. */
export function digestContextContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Token estimate for raw text using the shared compaction estimator. */
export function estimateContextTextTokens(text: string): number {
	return estimateTokens({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContextExtensionVisibility(value: unknown): value is ContextExtensionVisibility {
	return value === "snapshot_only" || value === "model_and_snapshot";
}

function canonicalizeContextValue(value: unknown, ancestors: Set<object> = new Set()): unknown {
	if (Array.isArray(value)) {
		if (ancestors.has(value)) {
			throw new Error("Context extension contribution cannot contain circular data");
		}
		ancestors.add(value);
		try {
			return value.map((entry) => canonicalizeContextValue(entry, ancestors));
		} finally {
			ancestors.delete(value);
		}
	}
	if (!isRecord(value)) {
		return value;
	}
	if (ancestors.has(value)) {
		throw new Error("Context extension contribution cannot contain circular data");
	}
	ancestors.add(value);
	try {
		const canonical: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			if (value[key] !== undefined) {
				canonical[key] = canonicalizeContextValue(value[key], ancestors);
			}
		}
		return canonical;
	} finally {
		ancestors.delete(value);
	}
}

function serializeContextExtensionContribution(contribution: ContextExtensionContribution): string {
	return JSON.stringify(
		canonicalizeContextValue({
			messages: contribution.messages,
			systemPromptAppend: contribution.systemPromptAppend,
		}),
	);
}

function invalidExtensionContribution(message: string): ContextError {
	return createContextError("context_extension_source_missing", message, false);
}

/** Validate and normalize the formal Context extension contribution contract. */
export function validateContextExtensionContribution(
	value: unknown,
): ContextExtensionContributionValidationResult {
	if (!isRecord(value)) {
		return { ok: false, error: invalidExtensionContribution("Context extension contribution must be an object") };
	}
	if (typeof value.sourceId !== "string" || value.sourceId.trim().length === 0) {
		return {
			ok: false,
			error: invalidExtensionContribution("Context extension contribution requires a non-empty sourceId"),
		};
	}
	if (typeof value.label !== "string" || value.label.trim().length === 0) {
		return {
			ok: false,
			error: invalidExtensionContribution("Context extension contribution requires a non-empty label"),
		};
	}
	if (!isContextExtensionVisibility(value.visibility)) {
		return {
			ok: false,
			error: invalidExtensionContribution(
				"Context extension contribution visibility must be snapshot_only or model_and_snapshot",
			),
		};
	}
	if (value.messages !== undefined && !Array.isArray(value.messages)) {
		return {
			ok: false,
			error: invalidExtensionContribution("Context extension contribution messages must be an array"),
		};
	}
	if (
		Array.isArray(value.messages) &&
		value.messages.some((message) => !isRecord(message) || typeof message.role !== "string")
	) {
		return {
			ok: false,
			error: invalidExtensionContribution("Context extension contribution messages must be AgentMessage values"),
		};
	}
	if (value.systemPromptAppend !== undefined && typeof value.systemPromptAppend !== "string") {
		return {
			ok: false,
			error: invalidExtensionContribution("Context extension contribution systemPromptAppend must be a string"),
		};
	}

	const contribution: ContextExtensionContribution = {
		sourceId: value.sourceId.trim(),
		label: value.label.trim(),
		visibility: value.visibility,
	};
	if (value.messages !== undefined) {
		contribution.messages = [...value.messages] as AgentMessage[];
	}
	if (value.systemPromptAppend !== undefined) {
		contribution.systemPromptAppend = value.systemPromptAppend;
	}
	try {
		serializeContextExtensionContribution(contribution);
	} catch {
		return {
			ok: false,
			error: invalidExtensionContribution("Context extension contribution must be JSON-serializable"),
		};
	}
	return { ok: true, contribution };
}

/** Build a metadata-only receipt for a validated extension contribution. */
export function createContextExtensionContributionReceipt(
	value: ContextExtensionContribution,
): ContextExtensionContributionReceipt {
	const validated = validateContextExtensionContribution(value);
	if (!validated.ok) {
		throw new Error(validated.error.message);
	}
	const contribution = validated.contribution;
	return {
		sourceId: contribution.sourceId,
		label: contribution.label,
		visibility: contribution.visibility,
		contentDigest: digestContextContent(serializeContextExtensionContribution(contribution)),
		estimatedTokens:
			(contribution.messages ?? []).reduce((total, message) => total + estimateTokens(message), 0) +
			(contribution.systemPromptAppend === undefined
				? 0
				: estimateContextTextTokens(contribution.systemPromptAppend)),
	};
}

/** Convert one formal contribution into one Engine-managed source. */
export function createContextExtensionSourceInput(value: ContextExtensionContribution): ContextSourceInput {
	const validated = validateContextExtensionContribution(value);
	if (!validated.ok) {
		throw new Error(validated.error.message);
	}
	const contribution = validated.contribution;
	const receipt = createContextExtensionContributionReceipt(contribution);
	const source: ContextSourceInput = {
		sourceId: contribution.sourceId,
		kind: "extension",
		scope: "turn",
		trust: "user_owned",
		label: contribution.label,
		visibility: contribution.visibility,
		content: serializeContextExtensionContribution(contribution),
		required: contribution.visibility === "model_and_snapshot",
		refId: contribution.sourceId,
		estimatedTokens: receipt.estimatedTokens,
		placement: contribution.messages && contribution.messages.length > 0 ? "message" : "system",
	};
	if (contribution.messages !== undefined) {
		source.messages = contribution.messages;
	}
	if (contribution.systemPromptAppend !== undefined) {
		source.systemPromptAppend = contribution.systemPromptAppend;
	}
	if (contribution.visibility === "snapshot_only") {
		source.preDisposition = { disposition: "excluded", reason: "snapshot_only" };
	}
	return source;
}

/**
 * Context packing priority (lower index = higher priority).
 * Required extension contributions belong with the current turn; optional
 * extension contributions must not displace retained session context, memory,
 * or the capability index.
 */
function sourcePriority(source: ContextSourceInput): number {
	switch (source.kind) {
		case "system":
			return 0;
		case "instruction":
			return 1;
		case "extension":
			return source.required ? 2 : 7;
		case "session_summary":
			return 3;
		case "session_message":
			return source.scope === "turn" ? 2 : 4;
		case "memory":
			return 5;
		case "capability_index":
			return 6;
	}
}

/**
 * Secondary scope order within instruction / directory-ish sources
 * (outer → inner: global, project, directory, session, turn).
 */
const SCOPE_PRIORITY: Record<ContextScope, number> = {
	global: 0,
	project: 1,
	directory: 2,
	session: 3,
	turn: 4,
};

function compareSources(a: ContextSourceInput, b: ContextSourceInput, indexA: number, indexB: number): number {
	const priorityDelta = sourcePriority(a) - sourcePriority(b);
	if (priorityDelta !== 0) {
		return priorityDelta;
	}
	if (a.required !== b.required) {
		return a.required ? -1 : 1;
	}
	if (a.kind === "instruction") {
		const scopeDelta = SCOPE_PRIORITY[a.scope] - SCOPE_PRIORITY[b.scope];
		if (scopeDelta !== 0) {
			return scopeDelta;
		}
	}
	return indexA - indexB;
}

function sortSourcesStable(sources: readonly ContextSourceInput[]): ContextSourceInput[] {
	return sources
		.map((source, index) => ({ source, index }))
		.sort((left, right) => compareSources(left.source, right.source, left.index, right.index))
		.map((entry) => entry.source);
}

function buildReceipt(
	source: ContextSourceInput,
	disposition: ContextDisposition,
	reason: ContextDispositionReason | undefined,
): ContextSourceReceipt {
	const receipt: ContextSourceReceipt = {
		sourceId: source.sourceId,
		kind: source.kind,
		scope: source.scope,
		trust: source.trust,
		contentDigest: digestContextContent(source.content),
		estimatedTokens: estimateSourceTokens(source),
		disposition,
	};
	if (source.path !== undefined) {
		receipt.path = source.path;
	}
	if (source.label !== undefined) {
		receipt.label = source.label;
	}
	if (source.visibility !== undefined) {
		receipt.visibility = source.visibility;
	}
	if (reason !== undefined) {
		receipt.reason = reason;
	}
	if (source.refId !== undefined) {
		receipt.refId = source.refId;
	}
	return receipt;
}

function estimateSourceTokens(source: ContextSourceInput): number {
	if (source.estimatedTokens !== undefined) {
		return source.estimatedTokens;
	}
	if (source.messages !== undefined) {
		return (
			source.messages.reduce((total, message) => total + estimateTokens(message), 0) +
			(source.systemPromptAppend === undefined ? 0 : estimateContextTextTokens(source.systemPromptAppend))
		);
	}
	if (source.placement === "message" && source.message) {
		return estimateTokens(source.message);
	}
	return estimateContextTextTokens(source.content);
}

/** A message already present in the transcript has a receipt cost but no extra packing cost. */
function estimatePackingTokens(source: ContextSourceInput): number {
	return source.alreadyIncludedInMessages ? 0 : estimateSourceTokens(source);
}

function composeSystemPrompt(sources: readonly ContextSourceInput[], receipts: readonly ContextSourceReceipt[]): string {
	const includedIds = new Set(receipts.filter((receipt) => receipt.disposition === "included").map((receipt) => receipt.sourceId));
	const parts: string[] = [];
	for (const source of sources) {
		if (!includedIds.has(source.sourceId)) {
			continue;
		}
		const content = source.kind === "extension" ? (source.systemPromptAppend ?? "") : source.placement === "message" ? "" : source.content;
		if (content.length > 0) {
			parts.push(content);
		}
	}
	return parts.join("\n\n");
}

function collectIncludedMessageSources(
	sources: readonly ContextSourceInput[],
	receipts: readonly ContextSourceReceipt[],
): AgentMessage[] {
	const includedIds = new Set(
		receipts.filter((receipt) => receipt.disposition === "included").map((receipt) => receipt.sourceId),
	);
	const messages: AgentMessage[] = [];
	for (const source of sources) {
		if (source.alreadyIncludedInMessages || !includedIds.has(source.sourceId)) {
			continue;
		}
		if (source.messages !== undefined) {
			messages.push(...source.messages);
			continue;
		}
		if (source.placement === "message" && source.message) {
			messages.push(source.message);
		}
	}
	return messages;
}

/**
 * Resolve a ContextPlan from prepared sources. Deterministic for the same inputs.
 *
 * Rules:
 * - Untrusted / disabled / revoked sources are excluded before packing.
 * - Required sources that cannot fit return context_budget_exceeded (no silent trim).
 * - Optional sources may be excluded with budget_exhausted.
 * - `trimmed` is reserved for future partial inclusion; v1 never silently trims required text.
 */
export function resolveContext(input: ContextResolveInput): ContextResolveResult {
	const reserveTokens = Math.max(0, input.reserveTokens);
	const contextWindow = Math.max(0, input.contextWindow);
	const inputLimit = Math.max(0, contextWindow - reserveTokens);
	const sourceIds = new Set<string>();
	for (const source of input.sources) {
		if (sourceIds.has(source.sourceId)) {
			return {
				ok: false,
				error: createContextError(
					"context_source_unavailable",
					`Context sourceId must be unique: ${source.sourceId}`,
					false,
				),
			};
		}
		sourceIds.add(source.sourceId);
	}

	const ordered = sortSourcesStable(input.sources);
	const receipts: ContextSourceReceipt[] = [];
	let usedTokens = 0;
	const offendingRequired: string[] = [];
	let requiredOverflowTokens = 0;

	// Session + turn messages count toward the shared budget as a reserved tail.
	// Reuse the established compaction estimator instead of maintaining a second
	// tokenizer with subtly different image/custom-message behavior.
	const sessionTurnTokens = estimateContextTokens([...input.sessionMessages, ...input.turnMessages]).tokens;
	if (sessionTurnTokens > inputLimit) {
		const offendingSourceIds = input.sources
			.filter((source) => source.alreadyIncludedInMessages && source.required)
			.map((source) => source.sourceId);
		const budget: ContextBudget = {
			contextWindow,
			reserveTokens,
			inputLimit,
			estimatedInputTokens: sessionTurnTokens,
		};
		return {
			ok: false,
			error: createContextError(
				"context_budget_exceeded",
				`Session and turn context exceed input budget (${sessionTurnTokens} > ${inputLimit})`,
				false,
				{
					budget,
					offendingSourceIds: offendingSourceIds.length > 0 ? offendingSourceIds : ["session:messages"],
				},
			),
		};
	}

	// First pass: pre-dispositions and untrusted project instructions.
	const pending: ContextSourceInput[] = [];
	for (const source of ordered) {
		if (source.preDisposition) {
			receipts.push(
				buildReceipt(source, source.preDisposition.disposition, source.preDisposition.reason),
			);
			continue;
		}
		if (source.trust === "untrusted_project") {
			receipts.push(buildReceipt(source, "excluded", "untrusted"));
			continue;
		}
		pending.push(source);
	}

	// Account for session/turn messages first so packing leaves room for them.
	usedTokens += sessionTurnTokens;

	for (const source of pending) {
		const tokens = estimatePackingTokens(source);
		const fits = usedTokens + tokens <= inputLimit;

		if (!fits) {
			if (source.required) {
				offendingRequired.push(source.sourceId);
				requiredOverflowTokens += tokens;
				receipts.push(buildReceipt(source, "excluded", "budget_exhausted"));
			} else {
				receipts.push(buildReceipt(source, "excluded", "budget_exhausted"));
			}
			continue;
		}

		usedTokens += tokens;
		receipts.push(buildReceipt(source, "included", "within_budget"));
	}

	// Preserve deterministic receipt order matching inclusion priority (ordered sources).
	const receiptById = new Map(receipts.map((receipt) => [receipt.sourceId, receipt]));
	const orderedReceipts: ContextSourceReceipt[] = [];
	for (const source of ordered) {
		const receipt = receiptById.get(source.sourceId);
		if (receipt) {
			orderedReceipts.push(receipt);
		}
	}

	const estimatedInputTokens = usedTokens;
	const budget: ContextBudget = {
		contextWindow,
		reserveTokens,
		inputLimit,
		estimatedInputTokens,
	};

	if (offendingRequired.length > 0) {
		const errorBudget: ContextBudget = {
			...budget,
			estimatedInputTokens: usedTokens + requiredOverflowTokens,
		};
		return {
			ok: false,
			error: createContextError(
				"context_budget_exceeded",
				`Required context sources exceed input budget (${errorBudget.estimatedInputTokens} > ${inputLimit}): ${offendingRequired.join(", ")}`,
				false,
				{ budget: errorBudget, offendingSourceIds: offendingRequired },
			),
		};
	}

	const systemPrompt = composeSystemPrompt(ordered, orderedReceipts);
	const messageSources = collectIncludedMessageSources(ordered, orderedReceipts);
	const plan: ContextPlan = {
		purpose: input.purpose,
		sessionId: input.sessionId,
		sources: orderedReceipts,
		budget,
		messages: [...input.sessionMessages, ...input.turnMessages, ...messageSources],
		systemPrompt,
	};
	if (input.runId !== undefined) {
		plan.runId = input.runId;
	}

	return { ok: true, plan };
}

/**
 * Freeze a resolved plan into a metadata-only snapshot. Never copies messages,
 * systemPrompt, or source body text.
 */
export function freezeContext(
	plan: ContextPlan,
	input: { id: string; createdAt: string; parentSnapshotId?: string },
): ContextSnapshot {
	const snapshot: ContextSnapshot = {
		schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
		id: input.id,
		purpose: plan.purpose,
		sessionId: plan.sessionId,
		createdAt: input.createdAt,
		sources: plan.sources.map((receipt) => ({ ...receipt })),
		budget: { ...plan.budget },
	};
	if (plan.runId !== undefined) {
		snapshot.runId = plan.runId;
	}
	if (input.parentSnapshotId !== undefined) {
		snapshot.parentSnapshotId = input.parentSnapshotId;
	}
	return snapshot;
}

/**
 * Compare a historical snapshot's source digests against current resolved sources.
 * Does not return or reconstruct historical body text.
 */
export function compareContextSources(
	snapshot: ContextSnapshot,
	currentSources: readonly Pick<ContextSourceInput, "sourceId" | "content" | "path">[],
): ContextSourceDrift[] {
	const currentById = new Map(
		currentSources.map((source) => [
			source.sourceId,
			{
				digest: digestContextContent(source.content),
				path: source.path,
			},
		]),
	);

	const drifts: ContextSourceDrift[] = [];
	for (const receipt of snapshot.sources) {
		const current = currentById.get(receipt.sourceId);
		if (!current) {
			const drift: ContextSourceDrift = {
				sourceId: receipt.sourceId,
				status: "source_unavailable",
				previousDigest: receipt.contentDigest,
			};
			if (receipt.path !== undefined) {
				drift.path = receipt.path;
			}
			drifts.push(drift);
			continue;
		}
		if (current.digest !== receipt.contentDigest || current.path !== receipt.path) {
			const drift: ContextSourceDrift = {
				sourceId: receipt.sourceId,
				status: "source_changed",
				previousDigest: receipt.contentDigest,
				currentDigest: current.digest,
			};
			if (current.path !== undefined) {
				drift.path = current.path;
			} else if (receipt.path !== undefined) {
				drift.path = receipt.path;
			}
			drifts.push(drift);
			continue;
		}
		const drift: ContextSourceDrift = {
			sourceId: receipt.sourceId,
			status: "unchanged",
			previousDigest: receipt.contentDigest,
			currentDigest: current.digest,
		};
		if (receipt.path !== undefined) {
			drift.path = receipt.path;
		}
		drifts.push(drift);
	}
	return drifts;
}

/**
 * Type guard: snapshot payload has no raw content / messages / systemPrompt fields.
 * Used by tests and redaction checks.
 */
export function assertSnapshotMetadataOnly(snapshot: ContextSnapshot): void {
	const json = JSON.stringify(snapshot);
	// Structural: frozen object must not carry content bodies.
	const record = snapshot as unknown as Record<string, unknown>;
	if ("messages" in record || "systemPrompt" in record || "content" in record) {
		throw new Error("ContextSnapshot must not include messages, systemPrompt, or content");
	}
	for (const source of snapshot.sources) {
		const sourceRecord = source as unknown as Record<string, unknown>;
		if ("content" in sourceRecord || "text" in sourceRecord) {
			throw new Error(`ContextSnapshot source ${source.sourceId} must not include content or text`);
		}
	}
	if (json.includes('"content":') && /"content"\s*:\s*"[^"]+"/.test(json)) {
		// Allow contentDigest only.
		const stripped = json.replace(/"contentDigest"\s*:\s*"[a-f0-9]+"/g, "");
		if (/"content"\s*:/.test(stripped)) {
			throw new Error("ContextSnapshot JSON must not embed raw content fields");
		}
	}
}

/**
 * Build instruction blocks for system-prompt rendering from included instruction receipts.
 * Content must be supplied by the caller (engine does not store it on receipts).
 */
export interface ContextInstructionBlock {
	sourceId: string;
	path?: string;
	content: string;
	scope: ContextScope;
	trust: ContextTrust;
}

export function selectIncludedInstructionBlocks(
	plan: ContextPlan,
	sources: readonly ContextSourceInput[],
): ContextInstructionBlock[] {
	const contentById = new Map(sources.map((source) => [source.sourceId, source]));
	const blocks: ContextInstructionBlock[] = [];
	for (const receipt of plan.sources) {
		if (receipt.kind !== "instruction" || receipt.disposition !== "included") {
			continue;
		}
		const source = contentById.get(receipt.sourceId);
		if (!source) {
			continue;
		}
		const block: ContextInstructionBlock = {
			sourceId: receipt.sourceId,
			content: source.content,
			scope: receipt.scope,
			trust: receipt.trust,
		};
		if (receipt.path !== undefined) {
			block.path = receipt.path;
		}
		blocks.push(block);
	}
	return blocks;
}
