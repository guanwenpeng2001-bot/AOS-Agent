import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { CapabilityBinding } from "../src/core/capability-registry.ts";
import type { SessionEntry, SessionTreeNode } from "../src/core/session-manager.ts";
import {
	serializePublicContextDrift,
	serializePublicContextSnapshot,
	serializePublicRunReceipt,
	serializePublicRunStreamEvent,
	serializePublicSessionEntry,
	serializePublicSessionEvent,
	serializePublicSessionTreeNode,
} from "../src/core/run-lifecycle.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

const PATH_MARKER_WIN = "C:\\audit-private\\capability-source";
const PATH_MARKER_POSIX = "/audit-private/capability-source";
const URL_MARKER = "https://audit-user:audit-secret@host.invalid/pkg?token=audit-query-secret#fragment";
const OPAQUE_BINDING_ID = `binding:${"b".repeat(43)}`;
const OPAQUE_SOURCE_ID = `source:${"s".repeat(43)}`;
const OPAQUE_REVISION_ID = `rev:${"r".repeat(43)}`;

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

function expectNoMarkers(value: unknown): void {
	const json = JSON.stringify(value);
	expect(json).not.toContain(PATH_MARKER_WIN);
	expect(json).not.toContain(PATH_MARKER_POSIX);
	expect(json).not.toContain("audit-user");
	expect(json).not.toContain("audit-secret");
	expect(json).not.toContain("audit-query-secret");
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function startPublicBoundaryHarness(): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => void;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	const legacyBindingEntry: SessionEntry = {
		type: "custom",
		id: "binding-entry",
		parentId: null,
		timestamp: "2026-08-12T00:00:00.000Z",
		customType: "capability.binding",
		data: {
			schemaVersion: 1,
			binding: {
				id: `binding:${PATH_MARKER_WIN}:legacy`,
				profile: "default",
				createdAt: "2026-08-12T00:00:00.000Z",
				descriptors: [{ id: `skill:${PATH_MARKER_POSIX}:audit`, revision: "rev:legacy" }],
				decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
				toolAllowlist: [],
			},
		},
	};
	const privateEntry: SessionEntry = {
		type: "custom",
		id: "private-entry",
		parentId: legacyBindingEntry.id,
		timestamp: "2026-08-12T00:00:01.000Z",
		customType: "extension.private",
		data: { path: PATH_MARKER_POSIX, url: URL_MARKER },
	};
	const tree: SessionTreeNode[] = [{ entry: legacyBindingEntry, children: [{ entry: privateEntry, children: [] }] }];
	const currentBinding: CapabilityBinding = {
		id: OPAQUE_BINDING_ID,
		profile: "default",
		createdAt: "2026-08-12T00:00:00.000Z",
		descriptors: [{ id: `skill:${OPAQUE_SOURCE_ID}:audit`, revision: OPAQUE_REVISION_ID }],
		decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
		toolAllowlist: [],
	};
	const session = {
		agent: { subscribe: () => () => {} },
		sessionId: "session-1",
		sessionFile: PATH_MARKER_WIN,
		model: undefined,
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionName: undefined,
		autoCompactionEnabled: false,
		messages: [],
		pendingMessageCount: 0,
		getSessionStats: () => ({
			sessionFile: PATH_MARKER_WIN,
			sessionId: "session-1",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		}),
		bindExtensions: async () => {},
		subscribe: () => () => {},
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => PATH_MARKER_WIN,
			appendCustomEntry: () => "not-written",
			getEntries: () => [legacyBindingEntry, privateEntry],
			getLeafId: () => privateEntry.id,
			getTree: () => tree,
		},
		inspectContext: async () => ({
			snapshot: {
				schemaVersion: 1,
				id: "snapshot-1",
				purpose: "agent_turn",
				sessionId: "session-1",
				createdAt: "2026-08-12T00:00:02.000Z",
				sources: [
					{
						sourceId: PATH_MARKER_POSIX,
						kind: "extension",
						scope: "global",
						trust: "user_owned",
						label: PATH_MARKER_WIN,
						visibility: "model_and_snapshot",
						path: PATH_MARKER_WIN,
						contentDigest: "digest",
						estimatedTokens: 1,
						disposition: "included",
						refId: URL_MARKER,
						capabilityId: `skill:${PATH_MARKER_WIN}:audit`,
						capabilityRevision: "rev:legacy",
						capabilityBindingId: `binding:${PATH_MARKER_POSIX}`,
					},
				],
				budget: { contextWindow: 100, reserveTokens: 10, inputLimit: 90, estimatedInputTokens: 1 },
			},
			drift: [
				{
					sourceId: PATH_MARKER_POSIX,
					status: "source_changed",
					path: PATH_MARKER_WIN,
				},
			],
			preview: false,
		}),
		getActiveCapabilityBinding: () => currentBinding,
		extensionRunner: {
			getRegisteredCommands: () => [
				{
					invocationName: "private-extension",
					description: "private extension",
					sourceInfo: {
						path: PATH_MARKER_WIN,
						source: URL_MARKER,
						scope: "user",
						origin: "package",
						baseDir: PATH_MARKER_POSIX,
					},
				},
			],
		},
		promptTemplates: [
			{
				name: "private-prompt",
				description: "private prompt",
				sourceInfo: {
					path: PATH_MARKER_WIN,
					source: URL_MARKER,
					scope: "user",
					origin: "package",
				},
			},
		],
		resourceLoader: {
			getSkills: () => ({
				skills: [
					{
						name: "private-skill",
						description: "private skill",
						sourceInfo: {
							path: PATH_MARKER_WIN,
							source: URL_MARKER,
							scope: "user",
							origin: "package",
						},
					},
				],
				diagnostics: [],
			}),
		},
	};
	const runtimeHost = {
		session,
		setRebindSession: () => {},
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	const signalNames: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const signalListenersBefore = new Map(signalNames.map((signal) => [signal, new Set(process.listeners(signal))]));
	const stdinEndListenersBefore = new Set(process.stdin.listeners("end"));
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	return {
		lineHandler: rpcIo.lineHandler!,
		cleanup: () => {
			for (const [signal, listenersBefore] of signalListenersBefore) {
				for (const listener of process.listeners(signal)) {
					if (!listenersBefore.has(listener)) process.off(signal, listener as (...args: unknown[]) => void);
				}
			}
			for (const listener of process.stdin.listeners("end")) {
				if (!stdinEndListenersBefore.has(listener)) process.stdin.off("end", listener as (...args: unknown[]) => void);
			}
		},
	};
}

describe("RPC capability public boundary", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});
	it("serializes legacy ledger entries, session tree, and terminal JSONL without raw source markers", () => {
		const legacyBindingEntry: SessionEntry = {
			type: "custom",
			id: "binding-entry",
			parentId: null,
			timestamp: "2026-08-12T00:00:00.000Z",
			customType: "capability.binding",
			data: {
				schemaVersion: 1,
				binding: {
					id: `binding:${PATH_MARKER_WIN}:legacy`,
					profile: "default",
					createdAt: "2026-08-12T00:00:00.000Z",
					descriptors: [{ id: `skill:${PATH_MARKER_POSIX}:audit`, revision: "rev:legacy" }],
					decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
					toolAllowlist: [],
				},
			},
		};
		const privateEntry: SessionEntry = {
			type: "custom",
			id: "private-entry",
			parentId: "binding-entry",
			timestamp: "2026-08-12T00:00:01.000Z",
			customType: "extension.private",
			data: { path: PATH_MARKER_POSIX, url: URL_MARKER },
		};
		const tree: SessionTreeNode = {
			entry: legacyBindingEntry,
			children: [{ entry: privateEntry, children: [] }],
		};
		const terminal = serializePublicRunStreamEvent({
			type: "run.failed",
			runId: "run-1",
			sessionId: "session-1",
			sequence: 2,
			timestamp: "2026-08-12T00:00:02.000Z",
			receipt: {
				runId: "run-1",
				sessionId: "session-1",
				status: "failed",
				usage: { input: 1, output: 2, total: 3 },
				sessionFile: PATH_MARKER_WIN,
				capabilityBindingId: `binding:${PATH_MARKER_POSIX}`,
				terminalError: { code: "model_error", message: `${PATH_MARKER_POSIX} ${URL_MARKER}`, retryable: false },
			},
		});
		const runEvent = serializePublicRunStreamEvent({
			type: "run.event",
			runId: "run-1",
			sessionId: "session-1",
			sequence: 1,
			timestamp: "2026-08-12T00:00:01.000Z",
			event: { type: "entry_appended", entry: privateEntry },
		});
		const sessionErrorEvent = serializePublicSessionEvent({
			type: "agent_end",
			willRetry: false,
			messages: [
				{
					role: "assistant",
					content: [],
					api: "openai-completions",
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					timestamp: 0,
					errorMessage: `${PATH_MARKER_POSIX} ${URL_MARKER}`,
				},
			],
		});

		const publicEntries = [legacyBindingEntry, privateEntry].map((entry) => serializePublicSessionEntry(entry));
		const publicTree = serializePublicSessionTreeNode(tree);
		expectNoMarkers({ publicEntries, publicTree, terminal, runEvent, sessionErrorEvent });
		expect(publicEntries[0]).toMatchObject({ type: "custom", customType: "capability.binding" });
		expect(publicEntries[1]).toMatchObject({ type: "custom", customType: "extension.private" });
		if (publicEntries[0].type === "custom") expect(publicEntries[0].data).toBeUndefined();
		if (publicEntries[1].type === "custom") expect(publicEntries[1].data).toBeUndefined();
		if (!("receipt" in terminal)) throw new Error("expected terminal event");
		expect("sessionFile" in terminal.receipt).toBe(false);
		expect(terminal.receipt.capabilityBindingId).toBeUndefined();
		expect(terminal.receipt.terminalError?.message).toBe("Run failed.");
		if (runEvent.type !== "run.event" || runEvent.event.type !== "entry_appended") {
			throw new Error("expected serialized run.event entry");
		}
		if (runEvent.event.entry.type !== "custom") throw new Error("expected custom entry");
		expect(runEvent.event.entry.data).toBeUndefined();
		if (sessionErrorEvent.type !== "agent_end") throw new Error("expected public agent_end");
		const publicErrorMessage = sessionErrorEvent.messages[0];
		if (publicErrorMessage?.role !== "assistant") throw new Error("expected public assistant error");
		expect(publicErrorMessage.errorMessage).toBe("Agent run failed.");
	});

	it("keeps current opaque receipt identities while omitting the session path", () => {
		const receipt = serializePublicRunReceipt({
			runId: "run-2",
			sessionId: "session-2",
			status: "completed",
			usage: { input: 1, output: 1, total: 2 },
			sessionFile: PATH_MARKER_WIN,
			capabilityBindingId: OPAQUE_BINDING_ID,
		});
		expect(receipt.capabilityBindingId).toBe(OPAQUE_BINDING_ID);
		expect("sessionFile" in receipt).toBe(false);
		expectNoMarkers(receipt);
	});

	it("uses the shared Context serializer to omit every raw source reference", () => {
		const snapshot = serializePublicContextSnapshot({
			schemaVersion: 1,
			id: "snapshot-1",
			purpose: "agent_turn",
			sessionId: "session-1",
			createdAt: "2026-08-12T00:00:00.000Z",
			sources: [
				{
					sourceId: PATH_MARKER_POSIX,
					kind: "extension",
					scope: "turn",
					trust: "user_owned",
					label: PATH_MARKER_WIN,
					visibility: "model_and_snapshot",
					path: PATH_MARKER_WIN,
					contentDigest: "digest",
					estimatedTokens: 1,
					disposition: "included",
					refId: URL_MARKER,
					capabilityId: `skill:${OPAQUE_SOURCE_ID}:audit`,
					capabilityRevision: OPAQUE_REVISION_ID,
					capabilityBindingId: OPAQUE_BINDING_ID,
				},
			],
			budget: { contextWindow: 100, reserveTokens: 10, inputLimit: 90, estimatedInputTokens: 1 },
		});
		const drift = serializePublicContextDrift({
			sourceId: PATH_MARKER_POSIX,
			status: "source_changed",
			path: PATH_MARKER_WIN,
		});

		expectNoMarkers({ snapshot, drift });
		const source = snapshot.sources[0];
		expect(source).toBeDefined();
		expect("sourceId" in source!).toBe(false);
		expect("path" in source!).toBe(false);
		expect("label" in source!).toBe(false);
		expect("refId" in source!).toBe(false);
		expect(source?.capabilityId).toBe(`skill:${OPAQUE_SOURCE_ID}:audit`);
		expect(source?.capabilityRevision).toBe(OPAQUE_REVISION_ID);
		expect(source?.capabilityBindingId).toBe(OPAQUE_BINDING_ID);
		expect("sourceId" in drift).toBe(false);
		expect("path" in drift).toBe(false);
	});

	it("does not leak raw capability sources through actual RPC JSONL read commands", async () => {
		const { lineHandler, cleanup } = await startPublicBoundaryHarness();
		try {
			for (const command of [
				{ id: "entries", type: "get_entries" },
				{ id: "tree", type: "get_tree" },
				{ id: "context", type: "get_context" },
				{ id: "commands", type: "get_commands" },
				{ id: "capabilities", type: "get_capabilities" },
				{ id: "initialize", type: "initialize", protocolVersion: 1 },
				{ id: "state", type: "get_state" },
				{ id: "stats", type: "get_session_stats" },
				{ id: "missing", type: "get_capabilities", bindingId: PATH_MARKER_POSIX },
			]) {
				lineHandler(JSON.stringify(command));
				await vi.waitFor(() =>
					expect(parseOutputLines().some((line) => line.id === command.id && line.type === "response")).toBe(true),
				);
			}

			const lines = parseOutputLines();
			expectNoMarkers(lines);
			const responseFor = (id: string) => lines.find((line) => line.id === id) as { data: Record<string, unknown> };
			const entries = responseFor("entries").data.entries as Array<Record<string, unknown>>;
			expect(entries.every((entry) => entry.data === undefined)).toBe(true);
			const context = responseFor("context").data;
			const source = (context.snapshot as { sources: Array<Record<string, unknown>> }).sources[0];
			expect(source.path).toBeUndefined();
			expect(source.sourceId).toBeUndefined();
			expect(source.label).toBeUndefined();
			expect(source.refId).toBeUndefined();
			expect(source.capabilityId).toBeUndefined();
			const drift = context.drift as Array<Record<string, unknown>>;
			expect(drift[0]?.sourceId).toBeUndefined();
			const commands = responseFor("commands").data.commands as Array<{ sourceInfo: Record<string, unknown> }>;
			expect(commands.every((command) => Object.keys(command.sourceInfo).sort().join(",") === "origin,scope")).toBe(true);
			const capabilities = responseFor("capabilities").data;
			expect((capabilities.binding as { id?: string } | null)?.id).toBe(OPAQUE_BINDING_ID);
			expect(capabilities.bindings).toEqual([]);
			expect(responseFor("initialize").data.sessionFile).toBeUndefined();
			expect(responseFor("state").data.sessionFile).toBeUndefined();
			expect(responseFor("stats").data.sessionFile).toBeUndefined();
			expect((lines.find((line) => line.id === "missing") as { error?: string }).error).toBe(
				"Capability binding not found.",
			);
		} finally {
			cleanup();
		}
	});
});
