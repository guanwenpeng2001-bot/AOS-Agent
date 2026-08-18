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
	readonly enabled?: boolean;
	readonly priority?: number;
	readonly createdAt?: number;
}

export interface InstructionResolution {
	readonly sources: readonly InstructionSourceV1[];
	readonly locks: readonly InstructionLockV1[];
	readonly digest: string;
}

export function resolveInstructionSources(
	sources: readonly InstructionSourceV1[],
	locks: readonly InstructionLockV1[],
): InstructionResolution {
	const lockBySource = new Map(locks.map((lock) => [lock.sourceId, lock]));
	const selected = sources
		.filter((source) => source.enabled)
		.filter((source) => lockBySource.get(source.sourceId)?.locked !== true)
		.sort((left, right) => right.priority - left.priority || left.sourceId.localeCompare(right.sourceId));
	const serialized = JSON.stringify({ sources: selected, locks: locks.slice().sort((left, right) => left.sourceId.localeCompare(right.sourceId)) });
	let hash = 0;
	for (let index = 0; index < serialized.length; index++) hash = Math.imul(31, hash) + serialized.charCodeAt(index) | 0;
	return { sources: selected, locks, digest: `instruction:${(hash >>> 0).toString(16).padStart(8, "0")}` };
}
