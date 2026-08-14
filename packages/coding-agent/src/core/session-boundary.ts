/** Durable branch, checkpoint, and recovery boundaries for Session history. */

import { randomUUID } from "node:crypto";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

export const SESSION_BOUNDARY_SCHEMA_VERSION = 1 as const;
export const SESSION_BOUNDARY_CUSTOM_TYPE = "session.boundary" as const;

export type SessionBoundaryKind = "branch" | "checkpoint" | "recovery";
export type SessionBoundaryStatus = "created" | "restored";

export interface SessionBoundaryRecord {
	readonly schemaVersion: typeof SESSION_BOUNDARY_SCHEMA_VERSION;
	readonly boundaryId: string;
	readonly kind: SessionBoundaryKind;
	readonly status: SessionBoundaryStatus;
	readonly sessionId: string;
	readonly leafId: string | null;
	readonly sourceLeafId?: string | null;
	readonly targetLeafId?: string | null;
	readonly checkpointId?: string;
	readonly parentBoundaryId?: string;
	readonly reason?: string;
	readonly createdAt: string;
}

export interface SessionBoundarySession
	extends Pick<
		SessionManager,
		"getSessionId" | "getLeafId" | "getEntry" | "getEntries" | "branch" | "resetLeaf" | "appendCustomEntry"
	> {}

export class SessionBoundaryError extends Error {
	readonly code: "checkpoint_not_found" | "checkpoint_invalid";

	constructor(code: SessionBoundaryError["code"], message: string) {
		super(message);
		this.name = "SessionBoundaryError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function isLeafId(value: unknown): value is string | null {
	return value === null || isSafeIdentifier(value);
}

export function isSessionBoundaryRecord(value: unknown): value is SessionBoundaryRecord {
	if (!isRecord(value) || value.schemaVersion !== SESSION_BOUNDARY_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.boundaryId) ||
		(value.kind !== "branch" && value.kind !== "checkpoint" && value.kind !== "recovery") ||
		(value.status !== "created" && value.status !== "restored") ||
		!isSafeIdentifier(value.sessionId) ||
		!isLeafId(value.leafId) ||
		typeof value.createdAt !== "string" ||
		Number.isNaN(Date.parse(value.createdAt))
	) {
		return false;
	}
	for (const key of ["sourceLeafId", "targetLeafId"] as const) {
		if (value[key] !== undefined && !isLeafId(value[key])) return false;
	}
	for (const key of ["checkpointId", "parentBoundaryId"] as const) {
		if (value[key] !== undefined && !isSafeIdentifier(value[key])) return false;
	}
	return value.reason === undefined || (typeof value.reason === "string" && value.reason.length <= 512);
}

function parseBoundaryEntry(entry: SessionEntry): SessionBoundaryRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== SESSION_BOUNDARY_CUSTOM_TYPE) return undefined;
	const value = isRecord(entry.data) && "boundary" in entry.data ? entry.data.boundary : entry.data;
	return isSessionBoundaryRecord(value) ? value : undefined;
}

export function getSessionBoundaries(sessionManager: SessionManager): SessionBoundaryRecord[] {
	return sessionManager.getEntries().flatMap((entry) => {
		const boundary = parseBoundaryEntry(entry);
		return boundary === undefined ? [] : [boundary];
	});
}

function persistBoundary(sessionManager: SessionManager, boundary: SessionBoundaryRecord): string {
	if (!isSessionBoundaryRecord(boundary)) throw new TypeError("Invalid session boundary");
	return sessionManager.appendCustomEntry(SESSION_BOUNDARY_CUSTOM_TYPE, {
		schemaVersion: SESSION_BOUNDARY_SCHEMA_VERSION,
		boundary: { ...boundary },
	});
}

export function createSessionCheckpoint(sessionManager: SessionManager, reason?: string): SessionBoundaryRecord {
	const boundary: SessionBoundaryRecord = {
		schemaVersion: SESSION_BOUNDARY_SCHEMA_VERSION,
		boundaryId: `checkpoint:${randomUUID()}`,
		kind: "checkpoint",
		status: "created",
		sessionId: sessionManager.getSessionId(),
		leafId: sessionManager.getLeafId(),
		...(reason === undefined ? {} : { reason: reason.slice(0, 512) }),
		createdAt: new Date().toISOString(),
	};
	persistBoundary(sessionManager, boundary);
	return boundary;
}

export function createSessionBranchBoundary(
	sessionManager: SessionManager,
	sourceLeafId: string | null,
	targetLeafId: string | null = sessionManager.getLeafId(),
	reason?: string,
): SessionBoundaryRecord {
	const boundary: SessionBoundaryRecord = {
		schemaVersion: SESSION_BOUNDARY_SCHEMA_VERSION,
		boundaryId: `branch:${randomUUID()}`,
		kind: "branch",
		status: "created",
		sessionId: sessionManager.getSessionId(),
		leafId: targetLeafId,
		sourceLeafId,
		targetLeafId,
		...(reason === undefined ? {} : { reason: reason.slice(0, 512) }),
		createdAt: new Date().toISOString(),
	};
	persistBoundary(sessionManager, boundary);
	return boundary;
}

/** Restore a checkpoint by branching from its recorded leaf, then record recovery. */
export function recoverSessionCheckpoint(
	sessionManager: SessionManager,
	checkpointId: string,
	reason?: string,
): SessionBoundaryRecord {
	const checkpoint = getSessionBoundaries(sessionManager).find(
		(boundary) => boundary.kind === "checkpoint" && boundary.boundaryId === checkpointId,
	);
	if (checkpoint === undefined) {
		throw new SessionBoundaryError("checkpoint_not_found", `Checkpoint ${checkpointId} not found.`);
	}
	if (checkpoint.leafId !== null && sessionManager.getEntry(checkpoint.leafId) === undefined) {
		throw new SessionBoundaryError("checkpoint_invalid", `Checkpoint ${checkpointId} references a missing leaf.`);
	}
	if (checkpoint.leafId === null) sessionManager.resetLeaf();
	else sessionManager.branch(checkpoint.leafId);
	const boundary: SessionBoundaryRecord = {
		schemaVersion: SESSION_BOUNDARY_SCHEMA_VERSION,
		boundaryId: `recovery:${randomUUID()}`,
		kind: "recovery",
		status: "restored",
		sessionId: sessionManager.getSessionId(),
		leafId: checkpoint.leafId,
		targetLeafId: checkpoint.leafId,
		checkpointId: checkpoint.boundaryId,
		parentBoundaryId: checkpoint.boundaryId,
		...(reason === undefined ? {} : { reason: reason.slice(0, 512) }),
		createdAt: new Date().toISOString(),
	};
	persistBoundary(sessionManager, boundary);
	return boundary;
}
