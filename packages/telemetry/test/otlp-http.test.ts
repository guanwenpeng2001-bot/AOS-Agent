import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	OtlpHttpTelemetryContext,
	type OtlpHttpTelemetryDiagnostic,
} from "../src/index.ts";

interface ReceivedRequest {
	path: string;
	body: unknown;
}

const servers = new Set<Server>();

afterEach(async () => {
	await Promise.all(Array.from(servers, (server) => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	})));
	servers.clear();
});

async function startCollector(): Promise<{ endpoint: string; requests: ReceivedRequest[] }> {
	const requests: ReceivedRequest[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		requests.push({
			path: request.url ?? "",
			body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
		});
		response.writeHead(200, { "content-type": "application/json" });
		response.end("{}");
	});
	servers.add(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Fake collector did not bind TCP");
	return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function traceSpans(payload: unknown): Record<string, unknown>[] {
	const resourceSpan = asRecord(asArray(asRecord(payload).resourceSpans)[0]);
	const scopeSpan = asRecord(asArray(resourceSpan.scopeSpans)[0]);
	return asArray(scopeSpan.spans).map(asRecord);
}

function metricNames(payload: unknown): string[] {
	const resourceMetric = asRecord(asArray(asRecord(payload).resourceMetrics)[0]);
	const scopeMetric = asRecord(asArray(resourceMetric.scopeMetrics)[0]);
	return asArray(scopeMetric.metrics)
		.map((metric) => asRecord(metric).name)
		.filter((name): name is string => typeof name === "string");
}

describe("OtlpHttpTelemetryContext", () => {
	it("exports OTLP JSON traces and derived basic metrics to a fake collector", async () => {
		const collector = await startCollector();
		const telemetry = new OtlpHttpTelemetryContext({
			endpoint: collector.endpoint,
			batchSize: 10,
			scheduledDelayMs: 60_000,
		});

		await telemetry.startSpan({ name: "aos.harness.run", attributes: { "aos.operation.kind": "run" } }, (run) =>
			run.startSpan({ name: "aos.ai.request", attributes: { "aos.ai.model": "model" } }, (request) =>
				request.startSpan({ name: "aos.harness.tool", attributes: { "aos.tool.name": "read" } }, (tool) => {
					tool.setAttributes({ "aos.tool.is_error": false });
				}),
			),
		);
		await telemetry.forceFlush();

		const traceRequest = collector.requests.find((request) => request.path === "/v1/traces");
		const metricRequest = collector.requests.find((request) => request.path === "/v1/metrics");
		expect(traceRequest).toBeDefined();
		expect(metricRequest).toBeDefined();
		const spans = traceSpans(traceRequest?.body);
		expect(spans.map((span) => span.name)).toEqual([
			"aos.harness.tool",
			"aos.ai.request",
			"aos.harness.run",
		]);
		expect(spans[0]?.traceId).toBe(spans[1]?.traceId);
		expect(spans[1]?.traceId).toBe(spans[2]?.traceId);
		expect(spans[0]?.parentSpanId).toBe(spans[1]?.spanId);
		expect(metricNames(metricRequest?.body).sort()).toEqual([
			"aos.ai.request.count",
			"aos.ai.request.duration",
			"aos.harness.run.finished",
			"aos.harness.run.started",
			"aos.harness.tool.count",
			"aos.harness.tool.duration",
		].sort());
		await telemetry.shutdown();
	});

	it("drops the oldest span when the bounded queue is full", async () => {
		const bodies: unknown[] = [];
		const request: typeof fetch = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response("{}", { status: 200 });
		};
		const telemetry = new OtlpHttpTelemetryContext({
			endpoint: "http://collector.test",
			request,
			batchSize: 10,
			maxQueueSize: 2,
			scheduledDelayMs: 60_000,
		});

		await telemetry.startSpan({ name: "first" }, () => undefined);
		await telemetry.startSpan({ name: "second" }, () => undefined);
		await telemetry.startSpan({ name: "third" }, () => undefined);
		expect(telemetry.getStats()).toMatchObject({ queuedSpans: 2, droppedSpans: 1 });
		await telemetry.forceFlush();
		expect(traceSpans(bodies[0]).map((span) => span.name)).toEqual(["second", "third"]);
		await telemetry.shutdown();
	});

	it("contains exporter failures without changing product results", async () => {
		const diagnostics: OtlpHttpTelemetryDiagnostic[] = [];
		const request: typeof fetch = async () => {
			throw new Error("collector unavailable");
		};
		const telemetry = new OtlpHttpTelemetryContext({
			endpoint: "http://collector.test",
			request,
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			scheduledDelayMs: 60_000,
		});

		await expect(telemetry.startSpan({ name: "aos.ai.request" }, () => 42)).resolves.toBe(42);
		await expect(telemetry.forceFlush()).resolves.toBeUndefined();
		expect(telemetry.getStats().exportFailures).toBe(2);
		expect(diagnostics).toEqual([
			{ type: "export_failure", signal: "traces", failures: 1 },
			{ type: "export_failure", signal: "metrics", failures: 2 },
		]);
		await telemetry.shutdown();
	});
});
