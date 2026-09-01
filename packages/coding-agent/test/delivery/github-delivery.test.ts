import { InMemorySessionStorage, Session } from "@aos-agent/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
	GithubDeliveryError,
	GithubDeliveryService,
	type GhCommandResult,
	type GhCommandRunner,
} from "../../src/core/delivery/github-delivery.ts";

const CREATED_URL = "https://github.com/example/project/pull/42";

function commandResult(overrides: Partial<GhCommandResult> = {}): GhCommandResult {
	return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

function scriptedRunner(results: readonly GhCommandResult[]): GhCommandRunner & { run: ReturnType<typeof vi.fn> } {
	let index = 0;
	const run = vi.fn(async () => results[index++] ?? commandResult({ exitCode: 1, stderr: "unexpected command" }));
	return { run };
}

function statusJson(conclusion: string, status = "COMPLETED"): string {
	return JSON.stringify({
		number: 42,
		url: CREATED_URL,
		headRefName: "feat/delivery",
		statusCheckRollup: [{ name: "test", status, conclusion }],
	});
}

describe("GitHub delivery facts", () => {
	it("creates a PR through fake gh, persists its checks, and replays after restart", async () => {
		const storage = new InMemorySessionStorage({ id: "delivery-session", createdAt: 1 });
		const runner = scriptedRunner([
			commandResult({ stdout: `${CREATED_URL}\n` }),
			commandResult({ stdout: statusJson("SUCCESS") }),
		]);
		const session = new Session(storage);
		const service = new GithubDeliveryService(session, { runner, now: () => 1_786_000_000_000 });

		const created = await service.createPullRequest({
			taskResultId: "task_result_run-1",
			cwd: "/workspace",
			branch: "feat/delivery",
			title: "Add delivery",
			body: "Body",
			base: "main",
			clientRequestId: "delivery-create-1",
		});

		expect(created).toMatchObject({
			taskResultId: "task_result_run-1",
			provider: "github",
			repo: "example/project",
			number: 42,
			branch: "feat/delivery",
			checks: [{ name: "test", status: "completed", conclusion: "success" }],
			conclusion: "success",
		});
		expect(runner.run).toHaveBeenNthCalledWith(
			1,
			["pr", "create", "--title", "Add delivery", "--body", "Body", "--head", "feat/delivery", "--base", "main"],
			{ cwd: "/workspace", timeoutMs: 30_000 },
		);
		expect(runner.run).toHaveBeenNthCalledWith(
			2,
			["pr", "view", CREATED_URL, "--json", "number,url,headRefName,statusCheckRollup"],
			{ cwd: "/workspace", timeoutMs: 30_000 },
		);

		await service.writer.releaseLease();
		const restarted = new GithubDeliveryService(new Session(storage), { runner });
		expect(await restarted.get("task_result_run-1")).toEqual(created);
	});

	it("refreshes fake gh status and writes back the latest conclusion", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "delivery-refresh", createdAt: 1 }));
		const runner = scriptedRunner([
			commandResult({ stdout: CREATED_URL }),
			commandResult({ stdout: statusJson("SUCCESS") }),
			commandResult({ stdout: statusJson("", "IN_PROGRESS") }),
		]);
		const service = new GithubDeliveryService(session, { runner, now: () => 1_786_000_000_000 });
		await service.createPullRequest({
			taskResultId: "task_result_run-2",
			cwd: "/workspace",
			branch: "feat/delivery",
			title: "Add delivery",
			body: "Body",
			clientRequestId: "delivery-create-2",
		});

		const refreshed = await service.refresh("task_result_run-2", "/workspace", "delivery-refresh-2");

		expect(refreshed).toMatchObject({ conclusion: "pending", checks: [{ status: "in_progress" }] });
		expect(refreshed).not.toHaveProperty("concludedAt");
		expect(await service.get("task_result_run-2")).toEqual(refreshed);
	});

	it.each([
		["missing", commandResult({ exitCode: 1, missing: true }), "gh_missing", "https://cli.github.com/"],
		["timeout", commandResult({ exitCode: 1, timedOut: true }), "gh_timeout", "timed out"],
	] as const)("returns an actionable %s gh error", async (_name, result, code, message) => {
		const service = new GithubDeliveryService(
			new Session(new InMemorySessionStorage({ id: `delivery-${code}`, createdAt: 1 })),
			{ runner: scriptedRunner([result]) },
		);
		const promise = service.createPullRequest({
			taskResultId: "task_result_error",
			cwd: "/workspace",
			branch: "feat/delivery",
			title: "Add delivery",
			body: "Body",
			clientRequestId: `delivery-${code}`,
		});
		await expect(promise).rejects.toMatchObject({ code });
		await expect(promise).rejects.toThrow(message);
	});

	it.each([
		["malformed", "not json"],
		["oversized", "x".repeat(1024 * 1024 + 1)],
	] as const)("rejects %s fake gh status output", async (_name, stdout) => {
		const service = new GithubDeliveryService(
			new Session(new InMemorySessionStorage({ id: `delivery-output-${_name}`, createdAt: 1 })),
			{ runner: scriptedRunner([commandResult({ stdout: CREATED_URL }), commandResult({ stdout })]) },
		);
		await expect(
			service.createPullRequest({
				taskResultId: "task_result_output",
				cwd: "/workspace",
				branch: "feat/delivery",
				title: "Add delivery",
				body: "Body",
				clientRequestId: `delivery-output-${_name}`,
			}),
		).rejects.toBeInstanceOf(GithubDeliveryError);
	});
});
