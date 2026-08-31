import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ContextLedger,
	InMemorySessionStorage,
	SessionLedger,
	Session,
	createBindingEpoch,
	createFoundationToolGateway,
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	resolveAgentBinding,
	type AgentBinding,
	type Dispatch,
	type ExecutionCorrelation,
	type RevisionReference,
	type TaskEnvelope,
} from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import { createPackagedExternalConnectorRegistryFactory } from "../../src/core/connector/packaged-runtime.ts";
import {
	externalConnectorAttemptId,
	type ExternalConnectorCredentialRuntime,
} from "../../src/core/connector/durable-connector.ts";
import { fingerprintCanonicalExternalAgentInput } from "../../src/core/connector/input.ts";
import type { AgentRuntimeCompositionContext } from "../../src/core/runtime/composition-factory.ts";
import { buildExternalConnectorTargetConfig, type ExternalConnectorTargetDefinition } from "../../src/external-connector.ts";
import { DEFAULT_RUNTIME_LIMITS } from "../../src/core/runtime/limits.ts";

const NOW = "2026-08-31T00:00:00.000Z";
const PROVIDER_ID = "fixture.external-jsonl";
const FIXTURE_PATH = join(import.meta.dirname, "../fixtures/external-connector-jsonl-driver.mjs");

function identity(path: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function immutableReference(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function target(
	options: {
		readonly toolGateway?: boolean;
		readonly modelAccess?: ExternalConnectorTargetDefinition["capabilityCeiling"]["modelAccess"];
	} = {},
): ReturnType<typeof buildExternalConnectorTargetConfig>["selectedTarget"] {
	const definition: ExternalConnectorTargetDefinition = {
		schemaVersion: 1,
		targetId: "fixture-external-jsonl-target",
		providerId: PROVIDER_ID,
		executablePath: process.execPath,
		modulePath: FIXTURE_PATH,
		cwd: process.cwd(),
		version: "1",
		executableIdentity: identity(process.execPath),
		moduleIdentity: identity(FIXTURE_PATH),
		capabilityCeiling: {
			modelAccess: options.modelAccess ?? ["none"],
			resume: true,
			toolGateway: options.toolGateway ?? false,
			artifacts: false,
			images: false,
		},
	};
	const config = buildExternalConnectorTargetConfig({
		managed: { schemaVersion: 1, targets: [definition] },
		explicitTargetId: definition.targetId,
	});
	if (config.selectedTarget === undefined) throw new Error("Expected a selected JSONL target");
	return config.selectedTarget;
}

function task(): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: "task-jsonl-module-spi",
		goalId: "goal-jsonl-module-spi",
		goal: "Exercise generic JSONL module target",
		workspace: "workspace-jsonl-module-spi",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function binding(currentTask: TaskEnvelope): AgentBinding {
	const role = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-jsonl-module-spi",
			scope: "project",
			slug: "jsonl-module-spi",
			name: "JSONL module SPI",
			description: "JSONL module SPI fixture role",
			revision: 1,
			persona: "Run the JSONL fixture.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "model-jsonl-module-spi", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
	const profile = createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "model-jsonl-module-spi",
		provider: "none",
		model: "none",
		budget: {},
		revision: 1,
		createdAt: NOW,
	});
	const resolved = resolveAgentBinding({
		task: currentTask,
		roleRevision: role,
		modelProfile: profile,
		contextRevision: immutableReference("external_agent_binding", "jsonl-module-binding"),
		capabilityRevision: immutableReference("capability_binding", "jsonl-module-capability"),
		modelBrokerBindingRevision: immutableReference("model_broker_binding", "jsonl-module-model"),
		policyRevision: immutableReference("policy_binding", "jsonl-module-policy"),
		newBindingId: "binding-jsonl-module-spi",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

describe("generic External Connector JSONL module SPI", () => {
	it("rejects a generic settings target that selects aos_gateway model access", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-jsonl-module-aos-gateway-"));
		const selectedTarget = target({ modelAccess: ["aos_gateway"] });
		if (selectedTarget === undefined) throw new Error("Target selection unexpectedly missing");
		try {
			await expect(
				createPackagedExternalConnectorRegistryFactory({
					target: selectedTarget,
					agentDir: root,
				}),
			).rejects.toMatchObject({
				code: "external_connector_config_invalid",
				reason: "capability_widened",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs a non-packaged settings target through the supervised process and canonical receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-jsonl-module-spi-"));
		const selectedTarget = target();
		if (selectedTarget === undefined) throw new Error("Target selection unexpectedly missing");
		const registryFactory = await createPackagedExternalConnectorRegistryFactory({
			target: selectedTarget,
			agentDir: root,
		});
		expect(registryFactory).toBeTypeOf("function");
		if (registryFactory === undefined) throw new Error("Generic target factory was not created");
		const session = new Session(new InMemorySessionStorage({ id: "session-jsonl-module-spi", createdAt: 1 }));
		const contextLedger = new ContextLedger(session, { ownerId: "jsonl-module-spi-test" });
		const ledger = new SessionLedger(session, { ownerId: "jsonl-module-spi-seed", writer: contextLedger.writer });
		const context = {
			session,
			harness: { ledger: { writer: contextLedger.writer } },
			sessionId: "session-jsonl-module-spi",
			models: {},
		} as unknown as AgentRuntimeCompositionContext;
		let credentialContextCalls = 0;
		const credentialRuntime = {
			service: {
				issueForTaskRun: () => {
					throw new Error("Credential issue is not expected without a resolved context");
				},
				lookupDeliveredLease: () => {
					throw new Error("Credential lookup is not expected without a resolved context");
				},
				releaseDeliveredLease: () => {
					throw new Error("Credential release is not expected without a resolved context");
				},
			},
			resolveIssueContext: () => {
				credentialContextCalls += 1;
				return undefined;
			},
		} satisfies ExternalConnectorCredentialRuntime;
		const registry = registryFactory(context, undefined, selectedTarget, {
			runtimeLimitsSource: {},
			runtimeLimits: DEFAULT_RUNTIME_LIMITS,
		}, credentialRuntime);
		const registered = registry.list();
		expect(registered).toHaveLength(1);
		const connectorSelection = await registry.select({
			providerId: PROVIDER_ID,
			revision: 1,
			capabilitySnapshotDigest: registered[0]!.capabilitySnapshotDigest,
		});
		if (!connectorSelection.ok) throw connectorSelection.error;
		const currentTask = task();
		const currentBinding = binding(currentTask);
		const dispatch: Dispatch = {
			schemaVersion: 1,
			dispatchId: "dispatch-jsonl-module-spi",
			taskId: currentTask.taskId,
			bindingId: currentBinding.bindingId,
			taskExecutorProviderId: PROVIDER_ID,
			status: "pending",
			createdAt: NOW,
		};
		const attemptId = externalConnectorAttemptId(PROVIDER_ID, dispatch.dispatchId);
		const epoch = createBindingEpoch({
			bindingEpochId: "epoch-jsonl-module-spi",
			taskId: currentTask.taskId,
			attemptId,
			bindingId: currentBinding.bindingId,
			activationReason: "attempt_started",
			activatedByCommandId: dispatch.dispatchId,
			now: () => NOW,
		});
		if (!epoch.ok) throw epoch.error;
		await ledger.appendFact("task", currentTask.taskId, currentTask, {
			clientRequestId: "jsonl-module-spi:task",
			expectedRevision: 0,
			correlation: { taskId: currentTask.taskId },
		});
		await ledger.appendFact("agent_binding", currentBinding.bindingId, currentBinding, {
			clientRequestId: "jsonl-module-spi:binding",
			expectedRevision: 0,
			correlation: { taskId: currentTask.taskId, bindingId: currentBinding.bindingId },
		});
		const created = await connectorSelection.value.connector.createAttempt(dispatch, currentBinding, {
			initialBindingEpoch: epoch.value,
		});
		if (!created.ok) throw created.error;
		await ledger.appendFact("attempt", created.value.attemptId, created.value, {
			clientRequestId: "jsonl-module-spi:attempt",
			expectedRevision: 0,
			correlation: {
				taskId: currentTask.taskId,
				dispatchId: dispatch.dispatchId,
				attemptId: created.value.attemptId,
				bindingId: currentBinding.bindingId,
				bindingEpochId: epoch.value.bindingEpochId,
			},
		});
		const input = { schemaVersion: 1 as const, text: "fixture", artifacts: [] };
		await ledger.appendFact("external_connector_execution_input", currentTask.taskId, {
			schemaVersion: 1,
			taskId: currentTask.taskId,
			requestFingerprint: fingerprintCanonicalExternalAgentInput(input),
			input,
		}, {
			clientRequestId: "jsonl-module-spi:input",
			expectedRevision: 0,
			correlation: { taskId: currentTask.taskId, attemptId: created.value.attemptId },
		});
		const correlation: ExecutionCorrelation = {
			sessionId: "session-jsonl-module-spi",
			laneId: "main",
			revision: 0,
		};
		const settled = await connectorSelection.value.connector.runAttempt(created.value, { correlation });
		try {
			if (!settled.ok) throw settled.error;
			expect(settled.ok).toBe(true);
			if (settled.ok) {
				expect(settled.value.status).toBe("succeeded");
				expect(settled.value.providerId).toBe(PROVIDER_ID);
				expect(settled.value.sideEffectState).toBe("none");
			}
			expect(credentialContextCalls).toBe(1);
		} finally {
			await registry.dispose();
			await ledger.release();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("binds JSONL Tool Gateway behavior before generic target registration and selection", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-jsonl-module-tool-gateway-"));
		const selectedTarget = target({ toolGateway: true });
		if (selectedTarget === undefined) throw new Error("Target selection unexpectedly missing");
		const registryFactory = await createPackagedExternalConnectorRegistryFactory({
			target: selectedTarget,
			agentDir: root,
		});
		if (registryFactory === undefined) throw new Error("Generic target factory was not created");
		const session = new Session(new InMemorySessionStorage({ id: "session-jsonl-tool-gateway", createdAt: 2 }));
		const contextLedger = new ContextLedger(session, { ownerId: "jsonl-tool-gateway-test" });
		const context = {
			session,
			harness: { ledger: { writer: contextLedger.writer } },
			sessionId: "session-jsonl-tool-gateway",
			models: {},
		} as unknown as AgentRuntimeCompositionContext;
		const registry = registryFactory(
			context,
			createFoundationToolGateway({ gatewayId: "jsonl-tool-gateway", providers: [] }),
			selectedTarget,
			{
				runtimeLimitsSource: {},
				runtimeLimits: DEFAULT_RUNTIME_LIMITS,
			},
			undefined,
		);
		try {
			const registered = registry.list();
			expect(registered).toHaveLength(1);
			const selected = await registry.select({
				providerId: PROVIDER_ID,
				revision: 1,
				capabilitySnapshotDigest: registered[0]!.capabilitySnapshotDigest,
			});
			expect(selected.ok).toBe(true);
		} finally {
			await registry.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
