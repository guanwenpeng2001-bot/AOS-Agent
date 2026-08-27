import {
	canonicalFoundationJson,
	createGoalStore,
	createHostTerminalGateAuthority,
	createModelProfileRevision,
	createOrderedBindingEpoch,
	createRoleRevision,
	createTaskEnvelope,
	fingerprintFoundationValue,
	FoundationError,
	LayeredResultSettlement,
	persistTaskEnvelopeBeforeResolver,
	resolveAgentBinding,
	SessionLedger,
	validateBindingEpoch,
	validateDispatch,
	validateTaskEnvelope,
	validateTaskResult,
	type AgentBinding,
	type AttemptReceipt,
	type BindingEpoch,
	type Dispatch,
	type ExecutionCorrelation,
	type Fingerprint,
	type FoundationJsonValue,
	type RevisionReference,
	type RunReceipt,
	type Session,
	type SessionLedgerWriter,
	type TaskEnvelope,
	type TaskResult,
} from "@aos-agent/agent-core";
import {
	gateCanonicalExternalAgentInputBeforeAcceptance,
	type CanonicalExternalAgentInput,
	type CanonicalExternalAgentRequestFingerprint,
	type ExternalAgentInputAdmissionOptions,
} from "./external-agent-input.ts";
import {
	isExternalResolvedModelProjection,
	type ExternalModelFallbackDecision,
	type ExternalModelTranslationResult,
	type ExternalResolvedModelProjection,
	type ExternalTranslatedModelProjection,
} from "./external-model-projection.ts";
import type {
	ExternalConnectorRegistry,
	ExternalConnectorResolvedSelection,
	ExternalConnectorSelection,
} from "./external-agent-registry.ts";
import {
	EXTERNAL_CONNECTOR_EXECUTION_INPUT_OBJECT_TYPE,
	SessionExternalConnectorDurableStore,
} from "./external-agent-operation.ts";

const DECLARED_AT = "1970-01-01T00:00:00.000Z";

export interface ExternalConnectorProductExecutionInput {
	readonly session: Session;
	readonly writer?: SessionLedgerWriter;
	readonly registry: ExternalConnectorRegistry;
	readonly selection: ExternalConnectorSelection;
	readonly runId: string;
	readonly message: string;
	readonly canonicalInput: CanonicalExternalAgentInput;
	readonly inputAdmission: Pick<ExternalAgentInputAdmissionOptions, "inspectArtifact">;
	readonly workspace: string;
	readonly signal?: AbortSignal;
	/** True when this accepted work requires the Connector's advertised Tool Gateway bridge. */
	readonly requiresToolGateway?: boolean;
	readonly gatewayModelRoute?: {
		readonly provider: string;
		readonly model: string;
		readonly effort: string;
		readonly serviceTier: string;
		readonly fallbackDecision: ExternalModelFallbackDecision;
		readonly bindingDigest: Fingerprint;
	};
	readonly now?: () => string;
}

export interface ExternalConnectorProductExecution {
	readonly task: TaskEnvelope;
	readonly binding: AgentBinding;
	readonly dispatch: Dispatch;
	readonly initialBindingEpoch: BindingEpoch;
	readonly attemptReceipt: AttemptReceipt;
	readonly taskResult: TaskResult;
	readonly runReceipt: RunReceipt;
}

export interface ExternalConnectorProductRecoveryInput {
	readonly session: Session;
	readonly writer?: SessionLedgerWriter;
	readonly registry: ExternalConnectorRegistry;
	readonly runId: string;
	readonly providerId: string;
	readonly selection?: ExternalConnectorSelection;
	/** RPC recovery must not silently replace the immutable input of the durable Attempt. */
	readonly expectedText?: string;
	readonly signal?: AbortSignal;
}

export type ExternalConnectorProductErrorCode = "external_binding_invalid" | "external_capability_mismatch";

export class ExternalConnectorProductError extends Error {
	readonly code: ExternalConnectorProductErrorCode;
	readonly retryable = false;

	constructor(code: ExternalConnectorProductErrorCode, message: string) {
		super(message);
		this.name = "ExternalConnectorProductError";
		this.code = code;
	}
}

export interface PreparedExternalConnectorProductRun {
	readonly input: ExternalConnectorProductExecutionInput;
	readonly selected: ExternalConnectorResolvedSelection;
	readonly timestamp: string;
	readonly task: TaskEnvelope;
	readonly binding: AgentBinding;
	readonly dispatch: Dispatch;
	readonly initialBindingEpoch: BindingEpoch;
	readonly correlation: ExecutionCorrelation;
}

interface PersistedExternalConnectorProductRun {
	readonly task: TaskEnvelope;
	readonly binding: AgentBinding;
	readonly dispatch: Dispatch;
	readonly initialBindingEpoch: BindingEpoch;
	readonly correlation: ExecutionCorrelation;
	readonly attemptReceipt: AttemptReceipt;
	readonly timestamp: string;
}

/** Read-only admission result. No Foundation fact exists until this value is persisted after acceptance. */
export interface ExternalConnectorProductAdmission {
	readonly input: ExternalConnectorProductExecutionInput;
	readonly selected: ExternalConnectorResolvedSelection;
	readonly admittedInput: CanonicalExternalAgentInput;
	readonly requestFingerprint: CanonicalExternalAgentRequestFingerprint;
	readonly route: {
		readonly provider: string;
		readonly model: string;
		readonly effort: string;
		readonly serviceTier: string;
		readonly fallbackDecision: ExternalModelFallbackDecision;
	};
	readonly modelProjection?: ExternalResolvedModelProjection;
	readonly modelTranslation?: ExternalTranslatedModelProjection;
}

interface ExternalConnectorModelProjectionPreflight {
	preflightModelProjection(projection: ExternalResolvedModelProjection): ExternalModelTranslationResult;
}

function modelProjectionPreflight(value: unknown): ExternalConnectorModelProjectionPreflight | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		!("preflightModelProjection" in value) ||
		typeof value.preflightModelProjection !== "function"
	) return undefined;
	return value as ExternalConnectorModelProjectionPreflight;
}

function requireValue<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: FoundationError }): T {
	if (!result.ok) throw result.error;
	return result.value;
}

function requireFactPayload(
	record: Awaited<ReturnType<SessionLedger["get"]>>,
	objectType: string,
	objectId: string,
): FoundationJsonValue {
	if (record === undefined || record.kind !== "fact") {
		throw new FoundationError("invalid_correlation", `Durable External Connector ${objectType} is missing`, {
			details: { objectType, objectId },
		});
	}
	return record.payload;
}

function token(runId: string, providerId: string): string {
	return fingerprintFoundationValue({ runId, providerId }).value.slice(0, 32);
}

export function externalConnectorProductIdentity(runId: string, providerId: string) {
	const identityToken = token(runId, providerId);
	const dispatchId = `dispatch_external_${identityToken}`;
	return Object.freeze({
		taskId: `task_external_${identityToken}`,
		bindingId: `binding_external_${identityToken}`,
		dispatchId,
		attemptId: `external_attempt_${fingerprintFoundationValue({ providerId, dispatchId }).value}`,
		bindingEpochId: `binding_epoch_external_${identityToken}`,
	});
}

function revisionReference(type: string, id: string, payload: FoundationJsonValue, providerId?: string): RevisionReference {
	return {
		schemaVersion: 1,
		type,
		id,
		revision: 1,
		fingerprint: fingerprintFoundationValue(payload),
		...(providerId === undefined ? {} : { providerId }),
	};
}

async function persistImmutable(
	ledger: SessionLedger,
	objectType: string,
	objectId: string,
	payload: FoundationJsonValue,
	correlation: { readonly taskId: string; readonly bindingId: string },
): Promise<void> {
	const existing = await ledger.get(objectType, objectId);
	if (existing !== undefined) {
		if (existing.kind === "fact" && canonicalFoundationJson(existing.payload) === canonicalFoundationJson(payload)) return;
		throw new FoundationError("session_ledger_conflict", `${objectType} ${objectId} conflicts with external execution`);
	}
	await ledger.appendFact(objectType, objectId, payload, {
		clientRequestId: `external-connector:${objectType}:${objectId}`,
		expectedRevision: 0,
		correlation,
	});
}

function modelRouteFor(selection: ExternalConnectorResolvedSelection, input: ExternalConnectorProductExecutionInput) {
	if (selection.capabilitySnapshot.modelAccess === "aos_gateway") {
		if (input.gatewayModelRoute === undefined) {
			throw new FoundationError("binding_required_fact", "AOS gateway connector requires an exact model binding");
		}
		return input.gatewayModelRoute;
	}
	return {
		provider: `external:${selection.descriptor.providerId}`,
		model: selection.capabilitySnapshot.modelAccess === "agent_owned" ? "agent-owned" : "none",
		effort: "off",
		serviceTier: "none",
		fallbackDecision: { kind: "disabled", reason: "fallback_disabled" } as const,
	};
}

/** Read-only pre-accept input, model-route, and driver-translation admission. */
export async function prepareExternalConnectorProductRun(
	input: ExternalConnectorProductExecutionInput,
): Promise<ExternalConnectorProductAdmission> {
	if (input.message.length === 0 || input.runId.length === 0 || input.workspace.length === 0) {
		throw new FoundationError("foundation_schema_invalid_shape", "External connector run identity and text are required");
	}
	if (input.message !== input.canonicalInput.text) {
		throw new FoundationError("foundation_schema_invalid_shape", "External connector text must match its canonical input");
	}
	const selected = await input.registry.select(input.selection);
	if (!selected.ok) throw selected.error;
	if (input.requiresToolGateway === true && !selected.value.capabilityTruth.capabilities.toolGateway) {
		throw new ExternalConnectorProductError(
			"external_capability_mismatch",
			"External connector does not support the required Tool Gateway bridge",
		);
	}
	const admitted = await gateCanonicalExternalAgentInputBeforeAcceptance(input.canonicalInput, {
		capabilities: {
			artifacts: selected.value.capabilitySnapshot.artifacts,
			images: selected.value.capabilitySnapshot.images,
		},
		inspectArtifact: input.inputAdmission.inspectArtifact,
	});
	if (!admitted.ok) throw admitted.error;
	const route = modelRouteFor(selected.value, input);
	let modelProjection: ExternalResolvedModelProjection | undefined;
	let modelTranslation: ExternalTranslatedModelProjection | undefined;
	if (selected.value.capabilitySnapshot.modelAccess === "aos_gateway") {
		const gatewayRoute = input.gatewayModelRoute;
		if (gatewayRoute === undefined) {
			throw new ExternalConnectorProductError("external_binding_invalid", "External gateway model binding is missing");
		}
		const exactProjection = {
			schemaVersion: 1 as const,
			provider: gatewayRoute.provider,
			model: gatewayRoute.model,
			effort: gatewayRoute.effort,
			serviceTier: gatewayRoute.serviceTier,
			fallbackDecision: gatewayRoute.fallbackDecision,
			bindingDigest: gatewayRoute.bindingDigest,
		};
		if (!isExternalResolvedModelProjection(exactProjection)) {
			throw new ExternalConnectorProductError("external_binding_invalid", "External gateway model projection is invalid");
		}
		const preflight = modelProjectionPreflight(selected.value.connector);
		if (preflight === undefined) {
			throw new ExternalConnectorProductError("external_binding_invalid", "External gateway model translation is unavailable");
		}
		const translated = preflight.preflightModelProjection(exactProjection);
		if (!translated.ok) {
			throw new ExternalConnectorProductError(translated.error.code, `External gateway model translation failed: ${translated.error.reasonCode}`);
		}
		modelProjection = exactProjection;
		modelTranslation = translated.translation;
	}
	return {
		input,
		selected: selected.value,
		admittedInput: admitted.input,
		requestFingerprint: admitted.requestFingerprint,
		route,
		...(modelProjection === undefined ? {} : { modelProjection }),
		...(modelTranslation === undefined ? {} : { modelTranslation }),
	};
}

/** Persist an already accepted admission before starting its pure Attempt. */
export async function persistExternalConnectorProductRunAfterAcceptance(
	admission: ExternalConnectorProductAdmission,
): Promise<PreparedExternalConnectorProductRun> {
	const { input, selected, admittedInput, requestFingerprint, route, modelProjection, modelTranslation } = admission;
	const timestamp = (input.now ?? (() => new Date().toISOString()))();
	const identityToken = token(input.runId, selected.descriptor.providerId);
	const identity = externalConnectorProductIdentity(input.runId, selected.descriptor.providerId);
	const modelProfile = createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: `model_profile_external_${identityToken}`,
		name: "External Connector execution route",
		provider: route.provider,
		model: route.model,
		effort: route.effort,
		serviceTier: route.serviceTier,
		budget: {},
		revision: 1,
		createdAt: DECLARED_AT,
	});
	const roleRevision = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: `external.${selected.descriptor.providerId}`,
			scope: "global",
			slug: "external-connector",
			name: "External Connector",
			description: "Canonical external connector executor",
			revision: 1,
			persona: "Execute the canonical task through the selected external connector",
			modelProfileRef: {
				schemaVersion: 1,
				type: "model_profile",
				id: modelProfile.modelProfileId,
				revision: modelProfile.revision,
				fingerprint: modelProfile.fingerprint,
			},
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "all" },
			mcpSelector: { policy: "all" },
		},
		now: () => DECLARED_AT,
	});
	const metadata = await input.session.getMetadata();
	const goal = await createGoalStore(input.session, input.writer === undefined ? {} : { writer: input.writer }).create({
		sessionId: metadata.id,
		title: "External Connector run",
		description: "Canonical product execution through an External Connector",
	}, {
		clientRequestId: `external-connector:goal:${metadata.id}:${input.runId}`,
		expectedRevision: 0,
	});
	const artifacts = admittedInput.artifacts.map((artifact) => ({
		schemaVersion: 1 as const,
		artifactId: artifact.artifactId,
		mediaType: artifact.mediaType,
		digest: artifact.digest,
	}));
	const task = requireValue(createTaskEnvelope({
		schemaVersion: 1,
		taskId: identity.taskId,
		goalId: goal.goalId,
		goal: admittedInput.text,
		kind: "task",
		title: "External Connector task",
		description: `Canonical input ${requestFingerprint}`,
		workspace: input.workspace,
		capabilityRefs: [],
		inputs: artifacts,
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: timestamp,
		updatedAt: timestamp,
	}));
	const persistedTask = await persistTaskEnvelopeBeforeResolver(input.session, task, {
		ownerId: `external-connector:${metadata.id}`,
		...(input.writer === undefined ? {} : { writer: input.writer }),
	});
	if (!persistedTask.ok) throw persistedTask.error;

	const sourcePayloads = {
		external: {
			schemaVersion: 1 as const,
			type: "external_agent_binding",
			id: `external_binding_${identityToken}`,
			revision: 1 as const,
			providerId: selected.descriptor.providerId,
			capabilitySnapshotDigest: selected.capabilitySnapshot.digest.value,
			capabilityRevision: selected.capabilitySnapshot.revision,
			inputFingerprint: requestFingerprint,
		},
		capability: {
			schemaVersion: 1 as const,
			type: "capability_binding",
			id: `capability_binding_${identityToken}`,
			revision: 1 as const,
			snapshotDigest: selected.capabilityTruth.snapshotDigest.value,
		},
		model: {
			schemaVersion: 1 as const,
			type: "model_broker_binding",
			id: `model_binding_${identityToken}`,
			revision: 1 as const,
			modelAccess: selected.capabilitySnapshot.modelAccess,
			route: { provider: route.provider, model: route.model, effort: route.effort, serviceTier: route.serviceTier },
			...(input.gatewayModelRoute === undefined ? {} : { bindingDigest: input.gatewayModelRoute.bindingDigest.value }),
		},
		policy: {
			schemaVersion: 1 as const,
			type: "policy_binding",
			id: `policy_binding_${identityToken}`,
			revision: 1 as const,
			decision: "trusted_connector",
		},
	};
	const refs = {
		external: revisionReference("external_agent_binding", sourcePayloads.external.id, sourcePayloads.external, selected.descriptor.providerId),
		capability: revisionReference("capability_binding", sourcePayloads.capability.id, sourcePayloads.capability),
		model: revisionReference("model_broker_binding", sourcePayloads.model.id, sourcePayloads.model),
		policy: revisionReference("policy_binding", sourcePayloads.policy.id, sourcePayloads.policy),
	};
	const binding = requireValue(resolveAgentBinding({
		task: persistedTask.value,
		roleRevision,
		modelProfile,
		externalAgentBindingRevision: refs.external,
		capabilityRevision: refs.capability,
		modelBrokerBindingRevision: refs.model,
		policyRevision: refs.policy,
		newBindingId: identity.bindingId,
		now: () => timestamp,
	}));
	const ledger = new SessionLedger(input.session, {
		ownerId: `external-connector:${binding.bindingId}`,
		...(input.writer === undefined ? {} : { writer: input.writer }),
	});
	try {
		const correlationBase = { taskId: persistedTask.value.taskId, bindingId: binding.bindingId };
		await persistImmutable(ledger, "role_revision", roleRevision.roleRevisionId, roleRevision as unknown as FoundationJsonValue, correlationBase);
		await persistImmutable(ledger, "model_profile_revision", modelProfile.modelProfileId, modelProfile as unknown as FoundationJsonValue, correlationBase);
		await persistImmutable(ledger, "external_agent_binding", refs.external.id, sourcePayloads.external, correlationBase);
		await persistImmutable(ledger, "capability_binding", refs.capability.id, sourcePayloads.capability, correlationBase);
		await persistImmutable(ledger, "model_broker_binding", refs.model.id, sourcePayloads.model, correlationBase);
		await persistImmutable(ledger, "policy_binding", refs.policy.id, sourcePayloads.policy, correlationBase);
		const durableExecutionInput = {
			schemaVersion: 1,
			taskId: persistedTask.value.taskId,
			requestFingerprint,
			input: admittedInput,
			...(modelProjection === undefined ? {} : { modelProjection }),
			...(modelTranslation === undefined ? {} : { modelTranslation }),
		};
		await persistImmutable(
			ledger,
			EXTERNAL_CONNECTOR_EXECUTION_INPUT_OBJECT_TYPE,
			persistedTask.value.taskId,
			durableExecutionInput as unknown as FoundationJsonValue,
			correlationBase,
		);
	} finally {
		await ledger.release();
	}

	const dispatch = requireValue(validateDispatch({
		schemaVersion: 1,
		dispatchId: identity.dispatchId,
		taskId: persistedTask.value.taskId,
		bindingId: binding.bindingId,
		taskExecutorProviderId: selected.connector.providerId,
		status: "pending",
		createdAt: timestamp,
	}));
	const attemptId = identity.attemptId;
	const epoch = requireValue(createOrderedBindingEpoch({
		bindingEpochId: identity.bindingEpochId,
		taskId: persistedTask.value.taskId,
		attemptId,
		bindingId: binding.bindingId,
		activationReason: "attempt_started",
		activatedByCommandId: dispatch.dispatchId,
		now: () => timestamp,
	}));
	const correlation: ExecutionCorrelation = {
		sessionId: metadata.id,
		laneId: "main",
		runId: input.runId,
		operationId: input.runId,
		taskId: persistedTask.value.taskId,
		dispatchId: dispatch.dispatchId,
		attemptId,
		bindingId: binding.bindingId,
		bindingEpochId: epoch.bindingEpochId,
		providerId: selected.connector.providerId,
		revision: 0,
	};
	return {
		input,
		selected,
		timestamp,
		task: persistedTask.value,
		binding,
		dispatch,
		initialBindingEpoch: epoch,
		correlation,
	};
}

/** Execute a pre-accepted current Connector run through the canonical terminal chain. */
export async function executePreparedExternalConnectorProductRun(
	prepared: PreparedExternalConnectorProductRun,
): Promise<ExternalConnectorProductExecution> {
	const { input, selected, timestamp, task, binding, dispatch, initialBindingEpoch: epoch, correlation } = prepared;
	const settlement = new LayeredResultSettlement(input.session, {
		ownerId: `external-connector:${binding.bindingId}`,
		...(input.writer === undefined ? {} : { writer: input.writer }),
	});
	try {
		const executed = await settlement.executeDispatch({
			provider: selected.connector,
			dispatch,
			binding,
			initialBindingEpoch: epoch,
			correlation,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		if (!executed.ok) throw executed.error;
		return await settleExternalConnectorProductRun(
			settlement,
			{
				task,
				binding,
				dispatch,
				initialBindingEpoch: epoch,
				correlation,
				attemptReceipt: executed.value.receipt,
				timestamp,
			},
			input.runId,
		);
	} finally {
		await settlement.release();
	}
}

async function settleExternalConnectorProductRun(
	settlement: LayeredResultSettlement,
	persisted: PersistedExternalConnectorProductRun,
	runId: string,
): Promise<ExternalConnectorProductExecution> {
	const { task, binding, dispatch, initialBindingEpoch, correlation, attemptReceipt, timestamp } = persisted;
	const taskResultId = `task_result_${runId}`;
	const settled = await settlement.settle({
		taskResultId,
		task,
		sourceAttemptReceiptIds: [attemptReceipt.attemptReceiptId],
		summary:
			attemptReceipt.status === "succeeded"
				? "External connector run completed"
				: "External connector run did not complete",
		artifacts: attemptReceipt.artifacts,
		tests: [],
		evidence: [],
		producer: {
			producerKind: "host",
			providerId: "aos.external-connector.terminal-gate",
			producedAt: timestamp,
			correlation: { ...correlation, taskResultId, attemptReceiptId: attemptReceipt.attemptReceiptId },
		},
	});
	if (!settled.ok) throw settled.error;
	const terminalStatus =
		attemptReceipt.sideEffectState !== "none" ||
		attemptReceipt.status === "failed" ||
		attemptReceipt.status === "suspended"
			? ("failed" as const)
			: attemptReceipt.status === "cancelled"
				? ("cancelled" as const)
				: ("completed" as const);
	const failedTerminalError =
		terminalStatus === "failed"
			? (attemptReceipt.error ?? {
					code: "side_effect_unknown",
					message: "External connector terminal outcome could not be proven.",
					category: "side_effect_unknown" as const,
					retryable: false,
				})
			: undefined;
	const finalized = await settlement.finalize({
		runReceiptId: `run_receipt_${runId}`,
		runId,
		terminalStatus,
		authority: createHostTerminalGateAuthority("aos.external-connector.terminal-gate", 1),
		attemptReceiptIds: [attemptReceipt.attemptReceiptId],
		taskResultId: settled.value.taskResultId,
		usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		...(terminalStatus === "cancelled"
			? {
					terminalErrorCode: "run_cancelled",
					terminalError: {
						code: "run_cancelled",
						message: "External connector run was cancelled",
						category: "cancelled" as const,
						retryable: false,
					},
				}
			: failedTerminalError === undefined
				? {}
				: {
						terminalErrorCode: failedTerminalError.code,
						terminalError: failedTerminalError,
					}),
		completedAt: timestamp,
	});
	if (!finalized.ok) throw finalized.error;
	return {
		task,
		binding,
		dispatch,
		initialBindingEpoch,
		attemptReceipt,
		taskResult: settled.value,
		runReceipt: finalized.value,
	};
}

/** Recover one persisted product Attempt without creating another Attempt or issuing vendor start. */
export async function recoverExternalConnectorProductRun(
	input: ExternalConnectorProductRecoveryInput,
): Promise<ExternalConnectorProductExecution> {
	const identity = externalConnectorProductIdentity(input.runId, input.providerId);
	const descriptor = input.registry.list().find((candidate) => candidate.providerId === input.providerId);
	if (descriptor === undefined) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"The persisted External Connector provider is not registered in this Host.",
		);
	}
	const selection = input.selection ?? {
		providerId: descriptor.providerId,
		revision: descriptor.revision,
		capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
	};
	if (selection.providerId !== input.providerId) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"The requested External Connector does not match the persisted Attempt.",
		);
	}
	const selected = await input.registry.select(selection);
	if (!selected.ok) {
		throw new ExternalConnectorProductError(
			"external_capability_mismatch",
			"The persisted External Connector capability snapshot is unavailable or drifted.",
		);
	}
	const ledger = new SessionLedger(input.session, {
		ownerId: `external-connector-recovery:${identity.bindingId}`,
		...(input.writer === undefined ? {} : { writer: input.writer }),
	});
	const store = new SessionExternalConnectorDurableStore(ledger);
	try {
		const attempt = await store.readAttempt(identity.attemptId);
		const binding = await store.readBinding(identity.bindingId);
		const operation = await store.readOperation(identity.attemptId);
		const executionInput = await store.readExecutionInput(identity.taskId);
		if (attempt === undefined || binding === undefined || operation === undefined || executionInput === undefined) {
			throw new FoundationError("invalid_correlation", "External Connector recovery facts are incomplete");
		}
		if (input.expectedText !== undefined && executionInput.input.text !== input.expectedText) {
			throw new ExternalConnectorProductError(
				"external_binding_invalid",
				"External Connector recovery input does not match the persisted Attempt.",
			);
		}
		const task = requireValue(
			validateTaskEnvelope(requireFactPayload(await ledger.get("task", identity.taskId), "task", identity.taskId)),
		);
		const dispatch = requireValue(
			validateDispatch(
				requireFactPayload(await ledger.get("dispatch", identity.dispatchId), "dispatch", identity.dispatchId),
			),
		);
		const epoch = requireValue(
			validateBindingEpoch(
				requireFactPayload(
					await ledger.get("binding_epoch", identity.bindingEpochId),
					"binding_epoch",
					identity.bindingEpochId,
				),
			),
		);
		if (
			attempt.taskId !== task.taskId ||
			attempt.dispatchId !== dispatch.dispatchId ||
			attempt.bindingId !== binding.bindingId ||
			attempt.bindingEpochIds[0] !== epoch.bindingEpochId ||
			dispatch.taskId !== task.taskId ||
			dispatch.bindingId !== binding.bindingId ||
			dispatch.taskExecutorProviderId !== selected.value.connector.providerId ||
			operation.providerId !== selected.value.connector.providerId ||
			operation.correlation.runId !== input.runId
		) {
			throw new FoundationError(
				"invalid_correlation",
				"External Connector recovery identity does not match durable facts",
			);
		}
		let attemptReceipt = await store.readReceipt(attempt.attemptId);
		if (attemptReceipt === undefined) {
			const recovered =
				operation.status === "running" && selected.value.capabilitySnapshot.resume
					? await selected.value.connector.resumeAttempt(attempt, {
							correlation: operation.correlation,
							...(input.signal === undefined ? {} : { signal: input.signal }),
						})
					: await selected.value.connector.reconcileAttempt(attempt, {
							correlation: operation.correlation,
							...(input.signal === undefined ? {} : { signal: input.signal }),
						});
			if (!recovered.ok) throw recovered.error;
			attemptReceipt = recovered.value;
		}
		const priorTaskResultRecord = await ledger.get("task_result", `task_result_${input.runId}`);
		const settlementTimestamp = priorTaskResultRecord === undefined
			? attemptReceipt.provenance.producedAt
			: requireValue(validateTaskResult(requireFactPayload(
				priorTaskResultRecord,
				"task_result",
				`task_result_${input.runId}`,
			))).provenance.producedAt;
		const settlement = new LayeredResultSettlement(input.session, {
			ownerId: `external-connector:${binding.bindingId}`,
			...(input.writer === undefined ? {} : { writer: input.writer }),
		});
		try {
			return await settleExternalConnectorProductRun(
				settlement,
				{
					task,
					binding,
					dispatch,
					initialBindingEpoch: epoch,
					correlation: operation.correlation,
					attemptReceipt,
					timestamp: settlementTimestamp,
				},
				input.runId,
			);
		} finally {
			await settlement.release();
		}
	} finally {
		await ledger.release();
	}
}

/** Prepare and execute one current External Connector run. */
export async function executeExternalConnectorProductRun(
	input: ExternalConnectorProductExecutionInput,
): Promise<ExternalConnectorProductExecution> {
	const admission = await prepareExternalConnectorProductRun(input);
	return executePreparedExternalConnectorProductRun(await persistExternalConnectorProductRunAfterAcceptance(admission));
}
