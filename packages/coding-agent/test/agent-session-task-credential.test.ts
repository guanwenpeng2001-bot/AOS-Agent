/**
 * Tests for the AgentSession-owned Task Credential lifecycle service:
 * lazy session-scoped service creation from the config provider, the
 * Session shutdown signal (revoke + settle every outstanding lease) fired by
 * dispose() and awaited by waitForDispose(), and the post-dispose closed
 * state (issue / renew fail closed, nothing new is appended, and a service
 * never created before dispose is not created afterwards). The shutdown path
 * must never fail the teardown and never touch the Run / Gate / Graph ledgers.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@aos-agent/agent-core";
import type { Model } from "@aos-agent/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/session/agent-session.ts";
import { createAgentRuntimeCompositionFactory } from "../src/core/agent-runtime-composition.ts";
import { AuthStorage } from "../src/core/policy/auth-storage.ts";
import type { SandboxProvider } from "../src/core/policy/sandbox.ts";
import { SessionManager } from "../src/core/session/manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createTaskCredentialTestProvider,
	type TaskCredentialProviderReceipt,
	type TaskCredentialTargetCapabilities,
	type TaskCredentialTargetCapabilitiesRequest,
	type TaskCredentialTargetRenewRequest,
	type TaskCredentialTargetRevokeRequest,
	type TaskCredentialTestProvider,
} from "../src/core/policy/task-credential-provider.ts";
import { TASK_CREDENTIAL_CUSTOM_TYPE } from "../src/core/policy/task-credential-store.ts";
import type { TaskCredentialDeliveryReceipt, TaskCredentialScope } from "../src/core/policy/task-credential-lease.ts";
import type { TaskCredentialRunIssueContext } from "../src/core/policy/task-credential-service.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const NOW = "2026-08-15T12:00:00.000Z";
const SENTINEL = "sentinel-secret-42";

/**
 * Fake sandbox provider: declares per-binding isolation AND credential
 * delivery so the T3 per-binding sandbox facts resolve honestly.
 */
function makeSandboxProvider(): SandboxProvider {
	const capabilities = {
		filesystem: true,
		process: true,
		network: false,
		credentialIsolation: true,
		credentialDelivery: true,
	};
	return {
		id: "fake-sandbox",
		capabilities,
		prepare: async (binding) => ({
			id: `sandbox-handle-${binding.id}`,
			bindingId: binding.id,
			providerId: "fake-sandbox",
			status: "ready",
			capabilities,
			execute: async () => ({ exitCode: 0 }),
		}),
		dispose: async () => {},
	};
}

/**
 * Sandbox-enforcement policy profile whose credentials allowlist contains
 * the test credential, so the `credential.task.*` decision is a real allow.
 */
function credentialSandboxPolicySettings(): {
	defaultProfile: string;
	profiles: Record<string, unknown>;
} {
	const profileId = "credential-sandbox";
	return {
		defaultProfile: profileId,
		profiles: {
			[profileId]: {
				id: profileId,
				enforcement: "sandbox",
				sandboxProvider: "fake-sandbox",
				defaultAction: "allow",
				workspace: { read: ["workspace", "declared-read-only"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
				process: { action: "allow", inheritEnvironment: false, allowEnvironment: ["PATH"], cwdScopes: ["workspace"] },
				network: { action: "allow", allowDestinations: [] },
				credentials: { action: "allow", allowNames: ["package_registry"] },
				approvals: { writeOutsideWorkspace: "deny", network: "allow", process: "allow", credentials: "allow" },
				rules: [],
			},
		},
	};
}

const SCOPES: ReadonlyArray<TaskCredentialScope> = [
	{
		credentialName: "package_registry",
		purpose: "dependency_read",
		operations: ["read"],
		targetKinds: ["isolated_sandbox"],
	},
];

/** Material-receiving target adapter; the provider forwards projections here. */
class RecordingTarget {
	received: Array<{ leaseId: string; material: Readonly<Record<string, string>> }> = [];

	project(request: {
		readonly schemaVersion: 1;
		readonly leaseId: string;
		readonly grantId: string;
		readonly bindingId: string;
		readonly targetId?: string;
		readonly scopes: ReadonlyArray<TaskCredentialScope>;
		readonly material: Readonly<Record<string, string>>;
		readonly projectedAt: string;
	}): TaskCredentialDeliveryReceipt {
		this.received.push({ leaseId: request.leaseId, material: { ...request.material } });
		const receipt: TaskCredentialDeliveryReceipt = {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "succeeded",
			recordedAt: NOW,
		};
		if (request.targetId !== undefined) (receipt as { targetId?: string }).targetId = request.targetId;
		return receipt;
	}

	getCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities {
		return {
			schemaVersion: 1,
			targetId: request.targetId,
			targetKind: request.targetKind,
			bindingId: request.bindingId,
			canReceiveShortLivedCredential: true,
			canRenewCredential: true,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		};
	}

	renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt {
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "renewed",
			recordedAt: NOW,
		};
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "revoked",
			recordedAt: NOW,
		};
	}
}

function makeProvider(): TaskCredentialTestProvider {
	return createTaskCredentialTestProvider({
		materials: { package_registry: SENTINEL },
		now: () => NOW,
		target: new RecordingTarget(),
	});
}

function mockModel(): Model<"anthropic-messages"> {
	return {
		id: "mock",
		name: "Mock",
		api: "anthropic-messages",
		provider: "mock",
		baseUrl: "https://mock.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("AgentSession task credential service ownership", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `aos-session-credential-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session !== undefined) {
			session.dispose();
			await session.waitForDispose();
			session = undefined;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(
		provider?: TaskCredentialTestProvider,
		policyMaxTtlMs?: number,
	): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mockModel(),
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				throw new Error("streamFn is not exercised by this harness");
			},
		});
		const sessionManager = SessionManager.inMemory("/workspace/session-credential");
		const settingsManager = SettingsManager.inMemory({ executionPolicy: credentialSandboxPolicySettings() });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		const created = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			sandboxProviders: [makeSandboxProvider()],
			runtimeComposition: createAgentRuntimeCompositionFactory({
				...(provider === undefined ? {} : { taskCredentialProvider: () => provider }),
				...(policyMaxTtlMs === undefined ? {} : { taskCredentialPolicyMaxTtlMs: policyMaxTtlMs }),
			}),
			...(provider === undefined
				? {}
				: { taskCredentialProviderAvailability: { available: true, declaresDelivery: true } }),
		});
		session = created;
		return { session: created, sessionManager };
	}

	/**
	 * Materialize the frozen policy boundary (capability binding + sandbox
	 * session) and return the real binding identities the issue context must
	 * carry; the command preflight itself never prepares anything.
	 */
	async function prepareBoundary(session: AgentSession, runId: string): Promise<{
		policyBindingId: string;
		capabilityBindingId: string;
		sandboxBindingId: string;
	}> {
		await session.runExternalAgentPreflight(runId);
		const policyBinding = session.getActiveExecutionPolicyBinding();
		const capabilityBindingId = session.getCapabilityBindingId();
		if (policyBinding === undefined || capabilityBindingId === undefined) {
			throw new Error("session boundary was not materialized");
		}
		return {
			policyBindingId: policyBinding.id,
			capabilityBindingId,
			sandboxBindingId: policyBinding.id,
		};
	}

	function issueContext(overrides: {
		policyBindingId: string;
		capabilityBindingId: string;
		sandboxBindingId: string;
		clientRequestId: string;
	}): TaskCredentialRunIssueContext {
		return {
			taskId: "task_42",
			graphRevision: 1,
			nodeId: "node_a",
			runId: "run_001",
			capabilityBindingId: overrides.capabilityBindingId,
			policyBindingId: overrides.policyBindingId,
			sandboxBindingId: overrides.sandboxBindingId,
			targetId: "target_sandbox",
			scopes: SCOPES,
			requestedTtlMs: 60_000,
			clientRequestId: overrides.clientRequestId,
			nodeAttached: true,
		};
	}

	it("creates the session-scoped service lazily from the configured provider", async () => {
		const provider = makeProvider();
		const { session, sessionManager } = await createSession(provider, 300_000);
		expect(session.getTaskCredentialService()).toBeDefined();
		// The service is owned by the session and bound to its SessionManager.
		expect(session.getTaskCredentialService()?.sessionId).toBe(sessionManager.getSessionId());
		// The same instance is returned on later access.
		expect(session.getTaskCredentialService()).toBe(session.getTaskCredentialService());
	});

	it("returns undefined without a provider or without a policy TTL ceiling", async () => {
		const { session } = await createSession();
		expect(session.getTaskCredentialService()).toBeUndefined();

		const provider = makeProvider();
		const withProviderOnly = await createSession(provider);
		expect(withProviderOnly.session.getTaskCredentialService()).toBeUndefined();
	});

	it("dispose fires the Session shutdown signal: every outstanding lease is revoked and settled", async () => {
		const provider = makeProvider();
		const { session, sessionManager } = await createSession(provider, 300_000);
		const service = session.getTaskCredentialService();
		expect(service).toBeDefined();
		const boundary = await prepareBoundary(session, "run_001");
		const issued = service!.issueForTaskRun(
			issueContext({ ...boundary, clientRequestId: "req_issue_1" }),
		);
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		expect(provider.records.get(issued.leaseId)?.revoked).toBe(false);
		expect(provider.records.get(issued.leaseId)?.credentialNames).toEqual(["package_registry"]);

		session.dispose();
		await session.waitForDispose();

		// The shutdown signal revoked + settled the lease through the session
		// single-writer; the issuer-side material is revoked.
		const view = service!.get(issued.leaseId);
		expect(view?.status).toBe("settled");
		expect(provider.records.get(issued.leaseId)?.revoked).toBe(true);
		const credentialEntries = sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					(entry as Extract<typeof entry, { type: "custom" }>).customType === TASK_CREDENTIAL_CUSTOM_TYPE,
			);
		// issued + delivery + revoked + settled; only task.credential entries.
		expect(credentialEntries.length).toBeGreaterThanOrEqual(4);
		// No run/gate/graph ledger entries were ever appended by the credential
		// service (the policy-boundary preparation appends its own policy-ledger
		// entries, which is expected and separate).
		const customTypes = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom")
			.map((entry) => (entry as Extract<typeof entry, { type: "custom" }>).customType);
		expect(customTypes.some((type) => type.startsWith("automation.run") || type.startsWith("task.gate") || type.startsWith("task.graph"))).toBe(false);
		// No material ever reached the session ledger.
		expect(JSON.stringify(sessionManager.getEntries())).not.toContain(SENTINEL);
	});

	it("dispose without a service is a safe no-op", async () => {
		const { session } = await createSession();
		expect(session.getTaskCredentialService()).toBeUndefined();
		expect(() => session.dispose()).not.toThrow();
		await session.waitForDispose();
	});

	it("post-dispose the service is closed: issue and renew fail closed and append nothing", async () => {
		const provider = makeProvider();
		const { session, sessionManager } = await createSession(provider, 300_000);
		const service = session.getTaskCredentialService();
		expect(service).toBeDefined();
		const boundary = await prepareBoundary(session, "run_001");
		const issued = service!.issueForTaskRun(
			issueContext({ ...boundary, clientRequestId: "req_issue_1" }),
		);
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		const { leaseId, bindingId } = issued;
		const grantId = issued.grant.grantId;

		session.dispose();
		await session.waitForDispose();

		// The stable interface still returns the same (closed) instance.
		expect(session.getTaskCredentialService()).toBe(service);
		const entriesBefore = sessionManager.getEntries().length;
		// Sensitive actions fail closed after dispose.
		const reissue = service!.issueForTaskRun(
			issueContext({ ...boundary, clientRequestId: "req_issue_after_dispose" }),
		);
		expect(reissue.ok).toBe(false);
		if (reissue.ok) return;
		expect(reissue.code).toBe("task_credential_invalid");
		const renew = service!.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_after_dispose",
			nodeAttached: true,
		});
		expect(renew.ok).toBe(false);
		if (renew.ok) return;
		expect(renew.code).toBe("task_credential_invalid");
		// The closed service appended nothing and the lease stays settled.
		expect(sessionManager.getEntries().length).toBe(entriesBefore);
		expect(service!.get(leaseId)?.status).toBe("settled");
		expect(provider.records.get(leaseId)?.revoked).toBe(true);
	});

	it("a service never created before dispose is not created afterwards", async () => {
		const provider = makeProvider();
		const { session } = await createSession(provider, 300_000);
		// The service is never touched before dispose.
		session.dispose();
		await session.waitForDispose();
		expect(session.getTaskCredentialService()).toBeUndefined();
	});
});
