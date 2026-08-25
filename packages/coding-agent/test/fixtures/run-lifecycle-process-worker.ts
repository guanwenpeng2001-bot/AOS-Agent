import { dirname } from "node:path";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createRunLifecycleCoordinator, type RunModelReference } from "../../src/core/run-lifecycle.ts";
import { observeCanonicalTerminal } from "../support/canonical-run-terminal.ts";

const [sessionFile, phase] = process.argv.slice(2);
if (sessionFile === undefined || (phase !== "accepted" && phase !== "started" && phase !== "terminal")) {
	throw new Error("Expected a session file and accepted, started, or terminal phase");
}

process.stdout.write("startup-ready\n");

const model: RunModelReference = { provider: "anthropic", id: "claude-sonnet-5", thinkingLevel: "high" };
const session = SessionManager.open(sessionFile, dirname(sessionFile));
const coordinator = createRunLifecycleCoordinator(session, { now: () => "2026-08-14T00:00:00.000Z" });
const run = coordinator.reserve().accept({
	runId: `run-${phase}`,
	attempt: 1,
	model,
	requestScope: "start",
	clientRequestId: `request-${phase}`,
	requestFingerprint: "a".repeat(64),
});

if (phase === "started" || phase === "terminal") run.start();
if (phase === "terminal") await observeCanonicalTerminal(session, run, { outcome: "completed" });

process.stdout.write("boundary-ready\n");
setInterval(() => {}, 1_000);
