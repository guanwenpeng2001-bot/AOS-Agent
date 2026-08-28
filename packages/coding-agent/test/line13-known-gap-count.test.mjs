import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { countLine13KnownGaps } from "../scripts/line13-known-gap-count.mjs";

const SHARD_NAMES = ["ac-01-08.ts", "ac-09-16.ts", "ac-17-24.ts"];

function writeShards(root, gapCount, total = 24) {
	const shardRoot = join(root, "packages", "coding-agent", "test", "line13-known-gap-shards");
	mkdirSync(shardRoot, { recursive: true });
	let emitted = 0;
	for (const name of SHARD_NAMES) {
		const calls = [];
		for (let index = 0; index < 8 && emitted < total; index += 1, emitted += 1) {
			calls.push(`${emitted < gapCount ? "defineLine13KnownGapCase" : "defineLine13ResolvedCase"}({});`);
		}
		writeFileSync(join(shardRoot, name), `${calls.join("\n")}\n`, "utf8");
	}
}

test("known-gap counter reads shard structure without executing fixtures", () => {
	const root = mkdtempSync(join(tmpdir(), "line13-gap-count-"));
	try {
		writeShards(root, 0);
		assert.deepEqual(countLine13KnownGaps(root), { knownGaps: 0, resolved: 24, totalAcceptanceCriteria: 24 });
		writeShards(root, 3);
		assert.deepEqual(countLine13KnownGaps(root), { knownGaps: 3, resolved: 21, totalAcceptanceCriteria: 24 });
		writeShards(root, 1, 23);
		assert.throws(() => countLine13KnownGaps(root), /classify all 24/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
