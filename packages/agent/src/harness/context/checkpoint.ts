import { canonicalFoundationJson, sha256HexValue } from "../foundation/index.ts";
import { estimateTokens } from "../compaction/compaction.ts";
import type { Entry } from "../session/types.ts";
import type { ContextRecoveryBoundary, ContextSnapshot } from "./snapshot.ts";

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface WorkspaceCheckpointState {
	readonly known: boolean;
	readonly digest?: string;
	readonly readFiles?: readonly string[];
	readonly modifiedFiles?: readonly string[];
	readonly pendingFiles?: readonly string[];
	readonly unknownFiles?: readonly string[];
}

export interface TranscriptCheckpointImpact {
	readonly beforeDigest: string;
	readonly afterDigest: string;
	readonly beforeEntryCount: number;
	readonly afterEntryCount: number;
	readonly removedEntryIds: readonly string[];
	readonly removedMessageCount: number;
	readonly estimatedTokensRemoved: number;
}

export interface WorkspaceCheckpointImpact {
	readonly known: boolean;
	readonly digest?: string;
	readonly readFiles: readonly string[];
	readonly modifiedFiles: readonly string[];
	readonly pendingFiles: readonly string[];
	readonly unknownFiles: readonly string[];
	readonly hasUncommittedImpact: boolean;
}

export type CheckpointRewindReason =
	| "ok"
	| "checkpoint_mismatch"
	| "lane_changed"
	| "target_not_found"
	| "transcript_changed"
	| "digest_mismatch"
	| "workspace_unknown"
	| "workspace_modified"
	| "workspace_pending";

export interface CheckpointImpactPlanV1 {
	readonly schemaVersion: 1;
	readonly digest: string;
	readonly checkpointId: string;
	readonly sourceSnapshotId: string;
	readonly targetEntryId: string | null;
	readonly status: "approved" | "rejected";
	readonly reason: CheckpointRewindReason;
	readonly failClosed: true;
	readonly transcript: TranscriptCheckpointImpact;
	readonly workspace: WorkspaceCheckpointImpact;
	readonly boundary: ContextRecoveryBoundary;
	readonly checkpointTranscriptDigest?: string;
	readonly checkpointWorkspaceDigest?: string;
	readonly currentLaneLeafId?: string | null;
}

export interface CheckpointPlanOptions {
	readonly checkpointId: string;
	readonly targetEntryId?: string | null;
	readonly workspace?: WorkspaceCheckpointState;
	readonly expectedTranscriptDigest?: string;
	readonly expectedWorkspaceDigest?: string;
	readonly checkpointTranscriptDigest?: string;
	readonly checkpointWorkspaceDigest?: string;
	readonly currentLaneLeafId?: string | null;
	readonly expectedLaneLeafId?: string | null;
}

export interface CheckpointV1 {
	readonly schemaVersion: 1;
	readonly checkpointId: string;
	readonly snapshotId: string;
	readonly lane: string;
	readonly entryId: string | null;
	readonly transcriptDigest: string;
	readonly workspaceDigest?: string;
	readonly createdAt: number;
	readonly failClosed: true;
	readonly currentLaneLeafId?: string | null;
}

export interface CheckpointRewindAuthority {
	readonly checkpoint: CheckpointV1;
	readonly targetEntryId: string | null;
	readonly workspace: WorkspaceCheckpointState;
	readonly planId?: string;
	readonly lane?: string;
}

type CheckpointImpactPlanWithSessionFields = CheckpointImpactPlanV1 & {
	readonly planId?: string;
	readonly lane?: string;
};

function digest(value: unknown): string {
	return `sha256:${sha256HexValue(canonicalFoundationJson(value))}`;
}

function messageEntry(entry: Entry): boolean {
	return entry.type === "message";
}

export function digestCheckpointTranscript(entries: readonly Entry[]): string {
	return digest(entries);
}

function workspaceImpact(state: WorkspaceCheckpointState | undefined): WorkspaceCheckpointImpact {
	const readFiles = [...new Set(state?.readFiles ?? [])].sort();
	const modifiedFiles = [...new Set(state?.modifiedFiles ?? [])].sort();
	const pendingFiles = [...new Set(state?.pendingFiles ?? [])].sort();
	const unknownFiles = [...new Set(state?.unknownFiles ?? [])].sort();
	return {
		known: state?.known === true,
		...(state?.digest === undefined ? {} : { digest: state.digest }),
		readFiles,
		modifiedFiles,
		pendingFiles,
		unknownFiles,
		hasUncommittedImpact: modifiedFiles.length > 0 || pendingFiles.length > 0 || unknownFiles.length > 0,
	};
}

function workspaceEvidenceComplete(state: WorkspaceCheckpointState | undefined): boolean {
	if (state?.known !== true || typeof state.digest !== "string" || state.digest.length === 0) return false;
	return [state.readFiles, state.modifiedFiles, state.pendingFiles, state.unknownFiles].every(
		(files) => Array.isArray(files) && files.every((file) => typeof file === "string"),
	);
}

function workspaceUnknown(state: WorkspaceCheckpointState | undefined): boolean {
	return !workspaceEvidenceComplete(state);
}

/**
 * Produce the durable decision before any lane movement. Unknown workspace
 * state and uncommitted effects are rejected instead of guessed away.
 */
export function planCheckpointRewind(snapshot: ContextSnapshot, options: CheckpointPlanOptions): CheckpointImpactPlanV1 {
	const targetEntryId = options.targetEntryId ?? null;
	const entries = [...snapshot.entries()];
	const targetIndex = targetEntryId === null ? -1 : entries.findIndex((entry) => entry.id === targetEntryId);
	const targetExists = targetEntryId === null || targetIndex >= 0;
	const removed = targetExists ? (targetEntryId === null ? entries : entries.slice(targetIndex + 1)) : [];
	const beforeDigest = digestCheckpointTranscript(entries);
	const afterEntries = targetExists ? (targetEntryId === null ? [] : entries.slice(0, targetIndex + 1)) : entries;
	const transcript: TranscriptCheckpointImpact = {
		beforeDigest,
		afterDigest: digestCheckpointTranscript(afterEntries),
		beforeEntryCount: entries.length,
		afterEntryCount: afterEntries.length,
		removedEntryIds: removed.map((entry) => entry.id),
		removedMessageCount: removed.filter(messageEntry).length,
		estimatedTokensRemoved: removed.reduce((total, entry) => {
			return entry.type === "message" ? total + estimateTokens(entry.message) : total;
		}, 0),
	};
	const workspace = workspaceImpact(options.workspace);
	let reason: CheckpointRewindReason = "ok";
	if (workspaceUnknown(options.workspace) || workspace.unknownFiles.length > 0) reason = "workspace_unknown";
	else if (!targetExists) reason = "target_not_found";
	else if (options.checkpointTranscriptDigest !== undefined && options.checkpointTranscriptDigest !== beforeDigest) reason = "checkpoint_mismatch";
	else if (options.expectedLaneLeafId !== undefined && options.currentLaneLeafId !== options.expectedLaneLeafId) reason = "lane_changed";
	else if (options.expectedTranscriptDigest !== undefined && options.expectedTranscriptDigest !== beforeDigest) reason = "transcript_changed";
	else if (options.checkpointWorkspaceDigest !== undefined && options.checkpointWorkspaceDigest !== workspace.digest) reason = "digest_mismatch";
	else if (options.expectedWorkspaceDigest !== undefined && options.expectedWorkspaceDigest !== workspace.digest) reason = "digest_mismatch";
	else if (workspace.modifiedFiles.length > 0) reason = "workspace_modified";
	else if (workspace.pendingFiles.length > 0) reason = "workspace_pending";
	const boundary: ContextRecoveryBoundary = {
		transcriptDigest: beforeDigest,
		...(workspace.digest === undefined ? {} : { workspaceDigest: workspace.digest }),
		entryId: targetEntryId,
		failClosed: true,
	};
	const body = {
		schemaVersion: CHECKPOINT_SCHEMA_VERSION,
		checkpointId: options.checkpointId,
		sourceSnapshotId: snapshot.snapshotId,
		targetEntryId,
		status: reason === "ok" ? ("approved" as const) : ("rejected" as const),
		reason,
		failClosed: true as const,
		transcript,
		workspace,
		boundary,
		...(options.checkpointTranscriptDigest === undefined ? {} : { checkpointTranscriptDigest: options.checkpointTranscriptDigest }),
		...(options.checkpointWorkspaceDigest === undefined ? {} : { checkpointWorkspaceDigest: options.checkpointWorkspaceDigest }),
		...(options.currentLaneLeafId === undefined ? {} : { currentLaneLeafId: options.currentLaneLeafId }),
	};
	return Object.freeze({ ...body, digest: digest(body) });
}

export const createCheckpointImpactPlan = planCheckpointRewind;

export function createCheckpoint(snapshot: ContextSnapshot, lane: string, checkpointId: string, workspace?: WorkspaceCheckpointState, now = Date.now): CheckpointV1 {
	return {
		schemaVersion: 1,
		checkpointId,
		snapshotId: snapshot.snapshotId,
		lane,
		entryId: snapshot.headEntryId,
		transcriptDigest: digestCheckpointTranscript(snapshot.entries()),
		...(workspace?.digest === undefined ? {} : { workspaceDigest: workspace.digest }),
		createdAt: now(),
		failClosed: true,
		currentLaneLeafId: snapshot.headEntryId,
	};
}

function checkpointMatchesSnapshot(checkpoint: CheckpointV1, snapshot: ContextSnapshot): boolean {
	return (
		checkpoint.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
		checkpoint.failClosed === true &&
		checkpoint.snapshotId === snapshot.snapshotId &&
		checkpoint.entryId === snapshot.headEntryId &&
		checkpoint.transcriptDigest === digestCheckpointTranscript(snapshot.entries()) &&
		(checkpoint.currentLaneLeafId ?? checkpoint.entryId) === snapshot.headEntryId
	);
}

function expectedCheckpointImpactPlan(snapshot: ContextSnapshot, authority: CheckpointRewindAuthority): CheckpointImpactPlanWithSessionFields | undefined {
	if (!checkpointMatchesSnapshot(authority.checkpoint, snapshot)) return undefined;
	if (authority.lane !== undefined && authority.lane !== authority.checkpoint.lane) return undefined;
	const expected = planCheckpointRewind(snapshot, {
		checkpointId: authority.checkpoint.checkpointId,
		targetEntryId: authority.targetEntryId,
		workspace: authority.workspace,
		checkpointTranscriptDigest: authority.checkpoint.transcriptDigest,
		checkpointWorkspaceDigest: authority.checkpoint.workspaceDigest,
		currentLaneLeafId: authority.checkpoint.currentLaneLeafId ?? authority.checkpoint.entryId,
		expectedLaneLeafId: snapshot.headEntryId,
	});
	return {
		...expected,
		...(authority.planId === undefined ? {} : { planId: authority.planId }),
		...(authority.lane === undefined ? {} : { lane: authority.lane }),
	};
}

function exactCheckpointImpactPlanMatch(plan: CheckpointImpactPlanWithSessionFields, expected: CheckpointImpactPlanWithSessionFields): boolean {
	try {
		return canonicalFoundationJson(plan) === canonicalFoundationJson(expected);
	} catch {
		return false;
	}
}

export function applyCheckpointRewind(snapshot: ContextSnapshot, plan: CheckpointImpactPlanV1, authority: CheckpointRewindAuthority): ContextSnapshot | undefined {
	if (!validateCheckpointImpactPlan(plan, snapshot, authority)) return undefined;
	if (plan.targetEntryId === null) return snapshot.fork({ mode: "none", checkpointId: plan.checkpointId });
	return snapshot.rewindTo(plan.targetEntryId);
}

export function validateCheckpointImpactPlan(plan: CheckpointImpactPlanV1, snapshot: ContextSnapshot, authority: CheckpointRewindAuthority): boolean {
	const expected = expectedCheckpointImpactPlan(snapshot, authority);
	return expected !== undefined && expected.status === "approved" && exactCheckpointImpactPlanMatch(plan, expected);
}
