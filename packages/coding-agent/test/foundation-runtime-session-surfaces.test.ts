import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Session,
	type AgentBindingV1,
	type AttemptReceiptV1,
	type DispatchV1,
	type RunReceiptV1,
	type TaskEnvelopeV1,
	type TaskResultV1,
} from "@aos-agent/agent-core";
import { fauxAssistantMessage, registerFauxProvider, type AssistantMessage } from "@aos-agent/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	RUNTIME_SESSION_SURFACES,
	createAgentSession,
	createRuntimeSessionSurfaceAdapter,
} from "../src/index.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SessionManagerStorage } from "../src/core/session-manager-storage.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function settledResponse(text: string): AssistantMessage {
	const {
		deferred: _deferred,
		errorMessage: _errorMessage,
		responseId: _responseId,
		...message
	} = fauxAssistantMessage(text);
	return message;
}

describe("Foundation RuntimeSession public surfaces", () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it("drives every public surface through one AgentSession and the complete durable receipt chain", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-runtime-session-surfaces-"));
		const faux = registerFauxProvider();
		cleanup = () => {
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
		};
		faux.setResponses([
			...RUNTIME_SESSION_SURFACES.map((surface) => settledResponse(`response from ${surface}`)),
			settledResponse("response from sdk default"),
			settledResponse("response from tui binding"),
			settledResponse("response from rpc binding"),
			settledResponse("response from headless binding"),
			settledResponse("response from print binding"),
		]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [model],
		});

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const result = await createAgentSession({
			cwd,
			agentDir: cwd,
			model,
			modelRuntime,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			noTools: "all",
		});
		const durableSession = new Session(new SessionManagerStorage(result.session.sessionManager));

		const latestFact = async <T>(objectType: string): Promise<T> => {
			const records = await durableSession.findFoundationRecords({ kind: "fact", objectType, order: "oldestFirst" });
			const record = records.at(-1);
			if (record?.kind !== "fact") throw new Error(`Missing ${objectType} fact`);
			return record.payload as unknown as T;
		};
		const assertLatestChain = async (surface: string): Promise<void> => {
			const ingress = await latestFact<{ readonly surface: string }>("coding_agent.product_prompt_ingress");
			const task = await latestFact<TaskEnvelopeV1>("task");
			const binding = await latestFact<AgentBindingV1>("agent_binding");
			const dispatch = await latestFact<DispatchV1>("dispatch");
			const attemptReceipt = await latestFact<AttemptReceiptV1>("attempt_receipt");
			const taskResult = await latestFact<TaskResultV1>("task_result");
			const runReceipt = await latestFact<RunReceiptV1>("run_receipt");
			expect(ingress.surface).toBe(surface);
			expect(binding.taskId).toBe(task.taskId);
			expect(dispatch.bindingId).toBe(binding.bindingId);
			expect(attemptReceipt.dispatchId).toBe(dispatch.dispatchId);
			expect(taskResult.sourceAttemptReceiptIds).toEqual([attemptReceipt.attemptReceiptId]);
			expect(runReceipt.taskResultId).toBe(taskResult.taskResultId);
			expect({ task: taskResult.status, run: runReceipt.terminalStatus }).toEqual({
				task: "succeeded",
				run: "completed",
			});
		};

		try {
			for (const surface of RUNTIME_SESSION_SURFACES) {
				const adapter = createRuntimeSessionSurfaceAdapter(result.session, surface);
				expect(adapter.session).toBe(result.session);
				await adapter.prompt(`prompt from ${surface}`, { runId: `surface-${surface}` });
				await assertLatestChain(surface);
			}

			await result.session.prompt("sdk default", { runId: "surface-sdk-default" });
			await assertLatestChain("sdk");

			for (const [mode, surface] of [
				["tui", "tui"],
				["rpc", "rpc"],
				["json", "headless"],
				["print", "print"],
			] as const) {
				await result.session.bindExtensions({ mode });
				await result.session.prompt(`prompt from ${mode} binding`, { runId: `surface-binding-${mode}` });
				await assertLatestChain(surface);
			}
		} finally {
			result.session.dispose();
			await result.session.waitForDispose();
		}
	}, 90_000);
});
