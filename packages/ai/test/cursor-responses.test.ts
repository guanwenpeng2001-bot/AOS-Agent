import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createCursorCli,
	cursorCliApiKey,
	cursorCliError,
	cursorProvider,
	normalizeCursorModels,
	parseCursorExecutionOutput,
	parseCursorModelList,
	parseCursorStatusJson,
	resolveCursorInvocation,
	runCursorCli,
	runCursorCliCapture,
	type CursorSpawn,
} from "../src/providers/cursor.ts";

function fakeChild(): ChildProcess {
	return new EventEmitter() as ChildProcess;
}

const SAMPLE_MODELS = `Available models

auto - Auto (default)
gpt-5.2 - GPT-5.2
composer-2.5 - Composer 2.5

Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.
`;

const FAKE_CURSOR_AGENT_PATH = fileURLToPath(new URL("./fixtures/fake-cursor-agent.mjs", import.meta.url));

function fixtureSpawn(state: string): CursorSpawn {
	return (_command, args, options) => {
		const commandIndex = args.findIndex((arg) =>
			["status", "login", "logout", "models"].includes(arg),
		);
		const fixtureArgs = commandIndex === -1 ? [...args] : args.slice(commandIndex);
		return spawn(process.execPath, [FAKE_CURSOR_AGENT_PATH, ...fixtureArgs], {
			...options,
			shell: false,
			env: { ...process.env, ...options.env, FAKE_CURSOR_AGENT_STATE: state },
		});
	};
}

describe("Cursor dynamic model catalog", () => {
	it("parses the documented line-oriented models output", () => {
		expect(parseCursorModelList(SAMPLE_MODELS)).toEqual([
			{ id: "auto", name: "Auto (default)" },
			{ id: "gpt-5.2", name: "GPT-5.2" },
			{ id: "composer-2.5", name: "Composer 2.5" },
		]);
	});

	it("rejects control characters and unknown shapes", () => {
		expect(() => parseCursorModelList("Available models\n\x1b[31mfoo - bar\nTip: --model <id>")).toThrow(
			/invalid model catalog/i,
		);
		expect(() => parseCursorModelList("not a catalog")).toThrow(/unsupported/i);
	});

	it("distinguishes an empty supported catalog from an unsupported shape", () => {
		expect(() =>
			parseCursorModelList("Available models\n\nTip: use --model <id> to switch.\n"),
		).toThrow(/returned no models/i);
	});

	it("normalizes references into Model entries", () => {
		const models = normalizeCursorModels(parseCursorModelList(SAMPLE_MODELS));
		expect(models).toHaveLength(3);
		expect(models[0]).toMatchObject({
			id: "auto",
			provider: "cursor",
			api: "cursor-cli",
			baseUrl: "cursor-cli://local",
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
	});
});

describe("Cursor status and stream-json parsing", () => {
	it("parses status --format json", () => {
		const status = parseCursorStatusJson(
			JSON.stringify({
				status: "authenticated",
				isAuthenticated: true,
				hasAccessToken: true,
				hasRefreshToken: true,
				userInfo: { email: "a@b.com", userId: 1 },
			}),
		);
		expect(status.isAuthenticated).toBe(true);
		expect(status.userInfo?.email).toBe("a@b.com");
	});

	it("parses stream-json execution output including thinking events", () => {
		const stdout = [
			JSON.stringify({ type: "system", model: "gpt-5.2" }),
			JSON.stringify({ type: "thinking", subtype: "delta", text: "..." }),
			JSON.stringify({ type: "thinking", subtype: "completed" }),
			JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
			JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Hello" }),
		].join("\n");
		expect(parseCursorExecutionOutput(stdout)).toEqual({ text: "Hello", responseModel: "gpt-5.2" });
	});

	it("rejects unsuccessful or incomplete streams", () => {
		expect(() =>
			parseCursorExecutionOutput(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "x" })),
		).toThrow(/unsuccessful/i);
		expect(() => parseCursorExecutionOutput(JSON.stringify({ type: "system", model: "m" }))).toThrow(
			/without a result/i,
		);
	});
});

describe("Cursor CLI adapter", () => {
	it("chooses the newest complete Windows version directory and falls back to the root layout", () => {
		const originalLocalAppData = process.env.LOCALAPPDATA;
		const localAppData = mkdtempSync(join(tmpdir(), "cursor-cli-layout-"));
		try {
			process.env.LOCALAPPDATA = localAppData;
			const versions = join(localAppData, "cursor-agent", "versions");
			for (const version of ["2026.9.1-old", "2026.10.1-new"]) {
				const versionDir = join(versions, version);
				mkdirSync(versionDir, { recursive: true });
				writeFileSync(join(versionDir, "node.exe"), "");
				writeFileSync(join(versionDir, "index.js"), "");
			}
			expect(resolveCursorInvocation()).toEqual({
				command: join(versions, "2026.10.1-new", "node.exe"),
				prefixArgs: [join(versions, "2026.10.1-new", "index.js")],
				shell: false,
			});

			rmSync(versions, { recursive: true, force: true });
			const root = join(localAppData, "cursor-agent");
			writeFileSync(join(root, "node.exe"), "");
			writeFileSync(join(root, "index.js"), "");
			expect(resolveCursorInvocation()).toEqual({
				command: join(root, "node.exe"),
				prefixArgs: [join(root, "index.js")],
				shell: false,
			});
		} finally {
			if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = originalLocalAppData;
			rmSync(localAppData, { recursive: true, force: true });
		}
	});

	it("maps login/status/models/execute to documented arguments", async () => {
		const calls: Array<{ args: readonly string[]; env?: Record<string, string> }> = [];
		const capture = async (args: readonly string[], _cwd: string, options?: { env?: Record<string, string> }) => {
			calls.push({ args, env: options?.env });
			if (args[0] === "status") {
				return {
					status: "completed" as const,
					code: 0 as const,
					stdout: JSON.stringify({ isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true }),
					stderr: "",
				};
			}
			if (args[0] === "models") {
				return { status: "completed" as const, code: 0 as const, stdout: SAMPLE_MODELS, stderr: "" };
			}
			return {
				status: "completed" as const,
				code: 0 as const,
				stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
				stderr: "",
			};
		};
		const execute = async (args: readonly string[]) => {
			calls.push({ args });
			return { status: "completed" as const, code: 0 as const };
		};
		const cli = createCursorCli(execute, capture);

		await cli.login("/tmp");
		await cli.status("/tmp");
		await cli.listModels("/tmp", { apiKey: "user-api-key" });
		await cli.execute("auto", "hi", "/tmp");

		expect(calls.map((c) => c.args)).toEqual([
			["login"],
			["status", "--format", "json"],
			["models"],
			["-p", "hi", "--model", "auto", "--output-format", "stream-json", "-f"],
		]);
		expect(calls[2]?.env).toEqual({ CURSOR_API_KEY: "user-api-key" });
	});

	it("reports missing executable without invoking a real CLI", async () => {
		const spawnImpl = (() => {
			throw Object.assign(new Error("command not found"), { code: "ENOENT" });
		}) as Parameters<typeof runCursorCli>[3];

		expect(await runCursorCli(["status"], "C:\\project", {}, spawnImpl)).toEqual({
			status: "not_installed",
			message: 'Cursor CLI command "cursor-agent" was not found on PATH.',
		});
		expect(cursorCliError({ status: "not_installed", message: "missing" }, "check its status").message).toContain(
			"https://cursor.com/docs/cli/installation",
		);
	});

	it("classifies a probe timeout separately from command failure", async () => {
		const result = await runCursorCliCapture(
			["status", "--format", "json"],
			process.cwd(),
			{ timeoutMs: 25 },
			fixtureSpawn("timeout"),
		);
		expect(result).toMatchObject({ status: "timed_out", message: "Cursor CLI command timed out." });
		expect(cursorCliError(result, "check its status").message).toContain("cursor-agent status");
	});

	it("uses the fake CLI fixture for normal, unauthenticated, and empty catalogs", async () => {
		const notLoggedInStatus = await runCursorCliCapture(
			["status", "--format", "json"],
			process.cwd(),
			{},
			fixtureSpawn("not_logged_in"),
		);
		expect(notLoggedInStatus.status).toBe("completed");
		if (notLoggedInStatus.status === "completed") {
			expect(parseCursorStatusJson(notLoggedInStatus.stdout).isAuthenticated).toBe(false);
		}

		const expiredStatus = await runCursorCliCapture(
			["status", "--format", "json"],
			process.cwd(),
			{},
			fixtureSpawn("expired"),
		);
		expect(expiredStatus.status).toBe("completed");

		const normal = await runCursorCliCapture(["models"], process.cwd(), {}, fixtureSpawn("normal"));
		expect(normal.status).toBe("completed");
		if (normal.status === "completed") expect(parseCursorModelList(normal.stdout)).toHaveLength(2);

		const unauthenticated = await runCursorCliCapture(
			["models"],
			process.cwd(),
			{},
			fixtureSpawn("not_logged_in"),
		);
		expect(unauthenticated).toMatchObject({ status: "failed", code: 1 });

		const empty = await runCursorCliCapture(["models"], process.cwd(), {}, fixtureSpawn("empty_models"));
		expect(empty.status).toBe("completed");
		if (empty.status === "completed") expect(() => parseCursorModelList(empty.stdout)).toThrow(/no models/i);
	});

	it("captures stdout from a successful child process", async () => {
		const child = fakeChild();
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		Object.assign(child, { stdout, stderr });
		const spawnImpl = (() => child) as Parameters<typeof runCursorCliCapture>[3];
		const resultPromise = runCursorCliCapture(["models"], "/tmp", {}, spawnImpl);
		stdout.emit("data", Buffer.from(SAMPLE_MODELS));
		child.emit("close", 0);
		const result = await resultPromise;
		expect(result.status).toBe("completed");
		if (result.status === "completed") {
			expect(parseCursorModelList(result.stdout)).toHaveLength(3);
		}
	});
});

describe("Cursor provider responses", () => {
	it("preflights the CLI before prompting for or storing an API key", async () => {
		const prompt = async () => "cursor-key";
		const missingCliProvider = cursorProvider({
			cli: {
				id: "cursor",
				name: "Cursor",
				login: async () => ({ status: "completed", code: 0 }),
				logout: async () => ({ status: "completed", code: 0 }),
				status: async () => ({ status: "not_installed", message: "missing", stdout: "", stderr: "" }),
				listModels: async () => ({ status: "completed", code: 0, stdout: SAMPLE_MODELS, stderr: "" }),
				execute: async () => ({ status: "completed", code: 0, stdout: "", stderr: "" }),
			},
		});
		await expect(
			missingCliProvider.auth.apiKey?.login?.({
				signal: new AbortController().signal,
				prompt,
				notify: () => {},
			}),
		).rejects.toThrow(/install.*cursor.*cli/i);
	});

	it("does not inject JWT session tokens as CURSOR_API_KEY", () => {
		expect(cursorCliApiKey("aaa.bbb.ccc")).toBeUndefined();
		expect(cursorCliApiKey("cursor_user_key_abc")).toBe("cursor_user_key_abc");
		expect(cursorCliApiKey(undefined)).toBeUndefined();
	});

	it("refreshes models through the CLI and surfaces them for selection", async () => {
		const listModels = async () => ({
			status: "completed" as const,
			code: 0 as const,
			stdout: SAMPLE_MODELS,
			stderr: "",
		});
		const provider = cursorProvider({
			cli: {
				id: "cursor",
				name: "Cursor",
				login: async () => ({ status: "completed", code: 0 }),
				logout: async () => ({ status: "completed", code: 0 }),
				status: async () => ({
					status: "completed",
					code: 0,
					stdout: "{}",
					stderr: "",
				}),
				listModels,
				execute: async () => ({
					status: "completed",
					code: 0,
					stdout: "",
					stderr: "",
				}),
			},
			cwd: "/tmp",
		});

		expect(provider.getModels()).toEqual([]);
		await provider.refreshModels?.({
			credential: { type: "oauth", access: "a.b.c", refresh: "r", expires: Date.now() + 60_000 },
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async ({ update }) => {
				update?.();
				return true;
			},
		});
		expect(provider.getModels().map((m) => m.id)).toEqual(["auto", "gpt-5.2", "composer-2.5"]);
	});
});
