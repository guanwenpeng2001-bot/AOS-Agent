import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Model, ProviderResponse } from "../src/types.ts";

const modelId = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
let server: Server | undefined;

afterEach(async () => {
	if (!server) return;
	await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
	server = undefined;
});

describe("Bedrock response headers", () => {
	it("forwards raw Smithy headers to onResponse", async () => {
		server = createServer((_request, response) => {
			response.writeHead(200, {
				"content-type": "application/vnd.amazon.eventstream",
				"x-aos-provider": "bedrock",
				"x-aos-resolved-model": modelId,
				"x-amzn-requestid": "req-123",
			});
			response.end();
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
		const base = getModel("amazon-bedrock", modelId) as Model<"bedrock-converse-stream">;
		const responses: ProviderResponse[] = [];

		await streamBedrock(
			{ ...base, baseUrl: `http://127.0.0.1:${address.port}` },
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{
				cacheRetention: "none",
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1" },
				onResponse: (response) => {
					responses.push(response);
				},
			},
		).result();

		expect(responses).toHaveLength(1);
		expect(responses[0]).toMatchObject({
			status: 200,
			headers: {
				"x-amzn-requestid": "req-123",
				"x-aos-provider": "bedrock",
				"x-aos-resolved-model": modelId,
			},
		});
	});
});
