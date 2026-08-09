import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	createCursorCli,
	cursorCliApiKey,
	cursorProvider,
	normalizeCursorModels,
	parseCursorExecutionOutput,
	parseCursorModelList,
	parseCursorStatusJson,
	runCursorCli,
	runCursorCliCapture,
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

	it("normalizes references into Model entries", () => {
		const models = normalizeCursorModels(parseCursorModelList(SAMPLE_MODELS));
		expect(models).toHaveLength(3);
		expect(models[0]).toMatchObject({
			id: "auto",
			provider: "cursor",
			api: "cursor-cli",
			baseUrl: "cursor-cli://local",
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
