import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, type AgentMessage } from "@aos-agent/agent-core";
import { getModel } from "@aos-agent/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as publicApi from "../src/index.ts";
import {
	createAgentSessionForkTarget,
	getAgentCanonicalSession,
} from "../src/core/session/facade.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session/manager.ts";
import {
	createHarnessCompatibilityWriter,
	createSessionManagerStorage,
	FOUNDATION_ENTRY_CUSTOM_TYPE,
	FOUNDATION_FACT_CUSTOM_TYPE,
	FOUNDATION_LANE_CUSTOM_TYPE,
} from "../src/core/session/manager-storage.ts";

const userMessage: AgentMessage = { role: "user", content: "canonical user", timestamp: 1 };

describe("canonical Session write authority", () => {
	const temporaryDirectories: string[] = [];

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps SessionManager out of package-root and AgentSession writer surfaces", async () => {
		const directory = join(tmpdir(), `aos-session-authority-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		temporaryDirectories.push(directory);
		mkdirSync(directory, { recursive: true });
		const { session } = await publicApi.createAgentSession({
			cwd: directory,
			agentDir: directory,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			session: { mode: "memory", id: "package-root-canonical" },
		});

		expect(Object.hasOwn(publicApi, "SessionManager")).toBe(false);
		expect("sessionManager" in session).toBe(false);
		expect(session.sessionId).toBe("package-root-canonical");
		await session.dispose();
	});

	it("routes the CLI startup name through canonical Session", () => {
		const mainSource = readFileSync(join(__dirname, "../src/main.ts"), "utf8");

		expect(mainSource).not.toContain(".appendSessionInfo(");
	});

	it("routes compatibility messages, custom entries, names, and labels through canonical Session", async () => {
		const manager = SessionManager.inMemory();
		const appendMessage = vi.spyOn(manager, "appendMessage");
		const appendSessionInfo = vi.spyOn(manager, "appendSessionInfo");
		const appendLabelChange = vi.spyOn(manager, "appendLabelChange");
		const storage = createSessionManagerStorage(manager);
		const session = new Session(storage);
		const writer = createHarnessCompatibilityWriter(session, storage);

		await writer.recordMessage(userMessage);
		const userEntry = await session.findEntry({ type: "message" });
		if (userEntry === undefined) throw new Error("Expected canonical user entry");
		writer.recordCustomEntry("extension.fixture", { value: 1 });
		writer.setSessionName(" canonical name ");
		writer.setSessionLabel(userEntry.id, "bookmark");
		await session.drain();

		expect(appendMessage).not.toHaveBeenCalled();
		expect(appendSessionInfo).not.toHaveBeenCalled();
		expect(appendLabelChange).not.toHaveBeenCalled();
		expect(await session.getName()).toBe("canonical name");
		expect(await session.getLabel(userEntry.id)).toBe("bookmark");
		expect(await session.findEntry({ customType: "extension.fixture" })).toBeDefined();
		expect(manager.getPhysicalEntries().every(
			(entry) => entry.type === "custom" && (
				entry.customType === FOUNDATION_ENTRY_CUSTOM_TYPE ||
				entry.customType === FOUNDATION_FACT_CUSTOM_TYPE ||
				entry.customType === FOUNDATION_LANE_CUSTOM_TYPE
			),
		)).toBe(true);
	});

	it("persists independent main and thread lane advancement across reopen", async () => {
		const directory = join(tmpdir(), `aos-session-lanes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		temporaryDirectories.push(directory);
		mkdirSync(directory, { recursive: true });
		const manager = SessionManager.create(directory, join(directory, "sessions"));
		const storage = createSessionManagerStorage(manager);
		const root = await storage.appendEntry({ type: "message", id: "lane-root", message: userMessage }, "main");
		await storage.createLane("thread", root.id);
		const threadOne = await storage.appendEntry({ type: "custom", id: "thread-one", customType: "fixture.thread" }, "thread");
		const threadTwo = await storage.appendEntry({ type: "custom", id: "thread-two", customType: "fixture.thread" }, "thread");
		const mainOne = await storage.appendEntry({ type: "custom", id: "main-one", customType: "fixture.main" }, "main");
		const mainTwo = await storage.appendEntry({ type: "custom", id: "main-two", customType: "fixture.main" }, "main");
		manager.flushPendingSession();

		expect(threadOne.parentId).toBe(root.id);
		expect(threadTwo.parentId).toBe(threadOne.id);
		expect(mainOne.parentId).toBe(root.id);
		expect(mainTwo.parentId).toBe(mainOne.id);
		const sessionFile = manager.getSessionFile();
		if (sessionFile === undefined) throw new Error("Expected a persisted lane Session");
		const reopened = createSessionManagerStorage(SessionManager.open(sessionFile));
		expect(await reopened.getLanes()).toEqual(expect.arrayContaining([
			{ lane: "main", leafId: mainTwo.id },
			{ lane: "thread", leafId: threadTwo.id },
		]));
		expect(await reopened.getEntry(threadTwo.id)).toMatchObject({ parentId: threadOne.id });
		expect(await reopened.getEntry(mainTwo.id)).toMatchObject({ parentId: mainOne.id });
	});

	it("migrates mixed legacy and canonical physical entries deterministically as a read-only projection", async () => {
		const directory = join(tmpdir(), `aos-session-mixed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		temporaryDirectories.push(directory);
		mkdirSync(directory, { recursive: true });
		const sessionPath = join(directory, "mixed.jsonl");
		const physical = [
			{ type: "session", version: 3, id: "mixed-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: directory },
			{ type: "message", id: "legacy-user", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: userMessage },
			{
				type: "custom",
				id: "wrapper-id",
				parentId: "legacy-user",
				timestamp: "2026-01-01T00:00:02.000Z",
				customType: FOUNDATION_ENTRY_CUSTOM_TYPE,
				data: {
					schemaVersion: 1,
					kind: "entry",
					entry: {
						type: "custom",
						id: "canonical-custom",
						seq: 2,
						parentId: "legacy-user",
						timestamp: 2,
						customType: "fixture.canonical",
						data: { value: 2 },
					},
				},
			},
		];
		writeFileSync(sessionPath, `${physical.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
		const manager = SessionManager.open(sessionPath);
		const first = new Session(createSessionManagerStorage(manager));
		const firstProjection = await first.findEntries({ order: "oldestFirst" });
		const replay = new Session(createSessionManagerStorage(manager));

		expect(await replay.findEntries({ order: "oldestFirst" })).toEqual(firstProjection);
		expect(firstProjection.map((entry) => entry.id)).toEqual(["legacy-user", "canonical-custom"]);
		expect(firstProjection[1]?.parentId).toBe("legacy-user");
		expect(manager.getPhysicalEntries()).toEqual(physical.slice(1));
		await replay.appendCustomEntry("fixture.new", { value: 3 });
		await replay.drain();
		const lastPhysicalEntries = manager.getPhysicalEntries().slice(-2);
		expect(lastPhysicalEntries[0]).toMatchObject({ type: "custom", customType: FOUNDATION_ENTRY_CUSTOM_TYPE });
		expect(lastPhysicalEntries[1]).toMatchObject({ type: "custom", customType: FOUNDATION_LANE_CUSTOM_TYPE });
	});

	for (const persisted of [false, true]) {
		it(`forks and exports ${persisted ? "persisted" : "in-memory"} canonical entries without wrapper ids`, async () => {
			const directory = join(tmpdir(), `aos-session-fork-${persisted}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			temporaryDirectories.push(directory);
			mkdirSync(directory, { recursive: true });
			const manager = persisted
				? SessionManager.create(directory, join(directory, "sessions"))
				: SessionManager.inMemory(directory);
			const { session } = await createAgentSession({
				cwd: directory,
				agentDir: directory,
				model: getModel("anthropic", "claude-sonnet-4-5"),
				sessionManager: manager,
			});
			const source = getAgentCanonicalSession(session);
			const userId = await source.appendMessage(userMessage);
			await source.setName("fork fixture");
			await source.setLabel(userId, "fork point");
			manager.flushPendingSession();
			const sourceWrapperIds = manager.getPhysicalEntries().map((entry) => entry.id);
			const sourceEntryIds = (await source.findEntries({ order: "oldestFirst" })).map((entry) => entry.id);
			const forked = await createAgentSessionForkTarget(session, userId, "at");
			const forkedCanonical = forked.session;
			const forkedEntries = await forkedCanonical.findEntries({ order: "oldestFirst" });
			expect(forkedEntries.map((entry) => entry.id)).toEqual(sourceEntryIds);
			expect(forkedEntries.map((entry) => entry.id).some((id) => sourceWrapperIds.includes(id))).toBe(false);
			expect(await forkedCanonical.getName()).toBe("fork fixture");
			expect(await forkedCanonical.getLabel(userId)).toBe("fork point");

			const exportPath = join(directory, `${persisted ? "persisted" : "memory"}-export.jsonl`);
			await session.exportToJsonl(exportPath);
			const exported = readFileSync(exportPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(exported[0]).toMatchObject({ type: "session", id: manager.getSessionId() });
			expect(exported.some((entry) => entry.id === userId)).toBe(true);
			expect(exported.some((entry) => sourceWrapperIds.includes(String(entry.id)))).toBe(false);
			expect(exported.some((entry) => String(entry.customType).startsWith("__aos.foundation."))).toBe(false);
			await session.dispose();
		});
	}
});
