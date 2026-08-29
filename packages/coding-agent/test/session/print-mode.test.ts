import type { AssistantMessage, ImageContent } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionShutdownEvent } from "../../src/index.ts";
import type { PreparedSessionScopeRebind } from "../../src/core/session/current-scope.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionRead: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	prepareExtensionBindings: ReturnType<typeof vi.fn>;
	activateExtensionBindings: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setPrepareSessionRebind: ReturnType<typeof vi.fn>;
	prepareSessionRebind?: (
		nextSession: FakeSession,
		previousSession: FakeSession,
	) => Promise<PreparedSessionScopeRebind>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionRead: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		prepareExtensionBindings: vi.fn(async () => {}),
		activateExtensionBindings: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	const runtimeHost: FakeRuntimeHost = {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setPrepareSessionRebind: vi.fn((prepareSessionRebind) => {
			runtimeHost.prepareSessionRebind = prepareSessionRebind;
		}),
	};
	return runtimeHost;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("keeps the old print binding usable when candidate host preparation fails", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const oldSession = runtimeHost.session;
		const candidateSession: FakeSession = {
			...oldSession,
			prepareExtensionBindings: vi.fn(async () => {
				throw new Error("candidate binding fault");
			}),
			activateExtensionBindings: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
			prompt: vi.fn(async () => {}),
		};
		oldSession.prompt.mockImplementationOnce(async () => {
			await expect(runtimeHost.prepareSessionRebind?.(candidateSession, oldSession)).rejects.toThrow(
				"candidate binding fault",
			);
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			messages: ["trigger fault", "old binding still works"],
		});

		expect(exitCode).toBe(0);
		expect(oldSession.prompt).toHaveBeenNthCalledWith(2, "old binding still works");
		expect(candidateSession.subscribe).not.toHaveBeenCalled();
	});

	it("resolves print input through the runtime pointer after a prepared rebind", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const oldSession = runtimeHost.session;
		const candidateSession: FakeSession = {
			...oldSession,
			prepareExtensionBindings: vi.fn(async () => {}),
			activateExtensionBindings: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
			prompt: vi.fn(async () => {}),
		};
		oldSession.prompt.mockImplementationOnce(async () => {
			const prepared = await runtimeHost.prepareSessionRebind!(candidateSession, oldSession);
			expect(candidateSession.prepareExtensionBindings).toHaveBeenCalledTimes(1);
			expect(candidateSession.subscribe).toHaveBeenCalledTimes(1);
			expect(candidateSession.activateExtensionBindings).not.toHaveBeenCalled();
			expect(() => prepared.commit()).not.toThrow();
			expect(candidateSession.prepareExtensionBindings).toHaveBeenCalledTimes(1);
			expect(candidateSession.subscribe).toHaveBeenCalledTimes(1);
			expect(candidateSession.activateExtensionBindings).not.toHaveBeenCalled();
			runtimeHost.session = candidateSession;
			await prepared.activate?.();
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			messages: ["prepare and commit", "candidate is current"],
		});

		expect(exitCode).toBe(0);
		expect(oldSession.prompt).toHaveBeenCalledTimes(1);
		expect(candidateSession.prompt).toHaveBeenCalledWith("candidate is current");
	});
});
