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

it("invokes the standard product runtime for every Line 13 transition and reads canonical closure", async () => {
	const root = mkdtempSync(join(tmpdir(), "line13-product-trace-"));
	cleanups.push(root);
	const workDirectory = join(root, "state");
	mkdirSync(workDirectory);
	const trace = await runPackagedLine13ProductTrace({ workDirectory, iterations: 7 });

	expect(trace.entrypoint).toBe("aos-agent/external-connector");
	expect(trace.adapter).toBe("standard_product_composition");
	expect(trace.samples).toHaveLength(7);
	for (const operation of LINE13_PRODUCT_TRACE_OPERATIONS) expect(trace.operations[operation]).toBe(1);
	expect(trace.provider).toEqual({ kind: "faux", pendingResponses: 0 });
	expect(trace.final).toEqual({
		activeRuns: 0,
		backlog: 0,
		status: 0,
		credentials: 0,
		reservations: 0,
		processes: 0,
		timers: 0,
		files: 1,
		pendingWrites: 0,
	});
});
