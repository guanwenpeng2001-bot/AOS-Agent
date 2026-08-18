import { canonicalFoundationJson, sha256HexValue } from "../foundation/index.ts";
import type { ArtifactReference } from "../artifacts.ts";
import type { ContextTrust } from "./snapshot.ts";

export const INSTRUCTION_SCHEMA_VERSION = 1 as const;

export type InstructionScope = "managed" | "project" | "session" | "task" | "agent";

/** Instruction source metadata; source text is held by an artifact reference only. */
export interface InstructionSourceV1 {
	readonly schemaVersion: 1;
	readonly sourceId: string;
	readonly scope: InstructionScope;
	readonly trust: ContextTrust;
	readonly contentDigest: string;
	readonly contentRef?: ArtifactReference;
	readonly path?: string;
	readonly parentSourceId?: string;
	readonly inherited?: boolean;
	readonly enabled: boolean;
	readonly priority: number;
	readonly createdAt: number;
}

export interface InstructionLockV1 {
	readonly schemaVersion: 1;
	readonly sourceId: string;
	readonly locked: boolean;
	readonly managed: boolean;
	readonly reason: string;
	readonly sourceDigest: string;
	readonly path?: string;
	readonly lockedBy: string;
	readonly createdAt: number;
}

export interface InstructionSourceInput {
	readonly sourceId?: string;
	readonly scope: InstructionScope;
	readonly trust: ContextTrust;
	readonly content?: string;
	readonly contentDigest?: string;
	readonly contentRef?: ArtifactReference;
	readonly path?: string;
	readonly parentSourceId?: string;
	readonly inherited?: boolean;
	readonly enabled?: boolean;
	readonly priority?: number;
	readonly createdAt?: number;
}

export interface InstructionResolution {
	readonly sources: readonly InstructionSourceV1[];
	readonly locks: readonly InstructionLockV1[];
	readonly decisions: readonly InstructionResolutionDecision[];
	readonly path?: string;
	readonly resolutionId?: string;
	readonly digest: string;
}

/** One executable decision made while resolving an instruction source. */
export interface InstructionResolutionDecision {
	readonly sourceId: string;
	readonly parentSourceId?: string;
	readonly inherited: boolean;
	readonly selected: boolean;
	readonly decision: "include" | "exclude";
	readonly reason: string;
	readonly pathMatched: boolean;
	readonly parentSelected?: boolean;
	readonly locked: boolean;
	readonly managedLock: boolean;
	/** Lower values are earlier in the deterministic resolution order. */
	readonly precedence: number;
}

/** Durable record of one instruction resolution, including excluded sources. */
export interface InstructionResolutionRecordV1 {
	readonly schemaVersion: 1;
	readonly resolutionId: string;
	readonly path?: string;
	readonly sourceIds: readonly string[];
	readonly selectedSourceIds: readonly string[];
	readonly decisions: readonly InstructionResolutionDecision[];
	readonly locks: readonly InstructionLockV1[];
	readonly digest: string;
	readonly createdAt: number;
}

export interface InstructionResolutionOptions {
	readonly path?: string;
}

function pathContains(parent: string | undefined, child: string | undefined): boolean {
	if (parent === undefined || child === undefined) return true;
	const normalizedParent = normalizePath(parent);
	const normalizedChild = normalizePath(child);
	if (normalizedParent === undefined || normalizedChild === undefined) return true;
	if (normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)) return true;
	// Resource loaders commonly identify an instruction by the file path while
	// callers resolve it for a directory below that file.
	const lastSegment = normalizedParent.slice(normalizedParent.lastIndexOf("/") + 1);
	if (lastSegment.includes(".")) {
		const directory = normalizedParent.slice(0, normalizedParent.lastIndexOf("/")) || "/";
		return normalizedChild === directory || normalizedChild.startsWith(`${directory}/`);
	}
	return false;
}

function normalizePath(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
	return normalized.length === 0 ? "/" : normalized;
}

function pathSpecificity(value: string | undefined): number {
	const normalized = normalizePath(value);
	return normalized === undefined ? 0 : normalized.split("/").filter((part) => part.length > 0).length;
}

function lockForSource(sourceId: string, locks: readonly InstructionLockV1[]): InstructionLockV1 | undefined {
	return locks
		.filter((lock) => lock.sourceId === sourceId)
		.sort(
			(left, right) =>
				right.createdAt - left.createdAt ||
			Number(right.managed) - Number(left.managed) ||
			Number(right.locked) - Number(left.locked) ||
			left.sourceDigest.localeCompare(right.sourceDigest) ||
			left.lockedBy.localeCompare(right.lockedBy),
		)[0];
}

function lockRank(lock: InstructionLockV1 | undefined): number {
	if (lock?.locked !== true) return 0;
	return lock.managed ? 2 : 1;
}

function sourceOrder(left: InstructionSourceV1, right: InstructionSourceV1, locks: ReadonlyMap<string, InstructionLockV1>): number {
	const leftLock = lockRank(locks.get(left.sourceId));
	const rightLock = lockRank(locks.get(right.sourceId));
	return (
		rightLock - leftLock ||
		pathSpecificity(right.path) - pathSpecificity(left.path) ||
		right.priority - left.priority ||
		Number(left.inherited) - Number(right.inherited) ||
		left.sourceId.localeCompare(right.sourceId)
	);
}

export function resolveInstructionSources(
	sources: readonly InstructionSourceV1[],
	locks: readonly InstructionLockV1[],
	options: InstructionResolutionOptions = {},
): InstructionResolution {
	const orderedSources = [...sources].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
	const orderedLocks = [...locks].sort(
		(left, right) =>
			left.sourceId.localeCompare(right.sourceId) ||
			right.createdAt - left.createdAt ||
			Number(right.managed) - Number(left.managed) ||
			Number(right.locked) - Number(left.locked) ||
			left.lockedBy.localeCompare(right.lockedBy),
	);
	const lockBySource = new Map<string, InstructionLockV1>();
	for (const source of orderedSources) {
		const lock = lockForSource(source.sourceId, orderedLocks);
		if (lock !== undefined) lockBySource.set(source.sourceId, lock);
	}
	const sourceById = new Map(orderedSources.map((source) => [source.sourceId, source]));
	const decisions = new Map<string, InstructionResolutionDecision>();
	const visiting = new Set<string>();

	const evaluate = (source: InstructionSourceV1): InstructionResolutionDecision => {
		const prior = decisions.get(source.sourceId);
		if (prior !== undefined) return prior;
		const lock = lockBySource.get(source.sourceId);
		const locked = lock?.locked === true;
		const managedLock = locked && lock?.managed === true;
		const pathMatched = pathContains(source.path, options.path);
		if (visiting.has(source.sourceId)) {
			const cycle: InstructionResolutionDecision = {
				sourceId: source.sourceId,
				...(source.parentSourceId === undefined ? {} : { parentSourceId: source.parentSourceId }),
				inherited: source.inherited === true,
				selected: false,
				decision: "exclude",
				reason: "inheritance_cycle",
				pathMatched,
				locked,
				managedLock,
				precedence: Number.MAX_SAFE_INTEGER,
			};
			return cycle;
		}
		if (!pathMatched) {
			const decision: InstructionResolutionDecision = {
				sourceId: source.sourceId,
				...(source.parentSourceId === undefined ? {} : { parentSourceId: source.parentSourceId }),
				inherited: source.inherited === true,
				selected: false,
				decision: "exclude",
				reason: "path_mismatch",
				pathMatched: false,
				locked,
				managedLock,
				precedence: Number.MAX_SAFE_INTEGER,
			};
			decisions.set(source.sourceId, decision);
			return decision;
		}
		if (!source.enabled && !managedLock) {
			const decision: InstructionResolutionDecision = {
				sourceId: source.sourceId,
				...(source.parentSourceId === undefined ? {} : { parentSourceId: source.parentSourceId }),
				inherited: source.inherited === true,
				selected: false,
				decision: "exclude",
				reason: "disabled",
				pathMatched: true,
				locked,
				managedLock,
				precedence: Number.MAX_SAFE_INTEGER,
			};
			decisions.set(source.sourceId, decision);
			return decision;
		}

		visiting.add(source.sourceId);
		let parentSelected: boolean | undefined;
		let reason = managedLock ? "managed_lock_preserved" : locked ? "locked_source_preserved" : source.inherited ? "inherited_source" : "selected";
		if (source.parentSourceId !== undefined || source.inherited === true) {
			const parent = source.parentSourceId === undefined ? undefined : sourceById.get(source.parentSourceId);
			if (parent === undefined) {
				visiting.delete(source.sourceId);
				const decision: InstructionResolutionDecision = {
					sourceId: source.sourceId,
					...(source.parentSourceId === undefined ? {} : { parentSourceId: source.parentSourceId }),
					inherited: source.inherited === true,
					selected: false,
					decision: "exclude",
					reason: "missing_parent",
					pathMatched: true,
					parentSelected: false,
					locked,
					managedLock,
					precedence: Number.MAX_SAFE_INTEGER,
				};
				decisions.set(source.sourceId, decision);
				return decision;
			}
			const parentDecision = evaluate(parent);
			parentSelected = parentDecision.selected;
			if (!parentSelected) {
				visiting.delete(source.sourceId);
				const decision: InstructionResolutionDecision = {
					sourceId: source.sourceId,
					...(source.parentSourceId === undefined ? {} : { parentSourceId: source.parentSourceId }),
					inherited: source.inherited === true,
					selected: false,
					decision: "exclude",
					reason: parentDecision.reason === "inheritance_cycle" ? "inheritance_cycle" : "parent_excluded",
					pathMatched: true,
					parentSelected: false,
					locked,
					managedLock,
					precedence: Number.MAX_SAFE_INTEGER,
				};
				decisions.set(source.sourceId, decision);
				return decision;
			}
			reason = managedLock ? "managed_lock_preserved_inherited_source" : "inherited_source";
		}
		visiting.delete(source.sourceId);
		const decision: InstructionResolutionDecision = {
			sourceId: source.sourceId,
			...(source.parentSourceId === undefined ? {} : { parentSourceId: source.parentSourceId }),
			inherited: source.inherited === true,
			selected: true,
			decision: "include",
			reason,
			pathMatched: true,
			...(parentSelected === undefined ? {} : { parentSelected }),
			locked,
			managedLock,
			precedence: Number.MAX_SAFE_INTEGER,
		};
		decisions.set(source.sourceId, decision);
		return decision;
	};

	for (const source of orderedSources) evaluate(source);
	const selected = orderedSources
		.filter((source) => decisions.get(source.sourceId)?.selected === true)
		.sort((left, right) => sourceOrder(left, right, lockBySource));
	const finalDecisions = orderedSources
		.map((source) => decisions.get(source.sourceId)!)
		.sort((left, right) => {
			const leftSource = sourceById.get(left.sourceId)!;
			const rightSource = sourceById.get(right.sourceId)!;
			const leftSelected = left.selected ? 0 : 1;
			return leftSelected - (right.selected ? 0 : 1) || sourceOrder(leftSource, rightSource, lockBySource) || left.sourceId.localeCompare(right.sourceId);
		})
		.map((decision, index) => ({ ...decision, precedence: index }));
	const selectedById = new Map(finalDecisions.map((decision) => [decision.sourceId, decision]));
	const resolvedSources = selected.map((source) => source);
	const digestBody = {
		sources: resolvedSources,
		locks: orderedLocks,
		decisions: finalDecisions,
		...(options.path === undefined ? {} : { path: normalizePath(options.path) }),
	};
	const digest = `instruction:sha256:${sha256HexValue(new TextEncoder().encode(canonicalFoundationJson(digestBody)))}`;
	return {
		sources: resolvedSources,
		locks: orderedLocks,
		decisions: finalDecisions.map((decision) => selectedById.get(decision.sourceId)!),
		...(options.path === undefined ? {} : { path: normalizePath(options.path) }),
		digest,
	};
}
