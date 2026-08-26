/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `aos -p "prompt"` - text output
 * - `aos --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@aos-agent/ai";
import type { AgentSession, ExtensionBindings } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { PreparedSessionScopeRebind } from "../core/current-session-scope.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
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
		session: AgentSession;
		unsubscribe?: () => void;
		unsubscribeBackpressure?: () => void;
	}
	let currentBinding: PrintSessionBinding = { session: runtimeHost.session };
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		currentBinding.unsubscribe?.();
		currentBinding.unsubscribeBackpressure?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

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

	const subscribeBinding = (binding: PrintSessionBinding): void => {
		binding.unsubscribe = binding.session.subscribe((event) => {
			if (currentBinding !== binding) return;
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		binding.unsubscribeBackpressure =
			mode === "json"
				? binding.session.agent.subscribe(async () => {
						if (currentBinding !== binding) return;
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	runtimeHost.setPrepareSessionRebind(async (nextSession, previousSession): Promise<PreparedSessionScopeRebind> => {
		if (currentBinding.session !== previousSession) {
			throw new Error("Print host session binding does not match the current runtime scope");
		}
		const previousBinding = currentBinding;
		const candidateBinding: PrintSessionBinding = { session: nextSession };
		try {
			await nextSession.prepareExtensionBindings(extensionBindings(nextSession));
			subscribeBinding(candidateBinding);
		} catch (error) {
			candidateBinding.unsubscribe?.();
			candidateBinding.unsubscribeBackpressure?.();
			throw error;
		}
		return {
			commit: () => {
				currentBinding = candidateBinding;
			},
			activate: () => nextSession.activateExtensionBindings(),
			disposeCandidate: () => {
				candidateBinding.unsubscribe?.();
				candidateBinding.unsubscribeBackpressure?.();
			},
			disposePrevious: () => {
				previousBinding.unsubscribe?.();
				previousBinding.unsubscribeBackpressure?.();
			},
		};
	});

	try {
		if (mode === "json") {
			const header = currentBinding.session.sessionRead.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await currentBinding.session.bindExtensions(extensionBindings(currentBinding.session));
		subscribeBinding(currentBinding);

		if (initialMessage) {
			await currentBinding.session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await currentBinding.session.prompt(message);
		}

		if (mode === "text") {
			const state = currentBinding.session.state;
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
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
