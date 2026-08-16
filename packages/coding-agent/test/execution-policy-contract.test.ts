import { describe, expect, it } from "vitest";

import {
	LEGACY_PROFILE_FIXTURE,
	POLICY_ACTIONS,
	POLICY_APPROVE_COMMAND,
	POLICY_BINDING_CUSTOM_TYPE,
	POLICY_CONTRACT_CASES,
	POLICY_DECISION_OUTCOMES,
	POLICY_DEFAULT_PROFILE,
	POLICY_ENFORCEMENTS,
	POLICY_ERROR_CODES,
	POLICY_LEDGER_EVENT_TYPES,
	POLICY_PUBLIC_SUMMARY_KEYS,
	POLICY_QUERY_COMMAND,
	POLICY_REJECT_COMMAND,
	POLICY_RESOURCES,
	POLICY_RUN_FIELD,
	POLICY_SETTINGS_KEY,
	STRICT_PROFILE_FIXTURE,
} from "./fixtures/execution-policy-contract.ts";

describe("execution policy T0 contract", () => {
	it("freezes policy domains and public entry names", () => {
		expect(POLICY_ACTIONS).toEqual(["allow", "ask", "deny"]);
		expect(POLICY_ENFORCEMENTS).toEqual(["legacy", "host", "sandbox"]);
		expect(POLICY_RESOURCES).toEqual([
			"capability.invoke",
			"mcp.auth",
			"mcp.content.list",
			"mcp.content.read",
			"mcp.content.attach",
			"filesystem.read",
			"filesystem.write",
			"filesystem.find",
			"filesystem.grep",
			"process.spawn",
			"network.connect",
			"credential.expose",
			"sandbox.prepare",
		]);
		expect(POLICY_DECISION_OUTCOMES).toEqual(["allow", "ask", "deny", "sandbox_required"]);
		expect(POLICY_SETTINGS_KEY).toBe("executionPolicy");
		expect(POLICY_DEFAULT_PROFILE).toBe("legacy");
		expect(POLICY_RUN_FIELD).toBe("policyProfile");
		expect(POLICY_QUERY_COMMAND).toBe("get_execution_policy");
		expect(POLICY_APPROVE_COMMAND).toBe("policy.approve");
		expect(POLICY_REJECT_COMMAND).toBe("policy.reject");
		expect(POLICY_BINDING_CUSTOM_TYPE).toBe("policy.binding");
		expect(POLICY_LEDGER_EVENT_TYPES).toEqual([
			"policy.binding",
			"policy.decision",
			"policy.approval",
			"sandbox.lifecycle",
			"policy.violation",
		]);
	});

	it("keeps legacy as the compatibility default", () => {
		expect(LEGACY_PROFILE_FIXTURE).toMatchObject({
			id: "legacy",
			enforcement: "legacy",
			defaultAction: "allow",
			process: { action: "allow", inheritEnvironment: true },
			network: { action: "allow" },
			credentials: { action: "allow" },
		});
	});

	it("keeps strict policy fail-closed and project trust narrowing", () => {
		expect(STRICT_PROFILE_FIXTURE).toMatchObject({
			id: "workspace-safe",
			enforcement: "sandbox",
			sandboxProvider: "fake-sandbox",
			defaultAction: "deny",
			process: { action: "ask", inheritEnvironment: false },
			network: { action: "deny" },
			credentials: { action: "deny" },
		});
		expect(STRICT_PROFILE_FIXTURE.workspace.deny).toEqual(["credentials", "agent-internal"]);

		const noSideEffectErrors = new Set([
			"sandbox_required",
			"sandbox_unavailable",
			"sandbox_capability_insufficient",
			"policy_profile_untrusted",
			"policy_approval_required",
			"policy_denied",
		]);
		for (const testCase of POLICY_CONTRACT_CASES) {
			if ("expectedError" in testCase && testCase.expectedError !== undefined && noSideEffectErrors.has(testCase.expectedError)) {
				expect(testCase.sideEffectMayStart, testCase.id).toBe(false);
			}
		}
	});

	it("does not treat Agent output as policy evidence", () => {
		const testCase = POLICY_CONTRACT_CASES.find((candidate) => candidate.id === "agent-self-report-is-not-evidence");
		expect(testCase).toBeDefined();
		expect(testCase?.agentSelfReport).toBeDefined();
		expect(testCase?.authoritativeEvidence).toBe("sandbox-provider");
		expect(testCase?.authoritativeEvidence).not.toBe("agent-self-report");
		expect(testCase?.expectedOutcome).toBe("deny");
	});

	it("keeps the public summary allowlist free of sensitive detail", () => {
		expect(POLICY_PUBLIC_SUMMARY_KEYS).toEqual([
			"bindingId",
			"profileId",
			"profileRevision",
			"projectTrust",
			"enforcement",
			"sandboxProviderId",
			"sandboxStatus",
			"sandboxCapabilities",
			"resource",
			"action",
			"outcome",
			"reasonCode",
			"requestId",
			"timestamp",
		]);

		const forbiddenKeys = new Set([
			"command",
			"args",
			"cwd",
			"path",
			"environment",
			"headers",
			"token",
			"credentials",
			"authorizationUrl",
			"providerPid",
			"tempPath",
			"agentSelfReport",
		]);
		for (const key of POLICY_PUBLIC_SUMMARY_KEYS) {
			expect(forbiddenKeys.has(key), key).toBe(false);
		}
	});

	it("keeps policy errors stable and distinct", () => {
		expect(POLICY_ERROR_CODES).toHaveLength(15);
		expect(new Set(POLICY_ERROR_CODES).size).toBe(POLICY_ERROR_CODES.length);
		expect(POLICY_ERROR_CODES).toContain("policy_approval_required");
		expect(POLICY_ERROR_CODES).toContain("sandbox_required");
		expect(POLICY_ERROR_CODES).toContain("policy_ledger_persistence_failed");
	});
});
