import {
	canonicalFoundationJson,
	cloneDeepFrozen,
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
	resolveMcpSelection,
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
	type ToolExecutionResult,
	type ToolGatewayRequest,
} from "@aos-agent/agent-core";
import { createGoalStore } from "../orchestration/goal-store.ts";
import {
	gateCanonicalExternalAgentInputBeforeAcceptance,
	validateCanonicalExternalAgentInput,
	type CanonicalExternalAgentInput,
	type CanonicalExternalAgentRequestFingerprint,
	type ExternalAgentInputAdmissionOptions,
} from "./input.ts";
import {
	isExternalResolvedModelProjection,
	type ExternalModelFallbackDecision,
	type ExternalModelTranslationResult,
	type ExternalResolvedModelProjection,
	type ExternalTranslatedModelProjection,
} from "./model-projection.ts";
import type { PolicyBinding } from "../policy/execution.ts";
import type { CapabilityBinding } from "../policy/capability-registry.ts";
import { createPolicyBindingLedgerRecord } from "../policy/execution-ledger.ts";
import {
	bindExternalConnectorToolGatewayConsumer,
	getExternalConnectorToolGatewayCatalogSnapshot,
	getExternalConnectorToolGatewayRouteCatalog,
	settleExternalConnectorRecoveryFailure,
	type ExternalConnectorRegistry,
	type ExternalConnectorResolvedSelection,
	type ExternalConnectorSelection,
} from "./registry.ts";
import {
	EXTERNAL_CONNECTOR_EXECUTION_INPUT_OBJECT_TYPE,
	SessionExternalConnectorDurableStore,
	type ExternalConnectorExecutionInput,
	type ExternalConnectorToolGatewayTerminal,
} from "./operation.ts";

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
	/** Resolver-owned canonical policy authority for this Run. */
	readonly policyBinding: PolicyBinding;
	/** Exact current CapabilityBinding required when the Connector can call tools. */
	readonly capabilityBinding?: CapabilityBinding;
	readonly signal?: AbortSignal;
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
	readonly toolGatewayExchanges?: readonly ExternalConnectorToolGatewayExchange[];
}

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
	/** RPC recovery must exactly match the immutable durable canonical execution input. */
	readonly expectedCanonicalInput: CanonicalExternalAgentInput;
	/** When supplied, the caller's resolved route must exactly match the durable model projection. */
	readonly expectedGatewayModelRoute?: ExternalConnectorProductExecutionInput["gatewayModelRoute"];
	readonly signal?: AbortSignal;
	/**
	 * Accepted transport facts can precede the canonical Task and binding facts.
	 * This contains only trusted admission context; exact execution material is
	 * always reconstructed from the durable pre-accept execution-input fact.
	 */
	readonly reconstruction?: {
		readonly inputAdmission: Pick<ExternalAgentInputAdmissionOptions, "inspectArtifact">;
		readonly workspace: string;
		readonly policyBinding: PolicyBinding;
		readonly capabilityBinding?: CapabilityBinding;
		readonly acceptedAt?: string;
	};
}

export type ExternalConnectorProductErrorCode =
	| "external_binding_invalid"
	| "external_capability_mismatch"
	| "external_mapping_conflict"
	| "external_resume_unsupported";

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

/** Read-only admission result. The immutable execution input is persisted before transport acceptance. */
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

function cloneProductCapabilityBinding(value: CapabilityBinding): CapabilityBinding {
	if (
		value.id.length === 0 ||
		value.profile.length === 0 ||
		value.createdAt.length === 0 ||
		!Array.isArray(value.descriptors) ||
		!Array.isArray(value.toolAllowlist) ||
		value.descriptors.some((descriptor) => descriptor.id.length === 0 || descriptor.revision.length === 0) ||
		value.toolAllowlist.some((toolName) => toolName.length === 0)
	) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External Connector capability binding is invalid",
		);
	}
	return cloneDeepFrozen({
		id: value.id,
		profile: value.profile,
		createdAt: value.createdAt,
		descriptors: value.descriptors.map((descriptor) => ({ ...descriptor })),
		decisionSummary: { ...value.decisionSummary },
		toolAllowlist: [...value.toolAllowlist],
	});
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
	)
		return undefined;
	return value as ExternalConnectorModelProjectionPreflight;
}

function requireValue<T>(
	result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: FoundationError },
): T {
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

function revisionReference(
	type: string,
	id: string,
	payload: FoundationJsonValue,
	providerId?: string,
): RevisionReference {
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
		if (existing.kind === "fact" && canonicalFoundationJson(existing.payload) === canonicalFoundationJson(payload))
			return;
		throw new FoundationError(
			"session_ledger_conflict",
			`${objectType} ${objectId} conflicts with external execution`,
		);
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

function exactModelProjection(
	route: NonNullable<ExternalConnectorProductExecutionInput["gatewayModelRoute"]>,
): ExternalResolvedModelProjection {
	const projection = {
		schemaVersion: 1 as const,
		provider: route.provider,
		model: route.model,
		effort: route.effort,
		serviceTier: route.serviceTier,
		fallbackDecision: route.fallbackDecision,
		bindingDigest: route.bindingDigest,
	};
	if (!isExternalResolvedModelProjection(projection)) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External gateway model projection is invalid",
		);
	}
	return projection;
}

/** Read-only pre-accept input, model-route, and driver-translation admission. */
export async function prepareExternalConnectorProductRun(
	input: ExternalConnectorProductExecutionInput,
): Promise<ExternalConnectorProductAdmission> {
	if (input.message.length === 0 || input.runId.length === 0 || input.workspace.length === 0) {
		throw new FoundationError(
			"foundation_schema_invalid_shape",
			"External connector run identity and text are required",
		);
	}
	if (input.message !== input.canonicalInput.text) {
		throw new FoundationError(
			"foundation_schema_invalid_shape",
			"External connector text must match its canonical input",
		);
	}
	if (input.policyBinding.runId !== input.runId) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External Connector execution requires the canonical policy binding for its Run",
		);
	}
	const selected = await input.registry.select(input.selection);
	if (!selected.ok) throw selected.error;
	let capabilityBinding: CapabilityBinding | undefined;
	if (selected.value.capabilitySnapshot.toolGateway) {
		if (input.capabilityBinding === undefined) {
			throw new ExternalConnectorProductError(
				"external_binding_invalid",
				"External Connector Tool Gateway requires the exact CapabilityBinding",
			);
		}
		capabilityBinding = cloneProductCapabilityBinding(input.capabilityBinding);
		if (
			input.policyBinding.capabilityBindingId !== undefined &&
			input.policyBinding.capabilityBindingId !== capabilityBinding.id
		) {
			throw new ExternalConnectorProductError(
				"external_binding_invalid",
				"External Connector capability and policy bindings do not match",
			);
		}
		getExternalConnectorToolGatewayRouteCatalog(selected.value);
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
			throw new ExternalConnectorProductError(
				"external_binding_invalid",
				"External gateway model binding is missing",
			);
		}
		const exactProjection = exactModelProjection(gatewayRoute);
		const preflight = modelProjectionPreflight(selected.value.connector);
		if (preflight === undefined) {
			throw new ExternalConnectorProductError(
				"external_binding_invalid",
				"External gateway model translation is unavailable",
			);
		}
		const translated = preflight.preflightModelProjection(exactProjection);
		if (!translated.ok) {
			throw new ExternalConnectorProductError(
				translated.error.code,
				`External gateway model translation failed: ${translated.error.reasonCode}`,
			);
		}
		modelProjection = exactProjection;
		modelTranslation = translated.translation;
	}
	return {
		input: capabilityBinding === undefined ? input : Object.freeze({ ...input, capabilityBinding }),
		selected: selected.value,
		admittedInput: admitted.input,
		requestFingerprint: admitted.requestFingerprint,
		route,
		...(modelProjection === undefined ? {} : { modelProjection }),
		...(modelTranslation === undefined ? {} : { modelTranslation }),
	};
}

function durableExecutionInputForAdmission(
	admission: ExternalConnectorProductAdmission,
): ExternalConnectorExecutionInput {
	return cloneDeepFrozen({
		schemaVersion: 1,
		taskId: externalConnectorProductIdentity(admission.input.runId, admission.selected.descriptor.providerId).taskId,
		requestFingerprint: admission.requestFingerprint,
		input: admission.admittedInput,
		...(admission.modelProjection === undefined ? {} : { modelProjection: admission.modelProjection }),
		...(admission.modelTranslation === undefined ? {} : { modelTranslation: admission.modelTranslation }),
	});
}

/** Persist exact immutable execution material before RPC accepted/started facts. */
export async function persistExternalConnectorProductAdmissionBeforeAcceptance(
	admission: ExternalConnectorProductAdmission,
): Promise<void> {
	const identity = externalConnectorProductIdentity(admission.input.runId, admission.selected.descriptor.providerId);
	const ledger = new SessionLedger(admission.input.session, {
		ownerId: `external-connector-admission:${identity.bindingId}`,
		...(admission.input.writer === undefined ? {} : { writer: admission.input.writer }),
	});
	try {
		await persistImmutable(
			ledger,
			EXTERNAL_CONNECTOR_EXECUTION_INPUT_OBJECT_TYPE,
			identity.taskId,
			durableExecutionInputForAdmission(admission) as unknown as FoundationJsonValue,
			{ taskId: identity.taskId, bindingId: identity.bindingId },
		);
	} finally {
		await ledger.release();
	}
}

/** Persist an already accepted admission before starting its pure Attempt. */
export async function persistExternalConnectorProductRunAfterAcceptance(
	admission: ExternalConnectorProductAdmission,
): Promise<PreparedExternalConnectorProductRun> {
	const { input, selected, admittedInput, requestFingerprint, route } = admission;
	const timestamp = (input.now ?? (() => new Date().toISOString()))();
	const identityToken = token(input.runId, selected.descriptor.providerId);
	const identity = externalConnectorProductIdentity(input.runId, selected.descriptor.providerId);
	const capabilityBindingId = `capability_binding_${identityToken}`;
	const selectedCapabilityBinding = input.capabilityBinding;
	const toolAllowlist = selectedCapabilityBinding?.toolAllowlist ?? [];
	const capabilityDescriptors = (selectedCapabilityBinding?.descriptors ?? []).flatMap((descriptor) =>
		descriptor.kind === undefined || descriptor.name === undefined
			? []
			: [{
				id: descriptor.id,
				revision: descriptor.revision,
				kind: descriptor.kind,
				name: descriptor.name,
				...(descriptor.exposedToolName === undefined ? {} : { exposedToolName: descriptor.exposedToolName }),
				...(descriptor.parentId === undefined ? {} : { parentId: descriptor.parentId }),
				...(descriptor.mcpServerId === undefined ? {} : { mcpServerId: descriptor.mcpServerId }),
			}],
	);
	const mcpServerIds = [...new Set(capabilityDescriptors.flatMap((descriptor) =>
		descriptor.kind === "mcp_server" && descriptor.mcpServerId !== undefined ? [descriptor.mcpServerId] : [],
	))].sort();
	const mcpSelector = mcpServerIds.length === 0
		? { policy: "none" as const }
		: { policy: "named" as const, named: mcpServerIds };
	const gatewayCatalog = selected.capabilitySnapshot.toolGateway
		? getExternalConnectorToolGatewayCatalogSnapshot(selected)
		: undefined;
	const routeCatalog = gatewayCatalog?.routes ?? [];
	const mcpSelection = requireValue(resolveMcpSelection({
		selector: mcpSelector,
		capabilityBinding: {
			id: capabilityBindingId,
			descriptors: capabilityDescriptors,
			toolAllowlist,
		},
		routeCatalog,
	}));
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
			capabilitySelector: toolAllowlist.length === 0
				? { policy: "none" }
				: { policy: "named", named: [...toolAllowlist].sort() },
			skillSelector: { policy: "all" },
			mcpSelector,
		},
		now: () => DECLARED_AT,
	});
	const metadata = await input.session.getMetadata();
	const goal = await createGoalStore(input.session, input.writer === undefined ? {} : { writer: input.writer }).create(
		{
			sessionId: metadata.id,
			title: "External Connector run",
			description: "Canonical product execution through an External Connector",
		},
		{
			clientRequestId: `external-connector:goal:${metadata.id}:${input.runId}`,
			expectedRevision: 0,
		},
	);
	const artifacts = admittedInput.artifacts.map((artifact) => ({
		schemaVersion: 1 as const,
		artifactId: artifact.artifactId,
		mediaType: artifact.mediaType,
		digest: artifact.digest,
	}));
	const task = requireValue(
		createTaskEnvelope({
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
		}),
	);
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
			id: capabilityBindingId,
			revision: 1 as const,
			snapshotDigest: selected.capabilityTruth.snapshotDigest.value,
			...(selectedCapabilityBinding === undefined
				? {}
				: {
					sourceBindingId: selectedCapabilityBinding.id,
					descriptors: selectedCapabilityBinding.descriptors.map((descriptor) => ({ ...descriptor })),
					toolAllowlist: [...selectedCapabilityBinding.toolAllowlist],
				}),
			...(gatewayCatalog === undefined ? {} : { gatewayId: gatewayCatalog.gatewayId }),
			gatewayCatalogDigest: gatewayCatalog?.catalogDigest.value ?? fingerprintFoundationValue([]).value,
		},
		model: {
			schemaVersion: 1 as const,
			type: "model_broker_binding",
			id: `model_binding_${identityToken}`,
			revision: 1 as const,
			modelAccess: selected.capabilitySnapshot.modelAccess,
			route: { provider: route.provider, model: route.model, effort: route.effort, serviceTier: route.serviceTier },
			...(input.gatewayModelRoute === undefined
				? {}
				: { bindingDigest: input.gatewayModelRoute.bindingDigest.value }),
		},
		policy: {
			...createPolicyBindingLedgerRecord(input.policyBinding),
			type: "policy_binding" as const,
			revision: 1 as const,
		},
	};
	const refs = {
		external: revisionReference(
			"external_agent_binding",
			sourcePayloads.external.id,
			sourcePayloads.external,
			selected.descriptor.providerId,
		),
		capability: revisionReference("capability_binding", sourcePayloads.capability.id, sourcePayloads.capability),
		model: revisionReference("model_broker_binding", sourcePayloads.model.id, sourcePayloads.model),
		policy: revisionReference(
			"policy_binding",
			sourcePayloads.policy.id,
			sourcePayloads.policy as unknown as FoundationJsonValue,
		),
	};
	const binding = requireValue(
		resolveAgentBinding({
			task: persistedTask.value,
			roleRevision,
			modelProfile,
			externalAgentBindingRevision: refs.external,
			capabilityRevision: refs.capability,
			modelBrokerBindingRevision: refs.model,
			policyRevision: refs.policy,
			mcpSelection,
			newBindingId: identity.bindingId,
			now: () => timestamp,
		}),
	);
	const ledger = new SessionLedger(input.session, {
		ownerId: `external-connector:${binding.bindingId}`,
		...(input.writer === undefined ? {} : { writer: input.writer }),
	});
	try {
		const correlationBase = { taskId: persistedTask.value.taskId, bindingId: binding.bindingId };
		await persistImmutable(
			ledger,
			"role_revision",
			roleRevision.roleRevisionId,
			roleRevision as unknown as FoundationJsonValue,
			correlationBase,
		);
		await persistImmutable(
			ledger,
			"model_profile_revision",
			modelProfile.modelProfileId,
			modelProfile as unknown as FoundationJsonValue,
			correlationBase,
		);
		await persistImmutable(
			ledger,
			"external_agent_binding",
			refs.external.id,
			sourcePayloads.external,
			correlationBase,
		);
		await persistImmutable(
			ledger,
			"capability_binding",
			refs.capability.id,
			sourcePayloads.capability,
			correlationBase,
		);
		await persistImmutable(ledger, "model_broker_binding", refs.model.id, sourcePayloads.model, correlationBase);
		await persistImmutable(
			ledger,
			"policy_binding",
			refs.policy.id,
			sourcePayloads.policy as unknown as FoundationJsonValue,
			correlationBase,
		);
		const durableExecutionInput = durableExecutionInputForAdmission(admission);
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

	const dispatch = requireValue(
		validateDispatch({
			schemaVersion: 1,
			dispatchId: identity.dispatchId,
			taskId: persistedTask.value.taskId,
			bindingId: binding.bindingId,
			taskExecutorProviderId: selected.connector.providerId,
			status: "pending",
			createdAt: timestamp,
		}),
	);
	const attemptId = identity.attemptId;
	const epoch = requireValue(
		createOrderedBindingEpoch({
			bindingEpochId: identity.bindingEpochId,
			taskId: persistedTask.value.taskId,
			attemptId,
			bindingId: binding.bindingId,
			activationReason: "attempt_started",
			activatedByCommandId: dispatch.dispatchId,
			now: () => timestamp,
		}),
	);
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

function toolGatewayExchange(terminal: ExternalConnectorToolGatewayTerminal): ExternalConnectorToolGatewayExchange {
	return cloneDeepFrozen({ request: terminal.request, result: terminal.result });
}

async function toolGatewayExchanges(
	store: SessionExternalConnectorDurableStore,
	attemptId: string,
): Promise<readonly ExternalConnectorToolGatewayExchange[]> {
	const executions = await store.listToolGatewayExecutions(attemptId);
	return Object.freeze(
		executions.flatMap((execution) =>
			execution.terminal === undefined ? [] : [toolGatewayExchange(execution.terminal)],
		),
	);
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
	let releaseToolGatewayConsumer: (() => void) | undefined;
	try {
		if (selected.capabilitySnapshot.toolGateway) {
			releaseToolGatewayConsumer = bindExternalConnectorToolGatewayConsumer(
				selected,
				epoch.attemptId,
				binding,
				input.policyBinding,
			);
		}
		const started = await settlement.startDispatch({
			provider: selected.connector,
			dispatch,
			binding,
			initialBindingEpoch: epoch,
			correlation,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		if (!started.ok) throw started.error;
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
		const gatewayExchanges = await toolGatewayExchanges(store, epoch.attemptId);
		return gatewayExchanges.length === 0
			? execution
			: Object.freeze({ ...execution, toolGatewayExchanges: gatewayExchanges });
	} finally {
		releaseToolGatewayConsumer?.();
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
	// wire/ledger field name; local alias below
	const capabilityDigest = descriptor.capabilitySnapshotDigest;
	const selection = input.selection ?? {
		providerId: descriptor.providerId,
		revision: descriptor.revision,
		capabilitySnapshotDigest: capabilityDigest,
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

function validateExternalConnectorRecoveryExpectedInput(
	input: ExternalConnectorProductRecoveryInput,
	selected: ExternalConnectorResolvedSelection,
	durableExecutionInput: ExternalConnectorExecutionInput | undefined,
): asserts durableExecutionInput is ExternalConnectorExecutionInput {
	if (durableExecutionInput === undefined) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External Connector recovery facts do not contain durable execution input.",
		);
	}
	const expectedInput = validateCanonicalExternalAgentInput(input.expectedCanonicalInput);
	if (!expectedInput.ok) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External Connector recovery input does not match the durable execution input.",
		);
	}
	if (canonicalFoundationJson(durableExecutionInput.input) !== canonicalFoundationJson(expectedInput.value)) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External Connector recovery input does not match the persisted Attempt.",
		);
	}
	const requiresGatewayModel = selected.capabilitySnapshot.modelAccess === "aos_gateway";
	if (
		(durableExecutionInput.modelProjection !== undefined) !== requiresGatewayModel ||
		(durableExecutionInput.modelTranslation !== undefined) !== requiresGatewayModel
	) {
		throw new ExternalConnectorProductError(
			"external_binding_invalid",
			"External Connector recovery model projection does not match the persisted capability.",
		);
	}
	if (input.expectedGatewayModelRoute !== undefined) {
		const expectedModelProjection = exactModelProjection(input.expectedGatewayModelRoute);
		if (
			durableExecutionInput.modelProjection === undefined ||
			canonicalFoundationJson(durableExecutionInput.modelProjection) !==
				canonicalFoundationJson(expectedModelProjection)
		) {
			throw new ExternalConnectorProductError(
				"external_binding_invalid",
				"External Connector recovery model projection does not match the durable execution input.",
			);
		}
	}
}

function gatewayModelRouteFromDurableInput(
	input: ExternalConnectorExecutionInput,
): ExternalConnectorProductExecutionInput["gatewayModelRoute"] {
	const projection = input.modelProjection;
	if (projection === undefined) return undefined;
	return {
		provider: projection.provider,
		model: projection.model,
		effort: projection.effort,
		serviceTier: projection.serviceTier,
		fallbackDecision: projection.fallbackDecision,
		bindingDigest: projection.bindingDigest,
	};
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
		if (
			!selected.capabilitySnapshot.resume &&
			await ledger.get("run_receipt", input.runId) !== undefined
		) {
			throw new ExternalConnectorProductError(
				"external_resume_unsupported",
				"The selected External Connector does not support resume.",
			);
		}
		const store = new SessionExternalConnectorDurableStore(ledger);
		validateExternalConnectorRecoveryExpectedInput(input, selected, await store.readExecutionInput(identity.taskId));
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
		const durableTask =
			taskRecord === undefined
				? undefined
				: requireValue(validateTaskEnvelope(requireFactPayload(taskRecord, "task", identity.taskId)));
		const durableBinding = await store.readBinding(identity.bindingId);
		const durableDispatch =
			dispatchRecord === undefined
				? undefined
				: requireValue(validateDispatch(requireFactPayload(dispatchRecord, "dispatch", identity.dispatchId)));
		const durableEpoch =
			epochRecord === undefined
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
			const durableGatewayModelRoute = gatewayModelRouteFromDurableInput(durableExecutionInput);
			const policyRecord = await ledger.get("policy_binding", durableBinding.policyRevision.id);
			const policyPayload = requireFactPayload(
				policyRecord,
				"policy_binding",
				durableBinding.policyRevision.id,
			);
			const durablePolicyFingerprint = durableBinding.policyRevision.fingerprint;
			if (
				durablePolicyFingerprint === undefined ||
				fingerprintFoundationValue(policyPayload).value !== durablePolicyFingerprint.value
			) {
				throw new ExternalConnectorProductError(
					"external_binding_invalid",
					"External Connector durable policy authority does not match its AgentBinding",
				);
			}
			const durablePolicyBinding = createPolicyBindingLedgerRecord(
				policyPayload as unknown as PolicyBinding,
			) as PolicyBinding;
			if (durablePolicyBinding.id !== durableBinding.policyRevision.id || durablePolicyBinding.runId !== input.runId) {
				throw new ExternalConnectorProductError(
					"external_binding_invalid",
					"External Connector durable policy authority does not match its Run",
				);
			}
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
					policyBinding: durablePolicyBinding,
					...(durableGatewayModelRoute === undefined ? {} : { gatewayModelRoute: durableGatewayModelRoute }),
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
				message: durableExecutionInput.input.text,
				canonicalInput: durableExecutionInput.input,
				inputAdmission: reconstruction.inputAdmission,
				workspace: reconstruction.workspace,
				policyBinding: reconstruction.policyBinding,
				...(reconstruction.capabilityBinding === undefined
					? {}
					: { capabilityBinding: reconstruction.capabilityBinding }),
				...(input.signal === undefined ? {} : { signal: input.signal }),
				...(durableExecutionInput.modelProjection === undefined
					? {}
					: { gatewayModelRoute: gatewayModelRouteFromDurableInput(durableExecutionInput) }),
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
		let releaseToolGatewayConsumer: (() => void) | undefined;
		try {
			if (prepared.selected.capabilitySnapshot.toolGateway) {
				releaseToolGatewayConsumer = bindExternalConnectorToolGatewayConsumer(
					prepared.selected,
					identity.attemptId,
					prepared.binding,
					prepared.input.policyBinding,
				);
			}
			const started = await settlement.startDispatch({
				provider: prepared.selected.connector,
				dispatch: prepared.dispatch,
				binding: prepared.binding,
				initialBindingEpoch: prepared.initialBindingEpoch,
				correlation: prepared.correlation,
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			if (!started.ok) throw started.error;
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
			let attemptReceipt = started.value.receipt ?? (await store.readReceipt(started.value.attempt.attemptId));
			if (attemptReceipt === undefined) {
				const sideEffectFree =
					mapping === undefined && (operation === undefined || operation.status === "prepared");
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
					const recovered =
						operation === undefined
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
						if (recovered === undefined) {
							throw new FoundationError(
								"side_effect_unknown",
								"External connector recovery has no durable operation authority.",
							);
						}
						const connectorSettlement = settleExternalConnectorRecoveryFailure(
							prepared.selected,
							started.value.attempt,
							recovered.error,
						);
						if (connectorSettlement === undefined) throw recovered.error;
						const settledFailure = await connectorSettlement;
						if (!settledFailure.ok) throw settledFailure.error;
						attemptReceipt = settledFailure.value;
					}
				}
			}
			const priorTaskResultRecord = await ledger.get("task_result", `task_result_${input.runId}`);
			const settlementTimestamp =
				priorTaskResultRecord === undefined
					? attemptReceipt.provenance.producedAt
					: requireValue(
							validateTaskResult(
								requireFactPayload(priorTaskResultRecord, "task_result", `task_result_${input.runId}`),
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
			const gatewayExchanges = await toolGatewayExchanges(store, identity.attemptId);
			return gatewayExchanges.length === 0
				? execution
				: Object.freeze({ ...execution, toolGatewayExchanges: gatewayExchanges });
		} finally {
			releaseToolGatewayConsumer?.();
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
	return executePreparedExternalConnectorProductRun(
		await persistExternalConnectorProductRunAfterAcceptance(admission),
	);
}
