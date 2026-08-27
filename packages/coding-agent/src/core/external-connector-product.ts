import {
	canonicalFoundationJson,
	cloneDeepFrozen,
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
	validateToolGatewayRequest,
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
	type ToolExecutionResult,
	type ToolGatewayRequest,
} from "@aos-agent/agent-core";
import {
	gateCanonicalExternalAgentInputBeforeAcceptance,
	validateCanonicalExternalAgentInput,
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
	EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
	SessionExternalConnectorDurableStore,
	type ExternalConnectorExecutionInput,
	type ExternalConnectorToolGatewayIntent,
	type ExternalConnectorToolGatewayTerminal,
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
	/** Request material supplied by the caller; the Host supplies immutable execution context. */
	readonly toolGatewayRequest?: ExternalConnectorToolGatewayRequestInput;
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
	readonly toolGatewayExchange?: ExternalConnectorToolGatewayExchange;
}

export type ExternalConnectorToolGatewayRequestInput = Omit<ToolGatewayRequest, "context">;

export interface ExternalConnectorToolGatewayExchange {
	readonly request: ToolGatewayRequest;
	readonly result: ToolExecutionResult;
}

export interface ExternalConnectorProductRecoveryInput {
	readonly session: Session;
	readonly writer?: SessionLedgerWriter;
	readonly registry: ExternalConnectorRegistry;
	readonly runId: string;
	readonly providerId: string;
	readonly selection?: ExternalConnectorSelection;
	/** RPC recovery must exactly match the immutable canonical input of the durable Attempt. */
	readonly expectedCanonicalInput: CanonicalExternalAgentInput;
	/** Omission means the durable Attempt must not contain a Tool Gateway request. */
	readonly expectedToolGatewayRequest?: ExternalConnectorToolGatewayRequestInput;
	readonly signal?: AbortSignal;
	/**
	 * Accepted transport facts can precede every product fact. This input is the
	 * read-only admission material needed to reconstruct that proven
	 * no-side-effect prefix with the same deterministic product identities.
	 */
	readonly reconstruction?: {
		readonly canonicalInput: CanonicalExternalAgentInput;
		readonly inputAdmission: Pick<ExternalAgentInputAdmissionOptions, "inspectArtifact">;
		readonly workspace: string;
		readonly acceptedAt?: string;
		readonly toolGatewayRequest?: ExternalConnectorToolGatewayRequestInput;
		readonly gatewayModelRoute?: ExternalConnectorProductExecutionInput["gatewayModelRoute"];
	};
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
	readonly toolGatewayRequest?: ToolGatewayRequest;
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
	readonly toolGatewayRequest?: ToolGatewayRequest;
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

const TOOL_GATEWAY_REQUEST_INPUT_KEYS = new Set([
	"schemaVersion",
	"toolCallId",
	"toolName",
	"namespace",
	"originalArguments",
	"idempotencyKey",
	"deadlineAt",
]);

function materializeToolGatewayRequest(
	value: ExternalConnectorToolGatewayRequestInput,
	runId: string,
	selection: ExternalConnectorResolvedSelection,
): ToolGatewayRequest {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Reflect.ownKeys(value).some((key) => typeof key !== "string" || !TOOL_GATEWAY_REQUEST_INPUT_KEYS.has(key))
	) {
		throw new ExternalConnectorProductError("external_binding_invalid", "External Connector Tool Gateway request is invalid.");
	}
	const identity = externalConnectorProductIdentity(runId, selection.descriptor.providerId);
	const checked = validateToolGatewayRequest({
		...value,
		context: {
			schemaVersion: 1,
			bindingId: identity.bindingId,
			bindingEpochId: identity.bindingEpochId,
			taskId: identity.taskId,
			dispatchId: identity.dispatchId,
			providerId: selection.descriptor.providerId,
			attemptId: identity.attemptId,
			operationId: runId,
		},
	});
	if (!checked.ok) {
		throw new ExternalConnectorProductError("external_binding_invalid", "External Connector Tool Gateway request is invalid.");
	}
	return cloneDeepFrozen(checked.value);
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
	if (input.toolGatewayRequest !== undefined && !selected.value.capabilityTruth.capabilities.toolGateway) {
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
	const toolGatewayRequest = input.toolGatewayRequest === undefined
		? undefined
		: materializeToolGatewayRequest(input.toolGatewayRequest, input.runId, selected.value);
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
		...(toolGatewayRequest === undefined ? {} : { toolGatewayRequest }),
		...(modelProjection === undefined ? {} : { modelProjection }),
		...(modelTranslation === undefined ? {} : { modelTranslation }),
	};
}

/** Persist an already accepted admission before starting its pure Attempt. */
export async function persistExternalConnectorProductRunAfterAcceptance(
	admission: ExternalConnectorProductAdmission,
): Promise<PreparedExternalConnectorProductRun> {
	const { input, selected, admittedInput, requestFingerprint, route, modelProjection, modelTranslation, toolGatewayRequest } = admission;
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
			...(toolGatewayRequest === undefined ? {} : { toolGatewayRequest }),
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
		...(toolGatewayRequest === undefined ? {} : { toolGatewayRequest }),
	};
}

type ExternalConnectorToolGatewayResolution =
	| { readonly kind: "none" }
	| { readonly kind: "terminal"; readonly exchange: ExternalConnectorToolGatewayExchange }
	| { readonly kind: "ambiguous" };

function toolGatewayExchange(
	terminal: ExternalConnectorToolGatewayTerminal,
): ExternalConnectorToolGatewayExchange {
	return cloneDeepFrozen({ request: terminal.request, result: terminal.result });
}

async function resolvePreparedToolGateway(
	prepared: PreparedExternalConnectorProductRun,
	store: SessionExternalConnectorDurableStore,
): Promise<ExternalConnectorToolGatewayResolution> {
	const request = prepared.toolGatewayRequest;
	const existing = await store.readToolGatewayExecution(prepared.initialBindingEpoch.attemptId);
	if (request === undefined) {
		if (existing !== undefined) {
			throw new FoundationError(
				"invalid_correlation",
				"Durable Tool Gateway execution exists for an Attempt without a request",
			);
		}
		return { kind: "none" };
	}
	if (
		existing !== undefined &&
		canonicalFoundationJson(existing.intent.request) !== canonicalFoundationJson(request)
	) {
		throw new FoundationError("invalid_correlation", "Durable Tool Gateway request does not match the Attempt");
	}
	if (existing?.terminal !== undefined) {
		return { kind: "terminal", exchange: toolGatewayExchange(existing.terminal) };
	}
	if (existing !== undefined) return { kind: "ambiguous" };

	const correlation: ExecutionCorrelation = {
		...prepared.correlation,
		toolCallId: request.toolCallId,
	};
	const intent: ExternalConnectorToolGatewayIntent = {
		schemaVersion: 1,
		type: EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
		id: prepared.initialBindingEpoch.attemptId,
		phase: "intent",
		providerId: prepared.selected.descriptor.providerId,
		attemptId: prepared.initialBindingEpoch.attemptId,
		bindingId: prepared.binding.bindingId,
		bindingEpochId: prepared.initialBindingEpoch.bindingEpochId,
		correlation,
		request,
		createdAt: prepared.timestamp,
	};
	const writtenIntent = await store.writeToolGatewayIntent(intent);
	if (!writtenIntent.claimed) {
		const replay = await store.readToolGatewayExecution(prepared.initialBindingEpoch.attemptId);
		return replay?.terminal === undefined
			? { kind: "ambiguous" }
			: { kind: "terminal", exchange: toolGatewayExchange(replay.terminal) };
	}

	const gatewayResult = await prepared.selected.executeToolGateway(
		request,
		prepared.input.signal === undefined ? undefined : { signal: prepared.input.signal },
	);
	if (!gatewayResult.ok) throw gatewayResult.error;
	const terminal: ExternalConnectorToolGatewayTerminal = {
		schemaVersion: 1,
		type: EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
		id: intent.id,
		phase: "terminal",
		providerId: intent.providerId,
		attemptId: intent.attemptId,
		bindingId: intent.bindingId,
		bindingEpochId: intent.bindingEpochId,
		correlation,
		request,
		result: gatewayResult.value,
		createdAt: intent.createdAt,
		completedAt: (prepared.input.now ?? (() => new Date().toISOString()))(),
	};
	const durableTerminal = await store.writeToolGatewayTerminal(terminal);
	return { kind: "terminal", exchange: toolGatewayExchange(durableTerminal) };
}

/** Execute a pre-accepted current Connector run through the canonical terminal chain. */
export async function executePreparedExternalConnectorProductRun(
	prepared: PreparedExternalConnectorProductRun,
): Promise<ExternalConnectorProductExecution> {
	const { input, selected, timestamp, task, binding, dispatch, initialBindingEpoch: epoch, correlation } = prepared;
	const ledger = new SessionLedger(input.session, {
		ownerId: `external-connector-tool-gateway:${binding.bindingId}`,
		...(input.writer === undefined ? {} : { writer: input.writer }),
	});
	const store = new SessionExternalConnectorDurableStore(ledger);
	const settlement = new LayeredResultSettlement(input.session, {
		ownerId: `external-connector:${binding.bindingId}`,
		...(input.writer === undefined ? {} : { writer: input.writer }),
	});
	try {
		const gateway = await resolvePreparedToolGateway(prepared, store);
		if (gateway.kind === "ambiguous") {
			throw new FoundationError(
				"side_effect_unknown",
				"Tool Gateway intent has no proven terminal result and cannot be repeated",
			);
		}
		const executed = await settlement.executeDispatch({
			provider: selected.connector,
			dispatch,
			binding,
			initialBindingEpoch: epoch,
			correlation,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		if (!executed.ok) throw executed.error;
		const execution = await settleExternalConnectorProductRun(
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
		return gateway.kind === "none"
			? execution
			: Object.freeze({ ...execution, toolGatewayExchange: gateway.exchange });
	} finally {
		await settlement.release();
		await ledger.release();
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

interface ExternalConnectorRecoverySelection {
	readonly selection: ExternalConnectorSelection;
	readonly selected: ExternalConnectorResolvedSelection;
}

async function resolveExternalConnectorRecoverySelection(
	input: ExternalConnectorProductRecoveryInput,
): Promise<ExternalConnectorRecoverySelection> {
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
	return { selection, selected: selected.value };
}

function optionalCanonicalValuesMatch(left: unknown | undefined, right: unknown | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

function validateExternalConnectorRecoveryExpectedInput(
	input: ExternalConnectorProductRecoveryInput,
	selected: ExternalConnectorResolvedSelection,
	durableExecutionInput: ExternalConnectorExecutionInput | undefined,
): void {
	const expectedInput = validateCanonicalExternalAgentInput(input.expectedCanonicalInput);
	if (!expectedInput.ok) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External Connector recovery input does not match the persisted Attempt.",
		);
	}
	const expectedRequest = input.expectedToolGatewayRequest === undefined
		? undefined
		: materializeToolGatewayRequest(input.expectedToolGatewayRequest, input.runId, selected);
	if (
		input.reconstruction !== undefined &&
		canonicalFoundationJson(input.reconstruction.canonicalInput) !== canonicalFoundationJson(expectedInput.value)
	) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External Connector recovery input does not match its reconstruction.",
		);
	}
	const reconstructionRequest = input.reconstruction?.toolGatewayRequest === undefined
		? undefined
		: materializeToolGatewayRequest(input.reconstruction.toolGatewayRequest, input.runId, selected);
	if (!optionalCanonicalValuesMatch(reconstructionRequest, expectedRequest)) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External Connector recovery Tool Gateway request does not match its reconstruction.",
		);
	}
	if (
		durableExecutionInput !== undefined &&
		(
			canonicalFoundationJson(durableExecutionInput.input) !== canonicalFoundationJson(expectedInput.value) ||
			!optionalCanonicalValuesMatch(durableExecutionInput.toolGatewayRequest, expectedRequest)
		)
	) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External Connector recovery input does not match the persisted Attempt.",
		);
	}
}

/** Validate immutable recovery input before RPC publishes a resumed acceptance. */
export async function preflightExternalConnectorProductRecovery(
	input: ExternalConnectorProductRecoveryInput,
): Promise<void> {
	const identity = externalConnectorProductIdentity(input.runId, input.providerId);
	const { selected } = await resolveExternalConnectorRecoverySelection(input);
	const ledger = new SessionLedger(input.session, {
		ownerId: `external-connector-recovery-preflight:${identity.bindingId}`,
		...(input.writer === undefined ? {} : { writer: input.writer }),
	});
	try {
		const store = new SessionExternalConnectorDurableStore(ledger);
		validateExternalConnectorRecoveryExpectedInput(
			input,
			selected,
			await store.readExecutionInput(identity.taskId),
		);
	} finally {
		await ledger.release();
	}
}

/** Recover one accepted product Run without replacing an ambiguous vendor side effect. */
export async function recoverExternalConnectorProductRun(
	input: ExternalConnectorProductRecoveryInput,
): Promise<ExternalConnectorProductExecution> {
	const identity = externalConnectorProductIdentity(input.runId, input.providerId);
	const { selection, selected } = await resolveExternalConnectorRecoverySelection(input);
	const ledger = new SessionLedger(input.session, {
		ownerId: `external-connector-recovery:${identity.bindingId}`,
		...(input.writer === undefined ? {} : { writer: input.writer }),
	});
	const store = new SessionExternalConnectorDurableStore(ledger);
	try {
		const taskRecord = await ledger.get("task", identity.taskId);
		const dispatchRecord = await ledger.get("dispatch", identity.dispatchId);
		const epochRecord = await ledger.get("binding_epoch", identity.bindingEpochId);
		const durableTask = taskRecord === undefined
			? undefined
			: requireValue(validateTaskEnvelope(requireFactPayload(taskRecord, "task", identity.taskId)));
		const durableBinding = await store.readBinding(identity.bindingId);
		const durableDispatch = dispatchRecord === undefined
			? undefined
			: requireValue(validateDispatch(requireFactPayload(dispatchRecord, "dispatch", identity.dispatchId)));
		const durableEpoch = epochRecord === undefined
			? undefined
			: requireValue(
					validateBindingEpoch(requireFactPayload(epochRecord, "binding_epoch", identity.bindingEpochId)),
				);
		const durableExecutionInput = await store.readExecutionInput(identity.taskId);
		validateExternalConnectorRecoveryExpectedInput(input, selected, durableExecutionInput);
		let prepared: PreparedExternalConnectorProductRun;
		if (
			durableTask !== undefined &&
			durableBinding !== undefined &&
			durableDispatch !== undefined &&
			durableEpoch !== undefined &&
			durableExecutionInput !== undefined
		) {
			const metadata = await input.session.getMetadata();
			prepared = {
				input: {
					session: input.session,
					...(input.writer === undefined ? {} : { writer: input.writer }),
					registry: input.registry,
					selection,
					runId: input.runId,
					message: durableExecutionInput.input.text,
					canonicalInput: durableExecutionInput.input,
					inputAdmission: {
						inspectArtifact: () => {
							throw new ExternalConnectorProductError(
								"external_binding_invalid",
								"Durable recovery input cannot be re-inspected after acceptance",
							);
						},
					},
					workspace: durableTask.workspace,
					...(durableExecutionInput.toolGatewayRequest === undefined
						? {}
						: {
							toolGatewayRequest: {
								schemaVersion: 1,
								toolCallId: durableExecutionInput.toolGatewayRequest.toolCallId,
								toolName: durableExecutionInput.toolGatewayRequest.toolName,
								originalArguments: durableExecutionInput.toolGatewayRequest.originalArguments,
								...(durableExecutionInput.toolGatewayRequest.namespace === undefined ? {} : { namespace: durableExecutionInput.toolGatewayRequest.namespace }),
								...(durableExecutionInput.toolGatewayRequest.idempotencyKey === undefined ? {} : { idempotencyKey: durableExecutionInput.toolGatewayRequest.idempotencyKey }),
								...(durableExecutionInput.toolGatewayRequest.deadlineAt === undefined ? {} : { deadlineAt: durableExecutionInput.toolGatewayRequest.deadlineAt }),
							},
						}),
					...(input.signal === undefined ? {} : { signal: input.signal }),
				},
				selected,
				timestamp: durableTask.createdAt,
				task: durableTask,
				binding: durableBinding,
				dispatch: durableDispatch,
				initialBindingEpoch: durableEpoch,
				correlation: {
					sessionId: metadata.id,
					laneId: "main",
					runId: input.runId,
					operationId: input.runId,
					taskId: identity.taskId,
					dispatchId: identity.dispatchId,
					attemptId: identity.attemptId,
					bindingId: identity.bindingId,
					bindingEpochId: identity.bindingEpochId,
					providerId: selected.connector.providerId,
					revision: 0,
				},
				...(durableExecutionInput.toolGatewayRequest === undefined
					? {}
					: { toolGatewayRequest: durableExecutionInput.toolGatewayRequest }),
			};
		} else {
			const reconstruction = input.reconstruction;
			if (reconstruction === undefined) {
				throw new FoundationError("invalid_correlation", "External Connector recovery facts are incomplete");
			}
			const admission = await prepareExternalConnectorProductRun({
				session: input.session,
				...(input.writer === undefined ? {} : { writer: input.writer }),
				registry: input.registry,
				selection,
				runId: input.runId,
				message: reconstruction.canonicalInput.text,
				canonicalInput: reconstruction.canonicalInput,
				inputAdmission: reconstruction.inputAdmission,
				workspace: reconstruction.workspace,
				...(input.signal === undefined ? {} : { signal: input.signal }),
				...(reconstruction.toolGatewayRequest === undefined
					? {}
					: { toolGatewayRequest: reconstruction.toolGatewayRequest }),
				...(reconstruction.gatewayModelRoute === undefined
					? {}
					: { gatewayModelRoute: reconstruction.gatewayModelRoute }),
				now: () => durableTask?.createdAt ?? reconstruction.acceptedAt ?? new Date().toISOString(),
			});
			if (admission.selected.connector !== selected.connector) {
				throw new ExternalConnectorProductError(
					"external_capability_mismatch",
					"External Connector authority changed during recovery.",
				);
			}
			prepared = await persistExternalConnectorProductRunAfterAcceptance(admission);
		}
		const settlement = new LayeredResultSettlement(input.session, {
			ownerId: `external-connector:${prepared.binding.bindingId}`,
			...(input.writer === undefined ? {} : { writer: input.writer }),
		});
		try {
			const started = await settlement.startDispatch({
				provider: prepared.selected.connector,
				dispatch: prepared.dispatch,
				binding: prepared.binding,
				initialBindingEpoch: prepared.initialBindingEpoch,
				correlation: prepared.correlation,
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			if (!started.ok) throw started.error;
			const gateway = await resolvePreparedToolGateway(prepared, store);
			const operation = await store.readOperation(identity.attemptId);
			const mapping = await store.readMapping(identity.attemptId);
			if (
				operation !== undefined &&
				(operation.providerId !== prepared.selected.connector.providerId ||
					operation.correlation.runId !== input.runId)
			) {
				throw new FoundationError(
					"invalid_correlation",
					"External Connector recovery identity does not match durable facts",
				);
			}
			let attemptReceipt = started.value.receipt ?? await store.readReceipt(started.value.attempt.attemptId);
			if (gateway.kind === "ambiguous") {
				if (attemptReceipt !== undefined) {
					throw new FoundationError(
						"session_ledger_conflict",
						"Ambiguous Tool Gateway intent conflicts with a terminal Connector receipt",
					);
				}
				const attemptReceiptId = `attempt_receipt_${started.value.attempt.attemptId}`;
				attemptReceipt = await store.writeReceipt({
					schemaVersion: 1,
					attemptReceiptId,
					taskId: started.value.attempt.taskId,
					dispatchId: started.value.attempt.dispatchId,
					attemptId: started.value.attempt.attemptId,
					providerId: prepared.selected.connector.providerId,
					bindingId: started.value.attempt.bindingId,
					bindingEpochIds: [...started.value.attempt.bindingEpochIds],
					status: "failed",
					workerReceiptRefs: [],
					artifacts: [],
					error: {
						code: "side_effect_unknown",
						message: "Tool Gateway intent has no proven terminal result and cannot be repeated.",
						category: "side_effect_unknown",
						retryable: false,
					},
					provenance: {
						producerKind: "external_connector",
						providerId: prepared.selected.connector.providerId,
						producedAt: prepared.timestamp,
						correlation: { ...prepared.correlation, attemptReceiptId },
					},
					sideEffectState: "side_effect_unknown",
				});
			} else if (attemptReceipt === undefined) {
				const sideEffectFree = mapping === undefined && (operation === undefined || operation.status === "prepared");
				if (sideEffectFree) {
					const executed = await settlement.executeDispatch({
						provider: prepared.selected.connector,
						dispatch: prepared.dispatch,
						binding: prepared.binding,
						initialBindingEpoch: prepared.initialBindingEpoch,
						correlation: prepared.correlation,
						...(input.signal === undefined ? {} : { signal: input.signal }),
					});
					if (!executed.ok) throw executed.error;
					attemptReceipt = executed.value.receipt;
				} else {
					const recovered = operation === undefined
						? undefined
						: operation.status === "running" && prepared.selected.capabilitySnapshot.resume
							? await prepared.selected.connector.resumeAttempt(started.value.attempt, {
									correlation: operation.correlation,
									...(input.signal === undefined ? {} : { signal: input.signal }),
								})
							: await prepared.selected.connector.reconcileAttempt(started.value.attempt, {
									correlation: operation.correlation,
									...(input.signal === undefined ? {} : { signal: input.signal }),
								});
					if (recovered?.ok === true) {
						attemptReceipt = recovered.value;
					} else {
						const attemptReceiptId = `attempt_receipt_${started.value.attempt.attemptId}`;
						attemptReceipt = await store.writeReceipt({
							schemaVersion: 1,
							attemptReceiptId,
							taskId: started.value.attempt.taskId,
							dispatchId: started.value.attempt.dispatchId,
							attemptId: started.value.attempt.attemptId,
							providerId: prepared.selected.connector.providerId,
							bindingId: started.value.attempt.bindingId,
							bindingEpochIds: [...started.value.attempt.bindingEpochIds],
							status: "failed",
							workerReceiptRefs: [],
							artifacts: [],
							error: {
								code: "side_effect_unknown",
								message: "External connector recovery could not prove a terminal vendor outcome.",
								category: "side_effect_unknown",
								retryable: false,
							},
							provenance: {
								producerKind: "external_connector",
								providerId: prepared.selected.connector.providerId,
								producedAt: operation?.updatedAt ?? prepared.timestamp,
								correlation: { ...prepared.correlation, attemptReceiptId },
							},
							sideEffectState: "side_effect_unknown",
						});
					}
				}
			}
			const priorTaskResultRecord = await ledger.get("task_result", `task_result_${input.runId}`);
			const settlementTimestamp = priorTaskResultRecord === undefined
				? attemptReceipt.provenance.producedAt
				: requireValue(
						validateTaskResult(
							requireFactPayload(
								priorTaskResultRecord,
								"task_result",
								`task_result_${input.runId}`,
							),
						),
					).provenance.producedAt;
			const execution = await settleExternalConnectorProductRun(
				settlement,
				{
					task: prepared.task,
					binding: prepared.binding,
					dispatch: prepared.dispatch,
					initialBindingEpoch: prepared.initialBindingEpoch,
					correlation: prepared.correlation,
					attemptReceipt,
					timestamp: settlementTimestamp,
				},
				input.runId,
			);
			return gateway.kind === "terminal"
				? Object.freeze({ ...execution, toolGatewayExchange: gateway.exchange })
				: execution;
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
