/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { ThinkingLevel } from "@aos-agent/agent-core";
import type { ImageContent } from "@aos-agent/ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import type {
	ModelResolution as BrokerModelResolution,
	ModelRoleSelection,
	ModelRouteSelection,
} from "../../core/model-broker.ts";
import {
	foldModelBrokerLedger,
	type ModelBindingLedgerRecord,
	serializePublicModelAttempt,
} from "../../core/model-broker-ledger.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { ExecutionAuditQuery } from "../../core/execution-audit-query.ts";
import { ExecutionAuditError } from "../../core/execution-audit.ts";
import { isExternalExecutionRef } from "../../core/external-session-mapping.ts";
import type {
	AutomationError,
	RunFinalModelReference,
	RunHandle,
	RunId,
	RunLifecycleCoordinator,
	RunModelAttemptSummary,
	RunModelBudgetSummary,
	RunModelReference,
	RunReservation,
	RunStreamEvent,
	RunUsageSnapshot,
} from "../../core/run-lifecycle.ts";
import {
	createAutomationError,
	createRunLifecycleCoordinator,
	foldCapabilityBindingEntries,
	isAutomationErrorCode,
	isTerminalStatus,
	redactAutomationError,
	redactErrorText,
	serializePublicAutomationError,
	serializePublicCapabilityBinding,
	serializePublicContextDrift,
	serializePublicContextSnapshot,
	serializePublicRunReceipt,
	serializePublicRunRecord,
	serializePublicRunStreamEvent,
	serializePublicSessionEntry,
	serializePublicSessionEvent,
	serializePublicSessionTreeNode,
} from "../../core/run-lifecycle.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	GetCapabilitiesData,
	GetExecutionPolicyData,
	GetModelRoutesData,
	AuditQuery,
	AuditQueryData,
	AuditReplayQuery,
	AuditReplayData,
	ExternalMapData,
	ExternalExecutionRef,
	ExternalMappingRequest,
	InitializeData,
	RpcAutomationCommandType,
	RpcAutomationResponse,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSessionStats,
	RpcSlashCommand,
	RpcSourceInfo,
	RunAcceptedData,
	RunGetData,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	AuditEvent,
	AuditEventType,
	AuditQuery,
	AuditQueryData,
	AuditQueryResult,
	AuditReplayData,
	AuditReplayQuery,
	AuditReplayResult,
	AuditWarning,
	AutomationError,
	AutomationErrorCode,
	CapabilityBindingView,
	ExternalExecutionMapping,
	ExternalExecutionRef,
	ExternalMappingSummary,
	ExternalMappingPersistenceResult,
	ExternalMappingRequest,
	GetCapabilitiesData,
	GetExecutionPolicyData,
	GetModelRoutesData,
	InitializeData,
	RpcAutomationCommandType,
	RpcAutomationResponse,
	RpcAuditCommandType,
	RpcAuditQueryCommand,
	RpcAuditReplayCommand,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcExternalMapCommand,
	RpcRunCommandType,
	RpcSessionState,
	RunAcceptedData,
	RunCancelData,
	RunGetData,
	RunReceipt,
	RunRecord,
	RunRecoveryState,
	RunStatus,
	RunStreamEvent,
	RunTerminalStatus,
} from "./rpc-types.ts";

function serializePublicSessionStats(stats: SessionStats): RpcSessionStats {
	const { sessionFile: _sessionFile, ...publicStats } = stats;
	return publicStats;
}

function serializePublicSourceInfo(sourceInfo: SourceInfo): RpcSourceInfo {
	return { scope: sourceInfo.scope, origin: sourceInfo.origin };
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	// Automation Host v1 state
	let hostInitialized = false;
	let coordinator: RunLifecycleCoordinator | undefined;
	let activeHandle: RunHandle | undefined;
	/** Reservation held while the run's preflight is in flight; cleared on accept or release. */
	let activeReservation: RunReservation | undefined;
	const runPromptPromises = new Map<RunId, Promise<void>>();
	const settledRunIds = new Set<RunId>();
	/** Terminal error detected from agent_end (stopReason "error"); used to settle failed/model_error. */
	const terminalErrorByRun = new Map<RunId, AutomationError>();

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: redactErrorText(message) };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	// ---------------------------------------------------------------------
	// Automation Host v1 helpers
	// ---------------------------------------------------------------------

	/** Legacy commands that mutate session/model/run state; rejected once the host is initialized. */
	const HOST_MUTATING_COMMANDS = new Set<string>([
		"prompt",
		"steer",
		"follow_up",
		"abort",
		"new_session",
		"switch_session",
		"set_model",
		"cycle_model",
		"set_thinking_level",
		"cycle_thinking_level",
		"set_steering_mode",
		"set_follow_up_mode",
		"compact",
		"set_auto_compaction",
		"set_auto_retry",
		"abort_retry",
		"bash",
		"abort_bash",
		"export_html",
		"fork",
		"clone",
		"set_session_name",
	]);

	const automationError = (
		id: string | undefined,
		command: RpcAutomationCommandType,
		err: AutomationError,
	): RpcAutomationResponse => ({
		id,
		type: "response",
		command,
		success: false,
		error: serializePublicAutomationError(redactAutomationError(err), "Automation request failed."),
	});

	type AuditAutomationCode =
		| "audit_query_invalid"
		| "audit_cursor_invalid"
		| "audit_scope_unavailable"
		| "audit_run_not_found"
		| "audit_replay_incomplete"
		| "external_mapping_invalid"
		| "external_mapping_conflict"
		| "audit_persistence_failed";

	const isAuditAutomationCode = (value: unknown): value is AuditAutomationCode =>
		value === "audit_query_invalid" ||
		value === "audit_cursor_invalid" ||
		value === "audit_scope_unavailable" ||
		value === "audit_run_not_found" ||
		value === "audit_replay_incomplete" ||
		value === "external_mapping_invalid" ||
		value === "external_mapping_conflict" ||
		value === "audit_persistence_failed";

	const auditErrorMessage = (code: AuditAutomationCode): string => {
		switch (code) {
			case "audit_query_invalid":
				return "The audit query is invalid.";
			case "audit_cursor_invalid":
				return "The audit cursor is invalid.";
			case "audit_scope_unavailable":
				return "The requested audit scope is unavailable.";
			case "audit_run_not_found":
				return "The requested run was not found in the audit scope.";
			case "audit_replay_incomplete":
				return "The audit replay could not be constructed safely.";
			case "external_mapping_invalid":
				return "The external mapping is invalid.";
			case "external_mapping_conflict":
				return "The external mapping conflicts with append-only mapping history.";
			case "audit_persistence_failed":
				return "The external mapping could not be persisted.";
		}
	};

	const auditCommandError = (err: unknown, fallback: AuditAutomationCode): AutomationError => {
		const candidate =
			err instanceof ExecutionAuditError
				? err.code
				: typeof err === "object" && err !== null && "code" in err
					? (err as { code?: unknown }).code
					: undefined;
		const code = isAuditAutomationCode(candidate) ? candidate : fallback;
		return createAutomationError(code, auditErrorMessage(code), false);
	};

	const hostNotInitializedError = (): AutomationError =>
		createAutomationError(
			"host_not_initialized",
			"Automation Host is not initialized. Send initialize with protocolVersion 1 first.",
			false,
		);

	const slashRunInputError = (
		id: string | undefined,
		command: "run.start" | "run.resume",
		message: string,
	): RpcAutomationResponse | undefined => {
		if (!message.startsWith("/")) return undefined;
		return automationError(
			id,
			command,
			createAutomationError(
				"start_rejected",
				"Automation Host v1 does not accept slash-command input for a run.",
				false,
			),
		);
	};

	const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

	const asAutomationError = (err: unknown): AutomationError => {
		if (typeof err === "object" && err !== null && "code" in err && "message" in err && "retryable" in err) {
			const candidate = err as AutomationError;
			if (isAuditAutomationCode(candidate.code)) {
				return createAutomationError(candidate.code, auditErrorMessage(candidate.code), false);
			}
			return createAutomationError(candidate.code, candidate.message, candidate.retryable);
		}
		return createAutomationError("start_rejected", errorMessage(err), false);
	};

	/**
	 * Map a capability discovery/preflight failure into the structured Automation
	 * Host error contract so profile, connection, authorization and binding
	 * problems are never degraded into generic model failures.
	 */
	const capabilityError = (err: unknown): AutomationError => {
		if (typeof err === "object" && err !== null && "code" in err) {
			const code = (err as { code?: unknown }).code;
			if (isAutomationErrorCode(code)) {
				return createAutomationError(code, errorMessage(err), false);
			}
		}
		return createAutomationError("start_rejected", errorMessage(err), false);
	};

	const currentRunModel = (): RunModelReference => {
		const model = session.model;
		return {
			provider: model?.provider ?? "unknown",
			id: model?.id ?? "unknown",
			thinkingLevel: session.thinkingLevel,
		};
	};

	const isThinkingLevel = (value: string): value is ThinkingLevel =>
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max";

	const finalModelForResolution = (resolution: BrokerModelResolution): RunFinalModelReference => ({
		provider: resolution.reference.provider,
		modelId: resolution.reference.id,
		...(resolution.reference.thinkingLevel !== undefined && isThinkingLevel(resolution.reference.thinkingLevel)
			? { thinkingLevel: resolution.reference.thinkingLevel }
			: {}),
	});

	const modelSelectionError = (err: unknown, fallback: "route" | "role" = "route"): AutomationError => {
		const candidate =
			typeof err === "object" && err !== null
				? (err as { code?: unknown; message?: unknown; retryable?: unknown })
				: undefined;
		const code = candidate?.code;
		if (code === "model_route_not_found") {
			return createAutomationError("model_route_not_found", "Model route was not found.", false);
		}
		if (code === "model_role_not_found") {
			return createAutomationError("model_role_not_found", "Model role was not found.", false);
		}
		if (code === "model_route_unavailable" || code === "model_no_candidate" || code === "model_provider_failure") {
			return createAutomationError("model_route_unavailable", "The selected model route is unavailable.", true);
		}
		if (code === "model_budget_exceeded") {
			return createAutomationError("model_budget_exceeded", "The model budget is exceeded.", false);
		}
		if (code === "model_binding_unavailable") {
			return createAutomationError("model_binding_unavailable", "The previous model binding is unavailable.", false);
		}
		if (code === "model_binding_invalid" || code === "model_binding_conflict" || code === "model_invalid_reference") {
			return createAutomationError("model_route_invalid", "The model route selection is invalid.", false);
		}
		if (candidate?.message !== undefined && typeof candidate.message === "string") {
			return createAutomationError(
				fallback === "role" ? "model_role_not_found" : "model_route_invalid",
				redactErrorText(candidate.message),
				candidate.retryable === true,
			);
		}
		return createAutomationError(
			fallback === "role" ? "model_role_not_found" : "model_route_invalid",
			fallback === "role" ? "Model role selection failed." : "Model route selection failed.",
			false,
		);
	};

	const unavailableModelError = (): AutomationError =>
		createAutomationError("model_route_unavailable", "The selected model route is unavailable.", true);

	const resolveRequestedModel = async (
		modelRoute: ModelRouteSelection | undefined,
		modelRole: ModelRoleSelection | undefined,
		inheritedBinding?: ModelBindingLedgerRecord,
	): Promise<{ resolution?: BrokerModelResolution; error?: AutomationError }> => {
		if (modelRoute !== undefined && modelRole !== undefined) {
			return {
				error: createAutomationError(
					"model_route_invalid",
					"modelRoute and modelRole are mutually exclusive.",
					false,
				),
			};
		}
		let requestedRoute = modelRoute;
		let requestedRole = modelRole;
		let inheritedDirect: { provider: string; id: string; thinkingLevel?: ThinkingLevel } | undefined;
		if (requestedRoute === undefined && requestedRole === undefined && inheritedBinding !== undefined) {
			if (inheritedBinding.role !== undefined) {
				requestedRole = inheritedBinding.role;
			} else if (inheritedBinding.mode === "route" && inheritedBinding.routeId !== undefined) {
				requestedRoute = inheritedBinding.routeId;
			} else if (inheritedBinding.mode === "route") {
				return { error: modelSelectionError({ code: "model_binding_unavailable" }) };
			} else {
				const inheritedModel = inheritedBinding.candidates[0]?.model;
				if (inheritedModel === undefined) {
					return { error: modelSelectionError({ code: "model_binding_unavailable" }) };
				}
				inheritedDirect = {
					provider: inheritedModel.provider,
					id: inheritedModel.modelId,
					...(inheritedModel.thinkingLevel === undefined ? {} : { thinkingLevel: inheritedModel.thinkingLevel }),
				};
			}
		}
		if (requestedRoute === undefined && requestedRole === undefined) {
			const currentModel = session.model;
			if (currentModel === undefined) return { error: unavailableModelError() };
			const result =
				inheritedDirect !== undefined
					? session.modelBroker.resolveResult({ direct: inheritedDirect })
					: session.modelBroker.hasDefaultSelection()
						? session.modelBroker.resolveResult({})
						: session.modelBroker.resolveResult({
								direct: {
									provider: currentModel.provider,
									id: currentModel.id,
									thinkingLevel: session.thinkingLevel,
								},
							});
			if (!result.ok) return { error: modelSelectionError(result.error) };
			let model = currentModel;
			if (
				result.resolution.reference.provider !== currentModel.provider ||
				result.resolution.reference.id !== currentModel.id
			) {
				try {
					model =
						session.modelRuntime.getModel(result.resolution.reference.provider, result.resolution.reference.id) ??
						model;
				} catch {
					return { error: unavailableModelError() };
				}
				if (
					model.provider !== result.resolution.reference.provider ||
					model.id !== result.resolution.reference.id
				) {
					return { error: unavailableModelError() };
				}
				try {
					await session.setModel(model);
				} catch {
					return { error: unavailableModelError() };
				}
			}
			try {
				session.setModelBrokerResolution(result.resolution, inheritedBinding?.bindingId);
			} catch {
				return { error: unavailableModelError() };
			}
			return { resolution: result.resolution };
		}

		const result = session.modelBroker.resolveResult({
			...(requestedRoute === undefined ? {} : { modelRoute: requestedRoute }),
			...(requestedRole === undefined ? {} : { modelRole: requestedRole }),
		});
		if (!result.ok) {
			return { error: modelSelectionError(result.error, requestedRole === undefined ? "route" : "role") };
		}

		let model: ReturnType<typeof session.modelRuntime.getModel>;
		try {
			model = session.modelRuntime.getModel(result.resolution.reference.provider, result.resolution.reference.id);
		} catch {
			return { error: unavailableModelError() };
		}
		if (model === undefined) return { error: unavailableModelError() };
		try {
			await session.setModel(model);
			session.setModelBrokerResolution(result.resolution, inheritedBinding?.bindingId);
			if (
				result.resolution.reference.thinkingLevel !== undefined &&
				isThinkingLevel(result.resolution.reference.thinkingLevel)
			) {
				session.setThinkingLevel(result.resolution.reference.thinkingLevel);
			}
		} catch {
			return { error: unavailableModelError() };
		}
		return { resolution: result.resolution };
	};

	const usageSnapshot = (): RunUsageSnapshot => {
		const stats = session.getSessionStats();
		return {
			input: stats.tokens.input,
			output: stats.tokens.output,
			total: stats.tokens.total,
		};
	};

	const serializeRunModelAttempt = (value: unknown): RunModelAttemptSummary | undefined => {
		const attempt = serializePublicModelAttempt(value);
		if (attempt === undefined) return undefined;
		return {
			attemptId: attempt.attemptId,
			bindingId: attempt.bindingId,
			candidate: {
				provider: attempt.candidate.provider,
				modelId: attempt.candidate.modelId,
				...(attempt.candidate.thinkingLevel === undefined
					? {}
					: { thinkingLevel: attempt.candidate.thinkingLevel }),
			},
			order: attempt.order,
			status: attempt.status,
			startedAt: attempt.startedAt,
			...(attempt.endedAt === undefined ? {} : { endedAt: attempt.endedAt }),
			...(attempt.failureCategory === undefined ? {} : { failureCategory: attempt.failureCategory }),
			...(attempt.usage === undefined ? {} : { usage: { ...attempt.usage } }),
			...(attempt.visibleOutput === undefined ? {} : { visibleOutput: attempt.visibleOutput }),
			...(attempt.contextSnapshotId === undefined ? {} : { contextSnapshotId: attempt.contextSnapshotId }),
			...(attempt.summary === undefined ? {} : { summary: attempt.summary }),
		};
	};

	const modelAttemptsForBinding = (
		bindingId: string | undefined,
	): ReadonlyArray<RunModelAttemptSummary> | undefined => {
		if (bindingId === undefined) return undefined;
		const replay = foldModelBrokerLedger(session.sessionManager.getEntries());
		const attempts = [...replay.attempts.values()]
			.filter((attempt) => attempt.bindingId === bindingId)
			.map((attempt) => serializeRunModelAttempt(attempt))
			.filter((attempt): attempt is RunModelAttemptSummary => attempt !== undefined)
			.sort((a, b) => a.order - b.order || a.startedAt.localeCompare(b.startedAt));
		return attempts.length === 0 ? undefined : attempts;
	};

	const runModelMetadata = (
		handle: RunHandle,
	): {
		modelBindingId?: string;
		previousModelBindingId?: string;
		finalModel?: RunFinalModelReference;
		modelAttempts?: ReadonlyArray<RunModelAttemptSummary>;
		modelBudget?: RunModelBudgetSummary;
	} => {
		const record = handle.record;
		const modelAttempts = modelAttemptsForBinding(record.modelBindingId);
		const bindingBudget =
			record.modelBindingId === undefined
				? undefined
				: session.modelBroker.getBindingBudgetSummary(record.modelBindingId);
		const finalModel =
			modelAttempts === undefined
				? record.finalModel
				: (modelAttempts[modelAttempts.length - 1]?.candidate ?? record.finalModel);
		return {
			...(record.modelBindingId === undefined ? {} : { modelBindingId: record.modelBindingId }),
			...(record.previousModelBindingId === undefined
				? {}
				: { previousModelBindingId: record.previousModelBindingId }),
			...(finalModel === undefined ? {} : { finalModel }),
			...(modelAttempts === undefined ? {} : { modelAttempts }),
			...(bindingBudget === undefined
				? {}
				: {
						modelBudget: {
							...(bindingBudget.committed.modelCalls === undefined
								? {}
								: { modelCalls: bindingBudget.committed.modelCalls }),
							inputTokens: bindingBudget.committed.inputTokens,
							outputTokens: bindingBudget.committed.outputTokens,
							totalTokens: bindingBudget.committed.totalTokens,
							costUsd: bindingBudget.committed.cost,
							...(bindingBudget.budget.maxModelCalls === undefined
								? {}
								: { maxModelCalls: bindingBudget.budget.maxModelCalls }),
							...(bindingBudget.budget.maxInputTokens === undefined
								? {}
								: { maxInputTokens: bindingBudget.budget.maxInputTokens }),
							...(bindingBudget.budget.maxOutputTokens === undefined
								? {}
								: { maxOutputTokens: bindingBudget.budget.maxOutputTokens }),
							...(bindingBudget.budget.maxTotalTokens === undefined
								? {}
								: { maxTotalTokens: bindingBudget.budget.maxTotalTokens }),
							...(bindingBudget.budget.maxCostUsd === undefined
								? {}
								: { maxCostUsd: bindingBudget.budget.maxCostUsd }),
							exceeded: bindingBudget.exceeded,
						},
					}),
		};
	};

	/** Serialize a run stream event, applying JSON-safe event conversion to wrapped session events. */
	const outputRunEvent = (event: RunStreamEvent): void => {
		const publicEvent = serializePublicRunStreamEvent(event);
		if (publicEvent.type === "run.event") {
			output({ ...publicEvent, event: toJsonEvent(publicEvent.event) });
		} else {
			output(publicEvent);
		}
	};

	const finalizeRun = async (
		handle: RunHandle,
		outcome: "completed" | "failed",
		terminalError?: AutomationError,
	): Promise<void> => {
		if (activeHandle !== handle || settledRunIds.has(handle.runId)) return;
		settledRunIds.add(handle.runId);
		const terminal = handle.settle({
			outcome,
			terminalError,
			currentUsage: usageSnapshot(),
			contextSnapshotId: session.getContextSnapshotIdForRun(handle.runId),
			...runModelMetadata(handle),
		});
		if (terminal !== undefined) outputRunEvent(terminal);
		activeHandle = undefined;
		runPromptPromises.delete(handle.runId);
		terminalErrorByRun.delete(handle.runId);
		await waitForRawStdoutBackpressure();
	};

	const settleActiveRun = async (handle: RunHandle): Promise<void> => {
		if (activeHandle !== handle || settledRunIds.has(handle.runId)) return;
		// Await the tracked prompt so a post-preflight failure settles the run as
		// failed first; the settledRunIds guard makes this later settle a no-op.
		await runPromptPromises.get(handle.runId);
		await finalizeRun(handle, "completed");
	};

	/**
	 * Track a started prompt so settleActiveRun can await it and post-preflight
	 * failures surface as a run.failed terminal carrying a model_error.
	 */
	const trackRunPrompt = (handle: RunHandle, prompt: Promise<unknown>): void => {
		const tracked = (async () => {
			try {
				await prompt;
				// Settle directly on completion so a run started by a preflight that
				// never emits agent_settled (e.g. an extension-handled prompt) cannot
				// leak an active run. A terminal error detected from agent_end marks
				// the run failed/model_error; otherwise it completed.
				const terminalError = terminalErrorByRun.get(handle.runId);
				await finalizeRun(handle, terminalError !== undefined ? "failed" : "completed", terminalError);
			} catch {
				await finalizeRun(handle, "failed", createAutomationError("model_error", "Run failed.", false));
			}
		})();
		runPromptPromises.set(handle.runId, tracked);
	};

	const startRun = async (
		id: string | undefined,
		commandType: "run.start" | "run.resume",
		message: string,
		images: ImageContent[] | undefined,
		attempt: number,
		sourceRunId: string | undefined,
		capabilityProfile: string | undefined,
		policyProfile: string | undefined,
		previousBindingId: string | undefined,
		previousPolicyBindingId: string | undefined,
		previousModelBindingId: string | undefined,
		inheritedModelBinding: ModelBindingLedgerRecord | undefined,
		modelRoute: ModelRouteSelection | undefined,
		modelRole: ModelRoleSelection | undefined,
		external: ExternalExecutionRef | undefined,
	): Promise<RpcAutomationResponse | undefined> => {
		const inputError = slashRunInputError(id, commandType, message);
		if (inputError !== undefined) return inputError;
		if (external !== undefined && !isExternalExecutionRef(external)) {
			return automationError(id, commandType, auditCommandError(undefined, "external_mapping_invalid"));
		}
		if (shuttingDown) {
			return automationError(
				id,
				commandType,
				createAutomationError(
					"start_rejected",
					"Automation Host is shutting down; no new runs are accepted.",
					false,
				),
			);
		}
		if (!hostInitialized || coordinator === undefined) {
			return automationError(id, commandType, hostNotInitializedError());
		}
		if (coordinator.activeRun !== undefined || activeReservation !== undefined) {
			return automationError(
				id,
				commandType,
				createAutomationError(
					"session_busy",
					"A run is already active in this session. Wait for its terminal event before starting another.",
					true,
				),
			);
		}
		const proposedRunId = crypto.randomUUID();
		// Capability profile preflight: materialize the requested capability profile
		// into the frozen binding before any reservation or prompt. The public API
		// owns the undefined => configured default semantics and waits for capability
		// discovery to settle. Any profile or discovery failure is converted into a
		// structured capability error before any ledger write; an unapprovable ask
		// still fails the run below.
		try {
			// Policy selection and the Run ID must be established before capability
			// discovery. MCP startup is a policy operation and its binding must be
			// the same binding that reservation.accept validates below.
			await session.setExecutionPolicyProfile(policyProfile);
			session.setPreviousExecutionPolicyBindingIdForNextRun(previousPolicyBindingId);
			await session.setCapabilityProfile(capabilityProfile, { runId: proposedRunId });
		} catch (err) {
			return automationError(id, commandType, capabilityError(err));
		}
		// The materialized profile (requested, or the configured default when omitted)
		// names the effective profile for the approval-required message below.
		const effectiveProfile = session.getActiveCapabilityProfile();
		let reservation: RunReservation;
		try {
			reservation = coordinator.reserve();
		} catch (err) {
			return automationError(id, commandType, asAutomationError(err));
		}
		activeReservation = reservation;
		try {
			await session.whenCapabilitiesReady(proposedRunId);
		} catch (err) {
			activeReservation = undefined;
			try {
				reservation.release();
			} catch {
				// reservation may already be consumed
			}
			return automationError(id, commandType, capabilityError(err));
		}
		const preflightBinding = session.getActiveCapabilityBinding();
		if (previousBindingId !== undefined) {
			// Resume binding-drift guard. This runs only after capability discovery has
			// settled (whenCapabilitiesReady above) so a restored MCP binding that
			// initially differs until discovery completes cannot false-fail. The binding
			// id is derived from descriptor id + revision + profile, so id equality is
			// the drift check. Rejection happens before session.prompt/accept, so no
			// accepted/terminal ledger write occurs.
			const knownBindings = foldCapabilityBindingEntries(session.sessionManager.getEntries());
			if (knownBindings.get(previousBindingId) === undefined) {
				activeReservation = undefined;
				try {
					reservation.release();
				} catch {
					// reservation may already be consumed
				}
				return automationError(
					id,
					commandType,
					createAutomationError(
						"capability_binding_unavailable",
						`Source run ${sourceRunId} requires capability binding ${previousBindingId} which is not recorded in this session`,
						false,
					),
				);
			}
			if (preflightBinding === undefined || preflightBinding.id !== previousBindingId) {
				activeReservation = undefined;
				try {
					reservation.release();
				} catch {
					// reservation may already be consumed
				}
				return automationError(
					id,
					commandType,
					createAutomationError(
						"capability_binding_unavailable",
						`Source run ${sourceRunId} used capability binding ${previousBindingId} but the settled binding for this session no longer matches it; the original capability set cannot be safely restored`,
						false,
					),
				);
			}
		}
		// The requested profile is already materialized into the frozen binding by
		// setCapabilityProfile above, so no profile-mismatch rejection applies.
		if (preflightBinding !== undefined && preflightBinding.decisionSummary.awaitingApproval > 0) {
			activeReservation = undefined;
			try {
				reservation.release();
			} catch {
				// reservation may already be consumed
			}
			return automationError(
				id,
				commandType,
				createAutomationError(
					"capability_approval_required",
					`Capability profile "${effectiveProfile}" has ${preflightBinding.decisionSummary.awaitingApproval} capability(-ies) awaiting approval; the Automation Host cannot auto-approve ask.`,
					false,
				),
			);
		}
		const modelSelection = await resolveRequestedModel(modelRoute, modelRole, inheritedModelBinding);
		if (modelSelection.error !== undefined) {
			activeReservation = undefined;
			try {
				reservation.release();
			} catch {
				// reservation may already be consumed
			}
			return automationError(id, commandType, modelSelection.error);
		}
		// Reserve before the prompt's preflight so the session is busy while the run
		// is pending. Only a preflight that succeeds persists the accepted fact and
		// starts the run; otherwise the reservation is released and the caller gets
		// start_rejected with no run id and no ledger entry.
		let promptPromise: Promise<unknown>;
		const rejectStart = (err: unknown): void => {
			if (activeReservation !== reservation) return;
			activeReservation = undefined;
			try {
				reservation.release();
			} catch {
				// reservation may already be consumed
			}
			const startError =
				modelSelection.resolution === undefined || (modelRoute === undefined && modelRole === undefined)
					? createAutomationError("start_rejected", errorMessage(err), false)
					: unavailableModelError();
			output(automationError(id, commandType, startError));
		};
		promptPromise = session.prompt(message, {
			images,
			source: "rpc",
			runId: proposedRunId,
			preflightResult: (didSucceed) => {
				if (!didSucceed) {
					rejectStart(new Error("Preflight rejected the run input"));
					return;
				}
				if (activeReservation !== reservation) return;
				let handle: RunHandle | undefined;
				let startEvents: RunStreamEvent[];
				try {
					handle = reservation.accept({
						runId: proposedRunId,
						attempt,
						sourceRunId,
						external,
						previousBindingId,
						previousPolicyBindingId,
						previousModelBindingId,
						model: currentRunModel(),
						...(modelSelection.resolution === undefined
							? {}
							: {
									modelBindingId: modelSelection.resolution.bindingId,
									finalModel: finalModelForResolution(modelSelection.resolution),
								}),
						// Persist the frozen binding as the run's capability binding;
						// its id is recorded on the terminal receipt.
						capabilityBinding: session.getActiveCapabilityBinding(),
						policyBinding: session.getActiveExecutionPolicyBinding(),
						policySummary: session.getActiveExecutionPolicySummary(),
					});
					handle.setUsageBaseline(usageSnapshot());
					// Persist the started fact before publishing accepted. The returned events
					// remain buffered locally so the external contract is still accepted ->
					// run.started -> run.event* -> terminal.
					startEvents = handle.start();
				} catch (err) {
					activeReservation = undefined;
					if (handle === undefined) {
						try {
							reservation.release();
						} catch {
							// reservation may already be consumed
						}
					} else {
						// The accepted fact was durable but the started fact was not. Discard
						// the live coordinator so this failed start cannot retain Session
						// ownership; its ledger record is replayed as interrupted if recovered.
						coordinator = createRunLifecycleCoordinator(session.sessionManager);
					}
					output(automationError(id, commandType, asAutomationError(err)));
					// preflightResult has no rejection return value. Throwing prevents
					// AgentSession.prompt() from proceeding into the Agent loop after an
					// accepted/start ledger failure; promptPromise.catch() sees the same
					// failure but does not output a duplicate because the reservation cleared.
					throw err;
				}
				activeReservation = undefined;
				activeHandle = handle;
				// Emit the accepted response before run.started and the buffered events so
				// records appear in the contract order: response -> run.started -> run.event* -> terminal.
				const acceptedData: RunAcceptedData = {
					runId: handle.runId,
					sessionId: session.sessionId,
					attempt,
					status: "accepted",
				};
				const publicRecord = serializePublicRunRecord(handle.record);
				if (publicRecord.external !== undefined) acceptedData.external = publicRecord.external;
				if (publicRecord.modelBindingId !== undefined) acceptedData.modelBindingId = publicRecord.modelBindingId;
				if (publicRecord.previousModelBindingId !== undefined) {
					acceptedData.previousModelBindingId = publicRecord.previousModelBindingId;
				}
				if (publicRecord.finalModel !== undefined) acceptedData.finalModel = publicRecord.finalModel;
				if (publicRecord.modelAttempts !== undefined) acceptedData.modelAttempts = publicRecord.modelAttempts;
				if (publicRecord.modelBudget !== undefined) acceptedData.modelBudget = publicRecord.modelBudget;
				if (publicRecord.policyBindingId !== undefined) acceptedData.policyBindingId = publicRecord.policyBindingId;
				if (publicRecord.previousPolicyBindingId !== undefined) {
					acceptedData.previousPolicyBindingId = publicRecord.previousPolicyBindingId;
				}
				if (publicRecord.policySummary !== undefined) acceptedData.policySummary = publicRecord.policySummary;
				output({ id, type: "response", command: commandType, success: true, data: acceptedData });
				for (const event of startEvents) {
					outputRunEvent(event);
				}
				trackRunPrompt(handle, promptPromise);
			},
		});
		promptPromise.catch((err) => {
			// When preflight rejects the promise no run was started, so release and
			// report start_rejected. Otherwise the tracked prompt settled the run.
			rejectStart(err);
		});
		return undefined;
	};

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		// Rebuild the run coordinator for the current session's ledger. When the
		// host is initialized, a fresh coordinator folds the new session's
		// automation.run custom entries so run.get and run.resume work after a switch.
		if (hostInitialized) {
			coordinator = createRunLifecycleCoordinator(session.sessionManager);
			activeHandle = undefined;
			settledRunIds.clear();
			runPromptPromises.clear();
		}
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", event: err.event, error: "Extension failed." });
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (activeHandle !== undefined) {
				const emitted = activeHandle.captureSessionEvent(event);
				if (emitted !== undefined) outputRunEvent(emitted);
				// Provider errors surface as a final assistant message with stopReason
				// "error" on agent_end; record it so the run settles failed/model_error.
				if (event.type === "agent_end" && event.willRetry !== true) {
					let errorText: string | undefined;
					for (const message of event.messages) {
						if (message.role === "assistant" && message.stopReason === "error") {
							errorText = message.errorMessage ?? "Agent run failed";
						}
					}
					if (errorText !== undefined) {
						const terminalCode =
							errorText === "Model budget exceeded."
								? "model_budget_exceeded"
								: errorText === "Model fallback exhausted."
									? "model_fallback_exhausted"
									: "model_error";
						terminalErrorByRun.set(activeHandle.runId, createAutomationError(terminalCode, errorText, false));
					} else {
						terminalErrorByRun.delete(activeHandle.runId);
					}
				}
			} else if (activeReservation !== undefined) {
				// Buffer session events observed during preflight; start() flushes them.
				activeReservation.captureSessionEvent(event);
			} else {
				output(toJsonEvent(serializePublicSessionEvent(event)));
			}
			if (event.type === "agent_settled") {
				if (activeHandle !== undefined) {
					void settleActiveRun(activeHandle);
				}
				void checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | RpcAutomationResponse | undefined> => {
		const id = command.id;

		// Once the Automation Host is initialized, legacy commands that would mutate
		// session/model/run state are rejected so a run and a legacy command cannot
		// compete for session ownership. Read-only queries and run.cancel/run.resume
		// remain available.
		if (hostInitialized && HOST_MUTATING_COMMANDS.has(command.type)) {
			return error(
				id,
				command.type,
				`Command "${command.type}" is not available while the Automation Host is initialized. Only read-only commands and run.cancel/run.resume are allowed.`,
			);
		}

		switch (command.type) {
			// =================================================================
			// Automation Host (protocolVersion 1)
			// =================================================================

			case "initialize": {
				if (command.protocolVersion !== 1) {
					return automationError(
						id,
						"initialize",
						createAutomationError(
							"unsupported_protocol_version",
							`Unsupported protocol version: ${command.protocolVersion}. This host supports protocolVersion 1 only.`,
							false,
						),
					);
				}
				// Idempotent: a repeat initialize re-advertises the contract without
				// recreating the coordinator or resetting run state, so an in-flight
				// reservation/run is never lost.
				if (!hostInitialized) {
					hostInitialized = true;
					coordinator = createRunLifecycleCoordinator(session.sessionManager);
				}
				const initializeData: InitializeData = {
					host: "automation-host",
					protocolVersion: 1,
					sessionId: session.sessionId,
					runCommands: ["run.start", "run.get", "run.cancel", "run.resume"],
					auditCommands: ["audit.query", "audit.replay", "external.map"],
				};
				const initializeResponse: RpcAutomationResponse = {
					id,
					type: "response",
					command: "initialize",
					success: true,
					data: initializeData,
				};
				return initializeResponse;
			}

			case "audit.query": {
				if (!hostInitialized || coordinator === undefined) {
					return automationError(id, "audit.query", hostNotInitializedError());
				}
				const query: AuditQuery = {
					scope: command.scope,
					...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
					...(command.runId === undefined ? {} : { runId: command.runId }),
					...(command.external === undefined ? {} : { external: command.external }),
					...(command.types === undefined ? {} : { types: command.types }),
					...(command.from === undefined ? {} : { from: command.from }),
					...(command.to === undefined ? {} : { to: command.to }),
					...(command.cursor === undefined ? {} : { cursor: command.cursor }),
					...(command.limit === undefined ? {} : { limit: command.limit }),
				};
				try {
					const data = new ExecutionAuditQuery(session.sessionManager).query(query) satisfies AuditQueryData;
					return { id, type: "response", command: "audit.query", success: true, data };
				} catch (err) {
					return automationError(id, "audit.query", auditCommandError(err, "audit_query_invalid"));
				}
			}

			case "audit.replay": {
				if (!hostInitialized || coordinator === undefined) {
					return automationError(id, "audit.replay", hostNotInitializedError());
				}
				const query: AuditReplayQuery = {
					runId: command.runId,
					...(command.scope === undefined ? {} : { scope: command.scope }),
					...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
					...(command.external === undefined ? {} : { external: command.external }),
					...(command.types === undefined ? {} : { types: command.types }),
					...(command.from === undefined ? {} : { from: command.from }),
					...(command.to === undefined ? {} : { to: command.to }),
					...(command.cursor === undefined ? {} : { cursor: command.cursor }),
					...(command.limit === undefined ? {} : { limit: command.limit }),
				};
				try {
					const data = new ExecutionAuditQuery(session.sessionManager).replay(query) satisfies AuditReplayData;
					return { id, type: "response", command: "audit.replay", success: true, data };
				} catch (err) {
					return automationError(id, "audit.replay", auditCommandError(err, "audit_replay_incomplete"));
				}
			}

			case "external.map": {
				if (!hostInitialized || coordinator === undefined) {
					return automationError(id, "external.map", hostNotInitializedError());
				}
				if (command.aosSessionId !== session.sessionId || !isExternalExecutionRef(command.external)) {
					return automationError(id, "external.map", auditCommandError(undefined, "external_mapping_invalid"));
				}
				const request: ExternalMappingRequest = {
					external: command.external,
					aosSessionId: command.aosSessionId,
					...(command.aosRunId === undefined ? {} : { aosRunId: command.aosRunId }),
					...(command.source === undefined ? {} : { source: command.source }),
					...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
				};
				try {
					const data = coordinator.persistExternalMapping(request) satisfies ExternalMapData;
					return { id, type: "response", command: "external.map", success: true, data };
				} catch (err) {
					return automationError(id, "external.map", auditCommandError(err, "audit_persistence_failed"));
				}
			}

			case "run.start": {
				return startRun(
					id,
					"run.start",
					command.message,
					command.images,
					1,
					undefined,
					command.capabilityProfile,
					command.policyProfile,
					undefined,
					undefined,
					undefined,
					undefined,
					command.modelRoute,
					command.modelRole,
					command.external,
				);
			}

			case "run.get": {
				if (!hostInitialized || coordinator === undefined) {
					return automationError(id, "run.get", hostNotInitializedError());
				}
				const result = coordinator.getRun(command.runId);
				if (result === undefined) {
					return automationError(
						id,
						"run.get",
						createAutomationError("run_not_found", `Run not found: ${command.runId}`, false),
					);
				}
				const getData: RunGetData = { run: serializePublicRunRecord(result.record) };
				if (result.receipt !== undefined) getData.receipt = serializePublicRunReceipt(result.receipt);
				if (result.recovery !== undefined) getData.recovery = result.recovery;
				const getResponse: RpcAutomationResponse = {
					id,
					type: "response",
					command: "run.get",
					success: true,
					data: getData,
				};
				return getResponse;
			}

			case "run.cancel": {
				if (!hostInitialized || coordinator === undefined) {
					return automationError(id, "run.cancel", hostNotInitializedError());
				}
				const result = coordinator.getRun(command.runId);
				if (result === undefined) {
					return automationError(
						id,
						"run.cancel",
						createAutomationError("run_not_found", `Run not found: ${command.runId}`, false),
					);
				}
				if (isTerminalStatus(result.record.status)) {
					const cancelResponse: RpcAutomationResponse = {
						id,
						type: "response",
						command: "run.cancel",
						success: true,
						data: { runId: command.runId, status: result.record.status },
					};
					return cancelResponse;
				}
				if (activeHandle === undefined || activeHandle.runId !== command.runId) {
					return automationError(
						id,
						"run.cancel",
						createAutomationError(
							"run_not_cancellable",
							`Run ${command.runId} is not in a cancellable state`,
							false,
						),
					);
				}
				activeHandle.requestCancel();
				// Cancellation is a request, not the terminal transition. Trigger the
				// existing abort path without waiting for its idle promise so the command
				// response describes the current running state; the subscriber emits the
				// unique run.cancelled event only after Session settlement.
				void session.abort().catch(() => {
					// The run remains governed by its normal settle/recovery path.
				});
				const cancelResponse: RpcAutomationResponse = {
					id,
					type: "response",
					command: "run.cancel",
					success: true,
					data: { runId: command.runId, status: result.record.status },
				};
				return cancelResponse;
			}

			case "run.resume": {
				const inputError = slashRunInputError(id, "run.resume", command.message);
				if (inputError !== undefined) return inputError;
				if (command.external !== undefined && !isExternalExecutionRef(command.external)) {
					return automationError(id, "run.resume", auditCommandError(undefined, "external_mapping_invalid"));
				}
				if (shuttingDown) {
					return automationError(
						id,
						"run.resume",
						createAutomationError(
							"start_rejected",
							"Automation Host is shutting down; no new runs are accepted.",
							false,
						),
					);
				}
				if (!hostInitialized || coordinator === undefined) {
					return automationError(id, "run.resume", hostNotInitializedError());
				}
				if (coordinator.activeRun !== undefined || activeReservation !== undefined) {
					return automationError(
						id,
						"run.resume",
						createAutomationError(
							"session_busy",
							"A run is already active in this session. Wait for its terminal event before starting another.",
							true,
						),
					);
				}
				if (session.sessionFile === undefined) {
					return automationError(
						id,
						"run.resume",
						createAutomationError(
							"session_not_persistent",
							"The current session has no sessionFile and cannot be resumed.",
							false,
						),
					);
				}
				const switchResult = await runtimeHost.switchSession(command.sessionPath);
				if (switchResult.cancelled) {
					return automationError(
						id,
						"run.resume",
						createAutomationError(
							"session_switch_cancelled",
							"A session-switch extension cancelled the switch.",
							false,
						),
					);
				}
				// switchSession() re-runs rebindSession(), which rebuilt `coordinator`
				// for the restored session's ledger.
				const sourceRun = coordinator!.getRun(command.sourceRunId);
				if (sourceRun === undefined) {
					return automationError(
						id,
						"run.resume",
						createAutomationError(
							"source_run_not_found",
							`Source run not found in restored session: ${command.sourceRunId}`,
							false,
						),
					);
				}
				if (!isTerminalStatus(sourceRun.record.status) && sourceRun.recovery !== "interrupted") {
					return automationError(
						id,
						"run.resume",
						createAutomationError(
							"source_run_not_resumable",
							`Source run ${command.sourceRunId} cannot be the basis for a new attempt`,
							false,
						),
					);
				}
				// An interrupted run may have an accepted record but no terminal
				// receipt. Preserve #6's binding-drift guard for that recovery path.
				const previousBindingId = sourceRun.receipt?.capabilityBindingId ?? sourceRun.record.capabilityBindingId;
				const previousPolicyBindingId = sourceRun.receipt?.policyBindingId ?? sourceRun.record.policyBindingId;
				const previousModelBindingId = sourceRun.receipt?.modelBindingId ?? sourceRun.record.modelBindingId;
				const inheritedModelBinding =
					previousModelBindingId === undefined
						? undefined
						: foldModelBrokerLedger(session.sessionManager.getEntries()).bindings.get(previousModelBindingId);
				return startRun(
					id,
					"run.resume",
					command.message,
					command.images,
					sourceRun.record.attempt + 1,
					command.sourceRunId,
					command.capabilityProfile,
					command.policyProfile,
					previousBindingId,
					previousPolicyBindingId,
					previousModelBindingId,
					inheritedModelBinding,
					command.modelRoute,
					command.modelRole,
					command.external,
				);
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = session.modelRuntime.getAvailableSnapshot();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.modelRuntime.getAvailableSnapshot();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const allowExtensionBash = await session.authorizeUserBashExtension(command.command, { id });
				const eventResult = allowExtensionBash
					? await session.extensionRunner.emitUserBash({
						type: "user_bash",
						command: command.command,
						excludeFromContext: command.excludeFromContext ?? false,
						cwd: session.sessionManager.getCwd(),
					})
					: undefined;

				if (eventResult?.result) {
					session.recordBashResult(command.command, eventResult.result, {
						excludeFromContext: command.excludeFromContext,
					});
					return success(id, "bash", eventResult.result);
				}

				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
					operations: eventResult?.operations,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", serializePublicSessionStats(stats));
			}

			case "get_context": {
				const inspection = await session.inspectContext({
					snapshotId: command.snapshotId,
				});
				return success(id, "get_context", {
					snapshot: serializePublicContextSnapshot(inspection.snapshot),
					drift: inspection.drift.map((item) => serializePublicContextDrift(item)),
					preview: inspection.preview,
				});
			}

			case "get_capabilities": {
				// Ordinary read-only inspection: no Automation Host initialize is
				// required, and only public-safe metadata is ever returned.
				const history = foldCapabilityBindingEntries(session.sessionManager.getEntries());
				const current = session.getActiveCapabilityBinding();
				if (command.bindingId !== undefined) {
					const found = history.get(command.bindingId);
					if (found === undefined) {
						return error(id, "get_capabilities", "Capability binding not found.");
					}
					const binding = serializePublicCapabilityBinding(found);
					return success(id, "get_capabilities", {
						catalog: session.inspectCapabilityCatalog(),
						binding: binding ?? null,
						bindings: [],
					} satisfies GetCapabilitiesData);
				}
				return success(id, "get_capabilities", {
					catalog: session.inspectCapabilityCatalog(),
					binding: current === undefined ? null : (serializePublicCapabilityBinding(current) ?? null),
					bindings: [...history.values()]
						.map((binding) => serializePublicCapabilityBinding(binding))
						.filter((binding): binding is NonNullable<typeof binding> => binding !== undefined),
				} satisfies GetCapabilitiesData);
			}

			case "get_execution_policy": {
				return success(id, "get_execution_policy", {
					summary: session.getActiveExecutionPolicySummary(),
					pendingApprovals: session.getPendingExecutionPolicyApprovals(),
				} satisfies GetExecutionPolicyData);
			}

			case "policy.approve": {
				session.approveExecutionPolicyRequest(command.requestId, "rpc");
				return success(id, "policy.approve");
			}

			case "policy.reject": {
				session.rejectExecutionPolicyRequest(command.requestId, "rpc");
				return success(id, "policy.reject");
			}

			case "get_model_routes": {
				// Route and role catalogs contain only declared model identities and
				// availability metadata. ModelRuntime credentials are intentionally not
				// part of the Broker summary.
				return success(
					id,
					"get_model_routes",
					session.modelBroker.publicSummary(session.modelBrokerBindingId) satisfies GetModelRoutesData,
				);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", {
					entries: entries.map((entry) => serializePublicSessionEntry(entry)),
					leafId: sessionManager.getLeafId(),
				});
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", {
					tree: sessionManager.getTree().map((node) => serializePublicSessionTreeNode(node)),
					leafId: sessionManager.getLeafId(),
				});
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: serializePublicSourceInfo(command.sourceInfo),
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: serializePublicSourceInfo(template.sourceInfo),
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: serializePublicSourceInfo(skill.sourceInfo),
					});
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		// Stop accepting new runs and abort the active run. session.abort() waits for
		// the session to settle, letting the subscriber emit the run's terminal event
		// before we tear down. If the process is force-killed or exceeds the graceful
		// window, the last persisted ledger state is authoritative.
		if (activeReservation !== undefined) {
			try {
				activeReservation.release();
			} catch {
				// reservation may already be consumed
			}
			activeReservation = undefined;
		}
		if (activeHandle !== undefined) {
			activeHandle.requestCancel();
			try {
				await session.abort();
			} catch {
				// settle proceeds regardless of abort errors
			}
		}
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
