import { Type } from "typebox";
import {
	canonicalFoundationJson,
	FoundationError,
	sha256HexValue,
	validateAsk,
	validateExactShape,
	type Ask,
	type AskReply,
	type AskStatus,
	type FoundationErrorCode,
	type FoundationJsonValue,
	type FoundationRecord,
	type Session,
	type SessionLedgerWriter,
	type SessionLedgerWriterOptions,
} from "@aos-agent/agent-core";
import {
	asFoundationStoreError,
	cloneStoreValue,
	createStoreWriter,
	expectedRevision,
	jsonValue,
	mutationId,
	readCommandResult,
	recordsForObject,
	storeId,
	storeText,
	validateTimestamp,
	writeCommandIntent,
	writeCommandResult,
	writeFact,
} from "./durable-store.ts";

const ASK_OBJECT_TYPE = "foundation.ask";
const REPLY_OBJECT_TYPE = "foundation.ask.reply";
const EVENT_OBJECT_TYPE = "foundation.ask.event";
const COMMAND_OBJECT_TYPE = "foundation.ask.command";

export interface AskCreateInput {
	readonly sessionId: string;
	readonly askId?: string;
	readonly question: string;
	readonly goalId?: string;
	readonly taskId?: string;
	readonly options?: readonly string[];
	readonly dueAt?: string;
	readonly escalationAt?: string;
	readonly escalationTarget?: string;
}

export interface AskReplyInput {
	readonly replyId?: string;
	readonly value: FoundationJsonValue;
	readonly by: string;
}

export interface AskTimedMutationInput {
	readonly at: string;
}

export interface AskMutationOptions {
	readonly clientRequestId: string;
	readonly expectedRevision: number;
}

export interface AskStoreOptions extends SessionLedgerWriterOptions {
	readonly writer?: SessionLedgerWriter;
}
export type AskEventType = "ask.created" | "ask.answered" | "ask.expired" | "ask.escalated" | "ask.cancelled";

export interface AskEvent {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly type: AskEventType;
	readonly askId: string;
	readonly revision: number;
	readonly timestamp: string;
	readonly clientRequestId: string;
	readonly commandPayload: string;
}

export const AskEventSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		eventId: Type.String({ minLength: 1 }),
	type: Type.Union([Type.Literal("ask.created"), Type.Literal("ask.answered"), Type.Literal("ask.expired"), Type.Literal("ask.escalated"), Type.Literal("ask.cancelled")]),
		askId: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 0 }),
		timestamp: Type.String({ minLength: 1 }),
		clientRequestId: Type.String({ minLength: 1 }),
		commandPayload: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

interface AskCommand {
	readonly request: AskMutationOptions;
	readonly command: string;
	readonly payload: string;
	readonly objectId: string;
	readonly timestamp: string;
}

function fail(code: FoundationErrorCode, message: string): never {
	throw new FoundationError(code, message);
}

function mutation(options: AskMutationOptions): AskMutationOptions {
	mutationId(options.clientRequestId);
	expectedRevision(options.expectedRevision);
	return options;
}

function derivedId(prefix: string, requestId: string): string {
	return `${prefix}_${sha256HexValue(requestId).slice(0, 32)}`;
}

function commandPayload(command: string, value: Record<string, unknown>): string {
	try {
		return canonicalFoundationJson({ command, ...value });
	} catch (error) {
		throw asFoundationStoreError(error);
	}
}

function clone<TValue>(value: TValue): TValue {
	return cloneStoreValue(value);
}

function assertAsk(value: unknown): Ask {
	const result = validateAsk(value);
	if (!result.ok) throw result.error;
	const ask = result.value;
	validateTimestamp(ask.createdAt, "ask createdAt");
	validateTimestamp(ask.updatedAt, "ask updatedAt");
	if (ask.dueAt !== undefined) validateTimestamp(ask.dueAt, "ask dueAt");
	if (ask.escalationAt !== undefined) validateTimestamp(ask.escalationAt, "ask escalationAt");
	if (ask.settledAt !== undefined) validateTimestamp(ask.settledAt, "ask settledAt");
	if (ask.reply !== undefined) {
		validateTimestamp(ask.reply.createdAt, "reply createdAt");
		if (ask.reply.askId !== ask.askId) fail("foundation_schema_invalid_shape", "Ask reply references another Ask");
	}
	if (ask.tombstone !== undefined) validateTimestamp(ask.tombstone.cancelledAt, "Ask cancelledAt");
	if (
		ask.status === "pending" &&
		(ask.reply !== undefined || ask.settledAt !== undefined || ask.tombstone !== undefined)
	)
		fail("foundation_schema_invalid_shape", "Pending Ask has terminal state");
	if (ask.status === "answered" && (ask.reply === undefined || ask.settledAt === undefined))
		fail("foundation_schema_invalid_shape", "Answered Ask has no Reply");
	if (ask.status === "cancelled" && ask.tombstone === undefined)
		fail("foundation_schema_invalid_shape", "Cancelled Ask has no tombstone");
	if ((ask.status === "expired" || ask.status === "escalated") && ask.settledAt === undefined)
		fail("foundation_schema_invalid_shape", "Settled Ask has no timestamp");
	if (ask.status !== "answered" && ask.reply !== undefined)
		fail("foundation_schema_invalid_shape", "Only answered Ask may contain a Reply");
	return ask;
}

function assertAskEvent(value: unknown): AskEvent {
	const result = validateExactShape<AskEvent>(AskEventSchema, value, "ask_event");
	if (!result.ok) throw result.error;
	validateTimestamp(result.value.timestamp, "ask event timestamp");
	return result.value;
}

function latestRecords(records: readonly FoundationRecord[]): Map<string, FoundationRecord> {
	const latest = new Map<string, FoundationRecord>();
	for (const record of records) if (record.kind !== "retention") latest.set(record.objectId, record);
	return latest;
}

export class AskStore {
	readonly session: Session;
	readonly writer: ReturnType<typeof createStoreWriter>;

	constructor(session: Session, options: AskStoreOptions = {}) {
		this.session = session;
		this.writer = createStoreWriter(session, options);
	}

	async create(input: AskCreateInput, options: AskMutationOptions): Promise<Ask> {
		return this.safe("ask_conflict", async () => {
			const request = mutation(options);
			if (request.expectedRevision !== 0) fail("ask_conflict", "Ask creation expectedRevision must be zero");
			const sessionId = storeId(input.sessionId, "sessionId");
			if ((await this.session.getMetadata()).id !== sessionId)
				fail("session_ledger_conflict", "Ask sessionId does not match the supplied Session");
			const askId =
				input.askId === undefined ? derivedId("ask", request.clientRequestId) : storeId(input.askId, "askId");
			const question = storeText(input.question, "question");
			const goalId = input.goalId === undefined ? undefined : storeId(input.goalId, "goalId");
			const taskId = input.taskId === undefined ? undefined : storeId(input.taskId, "taskId");
			const askOptions = input.options?.map((value) => storeText(value, "ask option"));
			const dueAt = input.dueAt === undefined ? undefined : validateTimestamp(input.dueAt, "dueAt");
			const escalationAt =
				input.escalationAt === undefined ? undefined : validateTimestamp(input.escalationAt, "escalationAt");
			const escalationTarget =
				input.escalationTarget === undefined ? undefined : storeId(input.escalationTarget, "escalationTarget");
			if ((escalationAt === undefined) !== (escalationTarget === undefined))
				fail("foundation_schema_invalid_shape", "Ask escalationAt and escalationTarget must be supplied together");
			const normalized = {
				sessionId,
				askId,
				question,
				...(goalId === undefined ? {} : { goalId }),
				...(taskId === undefined ? {} : { taskId }),
				...(askOptions === undefined ? {} : { options: askOptions }),
				...(dueAt === undefined ? {} : { dueAt }),
				...(escalationAt === undefined ? {} : { escalationAt, escalationTarget }),
			};
			const command = await this.begin(
				request,
				"ask.create",
				commandPayload("ask.create", { input: normalized, expectedRevision: request.expectedRevision }),
			);
			const replay = await this.resume(command, "ask.created");
			if (replay !== undefined) return replay;
			const ask: Ask = {
				schemaVersion: 1,
				...normalized,
				status: "pending",
				revision: 1,
				createdAt: command.timestamp,
				updatedAt: command.timestamp,
			};
			return this.commit(command, ask, "ask.created");
		});
	}

	async get(askId: string): Promise<Ask> {
		return this.safe("ask_not_found", async () => this.load(storeId(askId, "askId")));
	}

	async list(sessionId?: string): Promise<Ask[]> {
		return this.safe("ask_conflict", async () => {
			const normalized = sessionId === undefined ? undefined : storeId(sessionId, "sessionId");
			const records = await this.session.findFoundationRecords({
				objectType: ASK_OBJECT_TYPE,
				kind: "fact",
				order: "oldestFirst",
				includePruned: true,
			});
			return [...latestRecords(records).values()]
				.filter((record): record is Extract<FoundationRecord, { kind: "fact" }> => record.kind === "fact")
				.map((record) => assertAsk(record.payload))
				.filter((ask) => normalized === undefined || ask.sessionId === normalized)
				.sort(
					(left, right) => left.createdAt.localeCompare(right.createdAt) || left.askId.localeCompare(right.askId),
				)
				.map(clone);
		});
	}

	async reply(askId: string, input: AskReplyInput, options: AskMutationOptions): Promise<Ask> {
		return this.safe("ask_conflict", async () => {
			const request = mutation(options);
			const normalizedAskId = storeId(askId, "askId");
			const replyId =
				input.replyId === undefined
					? derivedId("reply", request.clientRequestId)
					: storeId(input.replyId, "replyId");
			const by = storeId(input.by, "reply by");
			const value = jsonValue(input.value, "reply value");
			const command = await this.begin(
				request,
				"ask.reply",
				commandPayload("ask.reply", {
					askId: normalizedAskId,
					input: { replyId, by, value },
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resume(command, "ask.answered");
			if (replay !== undefined) return replay;
			const ask = await this.load(normalizedAskId);
			this.assertPending(ask, request.expectedRevision);
			const reply: AskReply = {
				schemaVersion: 1,
				replyId,
				askId: normalizedAskId,
				value,
				by,
				createdAt: command.timestamp,
				clientRequestId: request.clientRequestId,
			};
			return this.commit(
				command,
				{
					...ask,
					status: "answered",
					revision: ask.revision + 1,
					reply,
					settledAt: command.timestamp,
					updatedAt: command.timestamp,
				},
				"ask.answered",
			);
		});
	}

	async expire(askId: string, input: AskTimedMutationInput, options: AskMutationOptions): Promise<Ask> {
		return this.timedTransition(askId, input, options, "expired", "ask.expired", "dueAt", "ask_timeout_not_reached");
	}

	async escalate(askId: string, input: AskTimedMutationInput, options: AskMutationOptions): Promise<Ask> {
		return this.timedTransition(
			askId,
			input,
			options,
			"escalated",
			"ask.escalated",
			"escalationAt",
			"ask_escalation_not_reached",
		);
	}

	async cancel(askId: string, reason: string | undefined, options: AskMutationOptions): Promise<Ask> {
		return this.safe("ask_conflict", async () => {
			const request = mutation(options);
			const normalizedAskId = storeId(askId, "askId");
			const normalizedReason = reason === undefined ? undefined : storeText(reason, "cancel reason");
			const command = await this.begin(
				request,
				"ask.cancel",
				commandPayload("ask.cancel", {
					askId: normalizedAskId,
					...(normalizedReason === undefined ? {} : { reason: normalizedReason }),
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resume(command, "ask.cancelled");
			if (replay !== undefined) return replay;
			const ask = await this.load(normalizedAskId);
			this.assertPending(ask, request.expectedRevision);
			return this.commit(
				command,
				{
					...ask,
					status: "cancelled",
					revision: ask.revision + 1,
					settledAt: command.timestamp,
					updatedAt: command.timestamp,
					tombstone: {
						schemaVersion: 1,
						cancelledAt: command.timestamp,
						...(normalizedReason === undefined ? {} : { reason: normalizedReason }),
					},
				},
				"ask.cancelled",
			);
		});
	}

	async eventsFor(askId: string): Promise<AskEvent[]> {
		return this.safe("ask_not_found", async () => {
			const normalizedAskId = storeId(askId, "askId");
			await this.load(normalizedAskId);
			const records = await this.session.findFoundationRecords({
				objectType: EVENT_OBJECT_TYPE,
				kind: "fact",
				order: "oldestFirst",
				includePruned: true,
			});
			return records
				.filter((record): record is Extract<FoundationRecord, { kind: "fact" }> => record.kind === "fact")
				.map((record) => assertAskEvent(record.payload))
				.filter((event) => event.askId === normalizedAskId)
				.map(clone);
		});
	}

	private async timedTransition(
		askId: string,
		input: AskTimedMutationInput,
		options: AskMutationOptions,
		status: Extract<AskStatus, "expired" | "escalated">,
		eventType: Extract<AskEventType, "ask.expired" | "ask.escalated">,
		thresholdField: "dueAt" | "escalationAt",
		earlyCode: Extract<FoundationErrorCode, "ask_timeout_not_reached" | "ask_escalation_not_reached">,
	): Promise<Ask> {
		return this.safe("ask_conflict", async () => {
			const request = mutation(options);
			const normalizedAskId = storeId(askId, "askId");
			const at = validateTimestamp(input.at, "Ask transition time");
			const command = await this.begin(
				request,
				eventType,
				commandPayload(eventType, { askId: normalizedAskId, at, expectedRevision: request.expectedRevision }),
			);
			const replay = await this.resume(command, eventType);
			if (replay !== undefined) return replay;
			const ask = await this.load(normalizedAskId);
			this.assertPending(ask, request.expectedRevision);
			const threshold = ask[thresholdField];
			if (threshold === undefined) fail("ask_invalid_transition", `Ask has no ${thresholdField}`);
			if (Date.parse(at) < Date.parse(threshold)) fail(earlyCode, `Ask ${thresholdField} has not been reached`);
			return this.commit(
				command,
				{ ...ask, status, revision: ask.revision + 1, settledAt: at, updatedAt: at },
				eventType,
			);
		});
	}

	private async begin(request: AskMutationOptions, command: string, payload: string): Promise<AskCommand> {
		const objectId = derivedId("ask_command", request.clientRequestId);
		const intent = await writeCommandIntent(
			this.writer,
			COMMAND_OBJECT_TYPE,
			objectId,
			request.clientRequestId,
			command,
			payload,
		);
		return { request, command, payload, objectId, timestamp: new Date(intent.timestamp).toISOString() };
	}

	private aggregateRequestId(request: AskMutationOptions): string {
		return derivedId("ask_aggregate", request.clientRequestId);
	}

	private async resume(command: AskCommand, eventType: AskEventType): Promise<Ask | undefined> {
		const stored = await readCommandResult<Ask>(
			this.writer,
			COMMAND_OBJECT_TYPE,
			command.objectId,
			command.request.clientRequestId,
			command.command,
			command.payload,
		);
		if (stored !== undefined) return assertAsk(stored);
		const records = await this.session.findFoundationRecords({
			objectType: ASK_OBJECT_TYPE,
			kind: "fact",
			order: "oldestFirst",
			includePruned: true,
		});
		const aggregateRequestId = this.aggregateRequestId(command.request);
		const matched = [...records]
			.reverse()
			.find(
				(record): record is Extract<FoundationRecord, { kind: "fact" }> =>
					record.kind === "fact" && record.clientRequestId === aggregateRequestId,
			);
		if (matched === undefined) return undefined;
		const ask = assertAsk(matched.payload);
		await this.writeEvent(command, ask, eventType);
		await this.repairReply(ask, command.request.clientRequestId);
		return this.finish(command, ask);
	}

	private async commit(command: AskCommand, ask: Ask, eventType: AskEventType): Promise<Ask> {
		const accepted = await writeFact(
			this.writer,
			ASK_OBJECT_TYPE,
			ask.askId,
			jsonValue(ask, "ask"),
			this.aggregateRequestId(command.request),
			command.request.expectedRevision,
		);
		const value = assertAsk(accepted.value);
		await this.writeEvent(command, value, eventType);
		await this.repairReply(value, command.request.clientRequestId);
		return this.finish(command, value);
	}

	private async finish(command: AskCommand, ask: Ask): Promise<Ask> {
		return assertAsk(
			await writeCommandResult(
				this.writer,
				COMMAND_OBJECT_TYPE,
				command.objectId,
				command.request.clientRequestId,
				command.command,
				command.payload,
				ask,
			),
		);
	}

	private async writeEvent(command: AskCommand, ask: Ask, type: AskEventType): Promise<void> {
		const event: AskEvent = {
			schemaVersion: 1,
			eventId: derivedId("ask_event", command.request.clientRequestId),
			type,
			askId: ask.askId,
			revision: ask.revision,
			timestamp: ask.updatedAt,
			clientRequestId: command.request.clientRequestId,
			commandPayload: command.payload,
		};
		await writeFact(
			this.writer,
			EVENT_OBJECT_TYPE,
			`${ask.askId}:${ask.revision}`,
			jsonValue(event, "ask event"),
			derivedId("ask_event_request", command.request.clientRequestId),
			0,
		);
	}

	private async repairReply(ask: Ask, requestId: string): Promise<void> {
		if (ask.reply === undefined) return;
		const records = await recordsForObject(this.writer, REPLY_OBJECT_TYPE, ask.reply.replyId);
		const latest = records.at(-1);
		if (latest?.kind === "fact" && canonicalFoundationJson(latest.payload) === canonicalFoundationJson(ask.reply))
			return;
		if (latest !== undefined) fail("ask_conflict", "Reply id is already occupied");
		await writeFact(
			this.writer,
			REPLY_OBJECT_TYPE,
			ask.reply.replyId,
			jsonValue(ask.reply, "ask reply"),
			derivedId("ask_reply", requestId),
			0,
		);
	}

	private async load(askId: string): Promise<Ask> {
		const records = await recordsForObject(this.writer, ASK_OBJECT_TYPE, askId);
		const latest = records.at(-1);
		if (latest === undefined) fail("ask_not_found", "Ask was not found");
		if (latest.kind !== "fact") fail("foundation_schema_invalid_shape", "Ask ledger contains an unsupported record");
		return clone(assertAsk(latest.payload));
	}

	private assertPending(ask: Ask, revision: number): void {
		if (ask.revision !== revision) fail("session_writer_stale_revision", "Ask revision is stale");
		if (ask.status !== "pending") fail("ask_invalid_transition", "Ask is already settled");
	}

	private async safe<TValue>(fallbackCode: FoundationErrorCode, operation: () => Promise<TValue>): Promise<TValue> {
		try {
			return await operation();
		} catch (error) {
			throw asFoundationStoreError(error, fallbackCode);
		}
	}
}

export function createAskStore(session: Session, options?: AskStoreOptions): AskStore {
	return new AskStore(session, options);
}
