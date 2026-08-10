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
import type { ImageContent } from "@aos-agent/ai";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import type {
	AutomationError,
	RunHandle,
	RunId,
	RunLifecycleCoordinator,
	RunModelReference,
	RunReservation,
	RunStreamEvent,
	RunUsageSnapshot,
} from "../../core/run-lifecycle.ts";
import { createAutomationError, createRunLifecycleCoordinator, isTerminalStatus } from "../../core/run-lifecycle.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	InitializeData,
	RpcAutomationCommandType,
	RpcAutomationResponse,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	RunAcceptedData,
	RunGetData,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	AutomationError,
	AutomationErrorCode,
	InitializeData,
	RpcAutomationCommandType,
	RpcAutomationResponse,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
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
		return { id, type: "response", command, success: false, error: message };
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
	): RpcAutomationResponse => ({ id, type: "response", command, success: false, error: err });

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
			return createAutomationError(candidate.code, candidate.message, candidate.retryable);
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

	const usageSnapshot = (): RunUsageSnapshot => {
		const stats = session.getSessionStats();
		return {
			input: stats.tokens.input,
			output: stats.tokens.output,
			total: stats.tokens.total,
		};
	};

	/** Serialize a run stream event, applying JSON-safe event conversion to wrapped session events. */
	const outputRunEvent = (event: RunStreamEvent): void => {
		if (event.type === "run.event") {
			output({ ...event, event: toJsonEvent(event.event) });
		} else {
			output(event);
		}
	};

	const finalizeRun = async (
		handle: RunHandle,
		outcome: "completed" | "failed",
		terminalError?: AutomationError,
	): Promise<void> => {
		if (activeHandle !== handle || settledRunIds.has(handle.runId)) return;
		settledRunIds.add(handle.runId);
		const terminal = handle.settle({ outcome, terminalError, currentUsage: usageSnapshot() });
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
			} catch (err) {
				await finalizeRun(handle, "failed", createAutomationError("model_error", errorMessage(err), false));
			}
		})();
		runPromptPromises.set(handle.runId, tracked);
	};

	const startRun = (
		id: string | undefined,
		commandType: "run.start" | "run.resume",
		message: string,
		images: ImageContent[] | undefined,
		attempt: number,
		sourceRunId: string | undefined,
	): RpcAutomationResponse | undefined => {
		const inputError = slashRunInputError(id, commandType, message);
		if (inputError !== undefined) return inputError;
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
		let reservation: RunReservation;
		try {
			reservation = coordinator.reserve();
		} catch (err) {
			return automationError(id, commandType, asAutomationError(err));
		}
		activeReservation = reservation;
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
			output(automationError(id, commandType, createAutomationError("start_rejected", errorMessage(err), false)));
		};
		promptPromise = session.prompt(message, {
			images,
			source: "rpc",
			preflightResult: (didSucceed) => {
				if (!didSucceed) {
					rejectStart(new Error("Preflight rejected the run input"));
					return;
				}
				if (activeReservation !== reservation) return;
				let handle: RunHandle | undefined;
				let startEvents: RunStreamEvent[];
				try {
					handle = reservation.accept({ attempt, sourceRunId, model: currentRunModel() });
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
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
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
						terminalErrorByRun.set(activeHandle.runId, createAutomationError("model_error", errorText, false));
					} else {
						terminalErrorByRun.delete(activeHandle.runId);
					}
				}
			} else if (activeReservation !== undefined) {
				// Buffer session events observed during preflight; start() flushes them.
				activeReservation.captureSessionEvent(event);
			} else {
				output(toJsonEvent(event));
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
				};
				const sessionFile = session.sessionFile;
				if (sessionFile !== undefined) initializeData.sessionFile = sessionFile;
				const initializeResponse: RpcAutomationResponse = {
					id,
					type: "response",
					command: "initialize",
					success: true,
					data: initializeData,
				};
				return initializeResponse;
			}

			case "run.start": {
				return startRun(id, "run.start", command.message, command.images, 1, undefined);
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
				const getData: RunGetData = { run: result.record };
				if (result.receipt !== undefined) getData.receipt = result.receipt;
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
				return startRun(
					id,
					"run.resume",
					command.message,
					command.images,
					sourceRun.record.attempt + 1,
					command.sourceRunId,
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
					sessionFile: session.sessionFile,
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
				const eventResult = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: session.sessionManager.getCwd(),
				});

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
				return success(id, "get_session_stats", stats);
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
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
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
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
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
