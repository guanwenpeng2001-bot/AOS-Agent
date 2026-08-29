import { describe, expect, it } from "vitest";
import {
	InMemoryArtifactBlobStore,
	InMemorySessionStorage,
	MemoryError,
	ScopedMemoryStore,
	Session,
	ContextLedger,
	createScopedMemoryStore,
} from "@aos-agent/agent-core";
import {
	cleanupChildMemoryScope,
	createChildMemoryScope,
} from "../src/core/subagent-memory.ts";

function memoryFixture(id: string) {
	const session = new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
	const ledger = new ContextLedger(session, {
		ownerId: `${id}-writer`,
		memoryScopeId: "parent-scope",
		memoryOwnerId: "parent-agent",
		artifactBlobStore: new InMemoryArtifactBlobStore(),
	});
	const parent = createScopedMemoryStore(
		ledger.memory,
		"session",
		{ ownerId: "parent-agent", scopeId: "parent-scope", createdBy: "system" },
		{ ownerId: "parent-agent", scopeId: "parent-scope" },
	);
	return { ledger, parent };
}

describe("Subagent child memory scope", () => {
	it("forks an isolated real child scope and cleans only that exact lineage", async () => {
		const { ledger, parent } = memoryFixture("subagent-memory-isolation");
		const parentEntry = await parent.put({
			id: "parent-entry",
			kind: "fact",
			trust: "user_owned",
			content: "parent content",
			source: "parent source",
			principal: "system",
		});
		const child = createChildMemoryScope(parent, "child-agent", "parent-agent");
		expect(child.parentId).toBe(parent.scopeId);
		const childEntry = await child.put({
			id: "child-entry",
			kind: "fact",
			trust: "user_owned",
			content: "child content",
			source: "child source",
			principal: "system",
		});

		expect(await child.get(parentEntry.id, "system")).toBeUndefined();
		expect(await parent.get(childEntry.id, "system")).toBeUndefined();
		expect((await child.get(childEntry.id, "system"))?.content).toBe("child content");

		const cleaned = await cleanupChildMemoryScope(child);
		expect(cleaned).toEqual({ ok: true, value: 1 });
		expect(await child.list({}, "system")).toEqual([]);
		expect((await parent.get(parentEntry.id, "system"))?.content).toBe("parent content");
		await ledger.writer.releaseLease();
	});

	it("rejects parent owner mismatch and scope collisions", () => {
		const { parent } = memoryFixture("subagent-memory-collision");
		expect(() => createChildMemoryScope(parent, "child-agent", "wrong-parent")).toThrow(MemoryError);
		expect(() => createChildMemoryScope(parent, "child-agent", "parent-agent", { scopeId: "other-scope" })).toThrow(MemoryError);
	});

	it("fails closed when post-delete verification still sees an entry", async () => {
		const { ledger } = memoryFixture("subagent-memory-post-delete");
		class NonDeletingChildStore extends ScopedMemoryStore {
			override async delete(): Promise<boolean> {
				return true;
			}
		}
		const child = new NonDeletingChildStore(
			ledger.memory,
			"child",
			{ ownerId: "child-agent", scopeId: "child:child-agent", parentId: "parent-scope", createdBy: "system" },
			{ ownerId: "child-agent", scopeId: "child:child-agent", parentId: "parent-scope" },
		);
		await child.put({
			id: "undeleted-entry",
			kind: "fact",
			trust: "user_owned",
			content: "retained",
			source: "retained source",
			principal: "system",
		});

		const cleaned = await cleanupChildMemoryScope(child);
		expect(cleaned).toMatchObject({ ok: false, error: { code: "subagent_close_unknown" } });
		expect(await child.list({}, "system")).toHaveLength(1);
		await ledger.writer.releaseLease();
	});
});
