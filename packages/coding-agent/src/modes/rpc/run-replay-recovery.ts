import type { DurableEventEnvelope } from "../../../../agent/src/internal.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import type {
	AuditEvent,
	AuditReplayQuery,
	AuditReplayResult,
	RunGetData,
	RunReceipt,
} from "./rpc-types.ts";

/**
 * A run stream event as received by an RPC client.
 *
 * `sequence` belongs to the live run stream. It is deliberately independent
 * from an audit replay cursor: audit cursors order persisted audit facts and do
 * not encode a run stream sequence.
 */
interface RpcRunStreamEnvelope {
	readonly runId: string;
	readonly sessionId: string;
	readonly sequence: number;
	readonly timestamp: string;
	readonly eventId: string;
	readonly streamId: string;
	readonly correlation: DurableEventEnvelope["correlation"];
}

export type RpcRunStreamEvent =
	| (RpcRunStreamEnvelope & { readonly type: "run.started" })
	| (RpcRunStreamEnvelope & {
			type: "run.event";
			event: JsonAgentSessionEvent;
	  })
	| (RpcRunStreamEnvelope & {
			type: "run.completed";
			receipt: RunReceipt;
	  })
	| (RpcRunStreamEnvelope & {
			type: "run.failed";
			receipt: RunReceipt;
	  })
	| (RpcRunStreamEnvelope & {
			type: "run.cancelled";
			receipt: RunReceipt;
	  });

export type RunReplayTerminalStatus = "completed" | "failed" | "cancelled";

export interface RunReplayTerminalUsage {
	readonly input: number;
	readonly output: number;
	readonly total: number;
}

export interface RunReplayTerminalError {
	readonly code: string;
	readonly retryable?: boolean;
}

/** The one terminal confirmation exposed by a recovery instance. */
export interface RunReplayTerminalConfirmation {
	readonly status: RunReplayTerminalStatus;
	readonly terminalError?: RunReplayTerminalError;
	readonly usage?: RunReplayTerminalUsage;
	readonly source: "run.event" | "audit.replay" | "run.get";
	readonly sequence?: number;
	readonly receipt?: RunReceipt;
	readonly auditEventKey?: string;
}

export interface RunReplayTerminalConflict {
	readonly confirmed: RunReplayTerminalStatus;
	readonly received: RunReplayTerminalStatus;
	readonly source: RunReplayTerminalConfirmation["source"];
	readonly reason: "status" | "terminal_error" | "usage";
}

export type RunReplayRecoveryErrorCode = "run_replay_terminal_conflict";

export class RunReplayRecoveryError extends Error {
	readonly code: RunReplayRecoveryErrorCode;
	readonly conflict: RunReplayTerminalConflict;

	constructor(conflict: RunReplayTerminalConflict) {
		super("Run replay terminal evidence conflicts");
		this.name = "RunReplayRecoveryError";
		this.code = "run_replay_terminal_conflict";
		this.conflict = { ...conflict };
	}
}

/**
 * A missing portion of the live stream. The event that caused the gap is not
 * consumed, so callers can reconnect/replay before accepting later events.
 */
export interface RunReplayGap {
	readonly expectedSequence: number;
	readonly receivedSequence: number;
	readonly missingFrom: number;
	readonly missingTo: number;
}

/**
 * Serializable recovery checkpoint.
 *
 * `lastEventSequence` and `auditReplayCursor` are paired only as a client
 * checkpoint. They are not interchangeable: the former is a contiguous live
 * stream watermark, while the latter is an opaque ordered-audit cursor.
 */
export interface RunReplayRecoveryState {
	readonly runId: string;
	readonly sessionId?: string;
	readonly lastEventSequence: number;
	readonly auditReplayCursor?: string;
	readonly auditReplayComplete: boolean;
	readonly auditStatus?: AuditReplayResult["status"];
	readonly gap?: RunReplayGap;
	readonly terminal?: RunReplayTerminalConfirmation;
	readonly terminalConflict?: RunReplayTerminalConflict;
	/** Stable audit identities already handed to the caller. */
	readonly consumedAuditEventKeys: ReadonlyArray<string>;
}

export interface RunReplayRecoverySource {
	/** Read-only run snapshot used to reconcile terminal state after reconnect. */
	readonly getRun: (runId: string) => Promise<RunGetData>;
	/** Read-only audit replay page reader. */
	readonly auditReplay: (query: AuditReplayQuery) => Promise<AuditReplayResult>;
}

export interface RunReplayRecoveryOptions {
	readonly runId: string;
	readonly sessionId?: string;
	readonly state?: RunReplayRecoveryState;
	readonly initialEventSequence?: number;
	/** Replay filters excluding the run id and opaque pagination cursor. */
	readonly replayQuery?: Omit<AuditReplayQuery, "runId" | "cursor">;
	readonly source?: RunReplayRecoverySource;
	/** Maximum pages fetched by one reconnect; protects against a faulty cursor. */
	readonly maxPages?: number;
}

export type RunReplayEventDisposition =
	| "accepted"
	| "duplicate"
	| "gap"
	| "terminal_duplicate"
	| "after_terminal"
	| "ignored";

export interface RunReplayEventResult {
	readonly disposition: RunReplayEventDisposition;
	readonly accepted: boolean;
	readonly duplicate: boolean;
	readonly event?: RpcRunStreamEvent;
	readonly gap?: RunReplayGap;
	readonly terminalConfirmation?: RunReplayTerminalConfirmation;
	readonly terminalConflict?: RunReplayTerminalConflict;
	readonly ignoredReason?:
		| "run_mismatch"
		| "session_mismatch"
		| "invalid_sequence"
		| "invalid_envelope"
		| "correlation_mismatch";
	readonly state: RunReplayRecoveryState;
}

export interface RunReplayPageResult {
	readonly events: ReadonlyArray<AuditEvent>;
	readonly duplicateEventKeys: ReadonlyArray<string>;
	readonly ignoredEventCount: number;
	readonly terminalConfirmation?: RunReplayTerminalConfirmation;
	readonly terminalConflict?: RunReplayTerminalConflict;
	readonly state: RunReplayRecoveryState;
}

export interface RunReplayRunSnapshotResult {
	readonly terminalConfirmation?: RunReplayTerminalConfirmation;
	readonly terminalConflict?: RunReplayTerminalConflict;
	readonly state: RunReplayRecoveryState;
}

export interface RunReplayReconnectResult {
	readonly run: RunGetData;
	readonly pages: number;
	readonly events: ReadonlyArray<AuditEvent>;
	readonly duplicateEventKeys: ReadonlyArray<string>;
	readonly terminalConfirmation?: RunReplayTerminalConfirmation;
	readonly terminalConflict?: RunReplayTerminalConflict;
	/** True when another page may exist or replay was not complete. */
	readonly hasMore: boolean;
	readonly state: RunReplayRecoveryState;
}

const DEFAULT_MAX_PAGES = 32;

function isTerminalStatus(value: string): value is RunReplayTerminalStatus {
	return value === "completed" || value === "failed" || value === "cancelled";
}

interface TerminalObservation {
	readonly status: RunReplayTerminalStatus;
	readonly terminalError?: RunReplayTerminalError;
	readonly usage?: RunReplayTerminalUsage;
}

function terminalObservation(
	status: RunReplayTerminalStatus,
	receipt: RunReceipt | undefined,
): TerminalObservation {
	return {
		status,
		...(receipt?.terminalError === undefined
			? {}
			: { terminalError: { code: receipt.terminalError.code, retryable: receipt.terminalError.retryable } }),
		...(receipt?.usage === undefined
			? {}
			: { usage: { input: receipt.usage.input, output: receipt.usage.output, total: receipt.usage.total } }),
	};
}

function terminalFromStreamEvent(event: RpcRunStreamEvent): TerminalObservation | undefined {
	if (event.type === "run.completed") return terminalObservation("completed", event.receipt);
	if (event.type === "run.failed") return terminalObservation("failed", event.receipt);
	if (event.type === "run.cancelled") return terminalObservation("cancelled", event.receipt);
	return undefined;
}

function terminalFromAuditEvent(event: AuditEvent): TerminalObservation | undefined {
	if (event.type !== "run.completed" && event.type !== "run.failed" && event.type !== "run.cancelled") return undefined;
	return {
		status: event.type === "run.completed" ? "completed" : event.type === "run.failed" ? "failed" : "cancelled",
		...(event.summary.terminalError === undefined
			? {}
			: {
					terminalError: {
						code: event.summary.terminalError.code,
						...(event.summary.terminalError.retryable === undefined
							? {}
							: { retryable: event.summary.terminalError.retryable }),
					},
				}),
		...(event.summary.usage === undefined
			? {}
			: {
					usage: {
						input: event.summary.usage.input,
						output: event.summary.usage.output,
						total: event.summary.usage.total,
					},
				}),
	};
}

function auditEventKey(event: AuditEvent): string {
	return `${event.sessionId}\u0000${event.sourceEntryId}\u0000${event.eventId}`;
}

function validateSequence(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function streamEnvelopeError(
	event: RpcRunStreamEvent,
): Exclude<RunReplayEventResult["ignoredReason"], undefined> | undefined {
	if (
		typeof event.eventId !== "string" ||
		event.eventId.length === 0 ||
		typeof event.streamId !== "string" ||
		event.streamId.length === 0 ||
		typeof event.timestamp !== "string" ||
		event.timestamp.length === 0 ||
		!isRecord(event.correlation)
	) {
		return "invalid_envelope";
	}
	if (
		event.streamId !== event.sessionId ||
		event.correlation.sessionId !== event.sessionId ||
		event.correlation.runId !== event.runId
	) {
		return "correlation_mismatch";
	}
	if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
		const expectedStatus = event.type === "run.completed" ? "completed" : event.type === "run.failed" ? "failed" : "cancelled";
		if (
			!isRecord(event.receipt) ||
			typeof event.receipt.runReceiptId !== "string" ||
			event.receipt.runReceiptId.length === 0 ||
			event.receipt.runId !== event.runId ||
			event.receipt.sessionId !== event.sessionId ||
			event.receipt.status !== expectedStatus ||
			event.correlation.runReceiptId !== event.receipt.runReceiptId
		) {
			return "correlation_mismatch";
		}
	}
	return undefined;
}

function cloneGap(gap: RunReplayGap | undefined): RunReplayGap | undefined {
	return gap === undefined ? undefined : { ...gap };
}

function cloneTerminal(
	terminal: RunReplayTerminalConfirmation | undefined,
): RunReplayTerminalConfirmation | undefined {
	return terminal === undefined
		? undefined
		: {
				...terminal,
				...(terminal.terminalError === undefined ? {} : { terminalError: { ...terminal.terminalError } }),
				...(terminal.usage === undefined ? {} : { usage: { ...terminal.usage } }),
			};
}

/**
 * Stateful, read-only consumer for a run stream and its durable audit replay.
 *
 * Live events must arrive at `lastEventSequence + 1`; a later sequence reports
 * a gap and is left unconsumed. Audit pages advance only the opaque
 * `auditReplayCursor` and are deduplicated by audit identity. The first
 * terminal observation, regardless of whether it came from a live event,
 * audit replay, or `run.get`, is the only terminal confirmation returned.
 */
export class RunReplayRecovery {
	readonly runId: string;
	private readonly source: RunReplayRecoverySource | undefined;
	private readonly replayQuery: Omit<AuditReplayQuery, "runId" | "cursor">;
	private readonly maxPages: number;
	private sessionId: string | undefined;
	private lastEventSequence: number;
	private auditReplayCursor: string | undefined;
	private auditReplayComplete: boolean;
	private auditStatus: AuditReplayResult["status"] | undefined;
	private gap: RunReplayGap | undefined;
	private terminal: RunReplayTerminalConfirmation | undefined;
	private terminalConflict: RunReplayTerminalConflict | undefined;
	private readonly consumedAuditEventKeys: Set<string>;

	constructor(options: RunReplayRecoveryOptions) {
		if (options.runId.length === 0) throw new Error("Run replay recovery requires a run id");
		this.runId = options.runId;
		this.source = options.source;
		this.replayQuery = { ...(options.replayQuery ?? {}) };
		this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
		if (!Number.isSafeInteger(this.maxPages) || this.maxPages < 1) {
			throw new Error("Run replay recovery maxPages must be a positive safe integer");
		}

		const state = options.state;
		if (state !== undefined && state.runId !== this.runId) {
			throw new Error(`Run replay recovery state belongs to ${state.runId}, not ${this.runId}`);
		}
		const initialSequence = state?.lastEventSequence ?? options.initialEventSequence ?? 0;
		if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
			throw new Error("Run replay recovery event sequence must be a non-negative safe integer");
		}
		this.sessionId = state?.sessionId ?? options.sessionId;
		this.lastEventSequence = initialSequence;
		this.auditReplayCursor = state?.auditReplayCursor;
		this.auditReplayComplete = state?.auditReplayComplete ?? false;
		this.auditStatus = state?.auditStatus;
		this.gap = cloneGap(state?.gap);
		this.terminalConflict = state?.terminalConflict === undefined ? undefined : { ...state.terminalConflict };
		this.terminal = this.terminalConflict === undefined ? cloneTerminal(state?.terminal) : undefined;
		this.consumedAuditEventKeys = new Set(state?.consumedAuditEventKeys ?? []);
	}

	get eventSequence(): number {
		return this.lastEventSequence;
	}

	get nextEventSequence(): number {
		return this.lastEventSequence + 1;
	}

	get auditCursor(): string | undefined {
		return this.auditReplayCursor;
	}

	get terminalConfirmed(): boolean {
		return this.terminal !== undefined;
	}

	getState(): RunReplayRecoveryState {
		return {
			runId: this.runId,
			...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
			lastEventSequence: this.lastEventSequence,
			...(this.auditReplayCursor === undefined ? {} : { auditReplayCursor: this.auditReplayCursor }),
			auditReplayComplete: this.auditReplayComplete,
			...(this.auditStatus === undefined ? {} : { auditStatus: this.auditStatus }),
			...(this.gap === undefined ? {} : { gap: { ...this.gap } }),
			...(this.terminal === undefined ? {} : { terminal: cloneTerminal(this.terminal)! }),
			...(this.terminalConflict === undefined ? {} : { terminalConflict: { ...this.terminalConflict } }),
			consumedAuditEventKeys: [...this.consumedAuditEventKeys].sort(),
		};
	}

	/** Consume one live run event, enforcing a contiguous sequence watermark. */
	consumeRunEvent(event: RpcRunStreamEvent): RunReplayEventResult {
		this.assertUsable();
		if (event.runId !== this.runId) return this.ignoredEvent(event, "run_mismatch");
		if (this.sessionId !== undefined && event.sessionId !== this.sessionId) {
			return this.ignoredEvent(event, "session_mismatch");
		}
		const envelopeError = streamEnvelopeError(event);
		if (envelopeError !== undefined) return this.ignoredEvent(event, envelopeError);
		if (!validateSequence(event.sequence)) return this.ignoredEvent(event, "invalid_sequence");
		this.sessionId ??= event.sessionId;

		const expectedSequence = this.nextEventSequence;
		if (event.sequence > expectedSequence) {
			const gap: RunReplayGap = {
				expectedSequence,
				receivedSequence: event.sequence,
				missingFrom: expectedSequence,
				missingTo: event.sequence - 1,
			};
			this.gap = gap;
			return {
				disposition: "gap",
				accepted: false,
				duplicate: false,
				gap,
				event,
				state: this.getState(),
			};
		}

		const streamTerminal = terminalFromStreamEvent(event);
		if (event.sequence <= this.lastEventSequence) {
			const terminalConflict =
				streamTerminal === undefined ? undefined : this.recordTerminalConflict(streamTerminal, "run.event");
			return {
				disposition: streamTerminal === undefined ? "duplicate" : "terminal_duplicate",
				accepted: false,
				duplicate: true,
				...(terminalConflict === undefined ? {} : { terminalConflict }),
				event,
				state: this.getState(),
			};
		}

		if (this.terminal?.source === "run.event" && streamTerminal === undefined) {
			return {
				disposition: "after_terminal",
				accepted: false,
				duplicate: false,
				event,
				state: this.getState(),
			};
		}

		this.lastEventSequence = event.sequence;
		this.gap = undefined;
		if (streamTerminal === undefined) {
			return {
				disposition: "accepted",
				accepted: true,
				duplicate: false,
				event,
				state: this.getState(),
			};
		}

		const terminalConflict = this.recordTerminalConflict(streamTerminal, "run.event");
		if (this.terminal !== undefined) {
			return {
				disposition: "terminal_duplicate",
				accepted: false,
				duplicate: true,
				...(terminalConflict === undefined ? {} : { terminalConflict }),
				event,
				state: this.getState(),
			};
		}
		const terminalConfirmation = this.confirmTerminal({
			...streamTerminal,
			source: "run.event",
			sequence: event.sequence,
			receipt: "receipt" in event ? event.receipt : undefined,
		});
		return {
			disposition: "accepted",
			accepted: true,
			duplicate: false,
			event,
			terminalConfirmation,
			state: this.getState(),
		};
	}

	/** Consume one audit.replay page and advance only its opaque cursor. */
	consumeReplayPage(result: AuditReplayResult): RunReplayPageResult {
		this.assertUsable();
		const events: AuditEvent[] = [];
		const duplicateEventKeys: string[] = [];
		let ignoredEventCount = 0;
		let terminalConfirmation: RunReplayTerminalConfirmation | undefined;
		let terminalConflict: RunReplayTerminalConflict | undefined;

		for (const event of result.events) {
			if (event.runId !== this.runId) {
				ignoredEventCount += 1;
				continue;
			}
			const key = auditEventKey(event);
			if (this.consumedAuditEventKeys.has(key)) {
				duplicateEventKeys.push(key);
				continue;
			}
			this.consumedAuditEventKeys.add(key);
			events.push(event);

			const observation = terminalFromAuditEvent(event);
			if (observation === undefined) continue;
			const conflict = this.recordTerminalConflict(observation, "audit.replay");
			if (conflict !== undefined) terminalConflict ??= conflict;
			if (this.terminal === undefined) {
				terminalConfirmation = this.confirmTerminal({
					...observation,
					source: "audit.replay",
					auditEventKey: key,
				});
			}
		}

		this.auditStatus = result.status;
		if (result.nextCursor !== undefined) {
			this.auditReplayCursor = result.nextCursor;
			this.auditReplayComplete = false;
		} else {
			// `interrupted` and `incomplete` pages can still be exhausted. The
			// status describes run integrity, while nextCursor describes page
			// availability; do not conflate the two.
			this.auditReplayComplete = true;
		}

		return {
			events,
			duplicateEventKeys,
			ignoredEventCount,
			...(terminalConfirmation === undefined ? {} : { terminalConfirmation }),
			...(terminalConflict === undefined ? {} : { terminalConflict }),
			state: this.getState(),
		};
	}

	/** Reconcile a read-only run.get snapshot without inventing a stream sequence. */
	reconcileRun(run: RunGetData): RunReplayRunSnapshotResult {
		this.assertUsable();
		if (run.run.id !== this.runId) throw new Error(`Run snapshot belongs to ${run.run.id}, not ${this.runId}`);
		if (this.sessionId !== undefined && run.run.sessionId !== this.sessionId) {
			throw new Error(`Run snapshot belongs to session ${run.run.sessionId}, not ${this.sessionId}`);
		}
		this.sessionId ??= run.run.sessionId;
		const status = run.receipt?.status ?? run.run.status;
		let terminalConfirmation: RunReplayTerminalConfirmation | undefined;
		let terminalConflict: RunReplayTerminalConflict | undefined;
		if (isTerminalStatus(status)) {
			const observation = terminalObservation(status, run.receipt);
			terminalConflict = this.recordTerminalConflict(observation, "run.get");
			if (this.terminal === undefined) {
				terminalConfirmation = this.confirmTerminal({
					...observation,
					source: "run.get",
					...(run.receipt === undefined ? {} : { receipt: run.receipt }),
				});
			} else if (terminalConflict === undefined && run.receipt !== undefined && this.terminal.receipt === undefined) {
				// Audit replay intentionally omits receipt payloads. A later read-only
				// run.get may provide the durable receipt without emitting a second
				// terminal confirmation.
				this.terminal = {
					...this.terminal,
					...observation,
					receipt: run.receipt,
				};
			}
		}
		return {
			...(terminalConfirmation === undefined ? {} : { terminalConfirmation }),
			...(terminalConflict === undefined ? {} : { terminalConflict }),
			state: this.getState(),
		};
	}

	/**
	 * Reconcile the run snapshot and read audit pages until the durable replay is
	 * exhausted or the configured page bound is reached. All calls are read-only.
	 */
	async reconnect(): Promise<RunReplayReconnectResult> {
		this.assertUsable();
		if (this.source === undefined) throw new Error("Run replay recovery has no read-only source");
		const run = await this.source.getRun(this.runId);
		const runSnapshot = this.reconcileRun(run);
		const events: AuditEvent[] = [];
		const duplicateEventKeys: string[] = [];
		let pages = 0;
		let hasMore = false;
		let terminalConfirmation = runSnapshot.terminalConfirmation;

		while (!this.auditReplayComplete && pages < this.maxPages) {
			const cursorBeforePage = this.auditReplayCursor;
			const query: AuditReplayQuery = {
				runId: this.runId,
				...this.replayQuery,
				...(cursorBeforePage === undefined ? {} : { cursor: cursorBeforePage }),
			};
			const page = await this.source.auditReplay(query);
			pages += 1;
			const consumed = this.consumeReplayPage(page);
			events.push(...consumed.events);
			duplicateEventKeys.push(...consumed.duplicateEventKeys);
			terminalConfirmation ??= consumed.terminalConfirmation;

			if (this.auditReplayComplete) break;
			if (page.nextCursor === undefined || page.nextCursor === cursorBeforePage) {
				hasMore = true;
				break;
			}
		}
		if (!this.auditReplayComplete && pages >= this.maxPages) hasMore = true;

		return {
			run,
			pages,
			events,
			duplicateEventKeys,
			...(terminalConfirmation === undefined ? {} : { terminalConfirmation }),
			...(this.terminalConflict === undefined ? {} : { terminalConflict: this.terminalConflict }),
			hasMore,
			state: this.getState(),
		};
	}

	private ignoredEvent(event: RpcRunStreamEvent, reason: RunReplayEventResult["ignoredReason"]): RunReplayEventResult {
		return {
			disposition: "ignored",
			accepted: false,
			duplicate: false,
			event,
			ignoredReason: reason,
			state: this.getState(),
		};
	}

	private confirmTerminal(input: Omit<RunReplayTerminalConfirmation, "receipt"> & { receipt?: RunReceipt }): RunReplayTerminalConfirmation {
		if (this.terminal !== undefined) return this.terminal;
		this.terminal = { ...input };
		return this.terminal;
	}

	private assertUsable(): void {
		if (this.terminalConflict !== undefined) throw new RunReplayRecoveryError(this.terminalConflict);
	}

	private recordTerminalConflict(
		observation: TerminalObservation,
		source: RunReplayTerminalConfirmation["source"],
	): RunReplayTerminalConflict | undefined {
		if (this.terminal === undefined) return undefined;
		let reason: RunReplayTerminalConflict["reason"] | undefined;
		if (this.terminal.status !== observation.status) reason = "status";
		else if (
			this.terminal.terminalError !== undefined &&
			observation.terminalError !== undefined &&
			(this.terminal.terminalError.code !== observation.terminalError.code ||
				(this.terminal.terminalError.retryable ?? undefined) !== (observation.terminalError.retryable ?? undefined))
		) {
			reason = "terminal_error";
		} else if (
			this.terminal.usage !== undefined &&
			observation.usage !== undefined &&
			(this.terminal.usage.input !== observation.usage.input ||
				this.terminal.usage.output !== observation.usage.output ||
				this.terminal.usage.total !== observation.usage.total)
		) {
			reason = "usage";
		}
		if (reason === undefined) {
			if (this.terminal.terminalError === undefined && observation.terminalError !== undefined) {
				this.terminal = { ...this.terminal, terminalError: { ...observation.terminalError } };
			}
			if (this.terminal.usage === undefined && observation.usage !== undefined) {
				this.terminal = { ...this.terminal, usage: { ...observation.usage } };
			}
			return undefined;
		}
		const conflict: RunReplayTerminalConflict = {
			confirmed: this.terminal.status,
			received: observation.status,
			source,
			reason,
		};
		this.terminal = undefined;
		this.terminalConflict = conflict;
		throw new RunReplayRecoveryError(conflict);
	}
}

export function createRunReplayRecovery(options: RunReplayRecoveryOptions): RunReplayRecovery {
	return new RunReplayRecovery(options);
}
