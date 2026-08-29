/**
 * Child Context fork: four forkScope modes onto an immutable ContextSnapshotV1.
 *
 * Child role/task is a runtime-only frozen projection (and snapshot summary()).
 * Durable toJSON() keeps digest only: no transcript, credentials, MCP material,
 * or secrets. Parent entries are cloned, never shared, and never rewritten as
 * user messages.
 */

import { Type } from "typebox";
import {
	cloneDeepFrozen,
	canonicalFoundationJson,
	contextSnapshotFromJSON,
	createContextSnapshot,
	FingerprintSchema,
	fingerprintFoundationValue,
	FoundationError,
	projectTaskEnvelope,
	Result,
	RevisionReferenceSchema,
	TaskEnvelopePublicProjectionSchema,
	validateExactShape,
	validateRoleRevision,
	validateTaskEnvelope,
	validateTaskEnvelopePublicProjection,
	type ContextForkMode,
	type ContextSnapshot,
	type ContextSnapshotSource,
	type ContextSnapshotRecord,
	type Entry,
	type Fingerprint,
	type MessageEntry,
	type Result as ResultValue,
	type RevisionReference,
	type RoleRevision,
	type TaskArtifactProjection,
	type TaskContextPackage,
	type TaskEnvelopePublicProjection,
	type TaskEnvelope,
} from "@aos-agent/agent-core";
import { CHILD_CONTEXT_FORK_SCOPES, type ChildContextForkScope } from "./subagent.ts";

export const CHILD_CONTEXT_FORK_SCHEMA_VERSION = 1 as const;
export const TASK_PACKAGE_GOAL_MAX_CHARS = 4096;
export const TASK_PACKAGE_CRITERION_MAX_CHARS = 512;
export const TASK_PACKAGE_MAX_CRITERIA = 32;
export const TASK_PACKAGE_MAX_ARTIFACTS = 32;

export interface ChildContextForkPlan {
	readonly schemaVersion: 1;
	readonly spawnId: string;
	readonly forkScope: ChildContextForkScope;
	readonly recentN?: number;
	readonly taskPackageRef?: string;
	readonly sourceContextDigest?: Fingerprint;
	readonly childSnapshotRef: RevisionReference;
	readonly tokenBudget: number;
}

export interface PersistedTaskPackageProof {
	readonly ref: string;
	readonly digest: Fingerprint;
	readonly projection: TaskEnvelopePublicProjection;
}

export interface ChildRuntimeCriterion {
	readonly criterionId: string;
	readonly description: string;
	readonly required: boolean;
	readonly satisfiedBy: string;
}

/** Runtime-only system/task inputs. Never persisted on ContextSnapshotV1. */
export interface ChildRuntimeLayer {
	readonly schemaVersion: 1;
	readonly kind: "system_task";
	readonly persona: string;
	readonly customInstructions: string;
	readonly goal: string;
	readonly acceptanceCriteria: readonly ChildRuntimeCriterion[];
	readonly inputs: readonly TaskArtifactProjection[];
	readonly expectedOutputs: readonly TaskArtifactProjection[];
}

export interface ForkChildContextInput {
	readonly schemaVersion: 1;
	readonly spawnId: string;
	readonly forkScope: ChildContextForkScope;
	readonly parentSnapshot: ContextSnapshot | ContextSnapshotRecord;
	readonly childRoleRevision: RoleRevision;
	readonly childTaskEnvelope: TaskEnvelope;
	readonly childBindingEpochId: string;
	readonly childTokenBudget: number;
	readonly parentEntries?: readonly Entry[];
	readonly recentN?: number;
	readonly taskPackageRef?: string;
	readonly sourceContextDigest?: Fingerprint;
	readonly persistedTaskPackage?: PersistedTaskPackageProof;
}

export interface ChildContextForkResult {
	readonly plan: ChildContextForkPlan;
	readonly snapshot: ContextSnapshot;
	readonly record: ContextSnapshotRecord;
	readonly runtimeProjection: ChildRuntimeLayer;
}

const INPUT_KEYS = new Set([
	"schemaVersion",
	"spawnId",
	"forkScope",
	"parentSnapshot",
	"childRoleRevision",
	"childTaskEnvelope",
	"childBindingEpochId",
	"childTokenBudget",
	"parentEntries",
	"recentN",
	"taskPackageRef",
	"sourceContextDigest",
	"persistedTaskPackage",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FORBIDDEN_DURABLE = ["transcript", "credential", "secret", "password", "authorization", "apikey", "token", "messages", "prompt", "env", "headers"];
const CONTROL_ENTRY_TYPES = new Set(["thinking_level_change", "model_change", "active_tools_change"]);
const PersistedTaskPackageProofV1Schema = Type.Object(
	{
		ref: Type.String({ minLength: 1 }),
		digest: FingerprintSchema,
		projection: TaskEnvelopePublicProjectionSchema,
	},
	{ additionalProperties: false },
);
const ChildContextForkPlanV1Schema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		spawnId: Type.String({ minLength: 1 }),
		forkScope: Type.Union([Type.Literal("none"), Type.Literal("all"), Type.Literal("recent_n"), Type.Literal("task_package")]),
		recentN: Type.Optional(Type.Integer({ minimum: 1 })),
		taskPackageRef: Type.Optional(Type.String({ minLength: 1 })),
		sourceContextDigest: Type.Optional(FingerprintSchema),
		childSnapshotRef: RevisionReferenceSchema,
		tokenBudget: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

function forkError(message: string): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError("subagent_context_fork_invalid", message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isLiveSnapshot(value: ContextSnapshot | ContextSnapshotRecord): value is ContextSnapshot {
	return typeof (value as ContextSnapshot).toJSON === "function" && typeof (value as ContextSnapshot).entries === "function";
}

function digestFingerprint(digest: string): Fingerprint {
	const value = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
	return { algorithm: "sha256", value };
}

function fingerprintMatchesDigest(fingerprint: Fingerprint, digest: string): boolean {
	if (fingerprint.algorithm !== "sha256") return false;
	return digest === fingerprint.value || digest === `sha256:${fingerprint.value}` || fingerprint.value === digest.replace(/^sha256:/, "");
}

function toContextForkMode(scope: ChildContextForkScope): ContextForkMode {
	if (scope === "recent_n") return "recent-N";
	if (scope === "task_package") return "task-package";
	return scope;
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function isConversationalEntry(entry: Entry): entry is MessageEntry {
	if (entry.type !== "message") return false;
	const role = entry.message.role;
	return role === "user" || role === "assistant" || role === "toolResult";
}

function isControlEntry(entry: Entry): boolean {
	return CONTROL_ENTRY_TYPES.has(entry.type);
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function runtimeLayerTokenParts(layer: ChildRuntimeLayer): { readonly instruction: number; readonly task: number; readonly total: number } {
	const instruction = estimateTextTokens(
		canonicalFoundationJson({
			schemaVersion: layer.schemaVersion,
			kind: layer.kind,
			persona: layer.persona,
			customInstructions: layer.customInstructions,
		}),
	);
	const task = estimateTextTokens(
		canonicalFoundationJson({
			goal: layer.goal,
			acceptanceCriteria: layer.acceptanceCriteria,
			inputs: layer.inputs,
			expectedOutputs: layer.expectedOutputs,
		}),
	);
	return { instruction, task, total: instruction + task };
}

function inheritedSystemInstructionTokens(snapshot: ContextSnapshot, scope: ChildContextForkScope): number {
	if (scope !== "all" && scope !== "recent_n") return 0;
	return cloneParentSources(snapshot, scope)
		.filter((source) => source.kind === "system" || source.kind === "instruction")
		.reduce((sum, source) => sum + source.estimatedTokens, 0);
}

function sanitizeEntry(entry: Entry): Entry {
	const clone = cloneValue(entry);
	if (clone.type !== "message") return clone;
	if (clone.message.role !== "toolResult") return clone;
	return {
		...clone,
		message: {
			role: "toolResult",
			toolCallId: clone.message.toolCallId,
			toolName: clone.message.toolName,
			content: [],
			isError: clone.message.isError,
			timestamp: clone.message.timestamp,
		},
	};
}

function lastConversationalTurns(entries: readonly Entry[], recentN: number): MessageEntry[] {
	const turns: MessageEntry[][] = [];
	for (const entry of entries) {
		if (!isConversationalEntry(entry)) continue;
		if (entry.message.role === "user" || turns.length === 0) {
			turns.push([entry]);
		} else {
			turns[turns.length - 1]!.push(entry);
		}
	}
	return turns.slice(-recentN).flat();
}

function relinkChain(entries: readonly Entry[]): Entry[] {
	const kept = entries.map((entry) => sanitizeEntry(entry));
	return kept.map((entry, index) => ({
		...entry,
		seq: index + 1,
		timestamp: entry.timestamp,
		parentId: index === 0 ? null : kept[index - 1]!.id,
	}));
}

function instructionSource(role: RoleRevision, estimatedTokens: number): ContextSnapshotSource {
	return {
		sourceId: "child-role-instructions",
		kind: "instruction",
		trust: "builtin",
		digest: `sha256:${fingerprintFoundationValue({ persona: role.persona, customInstructions: role.customInstructions ?? "" }).value}`,
		estimatedTokens,
		disposition: "included",
	};
}

function taskSource(projection: TaskEnvelopePublicProjection, estimatedTokens: number): ContextSnapshotSource {
	return {
		sourceId: "child-task-envelope",
		kind: "task",
		trust: "user_owned",
		digest: `sha256:${projection.goalDigest.value}`,
		estimatedTokens,
		disposition: "included",
		refId: projection.taskId,
	};
}

function cloneParentSources(snapshot: ContextSnapshot, scope: ChildContextForkScope): ContextSnapshotSource[] {
	const sources = snapshot.sources().map((source) => cloneValue(source));
	if (scope === "all") return sources;
	if (scope === "recent_n") return sources.filter((source) => source.kind === "system" || source.kind === "instruction");
	return [];
}

function boundTaskPackageLayer(layer: ChildRuntimeLayer): ResultValue<ChildRuntimeLayer, FoundationError> {
	if (layer.goal.length > TASK_PACKAGE_GOAL_MAX_CHARS) {
		return forkError("task_package goal exceeds the deterministic bound");
	}
	if (layer.acceptanceCriteria.length > TASK_PACKAGE_MAX_CRITERIA) {
		return forkError("task_package criteria exceed the deterministic bound");
	}
	if (layer.acceptanceCriteria.some((criterion) => criterion.description.length > TASK_PACKAGE_CRITERION_MAX_CHARS)) {
		return forkError("task_package criterion description exceeds the deterministic bound");
	}
	if (layer.inputs.length > TASK_PACKAGE_MAX_ARTIFACTS || layer.expectedOutputs.length > TASK_PACKAGE_MAX_ARTIFACTS) {
		return forkError("task_package artifact refs exceed the deterministic bound");
	}
	return Result.ok(layer);
}

function buildRuntimeLayer(role: RoleRevision, task: TaskEnvelope, projection: TaskEnvelopePublicProjection): ChildRuntimeLayer {
	return cloneDeepFrozen({
		schemaVersion: 1 as const,
		kind: "system_task" as const,
		persona: role.persona,
		customInstructions: role.customInstructions ?? "",
		goal: task.goal,
		acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({
			criterionId: criterion.criterionId,
			description: criterion.description,
			required: criterion.required,
			satisfiedBy: criterion.satisfiedBy ?? "evidence",
		})),
		inputs: projection.inputs,
		expectedOutputs: projection.expectedOutputs,
	});
}

function durableLeaksSecrets(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => durableLeaksSecrets(item, seen));
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_DURABLE.includes(key.toLowerCase())) return true;
		if (durableLeaksSecrets(child, seen)) return true;
	}
	return false;
}

function chainIsValid(entries: readonly Entry[]): boolean {
	const ids = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		if (ids.has(entry.id) || !isSafeIdentifier(entry.id) || entry.seq !== index + 1) return false;
		ids.add(entry.id);
		if (index === 0) {
			if (entry.parentId !== null) return false;
		} else if (entry.parentId !== entries[index - 1]!.id) {
			return false;
		}
	}
	return true;
}

function resolveParentSnapshot(input: ForkChildContextInput): ResultValue<ContextSnapshot, FoundationError> {
	if (isLiveSnapshot(input.parentSnapshot)) {
		const record = input.parentSnapshot.toJSON();
		try {
			return Result.ok(contextSnapshotFromJSON(record, cloneValue([...input.parentSnapshot.entries()])));
		} catch {
			return forkError("Parent ContextSnapshot digest is invalid");
		}
	}
	const entries = input.parentEntries;
	if (entries === undefined) return forkError("Parent ContextSnapshot recovery requires entries");
	try {
		return Result.ok(contextSnapshotFromJSON(input.parentSnapshot, cloneValue([...entries])));
	} catch {
		return forkError("Parent ContextSnapshot digest is invalid");
	}
}

function resolveTaskPackage(
	input: ForkChildContextInput,
	task: TaskEnvelope,
	currentProjection: TaskEnvelopePublicProjection,
): ResultValue<PersistedTaskPackageProof, FoundationError> {
	if (input.taskPackageRef === undefined || input.taskPackageRef.length === 0) {
		return forkError("task_package fork requires taskPackageRef");
	}
	if (input.persistedTaskPackage !== undefined) {
		const proof = validateExactShape<PersistedTaskPackageProof>(
			PersistedTaskPackageProofV1Schema,
			input.persistedTaskPackage,
			"task_package_proof",
		);
		if (!proof.ok) return forkError("Persisted task package proof is not an exact shape");
		const projection = validateTaskEnvelopePublicProjection(proof.value.projection);
		if (!projection.ok) return forkError("Persisted task package projection is invalid");
		if (proof.value.ref !== input.taskPackageRef) {
			return forkError("taskPackageRef does not match the persisted task package");
		}
		if (projection.value.taskId !== task.taskId) {
			return forkError("Persisted task package is bound to a foreign task");
		}
		if (canonicalFoundationJson(projection.value) !== canonicalFoundationJson(currentProjection)) {
			return forkError("Persisted task package does not match the current child Task projection");
		}
		const expected = fingerprintFoundationValue(projection.value);
		if (!fingerprintMatchesDigest(proof.value.digest, `sha256:${expected.value}`) && proof.value.digest.value !== expected.value) {
			return forkError("Persisted task package digest does not match its projection");
		}
		return Result.ok(proof.value);
	}
	if (input.taskPackageRef === task.taskId && task.fingerprint !== undefined) {
		return Result.ok({
			ref: input.taskPackageRef,
			digest: task.fingerprint,
			projection: currentProjection,
		});
	}
	return forkError("taskPackageRef does not point at a persisted Artifact or Task projection");
}

function buildPlan(
	input: ForkChildContextInput,
	snapshot: ContextSnapshot,
	sourceContextDigest: Fingerprint | undefined,
): ChildContextForkPlan {
	return cloneDeepFrozen({
		schemaVersion: CHILD_CONTEXT_FORK_SCHEMA_VERSION,
		spawnId: input.spawnId,
		forkScope: input.forkScope,
		...(input.forkScope === "recent_n" ? { recentN: input.recentN } : {}),
		...(input.forkScope === "task_package" ? { taskPackageRef: input.taskPackageRef } : {}),
		...(sourceContextDigest === undefined ? {} : { sourceContextDigest }),
		childSnapshotRef: {
			schemaVersion: 1 as const,
			type: "context_snapshot",
			id: snapshot.snapshotId,
			revision: snapshot.revision,
			fingerprint: digestFingerprint(snapshot.digest),
		},
		tokenBudget: input.childTokenBudget,
	});
}

function validateInputShape(value: unknown): value is ForkChildContextInput {
	if (!isRecord(value) || Object.keys(value).some((key) => !INPUT_KEYS.has(key))) return false;
	if (value.schemaVersion !== CHILD_CONTEXT_FORK_SCHEMA_VERSION) return false;
	if (!isSafeIdentifier(value.spawnId) || !isSafeIdentifier(value.childBindingEpochId)) return false;
	if (!CHILD_CONTEXT_FORK_SCOPES.includes(value.forkScope as ChildContextForkScope)) return false;
	if (typeof value.childTokenBudget !== "number" || !Number.isFinite(value.childTokenBudget) || value.childTokenBudget < 0) {
		return false;
	}
	if (value.sourceContextDigest !== undefined) {
		const digest = validateExactShape<Fingerprint>(FingerprintSchema, value.sourceContextDigest, "fingerprint");
		if (!digest.ok) return false;
	}
	return true;
}

function parentConversationEntries(parent: ContextSnapshot, scope: ChildContextForkScope, recentN: number | undefined): ResultValue<Entry[], FoundationError> {
	const entries = parent.entries();
	if (scope === "none" || scope === "task_package") return Result.ok([]);
	if (scope === "all") {
		const cloned = entries.map((entry) => cloneValue(entry));
		if (cloned.some((entry) => durableLeaksSecrets(entry))) {
			return forkError("all fork refuses unsafe credential or tool-secret material");
		}
		return Result.ok(cloned);
	}
	if (recentN === undefined || !Number.isInteger(recentN) || recentN < 1) {
		return forkError("recent_n fork requires recentN >= 1");
	}
	const keep = new Set<string>([
		...entries.filter((entry) => isControlEntry(entry)).map((entry) => entry.id),
		...lastConversationalTurns(entries, recentN).map((entry) => entry.id),
	]);
	const filtered = entries.filter((entry) => keep.has(entry.id));
	const relinked = relinkChain(filtered);
	if (!chainIsValid(relinked)) return forkError("recent_n fork produced an invalid entry chain");
	return Result.ok(relinked);
}

function forkChildContextUnchecked(input: ForkChildContextInput): ResultValue<ChildContextForkResult, FoundationError> {
	const role = validateRoleRevision(input.childRoleRevision);
	if (!role.ok) return forkError("Child RoleRevision is invalid");
	const task = validateTaskEnvelope(input.childTaskEnvelope);
	if (!task.ok) return forkError("Child TaskEnvelope is invalid");
	const parent = resolveParentSnapshot(input);
	if (!parent.ok) return parent;
	const parentRecord = parent.value.toJSON();
	const parentDigest = digestFingerprint(parentRecord.digest);
	if (input.sourceContextDigest !== undefined) {
		const digest = validateExactShape<Fingerprint>(FingerprintSchema, input.sourceContextDigest, "fingerprint");
		if (!digest.ok) return forkError("sourceContextDigest is not an exact FingerprintV1");
		if (!fingerprintMatchesDigest(digest.value, parentRecord.digest)) {
			return forkError("Parent Context digest does not match sourceContextDigest");
		}
	}
	if (input.forkScope === "recent_n") {
		if (input.recentN === undefined || !Number.isInteger(input.recentN) || input.recentN < 1) {
			return forkError("recent_n fork requires recentN >= 1");
		}
	}
	if (input.forkScope === "task_package" && (input.taskPackageRef === undefined || input.taskPackageRef.length === 0)) {
		return forkError("task_package fork requires taskPackageRef");
	}

	const taskProjection = projectTaskEnvelope(task.value);
	let runtimeProjection = buildRuntimeLayer(role.value, task.value, taskProjection);
	if (input.forkScope === "task_package") {
		const bounded = boundTaskPackageLayer(runtimeProjection);
		if (!bounded.ok) return bounded;
		runtimeProjection = bounded.value;
	}
	const conversation = parentConversationEntries(parent.value, input.forkScope, input.recentN);
	if (!conversation.ok) return conversation;
	if (input.forkScope === "all") {
		try {
			if (canonicalFoundationJson(conversation.value) !== canonicalFoundationJson(parent.value.entries())) {
				return forkError("all fork must canonical-clone parent entries");
			}
		} catch {
			return forkError("all fork must canonical-clone parent entries");
		}
	}
	const tokenParts = runtimeLayerTokenParts(runtimeProjection);
	const sources: ContextSnapshotSource[] = [
		...cloneParentSources(parent.value, input.forkScope),
		instructionSource(role.value, tokenParts.instruction),
		taskSource(taskProjection, tokenParts.task),
	];
	let taskPackage: TaskContextPackage;
	if (input.forkScope === "task_package") {
		const pack = resolveTaskPackage(input, task.value, taskProjection);
		if (!pack.ok) return pack;
		taskPackage = {
			schemaVersion: 1,
			packageId: pack.value.ref,
			taskId: pack.value.projection.taskId,
			goalDigest: `sha256:${pack.value.projection.goalDigest.value}`,
			artifactRefs: [
				...pack.value.projection.inputs.map((item) => item.artifactId),
				...pack.value.projection.expectedOutputs.map((item) => item.artifactId),
			],
			packageDigest: `sha256:${pack.value.digest.value}`,
		};
	} else {
		taskPackage = {
			schemaVersion: 1,
			taskId: task.value.taskId,
			goalDigest: `sha256:${taskProjection.goalDigest.value}`,
			artifactRefs: [
				...taskProjection.inputs.map((item) => item.artifactId),
				...taskProjection.expectedOutputs.map((item) => item.artifactId),
			],
			packageDigest: `sha256:${fingerprintFoundationValue(taskProjection).value}`,
		};
	}

	const summary = canonicalFoundationJson(runtimeProjection);
	const snapshot = createContextSnapshot(conversation.value, {
		parentSnapshotId: parentRecord.snapshotId,
		parentId: parentRecord.id,
		bindingEpochId: input.childBindingEpochId,
		forkMode: toContextForkMode(input.forkScope),
		source: sources[0],
		sources,
		trust: input.forkScope === "all" ? parent.value.trust : input.forkScope === "none" ? "builtin" : "user_owned",
		budget: { maxTokens: input.childTokenBudget },
		summary,
		summaryDigest: `sha256:${fingerprintFoundationValue(runtimeProjection).value}`,
		taskPackage,
	});
	const usedTokens = snapshot.budget.usedTokens + tokenParts.total + inheritedSystemInstructionTokens(parent.value, input.forkScope);
	if (usedTokens > input.childTokenBudget) {
		return forkError("Child Context fork exceeds the child token budget");
	}
	if (snapshot.entries() === parent.value.entries() || snapshot.entries().some((entry) => parent.value.entries().includes(entry))) {
		return forkError("Child ContextSnapshot must not share parent entries");
	}
	if (input.forkScope === "all") {
		try {
			if (canonicalFoundationJson(snapshot.entries()) !== canonicalFoundationJson(parent.value.entries())) {
				return forkError("all fork snapshot entries must canonical-equal the parent");
			}
		} catch {
			return forkError("all fork snapshot entries must canonical-equal the parent");
		}
	}
	const record = snapshot.toJSON();
	if (record.digest !== snapshot.digest) {
		return forkError("Child ContextSnapshot digest is inconsistent");
	}
	if ("summary" in record || durableLeaksSecrets(record)) {
		return forkError("Durable ContextSnapshot must not carry transcript or secrets");
	}
	if (record.summaryDigest === undefined) {
		return forkError("Durable ContextSnapshot requires a summary digest");
	}
	const sourceContextDigest = input.forkScope === "all" || input.forkScope === "recent_n" ? parentDigest : undefined;
	return Result.ok({
		plan: buildPlan(input, snapshot, input.sourceContextDigest ?? sourceContextDigest),
		snapshot,
		record,
		runtimeProjection,
	});
}

/**
 * Project parent Context through one of the four sealed forkScope modes.
 * The returned snapshot is a new immutable object; parent entries are cloned.
 */
export function forkChildContext(inputValue: unknown): ResultValue<ChildContextForkResult, FoundationError> {
	try {
		if (!validateInputShape(inputValue)) {
			return forkError("Child Context fork input is invalid");
		}
		return forkChildContextUnchecked(inputValue);
	} catch {
		return forkError("Child Context fork input is invalid");
	}
}

export function validateChildContextForkPlan(value: unknown): value is ChildContextForkPlan {
	try {
		const checked = validateExactShape<ChildContextForkPlan>(ChildContextForkPlanV1Schema, value, "child_context_fork_plan");
		if (!checked.ok || !isSafeIdentifier(checked.value.spawnId) || !Number.isFinite(checked.value.tokenBudget)) return false;
		if (checked.value.forkScope === "recent_n") {
			if (checked.value.recentN === undefined || !Number.isInteger(checked.value.recentN) || checked.value.recentN < 1) return false;
		} else if (checked.value.recentN !== undefined) {
			return false;
		}
		if (checked.value.forkScope === "task_package") {
			if (typeof checked.value.taskPackageRef !== "string" || checked.value.taskPackageRef.length === 0) return false;
		} else if (checked.value.taskPackageRef !== undefined) {
			return false;
		}
		if (checked.value.childSnapshotRef.type !== "context_snapshot") return false;
		return true;
	} catch {
		return false;
	}
}
