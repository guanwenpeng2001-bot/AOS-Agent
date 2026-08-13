import { describe, expect, it } from "vitest";
import { type ExecutionPolicyProfile, type PolicyBinding, resolveExecutionPolicy } from "../src/core/execution-policy.ts";
import {
	createExecutionPolicyLedger,
	createPolicyBindingLedgerRecord,
	EXECUTION_POLICY_LEDGER_SCHEMA_VERSION,
	POLICY_APPROVAL_CUSTOM_TYPE,
	POLICY_DECISION_CUSTOM_TYPE,
	POLICY_VIOLATION_CUSTOM_TYPE,
	SANDBOX_LIFECYCLE_CUSTOM_TYPE,
	type PolicyLedgerSession,
	type PolicyLedgerSessionEntry,
} from "../src/core/execution-policy-ledger.ts";

class MemoryPolicyLedgerSession implements PolicyLedgerSession {
	private readonly entries: PolicyLedgerSessionEntry[] = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({ id, type: "custom", customType, data });
		return id;
	}

	getEntries(): ReadonlyArray<PolicyLedgerSessionEntry> {
		return this.entries;
	}
}

class FailingPolicyLedgerSession implements PolicyLedgerSession {
	appendCustomEntry(): string {
		throw new Error("disk full: token=secret");
	}

	getEntries(): ReadonlyArray<PolicyLedgerSessionEntry> {
		return [];
	}
}

const hostProfile: ExecutionPolicyProfile = {
	id: "host-safe",
	enforcement: "host",
	defaultAction: "deny",
	workspace: { read: ["workspace"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
	process: { action: "ask", inheritEnvironment: false, allowEnvironment: ["PATH", "LANG"] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "ask", process: "ask" },
};

function resolveHostPolicy(options: { readonly previousPolicyBindingId?: string; readonly runId?: string } = {}) {
	return resolveExecutionPolicy({
		profiles: { [hostProfile.id]: hostProfile },
		defaultProfile: hostProfile.id,
		runId: options.runId ?? "run-ledger",
		workspaceIdentity: "workspace-ledger",
		createdAt: "2026-08-13T00:00:00.000Z",
		previousPolicyBindingId: options.previousPolicyBindingId,
		operation: {
			resource: "process.spawn",
			source: "user_bash",
			id: "request-process",
			command: "cat C:\\private\\secret.txt",
			args: ["--token", "secret"],
			cwd: "C:\\private",
			environmentNames: ["PATH"],
		},
	});
}

describe("execution policy ledger", () => {
	it("creates immutable binding facts from resolver-owned binding data", () => {
		const resolved = resolveHostPolicy();
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;

		const record = createPolicyBindingLedgerRecord(resolved.binding);

		expect(record.id).toBe(resolved.binding.id);
		expect(record.profileId).toBe("host-safe");
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record.constraints.workspace.read)).toBe(true);
		expect(() => {
			(record as { profileId: string }).profileId = "changed";
		}).toThrow();
		expect(record.constraints.process.allowedEnvironmentCount).toBe(2);
	});

	it("records successor bindings without reusing approval requests or sandbox handles", () => {
		const first = resolveHostPolicy({ runId: "run-ledger-1" });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = resolveHostPolicy({ runId: "run-ledger-2", previousPolicyBindingId: first.binding.id });
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		const ledger = createExecutionPolicyLedger();
		ledger.appendBinding(first.binding);
		if (first.approval !== undefined) ledger.appendApproval(first.approval);
		const unsafeLifecycle = {
			bindingId: first.binding.id,
			status: "ready" as const,
			providerId: "fake-sandbox",
			timestamp: "2026-08-13T00:00:01.000Z",
			capabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
			sandboxHandleId: "handle-1",
			providerTempPath: "C:\\Temp\\sandbox-secret",
		};
		ledger.appendSandboxLifecycle(unsafeLifecycle);
		ledger.appendBinding(second.binding);

		const successor = ledger.query({ bindingId: second.binding.id })[0];
		expect(successor?.record).toMatchObject({
			id: second.binding.id,
			previousPolicyBindingId: first.binding.id,
		});
		expect(second.binding.id).not.toBe(first.binding.id);
		expect(JSON.stringify(successor)).not.toContain("request-process");
		expect(JSON.stringify(ledger.query())).not.toContain("handle-1");
		expect(JSON.stringify(ledger.query())).not.toContain("sandbox-secret");
	});

	it("redacts by allowlist and never persists raw operation, path, environment, credential, provider, or self-report fields", () => {
		const resolved = resolveHostPolicy();
		expect(resolved.ok).toBe(true);
		if (!resolved.ok || resolved.decision === undefined || resolved.approval === undefined) return;

		const session = new MemoryPolicyLedgerSession();
		const ledger = createExecutionPolicyLedger(session);
		const unsafeBinding = {
			...resolved.binding,
			command: "cat C:\\private\\secret.txt",
			args: ["--token", "secret"],
			cwd: "C:\\private",
			env: { API_TOKEN: "secret" },
			headers: { authorization: "Bearer secret" },
			credential: "MODEL_TOKEN",
			providerProcessPath: "C:\\provider\\worker.exe",
			tempPath: "C:\\Temp\\provider-secret",
			agentSelfReport: "I did not read C:\\private\\secret.txt",
		};

		ledger.appendBinding(unsafeBinding as PolicyBinding);
		ledger.appendDecision({
			...resolved.decision,
			command: "cat C:\\private\\secret.txt",
			env: { API_TOKEN: "secret" },
			agentSelfReport: "safe",
		} as typeof resolved.decision);
		ledger.appendApproval({
			...resolved.approval,
			args: ["--token", "secret"],
			credentials: ["MODEL_TOKEN"],
		} as typeof resolved.approval);

		const persisted = JSON.stringify(session.getEntries());
		expect(persisted).not.toContain("secret.txt");
		expect(persisted).not.toContain("--token");
		expect(persisted).not.toContain("C:\\private");
		expect(persisted).not.toContain("API_TOKEN");
		expect(persisted).not.toContain("authorization");
		expect(persisted).not.toContain("MODEL_TOKEN");
		expect(persisted).not.toContain("worker.exe");
		expect(persisted).not.toContain("provider-secret");
		expect(persisted).not.toContain("agentSelfReport");
	});

	it("keeps safe event types ordered and queryable with public summaries", () => {
		const resolved = resolveHostPolicy();
		expect(resolved.ok).toBe(true);
		if (!resolved.ok || resolved.decision === undefined || resolved.approval === undefined) return;

		const ledger = createExecutionPolicyLedger();
		ledger.appendBinding(resolved.binding);
		ledger.appendDecision(resolved.decision);
		ledger.appendApproval(resolved.approval);
		ledger.appendSandboxLifecycle({ bindingId: resolved.binding.id, status: "disposed", timestamp: "2026-08-13T00:00:02.000Z" });
		ledger.appendViolation({
			bindingId: resolved.binding.id,
			timestamp: "2026-08-13T00:00:03.000Z",
			reasonCode: "policy_violation",
			resource: "process.spawn",
			requestId: "request-process",
		});

		expect(ledger.query().map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
		expect(ledger.query().map((event) => event.customType)).toEqual([
			"policy.binding",
			POLICY_DECISION_CUSTOM_TYPE,
			POLICY_APPROVAL_CUSTOM_TYPE,
			SANDBOX_LIFECYCLE_CUSTOM_TYPE,
			POLICY_VIOLATION_CUSTOM_TYPE,
		]);
		expect(ledger.query({ customType: POLICY_DECISION_CUSTOM_TYPE })).toHaveLength(1);
		expect(ledger.query({ sinceSequence: 3 }).map((event) => event.sequence)).toEqual([3, 4, 5]);
		expect(ledger.publicSummaries()[0]).toMatchObject({ bindingId: resolved.binding.id, enforcement: "host" });
		expect(JSON.stringify(ledger.publicSummaries())).not.toContain("command");
	});

	it("throws stable strict persistence failure without appending in-memory state", () => {
		const resolved = resolveHostPolicy();
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;

		const ledger = createExecutionPolicyLedger(new FailingPolicyLedgerSession());

		let failure: unknown;
		try {
			ledger.appendBinding(resolved.binding);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			code: "policy_ledger_persistence_failed",
			message: "The policy decision could not be recorded safely.",
			retryable: false,
		});
		expect(ledger.query()).toHaveLength(0);
		expect(EXECUTION_POLICY_LEDGER_SCHEMA_VERSION).toBe(1);
	});
});
