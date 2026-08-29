import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentBinding,
	AttemptReceipt,
	Dispatch,
	RunReceipt,
	TaskEnvelope,
	TaskResult,
} from "@aos-agent/agent-core";
import { fakeAssistantMessage, registerFakeProvider, type AssistantMessage } from "@aos-agent/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	RUNTIME_SESSION_SURFACES,
	createAgentSession,
	createRuntimeSessionSurfaceAdapter,
} from "../src/index.ts";
import { AuthStorage } from "../src/core/policy/auth-storage.ts";
import { getAgentCanonicalSession, getAgentSessionLedger } from "../src/core/session/facade.ts";
import type { AgentSession } from "../src/core/session/agent-session.ts";
import { ExecutionAuditQuery } from "../src/core/session/execution-audit-query.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function settledResponse(text: string): AssistantMessage {
	const {
		deferred: _deferred,
		errorMessage: _errorMessage,
		responseId: _responseId,
		...message
	} = fakeAssistantMessage(text);
	return message;
}

interface AuditBusinessTerminal {
	readonly status: string;
	readonly usage?: { readonly input: number; readonly output: number; readonly total: number };
	readonly terminalError?: { readonly code: string; readonly retryable?: boolean };
}

function canonicalBusinessTerminal(receipt: RunReceipt) {
	return {
		status: receipt.terminalStatus,
		usage: {
			input: receipt.usage.inputTokens,
			output: receipt.usage.outputTokens,
			total: receipt.usage.totalTokens,
		},
		terminalError:
			receipt.terminalError === undefined
				? undefined
				: { code: receipt.terminalError.code, retryable: receipt.terminalError.retryable },
	};
}

function auditBusinessTerminal(run: AuditBusinessTerminal) {
	return {
		status: run.status,
		usage: run.usage,
		terminalError:
			run.terminalError === undefined
				? undefined
				: { code: run.terminalError.code, retryable: run.terminalError.retryable },
	};
}

describe("Foundation RuntimeSession public surfaces", () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it("drives every public surface through one AgentSession and the complete durable receipt chain", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-runtime-session-surfaces-"));
		const fake = registerFakeProvider();
		cleanup = () => {
			fake.unregister();
			rmSync(cwd, { recursive: true, force: true });
		};
		fake.setResponses([
			...RUNTIME_SESSION_SURFACES.map((surface) => settledResponse(`response from ${surface}`)),
			settledResponse("response from sdk default"),
			settledResponse("response from tui binding"),
			settledResponse("response from rpc binding"),
			settledResponse("response from headless binding"),
			settledResponse("response from print binding"),
		]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(fake.getModel().provider, async () => ({ type: "api_key", key: "fake-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		const model = fake.getModel();
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
			session: { mode: "memory" },
			noTools: "all",
		});
		const durableSession = getAgentCanonicalSession(result.session);

		const latestFact = async <T>(objectType: string): Promise<T> => {
			const records = await durableSession.findFoundationRecords({ kind: "fact", objectType, order: "oldestFirst" });
			const record = records.at(-1);
			if (record?.kind !== "fact") throw new Error(`Missing ${objectType} fact`);
			return record.payload as unknown as T;
		};
		const assertLatestChain = async (surface: string): Promise<RunReceipt> => {
			const ingress = await latestFact<{ readonly surface: string }>("coding_agent.product_prompt_ingress");
			const task = await latestFact<TaskEnvelope>("task");
			const binding = await latestFact<AgentBinding>("agent_binding");
			const dispatch = await latestFact<Dispatch>("dispatch");
			const attemptReceipt = await latestFact<AttemptReceipt>("attempt_receipt");
			const taskResult = await latestFact<TaskResult>("task_result");
			const runReceipt = await latestFact<RunReceipt>("run_receipt");
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
			return runReceipt;
		};

		try {
			for (const surface of RUNTIME_SESSION_SURFACES) {
				const adapter = createRuntimeSessionSurfaceAdapter(result.session, surface);
				expect(adapter.session).toBe(result.session);
				const runId = `surface-${surface}`;
				await adapter.prompt(`prompt from ${surface}`, { runId });
				const canonical = canonicalBusinessTerminal(await assertLatestChain(surface));
				const audit = new ExecutionAuditQuery(getAgentSessionLedger(result.session)).replay(runId).run;
				expect(auditBusinessTerminal(audit)).toEqual(canonical);
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
				const runId = `surface-binding-${mode}`;
				await result.session.prompt(`prompt from ${mode} binding`, { runId });
				const canonical = canonicalBusinessTerminal(await assertLatestChain(surface));
				const audit = new ExecutionAuditQuery(getAgentSessionLedger(result.session)).replay(runId).run;
				expect(auditBusinessTerminal(audit)).toEqual(canonical);
			}
		} finally {
			result.session.dispose();
			await result.session.waitForDispose();
		}
	}, 90_000);

	it("keeps the SDK adapter, local TUI binding, canonical receipt, and Audit business terminal equal", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-runtime-surface-parity-"));
		const fake = registerFakeProvider();
		fake.setResponses([settledResponse("same response"), settledResponse("same response")]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(fake.getModel().provider, async () => ({ type: "api_key", key: "fake-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		const model = fake.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [model],
		});

		const createSurfaceSession = async () => {
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
			return await createAgentSession({
				cwd,
				agentDir: cwd,
				model,
				modelRuntime,
				resourceLoader,
				settingsManager,
				session: { mode: "memory" },
				noTools: "all",
			});
		};
		const sdk = await createSurfaceSession();
		const tui = await createSurfaceSession();
		const runId = "surface-parity";

		const readSurface = async (agentSession: AgentSession, expectedSurface: "sdk" | "tui") => {
			const durable = getAgentCanonicalSession(agentSession);
			const latestFact = async <T>(objectType: string): Promise<T> => {
				const records = await durable.findFoundationRecords({ kind: "fact", objectType, order: "oldestFirst" });
				const record = records.at(-1);
				if (record?.kind !== "fact") throw new Error(`Missing ${objectType} fact`);
				return record.payload as unknown as T;
			};
			const ingress = await latestFact<{ readonly surface: string }>("coding_agent.product_prompt_ingress");
			const receipt = await latestFact<RunReceipt>("run_receipt");
			const canonical = canonicalBusinessTerminal(receipt);
			const audit = new ExecutionAuditQuery(getAgentSessionLedger(agentSession)).replay(runId).run;
			expect(ingress.surface).toBe(expectedSurface);
			expect(auditBusinessTerminal(audit)).toEqual(canonical);
			return canonical;
		};

		try {
			await createRuntimeSessionSurfaceAdapter(sdk.session, "sdk").prompt("same prompt", { runId });
			await tui.session.bindExtensions({ mode: "tui" });
			await tui.session.prompt("same prompt", { runId });

			const sdkView = await readSurface(sdk.session, "sdk");
			const tuiView = await readSurface(tui.session, "tui");
			expect(tuiView).toEqual(sdkView);
		} finally {
			sdk.session.dispose();
			tui.session.dispose();
			await Promise.all([sdk.session.waitForDispose(), tui.session.waitForDispose()]);
			fake.unregister();
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 90_000);
});
