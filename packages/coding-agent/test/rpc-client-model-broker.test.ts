import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
};

function createClient(): { client: RpcClient; privateClient: RpcClientPrivate } {
	const client = new RpcClient();
	return { client, privateClient: client as unknown as RpcClientPrivate };
}

const acceptedResponse = {
	type: "response",
	command: "run.start",
	success: true,
	data: { runId: "r1", sessionId: "s1", attempt: 1, status: "accepted" },
};

describe("RpcClient ModelBroker API", () => {
	it("forwards a route selection on run.start", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => acceptedResponse);
		privateClient.send = send;

		await client.startRun("implement this", undefined, undefined, "balanced");

		expect(send).toHaveBeenCalledWith({
			type: "run.start",
			message: "implement this",
			images: undefined,
			modelRoute: "balanced",
		});
	});

	it("forwards a role selection on run.resume", async () => {
		const { client, privateClient } = createClient();
		const send = vi.fn(async () => ({
			type: "response",
			command: "run.resume",
			success: true,
			data: { runId: "r2", sessionId: "s1", attempt: 2, status: "accepted" },
		}));
		privateClient.send = send;

		await client.resumeRun("session.jsonl", "r1", "continue", undefined, undefined, undefined, "reviewer");

		expect(send).toHaveBeenCalledWith({
			type: "run.resume",
			sessionPath: "session.jsonl",
			sourceRunId: "r1",
			message: "continue",
			images: undefined,
			modelRole: "reviewer",
		});
	});

	it("returns the typed redacted route catalog", async () => {
		const { client, privateClient } = createClient();
		const catalog = {
			schemaVersion: 1,
			models: [{ provider: "faux", id: "faux-1" }],
			routes: [],
			roles: [],
			roleRoutes: [],
			bindings: [],
			currentBindingId: "model-binding:current",
		};
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_model_routes",
			success: true,
			data: catalog,
		}));
		privateClient.send = send;

		const result = await client.getModelRoutes();

		expect(send).toHaveBeenCalledWith({ type: "get_model_routes" });
		expect(result).toEqual(catalog);
		expect(JSON.stringify(result)).not.toContain("apiKey");
	});
});
