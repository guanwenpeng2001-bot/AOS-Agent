import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentBinding, type Attempt } from "@aos-agent/agent-core";
import type { Model } from "@aos-agent/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalConnectorCredentialRuntime } from "../../src/core/connector/durable-connector.ts";
import { createExternalConnectorRegistry } from "../../src/core/connector/registry.ts";
import {
	buildExternalConnectorTargetConfig,
	type ExternalConnectorTargetDefinition,
} from "../../src/core/connector/target-config.ts";
import { createTaskCredentialTestProvider } from "../../src/core/policy/task-credential-provider.ts";
import type { TaskCredentialScope } from "../../src/core/policy/task-credential-lease.ts";
import {
	createAgentRuntimeCompositionFactory,
	materializeAgentRuntimeComposition,
} from "../../src/core/runtime/composition.ts";
import { SettingsManager } from "../../src/core/runtime/settings-manager.ts";
import { AgentSession } from "../../src/core/session/agent-session.ts";
import { SessionManager } from "../../src/core/session/manager.ts";
import { AuthStorage } from "../../src/core/policy/auth-storage.ts";
import { createModelRegistry, getModelRuntime } from "../runtime/model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../utilities.ts";

const NOW = "2026-08-31T12:00:00.000Z";
const MATERIAL_CANARY = "external-product-material-canary";
const SCOPES: readonly TaskCredentialScope[] = Object.freeze([
	Object.freeze({
		credentialName: "external_registry",
		purpose: "dependency_read",
		operations: Object.freeze(["read" as const]),
		targetKinds: Object.freeze(["external_connector"]),
	}),
]);

function model(): Model<"anthropic-messages"> {
	return {
		id: "credential-target-model",
		name: "Credential Target Model",
		api: "anthropic-messages",
		provider: "test",
		baseUrl: "https://test.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

function targetDefinition(cwd: string): ExternalConnectorTargetDefinition {
	return {
		schemaVersion: 1,
		targetId: "external-target-product",
		providerId: "external-provider-product",
		executablePath: process.execPath,
		modulePath: process.execPath,
		cwd,
		version: "1",
		executableIdentity: `sha256:${"a".repeat(64)}`,
		moduleIdentity: `sha256:${"b".repeat(64)}`,
		accountReference: { schemaVersion: 1, namespace: "test", accountId: "opaque-account" },
		capabilityCeiling: {
			modelAccess: ["none"],
			resume: true,
			toolGateway: false,
			artifacts: false,
			images: false,
		},
	};
}

describe("External Connector product credential target", () => {
	let session: AgentSession | undefined;
	let directory: string | undefined;

	afterEach(async () => {
		if (session !== undefined) {
			session.dispose();
			await session.waitForDispose();
			session = undefined;
		}
		if (directory !== undefined) {
			rmSync(directory, { recursive: true, force: true });
			directory = undefined;
		}
	});

	it("binds the one Session service without issuing during composition or readiness", async () => {
		directory = join(tmpdir(), `aos-external-credential-target-${Date.now()}`);
		mkdirSync(directory, { recursive: true });
		const targetConfig = buildExternalConnectorTargetConfig({
			global: { schemaVersion: 1, targets: [targetDefinition(directory)] },
			explicitTargetId: "external-target-product",
		});
		const provider = createTaskCredentialTestProvider({
			materials: { external_registry: MATERIAL_CANARY },
			now: () => NOW,
		});
		let credentialRuntime: ExternalConnectorCredentialRuntime | undefined;
		const runtimeComposition = createAgentRuntimeCompositionFactory({
			externalConnectorTargetConfig: targetConfig,
			externalConnectorCredentialIssueContext: () => () => ({
				taskId: "task-external-product",
				graphRevision: 1,
				nodeId: "node-external-product",
				runId: "run-external-product",
				capabilityBindingId: "capability-external-product",
				policyBindingId: "policy-external-product",
				scopes: SCOPES,
				requestedTtlMs: 60_000,
				clientRequestId: "resolver-request-replaced-at-issue",
				nodeAttached: true,
			}),
			externalConnectorRegistry: (_context, _gateway, _target, _authority, credential) => {
				credentialRuntime = credential;
				return createExternalConnectorRegistry();
			},
			taskCredentialProvider: () => provider,
			taskCredentialPolicyMaxTtlMs: 300_000,
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: model(), systemPrompt: "Test", tools: [] },
			streamFn: () => {
				throw new Error("streaming is not exercised");
			},
		});
		const authStorage = AuthStorage.create(join(directory, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, directory);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(directory),
			settingsManager: SettingsManager.inMemory(),
			cwd: directory,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			runtimeComposition,
			taskCredentialProviderAvailability: { available: true, declaresDelivery: true },
		});

		expect(credentialRuntime).toBeDefined();
		expect(session.getTaskCredentialService()).toBeDefined();
		expect(provider.records.size).toBe(0);
		expect(JSON.stringify(session.agentRuntimeComposition)).not.toContain(MATERIAL_CANARY);
		const missing = credentialRuntime!.service.lookupDeliveredLease({
			projection: {
				schemaVersion: 1,
				leaseId: "lease-missing",
				grantId: "grant-missing",
				bindingId: "binding-missing",
				scopeDigest: `sha256:${"c".repeat(64)}`,
				expiresAt: "2099-01-01T00:00:00.000Z",
				clientRequestId: "missing-request",
			},
			targetId: "external-target-product",
		});
		expect(missing).toEqual({ ok: false, code: "task_credential_not_found" });

		const resolved = credentialRuntime!.resolveIssueContext({} as Attempt, {} as AgentBinding);
		expect(resolved).toMatchObject({
			targetId: "external-target-product",
			targetKind: "external_connector",
			targetLifecycle: "external_connector",
			scopes: SCOPES,
		});
		expect(resolved?.sandboxBindingId).toMatch(/^external_credential_target_/);

		let accountOnlyRuntime: ExternalConnectorCredentialRuntime | undefined;
		const accountOnlyFactory = createAgentRuntimeCompositionFactory({
			externalConnectorTargetConfig: targetConfig,
			externalConnectorRegistry: (_context, _gateway, _target, _authority, credential) => {
				accountOnlyRuntime = credential;
				return createExternalConnectorRegistry();
			},
		});
		const accountOnlyComposition = materializeAgentRuntimeComposition(
			accountOnlyFactory,
			session.agentRuntimeComposition,
		);
		expect(accountOnlyRuntime).toBeUndefined();
		await accountOnlyComposition.externalConnectorRegistry?.dispose();
	});
});
