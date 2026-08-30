import {
	canonicalFoundationJson,
	cloneDeepFrozen,
	FingerprintSchema,
	fingerprintFoundationValue,
	FoundationError,
	type FoundationJsonValue,
	Result,
	type ResultValue,
	type SessionLedger,
	validateEventPayloadForCategory,
	validateExactShape,
} from "@aos-agent/agent-core";
import { type Static, Type } from "typebox";

const WORKTREE_OBJECT_TYPE = "subagent.worktree_recorded";
const WORKTREE_QUARANTINE_OBJECT_TYPE = "subagent_worktree_quarantine";
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const BASE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const ChildWorktreeRecordV1Schema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		childAgentInstanceId: Type.String({ minLength: 1 }),
		attemptId: Type.String({ minLength: 1 }),
		baseRef: Type.String({ minLength: 1 }),
		worktreeDigest: FingerprintSchema,
		apply: Type.Optional(
			Type.Object(
				{
					status: Type.Union([Type.Literal("applied"), Type.Literal("conflict"), Type.Literal("unknown")]),
					at: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
		),
		cleanedUp: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export type ChildWorktreeRecord = Static<typeof ChildWorktreeRecordV1Schema>;

export interface ChildWorktreeIdentity {
	readonly schemaVersion: 1;
	readonly childAgentInstanceId: string;
	readonly attemptId: string;
}

export type OwnedWorktreeState =
	| {
			readonly schemaVersion: 1;
			readonly childAgentInstanceId: string;
			readonly attemptId: string;
			readonly state: "present";
			readonly baseRef: string;
			readonly baseDigest: string;
			readonly targetDigest: string;
			readonly currentDigest: string;
	  }
	| {
			readonly schemaVersion: 1;
			readonly childAgentInstanceId: string;
			readonly attemptId: string;
			readonly state: "missing" | "quarantined";
	  };

export interface WorktreeAdapter {
	createWorktree(identity: ChildWorktreeIdentity, baseRef: string): Promise<ResultValue<void, FoundationError>>;
	resolveOwnedWorktree(identity: ChildWorktreeIdentity): Promise<ResultValue<OwnedWorktreeState, FoundationError>>;
	applyWorktree(
		identity: ChildWorktreeIdentity,
		expected: Extract<OwnedWorktreeState, { readonly state: "present" }>,
	): Promise<ResultValue<{ readonly status: "applied" | "conflict" | "unknown" }, FoundationError>>;
	deleteWorktree(
		identity: ChildWorktreeIdentity,
		expected: Extract<OwnedWorktreeState, { readonly state: "present" }>,
	): Promise<ResultValue<void, FoundationError>>;
	quarantineWorktree(identity: ChildWorktreeIdentity): Promise<ResultValue<void, FoundationError>>;
}

export interface ChildWorktreeHost {
	readonly adapter: WorktreeAdapter;
	readonly ledger: SessionLedger;
	readonly sessionId: string;
	readonly laneId: string;
	readonly now?: () => number;
}

interface DurableWorktreeRecordV1 {
	readonly record: ChildWorktreeRecord;
	readonly revision: number;
}

function conflict(message: string, cause?: FoundationError): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError("subagent_worktree_conflict", message, cause === undefined ? undefined : { cause }));
}

function closeUnknown(message: string, cause?: FoundationError): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError("subagent_close_unknown", message, cause === undefined ? undefined : { cause }));
}

function validIdentity(value: string): boolean {
	return IDENTITY_PATTERN.test(value);
}

function validBaseRef(value: string): boolean {
	return BASE_REF_PATTERN.test(value) && !value.includes("..");
}

function identity(childAgentInstanceId: string, attemptId: string): ResultValue<ChildWorktreeIdentity, FoundationError> {
	return validIdentity(childAgentInstanceId) && validIdentity(attemptId)
		? Result.ok(cloneDeepFrozen({ schemaVersion: 1 as const, childAgentInstanceId, attemptId }))
		: conflict("Child worktree identity is invalid");
}

function objectId(value: ChildWorktreeIdentity): string {
	return fingerprintFoundationValue({
		schemaVersion: 1,
		childAgentInstanceId: value.childAgentInstanceId,
		attemptId: value.attemptId,
	}).value;
}

function timestamp(now: () => number): ResultValue<string, FoundationError> {
	const milliseconds = now();
	if (!Number.isFinite(milliseconds)) return conflict("Child worktree time is invalid");
	try {
		const value = new Date(milliseconds).toISOString();
		return new Date(value).toISOString() === value ? Result.ok(value) : conflict("Child worktree time is not canonical");
	} catch {
		return conflict("Child worktree time is outside the supported range");
	}
}

function validateOwnedState(value: unknown, expected: ChildWorktreeIdentity): ResultValue<OwnedWorktreeState, FoundationError> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return conflict("Host adapter returned an invalid owned-worktree state");
	const state = value as Record<string, unknown>;
	const exactIdentity =
		state.schemaVersion === 1 &&
		state.childAgentInstanceId === expected.childAgentInstanceId &&
		state.attemptId === expected.attemptId;
	if (!exactIdentity || !["present", "missing", "quarantined"].includes(state.state as string)) {
		return conflict("Host adapter returned a worktree outside the requested ownership identity");
	}
	if (state.state === "missing" || state.state === "quarantined") {
		return Object.keys(state).every((key) => ["schemaVersion", "childAgentInstanceId", "attemptId", "state"].includes(key))
			? Result.ok(cloneDeepFrozen(state as unknown as OwnedWorktreeState))
			: conflict("Host adapter returned an inexact terminal owned-worktree state");
	}
	if (
		!Object.keys(state).every((key) => ["schemaVersion", "childAgentInstanceId", "attemptId", "state", "baseRef", "baseDigest", "targetDigest", "currentDigest"].includes(key)) ||
		typeof state.baseRef !== "string" ||
		!validBaseRef(state.baseRef) ||
		typeof state.baseDigest !== "string" ||
		!DIGEST_PATTERN.test(state.baseDigest) ||
		typeof state.targetDigest !== "string" ||
		!DIGEST_PATTERN.test(state.targetDigest) ||
		typeof state.currentDigest !== "string" ||
		!DIGEST_PATTERN.test(state.currentDigest)
	) return conflict("Host adapter did not prove the owned worktree base, target, and current digests");
	return Result.ok(cloneDeepFrozen(state as unknown as OwnedWorktreeState));
}

function worktreeFingerprint(state: Extract<OwnedWorktreeState, { readonly state: "present" }>) {
	return fingerprintFoundationValue({
		schemaVersion: 1,
		childAgentInstanceId: state.childAgentInstanceId,
		attemptId: state.attemptId,
		baseRef: state.baseRef,
		baseDigest: state.baseDigest,
		targetDigest: state.targetDigest,
	});
}

function validateRecord(value: unknown): ResultValue<ChildWorktreeRecord, FoundationError> {
	const checked = validateExactShape<ChildWorktreeRecord>(ChildWorktreeRecordV1Schema, value, "child_worktree_record");
	if (!checked.ok || !validIdentity(checked.ok ? checked.value.childAgentInstanceId : "") || !validIdentity(checked.ok ? checked.value.attemptId : "") || !validBaseRef(checked.ok ? checked.value.baseRef : "")) {
		return conflict("Child worktree record has an invalid exact shape or identity", checked.ok ? undefined : checked.error);
	}
	if (checked.value.apply !== undefined) {
		try {
			if (new Date(checked.value.apply.at).toISOString() !== checked.value.apply.at) return conflict("Child worktree record time is not canonical");
		} catch {
			return conflict("Child worktree record time is outside the supported range");
		}
	}
	return Result.ok(cloneDeepFrozen(checked.value));
}

function eventPayload(record: ChildWorktreeRecord): FoundationJsonValue {
	return {
		schemaVersion: 1,
		childAgentInstanceId: record.childAgentInstanceId,
		attemptId: record.attemptId,
		baseRef: record.baseRef,
		worktreeDigest: `${record.worktreeDigest.algorithm}:${record.worktreeDigest.value}`,
		...(record.apply === undefined ? {} : { apply: record.apply }),
		...(record.cleanedUp === undefined ? {} : { cleanedUp: record.cleanedUp }),
	};
}

function recordFromEventPayload(value: unknown): ResultValue<ChildWorktreeRecord, FoundationError> {
	if (!validateEventPayloadForCategory("subagent.worktree_recorded", value) || value === null || typeof value !== "object" || Array.isArray(value)) {
		return conflict("Durable child worktree event is invalid");
	}
	const payload = value as Record<string, unknown>;
	const digest = payload.worktreeDigest as string;
	if (!DIGEST_PATTERN.test(digest)) return conflict("Durable child worktree event has an invalid ownership digest");
	return validateRecord({
		schemaVersion: 1,
		childAgentInstanceId: payload.childAgentInstanceId,
		attemptId: payload.attemptId,
		baseRef: payload.baseRef,
		worktreeDigest: { algorithm: "sha256", value: digest.slice("sha256:".length) },
		...(payload.apply === undefined ? {} : { apply: payload.apply }),
		...(payload.cleanedUp === undefined ? {} : { cleanedUp: payload.cleanedUp }),
	});
}

async function readDurableRecord(
	host: ChildWorktreeHost,
	value: ChildWorktreeIdentity,
): Promise<ResultValue<DurableWorktreeRecordV1 | undefined, FoundationError>> {
	try {
		const stored = await host.ledger.get(WORKTREE_OBJECT_TYPE, objectId(value));
		if (stored === undefined) return Result.ok(undefined);
		if (
			stored.kind !== "fact" ||
			stored.objectType !== WORKTREE_OBJECT_TYPE ||
			stored.objectId !== objectId(value) ||
			stored.lane !== host.laneId ||
			!Number.isSafeInteger(stored.revision) ||
			stored.revision < 1 ||
			stored.correlation.sessionId !== host.sessionId ||
			stored.correlation.laneId !== host.laneId ||
			stored.correlation.attemptId !== value.attemptId ||
			stored.correlation.agentInstanceId !== value.childAgentInstanceId
		) return conflict("Child worktree durable identity metadata is invalid");
		const record = recordFromEventPayload(stored.payload);
		if (!record.ok) return record;
		if (record.value.childAgentInstanceId !== value.childAgentInstanceId || record.value.attemptId !== value.attemptId) return conflict("Child worktree durable identity is mismatched");
		const expectedRevision = 1 + (record.value.apply === undefined ? 0 : 1) + (record.value.cleanedUp === undefined ? 0 : 1);
		if (stored.revision !== expectedRevision) return conflict("Child worktree durable revision does not match its lifecycle facts");
		return Result.ok({ record: record.value, revision: stored.revision });
	} catch (error) {
		return conflict("Child worktree durable record could not be read", error instanceof FoundationError ? error : undefined);
	}
}

async function persistRecord(
	host: ChildWorktreeHost,
	record: ChildWorktreeRecord,
	expectedRevision: number,
): Promise<ResultValue<ChildWorktreeRecord, FoundationError>> {
	const payload = eventPayload(record);
	if (!validateEventPayloadForCategory("subagent.worktree_recorded", payload)) return conflict("Child worktree durable event projection is invalid");
	try {
		const stored = await host.ledger.appendFact(WORKTREE_OBJECT_TYPE, objectId(record), payload, {
			clientRequestId: `subagent-worktree:${objectId(record)}:${expectedRevision + 1}`,
			expectedRevision,
			correlation: { attemptId: record.attemptId, agentInstanceId: record.childAgentInstanceId },
		});
		if (
			stored.record.kind !== "fact" ||
			stored.record.objectType !== WORKTREE_OBJECT_TYPE ||
			stored.record.objectId !== objectId(record) ||
			stored.record.lane !== host.laneId ||
			stored.record.revision !== expectedRevision + 1 ||
			stored.record.correlation.sessionId !== host.sessionId ||
			stored.record.correlation.laneId !== host.laneId ||
			stored.record.correlation.attemptId !== record.attemptId ||
			stored.record.correlation.agentInstanceId !== record.childAgentInstanceId
		) return conflict("Child worktree durable record metadata is invalid");
		const checked = recordFromEventPayload(stored.payload);
		if (!checked.ok || canonicalFoundationJson(checked.value) !== canonicalFoundationJson(record)) return conflict("Child worktree durable record content is invalid");
		return checked;
	} catch (error) {
		return conflict("Child worktree durable event could not be persisted", error instanceof FoundationError ? error : undefined);
	}
}

async function persistQuarantineFact(
	host: ChildWorktreeHost,
	value: ChildWorktreeIdentity,
	reason: "create_digest_unknown" | "apply_unknown" | "cleanup_unknown",
): Promise<ResultValue<void, FoundationError>> {
	const quarantineObjectId = `${objectId(value)}:${reason}`;
	try {
		const existing = await host.ledger.get(WORKTREE_QUARANTINE_OBJECT_TYPE, quarantineObjectId);
		if (existing !== undefined) {
			const payload = existing.kind === "fact" && existing.payload !== null && typeof existing.payload === "object" && !Array.isArray(existing.payload)
				? existing.payload as Record<string, unknown>
				: undefined;
			let validTimestamp = false;
			if (typeof payload?.at === "string") {
				try {
					validTimestamp = new Date(payload.at).toISOString() === payload.at;
				} catch {
					validTimestamp = false;
				}
			}
			if (
				existing.kind !== "fact" ||
				existing.objectType !== WORKTREE_QUARANTINE_OBJECT_TYPE ||
				existing.objectId !== quarantineObjectId ||
				existing.lane !== host.laneId ||
				existing.revision !== 1 ||
				existing.correlation.sessionId !== host.sessionId ||
				existing.correlation.laneId !== host.laneId ||
				existing.correlation.attemptId !== value.attemptId ||
				existing.correlation.agentInstanceId !== value.childAgentInstanceId ||
				payload === undefined ||
				!Object.keys(payload).every((key) => ["schemaVersion", "childAgentInstanceId", "attemptId", "reason", "at"].includes(key)) ||
				Object.keys(payload).length !== 5 ||
				payload.schemaVersion !== 1 ||
				payload.childAgentInstanceId !== value.childAgentInstanceId ||
				payload.attemptId !== value.attemptId ||
				payload.reason !== reason ||
				!validTimestamp
			) return closeUnknown("Child worktree quarantine fact conflicts with its durable identity");
			return Result.ok(undefined);
		}
		const at = timestamp(host.now ?? Date.now);
		if (!at.ok) return at;
		const payload = cloneDeepFrozen({ ...value, reason, at: at.value });
		const stored = await host.ledger.appendFact(WORKTREE_QUARANTINE_OBJECT_TYPE, quarantineObjectId, payload as unknown as FoundationJsonValue, {
			clientRequestId: `subagent-worktree-quarantine:${objectId(value)}:${reason}`,
			expectedRevision: 0,
			correlation: { attemptId: value.attemptId, agentInstanceId: value.childAgentInstanceId },
		});
		if (
			stored.record.kind !== "fact" ||
			stored.record.objectType !== WORKTREE_QUARANTINE_OBJECT_TYPE ||
			stored.record.objectId !== quarantineObjectId ||
			stored.record.lane !== host.laneId ||
			stored.record.revision !== 1 ||
			stored.record.correlation.sessionId !== host.sessionId ||
			stored.record.correlation.laneId !== host.laneId ||
			stored.record.correlation.attemptId !== value.attemptId ||
			stored.record.correlation.agentInstanceId !== value.childAgentInstanceId ||
			canonicalFoundationJson(stored.payload) !== canonicalFoundationJson(payload)
		) return closeUnknown("Child worktree quarantine fact metadata or content is invalid");
		return Result.ok(undefined);
	} catch (error) {
		return closeUnknown("Child worktree quarantine fact could not be persisted", error instanceof FoundationError ? error : undefined);
	}
}

async function quarantine(
	host: ChildWorktreeHost,
	value: ChildWorktreeIdentity,
	reason: "create_digest_unknown" | "apply_unknown" | "cleanup_unknown",
): Promise<ResultValue<void, FoundationError>> {
	let quarantined: Awaited<ReturnType<WorktreeAdapter["quarantineWorktree"]>>;
	try {
		quarantined = await host.adapter.quarantineWorktree(value);
	} catch {
		return closeUnknown("Child worktree quarantine threw");
	}
	if (!quarantined.ok) return closeUnknown("Child worktree quarantine failed", quarantined.error);
	return persistQuarantineFact(host, value, reason);
}

async function resolvePresent(
	host: ChildWorktreeHost,
	value: ChildWorktreeIdentity,
	record: ChildWorktreeRecord,
): Promise<ResultValue<Extract<OwnedWorktreeState, { readonly state: "present" }>, FoundationError>> {
	let resolved: Awaited<ReturnType<WorktreeAdapter["resolveOwnedWorktree"]>>;
	try {
		resolved = await host.adapter.resolveOwnedWorktree(value);
	} catch {
		return conflict("Host adapter could not resolve the owned child worktree");
	}
	if (!resolved.ok) return conflict("Host adapter could not resolve the owned child worktree", resolved.error);
	const state = validateOwnedState(resolved.value, value);
	if (!state.ok) return state;
	if (state.value.state !== "present") return conflict("Owned child worktree is not present");
	const digest = worktreeFingerprint(state.value);
	if (state.value.baseRef !== record.baseRef || digest.algorithm !== record.worktreeDigest.algorithm || digest.value !== record.worktreeDigest.value) {
		return conflict("Owned child worktree base or target ownership proof changed");
	}
	return Result.ok(state.value);
}

async function requireCanonicalRecord(
	host: ChildWorktreeHost,
	value: unknown,
): Promise<ResultValue<DurableWorktreeRecordV1, FoundationError>> {
	const supplied = validateRecord(value);
	if (!supplied.ok) return supplied;
	const ownedIdentity = identity(supplied.value.childAgentInstanceId, supplied.value.attemptId);
	if (!ownedIdentity.ok) return ownedIdentity;
	const durable = await readDurableRecord(host, ownedIdentity.value);
	if (!durable.ok) return durable;
	if (durable.value === undefined || canonicalFoundationJson(durable.value.record) !== canonicalFoundationJson(supplied.value)) {
		return conflict("Child worktree record conflicts with its exact durable identity");
	}
	return Result.ok(durable.value);
}

export async function createChildWorktree(
	host: ChildWorktreeHost,
	childAgentInstanceId: string,
	attemptId: string,
	baseRef: string,
): Promise<ResultValue<ChildWorktreeRecord, FoundationError>> {
	const ownedIdentity = identity(childAgentInstanceId, attemptId);
	if (!ownedIdentity.ok) return ownedIdentity;
	if (!validBaseRef(baseRef)) return conflict("Child worktree baseRef is invalid");
	const existing = await readDurableRecord(host, ownedIdentity.value);
	if (!existing.ok) return existing;
	if (existing.value !== undefined) {
		const owned = await resolvePresent(host, ownedIdentity.value, existing.value.record);
		if (owned.ok) return Result.ok(existing.value.record);
		const quarantined = await quarantine(host, ownedIdentity.value, "create_digest_unknown");
		return quarantined.ok ? owned : quarantined;
	}
	let created: Awaited<ReturnType<WorktreeAdapter["createWorktree"]>>;
	try {
		created = await host.adapter.createWorktree(ownedIdentity.value, baseRef);
	} catch {
		const quarantined = await quarantine(host, ownedIdentity.value, "create_digest_unknown");
		return quarantined.ok ? conflict("Host adapter create threw with unknown partial worktree state and was quarantined") : quarantined;
	}
	if (!created.ok) {
		const quarantined = await quarantine(host, ownedIdentity.value, "create_digest_unknown");
		return quarantined.ok ? conflict("Host adapter create failed with unknown partial worktree state and was quarantined", created.error) : quarantined;
	}
	let resolved: Awaited<ReturnType<WorktreeAdapter["resolveOwnedWorktree"]>>;
	try {
		resolved = await host.adapter.resolveOwnedWorktree(ownedIdentity.value);
	} catch {
		const quarantined = await quarantine(host, ownedIdentity.value, "create_digest_unknown");
		return quarantined.ok ? conflict("Child worktree digest could not be resolved and was quarantined") : quarantined;
	}
	const state = resolved.ok ? validateOwnedState(resolved.value, ownedIdentity.value) : conflict("Host adapter failed to resolve the created child worktree", resolved.error);
	if (!state.ok || state.value.state !== "present" || state.value.baseRef !== baseRef) {
		const quarantined = await quarantine(host, ownedIdentity.value, "create_digest_unknown");
		return quarantined.ok ? conflict("Created child worktree did not prove its base, target, and current digests and was quarantined") : quarantined;
	}
	const record = cloneDeepFrozen({
		schemaVersion: 1 as const,
		childAgentInstanceId,
		attemptId,
		baseRef,
		worktreeDigest: worktreeFingerprint(state.value),
	});
	const persisted = await persistRecord(host, record, 0);
	if (persisted.ok) return persisted;
	const quarantined = await quarantine(host, ownedIdentity.value, "create_digest_unknown");
	return quarantined.ok ? persisted : quarantined;
}

/** Trusted Host recovery of the path-free durable worktree lifecycle record. */
export async function readChildWorktreeRecord(
	host: ChildWorktreeHost,
	childAgentInstanceId: string,
	attemptId: string,
): Promise<ResultValue<ChildWorktreeRecord | undefined, FoundationError>> {
	const ownedIdentity = identity(childAgentInstanceId, attemptId);
	if (!ownedIdentity.ok) return ownedIdentity;
	const durable = await readDurableRecord(host, ownedIdentity.value);
	return durable.ok ? Result.ok(durable.value?.record) : durable;
}

export async function applyChildWorktree(
	host: ChildWorktreeHost,
	recordValue: unknown,
): Promise<ResultValue<ChildWorktreeRecord, FoundationError>> {
	const at = timestamp(host.now ?? Date.now);
	if (!at.ok) return at;
	const durable = await requireCanonicalRecord(host, recordValue);
	if (!durable.ok) return durable;
	if (durable.value.record.apply !== undefined) return conflict("Child worktree already has a terminal apply fact");
	const ownedIdentity = identity(durable.value.record.childAgentInstanceId, durable.value.record.attemptId);
	if (!ownedIdentity.ok) return ownedIdentity;
	const owned = await resolvePresent(host, ownedIdentity.value, durable.value.record);
	if (!owned.ok) {
		const quarantined = await quarantine(host, ownedIdentity.value, "apply_unknown");
		return quarantined.ok ? owned : quarantined;
	}
	let applied: Awaited<ReturnType<WorktreeAdapter["applyWorktree"]>>;
	try {
		applied = await host.adapter.applyWorktree(ownedIdentity.value, owned.value);
	} catch {
		applied = Result.ok({ status: "unknown" });
	}
	const status = applied.ok ? applied.value.status : "unknown";
	const updated = cloneDeepFrozen({ ...durable.value.record, apply: { status, at: at.value } });
	const persisted = await persistRecord(host, updated, durable.value.revision);
	if (!persisted.ok) {
		const quarantined = await quarantine(host, ownedIdentity.value, "apply_unknown");
		return quarantined.ok ? persisted : quarantined;
	}
	if (status === "applied") return persisted;
	if (status === "conflict") return conflict("Child worktree apply conflicted and failed closed", applied.ok ? undefined : applied.error);
	const quarantined = await quarantine(host, ownedIdentity.value, "apply_unknown");
	return quarantined.ok ? conflict("Child worktree apply state is unknown and was quarantined", applied.ok ? undefined : applied.error) : quarantined;
}

export async function cleanupChildWorktree(
	host: ChildWorktreeHost,
	recordValue: unknown,
): Promise<ResultValue<ChildWorktreeRecord, FoundationError>> {
	const durable = await requireCanonicalRecord(host, recordValue);
	if (!durable.ok) return durable;
	const ownedIdentity = identity(durable.value.record.childAgentInstanceId, durable.value.record.attemptId);
	if (!ownedIdentity.ok) return ownedIdentity;
	let resolved: Awaited<ReturnType<WorktreeAdapter["resolveOwnedWorktree"]>>;
	try {
		resolved = await host.adapter.resolveOwnedWorktree(ownedIdentity.value);
	} catch {
		const quarantined = await quarantine(host, ownedIdentity.value, "cleanup_unknown");
		return quarantined.ok ? closeUnknown("Host adapter could not verify child worktree ownership before cleanup") : quarantined;
	}
	if (!resolved.ok) {
		const quarantined = await quarantine(host, ownedIdentity.value, "cleanup_unknown");
		return quarantined.ok ? closeUnknown("Host adapter could not verify child worktree ownership before cleanup", resolved.error) : quarantined;
	}
	const state = validateOwnedState(resolved.value, ownedIdentity.value);
	if (!state.ok) {
		const quarantined = await quarantine(host, ownedIdentity.value, "cleanup_unknown");
		return quarantined.ok ? state : quarantined;
	}
	if (durable.value.record.cleanedUp === true) {
		if (state.value.state === "missing") return Result.ok(durable.value.record);
		const quarantined = await quarantine(host, ownedIdentity.value, "cleanup_unknown");
		return quarantined.ok
			? closeUnknown(state.value.state === "quarantined" ? "Cleaned child worktree remains quarantined" : "Cleaned child worktree still resolves as owned storage")
			: quarantined;
	}
	if (state.value.state !== "present") {
		const quarantined = await quarantine(host, ownedIdentity.value, "cleanup_unknown");
		return quarantined.ok ? closeUnknown("Child worktree disappeared before owned cleanup completed") : quarantined;
	}
	const expectedDigest = worktreeFingerprint(state.value);
	if (state.value.baseRef !== durable.value.record.baseRef || expectedDigest.value !== durable.value.record.worktreeDigest.value) {
		const quarantined = await quarantine(host, ownedIdentity.value, "cleanup_unknown");
		return quarantined.ok ? closeUnknown("Child worktree ownership, base, or target digest changed before cleanup") : quarantined;
	}
	let deleted: Awaited<ReturnType<WorktreeAdapter["deleteWorktree"]>>;
	try {
		deleted = await host.adapter.deleteWorktree(ownedIdentity.value, state.value);
	} catch {
		deleted = Result.err(new FoundationError("subagent_close_unknown", "Host adapter delete threw"));
	}
	if (deleted.ok) {
		let after: Awaited<ReturnType<WorktreeAdapter["resolveOwnedWorktree"]>>;
		try {
			after = await host.adapter.resolveOwnedWorktree(ownedIdentity.value);
		} catch {
			after = Result.err(new FoundationError("subagent_close_unknown", "Host adapter resolve threw after delete"));
		}
		const afterStateResult = after.ok ? validateOwnedState(after.value, ownedIdentity.value) : closeUnknown("Host adapter could not verify child worktree deletion", after.error);
		if (afterStateResult.ok && afterStateResult.value.state === "missing") {
			const persisted = await persistRecord(host, cloneDeepFrozen({ ...durable.value.record, cleanedUp: true }), durable.value.revision);
			if (persisted.ok) return persisted;
			const quarantined = await quarantine(host, ownedIdentity.value, "cleanup_unknown");
			return quarantined.ok ? persisted : quarantined;
		}
	}
	const failedRecord = await persistRecord(host, cloneDeepFrozen({ ...durable.value.record, cleanedUp: false }), durable.value.revision);
	const quarantined = await quarantine(host, ownedIdentity.value, "cleanup_unknown");
	if (!failedRecord.ok) return quarantined.ok ? failedRecord : quarantined;
	return quarantined.ok ? closeUnknown("Child worktree cleanup is unknown and was quarantined", deleted.ok ? undefined : deleted.error) : quarantined;
}
