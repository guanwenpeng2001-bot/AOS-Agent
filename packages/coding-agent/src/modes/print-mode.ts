/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `aos -p "prompt"` - text output
 * - `aos --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@aos-agent/ai";
import type { AgentSession, ExtensionBindings } from "../core/session/agent-session.ts";
import type { AgentSessionRuntime } from "../core/session/runtime.ts";
import type { PreparedSessionScopeRebind } from "../core/session/current-scope.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/runtime/output-guard.ts";
import { ShutdownCoordinator } from "../core/runtime/shutdown-coordinator.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	interface PrintSessionBinding {
		unsubscribe?: () => void;
		unsubscribeBackpressure?: () => void;
	}
	const sessionBindings = new Map<AgentSession, PrintSessionBinding>();
	let disposePromise: Promise<void> | undefined;

	const disposeRuntime = async (): Promise<void> => {
		if (disposePromise === undefined) {
			for (const binding of sessionBindings.values()) {
				binding.unsubscribe?.();
				binding.unsubscribeBackpressure?.();
			}
			sessionBindings.clear();
			disposePromise = runtimeHost.dispose();
		}
		await disposePromise;
	};

	const shutdownCoordinator = new ShutdownCoordinator({
		closeAdmission: (request) => {
			runtimeHost.closeAdmissionForShutdown();
			if (request.signal !== undefined) {
				killTrackedDetachedChildren();
			}
		},
		handoffRecovery: () => runtimeHost.handoffShutdownRecovery(),
		resourceGroups: [[{ name: "runtime", cleanup: disposeRuntime }]],
		finalize: () => flushRawStdout(),
		onFailure: (failure) => {
			console.error(`[shutdown] ${failure.resource} ${failure.reason.replaceAll("_", " ")}`);
		},
	});
	shutdownCoordinator.installSignalHandlers();

	const extensionBindings = (session: AgentSession): ExtensionBindings => ({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await runtimeHost.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
	});

	const subscribeSession = (session: AgentSession): PrintSessionBinding => {
		const binding: PrintSessionBinding = {};
		binding.unsubscribe = session.subscribe((event) => {
			if (runtimeHost.session !== session) return;
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		binding.unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						if (runtimeHost.session !== session) return;
						await waitForRawStdoutBackpressure();
					})
				: undefined;
		sessionBindings.set(session, binding);
		return binding;
	};

	runtimeHost.setPrepareSessionRebind(async (nextSession, previousSession): Promise<PreparedSessionScopeRebind> => {
		if (runtimeHost.session !== previousSession) {
			throw new Error("Print host session binding does not match the current runtime scope");
		}
		const previousBinding = sessionBindings.get(previousSession);
		let candidateBinding: PrintSessionBinding | undefined;
		try {
			await nextSession.prepareExtensionBindings(extensionBindings(nextSession));
			candidateBinding = subscribeSession(nextSession);
		} catch (error) {
			candidateBinding?.unsubscribe?.();
			candidateBinding?.unsubscribeBackpressure?.();
			sessionBindings.delete(nextSession);
			throw error;
		}
		return {
			commit: () => undefined,
			activate: () => nextSession.activateExtensionBindings(),
			disposeCandidate: () => {
				candidateBinding?.unsubscribe?.();
				candidateBinding?.unsubscribeBackpressure?.();
				sessionBindings.delete(nextSession);
			},
			disposePrevious: () => {
				previousBinding?.unsubscribe?.();
				previousBinding?.unsubscribeBackpressure?.();
				sessionBindings.delete(previousSession);
			},
		};
	});

	try {
		if (mode === "json") {
			const header = runtimeHost.session.sessionRead.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await runtimeHost.session.bindExtensions(extensionBindings(runtimeHost.session));
		subscribeSession(runtimeHost.session);

		if (initialMessage) {
			await runtimeHost.session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await runtimeHost.session.prompt(message);
		}

		if (mode === "text") {
			const state = runtimeHost.session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		if (shutdownCoordinator.state === "accepting") {
			shutdownCoordinator.removeSignalHandlers();
			await disposeRuntime();
			await flushRawStdout();
		} else {
			await shutdownCoordinator.completion;
		}
	}
}
