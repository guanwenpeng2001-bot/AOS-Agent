import { describe, expect, it } from "vitest";

import {
	AUDIT_CONTRACT_CASES,
	AUDIT_CURSOR_SORT_KEYS,
	AUDIT_DEFAULT_LIMIT,
	AUDIT_ERROR_CODES,
	AUDIT_EVENT_TYPES,
	AUDIT_EXCLUDED_CUSTOM_TYPES,
	AUDIT_FORBIDDEN_KEYS,
	AUDIT_MAX_LIMIT,
	AUDIT_NO_SIDE_EFFECT_OPERATIONS,
	AUDIT_PUBLIC_SUMMARY_KEYS,
	AUDIT_QUERY_COMMAND,
	AUDIT_QUERY_SCOPES,
	AUDIT_REPLAY_COMMAND,
	AUDIT_REPLAY_STATUSES,
	AUDIT_SCHEMA_VERSION,
	AUDIT_SOURCE_CUSTOM_TYPES,
	AUDIT_WARNING_CODES,
	EXTERNAL_EXECUTION_REF_KEYS,
	EXTERNAL_MAP_COMMAND,
	EXTERNAL_MAPPING_KEYS,
} from "./fixtures/execution-audit-contract.ts";

describe("execution audit T0 contract", () => {
	it("freezes the v1 commands, event union, and source types", () => {
		expect(AUDIT_SCHEMA_VERSION).toBe(1);
		expect(AUDIT_QUERY_COMMAND).toBe("audit.query");
		expect(AUDIT_REPLAY_COMMAND).toBe("audit.replay");
		expect(EXTERNAL_MAP_COMMAND).toBe("external.map");
		expect(AUDIT_SOURCE_CUSTOM_TYPES).toEqual([
			"automation.run",
			"model.binding",
			"model.attempt",
			"context.snapshot",
			"capability.binding",
			"policy.binding",
			"policy.decision",
			"policy.approval",
			"sandbox.lifecycle",
			"policy.violation",
			"external.mapping",
			"task.gate",
		]);
		expect(AUDIT_EXCLUDED_CUSTOM_TYPES).toEqual(["context.memory"]);
		expect(AUDIT_EVENT_TYPES).toEqual([
			"run.accepted",
			"run.started",
			"run.completed",
			"run.failed",
			"run.cancelled",
			"run.interrupted",
			"model.binding",
			"model.attempt",
			"context.snapshot",
			"capability.binding",
			"policy.binding",
			"policy.decision",
			"policy.approval",
			"sandbox.lifecycle",
			"policy.violation",
			"external.mapping",
			"task.gate",
		]);
	});

	it("freezes replay, warning, error, and pagination domains", () => {
		expect(AUDIT_REPLAY_STATUSES).toEqual(["complete", "interrupted", "incomplete"]);
		expect(AUDIT_QUERY_SCOPES).toEqual(["current-session", "session-directory"]);
		expect(AUDIT_WARNING_CODES).toEqual([
			"unknown_source",
			"malformed_source",
			"unsupported_schema",
			"orphan_source",
			"duplicate_source",
			"source_unavailable",
			"ambiguous_run_association",
			"mapping_conflict",
		]);
		expect(AUDIT_ERROR_CODES).toEqual([
			"audit_query_invalid",
			"audit_cursor_invalid",
			"audit_scope_unavailable",
			"audit_run_not_found",
			"audit_replay_incomplete",
			"external_mapping_invalid",
			"external_mapping_conflict",
			"audit_persistence_failed",
		]);
		expect(AUDIT_DEFAULT_LIMIT).toBe(50);
		expect(AUDIT_MAX_LIMIT).toBe(200);
		expect(AUDIT_CURSOR_SORT_KEYS).toEqual(["recordedAt", "sessionId", "sourceEntryId", "eventId"]);
	});

	it("freezes external mapping keys and public summary allowlists", () => {
		expect(EXTERNAL_EXECUTION_REF_KEYS).toEqual(["namespace", "externalSessionId", "externalRunId"]);
		expect(EXTERNAL_MAPPING_KEYS).toEqual([
			"namespace",
			"externalSessionId",
			"externalRunId",
			"aosSessionId",
			"aosRunId",
			"createdAt",
			"source",
			"correlationId",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.run).toEqual([
			"status",
			"attempt",
			"model",
			"sourceRunId",
			"previousBindingId",
			"capabilityBindingId",
			"modelBindingId",
			"previousModelBindingId",
			"policyBindingId",
			"previousPolicyBindingId",
			"contextSnapshotId",
			"startedAt",
			"endedAt",
			"terminalError",
			"finalModel",
			"modelBudget",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.modelBinding).toEqual([
			"bindingId",
			"mode",
			"routeId",
			"role",
			"candidates",
			"fallback",
			"budget",
			"configRevision",
			"createdAt",
			"previousModelBindingId",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.modelAttempt).toEqual([
			"attemptId",
			"bindingId",
			"candidate",
			"order",
			"status",
			"startedAt",
			"endedAt",
			"failureCategory",
			"usage",
			"visibleOutput",
			"contextSnapshotId",
			"summary",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.contextSnapshot).toEqual([
			"schemaVersion",
			"id",
			"purpose",
			"sessionId",
			"runId",
			"createdAt",
			"parentSnapshotId",
			"sources",
			"budget",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.contextSource).toEqual([
			"kind",
			"scope",
			"trust",
			"visibility",
			"contentDigest",
			"estimatedTokens",
			"disposition",
			"reason",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.policySummary).toEqual([
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
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.taskGate).toEqual([
			"gateId",
			"taskId",
			"stageId",
			"stageRevision",
			"status",
			"action",
			"revision",
			"requestedAt",
			"decidedAt",
			"runId",
			"actorId",
			"reasonCode",
		]);
		expect(AUDIT_PUBLIC_SUMMARY_KEYS.externalMapping).toBe(EXTERNAL_MAPPING_KEYS);
	});

	it("keeps forbidden data and side effects outside the contract", () => {
		const forbiddenKeys = new Set<string>(AUDIT_FORBIDDEN_KEYS);
		for (const summaryKeys of Object.values(AUDIT_PUBLIC_SUMMARY_KEYS)) {
			for (const key of summaryKeys) expect(forbiddenKeys.has(key), key).toBe(false);
		}

		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("SessionManager.appendCustomEntry");
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("ModelBroker provider call or fallback");
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("Policy authorize/approve/reject");
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("SandboxProvider.prepare/execute/dispose");
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("Context memory write");
		expect(AUDIT_NO_SIDE_EFFECT_OPERATIONS).toContain("TaskGateStore mutation (task.gate.request/approve/reject/cancel)");
		for (const testCase of AUDIT_CONTRACT_CASES) expect(testCase.sideEffects, testCase.id).toEqual([]);
	});

	it("keeps the replay/error distinction explicit", () => {
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "accepted-without-terminal-is-interrupted")?.expectedStatus).toBe(
			"interrupted",
		);
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "malformed-source-is-incomplete")?.expectedStatus).toBe("incomplete");
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "missing-run-is-an-error")?.expectedError).toBe("audit_run_not_found");
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "bad-cursor-is-an-error")?.expectedError).toBe("audit_cursor_invalid");
		expect(AUDIT_CONTRACT_CASES.find((testCase) => testCase.id === "mapping-persistence-failure-is-an-error")?.expectedError).toBe(
			"audit_persistence_failed",
		);
	});
});
