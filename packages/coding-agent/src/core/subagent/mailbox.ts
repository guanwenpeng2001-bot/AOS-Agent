/** Same-Session durable Child Agent mailbox and read-only sibling roster. */

import {
	canonicalFoundationJson,
	cloneDeepFrozen,
	FoundationError,
	Result,
	validateEventPayloadForCategory,
	type EventCorrelationRef,
	type FoundationJsonValue,
	type FoundationRecord,
	type ResultValue,
	type SessionLedger,
} from "@aos-agent/agent-core";
import { SUBAGENT_PROVIDER_KINDS } from "./lifecycle.ts";
import type { ChildAgentRosterEntry } from "./supervisor.ts";

export const SUBAGENT_MAILBOX_SENT_OBJECT_TYPE = "subagent.mailbox_message_sent";
export const SUBAGENT_MAILBOX_ACK_OBJECT_TYPE = "subagent.mailbox_message_acknowledged";

export type ChildMailboxMessageKind = "input" | "query" | "notice" | "result_ref";

export interface ChildMailboxCorrelation {
	readonly sessionId: string;
	readonly laneId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly agentInstanceId: string;
}

export interface ChildMailboxMessage {
	readonly schemaVersion: 1;
	readonly messageId: string;
	readonly fromAgentInstanceId: string;
	readonly toAgentInstanceId: string;
	readonly kind: ChildMailboxMessageKind;
	readonly body: FoundationJsonValue;
	readonly correlation: ChildMailboxCorrelation;
	readonly createdAt: string;
	readonly ack?: {
		readonly at: string;
		readonly byAttemptId: string;
	};
}

export interface ChildMailboxEndpoint {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly laneId: string;
	readonly agentInstanceId: string;
	readonly taskId: string;
	readonly attemptId: string;
}

export interface SendChildMailboxMessageInput {
	readonly schemaVersion: 1;
	readonly messageId: string;
	readonly fromAgentInstanceId: string;
	readonly fromAttemptId: string;
	readonly toAgentInstanceId: string;
	readonly kind: ChildMailboxMessageKind;
	readonly body: FoundationJsonValue;
	readonly correlation: ChildMailboxCorrelation;
}

export interface AcknowledgeChildMailboxMessageInput {
	readonly schemaVersion: 1;
	readonly messageId: string;
	readonly toAgentInstanceId: string;
	readonly byAttemptId: string;
}

export interface ConsumeChildMailboxInput {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly toAgentInstanceId: string;
	readonly byAttemptId: string;
	readonly limit: number;
}

export interface WaitForChildrenInput {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly childAgentInstanceIds: readonly string[];
	readonly timeoutMs: number;
}

export interface QueryChildMailboxInput {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly childAgentInstanceId: string;
	readonly timeoutMs: number;
}

export interface ChildMailboxQuery {
	readonly schemaVersion: 1;
	readonly child: ChildAgentRosterEntry;
	readonly pendingMessages: number;
	readonly lastMessageSequence?: number;
}

export interface SubagentMailboxOptions {
	readonly schemaVersion: 1;
	readonly ledger: SessionLedger;
	readonly ledgerForLane: (laneId: string) => SessionLedger;
	readonly sessionId: string;
	readonly laneId: string;
	readonly roster: () => readonly ChildAgentRosterEntry[];
	readonly endpoints?: readonly ChildMailboxEndpoint[];
	readonly maxBodyBytes: number;
	readonly maxPendingPerRecipient: number;
	readonly maxMessagesPerWindow: number;
	readonly rateWindowMs: number;
	readonly maxWaitMs: number;
	readonly pollIntervalMs: number;
	readonly now?: () => string;
	readonly clock?: () => number;
	readonly delay?: (milliseconds: number) => Promise<void>;
}

interface ChildMailboxSentPayload {
	readonly schemaVersion: 1;
	readonly messageId: string;
	readonly fromAgentInstanceId: string;
	readonly toAgentInstanceId: string;
	readonly kind: ChildMailboxMessageKind;
	readonly body: FoundationJsonValue;
	readonly correlation: ChildMailboxCorrelation;
	readonly createdAt: string;
}

interface ChildMailboxAckPayload {
	readonly schemaVersion: 1;
	readonly messageId: string;
	readonly fromAgentInstanceId: string;
	readonly toAgentInstanceId: string;
	readonly at: string;
	readonly byAttemptId: string;
}

const SEND_KEYS = new Set([
	"schemaVersion",
	"messageId",
	"fromAgentInstanceId",
	"fromAttemptId",
	"toAgentInstanceId",
	"kind",
	"body",
	"correlation",
]);
const CORRELATION_KEYS = new Set(["sessionId", "laneId", "taskId", "attemptId", "agentInstanceId"]);
const SENT_PAYLOAD_KEYS = new Set([
	"schemaVersion",
	"messageId",
	"fromAgentInstanceId",
	"toAgentInstanceId",
	"kind",
	"body",
	"correlation",
	"createdAt",
]);
const ACK_INPUT_KEYS = new Set(["schemaVersion", "messageId", "toAgentInstanceId", "byAttemptId"]);
const CONSUME_KEYS = new Set(["schemaVersion", "sessionId", "toAgentInstanceId", "byAttemptId", "limit"]);
const WAIT_KEYS = new Set(["schemaVersion", "sessionId", "childAgentInstanceIds", "timeoutMs"]);
const QUERY_KEYS = new Set(["schemaVersion", "sessionId", "childAgentInstanceId", "timeoutMs"]);
const ENDPOINT_KEYS = new Set(["schemaVersion", "sessionId", "laneId", "agentInstanceId", "taskId", "attemptId"]);
const ROSTER_KEYS = new Set([
	"schemaVersion",
	"sessionId",
	"laneId",
	"childAgentInstanceId",
	"parentAgentInstanceId",
	"ancestorIds",
	"depth",
	"taskId",
	"attemptId",
	"providerId",
	"providerKind",
	"status",
	"mailboxAddress",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "lost", "closed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isJson(value: unknown): value is FoundationJsonValue {
	try {
		canonicalFoundationJson(value);
		return true;
	} catch {
		return false;
	}
}

function validateCorrelation(value: unknown): value is ChildMailboxCorrelation {
	return (
		isRecord(value) &&
		exactKeys(value, CORRELATION_KEYS) &&
		isIdentifier(value.sessionId) &&
		isIdentifier(value.laneId) &&
		isIdentifier(value.taskId) &&
		isIdentifier(value.attemptId) &&
		isIdentifier(value.agentInstanceId)
	);
}

function validateEndpoint(value: unknown): value is ChildMailboxEndpoint {
	return (
		isRecord(value) &&
		exactKeys(value, ENDPOINT_KEYS) &&
		value.schemaVersion === 1 &&
		isIdentifier(value.sessionId) &&
		isIdentifier(value.laneId) &&
		isIdentifier(value.agentInstanceId) &&
		isIdentifier(value.taskId) &&
		isIdentifier(value.attemptId)
	);
}

function validateRosterEntry(value: unknown): value is ChildAgentRosterEntry {
	return (
		isRecord(value) &&
		exactKeys(value, ROSTER_KEYS) &&
		value.schemaVersion === 1 &&
		isIdentifier(value.sessionId) &&
		isIdentifier(value.laneId) &&
		isIdentifier(value.childAgentInstanceId) &&
		isIdentifier(value.parentAgentInstanceId) &&
		Array.isArray(value.ancestorIds) &&
		value.ancestorIds.every(isIdentifier) &&
		new Set(value.ancestorIds).size === value.ancestorIds.length &&
		isNonNegativeInteger(value.depth) &&
		value.depth === value.ancestorIds.length &&
		value.ancestorIds.at(-1) === value.parentAgentInstanceId &&
		isIdentifier(value.taskId) &&
		isIdentifier(value.attemptId) &&
		isIdentifier(value.providerId) &&
		SUBAGENT_PROVIDER_KINDS.includes(value.providerKind as (typeof SUBAGENT_PROVIDER_KINDS)[number]) &&
		["spawning", "running", "awaiting_input", "background", "cancelling", "succeeded", "failed", "cancelled", "lost", "closed"].includes(
			value.status as string,
		) &&
		value.mailboxAddress === value.childAgentInstanceId
	);
}

function validateSendInput(value: unknown): value is SendChildMailboxMessageInput {
	return (
		isRecord(value) &&
		exactKeys(value, SEND_KEYS) &&
		value.schemaVersion === 1 &&
		isIdentifier(value.messageId) &&
		isIdentifier(value.fromAgentInstanceId) &&
		isIdentifier(value.fromAttemptId) &&
		isIdentifier(value.toAgentInstanceId) &&
		["input", "query", "notice", "result_ref"].includes(value.kind as string) &&
		isJson(value.body) &&
		validateCorrelation(value.correlation)
	);
}

function validateSentPayload(value: unknown): value is ChildMailboxSentPayload {
	return (
		isRecord(value) &&
		exactKeys(value, SENT_PAYLOAD_KEYS) &&
		value.schemaVersion === 1 &&
		isIdentifier(value.messageId) &&
		isIdentifier(value.fromAgentInstanceId) &&
		isIdentifier(value.toAgentInstanceId) &&
		["input", "query", "notice", "result_ref"].includes(value.kind as string) &&
		isJson(value.body) &&
		validateCorrelation(value.correlation) &&
		isCanonicalTimestamp(value.createdAt) &&
		validateEventPayloadForCategory("subagent.mailbox_message_sent", value)
	);
}

function validateAckPayload(value: unknown): value is ChildMailboxAckPayload {
	return (
		isRecord(value) &&
		exactKeys(
			value,
			new Set(["schemaVersion", "messageId", "fromAgentInstanceId", "toAgentInstanceId", "at", "byAttemptId"]),
		) &&
		value.schemaVersion === 1 &&
		isIdentifier(value.messageId) &&
		isIdentifier(value.fromAgentInstanceId) &&
		isIdentifier(value.toAgentInstanceId) &&
		isCanonicalTimestamp(value.at) &&
		isIdentifier(value.byAttemptId) &&
		validateEventPayloadForCategory("subagent.mailbox_message_acknowledged", value)
	);
}

function publicMessage(sent: ChildMailboxSentPayload, ack: ChildMailboxAckPayload | undefined): ChildMailboxMessage {
	return cloneDeepFrozen({
		...sent,
		...(ack === undefined ? {} : { ack: { at: ack.at, byAttemptId: ack.byAttemptId } }),
	});
}

function inputMatchesStored(input: SendChildMailboxMessageInput, stored: ChildMailboxSentPayload): boolean {
	return (
		input.messageId === stored.messageId &&
		input.fromAgentInstanceId === stored.fromAgentInstanceId &&
		input.toAgentInstanceId === stored.toAgentInstanceId &&
		input.kind === stored.kind &&
		canonicalFoundationJson(input.body) === canonicalFoundationJson(stored.body) &&
		canonicalFoundationJson(input.correlation) === canonicalFoundationJson(stored.correlation)
	);
}

export class SubagentMailbox {
	private readonly ledger: SessionLedger;
	private readonly ledgerForLane: (laneId: string) => SessionLedger;
	private readonly sessionId: string;
	private readonly rosterSource: () => readonly ChildAgentRosterEntry[];
	private readonly endpoints = new Map<string, ChildMailboxEndpoint>();
	private readonly sealedEndpoints = new Set<string>();
	private readonly maxBodyBytes: number;
	private readonly maxPendingPerRecipient: number;
	private readonly maxMessagesPerWindow: number;
	private readonly rateWindowMs: number;
	private readonly maxWaitMs: number;
	private readonly pollIntervalMs: number;
	private readonly now: () => string;
	private readonly clock: () => number;
	private readonly waitDelay: (milliseconds: number) => Promise<void>;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(options: SubagentMailboxOptions) {
		const endpoints = options.endpoints ?? [];
		if (
			options.schemaVersion !== 1 ||
			!isIdentifier(options.sessionId) ||
			!isIdentifier(options.laneId) ||
			!isPositiveInteger(options.maxBodyBytes) ||
			!isPositiveInteger(options.maxPendingPerRecipient) ||
			!isPositiveInteger(options.maxMessagesPerWindow) ||
			!isPositiveInteger(options.rateWindowMs) ||
			!isPositiveInteger(options.maxWaitMs) ||
			!isPositiveInteger(options.pollIntervalMs) ||
			options.pollIntervalMs > options.maxWaitMs ||
			!endpoints.every(validateEndpoint) ||
			endpoints.some((endpoint) => endpoint.sessionId !== options.sessionId) ||
			new Set(endpoints.map((endpoint) => endpoint.agentInstanceId)).size !== endpoints.length ||
			new Set(endpoints.map((endpoint) => `${endpoint.laneId}:${endpoint.agentInstanceId}`)).size !== endpoints.length ||
			typeof options.ledgerForLane !== "function" ||
			(options.delay !== undefined && typeof options.delay !== "function")
		) {
			throw new FoundationError("subagent_mailbox_invalid", "Subagent mailbox options are invalid");
		}
		this.ledger = options.ledger;
		this.ledgerForLane = options.ledgerForLane;
		this.sessionId = options.sessionId;
		this.rosterSource = options.roster;
		for (const endpoint of endpoints) this.endpoints.set(endpoint.agentInstanceId, cloneDeepFrozen(endpoint));
		this.maxBodyBytes = options.maxBodyBytes;
		this.maxPendingPerRecipient = options.maxPendingPerRecipient;
		this.maxMessagesPerWindow = options.maxMessagesPerWindow;
		this.rateWindowMs = options.rateWindowMs;
		this.maxWaitMs = options.maxWaitMs;
		this.pollIntervalMs = options.pollIntervalMs;
		this.now = options.now ?? (() => new Date().toISOString());
		this.clock = options.clock ?? (() => Date.now());
		this.waitDelay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
		const roster = this.readRoster();
		if (!roster.ok) throw new FoundationError("subagent_mailbox_invalid", "Subagent mailbox roster is invalid");
	}

	async send(inputValue: unknown): Promise<ResultValue<ChildMailboxMessage, FoundationError>> {
		if (!validateSendInput(inputValue)) {
			return Result.err(new FoundationError("subagent_mailbox_invalid", "Child mailbox message has an invalid exact shape"));
		}
		const input = inputValue;
		return this.serial(async () => {
		const fromLookup = this.endpoint(input.fromAgentInstanceId);
		if (!fromLookup.ok) return fromLookup;
		const toLookup = this.endpoint(input.toAgentInstanceId);
		if (!toLookup.ok) return toLookup;
		const from = fromLookup.value;
		const to = toLookup.value;
		if (from === undefined || to === undefined) {
			return Result.err(new FoundationError("subagent_not_found", "Child mailbox endpoint was not found"));
		}
		if (this.sealedEndpoints.has(from.agentInstanceId) || this.sealedEndpoints.has(to.agentInstanceId)) {
			return Result.err(new FoundationError("subagent_mailbox_invalid", "Sealed Child mailbox endpoints cannot send or receive new messages"));
		}
		if (
			from.sessionId !== this.sessionId ||
			to.sessionId !== this.sessionId ||
			input.fromAttemptId !== from.attemptId ||
			input.correlation.sessionId !== this.sessionId ||
			input.correlation.laneId !== to.laneId ||
			input.correlation.taskId !== to.taskId ||
			input.correlation.attemptId !== to.attemptId ||
			input.correlation.agentInstanceId !== to.agentInstanceId ||
			input.toAgentInstanceId !== to.agentInstanceId
		) {
			return Result.err(new FoundationError("subagent_mailbox_invalid", "Cross-Session or forged Child mailbox addressing is rejected"));
		}
		try {
			const existing = await this.ledger.get(SUBAGENT_MAILBOX_SENT_OBJECT_TYPE, input.messageId);
			if (existing !== undefined) {
				const existingResult = this.validateStoredSentRecord(existing);
				if (!existingResult.ok) return existingResult;
				if (existingResult.value === undefined || !inputMatchesStored(input, existingResult.value.payload)) {
					return Result.err(new FoundationError("subagent_conflict", "Child mailbox messageId is already bound to different content"));
				}
				const ack = await this.readAck(input.messageId);
				if (!ack.ok) return ack;
				return Result.ok(publicMessage(existingResult.value.payload, ack.value));
			}
			const payload: ChildMailboxSentPayload = {
				schemaVersion: 1,
				messageId: input.messageId,
				fromAgentInstanceId: input.fromAgentInstanceId,
				toAgentInstanceId: input.toAgentInstanceId,
				kind: input.kind,
				body: cloneDeepFrozen(input.body),
				correlation: cloneDeepFrozen(input.correlation),
				createdAt: this.now(),
			};
			if (!validateSentPayload(payload)) {
				return Result.err(new FoundationError("subagent_mailbox_invalid", "Child mailbox event is invalid"));
			}
			if (new TextEncoder().encode(canonicalFoundationJson(payload)).byteLength > this.maxBodyBytes) {
				return Result.err(new FoundationError("subagent_mailbox_invalid", "Child mailbox message exceeds its total byte limit"));
			}
			const records = await this.readSentRecords();
			if (!records.ok) return records;
			const acknowledgements = await this.readAckMap(records.value);
			if (!acknowledgements.ok) return acknowledgements;
			const pending = records.value.filter(
				(record) => record.payload.toAgentInstanceId === to.agentInstanceId && !acknowledgements.value.has(record.payload.messageId),
			);
			if (pending.length >= this.maxPendingPerRecipient) {
				return Result.err(new FoundationError("subagent_mailbox_invalid", "Child mailbox pending-message limit reached"));
			}
			const windowStart = this.clock() - this.rateWindowMs;
			const senderRate = records.value.filter(
				(record) => record.payload.fromAgentInstanceId === from.agentInstanceId && record.timestamp >= windowStart,
			).length;
			if (senderRate >= this.maxMessagesPerWindow) {
				return Result.err(new FoundationError("subagent_mailbox_invalid", "Child mailbox rate limit reached"));
			}
			const stored = await this.ledgerForLane(to.laneId).appendFact(
				SUBAGENT_MAILBOX_SENT_OBJECT_TYPE,
				payload.messageId,
				payload,
				{
					clientRequestId: `subagent-mailbox-send:${payload.messageId}`,
					expectedRevision: 0,
					correlation: {
						taskId: to.taskId,
						attemptId: to.attemptId,
						agentInstanceId: to.agentInstanceId,
					},
				},
			);
			const storedResult = this.validateStoredSentRecord(stored.record);
			if (!storedResult.ok) return storedResult;
			if (storedResult.value === undefined) {
				return Result.err(new FoundationError("subagent_persistence_failed", "Persisted Child mailbox message is outside mailbox ownership"));
			}
			return Result.ok(publicMessage(storedResult.value.payload, undefined));
		} catch {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child mailbox message could not be persisted"));
		}
		});
	}

	/** Registers dynamic parent authority at the trusted Host boundary. */
	registerEndpoint(input: unknown): ResultValue<void, FoundationError> {
		if (!validateEndpoint(input) || input.sessionId !== this.sessionId) {
			return Result.err(new FoundationError("subagent_mailbox_invalid", "Dynamic Child mailbox endpoint is invalid"));
		}
		const endpoint = cloneDeepFrozen(input);
		const existing = this.endpoints.get(endpoint.agentInstanceId);
		if (existing !== undefined) {
			return canonicalFoundationJson(existing) === canonicalFoundationJson(endpoint)
				? Result.ok(undefined)
				: Result.err(new FoundationError("subagent_conflict", "Child mailbox endpoint identity conflicts with existing authority"));
		}
		const roster = this.readRoster();
		if (!roster.ok) return roster;
		const child = roster.value.find((entry) => entry.childAgentInstanceId === endpoint.agentInstanceId);
		if (child !== undefined && (child.laneId !== endpoint.laneId || child.taskId !== endpoint.taskId || child.attemptId !== endpoint.attemptId)) {
			return Result.err(new FoundationError("subagent_conflict", "Child mailbox endpoint conflicts with the durable roster"));
		}
		this.endpoints.set(endpoint.agentInstanceId, endpoint);
		return Result.ok(undefined);
	}

	/** Stops new delivery while retaining durable messages for acknowledgement/consumption. */
	sealEndpoint(agentInstanceId: string): ResultValue<void, FoundationError> {
		if (!isIdentifier(agentInstanceId)) {
			return Result.err(new FoundationError("subagent_mailbox_invalid", "Child mailbox seal identity is invalid"));
		}
		const endpoint = this.endpoint(agentInstanceId);
		if (!endpoint.ok) return endpoint;
		if (endpoint.value === undefined) return Result.err(new FoundationError("subagent_not_found", "Child mailbox endpoint was not found"));
		this.sealedEndpoints.add(agentInstanceId);
		return Result.ok(undefined);
	}

	async acknowledge(inputValue: unknown): Promise<ResultValue<ChildMailboxMessage, FoundationError>> {
		if (
			!isRecord(inputValue) ||
			!exactKeys(inputValue, ACK_INPUT_KEYS) ||
			inputValue.schemaVersion !== 1 ||
			!isIdentifier(inputValue.messageId) ||
			!isIdentifier(inputValue.toAgentInstanceId) ||
			!isIdentifier(inputValue.byAttemptId)
		) {
			return Result.err(new FoundationError("subagent_mailbox_invalid", "Child mailbox acknowledgement is invalid"));
		}
		const input: AcknowledgeChildMailboxMessageInput = {
			schemaVersion: 1,
			messageId: inputValue.messageId,
			toAgentInstanceId: inputValue.toAgentInstanceId,
			byAttemptId: inputValue.byAttemptId,
		};
		return this.serial(async () => {
		try {
			const sentRecord = await this.ledger.get(SUBAGENT_MAILBOX_SENT_OBJECT_TYPE, input.messageId);
			if (sentRecord === undefined) {
				return Result.err(new FoundationError("subagent_not_found", "Child mailbox message was not found"));
			}
			const sentResult = this.validateStoredSentRecord(sentRecord);
			if (!sentResult.ok) return sentResult;
			if (sentResult.value === undefined) {
				return Result.err(new FoundationError("subagent_not_found", "Child mailbox message was not found"));
			}
			const sent = sentResult.value.payload;
			const endpointLookup = this.endpoint(input.toAgentInstanceId);
			if (!endpointLookup.ok) return endpointLookup;
			const endpoint = endpointLookup.value;
			if (
				endpoint === undefined ||
				endpoint.sessionId !== this.sessionId ||
				sent.toAgentInstanceId !== endpoint.agentInstanceId ||
				input.byAttemptId !== endpoint.attemptId
			) {
				return Result.err(new FoundationError("subagent_mailbox_invalid", "Only the addressed consuming Attempt may acknowledge a message"));
			}
			const existing = await this.readAck(sent.messageId);
			if (!existing.ok) return existing;
			if (existing.value !== undefined) {
				if (
					existing.value.toAgentInstanceId !== endpoint.agentInstanceId ||
					existing.value.byAttemptId !== endpoint.attemptId
				) {
					return Result.err(new FoundationError("subagent_conflict", "Child mailbox acknowledgement conflicts with the durable consumer"));
				}
				return Result.ok(publicMessage(sent, existing.value));
			}
			const ack: ChildMailboxAckPayload = {
				schemaVersion: 1,
				messageId: sent.messageId,
				fromAgentInstanceId: sent.fromAgentInstanceId,
				toAgentInstanceId: sent.toAgentInstanceId,
				at: this.now(),
				byAttemptId: endpoint.attemptId,
			};
			if (!validateAckPayload(ack)) {
				return Result.err(new FoundationError("subagent_mailbox_invalid", "Child mailbox acknowledgement event is invalid"));
			}
			const stored = await this.ledgerForLane(endpoint.laneId).appendFact(SUBAGENT_MAILBOX_ACK_OBJECT_TYPE, ack.messageId, ack, {
				clientRequestId: `subagent-mailbox-ack:${ack.messageId}`,
				expectedRevision: 0,
				correlation: {
					taskId: endpoint.taskId,
					attemptId: endpoint.attemptId,
					agentInstanceId: endpoint.agentInstanceId,
				},
			});
			const ackResult = this.validateStoredAckRecord(stored.record, new Map([[sent.messageId, sent]]));
			if (!ackResult.ok) return ackResult;
			if (ackResult.value === undefined) {
				return Result.err(new FoundationError("subagent_persistence_failed", "Persisted Child mailbox acknowledgement is outside mailbox ownership"));
			}
			return Result.ok(publicMessage(sent, ackResult.value));
		} catch {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child mailbox acknowledgement could not be persisted"));
		}
		});
	}

	async consume(inputValue: unknown): Promise<ResultValue<readonly ChildMailboxMessage[], FoundationError>> {
		if (
			!isRecord(inputValue) ||
			!exactKeys(inputValue, CONSUME_KEYS) ||
			inputValue.schemaVersion !== 1 ||
			inputValue.sessionId !== this.sessionId ||
			!isIdentifier(inputValue.toAgentInstanceId) ||
			!isIdentifier(inputValue.byAttemptId) ||
			!isPositiveInteger(inputValue.limit)
		) {
			return Result.err(new FoundationError("subagent_mailbox_invalid", "Child mailbox consume input is invalid"));
		}
		const records = await this.readSentRecords();
		if (!records.ok) return records;
		const acknowledgements = await this.readAckMap(records.value);
		if (!acknowledgements.ok) return acknowledgements;
		const pending = records.value
			.filter(
				(record) =>
					record.payload.toAgentInstanceId === inputValue.toAgentInstanceId &&
					!acknowledgements.value.has(record.payload.messageId),
			)
			.slice(0, inputValue.limit as number);
		const consumed: ChildMailboxMessage[] = [];
		for (const record of pending) {
			const ack = await this.acknowledge({
				schemaVersion: 1,
				messageId: record.payload.messageId,
				toAgentInstanceId: inputValue.toAgentInstanceId,
				byAttemptId: inputValue.byAttemptId,
			});
			if (!ack.ok) return ack;
			consumed.push(ack.value);
		}
		return Result.ok(Object.freeze(consumed));
	}

	async waitAny(inputValue: unknown): Promise<ResultValue<readonly ChildAgentRosterEntry[], FoundationError>> {
		const input = this.validateWaitInput(inputValue);
		if (!input.ok) return input;
		return this.waitFor(input.value, false);
	}

	async waitAll(inputValue: unknown): Promise<ResultValue<readonly ChildAgentRosterEntry[], FoundationError>> {
		const input = this.validateWaitInput(inputValue);
		if (!input.ok) return input;
		return this.waitFor(input.value, true);
	}

	async query(inputValue: unknown): Promise<ResultValue<ChildMailboxQuery, FoundationError>> {
		if (
			!isRecord(inputValue) ||
			!exactKeys(inputValue, QUERY_KEYS) ||
			inputValue.schemaVersion !== 1 ||
			inputValue.sessionId !== this.sessionId ||
			!isIdentifier(inputValue.childAgentInstanceId) ||
			!isNonNegativeInteger(inputValue.timeoutMs) ||
			(inputValue.timeoutMs as number) > this.maxWaitMs
		) {
			return Result.err(new FoundationError("subagent_mailbox_invalid", "Child mailbox query input is invalid"));
		}
		const deadline = this.clock() + (inputValue.timeoutMs as number);
		while (true) {
			const roster = this.readRoster();
			if (!roster.ok) return roster;
			const child = roster.value.find(
				(entry) =>
					entry.sessionId === this.sessionId &&
					entry.childAgentInstanceId === inputValue.childAgentInstanceId,
			);
			if (child !== undefined) {
				const sent = await this.readSentRecords();
				if (!sent.ok) return sent;
				const acknowledgements = await this.readAckMap(sent.value);
				if (!acknowledgements.ok) return acknowledgements;
				const addressed = sent.value.filter((record) => record.payload.toAgentInstanceId === child.childAgentInstanceId);
				const pending = addressed.filter((record) => !acknowledgements.value.has(record.payload.messageId)).length;
				return Result.ok(
					cloneDeepFrozen({
						schemaVersion: 1 as const,
						child,
						pendingMessages: pending,
						...(addressed.length === 0 ? {} : { lastMessageSequence: addressed.at(-1)!.sequence }),
					}),
				);
			}
			if (this.clock() >= deadline) {
				return Result.err(new FoundationError("subagent_wait_timeout", "Child mailbox query timed out"));
			}
			await this.waitDelay(Math.min(this.pollIntervalMs, Math.max(1, deadline - this.clock())));
		}
	}

	siblingRoster(inputValue: unknown): ResultValue<readonly ChildAgentRosterEntry[], FoundationError> {
		if (
			!isRecord(inputValue) ||
			!exactKeys(inputValue, new Set(["schemaVersion", "sessionId", "agentInstanceId"])) ||
			inputValue.schemaVersion !== 1 ||
			inputValue.sessionId !== this.sessionId ||
			!isIdentifier(inputValue.agentInstanceId)
		) {
			return Result.err(new FoundationError("subagent_mailbox_invalid", "Sibling roster query is invalid"));
		}
		const rosterResult = this.readRoster();
		if (!rosterResult.ok) return rosterResult;
		const roster = rosterResult.value.filter((entry) => entry.sessionId === this.sessionId);
		const requester = roster.find((entry) => entry.childAgentInstanceId === inputValue.agentInstanceId);
		if (requester === undefined) return Result.err(new FoundationError("subagent_not_found", "Child Agent was not found"));
		return Result.ok(
			Object.freeze(
				roster
					.filter(
						(entry) =>
							entry.parentAgentInstanceId === requester.parentAgentInstanceId &&
							entry.childAgentInstanceId !== requester.childAgentInstanceId,
					)
					.sort((left, right) => left.childAgentInstanceId.localeCompare(right.childAgentInstanceId))
					.map((entry) => cloneDeepFrozen(entry)),
			),
		);
	}

	private endpoint(agentInstanceId: string): ResultValue<ChildMailboxEndpoint | undefined, FoundationError> {
		const explicit = this.endpoints.get(agentInstanceId);
		if (explicit !== undefined) return Result.ok(explicit);
		const roster = this.readRoster();
		if (!roster.ok) return roster;
		const child = roster.value.find((entry) => entry.childAgentInstanceId === agentInstanceId);
		return Result.ok(
			child === undefined
				? undefined
				: {
					schemaVersion: 1,
					sessionId: child.sessionId,
					laneId: child.laneId,
					agentInstanceId: child.childAgentInstanceId,
					taskId: child.taskId,
					attemptId: child.attemptId,
				},
		);
	}

	private readRoster(): ResultValue<readonly ChildAgentRosterEntry[], FoundationError> {
		let roster: readonly ChildAgentRosterEntry[];
		try {
			roster = this.rosterSource();
		} catch {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent roster could not be read"));
		}
		if (
			!Array.isArray(roster) ||
			!roster.every(validateRosterEntry) ||
			roster.some((entry) => entry.sessionId !== this.sessionId) ||
			new Set(roster.map((entry) => entry.childAgentInstanceId)).size !== roster.length ||
			new Set(roster.map((entry) => entry.mailboxAddress)).size !== roster.length ||
			[...this.endpoints.values()].some((endpoint) =>
				roster.some(
					(entry) =>
						entry.childAgentInstanceId === endpoint.agentInstanceId &&
						(entry.laneId !== endpoint.laneId || entry.taskId !== endpoint.taskId || entry.attemptId !== endpoint.attemptId),
				),
			)
		) {
			return Result.err(new FoundationError("subagent_persistence_failed", "Child Agent roster is invalid or ambiguous"));
		}
		return Result.ok(Object.freeze(roster.map((entry) => cloneDeepFrozen(entry))));
	}

	private validateWaitInput(value: unknown): ResultValue<WaitForChildrenInput, FoundationError> {
		if (
			!isRecord(value) ||
			!exactKeys(value, WAIT_KEYS) ||
			value.schemaVersion !== 1 ||
			value.sessionId !== this.sessionId ||
			!Array.isArray(value.childAgentInstanceIds) ||
			value.childAgentInstanceIds.length === 0 ||
			!value.childAgentInstanceIds.every(isIdentifier) ||
			new Set(value.childAgentInstanceIds).size !== value.childAgentInstanceIds.length ||
			!isNonNegativeInteger(value.timeoutMs) ||
			value.timeoutMs > this.maxWaitMs
		) {
			return Result.err(new FoundationError("subagent_mailbox_invalid", "Child wait input is invalid"));
		}
		return Result.ok(value as unknown as WaitForChildrenInput);
	}

	private async waitFor(
		input: WaitForChildrenInput,
		all: boolean,
	): Promise<ResultValue<readonly ChildAgentRosterEntry[], FoundationError>> {
		const deadline = this.clock() + input.timeoutMs;
		while (true) {
			const rosterResult = this.readRoster();
			if (!rosterResult.ok) return rosterResult;
			const roster = rosterResult.value.filter(
				(entry) =>
					entry.sessionId === this.sessionId && input.childAgentInstanceIds.includes(entry.childAgentInstanceId),
			);
			const sent = await this.readSentRecords();
			if (!sent.ok) return sent;
			const completed = roster.filter(
				(entry) =>
					TERMINAL_STATUSES.has(entry.status) ||
					sent.value.some(
						(record) => record.payload.kind === "result_ref" && record.payload.fromAgentInstanceId === entry.childAgentInstanceId,
					),
			);
			if ((!all && completed.length > 0) || (all && completed.length === input.childAgentInstanceIds.length)) {
				return Result.ok(
					Object.freeze(
						completed
							.sort((left, right) =>
								input.childAgentInstanceIds.indexOf(left.childAgentInstanceId) -
								input.childAgentInstanceIds.indexOf(right.childAgentInstanceId),
							)
							.map((entry) => cloneDeepFrozen(entry)),
					),
				);
			}
			if (this.clock() >= deadline) {
				return Result.err(new FoundationError("subagent_wait_timeout", "Child wait timed out without cancelling execution"));
			}
			await this.waitDelay(Math.min(this.pollIntervalMs, Math.max(1, deadline - this.clock())));
		}
	}

	private ownedEndpoints(): ResultValue<ReadonlyMap<string, ChildMailboxEndpoint>, FoundationError> {
		const roster = this.readRoster();
		if (!roster.ok) return roster;
		const result = new Map<string, ChildMailboxEndpoint>();
		for (const endpoint of this.endpoints.values()) result.set(endpoint.agentInstanceId, endpoint);
		for (const child of roster.value) {
			result.set(child.childAgentInstanceId, {
				schemaVersion: 1,
				sessionId: child.sessionId,
				laneId: child.laneId,
				agentInstanceId: child.childAgentInstanceId,
				taskId: child.taskId,
				attemptId: child.attemptId,
			});
		}
		return Result.ok(result);
	}

	private validateStoredSentRecord(
		record: FoundationRecord,
	): ResultValue<
		| { readonly payload: ChildMailboxSentPayload; readonly sequence: number; readonly timestamp: number }
		| undefined,
		FoundationError
	> {
		const endpoints = this.ownedEndpoints();
		if (!endpoints.ok) return endpoints;
		const rawPayload = record.kind === "fact" && isRecord(record.payload) ? record.payload : undefined;
		const rawFromId = rawPayload === undefined || !isIdentifier(rawPayload.fromAgentInstanceId)
			? undefined
			: rawPayload.fromAgentInstanceId;
		const rawToId = rawPayload === undefined || !isIdentifier(rawPayload.toAgentInstanceId)
			? undefined
			: rawPayload.toAgentInstanceId;
		const from = rawFromId === undefined ? undefined : endpoints.value.get(rawFromId);
		const to = rawToId === undefined ? undefined : endpoints.value.get(rawToId);
		const payloadTouchesOwned = from !== undefined || to !== undefined;
		const metadataTouchesOwned = [...endpoints.value.values()].some(
			(endpoint) =>
				record.correlation.agentInstanceId === endpoint.agentInstanceId ||
				record.correlation.laneId === endpoint.laneId ||
				(record.correlation.taskId === endpoint.taskId && record.correlation.attemptId === endpoint.attemptId),
		);
		if (!payloadTouchesOwned && !metadataTouchesOwned) return Result.ok(undefined);
		if (
			record.kind !== "fact" ||
			rawPayload === undefined ||
			rawFromId === undefined ||
			rawToId === undefined ||
			!validateSentPayload(rawPayload)
		) {
			return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child mailbox message is invalid"));
		}
		if (
			from === undefined ||
			to === undefined ||
			record.objectType !== SUBAGENT_MAILBOX_SENT_OBJECT_TYPE ||
			record.objectId !== rawPayload.messageId ||
			record.revision !== 1 ||
			record.lane !== to.laneId ||
			record.correlation.sessionId !== this.sessionId ||
			record.correlation.laneId !== to.laneId ||
			record.correlation.taskId !== to.taskId ||
			record.correlation.attemptId !== to.attemptId ||
			record.correlation.agentInstanceId !== to.agentInstanceId ||
			rawPayload.correlation.sessionId !== this.sessionId ||
			rawPayload.correlation.laneId !== to.laneId ||
			rawPayload.correlation.taskId !== to.taskId ||
			rawPayload.correlation.attemptId !== to.attemptId ||
			rawPayload.correlation.agentInstanceId !== to.agentInstanceId
		) {
			return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child mailbox message is invalid"));
		}
		return Result.ok({ payload: rawPayload, sequence: record.seq, timestamp: record.timestamp });
	}

	private validateStoredAckRecord(
		record: FoundationRecord,
		sentById: ReadonlyMap<string, ChildMailboxSentPayload>,
	): ResultValue<ChildMailboxAckPayload | undefined, FoundationError> {
		const endpoints = this.ownedEndpoints();
		if (!endpoints.ok) return endpoints;
		const rawPayload = record.kind === "fact" && isRecord(record.payload) ? record.payload : undefined;
		const rawFromId = rawPayload === undefined || !isIdentifier(rawPayload.fromAgentInstanceId)
			? undefined
			: rawPayload.fromAgentInstanceId;
		const rawToId = rawPayload === undefined || !isIdentifier(rawPayload.toAgentInstanceId)
			? undefined
			: rawPayload.toAgentInstanceId;
		const from = rawFromId === undefined ? undefined : endpoints.value.get(rawFromId);
		const to = rawToId === undefined ? undefined : endpoints.value.get(rawToId);
		const payloadTouchesOwned = from !== undefined || to !== undefined;
		const metadataTouchesOwned = [...endpoints.value.values()].some(
			(endpoint) =>
				record.correlation.agentInstanceId === endpoint.agentInstanceId ||
				record.correlation.laneId === endpoint.laneId ||
				(record.correlation.taskId === endpoint.taskId && record.correlation.attemptId === endpoint.attemptId),
		);
		if (!payloadTouchesOwned && !metadataTouchesOwned) return Result.ok(undefined);
		if (
			record.kind !== "fact" ||
			rawPayload === undefined ||
			rawFromId === undefined ||
			rawToId === undefined ||
			!validateAckPayload(rawPayload)
		) {
			return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child mailbox acknowledgement is invalid"));
		}
		const sent = sentById.get(rawPayload.messageId);
		if (
			from === undefined ||
			to === undefined ||
			sent === undefined ||
			record.objectType !== SUBAGENT_MAILBOX_ACK_OBJECT_TYPE ||
			record.objectId !== rawPayload.messageId ||
			record.revision !== 1 ||
			record.lane !== to.laneId ||
			record.correlation.sessionId !== this.sessionId ||
			record.correlation.laneId !== to.laneId ||
			record.correlation.agentInstanceId !== to.agentInstanceId ||
			record.correlation.attemptId !== to.attemptId ||
			record.correlation.taskId !== to.taskId ||
			rawPayload.fromAgentInstanceId !== sent.fromAgentInstanceId ||
			rawPayload.toAgentInstanceId !== sent.toAgentInstanceId ||
			rawPayload.byAttemptId !== to.attemptId
		) {
			return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child mailbox acknowledgement is invalid"));
		}
		return Result.ok(rawPayload);
	}

	private async readSentRecords(): Promise<
		ResultValue<readonly { readonly payload: ChildMailboxSentPayload; readonly sequence: number; readonly timestamp: number }[], FoundationError>
	> {
		try {
			const records = await this.ledger.find({
				kind: "fact",
				objectType: SUBAGENT_MAILBOX_SENT_OBJECT_TYPE,
				order: "oldestFirst",
			});
			const result: { payload: ChildMailboxSentPayload; sequence: number; timestamp: number }[] = [];
			for (const record of records) {
				if (record.kind !== "fact") {
					return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child mailbox message is invalid"));
				}
				const checked = this.validateStoredSentRecord(record);
				if (!checked.ok) return checked;
				if (checked.value !== undefined) result.push(checked.value);
			}
			return Result.ok(Object.freeze(result));
		} catch {
			return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child mailbox messages could not be read"));
		}
	}

	private async readAckMap(
		sentRecords?: readonly { readonly payload: ChildMailboxSentPayload; readonly sequence: number; readonly timestamp: number }[],
	): Promise<ResultValue<ReadonlyMap<string, ChildMailboxAckPayload>, FoundationError>> {
		try {
			const sent = sentRecords === undefined ? await this.readSentRecords() : Result.ok(sentRecords);
			if (!sent.ok) return sent;
			const sentById = new Map(sent.value.map((record) => [record.payload.messageId, record.payload]));
			const records = await this.ledger.find({
				kind: "fact",
				objectType: SUBAGENT_MAILBOX_ACK_OBJECT_TYPE,
				order: "oldestFirst",
			});
			const result = new Map<string, ChildMailboxAckPayload>();
			for (const record of records) {
				if (record.kind !== "fact") {
					return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child mailbox acknowledgement is invalid"));
				}
				const checked = this.validateStoredAckRecord(record, sentById);
				if (!checked.ok) return checked;
				if (checked.value === undefined) continue;
				if (result.has(checked.value.messageId)) {
					return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child mailbox acknowledgement is duplicated"));
				}
				result.set(checked.value.messageId, checked.value);
			}
			return Result.ok(result);
		} catch {
			return Result.err(new FoundationError("subagent_persistence_failed", "Durable Child mailbox acknowledgements could not be read"));
		}
	}

	private async readAck(messageId: string): Promise<ResultValue<ChildMailboxAckPayload | undefined, FoundationError>> {
		const map = await this.readAckMap();
		return map.ok ? Result.ok(map.value.get(messageId)) : map;
	}

	private serial<T>(operation: () => Promise<ResultValue<T, FoundationError>>): Promise<ResultValue<T, FoundationError>> {
		const result = this.mutationTail.then(operation, operation);
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

}

/** Exact event correlation projection used by observers and tests. */
export function childMailboxEventCorrelation(message: ChildMailboxMessage): EventCorrelationRef {
	return cloneDeepFrozen({ ...message.correlation });
}
