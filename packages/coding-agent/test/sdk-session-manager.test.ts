import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getModel } from "@aos-agent/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session/manager.ts";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `aos-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionRead.getSessionDir();
		const sessionFile = session.sessionRead.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile).toBeDefined();
		expect(dirname(sessionFile!)).toBe(expectedSessionDir);

		session.dispose();
		await session.waitForDispose();
	});

	it("supports an explicit in-memory session", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			session: { mode: "memory", id: "sdk-memory-session" },
		});

		expect(session.sessionId).toBe("sdk-memory-session");
		expect(session.sessionRead.isPersisted()).toBe(false);

		session.dispose();
		await session.waitForDispose();
	});

	it("derives cwd from an explicitly opened session when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.create(sessionCwd, join(tempDir, "sessions"));
		sessionManager.flushPendingSession();
		const sessionPath = sessionManager.getSessionFile();
		if (sessionPath === undefined) throw new Error("Expected a persisted fixture session");
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			session: { mode: "open", path: sessionPath },
		});

		expect(session.sessionFile).toBe(sessionPath);
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: 'node -p "process.cwd()"' });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");
		const shellPath =
			process.platform === "win32"
				? output.trim().replace(/^\/tmp(?=\/|$)/, tmpdir().replace(/\\/g, "/"))
				: output.trim();
		expect(realpathSync(shellPath)).toBe(realpathSync(sessionCwd));

		session.dispose();
		await session.waitForDispose();
	});

	it("exposes current session state to the built-in bash tool", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			thinkingLevel: "high",
		});
		expect(session.sessionFile).toBeTruthy();
		expect(session.systemPrompt).toContain(
			"You can inspect AOS_AGENT_* environment variables for current model and session details.",
		);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", {
			command: `printf '%s\\n' "$AOS_AGENT_SESSION_ID" "$AOS_AGENT_SESSION_FILE" "$AOS_AGENT_PROVIDER" "$AOS_AGENT_MODEL" "$AOS_AGENT_REASONING_LEVEL"`,
		});
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(output.trim().split("\n")).toEqual([
			session.sessionId,
			session.sessionFile,
			model!.provider,
			model!.id,
			session.thinkingLevel,
		]);

		session.dispose();
		await session.waitForDispose();
	});
});
