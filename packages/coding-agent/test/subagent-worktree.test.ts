import { describe, expect, it } from "vitest";
import {
	fingerprintFoundationValue,
	FoundationError,
	InMemorySessionStorage,
	Result,
	Session,
	SessionLedger,
	type ResultValue,
} from "@aos-agent/agent-core";
import {
	applyChildWorktree,
	cleanupChildWorktree,
	createChildWorktree,
	type ChildWorktreeHost,
	type ChildWorktreeIdentity,
	type OwnedWorktreeState,
	type WorktreeAdapter,
} from "../src/core/subagent/worktree.ts";

const BASE_DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const CREATED_DIGEST = `sha256:${"c".repeat(64)}`;
const EDITED_DIGEST = `sha256:${"d".repeat(64)}`;

class FakeOwnedWorktreeAdapter implements WorktreeAdapter {
	state: OwnedWorktreeState = {
		schemaVersion: 1,
		childAgentInstanceId: "child-agent",
		attemptId: "attempt-1",
		state: "missing",
	};
	createBehavior: "ok" | "error" | "throw" = "ok";
	resolveBehavior: "ok" | "error" | "throw" = "ok";
	applyStatus: "applied" | "conflict" | "unknown" = "applied";
	quarantineFails = false;
	throwAfterDelete = false;
	createCount = 0;
	resolveCount = 0;
	applyCount = 0;
	deleteCount = 0;
	quarantineCount = 0;
	lastApplyCurrentDigest: string | undefined;

	async createWorktree(identity: ChildWorktreeIdentity, baseRef: string): Promise<ResultValue<void, FoundationError>> {
		this.createCount += 1;
		this.state = {
			...identity,
			state: "present",
			baseRef,
			baseDigest: BASE_DIGEST,
			targetDigest: TARGET_DIGEST,
			currentDigest: CREATED_DIGEST,
		};
		if (this.createBehavior === "throw") throw new Error("create failed after partial worktree creation");
		if (this.createBehavior === "error") return Result.err(new FoundationError("subagent_worktree_conflict", "create returned an unknown partial failure"));
		return Result.ok(undefined);
	}

	async resolveOwnedWorktree(): Promise<ResultValue<OwnedWorktreeState, FoundationError>> {
		this.resolveCount += 1;
		if (this.throwAfterDelete && this.deleteCount > 0) throw new Error("post-delete resolve threw");
		if (this.resolveBehavior === "throw") throw new Error("resolve threw");
		if (this.resolveBehavior === "error") return Result.err(new FoundationError("subagent_worktree_conflict", "resolve failed"));
		return Result.ok(this.state);
	}

	async applyWorktree(
		_identity: ChildWorktreeIdentity,
		expected: Extract<OwnedWorktreeState, { readonly state: "present" }>,
	): Promise<ResultValue<{ readonly status: "applied" | "conflict" | "unknown" }, FoundationError>> {
		this.applyCount += 1;
		this.lastApplyCurrentDigest = expected.currentDigest;
		return Result.ok({ status: this.applyStatus });
	}

	async deleteWorktree(identity: ChildWorktreeIdentity): Promise<ResultValue<void, FoundationError>> {
		this.deleteCount += 1;
		this.state = { ...identity, state: "missing" };
		return Result.ok(undefined);
	}

	async quarantineWorktree(identity: ChildWorktreeIdentity): Promise<ResultValue<void, FoundationError>> {
		this.quarantineCount += 1;
		if (this.quarantineFails) return Result.err(new FoundationError("subagent_close_unknown", "quarantine failed"));
		this.state = { ...identity, state: "quarantined" };
		return Result.ok(undefined);
	}

	setCurrentDigest(currentDigest: string): void {
		if (this.state.state !== "present") throw new Error("worktree is not present");
		this.state = { ...this.state, currentDigest };
	}

	setBaseDigest(baseDigest: string): void {
		if (this.state.state !== "present") throw new Error("worktree is not present");
		this.state = { ...this.state, baseDigest };
	}
}

function fixture(id: string, adapter = new FakeOwnedWorktreeAdapter(), now: () => number = () => 1_767_225_600_000) {
	const session = new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
	const laneId = "child-worktree-lane";
	const ledger = new SessionLedger(session, { ownerId: `${id}-writer`, laneId });
	const host: ChildWorktreeHost = { adapter, ledger, sessionId: id, laneId, now };
	return { session, ledger, adapter, host };
}

describe("Subagent owned worktree lifecycle", () => {
	it("keeps one exact object identity across revisions and permits child currentDigest changes", async () => {
		const { session, adapter, host } = fixture("worktree-current-change");
		const created = await createChildWorktree(host, "child-agent", "attempt-1", "refs/heads/main");
		if (!created.ok) throw created.error;
		adapter.setCurrentDigest(EDITED_DIGEST);
		const applied = await applyChildWorktree(host, created.value);
		expect(applied).toMatchObject({ ok: true, value: { apply: { status: "applied" } } });
		expect(adapter.lastApplyCurrentDigest).toBe(EDITED_DIGEST);
		const records = (await session.findFoundationRecords({ kind: "fact", objectType: "subagent.worktree_recorded", order: "oldestFirst" })).filter((record) => record.kind === "fact");
		expect(records.map((record) => record.objectId)).toEqual([records[0]?.objectId, records[0]?.objectId]);
		expect(records.map((record) => record.revision)).toEqual([1, 2]);
		expect(records[0]?.payload).not.toHaveProperty("path");
	});

	it("fails an apply conflict closed and records the durable conflict fact", async () => {
		const { adapter, host, session } = fixture("worktree-conflict");
		const created = await createChildWorktree(host, "child-agent", "attempt-1", "main");
		if (!created.ok) throw created.error;
		adapter.applyStatus = "conflict";
		const applied = await applyChildWorktree(host, created.value);
		expect(applied).toMatchObject({ ok: false, error: { code: "subagent_worktree_conflict" } });
		expect(await session.getFoundationObject("subagent.worktree_recorded", fingerprintFoundationValue({ schemaVersion: 1, childAgentInstanceId: "child-agent", attemptId: "attempt-1" }).value)).toMatchObject({
			kind: "fact",
			revision: 2,
			payload: { apply: { status: "conflict" } },
		});
		expect(adapter.quarantineCount).toBe(0);
	});

	it("verifies ownership before cleanup and supports a proved idempotent cleanup", async () => {
		const { adapter, host } = fixture("worktree-cleanup");
		const created = await createChildWorktree(host, "child-agent", "attempt-1", "main");
		if (!created.ok) throw created.error;
		adapter.setCurrentDigest(EDITED_DIGEST);
		const cleaned = await cleanupChildWorktree(host, created.value);
		expect(cleaned).toMatchObject({ ok: true, value: { cleanedUp: true } });
		if (!cleaned.ok) return;
		const resolveCount = adapter.resolveCount;
		expect(await cleanupChildWorktree(host, cleaned.value)).toEqual(cleaned);
		expect(adapter.resolveCount).toBe(resolveCount + 1);
		expect(adapter.deleteCount).toBe(1);
	});

	it("rejects record tamper and quarantines changed base ownership proof", async () => {
		const { adapter, host } = fixture("worktree-tamper");
		const created = await createChildWorktree(host, "child-agent", "attempt-1", "main");
		if (!created.ok) throw created.error;
		const tampered = await applyChildWorktree(host, { ...created.value, baseRef: "other" });
		expect(tampered).toMatchObject({ ok: false, error: { code: "subagent_worktree_conflict" } });
		expect(adapter.applyCount).toBe(0);
		adapter.setBaseDigest(`sha256:${"e".repeat(64)}`);
		const changedBase = await applyChildWorktree(host, created.value);
		expect(changedBase).toMatchObject({ ok: false, error: { code: "subagent_worktree_conflict" } });
		expect(adapter.quarantineCount).toBe(1);
	});

	it("rejects corrupt durable lane metadata before adapter mutation", async () => {
		const id = "worktree-corrupt-metadata";
		const session = new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
		const identity = { schemaVersion: 1 as const, childAgentInstanceId: "child-agent", attemptId: "attempt-1" };
		const objectId = fingerprintFoundationValue(identity).value;
		const wrongLane = new SessionLedger(session, { ownerId: "wrong-lane-writer", laneId: "wrong-lane" });
		await wrongLane.appendFact("subagent.worktree_recorded", objectId, {
			schemaVersion: 1,
			childAgentInstanceId: identity.childAgentInstanceId,
			attemptId: identity.attemptId,
			baseRef: "main",
			worktreeDigest: `sha256:${"f".repeat(64)}`,
		}, { clientRequestId: "corrupt-metadata", expectedRevision: 0, correlation: { attemptId: identity.attemptId, agentInstanceId: identity.childAgentInstanceId } });
		await wrongLane.release();
		const adapter = new FakeOwnedWorktreeAdapter();
		const host: ChildWorktreeHost = { adapter, ledger: new SessionLedger(session, { ownerId: "expected-lane-writer", laneId: "expected-lane" }), sessionId: id, laneId: "expected-lane" };
		expect(await createChildWorktree(host, identity.childAgentInstanceId, identity.attemptId, "main")).toMatchObject({ ok: false, error: { code: "subagent_worktree_conflict" } });
		expect(adapter.createCount).toBe(0);
	});

	it("quarantines partial create throws and errors, and surfaces quarantine failure", async () => {
		for (const behavior of ["throw", "error"] as const) {
			const adapter = new FakeOwnedWorktreeAdapter();
			adapter.createBehavior = behavior;
			const { host, session } = fixture(`worktree-partial-${behavior}`, adapter);
			expect(await createChildWorktree(host, "child-agent", "attempt-1", "main")).toMatchObject({ ok: false });
			expect(adapter.quarantineCount).toBe(1);
			expect(adapter.state.state).toBe("quarantined");
			expect(await session.findFoundationRecords({ kind: "fact", objectType: "subagent_worktree_quarantine" })).toHaveLength(1);
		}
		const adapter = new FakeOwnedWorktreeAdapter();
		adapter.createBehavior = "throw";
		adapter.quarantineFails = true;
		const { host } = fixture("worktree-quarantine-failure", adapter);
		expect(await createChildWorktree(host, "child-agent", "attempt-1", "main")).toMatchObject({ ok: false, error: { code: "subagent_close_unknown" } });
	});

	it("replays repeated quarantine with the original canonical timestamp", async () => {
		let clock = 1_767_225_600_000;
		const adapter = new FakeOwnedWorktreeAdapter();
		adapter.resolveBehavior = "error";
		const { host, session } = fixture("worktree-quarantine-replay", adapter, () => clock);
		expect(await createChildWorktree(host, "child-agent", "attempt-1", "main")).toMatchObject({ ok: false });
		const first = (await session.findFoundationRecords({ kind: "fact", objectType: "subagent_worktree_quarantine" })).filter((record) => record.kind === "fact");
		clock += 60_000;
		expect(await createChildWorktree(host, "child-agent", "attempt-1", "main")).toMatchObject({ ok: false });
		const replayed = (await session.findFoundationRecords({ kind: "fact", objectType: "subagent_worktree_quarantine" })).filter((record) => record.kind === "fact");
		expect(replayed).toHaveLength(1);
		expect(replayed[0]?.payload).toEqual(first[0]?.payload);
		expect(adapter.quarantineCount).toBe(2);
	});

	it("quarantines when ownership cannot be resolved after delete", async () => {
		const adapter = new FakeOwnedWorktreeAdapter();
		const { host, session } = fixture("worktree-post-delete-resolve-throw", adapter);
		const created = await createChildWorktree(host, "child-agent", "attempt-1", "main");
		if (!created.ok) throw created.error;
		adapter.throwAfterDelete = true;
		const cleaned = await cleanupChildWorktree(host, created.value);
		expect(cleaned).toMatchObject({ ok: false, error: { code: "subagent_close_unknown" } });
		expect(adapter.deleteCount).toBe(1);
		expect(adapter.quarantineCount).toBe(1);
		expect(await session.findFoundationRecords({ kind: "fact", objectType: "subagent_worktree_quarantine" })).toHaveLength(1);
	});

	it("quarantines when durable persistence fails after create", async () => {
		const id = "worktree-persistence-after-create";
		const session = new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
		const blocker = new SessionLedger(session, { ownerId: "blocking-writer", laneId: "child-worktree-lane" });
		await blocker.appendFact("blocker", "lease", { schemaVersion: 1 }, { clientRequestId: "hold-lease", expectedRevision: 0, correlation: {} });
		const adapter = new FakeOwnedWorktreeAdapter();
		const host: ChildWorktreeHost = {
			adapter,
			ledger: new SessionLedger(session, { ownerId: "worktree-writer", laneId: "child-worktree-lane" }),
			sessionId: id,
			laneId: "child-worktree-lane",
		};
		const created = await createChildWorktree(host, "child-agent", "attempt-1", "main");
		expect(created).toMatchObject({ ok: false });
		expect(adapter.quarantineCount).toBe(1);
		expect(adapter.state.state).toBe("quarantined");
		await blocker.release();
	});
});
