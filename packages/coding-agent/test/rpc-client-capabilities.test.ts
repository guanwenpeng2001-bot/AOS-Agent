import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const PATH_MARKER_WIN = "C:\\audit-private\\capability-source";
const PATH_MARKER_POSIX = "/audit-private/capability-source";
const URL_MARKER = "https://audit-user:audit-secret@host.invalid/pkg?token=audit-query-secret#fragment";
const OPAQUE_BINDING_ID = `binding:${"b".repeat(43)}`;
const OPAQUE_SOURCE_ID = `source:${"s".repeat(43)}`;
const OPAQUE_REVISION_ID = `rev:${"r".repeat(43)}`;

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
};

function expectNoMarkers(value: unknown): void {
	const json = JSON.stringify(value);
	expect(json).not.toContain(PATH_MARKER_WIN);
	expect(json).not.toContain(PATH_MARKER_POSIX);
	expect(json).not.toContain(URL_MARKER);
	expect(json).not.toContain("audit-user");
	expect(json).not.toContain("audit-secret");
	expect(json).not.toContain("audit-query-secret");
}

describe("RpcClient capability public boundary", () => {
	it("returns only public-safe RPC objects for capability, context, session, and host reads", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async (command: { type: string }) => {
			switch (command.type) {
				case "get_state":
					return {
						type: "response",
						command: "get_state",
						success: true,
						data: {
							thinkingLevel: "off",
							isStreaming: false,
							isCompacting: false,
							steeringMode: "all",
							followUpMode: "all",
							sessionId: "session-1",
							autoCompactionEnabled: false,
							messageCount: 0,
							pendingMessageCount: 0,
						},
					};
				case "get_session_stats":
					return {
						type: "response",
						command: "get_session_stats",
						success: true,
						data: {
							sessionId: "session-1",
							userMessages: 0,
							assistantMessages: 0,
							toolCalls: 0,
							toolResults: 0,
							totalMessages: 0,
							tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							cost: 0,
						},
					};
				case "get_entries":
					return {
						type: "response",
						command: "get_entries",
						success: true,
						data: {
							entries: [
								{
									type: "custom",
									id: "entry-1",
									parentId: null,
									timestamp: "2026-08-12T00:00:00.000Z",
									customType: "capability.binding",
								},
							],
							leafId: "entry-1",
						},
					};
				case "get_tree":
					return {
						type: "response",
						command: "get_tree",
						success: true,
						data: {
							tree: [
								{
									entry: {
										type: "custom",
										id: "entry-1",
										parentId: null,
										timestamp: "2026-08-12T00:00:00.000Z",
										customType: "capability.binding",
									},
									children: [],
								},
							],
							leafId: "entry-1",
						},
					};
				case "get_context":
					return {
						type: "response",
						command: "get_context",
						success: true,
						data: {
							snapshot: {
								schemaVersion: 1,
								id: "snapshot-1",
								purpose: "agent_turn",
								sessionId: "session-1",
								createdAt: "2026-08-12T00:00:00.000Z",
								sources: [
									{
										kind: "extension",
										scope: "global",
										trust: "user_owned",
										contentDigest: "digest",
										estimatedTokens: 1,
										disposition: "included",
									},
								],
								budget: { contextWindow: 100, reserveTokens: 10, inputLimit: 90, estimatedInputTokens: 1 },
							},
							drift: [{ status: "source_changed" }],
							preview: false,
						},
					};
				case "get_commands":
					return {
						type: "response",
						command: "get_commands",
						success: true,
						data: { commands: [{ name: "private", source: "skill", sourceInfo: { scope: "user", origin: "package" } }] },
					};
				case "get_capabilities":
					return {
						type: "response",
						command: "get_capabilities",
						success: true,
						data: {
							binding: {
								id: OPAQUE_BINDING_ID,
								profile: "default",
								createdAt: "2026-08-12T00:00:00.000Z",
								descriptors: [{ id: `skill:${OPAQUE_SOURCE_ID}:audit`, revision: OPAQUE_REVISION_ID }],
								decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
								toolAllowlist: [],
							},
							bindings: [],
						},
					};
				case "initialize":
					return {
						type: "response",
						command: "initialize",
						success: true,
						data: {
							host: "automation-host",
							protocolVersion: 1,
							sessionId: "session-1",
							runCommands: ["run.start", "run.get", "run.cancel", "run.resume"],
						},
					};
				default:
					throw new Error(`unexpected command ${command.type}`);
			}
		});
		privateClient.send = send;

		const [state, stats, entries, tree, context, commands, capabilities, initialized] = await Promise.all([
			client.getState(),
			client.getSessionStats(),
			client.getEntries(),
			client.getTree(),
			client.getContext(),
			client.getCommands(),
			client.getCapabilities(),
			client.initializeAutomationHost(),
		]);

		expectNoMarkers({ state, stats, entries, tree, context, commands, capabilities, initialized });
		expect("sessionFile" in state).toBe(false);
		expect("sessionFile" in stats).toBe(false);
		expect("sessionFile" in initialized).toBe(false);
		expect(entries.entries[0]).toMatchObject({ customType: "capability.binding" });
		expect(tree.tree[0]?.entry).toMatchObject({ customType: "capability.binding" });
		expect("path" in (context.snapshot.sources[0] ?? {})).toBe(false);
		expect(commands[0]?.sourceInfo).toEqual({ scope: "user", origin: "package" });
		expect(capabilities.binding?.id).toBe(OPAQUE_BINDING_ID);
		expect(send).toHaveBeenCalledWith({ type: "get_capabilities" });
	});

});
