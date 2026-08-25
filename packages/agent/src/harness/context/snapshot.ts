import { uuidv7 } from "@aos-agent/ai";
import type { AgentMessage } from "../../types.ts";
import { canonicalFoundationJson, sha256HexValue } from "../foundation/index.ts";
import { estimateTokens } from "../compaction/compaction.ts";
import { buildSessionContext, type SessionContextBuildOptions } from "../session/context.ts";
import type { Entry } from "../session/types.ts";
import { redactArtifactReference, type ArtifactReference } from "../artifacts.ts";

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type ContextSourceKind =
	| "system"
	| "instruction"
	| "capability"
	| "session"
	| "memory"
	| "extension"
	| "attachment"
	| "task";
export type ContextTrust =
	| "builtin"
	| "user_owned"
	| "trusted_project"
	| "untrusted_project"
	| "user"
	| "tool"
	| "model"
	| "external"
	| "untrusted";
export type ContextForkMode = "none" | "all" | "recent-N" | "task-package";

export interface ContextSnapshotSource {
	readonly sourceId: string;
	readonly kind: ContextSourceKind;
	readonly scope?: string;
	readonly trust: ContextTrust;
	readonly digest: string;
	readonly estimatedTokens: number;
	readonly disposition: "included" | "excluded" | "trimmed";
	/** A reference only. Source bodies are never put in this contract. */
	readonly refId?: string;
}

export interface ContextSnapshotBudget {
	readonly maxTokens: number;
	readonly usedTokens: number;
	readonly reservedTokens: number;
}

export type ContextResourceKind =
	| "instructions"
	| "skills"
	| "mcp"
	| "model"
	| "sandbox"
	| "git"
	| "memory"
	| "artifacts";
export const CONTEXT_RESOURCE_KINDS: readonly ContextResourceKind[] = [
	"instructions",
	"skills",
	"mcp",
	"model",
	"sandbox",
	"git",
	"memory",
	"artifacts",
];

export interface ContextResourceSelector {
	readonly policy: "all" | "none" | "named" | "except";
	readonly named?: readonly string[];
}

export interface ContextInheritanceDecision {
	readonly resource: ContextResourceKind;
	readonly decision: "inherit" | "narrow" | "deny";
	readonly source: "parent" | "child" | "managed";
	readonly parent: ContextResourceSelector;
	readonly child: ContextResourceSelector;
	readonly managedLock: boolean;
	readonly reason: string;
}

export type ContextInheritanceMatrix = Readonly<Record<ContextResourceKind, ContextInheritanceDecision>>;

export interface ContextInheritanceOptions {
	readonly parent?: Partial<Record<ContextResourceKind, ContextResourceSelector>>;
	readonly child?: Partial<Record<ContextResourceKind, ContextResourceSelector>>;
	readonly managedLocks?: readonly ContextResourceKind[];
}

/** Metadata-only build fact; the actual context is reconstructed from Session entries. */
export interface ContextBuildFact {
	readonly schemaVersion: 1;
	readonly buildId: string;
	readonly bindingEpochId: string;
	readonly taskId?: string;
	readonly lane?: string;
	readonly entryIds: readonly string[];
	readonly sourceIds: readonly string[];
	readonly contextDigest: string;
	readonly createdAt: number;
}

/** Persistable task package metadata. Package bodies remain Session/artifact refs. */
export interface TaskContextPackage {
	readonly schemaVersion: 1;
	readonly packageId?: string;
	readonly taskId: string;
	readonly bindingEpochId?: string;
	/** Runtime-only goal input. Persisted packages carry only goalDigest. */
	readonly goal?: string;
	readonly entryIds?: readonly string[];
	/** Runtime-only input accepted by task-package forks; never emitted to ledger. */
	readonly entries?: readonly Entry[];
	readonly artifactRefs?: readonly string[];
	readonly budget?: Partial<ContextSnapshotBudget>;
	readonly packageDigest?: string;
	readonly createdAt?: number;
	readonly goalDigest?: string;
}
export type PersistedTaskContextPackage = Omit<TaskContextPackage, "entries" | "goal"> & { readonly goalDigest?: string };

export interface ContextSnapshotState {
	readonly thinkingLevel: string;
	readonly model: { readonly provider: string; readonly modelId: string } | null;
	readonly activeToolNames: readonly string[] | null;
}

export interface ContextRecoveryBoundary {
	readonly transcriptDigest: string;
	readonly workspaceDigest?: string;
	readonly entryId: string | null;
	readonly failClosed: true;
}

/** Metadata-only durable representation. It intentionally has no message body. */
export interface ContextSnapshotRecord {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly snapshotId: string;
	readonly revision: number;
	readonly parentId: string | null;
	readonly parentSnapshotId: string | null;
	readonly checkpointId: string | null;
	readonly createdAt: number;
	readonly bindingEpochId: string;
	readonly buildFact?: ContextBuildFact;
	readonly taskPackage?: PersistedTaskContextPackage;
	readonly source: ContextSnapshotSource;
	readonly sources: readonly ContextSnapshotSource[];
	readonly trust: ContextTrust;
	readonly budget: ContextSnapshotBudget;
	readonly digest: string;
	/** Summary body is an artifact; only its redacted reference is durable. */
	readonly summaryRef?: ArtifactReference;
	readonly summaryDigest?: string;
	readonly forkMode: ContextForkMode;
	readonly inheritance: ContextInheritanceMatrix;
	readonly recoveryBoundary?: ContextRecoveryBoundary;
	readonly headEntryId: string | null;
	readonly entryIds: readonly string[];
}

export interface ContextSnapshotForkOptions {
	readonly id?: string;
	readonly snapshotId?: string;
	readonly checkpointId?: string;
	readonly createdAt?: number;
	readonly mode?: ContextForkMode;
	readonly recentN?: number;
	readonly taskPackage?: TaskContextPackage;
	readonly inheritance?: ContextInheritanceOptions;
	readonly summary?: string;
	readonly summaryRef?: ArtifactReference;
	readonly summaryDigest?: string;
	readonly bindingEpochId?: string;
	readonly buildFact?: ContextBuildFact;
	readonly source?: Partial<ContextSnapshotSource> | string;
	readonly budget?: Partial<ContextSnapshotBudget> | number;
}
export type ContextForkOptions = ContextSnapshotForkOptions;

export interface ContextSnapshotOptions {
	readonly id?: string;
	readonly snapshotId?: string;
	readonly parentId?: string | null;
	readonly parentSnapshotId?: string | null;
	readonly checkpointId?: string | null;
	readonly createdAt?: number;
	readonly revision?: number;
	readonly bindingEpochId?: string;
	readonly buildFact?: ContextBuildFact;
	readonly taskPackage?: TaskContextPackage;
	readonly source?: Partial<ContextSnapshotSource> | string;
	readonly sources?: readonly ContextSnapshotSource[];
	readonly trust?: ContextTrust;
	readonly budget?: Partial<ContextSnapshotBudget> | number;
	readonly summary?: string;
	readonly summaryRef?: ArtifactReference;
	readonly summaryDigest?: string;
	readonly forkMode?: ContextForkMode;
	readonly inheritance?: ContextInheritanceOptions;
	readonly recoveryBoundary?: ContextRecoveryBoundary;
	readonly build?: SessionContextBuildOptions;
}

export interface ContextSnapshot {
	readonly id: string;
	readonly snapshotId: string;
	readonly revision: number;
	readonly parentId: string | null;
	readonly parentSnapshotId: string | null;
	readonly checkpointId: string | null;
	readonly createdAt: number;
	readonly bindingEpochId: string;
	readonly buildFact?: ContextBuildFact;
	readonly taskPackage?: PersistedTaskContextPackage;
	readonly source: ContextSnapshotSource;
	readonly headEntryId: string | null;
	sources(): readonly ContextSnapshotSource[];
	readonly trust: ContextTrust;
	readonly budget: ContextSnapshotBudget;
	readonly digest: string;
	readonly summaryRef?: ArtifactReference;
	readonly forkMode: ContextForkMode;
	readonly inheritance: ContextInheritanceMatrix;
	readonly recoveryBoundary?: ContextRecoveryBoundary;
	entries(): readonly Entry[];
	messages(): readonly AgentMessage[];
	state(): ContextSnapshotState;
	/** Returns the transient summary body; it is never emitted by toJSON(). */
	summary(): string | undefined;
	toJSON(): ContextSnapshotRecord;
	fork(options?: ContextSnapshotForkOptions): ContextSnapshot;
	rewindTo(entryId: string): ContextSnapshot | undefined;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value === null || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item, seen);
	} else {
		for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key], seen);
	}
	return Object.freeze(value);
}

function digest(value: unknown): string {
	return `sha256:${sha256HexValue(canonicalFoundationJson(value))}`;
}

function normalizeDigest(value: string): string {
	return /^sha256:[0-9a-f]{64}$/.test(value) ? value : digest(value);
}

function persistedTaskPackage(value: TaskContextPackage | PersistedTaskContextPackage): PersistedTaskContextPackage {
	const runtime = value as TaskContextPackage;
	const { goal: _goal, entries: _entries, ...metadata } = runtime;
	return {
		...metadata,
		...(runtime.goal === undefined && runtime.goalDigest === undefined
			? {}
			: { goalDigest: runtime.goalDigest ?? digest(runtime.goal) }),
	};
}

function selector(value: ContextResourceSelector | undefined): ContextResourceSelector {
	if (value === undefined) return { policy: "all" };
	if (value.policy === "all" || value.policy === "none") return { policy: value.policy };
	return { policy: value.policy, named: [...new Set(value.named ?? [])].sort() };
}

function equalSelector(left: ContextResourceSelector, right: ContextResourceSelector): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

/** Return true when child is equal to or narrower than parent. */
export function contextSelectorNarrower(parent: ContextResourceSelector, child: ContextResourceSelector): boolean {
	const parentNames = new Set(parent.named ?? []);
	const childNames = new Set(child.named ?? []);
	if (parent.policy === "none") return child.policy === "none";
	if (child.policy === "none") return true;
	if (parent.policy === "all") return true;
	if (child.policy === "all") return false;
	if (parent.policy === "named") {
		// A named parent can only be narrowed by another named subset. An
		// except selector describes an open universe and is therefore a widen.
		return child.policy === "named" && [...childNames].every((name) => parentNames.has(name));
	}
	if (child.policy === "named") {
		// Parent except X permits every name outside X. A named child is safe
		// only when it contains no excluded name.
		return [...childNames].every((name) => !parentNames.has(name));
	}
	// except X -> except Y is narrower exactly when Y excludes every name
	// already excluded by X. The previous implementation accidentally treated
	// an except selector as named in some mixed-policy cases.
	return [...parentNames].every((name) => childNames.has(name));
}

/** Resolve inheritance fail-closed: a child cannot widen a parent selector. */
export function resolveContextInheritance(options: ContextInheritanceOptions = {}): ContextInheritanceMatrix {
	const locks = new Set(options.managedLocks ?? []);
	const matrix = {} as Record<ContextResourceKind, ContextInheritanceDecision>;
	for (const resource of CONTEXT_RESOURCE_KINDS) {
		const parent = selector(options.parent?.[resource]);
		const requested = selector(options.child?.[resource]);
		const managedLock = locks.has(resource);
		const narrowed = contextSelectorNarrower(parent, requested);
		const child = managedLock || !narrowed ? parent : requested;
		const unchanged = equalSelector(parent, child);
		matrix[resource] = {
			resource,
			decision: unchanged ? "inherit" : child.policy === "none" ? "deny" : "narrow",
			source: managedLock || unchanged ? (managedLock ? "managed" : "parent") : "child",
			parent,
			child,
			managedLock,
			reason: managedLock
				? "Managed lock preserves the parent selector"
				: !narrowed
					? "Requested selector would widen the parent and was reduced"
					: unchanged
						? "Child inherits the parent selector"
						: child.policy === "none"
							? "Child explicitly denies inherited resource"
							: "Child selector is a permitted narrowing",
		};
	}
	return deepFreeze(matrix);
}
export const decideContextInheritance = resolveContextInheritance;

function snapshotSource(options: ContextSnapshotOptions, messages: readonly AgentMessage[]): ContextSnapshotSource {
	const value = typeof options.source === "string" ? { sourceId: options.source } : options.source ?? {};
	const sourceId = value.sourceId ?? "session";
	const kind = value.kind ?? "session";
	const trust = value.trust ?? options.trust ?? "user_owned";
	return {
		sourceId,
		kind,
		trust,
		digest: value.digest === undefined ? digest({ sourceId, kind, trust, messages }) : normalizeDigest(value.digest),
		estimatedTokens: value.estimatedTokens ?? messages.reduce((sum, message) => sum + estimateTokens(message), 0),
		disposition: value.disposition ?? "included",
		...(value.scope === undefined ? {} : { scope: value.scope }),
		...(value.refId === undefined ? {} : { refId: value.refId }),
	};
}

function budgetValue(value: ContextSnapshotOptions["budget"], usedTokens: number): ContextSnapshotBudget {
	const budget = typeof value === "number" ? { maxTokens: value } : value;
	const maxTokens = budget?.maxTokens ?? Number.MAX_SAFE_INTEGER;
	const reservedTokens = budget?.reservedTokens ?? 0;
	if (!Number.isFinite(maxTokens) || maxTokens < 0 || !Number.isFinite(reservedTokens) || reservedTokens < 0) {
		throw new RangeError("Context snapshot budget must be finite and non-negative");
	}
	return { maxTokens, usedTokens: budget?.usedTokens ?? usedTokens, reservedTokens };
}

function forkEntries(entries: readonly Entry[], mode: ContextForkMode, recentN: number | undefined, taskPackage: TaskContextPackage | undefined): Entry[] {
	if (mode === "none") return [];
	if (mode === "all") return entries.map(clone);
	if (mode === "recent-N") {
		if (recentN === undefined || !Number.isInteger(recentN) || recentN < 0) throw new RangeError("recent-N requires a non-negative recentN");
		return entries.slice(Math.max(0, entries.length - recentN)).map(clone);
	}
	return (taskPackage?.entries ?? []).map(clone);
}

export class ImmutableContextSnapshot implements ContextSnapshot {
	readonly id: string;
	readonly snapshotId: string;
	readonly revision: number;
	readonly parentId: string | null;
	readonly parentSnapshotId: string | null;
	readonly checkpointId: string | null;
	readonly createdAt: number;
	readonly bindingEpochId: string;
	readonly buildFact?: ContextBuildFact;
	readonly taskPackage?: PersistedTaskContextPackage;
	readonly source: ContextSnapshotSource;
	readonly trust: ContextTrust;
	readonly budget: ContextSnapshotBudget;
	readonly digest: string;
	readonly summaryRef?: ArtifactReference;
	readonly forkMode: ContextForkMode;
	readonly inheritance: ContextInheritanceMatrix;
	readonly recoveryBoundary?: ContextRecoveryBoundary;
	private readonly pathEntries: readonly Entry[];
	private readonly contextMessages: readonly AgentMessage[];
	private readonly sourceList: readonly ContextSnapshotSource[];
	private readonly contextState: ContextSnapshotState;
	private readonly summaryTextValue?: string;
	private readonly summaryDigestValue?: string;

	constructor(pathEntries: readonly Entry[], options: ContextSnapshotOptions = {}) {
		this.id = options.id ?? options.snapshotId ?? uuidv7();
		this.snapshotId = options.snapshotId ?? this.id;
		this.revision = options.revision ?? 0;
		this.parentId = options.parentId ?? options.parentSnapshotId ?? null;
		this.parentSnapshotId = options.parentSnapshotId ?? options.parentId ?? null;
		this.checkpointId = options.checkpointId ?? null;
		this.createdAt = options.createdAt ?? Date.now();
		if (options.bindingEpochId === undefined || options.bindingEpochId.length === 0) {
			throw new RangeError("Context snapshot bindingEpochId is required");
		}
		this.bindingEpochId = options.bindingEpochId;
		this.buildFact = options.buildFact === undefined ? undefined : deepFreeze(clone(options.buildFact));
		this.taskPackage = options.taskPackage === undefined ? undefined : deepFreeze(persistedTaskPackage(options.taskPackage));
		this.pathEntries = deepFreeze(pathEntries.map(clone));
		const context = buildSessionContext(this.pathEntries, options.build);
		this.contextMessages = deepFreeze(context.messages.map(clone));
		this.contextState = deepFreeze({
			thinkingLevel: context.thinkingLevel,
			model: context.model === null ? null : { ...context.model },
			activeToolNames: context.activeToolNames === null ? null : [...context.activeToolNames],
		});
		this.trust = options.trust ?? (typeof options.source === "object" ? options.source.trust : undefined) ?? "user_owned";
		this.source = deepFreeze(snapshotSource(options, this.contextMessages));
		this.sourceList = deepFreeze((options.sources ?? [this.source]).map((item) => clone(item)));
		this.budget = deepFreeze(budgetValue(options.budget, this.contextMessages.reduce((sum, message) => sum + estimateTokens(message), 0)));
		this.forkMode = options.forkMode ?? "all";
		this.inheritance = resolveContextInheritance(options.inheritance);
		this.recoveryBoundary = options.recoveryBoundary === undefined ? undefined : deepFreeze(clone(options.recoveryBoundary));
		this.summaryTextValue = options.summary;
		this.summaryDigestValue =
			options.summaryDigest ??
			(options.summaryRef === undefined ? undefined : options.summaryRef.digest) ??
			(options.summary === undefined ? undefined : `sha256:${sha256HexValue(new TextEncoder().encode(options.summary))}`);
		this.summaryRef = options.summaryRef === undefined ? undefined : deepFreeze(redactArtifactReference(options.summaryRef));
		this.digest = digest({
			schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
			snapshotId: this.snapshotId,
			revision: this.revision,
			parentSnapshotId: this.parentSnapshotId,
			checkpointId: this.checkpointId,
			bindingEpochId: this.bindingEpochId,
			...(this.buildFact === undefined ? {} : { buildFact: this.buildFact }),
			...(this.taskPackage === undefined ? {} : { taskPackage: this.taskPackage }),
			source: this.source,
			sources: this.sourceList,
			trust: this.trust,
			budget: this.budget,
			forkMode: this.forkMode,
			inheritance: this.inheritance,
			...(this.summaryDigestValue === undefined ? {} : { summaryDigest: this.summaryDigestValue }),
			entryIds: this.pathEntries.map((entry) => entry.id),
			messages: this.contextMessages,
		});
	}

	get headEntryId(): string | null {
		return this.pathEntries.at(-1)?.id ?? null;
	}

	sources(): readonly ContextSnapshotSource[] {
		return this.sourceList;
	}
	entries(): readonly Entry[] {
		return this.pathEntries;
	}
	messages(): readonly AgentMessage[] {
		return this.contextMessages;
	}
	state(): ContextSnapshotState {
		return this.contextState;
	}

	summary(): string | undefined {
		return this.summaryTextValue;
	}
	toJSON(): ContextSnapshotRecord {
		return deepFreeze({
			schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
			id: this.id,
			snapshotId: this.snapshotId,
			revision: this.revision,
			parentId: this.parentId,
			parentSnapshotId: this.parentSnapshotId,
			checkpointId: this.checkpointId,
			createdAt: this.createdAt,
			bindingEpochId: this.bindingEpochId,
			...(this.buildFact === undefined ? {} : { buildFact: this.buildFact }),
			...(this.taskPackage === undefined ? {} : { taskPackage: this.taskPackage }),
			source: this.source,
			sources: this.sourceList,
			trust: this.trust,
			budget: this.budget,
			digest: this.digest,
			...(this.summaryRef === undefined ? {} : { summaryRef: this.summaryRef }),
			...(this.summaryDigestValue === undefined ? {} : { summaryDigest: this.summaryDigestValue }),
			forkMode: this.forkMode,
			inheritance: this.inheritance,
			...(this.recoveryBoundary === undefined ? {} : { recoveryBoundary: this.recoveryBoundary }),
			headEntryId: this.headEntryId,
			entryIds: this.pathEntries.map((entry) => entry.id),
		});
	}

	fork(options: ContextSnapshotForkOptions = {}): ContextSnapshot {
		const mode = options.mode ?? "all";
		const entries = forkEntries(this.pathEntries, mode, options.recentN, options.taskPackage);
		const source = typeof options.source === "string" ? { sourceId: options.source } : options.source;
		return new ImmutableContextSnapshot(entries, {
			id: options.id ?? options.snapshotId,
			snapshotId: options.snapshotId,
			parentId: this.id,
			parentSnapshotId: this.snapshotId,
			checkpointId: options.checkpointId,
			createdAt: options.createdAt,
			bindingEpochId: options.bindingEpochId ?? this.bindingEpochId,
			buildFact: options.buildFact,
			taskPackage: options.taskPackage === undefined ? undefined : { ...options.taskPackage },
			source: source ?? { sourceId: this.source.sourceId, kind: this.source.kind, trust: this.trust },
			trust: this.trust,
			budget: options.budget ?? this.budget,
			forkMode: mode,
			inheritance: options.inheritance ?? { parent: Object.fromEntries(CONTEXT_RESOURCE_KINDS.map((kind) => [kind, this.inheritance[kind]!.child])) },
			summary: options.summary,
			summaryRef: options.summaryRef,
			summaryDigest: options.summaryDigest,
		});
	}

	rewindTo(entryId: string): ContextSnapshot | undefined {
		const index = this.pathEntries.findIndex((entry) => entry.id === entryId);
		if (index < 0) return undefined;
		return new ImmutableContextSnapshot(this.pathEntries.slice(0, index + 1), {
			parentId: this.id,
			parentSnapshotId: this.snapshotId,
			checkpointId: this.checkpointId,
			bindingEpochId: this.bindingEpochId,
			buildFact: this.buildFact,
			taskPackage: this.taskPackage,
			source: this.source,
			trust: this.trust,
			budget: this.budget,
			forkMode: "all",
			inheritance: { parent: Object.fromEntries(CONTEXT_RESOURCE_KINDS.map((kind) => [kind, this.inheritance[kind]!.child])) },
			summaryRef: this.summaryRef,
			summaryDigest: this.summaryDigestValue,
		});
	}
}

export function createContextSnapshot(entries: readonly Entry[], options: ContextSnapshotOptions = {}): ContextSnapshot {
	return new ImmutableContextSnapshot(entries, options);
}

export function contextSnapshotFromJSON(record: ContextSnapshotRecord, entries: readonly Entry[]): ContextSnapshot {
	if (record.bindingEpochId.length === 0) throw new Error(`Context snapshot ${record.snapshotId} has no BindingEpoch`);
	if (record.buildFact !== undefined && record.buildFact.bindingEpochId !== record.bindingEpochId) throw new Error(`Context snapshot ${record.snapshotId} has a mismatched build BindingEpoch`);
	if (record.taskPackage?.bindingEpochId !== undefined && record.taskPackage.bindingEpochId !== record.bindingEpochId) throw new Error(`Context snapshot ${record.snapshotId} has a mismatched task package BindingEpoch`);
	if (record.summaryRef !== undefined && record.summaryDigest !== record.summaryRef.digest) throw new Error(`Context snapshot ${record.snapshotId} has a mismatched summary digest`);
	if (record.entryIds.length !== entries.length || record.entryIds.some((entryId, index) => entryId !== entries[index]?.id)) throw new Error(`Context snapshot ${record.snapshotId} entry ids failed recovery`);
	const snapshot = new ImmutableContextSnapshot(entries, {
		id: record.id,
		snapshotId: record.snapshotId,
		revision: record.revision,
		parentId: record.parentId,
		parentSnapshotId: record.parentSnapshotId,
		checkpointId: record.checkpointId,
		createdAt: record.createdAt,
		bindingEpochId: record.bindingEpochId,
		buildFact: record.buildFact,
		taskPackage: record.taskPackage,
		source: record.source,
		sources: record.sources,
		trust: record.trust,
		budget: record.budget,
		summaryRef: record.summaryRef,
		summaryDigest: record.summaryDigest,
		forkMode: record.forkMode,
		inheritance: { parent: Object.fromEntries(CONTEXT_RESOURCE_KINDS.map((kind) => [kind, record.inheritance[kind]!.parent])) },
		recoveryBoundary: record.recoveryBoundary,
	});
	if (snapshot.digest !== record.digest || snapshot.headEntryId !== record.headEntryId) throw new Error(`Context snapshot ${record.snapshotId} failed digest recovery`);
	return snapshot;
}
