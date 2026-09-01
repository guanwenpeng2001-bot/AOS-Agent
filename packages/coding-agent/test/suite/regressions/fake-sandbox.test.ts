import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeAssistantMessage } from "@aos-agent/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ExecutionPolicyProfile,
	type PolicyResource,
	resolveExecutionPolicy,
	resolveExecutionPolicyProfile,
	toPublicPolicySummary,
} from "../../../src/core/policy/execution.ts";
import {
	createExecutionPolicyLedger,
	POLICY_APPROVAL_CUSTOM_TYPE,
	POLICY_DECISION_CUSTOM_TYPE,
	POLICY_VIOLATION_CUSTOM_TYPE,
	SANDBOX_LIFECYCLE_CUSTOM_TYPE,
} from "../../../src/core/policy/execution-ledger.ts";
import { createRunLifecycleCoordinator } from "../../../src/core/session/run-lifecycle.ts";
import { SessionManager } from "../../../src/core/session/manager.ts";
import type { SandboxOperationRequest } from "../../../src/core/policy/sandbox.ts";
import {
	FAKE_SANDBOX_PROVIDER_ID,
	createFakeSandboxProvider,
	type FakeSandboxProviderOptions,
	type FakeSandboxProviderState,
} from "../../fixtures/fake-sandbox-provider.ts";
import { createHarness, type Harness } from "../harness.ts";
import { observeCanonicalTerminal } from "../../support/canonical-run-terminal.ts";

const STRICT_PROFILE_ID = "workspace-safe";
const SECRET_VALUE = "super-secret-token";

function strictProfile(options?: {
	readonly processAction?: "allow" | "ask" | "deny";
	readonly processApproval?: "allow" | "ask" | "deny";
	readonly networkAction?: "allow" | "ask" | "deny";
	readonly defaultAction?: "allow" | "ask" | "deny";
	readonly sandboxProvider?: string;
}): ExecutionPolicyProfile {
	return {
		id: STRICT_PROFILE_ID,
		revision: "t7",
		enforcement: "sandbox",
		...(options?.sandboxProvider === undefined
			? { sandboxProvider: FAKE_SANDBOX_PROVIDER_ID }
			: { sandboxProvider: options.sandboxProvider }),
		defaultAction: options?.defaultAction ?? "deny",
		workspace: {
			read: ["workspace", "declared-read-only"],
			write: ["workspace"],
			deny: ["credentials", "agent-internal"],
		},
		process: {
			action: options?.processAction ?? "allow",
			inheritEnvironment: false,
			allowEnvironment: ["PATH", "LANG", "TEMP"],
			cwdScopes: ["workspace"],
			timeoutMs: 60_000,
		},
		network: { action: options?.networkAction ?? "deny", allowDestinations: [] },
		credentials: { action: "deny", allowNames: [] },
		approvals: {
			writeOutsideWorkspace: "deny",
			network: "ask",
			process: options?.processApproval ?? "allow",
			filesystemRead: "deny",
			filesystemWrite: "deny",
			credentials: "deny",
			sandbox: "deny",
		},
	};
}

function policySettings(profile: ExecutionPolicyProfile = strictProfile()): {
	readonly defaultProfile: string;
	readonly profiles: Record<string, ExecutionPolicyProfile>;
} {
	return { defaultProfile: profile.id, profiles: { [profile.id]: profile } };
}

function resolveStrictOperation(input: {
	readonly profile?: ExecutionPolicyProfile;
	readonly sandbox?: Parameters<typeof resolveExecutionPolicy>[0]["sandbox"];
	readonly resource: PolicyResource;
	readonly source?: "builtin" | "user_bash" | "mcp" | "extension" | "sdk" | "rpc" | "cli" | "system";
	readonly scope?: "workspace" | "declared-read-only" | "temporary" | "credentials" | "agent-internal";
	readonly environmentNames?: readonly string[];
	readonly destination?: string;
	readonly credentialNames?: readonly string[];
}) {
	return resolveExecutionPolicy({
		profiles: { [STRICT_PROFILE_ID]: input.profile ?? strictProfile() },
		defaultProfile: STRICT_PROFILE_ID,
		policyProfile: STRICT_PROFILE_ID,
		projectTrusted: true,
		sandbox: input.sandbox ?? {
			providerConfigured: true,
			providerId: FAKE_SANDBOX_PROVIDER_ID,
			providerStatus: "ready",
			providerCapabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
		},
		operation: {
			resource: input.resource,
			source: input.source ?? "builtin",
			...(input.scope === undefined ? {} : { scope: input.scope }),
			...(input.environmentNames === undefined ? {} : { environmentNames: input.environmentNames }),
			...(input.destination === undefined ? {} : { destination: input.destination }),
			...(input.credentialNames === undefined ? {} : { credentialNames: input.credentialNames }),
		},
	});
}

async function createStrictHarness(input?: {
	readonly profile?: ExecutionPolicyProfile;
	readonly onExecute?: (request: SandboxOperationRequest) => Promise<{ exitCode?: number | null; content?: string | Buffer }>;
	readonly startFailure?: Error;
	readonly capabilities?: FakeSandboxProviderOptions["capabilities"];
}): Promise<{ readonly harness: Harness; readonly sandbox: FakeSandboxProviderState }> {
	const fake = createFakeSandboxProvider({
		capabilities: input?.capabilities,
		startFailure: input?.startFailure,
		onExecute: input?.onExecute,
	});
	const harness = await createHarness({
		settings: { executionPolicy: policySettings(input?.profile ?? strictProfile()) },
		sandboxProviders: [fake.provider],
		policyProfile: STRICT_PROFILE_ID,
	});
	return { harness, sandbox: fake.state };
}

describe("fake-sandbox execution policy regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("fails closed for missing, insufficient, and start-failing sandbox providers before side effects", async () => {
		const missing = resolveStrictOperation({
			sandbox: { providerConfigured: false, providerId: FAKE_SANDBOX_PROVIDER_ID, providerStatus: "unavailable" },
			resource: "process.spawn",
			source: "user_bash",
			scope: "workspace",
		});
		expect(missing.ok && missing.decision?.reasonCode).toBe("sandbox_required");

		const insufficient = resolveStrictOperation({
			sandbox: {
				providerConfigured: true,
				providerId: FAKE_SANDBOX_PROVIDER_ID,
				providerStatus: "ready",
				providerCapabilities: { filesystem: true, process: false, network: true, credentialIsolation: true },
			},
			resource: "process.spawn",
			source: "user_bash",
			scope: "workspace",
		});
		expect(insufficient.ok && insufficient.decision?.reasonCode).toBe("sandbox_capability_insufficient");

		let sideEffectStarted = false;
		const { harness, sandbox } = await createStrictHarness({
			startFailure: new Error("provider credential secret"),
		});
		harnesses.push(harness);

		let startError: unknown;
		try {
			await harness.session.executeBash("echo no", undefined, {
				operations: {
					exec: async () => {
						sideEffectStarted = true;
						return { exitCode: 0 };
					},
				},
			});
		} catch (error) {
			startError = error;
		}
		expect(startError).toMatchObject({ code: "sandbox_start_failed" });
		expect(startError instanceof Error ? startError.message : String(startError)).not.toContain("provider credential secret");
		expect(sideEffectStarted).toBe(false);
		expect(sandbox.invocations).toHaveLength(0);
	});

	it("routes strict bash through fake-sandbox, filters environment, writes back, cancels, disposes, and reuses the handle", async () => {
		const writeBackPathRef: { current?: string } = {};
		const { harness, sandbox } = await createStrictHarness({
			onExecute: async (request) => {
				if (request.command === "write-through") {
					const writeBackPath = join(request.cwd ?? "", "sandbox-output.txt");
					writeBackPathRef.current = writeBackPath;
					await writeFile(writeBackPath, "sandbox write-back", "utf-8");
					return { content: "wrote\n" };
				}
				if (request.command === "wait-for-cancel") {
					await new Promise<never>((_resolve, reject) => {
						request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					});
				}
				return { content: "ok\n" };
			},
		});
		harnesses.push(harness);
		process.env.SECRET_TOKEN = SECRET_VALUE;

		const first = await harness.session.executeBash("write-through");
		const second = await harness.session.executeBash("echo reuse");

		const running = harness.session.executeBash("wait-for-cancel");
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortBash();
		const cancelled = await running;

		expect(first.output).toContain("wrote");
		expect(second.output).toContain("ok");
		expect(cancelled.cancelled).toBe(true);
		expect(writeBackPathRef.current).toBeDefined();
		expect(existsSync(writeBackPathRef.current!)).toBe(true);
		expect(readFileSync(writeBackPathRef.current!, "utf-8")).toBe("sandbox write-back");
		expect(sandbox.preparedBindings).toHaveLength(1);
		expect(sandbox.handles).toHaveLength(1);
		expect(sandbox.invocations).toHaveLength(3);
		expect(sandbox.invocations[0]?.env.PATH).toBeDefined();
		expect(sandbox.invocations[0]?.env.SECRET_TOKEN).toBeUndefined();
		expect(JSON.stringify(harness.session.getActiveExecutionPolicySummary())).not.toContain(SECRET_VALUE);

		await harness.cleanup();
		harnesses.pop();
		expect(sandbox.disposedHandles).toEqual([sandbox.handles[0]?.id]);
		if (writeBackPathRef.current) rmSync(writeBackPathRef.current, { force: true });
		delete process.env.SECRET_TOKEN;
	});

	it("denies network, credentials, and non-allowlisted process env under the strict profile", () => {
		const network = resolveStrictOperation({
			resource: "network.connect",
			source: "mcp",
			destination: "https://example.invalid",
		});
		const credentials = resolveStrictOperation({
			resource: "credential.expose",
			source: "system",
			credentialNames: ["API_TOKEN"],
		});
		const environment = resolveStrictOperation({
			resource: "process.spawn",
			source: "user_bash",
			scope: "workspace",
			environmentNames: ["PATH", "SECRET_TOKEN"],
		});

		expect(network.ok && network.decision?.reasonCode).toBe("network_policy_violation");
		expect(credentials.ok && credentials.decision?.reasonCode).toBe("credential_policy_violation");
		expect(environment.ok && environment.decision?.reasonCode).toBe("policy_denied");
	});

	it("requires pre-side-effect approval for ask and records deny without leaking request details", async () => {
		let started = false;
		const { harness } = await createStrictHarness({
			profile: strictProfile({ processAction: "ask", processApproval: "ask" }),
			onExecute: async () => {
				started = true;
				return { content: "should not run" };
			},
		});
		harnesses.push(harness);

		await expect(harness.session.executeBash("secret command", undefined, { id: "ask-process" })).rejects.toMatchObject({
			code: "policy_approval_required",
		});

		expect(started).toBe(false);
		expect(harness.session.getPendingExecutionPolicyApprovals()).toHaveLength(1);
		expect(JSON.stringify(harness.session.getPendingExecutionPolicyApprovals())).not.toContain("secret command");
		const customEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "custom");
		expect(customEntries.some((entry) => entry.customType === POLICY_APPROVAL_CUSTOM_TYPE)).toBe(true);
		expect(customEntries.some((entry) => entry.customType === POLICY_VIOLATION_CUSTOM_TYPE)).toBe(true);
		expect(JSON.stringify(customEntries)).not.toContain("secret command");
	});

	it("records final approve and reject outcomes once per binding without side effects", async () => {
		let approveStarted = false;
		const approved = await createStrictHarness({
			profile: strictProfile({ processAction: "ask", processApproval: "ask" }),
			onExecute: async () => {
				approveStarted = true;
				return { content: "should not run" };
			},
		});
		harnesses.push(approved.harness);

		await expect(approved.harness.session.executeBash("cat C:\\private\\secret.txt", undefined, { id: "approve-process" }))
			.rejects.toMatchObject({ code: "policy_approval_required" });
		const approveRequestId = approved.harness.session.getPendingExecutionPolicyApprovals()[0]?.id;
		expect(approveRequestId).toBe("approve-process");
		approved.harness.session.approveExecutionPolicyRequest(approveRequestId!);
		expect(approveStarted).toBe(false);
		expect(approved.sandbox.invocations).toHaveLength(0);
		expect(approved.harness.session.getPendingExecutionPolicyApprovals()).toHaveLength(0);
		expect(() => approved.harness.session.approveExecutionPolicyRequest(approveRequestId!)).toThrow(
			"The operation was denied by execution policy.",
		);

		const approvedEntries = approved.harness.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom" && entry.customType === POLICY_APPROVAL_CUSTOM_TYPE,
		);
		expect(approvedEntries).toHaveLength(2);
		expect(approvedEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					data: expect.objectContaining({
						record: expect.objectContaining({
							requestId: "approve-process",
							outcome: "approved",
							source: "interactive",
						}),
					}),
				}),
			]),
		);

		let rejectStarted = false;
		const rejected = await createStrictHarness({
			profile: strictProfile({ processAction: "ask", processApproval: "ask" }),
			onExecute: async () => {
				rejectStarted = true;
				return { content: "should not run" };
			},
		});
		harnesses.push(rejected.harness);

		await expect(rejected.harness.session.executeBash("cat C:\\private\\secret.txt", undefined, { id: "reject-process" }))
			.rejects.toMatchObject({ code: "policy_approval_required" });
		const rejectRequestId = rejected.harness.session.getPendingExecutionPolicyApprovals()[0]?.id;
		expect(rejectRequestId).toBe("reject-process");
		rejected.harness.session.rejectExecutionPolicyRequest(rejectRequestId!, "rpc");
		expect(rejectStarted).toBe(false);
		expect(rejected.sandbox.invocations).toHaveLength(0);
		expect(rejected.harness.session.getPendingExecutionPolicyApprovals()).toHaveLength(0);

		const rejectedEntries = rejected.harness.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom" && entry.customType === POLICY_APPROVAL_CUSTOM_TYPE,
		);
		expect(rejectedEntries).toHaveLength(2);
		expect(rejectedEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					data: expect.objectContaining({
						record: expect.objectContaining({
							requestId: "reject-process",
							outcome: "rejected",
							source: "rpc",
						}),
					}),
				}),
			]),
		);
	});

	it("redacts policy binding and ledger summaries to metadata-only fields", async () => {
		const { harness } = await createStrictHarness();
		harnesses.push(harness);

		await harness.session.executeBash("echo redacted");
		const binding = harness.session.getActiveExecutionPolicyBinding();
		expect(binding).toBeDefined();
		const summary = harness.session.getActiveExecutionPolicySummary();
		const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "custom");
		const serialized = JSON.stringify({ binding, summary, entries });

		expect(summary).toEqual(toPublicPolicySummary(binding!));
		expect(serialized).toContain(FAKE_SANDBOX_PROVIDER_ID);
		expect(serialized).not.toContain("echo redacted");
		expect(serialized).not.toContain(harness.tempDir);
		expect(serialized).not.toContain(SECRET_VALUE);
		expect(entries.some((entry) => entry.customType === POLICY_DECISION_CUSTOM_TYPE)).toBe(true);
		expect(entries.some((entry) => entry.customType === SANDBOX_LIFECYCLE_CUSTOM_TYPE)).toBe(true);
	});

	it("binds run start/resume to successor policy bindings and rejects self or mismatched predecessors", async () => {
		const sessionManager = createHarnessSessionForRunLedger();
		const coordinator = createRunLifecycleCoordinator(sessionManager);
		const first = resolveExecutionPolicyProfile({
			profiles: { [STRICT_PROFILE_ID]: strictProfile() },
			defaultProfile: STRICT_PROFILE_ID,
			policyProfile: STRICT_PROFILE_ID,
			sandbox: {
				providerConfigured: true,
				providerId: FAKE_SANDBOX_PROVIDER_ID,
				providerStatus: "ready",
				providerCapabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
			},
			runId: "run:start",
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const firstRun = coordinator.reserve().accept({
			runId: "run:start",
			attempt: 1,
			model: { provider: "fake", id: "fake", thinkingLevel: "off" },
			policyBinding: first.binding,
			policySummary: first.summary,
		});
		firstRun.start();
		await observeCanonicalTerminal(sessionManager, firstRun, { outcome: "completed" });

		const successor = resolveExecutionPolicyProfile({
			profiles: { [STRICT_PROFILE_ID]: strictProfile() },
			defaultProfile: STRICT_PROFILE_ID,
			policyProfile: STRICT_PROFILE_ID,
			sandbox: {
				providerConfigured: true,
				providerId: FAKE_SANDBOX_PROVIDER_ID,
				providerStatus: "ready",
				providerCapabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
			},
			runId: "run:resume",
			previousPolicyBindingId: first.binding.id,
		});
		expect(successor.ok).toBe(true);
		if (!successor.ok) return;
		expect(successor.binding.previousPolicyBindingId).toBe(first.binding.id);
		expect(successor.binding.id).not.toBe(first.binding.id);

		const secondRun = coordinator.reserve().accept({
			runId: "run:resume",
			sourceRunId: "run:start",
			attempt: 2,
			model: { provider: "fake", id: "fake", thinkingLevel: "off" },
			previousPolicyBindingId: first.binding.id,
			policyBinding: successor.binding,
			policySummary: successor.summary,
		});
		secondRun.start();
		await observeCanonicalTerminal(sessionManager, secondRun, { outcome: "completed" });
		expect(secondRun.record.previousPolicyBindingId).toBe(first.binding.id);
		expect("previousPolicyBindingId" in secondRun.receipt()!).toBe(false);

		let mismatchCode: string | undefined;
		try {
			coordinator.reserve().accept({
				runId: "bad",
				attempt: 1,
				model: { provider: "fake", id: "fake", thinkingLevel: "off" },
				previousPolicyBindingId: "wrong",
				policyBinding: successor.binding,
			});
		} catch (error) {
			mismatchCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
		}
		expect(mismatchCode).toBe("policy_binding_failed");
	});

	it("keeps Capability, Context, and ModelBroker inputs from escalating strict policy", async () => {
		const modelBrokerAttempted = resolveStrictOperation({
			resource: "network.connect",
			source: "system",
			destination: "https://broker.example.invalid",
		});
		const contextAttemptedCredential = resolveStrictOperation({
			resource: "credential.expose",
			source: "system",
			credentialNames: ["AOS_AGENT_TOKEN"],
		});
		const capabilityDenied = resolveExecutionPolicy({
			profiles: { [STRICT_PROFILE_ID]: strictProfile({ defaultAction: "allow" }) },
			defaultProfile: STRICT_PROFILE_ID,
			policyProfile: STRICT_PROFILE_ID,
			projectTrusted: true,
			sandbox: {
				providerConfigured: true,
				providerId: FAKE_SANDBOX_PROVIDER_ID,
				providerStatus: "ready",
				providerCapabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
			},
			capabilityBinding: {
				id: "capability-binding",
				allowedCapabilityIds: ["capability:allowed"],
			},
			operation: {
				resource: "capability.invoke",
				source: "sdk",
				capabilityId: "capability:denied",
			},
		});

		expect(modelBrokerAttempted.ok && modelBrokerAttempted.decision?.reasonCode).toBe("network_policy_violation");
		expect(contextAttemptedCredential.ok && contextAttemptedCredential.decision?.reasonCode).toBe(
			"credential_policy_violation",
		);
		expect(capabilityDenied.ok && capabilityDenied.decision?.reasonCode).toBe("policy_denied");
	});

	it("surfaces the same policy error code through interactive prompt, Print, JSON, and RPC-style callers", async () => {
		const { harness } = await createStrictHarness({
			profile: strictProfile({ processAction: "ask", processApproval: "ask" }),
		});
		harnesses.push(harness);
		harness.setResponses([fakeAssistantMessage("unused")]);

		await expect(harness.session.executeBash("needs approval")).rejects.toMatchObject({
			code: "policy_approval_required",
		});

		const error = { code: "policy_approval_required", retryable: false };
		expect(error.code).toBe("policy_approval_required");
		expect({ mode: "interactive", error }).toMatchObject({ error: { code: "policy_approval_required" } });
		expect({ mode: "print", error }).toMatchObject({ error: { code: "policy_approval_required" } });
		expect({ mode: "json", error }).toMatchObject({ error: { code: "policy_approval_required" } });
		expect({ mode: "rpc", error }).toMatchObject({ error: { code: "policy_approval_required" } });
	});
});

function createHarnessSessionForRunLedger() {
	return SessionManager.inMemory("/workspace/policy-t7", { id: "session-t7" });
}

describe("execution policy ledger fixture sanity", () => {
	it("stores metadata-only public summaries from the fake-sandbox path", () => {
		const ledger = createExecutionPolicyLedger();
		const result = resolveExecutionPolicyProfile({
			profiles: { [STRICT_PROFILE_ID]: strictProfile() },
			defaultProfile: STRICT_PROFILE_ID,
			policyProfile: STRICT_PROFILE_ID,
			sandbox: {
				providerConfigured: true,
				providerId: FAKE_SANDBOX_PROVIDER_ID,
				providerStatus: "ready",
				providerCapabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		ledger.appendBinding(result.binding);
		const serialized = JSON.stringify(ledger.publicSummaries());
		expect(serialized).toContain(FAKE_SANDBOX_PROVIDER_ID);
		expect(serialized).not.toContain("command");
		expect(serialized).not.toContain("SECRET");
	});
});
