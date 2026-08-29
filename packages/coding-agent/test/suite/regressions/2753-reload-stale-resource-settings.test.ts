import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFakeProvider } from "@aos-agent/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/session/runtime.ts";
import { AuthStorage } from "../../../src/core/policy/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

describe("issue #2753 reload stale resource settings", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("applies updated top-level prompt settings on reload after startup", async () => {
		const tempDir = join(tmpdir(), `aos-2753-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		const promptsDir = join(agentDir, "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(promptsDir, "test.md"), "Echo test prompt\n");

		const fake = registerFakeProvider({
			models: [{ id: "fake-1", reasoning: false }],
		});
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(fake.getModel().provider, async () => ({ type: "api_key", key: "fake-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
			registerCandidateSession,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [
						(agent) => {
							agent.registerProvider(fake.getModel().provider, {
								baseUrl: fake.getModel().baseUrl,
								apiKey: "fake-key",
								api: fake.api,
								models: fake.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
						},
					],
					noSkills: true,
					noThemes: true,
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: fake.getModel(),
			});
			registerCandidateSession(created.session);
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir,
			session: { mode: "new" },
		});

		cleanups.push(() => {
			runtime.session.dispose();
			fake.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		expect(runtime.session.promptTemplates.map((prompt) => prompt.name)).toContain("test");

		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ prompts: ["-prompts/test.md"] }, null, 2)}\n`);

		await runtime.session.reload();

		expect(runtime.services.settingsManager.getGlobalSettings().prompts).toEqual(["-prompts/test.md"]);
		expect(runtime.session.promptTemplates.map((prompt) => prompt.name)).not.toContain("test");
	});
});
