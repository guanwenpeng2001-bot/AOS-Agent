/**
 * Foundation parity baseline (T0B): old-AgentSession transcript fixture test.
 *
 * Regenerates the normalized old-AgentSession observable transcript and
 * verifies it against the committed fixture
 * (`fixtures/old-agent-session.transcript.json`). The committed fixture is the
 * ground truth that later facade-parity tasks (facade parity) replay against the new
 * AgentHarness.
 *
 * Regenerate the fixture after intentional behavioral changes:
 *   UPDATE_PARITY_FIXTURES=1 node <repo>/node_modules/vitest/dist/cli.js --run test/foundation-parity/old-agent-session-transcript.test.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	recordOldAgentSessionTranscript,
	transcriptScenarioIds,
	type OldAgentSessionTranscript,
} from "./record-old-agent-session-transcript.ts";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "old-agent-session.transcript.json");

function readFixture(): OldAgentSessionTranscript {
	if (!existsSync(FIXTURE_PATH)) {
		throw new Error(`Missing transcript fixture at ${FIXTURE_PATH}. Regenerate with UPDATE_PARITY_FIXTURES=1.`);
	}
	return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as OldAgentSessionTranscript;
}

function writeFixture(transcript: OldAgentSessionTranscript): void {
	writeFileSync(FIXTURE_PATH, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
}

const REQUIRED_SCENARIOS: Array<{ id: string; area: string }> = [
	{ id: "prompt-stream", area: "prompt/model stream" },
	{ id: "tool-loop", area: "tool loop" },
	{ id: "queued-follow-up", area: "queued follow-up" },
	{ id: "cancel-abort", area: "cancel/abort" },
	{ id: "compact", area: "compact" },
	{ id: "resume", area: "resume" },
];

describe("old-AgentSession transcript fixture (T0B parity baseline)", () => {
	it("covers every required observable area", async () => {
		const transcript = await recordOldAgentSessionTranscript();
		expect(transcript.schemaVersion).toBe(1);

		const ids = transcriptScenarioIds(transcript);
		for (const required of REQUIRED_SCENARIOS) {
			expect(ids, `missing required scenario ${required.id} (${required.area})`).toContain(required.id);
		}

		for (const scenario of transcript.scenarios) {
			expect(scenario.finalMessages.length, `${scenario.id}: empty final transcript`).toBeGreaterThan(0);
			expect(scenario.eventTypes.length, `${scenario.id}: empty event trace`).toBeGreaterThan(0);
		}

		const promptStream = transcript.scenarios.find((scenario) => scenario.id === "prompt-stream");
		expect(promptStream).toBeDefined();
		expect(promptStream?.markers.streamingAtEnd).toBe(false);
		expect(promptStream?.markers.pendingAtEnd).toBe(0);
		expect(promptStream?.streamDeltasObserved).toBe(true);

		const toolLoop = transcript.scenarios.find((scenario) => scenario.id === "tool-loop");
		expect(toolLoop?.markers.finalRoles).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(toolLoop?.markers.toolExecutionStarts).toEqual(["echo"]);

		const queuedFollowUp = transcript.scenarios.find((scenario) => scenario.id === "queued-follow-up");
		expect(queuedFollowUp?.markers.queuedCountWhileBlocked).toBe(2);
		expect(queuedFollowUp?.markers.finalUserTexts).toEqual(["start", "steer now", "follow-up later"]);
		expect(queuedFollowUp?.streamDeltasObserved).toBe(true);

		const cancelAbort = transcript.scenarios.find((scenario) => scenario.id === "cancel-abort");
		expect(cancelAbort?.markers.abortedStopReason).toBe("aborted");

		const compact = transcript.scenarios.find((scenario) => scenario.id === "compact");
		expect(compact?.markers.compactionSummary).toEqual(["summary from extension"]);

		const resume = transcript.scenarios.find((scenario) => scenario.id === "resume");
		expect(resume?.markers.sessionStartReasons).toEqual(["startup", "resume"]);
		expect(resume?.markers.finalUserTexts).toEqual(["first question", "second question"]);
	});

	it("matches the committed fixture (normalize unstable ids/timestamps)", async () => {
		const recorded = await recordOldAgentSessionTranscript();
		const fixture = readFixture();
		try {
			expect(recorded).toEqual(fixture);
		} catch {
			// Provide a regeneration hint without mutating the fixture on a normal run.
			expect.fail(
				`Transcript drift detected. Intentional behavior change? Regenerate with UPDATE_PARITY_FIXTURES=1\n` +
					`Fixture: ${FIXTURE_PATH}`,
			);
		}
	});

	it("keeps the committed fixture free of unstable ids and timestamps", () => {
		const serialized = JSON.stringify(readFixture());
		const unstablePatterns: Array<[string, RegExp]> = [
			["timestamps", /"timestamp"/],
			["response ids", /"responseId"/],
			["entry ids", /"entryId"/],
			["leaf ids", /"leafId"/],
			["session ids", /"sessionId"/],
			["run ids", /"runId"/],
			["tool call ids", /"toolCallId":\s*"(?!tc\d+")/],
			["session files", /"sessionFile"/],
			["temp dir paths", /aos-(?:suite|parity)-/],
			["uuid-7 ids", /\b[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\b/],
			["tool: random ids", /"tool:[0-9]+:[0-9a-z]+"/],
		];
		for (const [label, pattern] of unstablePatterns) {
			expect(serialized.match(pattern), `fixture contains unstable ${label}`).toBeNull();
		}
	});

	it("regenerates the fixture when UPDATE_PARITY_FIXTURES=1", async () => {
		if (process.env.UPDATE_PARITY_FIXTURES !== "1") {
			return;
		}
		const recorded = await recordOldAgentSessionTranscript();
		writeFixture(recorded);
		expect(recorded).toEqual(readFixture());
	});
});
