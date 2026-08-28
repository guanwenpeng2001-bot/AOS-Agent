import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/line13-final.yml", import.meta.url), "utf8");

test("Line 13 workflow uses native exact-head jobs and failure-safe artifact assembly", () => {
	for (const runner of ["windows-latest", "ubuntu-latest", "macos-latest"]) assert.match(workflow, new RegExp(runner, "u"));
	assert.match(workflow, /fail-fast: false/u);
	assert.match(workflow, /always\(\) && !cancelled\(\)/u);
	assert.match(workflow, /git rev-parse HEAD/u);
	assert.match(workflow, /verify-line13-evidence\.mjs[\s\S]+--records-dir/u);
	assert.match(workflow, /actions\/upload-artifact@v4/u);
});

test("Line 13 workflow installs safely and calls only targeted checks and dedicated harnesses", () => {
	assert.match(workflow, /npm ci --ignore-scripts/u);
	assert.match(workflow, /vitest\/dist\/cli\.js --run/u);
	assert.match(workflow, /npm run check/u);
	assert.match(workflow, /line13-pack-smoke\.mjs/u);
	assert.match(workflow, /line13-upgrade\.mjs run/u);
	assert.match(workflow, /line13-soak\.mjs/u);
	assert.match(workflow, /line13-certification\.mjs/u);
	assert.doesNotMatch(workflow, /\bnpm test\b|\bnpm run build\b/u);
	assert.doesNotMatch(workflow, /^\s*push:|\bnpm publish\b|\bgit push\b/mu);
});
