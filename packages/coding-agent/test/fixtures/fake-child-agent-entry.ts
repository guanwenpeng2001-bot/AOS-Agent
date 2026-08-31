/** Test-only OS-process bootstrap for the fork provider smoke. */
import { once } from "node:events";
import process from "node:process";
import { FoundationError, Result } from "../../../agent/src/internal.ts";
import {
	createAssistantMessageEventStream,
	createModels,
	fakeProvider,
} from "@aos-agent/ai";
import {
	AgentHarnessChildAgentEntryRuntime,
	runChildAgentProcess,
} from "../../src/child-agent-entry.ts";

export const FAKE_CHILD_AGENT_SENTINEL = "AOS_CHILD_AGENT_FORK_OK";
export const FAKE_CHILD_PARENT_CONTEXT = "AOS_CHILD_AGENT_PARENT_CONTEXT";

const fake = fakeProvider({ provider: "fake", models: [{ id: "model-1" }] });
const models = createModels();
models.setProvider(fake.provider);
const runtime = new AgentHarnessChildAgentEntryRuntime({
	models,
	streamFunction: (model, context) => {
		const stream = createAssistantMessageEventStream();
		const inherited = JSON.stringify(context.messages).includes(FAKE_CHILD_PARENT_CONTEXT);
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: inherited ? FAKE_CHILD_AGENT_SENTINEL : "AOS_CHILD_AGENT_PARENT_CONTEXT_MISSING" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	},
	resolveModel: (selection) => {
		const model = fake.getModel();
		return selection.provider === model.provider && selection.model === model.id
			? Result.ok(model)
			: Result.err(new FoundationError("subagent_provider_unavailable", "Fake smoke model selection did not match"));
	},
});

if (!process.stderr.write("test-only child diagnostic\n".repeat(32_768))) {
	await once(process.stderr, "drain");
}

await runChildAgentProcess({ runtime }).catch(() => {
	process.exitCode = 1;
});
