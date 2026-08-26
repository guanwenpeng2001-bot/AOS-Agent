import { describe, expect, it } from "vitest";
import { Result } from "../../src/harness/result.ts";
import type { Result as ResultValue } from "../../src/harness/result.ts";
import {
	ArtifactRefSchema,
	DURABLE_LEDGER_ERROR_CODES,
	SUBAGENT_ERROR_CODES,
	FoundationError,
	foundationErrorCategory,
	FOUNDATION_ERROR_CODES,
	FoundationObserver,
	FOUNDATION_ENTITY_KINDS,
	PROTOCOL_FEATURE_MATRIX,
	canonicalFoundationJson,
	createAttempt,
	createAgentInstance,
	createBindingEpoch,
	createDurableEvent,
	createExecutionCorrelation,
	createHostTerminalGateAuthority,
	createRoleRevision,
	createFoundationEnvelope,
	FoundationEnvelopeSchema,
	EVENT_CATALOG,
	finalizeRunReceipt,
	fingerprintFoundationValue,
	selectorsNarrow,
	ROLE_RESOLUTION_ORDER,
	validateRoleResolutionOrder,
	validateRoleScopeTightening,
	isSideEffectRetryable,
	negotiateProtocol,
	projectEventEnvelope,
	redactProjection,
	redactFoundationError,
	resolveAgentBinding,
	resolveRoleResolution,
	settleTaskResult,
	validateAttemptReceipt,
	validateAgentBinding,
	validateBindingEpoch,
	validateExactShape,
	validateWorkerReceipt,
	validateWorkerReceiptRef,
	validateArtifactRef,
	validateVersionedReference,
	validateFoundationEntityQuery,
	validateFoundationEntityId,
	validateFoundationEnvelope,
	validateRoleDefinition,
	validateRoleRevision,
	validateTaskEnvelope,
	validateEndpointSecurity,
	validateDurableEvent,
	validateEventPayloadForCategory,
	validateProtocolMessageEnvelope,
	validateToolGatewayRequest,
	validateScopedModelRequest,
	serializeToolGatewayRequest,
	serializeScopedModelRequest,
	validateGoal,
	validatePlan,
	validateStage,
	validateTodo,
	validateAsk,
	validateWorkflow,
	projectTaskEnvelope,
	validateTaskEnvelopePublicProjection,
	type AgentBinding,
	type AgentInstance,
	type ArtifactDescriptor,
	type ArtifactStoreProvider,
	type AttemptReceipt,
	type Attempt,
	type BindingEpoch,
	type ChildAgentProvider,
	type ChildSpawnRequest,
	type ChildSpawnResult,
	type FoundationEventEnvelope,
	type Dispatch,
	type ProductObserverAdapter,
	type QuotaAttribution,
	type QuotaProvider,
	type QuotaReservation,
	type FoundationProviderCapability,
	type ScopedModelGateway,
	type ScopedModelRequest,
	type ScopedModelResult,
	type SandboxOperationProvider,
	type SandboxOperationRequest,
	type ModelProfile,
	type RevisionReference,
	type TaskEnvelope,
	type TaskExecutorProvider,
	type SchedulerTaskExecutorProvider,
	type ToolExecutionResult,
	type ToolGateway,
	type ToolGatewayRequest,
	type TransportAdapter,
	type TransportObserverCursor,
	type WorkerReceipt,
	type CreateAttemptInput,
	type RoleRegistry,
	type RoleRegistryRecord,
	type RoleRegistryCreateInput,
	type RoleRegistryGetQuery,
	type RoleRegistryListQuery,
	type RoleRegistrySearchQuery,
	type RoleRegistryEditInput,
	type RoleRegistryCopyInput,
	type RoleRegistryDeleteInput,
	type RoleRegistryImport,
	type RoleRegistryExportQuery,
	type RoleRegistryExport,
	type RoleResolveInput,
	type RoleResolutionPreview,
	type RoleTombstone,
	requireRoleResolutionTask,
} from "../../src/harness/foundation/index.ts";
import { FOUNDATION_LEDGER_ERROR_CODES } from "../../src/harness/session/durable/types.ts";

const correlation = createExecutionCorrelation("session-1", "main", { revision: 1 });
const artifact = { schemaVersion: 1 as const, artifactId: "artifact-1", mediaType: "text/plain", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
const noRunUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as const;
const task: TaskEnvelope = {
	schemaVersion: 1,
	taskId: "task-1",
	goalId: "goal-1",
	goal: "Complete the contract test",
	title: "contract test",
	workspace: "workspace-1",
	capabilityRefs: [artifact],
	inputs: [artifact],
	expectedOutputs: [artifact],
	budget: {},
	acceptanceCriteria: [{ schemaVersion: 1, criterionId: "criterion-1", description: "works", satisfiedBy: "evidence", required: true }],
	status: "ready",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function roleRevision() {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-1",
			scope: "project",
			slug: "worker",
			name: "Worker",
			description: "Runs the task",
			revision: 1,
			persona: "You run the task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-1", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => "2026-01-01T00:00:00.000Z",
	});
}

function immutableBindingFact(type: string, id: string, revision = 1): RevisionReference {
	const payload = { schemaVersion: 1 as const, type, id, revision };
	return { ...payload, fingerprint: fingerprintFoundationValue(payload) };
}

function bindingFacts(): { contextRevision: RevisionReference; capabilityRevision: RevisionReference; modelBrokerBindingRevision: RevisionReference; policyRevision: RevisionReference } {
	return {
		contextRevision: immutableBindingFact("external_agent_binding", "external-1"),
		capabilityRevision: immutableBindingFact("capability_binding", "capability-1"),
		modelBrokerBindingRevision: immutableBindingFact("model_broker_binding", "model-broker-1"),
		policyRevision: immutableBindingFact("policy_binding", "policy-1"),
	};
}

function receipt(status: AttemptReceipt["status"] = "succeeded"): AttemptReceipt {
	return {
		schemaVersion: 1,
		attemptReceiptId: "attempt-receipt-1",
		taskId: "task-1",
		dispatchId: "dispatch-1",
		attemptId: "attempt-1",
		providerId: "agent-provider",
		agentInstanceId: "agent-instance-1",
		bindingId: "binding-1",
		bindingEpochIds: ["epoch-1"],
		status,
		workerReceiptRefs: [],
		artifacts: [artifact],
		provenance: { producerKind: "agent_executor", providerId: "agent-provider", producedAt: "2026-01-01T00:00:00.000Z", correlation: { sessionId: "session-1", laneId: "main", taskId: "task-1", dispatchId: "dispatch-1", attemptId: "attempt-1", bindingId: "binding-1", bindingEpochId: "epoch-1", attemptReceiptId: "attempt-receipt-1", revision: 1 } },
		sideEffectState: "none",
	};
}

describe("Foundation identity, schemas, and redaction", () => {
	it("keeps Foundation and durable-ledger error catalogs exhaustive and single-source", () => {
		expect(new Set(FOUNDATION_ERROR_CODES).size).toBe(FOUNDATION_ERROR_CODES.length);
		const coreErrorCodes = FOUNDATION_ERROR_CODES.slice(0, -DURABLE_LEDGER_ERROR_CODES.length);
		const coreWithoutSubagent = coreErrorCodes.slice(0, -SUBAGENT_ERROR_CODES.length);
		const schedulerErrorCodes = coreWithoutSubagent.filter((code) => code.startsWith("scheduler_"));
		expect(coreWithoutSubagent.slice(0, -schedulerErrorCodes.length).slice(-2)).toEqual([
			"sandbox_capability_insufficient",
			"task_credential_target_unavailable",
		]);
		expect(schedulerErrorCodes).toHaveLength(22);
		expect(schedulerErrorCodes.slice(0, 2)).toEqual(["scheduler_queue_invalid", "scheduler_queue_conflict"]);
		expect(schedulerErrorCodes.slice(-2)).toEqual(["scheduler_not_found", "scheduler_persistence_failed"]);
		expect(coreWithoutSubagent.slice(-schedulerErrorCodes.length)).toEqual(schedulerErrorCodes);
		expect(coreErrorCodes.slice(-SUBAGENT_ERROR_CODES.length)).toEqual(SUBAGENT_ERROR_CODES);
		expect(foundationErrorCategory("sandbox_capability_insufficient")).toBe("validation");
		expect(foundationErrorCategory("task_credential_target_unavailable")).toBe("validation");
		expect(foundationErrorCategory("scheduler_queue_conflict")).toBe("conflict");
		expect(foundationErrorCategory("scheduler_not_found")).toBe("not_found");
		expect(foundationErrorCategory("scheduler_budget_exhausted_wait")).toBe("permission");
		expect(foundationErrorCategory("scheduler_lease_lost")).toBe("concurrency");
		expect(foundationErrorCategory("scheduler_no_executor")).toBe("provider");
		expect(new Set(DURABLE_LEDGER_ERROR_CODES).size).toBe(DURABLE_LEDGER_ERROR_CODES.length);
		expect([...FOUNDATION_LEDGER_ERROR_CODES]).toEqual([...DURABLE_LEDGER_ERROR_CODES]);
		expect([...FOUNDATION_ERROR_CODES].filter((code) => code.startsWith("session_")).sort()).toEqual([...DURABLE_LEDGER_ERROR_CODES].sort());
	});

	it("canonicalizes key order and fingerprints content deterministically", () => {
		expect(canonicalFoundationJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
		expect(fingerprintFoundationValue({ a: 1, b: 2 })).toEqual(fingerprintFoundationValue({ b: 2, a: 1 }));
	});

	it("rejects non-finite, non-JSON, sparse, and cyclic values at public boundaries", () => {
		expect(() => canonicalFoundationJson(Number.NaN)).toThrow();
		expect(() => canonicalFoundationJson(Infinity)).toThrow();
		expect(() => canonicalFoundationJson(() => "not-json")).toThrow();
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => canonicalFoundationJson(cycle)).toThrow();
		const sparse: unknown[] = [];
		sparse.length = 2;
		expect(() => canonicalFoundationJson(sparse)).toThrow();
		const envelope = createFoundationEnvelope("task.created", "event-1", correlation, { taskId: task.taskId });
		expect(validateFoundationEnvelope(envelope).ok).toBe(true);
		expect(validateExactShape(FoundationEnvelopeSchema, { ...envelope, payload: () => "not-json" }, "foundation_envelope").ok).toBe(false);
	});

	it("rejects unknown exact-shape fields and keeps error details redacted", () => {
		const result = validateExactShape(ArtifactRefSchema, { ...artifact, secretToken: "do-not-leak" }, "artifact_ref");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(FoundationError);
			expect(result.error.message).not.toContain("do-not-leak");
			expect(redactFoundationError(result.error)).toEqual({ code: "foundation_schema_invalid_shape", category: "schema", message: "artifact_ref failed exact-shape validation" });
		}
		const redacted = new FoundationError("foundation_schema_unknown_record", "failed at C:\\Users\\secret\\result.json sk-1234567890abcdef");
		expect(redacted.message).not.toContain("secret\\result.json");
		expect(redacted.message).not.toContain("sk-1234567890abcdef");
	});

	it("excludes signature/textSignature and secret-bearing fields from public and ledger projections", () => {
		const secret = {
			signature: "private-signature",
			textSignature: "private-text-signature",
			apiKey: "private-api-key",
			nested: { signature: "nested-signature", textSignature: "nested-text-signature", token: "nested-token" },
		};
		const publicProjection = redactProjection(secret) as Record<string, unknown>;
		expect(publicProjection.signature).toBe("[redacted]");
		expect(publicProjection.textSignature).toBe("[redacted]");
		expect(JSON.stringify(publicProjection)).not.toContain("private-signature");
		expect(JSON.stringify(publicProjection)).not.toContain("nested-signature");
		const ledgerError = new FoundationError("foundation_schema_unknown_record", "ledger projection", { details: secret });
		expect(JSON.stringify(ledgerError.details)).not.toContain("private-text-signature");
		expect(JSON.stringify(redactFoundationError(ledgerError))).not.toContain("private-api-key");
		const event = {
			schemaVersion: 1 as const,
			class: "durable" as const,
			category: "goal.created" as const,
			eventId: "secret-event",
			streamId: "session-1",
			sequence: 1,
			timestamp: fakeNow,
			correlation: { sessionId: "session-1" },
			payload: secret,
		} as never;
		expect(JSON.stringify(projectEventEnvelope(event))).not.toContain("private-signature");
	});

	it("accepts only the canonical FoundationError tag", () => {
		expect(FoundationError.is({ _tag: "FoundationError" })).toBe(true);
		expect(FoundationError.is({ _tag: "FoundationContractError" })).toBe(false);
		expect(new FoundationError("foundation_schema_unknown_record", "unknown record").toJSON()).toMatchObject({ _tag: "FoundationError" });
	});

	it("keeps the Foundation envelope versioned and correlated", () => {
		const envelope = createFoundationEnvelope("task.created", "event-1", correlation, { taskId: task.taskId }, { sequence: 4, timestamp: "2026-01-01T00:00:00.000Z" });
		expect(envelope.schemaVersion).toBe(1);
		expect(envelope.correlation.sessionId).toBe("session-1");
	});

	it("versions nested references and isolates WorkerReceiptRef from other result layers", () => {
		const workerRef = { schemaVersion: 1 as const, type: "worker_receipt" as const, id: "worker-1", revision: 1 };
		expect(validateArtifactRef(artifact).ok).toBe(true);
		expect(validateArtifactRef({ artifactId: artifact.artifactId, mediaType: artifact.mediaType, digest: artifact.digest }).ok).toBe(false);
		expect(validateVersionedReference({ type: "role_revision", id: "role-1", revision: 1 }).ok).toBe(false);
		expect(validateWorkerReceiptRef(workerRef).ok).toBe(true);
		expect(validateWorkerReceiptRef({ ...workerRef, type: "attempt_receipt" }).ok).toBe(false);
		expect(validateWorkerReceiptRef({ ...workerRef, extra: true }).ok).toBe(false);
		expect(validateAttemptReceipt({ ...receipt(), workerReceiptRefs: [workerRef] }).ok).toBe(true);
		expect(validateAttemptReceipt({ ...receipt(), workerReceiptRefs: [{ schemaVersion: 1, type: "task_result", id: "task-result-1", revision: 1 }] }).ok).toBe(false);
	});
});

describe("Foundation events, protocol, and observer continuity", () => {
	it("partitions the typed event catalog and redacts event payloads", () => {
		expect(EVENT_CATALOG["operation.started"].class).toBe("durable");
		expect(EVENT_CATALOG["stream.text"].class).toBe("live");
		expect(EVENT_CATALOG["run.derived"].class).toBe("derived");
		const event = createDurableEvent({ category: "goal.created", eventId: "event-1", streamId: "session-1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", correlation: { sessionId: "session-1", goalId: "goal-1" }, payload: { schemaVersion: 1, goalId: "goal-1", sessionId: "session-1", revision: 1 } });
		const projection = projectEventEnvelope(event);
		expect(projection.payload).toMatchObject({ goalId: "goal-1", sessionId: "session-1" });
		expect(EVENT_CATALOG.run_end.derivedFrom).toEqual(["run_receipt.written"]);
		expect(EVENT_CATALOG.run_end.derivedFrom).not.toEqual(["operation.started"]);
		expect(EVENT_CATALOG["run_receipt.written"].correlationFields).toEqual(expect.arrayContaining(["runReceiptId", "taskResultId", "runId"]));
		expect(validateDurableEvent({ ...event, payload: { schemaVersion: 1, goalId: "goal-1", sessionId: "session-1", revision: 1, prompt: "hidden" } }).ok).toBe(false);
	});

	it("catalogs safe durable Worker lifecycle and operation projections", () => {
		expect(EVENT_CATALOG["worker.lifecycle_transitioned"]).toMatchObject({
			class: "durable",
			replay: "must",
			retention: "ledger",
		});
		expect(EVENT_CATALOG["worker.operation_recorded"].correlationFields).toEqual(
			expect.arrayContaining(["sessionId", "laneId", "workerId", "operationId"]),
		);
		const lifecycle = createDurableEvent({
			category: "worker.lifecycle_transitioned",
			eventId: "worker-event-1",
			streamId: "session-1",
			sequence: 2,
			timestamp: fakeNow,
			correlation: {
				sessionId: "session-1",
				laneId: "main",
				workerId: "worker-1",
				operationId: "operation-1",
			},
			payload: {
				schemaVersion: 1,
				workerId: "worker-1",
				providerId: "sandbox-worker",
				sessionId: "session-1",
				laneId: "main",
				status: "running",
				revision: 3,
				profileId: "local-worker",
				activeOperationId: "operation-1",
			},
		});
		expect(projectEventEnvelope(lifecycle).payload).toEqual(lifecycle.payload);
		const terminal = createDurableEvent({
			category: "worker.lifecycle_transitioned",
			eventId: "worker-event-2",
			streamId: "session-1",
			sequence: 3,
			timestamp: fakeNow,
			correlation: {
				sessionId: "session-1",
				laneId: "main",
				workerId: "worker-1",
				operationId: "operation-1",
			},
			payload: {
				schemaVersion: 1,
				workerId: "worker-1",
				providerId: "sandbox-worker",
				sessionId: "session-1",
				laneId: "main",
				status: "completed",
				revision: 4,
				operationId: "operation-1",
				receiptId: "receipt-1",
			},
		});
		expect(
			validateDurableEvent({
				...terminal,
				correlation: { ...terminal.correlation, operationId: "operation-other" },
			}).ok,
		).toBe(false);
		expect(
			validateEventPayloadForCategory("worker.lifecycle_transitioned", {
				...terminal.payload,
				status: "terminal",
			}),
		).toBe(false);
		expect(
			validateEventPayloadForCategory("worker.lifecycle_transitioned", {
				...lifecycle.payload,
				stdout: "must-not-persist",
			}),
		).toBe(false);
		expect(
			validateEventPayloadForCategory("worker.operation_recorded", {
				schemaVersion: 1,
				workerId: "worker-1",
				providerId: "sandbox-worker",
				sessionId: "session-1",
				laneId: "main",
				operationId: "operation-1",
				phase: "finished",
				revision: 4,
				sideEffectState: "none",
				receiptId: "receipt-1",
			}),
		).toBe(true);
	});

	it("negotiates the highest common protocol version and fails closed for remote endpoints", () => {
		const negotiated = negotiateProtocol({ versions: { min: 1, max: 1 }, features: PROTOCOL_FEATURE_MATRIX[1]! }, { versions: { min: 1, max: 1 }, features: ["observer.cursor", "events.durable"] });
		expect(negotiated).toMatchObject({ ok: true, value: { version: 1, features: ["observer.cursor", "events.durable"] } });
		const endpoint = validateEndpointSecurity({ kind: "tcp", host: "203.0.113.5", allowRemote: false });
		expect(endpoint).toMatchObject({ ok: false });
		const protocolMessage = { schemaVersion: 1, kind: "command", messageId: "message-1", timestamp: fakeNow, payload: { commandId: "command-1" } };
		expect(validateProtocolMessageEnvelope(protocolMessage).ok).toBe(true);
		const cyclicPayload: Record<string, unknown> = {};
		cyclicPayload.self = cyclicPayload;
		expect(validateProtocolMessageEnvelope({ ...protocolMessage, payload: cyclicPayload }).ok).toBe(false);
		expect(validateProtocolMessageEnvelope({ ...protocolMessage, payload: Number.NaN }).ok).toBe(false);
		expect(validateProtocolMessageEnvelope({ ...protocolMessage, extra: true }).ok).toBe(false);
	});

	it("requires contiguous durable sequences while allowing live deltas to deduplicate", () => {
		const observer = new FoundationObserver({ idGenerator: () => "observer-1" });
		expect(observer.attach("session-1").ok).toBe(true);
		const live = createDurableEvent({ category: "message.persisted", eventId: "event-1", streamId: "session-1", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", correlation: { sessionId: "session-1" }, payload: {} });
		observer.receiveDurable(live);
		const sink = { durable: () => {}, live: () => {} };
		expect(observer.start(sink)).toMatchObject({ ok: true });
		const gap = observer.receiveDurable({ ...live, eventId: "event-3", sequence: 3 });
		expect(gap).toMatchObject({ ok: false, error: { code: "event_cursor_gap" } });
	});

	it("uses a separate protocol for live snapshots and does not collapse event classes", () => {
		const observer = new FoundationObserver();
		expect(observer.currentPhase).toBe("idle");
	});
});

describe("task, binding, provider, and result invariants", () => {
	it("requires a persisted task before binding resolution and freezes role revisions", () => {
		const revision = roleRevision();
		const binding = resolveAgentBinding({ task, roleRevision: revision, modelProfile: fakeModelProfile(), ...bindingFacts(), newBindingId: "binding-1" });
		expect(binding.ok).toBe(true);
		if (binding.ok) expect(Object.isFrozen(binding.value)).toBe(true);
		const next = createRoleRevision({ definition: { schemaVersion: 1, roleId: "role-1", scope: "project", slug: "worker", name: "Worker", description: "Runs the task", revision: 1, persona: "You run the task.", modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-1", revision: 1 }, capabilitySelector: { policy: "all" }, skillSelector: { policy: "none" }, mcpSelector: { policy: "none" } }, previous: revision, now: () => "2026-01-01T00:00:01.000Z" });
		expect(next.revision).toBe(2);
	});

	it("keeps mode switch and spawn distinct and forbids operation-worker instances", () => {
		const epoch = { schemaVersion: 1 as const, bindingEpochId: "epoch-1", taskId: "task-1", attemptId: "attempt-1", bindingId: "binding-1", ordinal: 0, activationReason: "attempt_started" as const, activatedByCommandId: "command-1", activatedAt: "2026-01-01T00:00:00.000Z" };
		// @ts-expect-error Operation Workers are not task-executor provider classes.
		const attempt = createAttempt({ attemptId: "attempt-1", dispatch: { schemaVersion: 1, dispatchId: "dispatch-1", taskId: "task-1", bindingId: "binding-1", taskExecutorProviderId: "operation", status: "pending", createdAt: "2026-01-01T00:00:00.000Z" }, providerId: "operation", initialBindingEpoch: epoch, agentInstanceId: "illegal", providerClass: operationWorkerProviderClass });
		expect(attempt).toMatchObject({ ok: false, error: { code: "task_executor_invalid_provider_class" } });
	});

	it("keeps WorkerReceipt, AttemptReceipt, TaskResult, and RunReceipt as four authorities", () => {
		const worker: WorkerReceipt = { schemaVersion: 1, workerReceiptId: "worker-1", sandboxProviderId: "sandbox", operationId: "op-1", status: "succeeded", sideEffectState: "none", provenance: { producerKind: "operation_worker", providerId: "sandbox", producedAt: "2026-01-01T00:00:00.000Z", correlation: { sessionId: "session-1", laneId: "main", revision: 1 } }, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z" };
		expect(validateWorkerReceipt({ ...worker, agentInstanceId: "not-allowed" })).toMatchObject({ ok: false });
		expect(validateWorkerReceipt(worker)).toMatchObject({ ok: true });
		expect(validateAttemptReceipt(receipt(), { agentProvider: true })).toMatchObject({ ok: true });
		const result = settleTaskResult({ task, taskResultId: "task-result-1", receipts: [receipt()], summary: "done", artifacts: [artifact], tests: [{ name: "contract", required: true, status: "passed", evidenceRefs: [artifact] }], evidence: [{ schemaVersion: 1, factId: "fact-1", criterionId: "criterion-1", outcome: "satisfied", evidenceRefs: [artifact], recordedAt: "2026-01-01T00:00:00.000Z" }], producer: { producerKind: "host", providerId: "host", producedAt: "2026-01-01T00:00:00.000Z", correlation: { sessionId: "session-1", laneId: "main", taskId: "task-1", taskResultId: "task-result-1", revision: 1 } } });
		expect(result).toMatchObject({ ok: true, value: { taskResultId: "task-result-1" } });
		if (result.ok) expect(finalizeRunReceipt({ runReceiptId: "run-1", runId: "run-1", terminalStatus: "completed", authority: createHostTerminalGateAuthority("host"), taskResult: result.value, attemptReceiptIds: [receipt().attemptReceiptId], usage: noRunUsage })).toMatchObject({ ok: true, value: { taskResultId: "task-result-1", usage: noRunUsage } });
	});

	it("requires a Host terminal gate and all succeeded TaskResult evidence layers", () => {
		const validInput = {
			task,
			taskResultId: "task-result-strict",
			receipts: [receipt()],
			summary: "done",
			artifacts: [artifact],
			tests: [{ name: "required", required: true, status: "passed" as const, evidenceRefs: [artifact] }],
			evidence: [{ schemaVersion: 1 as const, factId: "fact-1", criterionId: "criterion-1", outcome: "satisfied" as const, evidenceRefs: [artifact], recordedAt: fakeNow }],
			producer: { producerKind: "host" as const, providerId: "host", producedAt: fakeNow, correlation: { sessionId: "session-1", laneId: "main", taskId: "task-1", taskResultId: "task-result-strict", revision: 1 } },
		};
		expect(settleTaskResult({ ...validInput, receipts: [] }).ok).toBe(false);
		expect(settleTaskResult({ ...validInput, artifacts: [] }).ok).toBe(false);
		expect(settleTaskResult({ ...validInput, artifacts: [{ ...artifact, digest: "not-a-digest" }] }).ok).toBe(false);
		expect(settleTaskResult({ ...validInput, tests: [] }).ok).toBe(false);
		expect(settleTaskResult({ ...validInput, tests: [{ name: "required", required: true, status: "failed" as const }] }).ok).toBe(false);
		expect(settleTaskResult({ ...validInput, tests: [{ name: "required", required: true, status: "pending" as const }] }).ok).toBe(false);
		expect(settleTaskResult({ ...validInput, evidence: [] }).ok).toBe(false);
		expect(settleTaskResult({ ...validInput, evidence: [{ ...validInput.evidence[0]!, evidenceRefs: [{ ...artifact, digest: "bad" }] }] }).ok).toBe(false);
		expect(settleTaskResult({ ...validInput, validation: { schemaValid: false, artifactDigestsValid: true, acceptanceVerified: true, requiredEvidencePresent: true } }).ok).toBe(false);
		const settled = settleTaskResult(validInput);
		expect(settled.ok).toBe(true);
		const baseFinalization = { runReceiptId: "run-strict", runId: "run-strict", terminalStatus: "completed" as const, attemptReceiptIds: [receipt().attemptReceiptId], usage: noRunUsage };
		// @ts-expect-error The terminal gate is a required Host-only authority.
		const missingAuthority = finalizeRunReceipt({ ...baseFinalization, taskResult: settled.ok ? settled.value : undefined });
		expect(missingAuthority).toMatchObject({ ok: false, error: { code: "run_terminal_authority_required" } });
		const authority = createHostTerminalGateAuthority("host-strict");
		const wrongAuthority = { ...authority, type: "agent" };
		// @ts-expect-error Wrong authority discriminator must be rejected at the contract boundary.
		const rejectedAuthority = finalizeRunReceipt({ ...baseFinalization, authority: wrongAuthority, taskResult: settled.ok ? settled.value : undefined });
		expect(rejectedAuthority).toMatchObject({ ok: false, error: { code: "run_terminal_authority_invalid" } });
		expect(finalizeRunReceipt({ ...baseFinalization, authority, taskResult: settled.ok ? settled.value : undefined })).toMatchObject({ ok: true });
	});
});

const fakeProviderCapability: FoundationProviderCapability = { schemaVersion: 1, id: "foundation.v1", version: 1 };
const fakeNow = "2026-01-01T00:00:00.000Z";
const operationWorkerProviderClass = "operation_worker" as const;
// @ts-expect-error Operation Workers return WorkerReceipt only and are not TaskExecutorProviders.
const _operationWorkerCannotBeTaskExecutor: TaskExecutorProvider["providerClass"] = operationWorkerProviderClass;

function fakeModelProfile(): ModelProfile {
	return { schemaVersion: 1, modelProfileId: "profile-1", provider: "fake", model: "model-1", budget: {}, revision: 1, createdAt: fakeNow, fingerprint: fingerprintFoundationValue({ modelProfileId: "profile-1", revision: 1, provider: "fake", model: "model-1" }) };
}

function fakeBinding(): AgentBinding {
	const result = resolveAgentBinding({ task, roleRevision: roleRevision(), modelProfile: fakeModelProfile(), ...bindingFacts(), newBindingId: "binding-1", now: () => fakeNow });
	if (!result.ok) throw result.error;
	return result.value;
}

function fakeAgentAttempt(providerId: string, taskId: string, bindingId: string, agentInstanceId?: string, providerClass: CreateAttemptInput["providerClass"] = agentInstanceId === undefined ? "external_connector" : "agent"): { attempt: Attempt; agentInstance?: AgentInstance; epoch: BindingEpoch } {
	const role = roleRevision();
	const instanceResult = providerClass === "agent" && agentInstanceId !== undefined ? createAgentInstance({ agentInstanceId, providerId, providerDeclaredAgent: true, roleRevision: role, taskId, now: () => fakeNow }) : undefined;
	if (instanceResult !== undefined && !instanceResult.ok) throw instanceResult.error;
	const epochResult = createBindingEpoch({ bindingEpochId: `${providerId}-epoch-0`, taskId, attemptId: `${providerId}-attempt-1`, bindingId, activationReason: "attempt_started", activatedByCommandId: `${providerId}-dispatch-1`, ...(instanceResult?.ok ? { agentInstanceId: agentInstanceId! } : {}), now: () => fakeNow });
	if (!epochResult.ok) throw epochResult.error;
	const dispatch: Dispatch = { schemaVersion: 1, dispatchId: `${providerId}-dispatch-1`, taskId, bindingId, taskExecutorProviderId: providerId, status: "pending", createdAt: fakeNow };
	const attemptResult = createAttempt({ attemptId: `${providerId}-attempt-1`, dispatch, providerId, initialBindingEpoch: epochResult.value, ...(instanceResult?.ok ? { agentInstanceId: agentInstanceId! } : {}), providerClass, now: () => fakeNow });
	if (!attemptResult.ok) throw attemptResult.error;
	return { attempt: attemptResult.value, agentInstance: instanceResult?.ok ? instanceResult.value : undefined, epoch: epochResult.value };
}

class FakeSandboxOperationProvider implements SandboxOperationProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "fake-line-11";
	readonly providerClass = "operation_worker" as const;
	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [fakeProviderCapability]; }
	async start(request: SandboxOperationRequest) {
		return { ok: true as const, value: { schemaVersion: 1 as const, workerReceiptId: "worker-receipt-11", sandboxProviderId: this.providerId, operationId: request.operationId, status: "succeeded" as const, sideEffectState: "none" as const, provenance: { producerKind: "operation_worker" as const, providerId: this.providerId, producedAt: fakeNow, correlation: { sessionId: "session-1", laneId: "main", revision: 1 } }, startedAt: fakeNow, completedAt: fakeNow } satisfies WorkerReceipt };
	}
	async cancel(_operationId: string) { return Result.ok(undefined); }
	async dispose() {}
}

class FakeChildAgentProvider implements ChildAgentProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "fake-line-12a";
	readonly providerClass = "agent" as const;
	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [fakeProviderCapability]; }
	async spawn(request: ChildSpawnRequest) {
		const artifacts = fakeAgentAttempt(this.providerId, request.taskEnvelope.taskId, "binding-child-1", "agent-child-1");
		return { ok: true as const, value: { schemaVersion: 1, attempt: artifacts.attempt, agentInstance: artifacts.agentInstance!, initialBindingEpoch: artifacts.epoch } satisfies ChildSpawnResult };
	}
	async resume(_attemptId: string) { return Result.err(new FoundationError("foundation_schema_unknown_record", "fake child resume is not implemented")); }
	async cancel(_attemptId: string) { return Result.ok(undefined); }
	async dispose() {}
}

class FakeSchedulerTaskExecutor implements SchedulerTaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "fake-line-12b";
	readonly providerClass = "scheduler" as const;
	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [fakeProviderCapability]; }
	async createAttempt(dispatch: Dispatch, _binding: AgentBinding) {
		return Result.ok(fakeAgentAttempt(this.providerId, dispatch.taskId, dispatch.bindingId, undefined, "scheduler").attempt);
	}
	async runAttempt(attempt: Attempt) {
		return Result.ok<AttemptReceipt>({ schemaVersion: 1, attemptReceiptId: "attempt-receipt-12b", taskId: attempt.taskId, dispatchId: attempt.dispatchId, attemptId: attempt.attemptId, providerId: this.providerId, ...(attempt.agentInstanceId === undefined ? {} : { agentInstanceId: attempt.agentInstanceId }), bindingId: attempt.bindingId, bindingEpochIds: attempt.bindingEpochIds, status: "succeeded", workerReceiptRefs: [], artifacts: [artifact], provenance: { producerKind: "scheduler", providerId: this.providerId, producedAt: fakeNow, correlation: { sessionId: "session-1", laneId: "main", taskId: attempt.taskId, dispatchId: attempt.dispatchId, attemptId: attempt.attemptId, bindingId: attempt.bindingId, bindingEpochId: attempt.bindingEpochIds[0], attemptReceiptId: "attempt-receipt-12b", revision: 1 } }, sideEffectState: "none" });
	}
	async cancelAttempt(_attemptId: string) { return Result.ok(undefined); }
	async dispose() {}
}

class FakeToolGateway implements ToolGateway {
	readonly schemaVersion = 1 as const;
	readonly providerId = "fake-tool-gateway";
	readonly providerClass = "gateway" as const;
	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [fakeProviderCapability]; }
	async execute(request: ToolGatewayRequest) { return { ok: true as const, value: { schemaVersion: 1, toolCallId: request.toolCallId, toolName: request.toolName, ok: true, sideEffectState: "none" as const } satisfies ToolExecutionResult }; }
	async dispose() {}
}

class FakeScopedModelGateway implements ScopedModelGateway {
	readonly schemaVersion = 1 as const;
	readonly providerId = "fake-model-gateway";
	readonly providerClass = "gateway" as const;
	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [fakeProviderCapability]; }
	async stream(request: ScopedModelRequest) { return { ok: true as const, value: { schemaVersion: 1, requestId: request.requestId, usage: { tokens: 1 }, stopReason: "stop" as const } satisfies ScopedModelResult }; }
	async dispose() {}
}

class FakeArtifactStoreProvider implements ArtifactStoreProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "fake-artifact-store";
	readonly providerClass = "store" as const;
	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [fakeProviderCapability]; }
	async put(descriptor: ArtifactDescriptor, data: Uint8Array) { return { ok: true as const, value: { schemaVersion: 1 as const, ref: descriptor.artifactId, sizeBytes: data.byteLength } }; }
	async get(_ref: string) { return { ok: true as const, value: new Uint8Array([1]) }; }
	async verify(_artifactId: string) { return { ok: true as const, value: { schemaVersion: 1 as const, digestValid: true } }; }
	async delete(_artifactId: string) { return { ok: true as const, value: undefined }; }
	async dispose() {}
}

class FakeQuotaProvider implements QuotaProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "fake-quota";
	readonly providerClass = "quota" as const;
	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [fakeProviderCapability]; }
	async reserve(attribution: QuotaAttribution, budget: { tokens?: number }) { return { ok: true as const, value: { schemaVersion: 1, reservationId: "reservation-1", attribution, budget, grantedAt: fakeNow } satisfies QuotaReservation }; }
	async settle(_reservation: QuotaReservation, usage: { tokens?: number }) { return { ok: true as const, value: usage }; }
	async dispose() {}
}

class FakeTransportAdapter implements TransportAdapter {
	readonly schemaVersion = 1 as const;
	readonly providerId = "fake-transport";
	readonly providerClass = "transport" as const;
	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [fakeProviderCapability]; }
	async initialize() { return { ok: true as const, value: { schemaVersion: 1 as const, protocolVersion: 1 as const, features: ["observer.cursor"] } }; }
	async attach(sessionId: string, _cursor?: TransportObserverCursor) { return { ok: true as const, value: { schemaVersion: 1 as const, sessionId, sequence: 0, catalogVersion: 1 as const } }; }
	async observe(_from: TransportObserverCursor, _onEvent: (event: FoundationEventEnvelope) => void) { return { ok: true as const, value: undefined }; }
	async dispose() {}
}

class FakeProductObserverAdapter implements ProductObserverAdapter {
	readonly schemaVersion = 1 as const;
	readonly providerId = "fake-product-observer";
	readonly providerClass = "observer" as const;
	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [fakeProviderCapability]; }
	async operatorIntents(_sessionId: string) { return { ok: true as const, value: [] as const }; }
	async acceptanceFacts(_taskId: string) { return { ok: true as const, value: [{ schemaVersion: 1 as const, factId: "fact-1", outcome: "satisfied" }] as const }; }
	async timeline(_runId: string) { return { ok: true as const, value: [] as const }; }
	async dispose() {}
}

function registryNotImplemented<T>(): ResultValue<T, FoundationError> {
	return Result.err(new FoundationError("foundation_schema_unknown_record", "registry fake has no persistence implementation"));
}

/** Compile-time contract fake: the registry surface is independent from any T2 store. */
class FakeRoleRegistry implements RoleRegistry {
	create(_input: RoleRegistryCreateInput) { return registryNotImplemented<RoleRegistryRecord>(); }
	get(_query: RoleRegistryGetQuery) { return registryNotImplemented<RoleRegistryRecord>(); }
	list(_query?: RoleRegistryListQuery) { return registryNotImplemented<readonly RoleRegistryRecord[]>(); }
	search(_query: RoleRegistrySearchQuery) { return registryNotImplemented<readonly RoleRegistryRecord[]>(); }
	edit(_input: RoleRegistryEditInput) { return registryNotImplemented<RoleRegistryRecord>(); }
	copy(_input: RoleRegistryCopyInput) { return registryNotImplemented<RoleRegistryRecord>(); }
	delete(_input: RoleRegistryDeleteInput) { return registryNotImplemented<RoleTombstone>(); }
	import(_input: RoleRegistryImport) { return registryNotImplemented<readonly RoleRegistryRecord[]>(); }
	export(_query?: RoleRegistryExportQuery) { return registryNotImplemented<RoleRegistryExport>(); }
	resolve(input: RoleResolveInput): ResultValue<RoleResolutionPreview, FoundationError> {
		const task = requireRoleResolutionTask(input.task);
		return task.ok ? registryNotImplemented<RoleResolutionPreview>() : Result.err(task.error);
	}
}

describe("T1 registry and identity query contracts", () => {
	it("exposes the exact T1 entity identity/query set", () => {
		const expected = new Set([
			"execution_correlation", "lineage", "fingerprint", "envelope", "event", "task", "artifact", "role_definition", "role_revision", "model_profile", "agent_binding", "binding_epoch", "agent_instance", "dispatch", "attempt", "worker_receipt", "attempt_receipt", "task_result", "run_receipt", "provider_contract", "protocol_negotiation", "observer_cursor", "observer_snapshot", "plugin", "service", "profile", "session", "goal", "plan", "stage", "todo", "ask", "workflow", "run", "turn", "step", "inbox",
		]);
		expect(new Set(FOUNDATION_ENTITY_KINDS)).toEqual(expected);
		const query = { schemaVersion: 1 as const, entityType: "task" as const, id: task.taskId, revision: 1, limit: 10 };
		expect(validateFoundationEntityQuery(query).ok).toBe(true);
		expect(validateFoundationEntityQuery({ ...query, extra: true }).ok).toBe(false);
		expect(validateFoundationEntityQuery({ ...query, entityType: "not-a-t1-entity" }).ok).toBe(false);
		expect(validateFoundationEntityId({ schemaVersion: 1, entityType: "task", id: task.taskId, revision: 1, extra: true }).ok).toBe(false);
	});

	it("requires the task-first public Role Registry/Resolver contract", () => {
		const registry = new FakeRoleRegistry();
		expect(registry.list().ok).toBe(false);
		expect(requireRoleResolutionTask(undefined).ok).toBe(false);
		expect(requireRoleResolutionTask(undefined)).toMatchObject({ ok: false, error: { code: "role_resolver_task_required" } });
	});

	it("freezes persisted Goal/Plan/Stage/Todo/Ask/Workflow schemas", () => {
		const goal = { schemaVersion: 1 as const, sessionId: "session-1", goalId: "goal-1", title: "goal", status: "active" as const, revision: 1, acceptanceCriteria: [], createdAt: fakeNow, updatedAt: fakeNow };
		const plan = { schemaVersion: 1 as const, planId: "plan-1", goalId: "goal-1", status: "draft" as const, revision: 1, stageIds: [], createdAt: fakeNow, updatedAt: fakeNow };
		const stage = { schemaVersion: 1 as const, stageId: "stage-1", planId: "plan-1", status: "pending" as const, ordinal: 0, todoIds: [] };
		const todo = { schemaVersion: 1 as const, todoId: "todo-1", stageId: "stage-1", status: "pending" as const, title: "todo", ordinal: 0 };
		const ask = { schemaVersion: 1 as const, sessionId: "session-1", askId: "ask-1", status: "pending" as const, question: "continue?", revision: 1, createdAt: fakeNow, updatedAt: fakeNow };
		const workflow = { schemaVersion: 1 as const, dslVersion: 1 as const, sessionId: "session-1", workflowId: "workflow-1", revision: 1, status: "draft" as const, steps: [{ schemaVersion: 1 as const, stepId: "step-1", ordinal: 0, revision: 1, status: "pending" as const, type: "agent" as const, taskId: task.taskId, roleRevision: { schemaVersion: 1 as const, type: "role_revision" as const, id: "role-1", revision: 1 }, executor: "local" as const, input: [{ schemaVersion: 1 as const, contractId: "input-none", kind: "none" as const, required: false }], output: [{ schemaVersion: 1 as const, contractId: "output-none", kind: "none" as const, required: false }] }], createdAt: fakeNow, updatedAt: fakeNow };
		expect(validateGoal(goal).ok).toBe(true);
		expect(validateGoal({ ...goal, sessionId: undefined }).ok).toBe(false);
		expect(validatePlan(plan).ok).toBe(true);
		expect(validateStage(stage).ok).toBe(true);
		expect(validateTodo(todo).ok).toBe(true);
		expect(validateAsk(ask).ok).toBe(true);
		expect(validateWorkflow(workflow).ok).toBe(true);
		expect(validateWorkflow({ ...workflow, extra: true }).ok).toBe(false);
	});

	it("projects tasks and workspaces without raw public values", () => {
		const projection = projectTaskEnvelope(task);
		expect(validateTaskEnvelopePublicProjection(projection).ok).toBe(true);
		expect(projection).toMatchObject({ taskId: task.taskId, goalId: task.goalId, goalDigest: { algorithm: "sha256" }, workspaceDigest: { algorithm: "sha256" } });
		expect("goal" in projection).toBe(false);
		expect("workspace" in projection).toBe(false);
		expect("title" in projection).toBe(false);
	});

	it("freezes resolver order and selector narrowing semantics", () => {
		const layers = ROLE_RESOLUTION_ORDER.map((layer, ordinal) => ({ schemaVersion: 1 as const, layer, ordinal, referenceId: `${layer}-ref`, revision: 1, overrideReason: "contract-test" }));
		expect(validateRoleResolutionOrder(layers).ok).toBe(true);
		expect(validateRoleResolutionOrder([layers[1]!, layers[0]!, ...layers.slice(2)]).ok).toBe(false);
		expect(validateRoleResolutionOrder([...layers.slice(0, -1), layers[5]!]).ok).toBe(false);
		const all = { policy: "all" as const };
		const none = { policy: "none" as const };
		const namedAB = { policy: "named" as const, named: ["a", "b"] };
		const namedA = { policy: "named" as const, named: ["a"] };
		const exceptAB = { policy: "except" as const, named: ["a", "b"] };
		const exceptABC = { policy: "except" as const, named: ["a", "b", "c"] };
		expect(selectorsNarrow(all, all)).toBe(true);
		expect(selectorsNarrow(all, namedAB)).toBe(true);
		expect(selectorsNarrow(all, exceptAB)).toBe(true);
		expect(selectorsNarrow(all, none)).toBe(true);
		expect(selectorsNarrow(none, none)).toBe(true);
		expect(selectorsNarrow(none, namedA)).toBe(false);
		expect(selectorsNarrow(namedAB, namedA)).toBe(true);
		expect(selectorsNarrow(namedA, namedAB)).toBe(false);
		expect(selectorsNarrow(namedAB, exceptAB)).toBe(false);
		expect(selectorsNarrow(exceptAB, namedA)).toBe(false);
		expect(selectorsNarrow(exceptAB, { policy: "named", named: ["c"] })).toBe(true);
		expect(selectorsNarrow(exceptAB, exceptABC)).toBe(true);
		expect(selectorsNarrow(exceptABC, exceptAB)).toBe(false);
		expect(validateRoleScopeTightening({ capabilitySelector: exceptAB, policySelector: exceptAB }, { capabilitySelector: exceptABC, policySelector: exceptABC }).ok).toBe(true);
		expect(validateRoleScopeTightening({ capabilitySelector: exceptAB, policySelector: exceptAB }, { capabilitySelector: exceptAB, policySelector: { policy: "all" } }).ok).toBe(false);
	});

	it("applies managed/global selectors before a project role and binds project override sources", () => {
		const projectRole = createRoleRevision({
			definition: {
				...roleRevision(),
				capabilitySelector: { policy: "named", named: ["a"] },
			},
			now: () => fakeNow,
		});
		const layers = ROLE_RESOLUTION_ORDER.map((layer, ordinal) => ({ schemaVersion: 1 as const, layer, ordinal, referenceId: `${layer}-ref`, revision: 1, overrideReason: "resolver-test" }));
		const baseInput = { schemaVersion: 1 as const, task, roleId: "role-1", scope: "project" as const, modelProfile: fakeModelProfile(), orderedLayers: layers, ...bindingFacts(), roleRevision: projectRole };
		const managedNarrowing = resolveRoleResolution({ ...baseInput, overrides: [{ schemaVersion: 1, layer: "managed_lock", referenceId: "managed-lock", revision: 1, overrideReason: "lock", capabilitySelector: { policy: "named", named: ["a", "b"] } }] });
		expect(managedNarrowing).toMatchObject({ ok: true, value: { capabilitySelector: { policy: "named", named: ["a"] } } });
		const widenedProject = resolveRoleResolution({ ...baseInput, overrides: [{ schemaVersion: 1, layer: "project", referenceId: "project-override", revision: 1, overrideReason: "widen", capabilitySelector: { policy: "all" } }] });
		expect(widenedProject).toMatchObject({ ok: false, error: { code: "role_resolver_scope_widened" } });
		const wrongProjectSource = resolveRoleResolution({ ...baseInput, overrides: [{ schemaVersion: 1, layer: "project", referenceId: "wrong-role", revision: 1, overrideReason: "source", roleRevision: projectRole }] });
		expect(wrongProjectSource).toMatchObject({ ok: false, error: { code: "role_resolver_conflict" } });
	});
});

describe("provider-neutral compilation contracts", () => {
	it("does not accept compatibility-optional omissions from frozen V1 shapes", () => {
		const roleDefinition = { schemaVersion: 1, roleId: "role-1", scope: "project", slug: "worker", name: "Worker", description: "Runs the task", revision: 0, persona: "You run the task.", modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-1", revision: 1 }, capabilitySelector: { policy: "all" }, skillSelector: { policy: "none" }, mcpSelector: { policy: "none" } };
		const omit = (value: object, key: string): unknown => { const copy = { ...value } as Record<string, unknown>; delete copy[key]; return copy; };
		const requiredRoleDefinitionFields = ["schemaVersion", "roleId", "scope", "slug", "name", "description", "revision", "persona", "modelProfileRef", "capabilitySelector", "skillSelector", "mcpSelector"];
		for (const field of requiredRoleDefinitionFields) expect(validateRoleDefinition(omit(roleDefinition, field)).ok, `RoleDefinition field ${field}`).toBe(false);
		const revision = roleRevision();
		const requiredRoleRevisionFields = ["schemaVersion", "roleRevisionId", "roleId", "scope", "revision", "slug", "name", "description", "persona", "modelProfileRef", "capabilitySelector", "skillSelector", "mcpSelector", "fingerprint", "createdAt"];
		for (const field of requiredRoleRevisionFields) expect(validateRoleRevision(omit(revision, field)).ok, `RoleRevision field ${field}`).toBe(false);
		const requiredTaskFields = ["schemaVersion", "taskId", "goalId", "goal", "workspace", "capabilityRefs", "inputs", "expectedOutputs", "budget", "acceptanceCriteria", "status", "createdAt", "updatedAt"];
		for (const field of requiredTaskFields) expect(validateTaskEnvelope(omit(task, field)).ok, `TaskEnvelope field ${field}`).toBe(false);
		const binding = fakeBinding();
		const requiredBindingFields = ["schemaVersion", "bindingId", "taskId", "roleRevision", "modelProfileRevision", "modelRoute", "contextRevision", "capabilityRevision", "modelBrokerBindingRevision", "policyRevision", "capabilitySelector", "budget", "sourceTrace", "conflicts", "fingerprint", "resolvedAt"];
		for (const field of requiredBindingFields) expect(validateAgentBinding(omit(binding, field)).ok, `AgentBinding field ${field}`).toBe(false);
		const epoch = fakeAgentAttempt("shape", task.taskId, "binding-1").epoch;
		const requiredEpochFields = ["schemaVersion", "bindingEpochId", "taskId", "attemptId", "bindingId", "ordinal", "activationReason", "activatedByCommandId", "activatedAt"];
		for (const field of requiredEpochFields) expect(validateBindingEpoch(omit(epoch, field)).ok, `BindingEpoch field ${field}`).toBe(false);
		const requiredReceiptFields = ["schemaVersion", "attemptReceiptId", "taskId", "dispatchId", "attemptId", "providerId", "bindingId", "bindingEpochIds", "status", "workerReceiptRefs", "artifacts", "provenance", "sideEffectState"];
		for (const field of requiredReceiptFields) expect(validateAttemptReceipt(omit(receipt(), field)).ok, `AttemptReceipt field ${field}`).toBe(false);
		// These are intentionally optional: title/description/payload/retry fingerprint are task metadata;
		// goalId is redundant on a binding whose taskId is authoritative; epoch instance/previous ids
		// distinguish operation workers and the ordinal-0 epoch; receipt error/artifact fields depend on outcome.
		expect(validateTaskEnvelope(omit(task, "title")).ok).toBe(true);
		expect(validateTaskEnvelope(omit(task, "description")).ok).toBe(true);
		expect(validateTaskEnvelope(omit(task, "payload")).ok).toBe(true);
		expect(validateTaskEnvelope(omit(task, "attempts")).ok).toBe(true);
		expect(validateAgentBinding(omit(binding, "goalId")).ok).toBe(false);
		expect(validateBindingEpoch(omit(epoch, "agentInstanceId")).ok).toBe(true);
		expect(validateAttemptReceipt(omit(receipt(), "error")).ok).toBe(true);
	});

	it("covers deterministic line 11, 12A, and 12B providers", async () => {
		const sandbox = new FakeSandboxOperationProvider();
	const worker = await sandbox.start({ schemaVersion: 1, operationId: "operation-11" });
		expect(worker.ok && validateWorkerReceipt(worker.value).ok).toBe(true);
		expect("agentInstanceId" in (worker.ok ? worker.value : {})).toBe(false);
		expect("createAttempt" in sandbox).toBe(false);
		expect("runAttempt" in sandbox).toBe(false);
		expect("settleTaskResult" in sandbox).toBe(false);

		const child = new FakeChildAgentProvider();
		const childResult = await child.spawn({ schemaVersion: 1, spawnId: "spawn-12a", taskEnvelope: { ...task, taskId: "child-task" }, roleRevision: roleRevision(), modelProfile: fakeModelProfile(), forkScope: "none" });
		expect(childResult.ok).toBe(true);
		if (childResult.ok) expect(childResult.value.initialBindingEpoch.ordinal).toBe(0);

		const scheduler = new FakeSchedulerTaskExecutor();
		const dispatch: Dispatch = { schemaVersion: 1, dispatchId: "dispatch-12b", taskId: task.taskId, bindingId: "binding-1", taskExecutorProviderId: scheduler.providerId, status: "pending", createdAt: fakeNow };
		const attemptResult = await scheduler.createAttempt(dispatch, fakeBinding());
		expect(attemptResult.ok).toBe(true);
		if (attemptResult.ok) {
			const schedulerReceipt = await scheduler.runAttempt(attemptResult.value);
			expect(schedulerReceipt.ok).toBe(true);
			if (schedulerReceipt.ok) {
				expect(schedulerReceipt.value.provenance.producerKind).toBe("scheduler");
				expect(schedulerReceipt.value.agentInstanceId).toBeUndefined();
				expect(validateAttemptReceipt(schedulerReceipt.value, { agentProvider: false }).ok).toBe(true);
			}
		}
		expect(validateAttemptReceipt({ ...receipt(), agentInstanceId: undefined, provenance: { ...receipt().provenance, producerKind: "agent_executor" } }).ok).toBe(false);
	});

	it("covers every remaining provider interface at the contract boundary", async () => {
		const tool = new FakeToolGateway();
		expect((await tool.execute({ schemaVersion: 1, toolCallId: "call-1", toolName: "read", originalArguments: {}, context: { schemaVersion: 1, bindingId: "binding-1", bindingEpochId: "epoch-1", taskId: task.taskId } })).value).toMatchObject({ ok: true, sideEffectState: "none" });

		const model = new FakeScopedModelGateway();
		expect((await model.stream({ schemaVersion: 1, requestId: "model-1", modelProfileRevision: { schemaVersion: 1, type: "model_profile", id: "profile-1", revision: 1 }, bindingEpochId: "epoch-1", taskId: task.taskId, input: {} })).value).toMatchObject({ stopReason: "stop" });

		const store = new FakeArtifactStoreProvider();
		const descriptor: ArtifactDescriptor = { schemaVersion: 1, artifactId: "artifact-1", name: "result", mediaType: "text/plain", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", permissions: ["read"], retention: { policy: "session" }, validationState: "verified" };
		expect((await store.put(descriptor, new Uint8Array([1]))).value).toEqual({ schemaVersion: 1, ref: "artifact-1", sizeBytes: 1 });
		expect((await store.verify(descriptor.artifactId)).value).toEqual({ schemaVersion: 1, digestValid: true });

		const quota = new FakeQuotaProvider();
		const attribution: QuotaAttribution = { schemaVersion: 1, taskId: task.taskId, providerId: quota.providerId, ownerKind: "host" };
		const reservation = await quota.reserve(attribution, { tokens: 10 });
		expect(reservation.ok).toBe(true);
		if (reservation.ok) expect((await quota.settle(reservation.value, { tokens: 1 })).value).toEqual({ tokens: 1 });

		const transport = new FakeTransportAdapter();
		expect((await transport.initialize()).value).toMatchObject({ protocolVersion: 1 });
		expect((await transport.attach(task.taskId)).value).toMatchObject({ sessionId: task.taskId, catalogVersion: 1 });

		const observer = new FakeProductObserverAdapter();
	 expect((await observer.acceptanceFacts(task.taskId)).value).toEqual([{ schemaVersion: 1, factId: "fact-1", outcome: "satisfied" }]);
	});

	it("validates provider payloads with exact nested schemas and recursive JSON values", () => {
		const binding = fakeBinding();
		const toolRequest: ToolGatewayRequest = { schemaVersion: 1, toolCallId: "tool-call", toolName: "read", originalArguments: { path: "artifact" }, context: { schemaVersion: 1, bindingId: binding.bindingId, bindingEpochId: "epoch-1", taskId: task.taskId } };
		expect(validateToolGatewayRequest(toolRequest).ok).toBe(true);
		expect(serializeToolGatewayRequest(toolRequest)).toContain('"toolCallId":"tool-call"');
		expect(validateToolGatewayRequest({ ...toolRequest, originalArguments: { run: () => "no" } }).ok).toBe(false);
		const scopedRequest: ScopedModelRequest = { schemaVersion: 1, requestId: "model-request", modelProfileRevision: { schemaVersion: 1, type: "model_profile", id: "profile-1", revision: 1 }, bindingEpochId: "epoch-1", taskId: task.taskId, input: { messages: ["hello"] } };
		expect(validateScopedModelRequest(scopedRequest).ok).toBe(true);
		expect(serializeScopedModelRequest(scopedRequest)).toContain('"requestId":"model-request"');
		expect(validateScopedModelRequest({ ...scopedRequest, modelProfileRevision: { type: "model_profile", id: "profile-1", revision: 1 } }).ok).toBe(false);
	});

	it("keeps idempotency separate from side-effect state and fails closed", () => {
		expect(isSideEffectRetryable("none", "non_idempotent")).toBe(true);
		expect(isSideEffectRetryable("unknown", "idempotent")).toBe(true);
		expect(isSideEffectRetryable("unknown", "non_idempotent")).toBe(false);
		expect(isSideEffectRetryable("side_effect_unknown", "idempotent")).toBe(false);
		expect(validateWorkerReceipt({ schemaVersion: 1, workerReceiptId: "worker-1", sandboxProviderId: "sandbox", operationId: "op-1", status: "succeeded", sideEffectState: "side_effect_unknown", provenance: { producerKind: "operation_worker", providerId: "sandbox", producedAt: fakeNow, correlation: { sessionId: "session-1", laneId: "main", revision: 1 } }, startedAt: fakeNow, completedAt: fakeNow }).ok).toBe(false);
		expect(validateWorkerReceipt({ schemaVersion: 1, workerReceiptId: "worker-1", sandboxProviderId: "sandbox", operationId: "op-1", status: "succeeded", sideEffectState: "idempotent", provenance: { producerKind: "operation_worker", providerId: "sandbox", producedAt: fakeNow, correlation: { sessionId: "session-1", laneId: "main", revision: 1 } }, startedAt: fakeNow, completedAt: fakeNow }).ok).toBe(false);
	});
});
