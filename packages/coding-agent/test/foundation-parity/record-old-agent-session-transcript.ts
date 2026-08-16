/**
 * Foundation parity baseline (T0B): old-AgentSession transcript recorder.
 *
 * Runs the {@link foundationParityScripts} against the current AgentSession
 * (via the suite harness and, for the resume flow, the session runtime
 * factory) and returns the normalized observable transcript fixture.
 *
 * The fixture is facade-neutral plain JSON: later facade-parity tasks (T3/T9)
 * run the same scripts against AgentHarness and must reproduce the recorded
 * observations modulo the explicit `gaps` documented in the migration
 * inventory.
 */

import { foundationParityScripts, type ScenarioObservation, type ScenarioScript } from "./scenarios.ts";
import { OldAgentSessionHost, ResumeAgentSessionHost } from "./old-agent-session-host.ts";

export interface OldAgentSessionTranscriptScenario extends ScenarioObservation {
	id: string;
	description: string;
	coverage: string[];
}

export interface OldAgentSessionTranscript {
	schemaVersion: 1;
	recorder: "old-AgentSession (suite harness + faux provider)";
	normalization: {
		stripped: string[];
		collapsed: string[];
	};
	scenarios: OldAgentSessionTranscriptScenario[];
}

export const TRANSCRIPT_NORMALIZATION = {
	stripped: [
		"message timestamps",
		"message/entry ids",
		"leaf ids",
		"session ids",
		"run ids",
		"tool call ids (replayed as tc1..tcN)",
		"response ids",
		"session file paths",
		"temp dir paths",
	],
	collapsed: ["streaming deltas (message_update) to one marker per assistant stream"],
} as const;

function hostForScript(script: ScenarioScript): OldAgentSessionHost | ResumeAgentSessionHost {
	return script.id === "resume" ? new ResumeAgentSessionHost() : new OldAgentSessionHost();
}

export async function recordOldAgentSessionTranscript(): Promise<OldAgentSessionTranscript> {
	const scenarios: OldAgentSessionTranscriptScenario[] = [];
	for (const script of foundationParityScripts) {
		const host = hostForScript(script);
		try {
			const observation = await script.run(host);
			scenarios.push({
				id: script.id,
				description: script.description,
				coverage: script.coverage,
				...observation,
			});
		} finally {
			await host.dispose();
		}
	}
	return {
		schemaVersion: 1,
		recorder: "old-AgentSession (suite harness + faux provider)",
		normalization: {
			stripped: [...TRANSCRIPT_NORMALIZATION.stripped],
			collapsed: [...TRANSCRIPT_NORMALIZATION.collapsed],
		},
		scenarios,
	};
}

export function transcriptScenarioIds(transcript: OldAgentSessionTranscript): string[] {
	return transcript.scenarios.map((scenario) => scenario.id);
}