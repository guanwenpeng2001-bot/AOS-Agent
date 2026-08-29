import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	LINE13_PRODUCT_TRACE_OPERATIONS,
	runPackagedLine13ProductTrace,
} from "../src/core/line13-product-trace.ts";

const cleanups: string[] = [];

afterEach(() => {
	for (const path of cleanups.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

it("executes the external Connector through the Scheduler and preserves canonical results across every Line 13 transition", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-product-trace-"));
	cleanups.push(root);
	const workDirectory = join(root, "state");
	mkdirSync(workDirectory);
	const trace = await runPackagedLine13ProductTrace({ workDirectory, iterations: 7 });

	expect(trace.entrypoint).toBe("aos-agent/external-connector");
	expect(trace.adapter).toBe("standard_product_composition");
	expect(trace.samples).toHaveLength(7);
	for (const operation of LINE13_PRODUCT_TRACE_OPERATIONS) expect(trace.operations[operation]).toBe(1);
	expect(trace.connector).toEqual({
		providerId: "aos.line13.external-connector",
		currentRegistrySize: 1,
		attemptExecutions: 2,
	});
	expect(trace.canonicalRecords).toHaveLength(7);
	for (const [index, records] of trace.canonicalRecords.entries()) {
		expect(records).toMatchObject({
			operation: LINE13_PRODUCT_TRACE_OPERATIONS[index],
			attempts: 1,
			attemptReceipts: 1,
			taskResults: 1,
			runReceipts: 1,
			runId: "line13-product-trace-run",
			providerId: "aos.line13.external-connector",
		});
		for (const id of [records.attemptId, records.attemptReceiptId, records.taskResultId, records.runReceiptId]) expect(id.length).toBeGreaterThan(0);
	}
	expect(trace.provider).toEqual({ kind: "faux", pendingResponses: 0 });
	expect(trace.final).toEqual({
		activeRuns: 0,
		backlog: 0,
		status: 1,
		credentials: 0,
		reservations: 0,
		processes: 0,
		timers: 0,
		files: 1,
		pendingWrites: 0,
	});
}, 120_000);
