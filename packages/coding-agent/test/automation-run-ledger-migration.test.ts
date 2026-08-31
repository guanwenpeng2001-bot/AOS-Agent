import { describe, expect, it } from "vitest";
import { createBindingHandle, createRunBindingAssociation } from "../src/core/binding-handles.ts";
import {
	POLICY_RESOURCE_CATEGORIES,
	resolveExecutionPolicy,
	toPublicPolicySummary,
	type PolicyDecision,
} from "../src/core/policy/execution.ts";
import {
	decodeLegacyAutomationRunLedgerEntryV1,
	migrateLegacyAutomationRunLedger,
	planLegacyAutomationRunLedgerMigrationV1,
	reconcileLegacyAutomationRunLedger,
	type LegacyAutomationRunLedgerSourceEntry,
} from "../src/core/migrations/automation-run-ledger.ts";
import { PrivateMigrationError } from "../src/core/migrations/session-entry.ts";
import type { CanonicalAutomationRunProjection } from "../src/core/session/automation-run-projection.ts";

const SESSION_ID = "session-1";
const RUN_ID = "run-1";

function accepted(bindingAssociation = createRunBindingAssociation(RUN_ID, [
	createBindingHandle({
		domain: "model",
		bindingId: "model-binding-1",
		revision: "revision-1",
		relation: "run.model",
	}),
])) {
	return {
		schemaVersion: 1 as const,
		kind: "accepted" as const,
		record: {
			id: RUN_ID,
			sessionId: SESSION_ID,
			attempt: 0,
			status: "accepted" as const,
			model: { provider: "test", id: "model", thinkingLevel: "medium" as const },
			bindingAssociation,
		},
	};
}

function started() {
	return {
		schemaVersion: 1 as const,
		kind: "started" as const,
		runId: RUN_ID,
		startedAt: "2026-01-01T00:00:01.000Z",
	};
}

function terminal(status: "completed" | "failed" | "cancelled" = "completed") {
	return {
		schemaVersion: 1 as const,
		kind: "terminal" as const,
		receipt: {
			runId: RUN_ID,
			sessionId: SESSION_ID,
			status,
			...(status === "completed" ? { finalText: "done" } : {}),
			usage: { input: 1, output: 2, total: 3 },
			...(status === "failed"
				? { terminalError: { code: "model_error", message: "failed", retryable: false } }
				: {}),
		},
		endedAt: "2026-01-01T00:00:02.000Z",
	};
}

function fullAccepted() {
	const entry = accepted();
	return {
		...entry,
		record: {
			...entry.record,
			requestScope: "start" as const,
			clientRequestId: "request-1",
			requestFingerprint: "a".repeat(64),
			external: { namespace: "test", externalSessionId: "external-session", externalRunId: "external-run" },
			deadlineAt: "2026-01-01T00:01:00.000Z",
			sourceRunId: "run-0",
			previousBindingId: "binding-0",
			capabilityBindingId: `binding:${"b".repeat(43)}`,
			modelBindingId: "model-binding-1",
			previousModelBindingId: "model-binding-0",
			policyBindingId: "policy-binding-1",
			previousPolicyBindingId: "policy-binding-0",
			finalModel: { provider: "test", id: "selected", modelId: "model", thinkingLevel: "high" as const },
			modelAttempts: [
				{
					attemptId: "attempt-1",
					bindingId: "model-binding-1",
					candidate: { provider: "test", modelId: "model" },
					order: 0,
					status: "completed" as const,
					startedAt: "2026-01-01T00:00:00.000Z",
					endedAt: "2026-01-01T00:00:01.000Z",
					failureCategory: "none",
					usage: {
						input: 1,
						output: 2,
						total: 3,
						inputTokens: 1,
						outputTokens: 2,
						totalTokens: 3,
						costUsd: 0.1,
						cost: 0.1,
					},
					visibleOutput: true,
					contextSnapshotId: "context-1",
					summary: "selected candidate",
				},
			],
			modelBudget: {
				modelCalls: 1,
				inputTokens: 1,
				outputTokens: 2,
				totalTokens: 3,
				costUsd: 0.1,
				maxModelCalls: 2,
				maxInputTokens: 10,
				maxOutputTokens: 10,
				maxTotalTokens: 20,
				maxCostUsd: 1,
				exceeded: false,
			},
			policySummary: {
				bindingId: "policy-binding-1",
				profileId: "profile-1",
				profileRevision: "revision-1",
				projectTrust: "trusted" as const,
				enforcement: "sandbox" as const,
				sandboxProviderId: "sandbox-1",
				sandboxStatus: "ready" as const,
				sandboxCapabilities: {
					filesystem: true,
					process: true,
					network: false,
					credentialIsolation: true,
				},
				resource: "filesystem.read" as const,
				action: "allow" as const,
				outcome: "allow" as const,
				reasonCode: "policy_denied" as const,
				requestId: "policy-request-1",
				timestamp: "2026-01-01T00:00:00.000Z",
			},
		},
	};
}

function producerPolicySummary(resource: PolicyDecision["resource"]) {
	const resolution = resolveExecutionPolicy({
		operation: { resource: "capability.invoke", source: "builtin" },
		createdAt: "2026-01-01T00:00:00.000Z",
		runId: RUN_ID,
		workspaceIdentity: "workspace-1",
	});
	if (!resolution.ok) throw new Error("Expected the policy fixture to resolve");
	const binding = {
		...resolution.binding,
		sandboxCapabilities: { ...resolution.binding.sandboxCapabilities, credentialDelivery: true },
	};
	const decision = {
		bindingId: binding.id,
		profileId: binding.profileId,
		profileRevision: binding.profileRevision,
		projectTrust: binding.projectTrust,
		enforcement: binding.enforcement,
		resource,
		source: "system",
		action: "allow",
		outcome: "allow",
		hardDeny: false,
		timestamp: "2026-01-01T00:00:00.000Z",
	} satisfies PolicyDecision;
	return toPublicPolicySummary(binding, decision);
}

function fullTerminal() {
	const entry = terminal("failed");
	return {
		...entry,
		receipt: {
			...entry.receipt,
			external: { namespace: "test", externalSessionId: "external-session", externalRunId: "external-run" },
			deadlineAt: "2026-01-01T00:01:00.000Z",
			finalText: "failed safely",
			sessionFile: "session.jsonl",
			terminalError: { code: "task_credential_unavailable" as const, message: "unavailable", retryable: false },
			contextSnapshotId: "context-1",
			capabilityBindingId: `binding:${"b".repeat(43)}`,
			modelBindingId: "model-binding-1",
			previousModelBindingId: "model-binding-0",
			policyBindingId: "policy-binding-1",
			previousPolicyBindingId: "policy-binding-0",
			attachments: [
				{
					sourceId: "s".repeat(43),
					kind: "resource" as const,
					descriptorId: `mcp_resource:source:${"d".repeat(43)}:resource`,
					revision: `rev:${"r".repeat(43)}`,
					capabilityBindingId: `binding:${"b".repeat(43)}`,
					policyBindingId: "policy-binding-1",
					contentDigest: "c".repeat(64),
					byteCount: 10,
					blockCount: 1,
					mimeTypes: ["text/plain"],
				},
			],
			finalModel: fullAccepted().record.finalModel,
			modelAttempts: fullAccepted().record.modelAttempts,
			modelBudget: fullAccepted().record.modelBudget,
			policySummary: fullAccepted().record.policySummary,
			bindingAssociation: accepted().record.bindingAssociation,
		},
	};
}

function source(sequence: number, entryId: string, data: unknown): LegacyAutomationRunLedgerSourceEntry {
	return { sequence, entryId, data };
}

interface CanonicalProjectionOptions {
	readonly usage?: { readonly input: number; readonly output: number; readonly total: number };
	readonly terminalError?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

function canonicalProjection(
	status: "completed" | "failed" | "cancelled" = "completed",
	options: CanonicalProjectionOptions = {},
): CanonicalAutomationRunProjection {
	const terminalError = options.terminalError ?? (status === "completed"
		? undefined
		: { code: `canonical_${status}`, message: status, retryable: false });
	return {
		id: RUN_ID,
		sessionId: SESSION_ID,
		status,
		startedAt: "2026-01-01T00:00:01.000Z",
		endedAt: "2026-01-01T00:00:02.000Z",
		...(terminalError === undefined ? {} : { terminalError }),
		terminal: {
			runId: RUN_ID,
			sessionId: SESSION_ID,
			status,
			usage: options.usage ?? { input: 1, output: 2, total: 3 },
			...(terminalError === undefined ? {} : { terminalError }),
		},
		canonicalResult: {
			runReceiptId: "canonical-run-receipt-1",
			taskResultId: "canonical-task-result-1",
			attemptReceiptIds: ["canonical-attempt-receipt-1"],
			taskSummary: "canonical summary",
			sideEffectState: "none",
		},
	};
}

describe("private automation.run ledger migration", () => {
	it("replays accepted, started, and terminal facts in deterministic ledger order", () => {
		const entries = [
			source(3, "terminal", terminal()),
			source(1, "accepted", accepted()),
			source(2, "started", started()),
			source(4, "terminal-replay", terminal()),
		];
		const result = migrateLegacyAutomationRunLedger(SESSION_ID, entries);
		const reversedPlan = planLegacyAutomationRunLedgerMigrationV1(SESSION_ID, [...entries].reverse());
		const plan = planLegacyAutomationRunLedgerMigrationV1(SESSION_ID, entries);

		expect(result.runs).toHaveLength(1);
		expect(result.runs[0]).toMatchObject({
			runId: RUN_ID,
			status: "completed",
			startedAt: "2026-01-01T00:00:01.000Z",
			endedAt: "2026-01-01T00:00:02.000Z",
			terminal: { status: "completed", finalText: "done" },
		});
		expect(result.runs[0]?.bindingAssociationView?.runId).toBe(RUN_ID);
		expect(result.runs[0]?.terminal).not.toHaveProperty("bindingAssociation");
		expect(result.runs[0]).not.toHaveProperty("recovery");
		expect(reversedPlan).toEqual(plan);
	});

	it("treats equivalent accepted and started duplicates as no-ops", () => {
		const result = migrateLegacyAutomationRunLedger(SESSION_ID, [
			source(1, "accepted-a", accepted()),
			source(2, "accepted-b", accepted()),
			source(3, "started-a", started()),
			source(4, "started-b", started()),
		]);
		expect(result.runs).toEqual([
			expect.objectContaining({ runId: RUN_ID, status: "running", recovery: "interrupted" }),
		]);
	});

	it("fails closed when mixed legacy entries disagree on the derived binding view", () => {
		const conflictingAssociation = createRunBindingAssociation(RUN_ID, [
			createBindingHandle({
				domain: "model",
				bindingId: "model-binding-2",
				revision: "revision-2",
				relation: "run.model",
			}),
		]);
		expect(() =>
			migrateLegacyAutomationRunLedger(SESSION_ID, [
				source(1, "accepted-a", accepted()),
				source(2, "accepted-b", accepted(conflictingAssociation)),
			]),
		).toThrow("accepted fact conflicts");
	});

	it("fails closed on conflicting terminal facts", () => {
		expect(() =>
			migrateLegacyAutomationRunLedger(SESSION_ID, [
				source(1, "accepted", accepted()),
				source(2, "started", started()),
				source(3, "completed", terminal("completed")),
				source(4, "failed", terminal("failed")),
			]),
		).toThrow("terminal fact conflicts");
	});

	it("decodes the complete record, receipt, error, and nested metadata contracts", () => {
		expect(decodeLegacyAutomationRunLedgerEntryV1(fullAccepted())).toEqual(fullAccepted());
		expect(decodeLegacyAutomationRunLedgerEntryV1(fullTerminal())).toEqual(fullTerminal());
		const result = migrateLegacyAutomationRunLedger(SESSION_ID, [
			source(1, "accepted", fullAccepted()),
			source(2, "started", started()),
			source(3, "terminal", fullTerminal()),
		]);
		expect(result.runs[0]?.terminal).toMatchObject({
			terminalError: { code: "task_credential_unavailable" },
			attachments: [{ kind: "resource", mimeTypes: ["text/plain"] }],
			policySummary: { bindingId: "policy-binding-1" },
		});
		expect(result.runs[0]).toMatchObject({
			requestScope: "start",
			clientRequestId: "request-1",
			requestFingerprint: "a".repeat(64),
			external: { namespace: "test", externalSessionId: "external-session", externalRunId: "external-run" },
			finalModel: { provider: "test", id: "selected", modelId: "model", thinkingLevel: "high" },
			modelAttempts: [{ attemptId: "attempt-1", status: "completed" }],
			modelBudget: { maxModelCalls: 2, exceeded: false },
			policySummary: { bindingId: "policy-binding-1" },
		});
		expect(result.runs[0]?.bindingAssociationView).toEqual(accepted().record.bindingAssociation);
		expect(result.runs[0]?.terminal).not.toHaveProperty("bindingAssociation");
	});

	it("accepts every producer policy resource and optional credential delivery capability", () => {
		for (const resource of POLICY_RESOURCE_CATEGORIES) {
			const policySummary = producerPolicySummary(resource);
			const entry = fullAccepted();
			const producerEntry = { ...entry, record: { ...entry.record, policySummary } };
			const decoded = decodeLegacyAutomationRunLedgerEntryV1(producerEntry);
			if (decoded.kind !== "accepted") throw new Error("Expected an accepted automation fact");
			expect(decoded.record.policySummary).toEqual(policySummary);
			expect(decoded.record.policySummary?.sandboxCapabilities.credentialDelivery).toBe(true);
		}
	});

	it("fails closed on invalid nested metadata", () => {
		const acceptedEntry = fullAccepted();
		const terminalEntry = fullTerminal();
		const invalidEntries = [
			{ ...acceptedEntry, record: { ...acceptedEntry.record, model: { ...acceptedEntry.record.model, extra: true } } },
			{ ...acceptedEntry, record: { ...acceptedEntry.record, finalModel: { provider: "https://unsafe", modelId: "model" } } },
			{
				...acceptedEntry,
				record: {
					...acceptedEntry.record,
					modelAttempts: [{ ...acceptedEntry.record.modelAttempts[0], usage: { input: -1 } }],
				},
			},
			{
				...acceptedEntry,
				record: {
					...acceptedEntry.record,
					policySummary: {
						...acceptedEntry.record.policySummary,
						sandboxCapabilities: { ...acceptedEntry.record.policySummary.sandboxCapabilities, authority: true },
					},
				},
			},
			{
				...acceptedEntry,
				record: {
					...acceptedEntry.record,
					policySummary: {
						...acceptedEntry.record.policySummary,
						sandboxCapabilities: {
							...acceptedEntry.record.policySummary.sandboxCapabilities,
							credentialDelivery: "yes",
						},
					},
				},
			},
			{
				...acceptedEntry,
				record: {
					...acceptedEntry.record,
					policySummary: { ...acceptedEntry.record.policySummary, resource: "credential.task.rotate" },
				},
			},
			{
				...terminalEntry,
				receipt: { ...terminalEntry.receipt, terminalError: { code: "not_real", message: "bad", retryable: false } },
			},
			{
				...terminalEntry,
				receipt: {
					...terminalEntry.receipt,
					attachments: [{ ...terminalEntry.receipt.attachments[0], contentDigest: "bad" }],
				},
			},
		];
		for (const entry of invalidEntries) {
			expect(() => decodeLegacyAutomationRunLedgerEntryV1(entry)).toThrow(PrivateMigrationError);
		}
	});

	it("rejects terminal before started while retaining orphan handling", () => {
		expect(() =>
			migrateLegacyAutomationRunLedger(SESSION_ID, [
				source(1, "accepted", accepted()),
				source(2, "terminal", terminal()),
			]),
		).toThrow("precedes started");
		expect(() => migrateLegacyAutomationRunLedger(SESSION_ID, [source(1, "terminal", terminal())])).toThrow("orphaned");
	});

	it("fails closed on orphan facts, duplicate order, and non-exact historical shapes", () => {
		expect(() =>
			migrateLegacyAutomationRunLedger(SESSION_ID, [source(1, "started", started())]),
		).toThrow("orphaned");
		expect(() =>
			migrateLegacyAutomationRunLedger(SESSION_ID, [
				source(1, "accepted", accepted()),
				source(1, "started", started()),
			]),
		).toThrow("repeats sequence");
		expect(() =>
			decodeLegacyAutomationRunLedgerEntryV1({ ...started(), lifecycleClaim: "running" }),
		).toThrow(PrivateMigrationError);
		expect(() =>
			decodeLegacyAutomationRunLedgerEntryV1({
				...accepted(),
				record: { ...accepted().record, status: "completed" },
			}),
		).toThrow("accepted-state invariants");
	});

	it("records equivalent legacy terminal data as migration evidence", () => {
		const canonical = canonicalProjection();
		const result = reconcileLegacyAutomationRunLedger(
			SESSION_ID,
			[source(1, "accepted", accepted()), source(2, "started", started()), source(3, "terminal", terminal())],
			[canonical],
		);
		expect(result.runs).toEqual([canonical]);
		expect(result.evidence).toEqual([{ runId: RUN_ID, disposition: "canonical_equal" }]);
	});

	it("accepts equal legacy usage and terminal error", () => {
		const canonical = canonicalProjection("failed", {
			terminalError: { code: "model_error", message: "failed", retryable: false },
		});
		const result = reconcileLegacyAutomationRunLedger(
			SESSION_ID,
			[source(1, "accepted", accepted()), source(2, "started", started()), source(3, "terminal", terminal("failed"))],
			[canonical],
		);
		expect(result.runs).toEqual([canonical]);
		expect(result.evidence).toEqual([{ runId: RUN_ID, disposition: "canonical_equal" }]);
	});

	it("fails closed when legacy usage conflicts with canonical usage", () => {
		expect(() => reconcileLegacyAutomationRunLedger(
			SESSION_ID,
			[source(1, "accepted", accepted()), source(2, "started", started()), source(3, "terminal", terminal())],
			[canonicalProjection("completed", { usage: { input: 1, output: 2, total: 4 } })],
		)).toThrow(/conflicts with canonical Run/u);
	});

	it("fails closed when legacy terminal error conflicts with the canonical error", () => {
		expect(() => reconcileLegacyAutomationRunLedger(
			SESSION_ID,
			[source(1, "accepted", accepted()), source(2, "started", started()), source(3, "terminal", terminal("failed"))],
			[canonicalProjection("failed", {
				terminalError: { code: "different_error", message: "failed", retryable: false },
			})],
		)).toThrow(/conflicts with canonical Run/u);
	});

	it("migrates complete legacy evidence only when the canonical receipt is missing", () => {
		const result = reconcileLegacyAutomationRunLedger(
			SESSION_ID,
			[source(1, "accepted", accepted()), source(2, "started", started()), source(3, "terminal", terminal())],
			[],
		);
		expect(result.evidence).toEqual([{ runId: RUN_ID, disposition: "legacy_migrated" }]);
		expect(result.runs).toEqual([
			{
				id: RUN_ID,
				sessionId: SESSION_ID,
				status: "completed",
				startedAt: "2026-01-01T00:00:01.000Z",
				endedAt: "2026-01-01T00:00:02.000Z",
				terminal: {
					runId: RUN_ID,
					sessionId: SESSION_ID,
					status: "completed",
					usage: { input: 1, output: 2, total: 3 },
				},
				migration: {
					sourceKind: "automation.run",
					sourceSchemaVersion: 1,
					disposition: "legacy_migrated",
				},
			},
		]);
		expect(result.runs[0]?.terminal).not.toHaveProperty("finalText");
		expect(result.runs[0]).not.toHaveProperty("canonicalResult");
	});

	it("preserves legacy usage and error in the complete migrated current record", () => {
		const result = reconcileLegacyAutomationRunLedger(
			SESSION_ID,
			[source(1, "accepted", accepted()), source(2, "started", started()), source(3, "terminal", terminal("failed"))],
			[],
		);
		expect(result.runs[0]).toMatchObject({
			status: "failed",
			terminalError: { code: "model_error", message: "failed", retryable: false },
			terminal: {
				status: "failed",
				terminalError: { code: "model_error", message: "failed", retryable: false },
				usage: { input: 1, output: 2, total: 3 },
			},
			migration: { sourceKind: "automation.run", sourceSchemaVersion: 1, disposition: "legacy_migrated" },
		});
	});

	it("does not invent a terminal Run from incomplete legacy evidence", () => {
		const result = reconcileLegacyAutomationRunLedger(
			SESSION_ID,
			[source(1, "accepted", accepted()), source(2, "started", started())],
			[],
		);
		expect(result.runs).toEqual([]);
		expect(result.evidence).toEqual([{ runId: RUN_ID, disposition: "legacy_incomplete" }]);
	});

	it("fails closed when complete legacy evidence conflicts with canonical terminal truth", () => {
		expect(() => reconcileLegacyAutomationRunLedger(
			SESSION_ID,
			[source(1, "accepted", accepted()), source(2, "started", started()), source(3, "terminal", terminal())],
			[canonicalProjection("failed")],
		)).toThrow(/conflicts with canonical Run/u);
	});
});
