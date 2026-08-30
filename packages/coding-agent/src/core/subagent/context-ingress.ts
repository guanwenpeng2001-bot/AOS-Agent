import {
	canonicalFoundationJson,
	cloneDeepFrozen,
	fingerprintFoundationValue,
	FoundationError,
	Result,
	type ArtifactStoreProvider,
	type AttemptReceipt,
	type Fingerprint,
	type ResultValue,
	type SessionLedger,
	validateAttemptReceipt,
	validateTaskResult,
} from "@aos-agent/agent-core";
import type {
	ChildMailboxMessage,
	ConsumeChildMailboxInput,
	SubagentMailbox,
} from "./mailbox.ts";
import {
	projectSafeChildResult,
	type SafeChildResultProjection,
	validateSafeChildResultProjection,
} from "./result.ts";

export const SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES = 8_192;
export const SUBAGENT_CONTEXT_TEXT_MAX_BYTES = 4_096;
export const SUBAGENT_CONTEXT_ITEM_MAX_BYTES = 512;
export const SUBAGENT_CONTEXT_MAX_ITEMS = 16;
export const SUBAGENT_CONTEXT_CONSUME_MAX_ITEMS = 32;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STRUCTURED_BODY_KEYS = new Set(["schemaVersion", "text", "items"]);
const RESULT_REF_BODY_KEYS = new Set(["schemaVersion", "objectType", "objectId", "digest"]);
const MESSAGE_KEYS = new Set([
	"schemaVersion",
	"messageId",
	"fromAgentInstanceId",
	"toAgentInstanceId",
	"kind",
	"body",
	"correlation",
	"createdAt",
	"ack",
]);
const CORRELATION_KEYS = new Set(["sessionId", "laneId", "taskId", "attemptId", "agentInstanceId"]);
const ACK_KEYS = new Set(["at", "byAttemptId"]);
const DIGEST_KEYS = new Set(["algorithm", "value"]);
const SAFE_MAILBOX_KEYS = new Set([
	"schemaVersion",
	"source",
	"messageId",
	"childAgentInstanceId",
	"kind",
	"safeText",
	"trust",
	"digest",
	"producedAt",
]);

export interface SafeChildMailboxContext {
	readonly schemaVersion: 1;
	readonly source: "subagent_mailbox";
	readonly messageId: string;
	readonly childAgentInstanceId: string;
	readonly kind: "input" | "query" | "notice";
	readonly safeText: string;
	readonly trust: "untrusted_child_output";
	readonly digest: Fingerprint;
	readonly producedAt: string;
}

export type SafeSubagentNextTurnContext = SafeChildMailboxContext | SafeChildResultProjection;

export interface SubagentContextIngressOptions {
	readonly schemaVersion: 1;
	readonly mailbox: Pick<SubagentMailbox, "consume">;
	readonly ledger: SessionLedger;
	readonly artifactStore: ArtifactStoreProvider;
	readonly sessionId: string;
	readonly parentLaneId: string;
}

function untrusted(message: string): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError("subagent_result_untrusted", message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function canonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function canonicalText(value: string): string {
	return value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function fingerprintMatches(left: Fingerprint, right: Fingerprint): boolean {
	return left.algorithm === right.algorithm && left.value === right.value;
}

function validateMessageEnvelope(message: unknown): message is ChildMailboxMessage {
	if (!isRecord(message) || !exactKeys(message, MESSAGE_KEYS)) return false;
	return message.schemaVersion === 1 &&
		typeof message.messageId === "string" && IDENTIFIER_PATTERN.test(message.messageId) &&
		typeof message.fromAgentInstanceId === "string" && IDENTIFIER_PATTERN.test(message.fromAgentInstanceId) &&
		typeof message.toAgentInstanceId === "string" && IDENTIFIER_PATTERN.test(message.toAgentInstanceId) &&
		["input", "query", "notice", "result_ref"].includes(message.kind as string) &&
		isRecord(message.correlation) && exactKeys(message.correlation, CORRELATION_KEYS) &&
		Object.values(message.correlation).every((value) => typeof value === "string" && IDENTIFIER_PATTERN.test(value)) &&
		canonicalTimestamp(message.createdAt) &&
		isRecord(message.ack) && exactKeys(message.ack, ACK_KEYS) &&
		canonicalTimestamp(message.ack.at) &&
		typeof message.ack.byAttemptId === "string" && IDENTIFIER_PATTERN.test(message.ack.byAttemptId);
}

export function sanitizeChildMailboxContext(
	messageValue: unknown,
): ResultValue<SafeChildMailboxContext, FoundationError> {
	if (!validateMessageEnvelope(messageValue) || messageValue.kind === "result_ref") {
		return untrusted("Child mailbox Context input has an invalid exact shape");
	}
	const body = messageValue.body;
	if (
		!isRecord(body) ||
		!exactKeys(body, STRUCTURED_BODY_KEYS) ||
		body.schemaVersion !== 1 ||
		typeof body.text !== "string" ||
		!Array.isArray(body.items) ||
		!body.items.every((item) => typeof item === "string")
	) {
		return untrusted("Child mailbox structured body has an invalid exact shape");
	}
	const sourceItems = body.items;
	if (sourceItems.length > SUBAGENT_CONTEXT_MAX_ITEMS) {
		return untrusted("Child mailbox structured body exceeds its item-count cap");
	}
	const text = canonicalText(body.text);
	const items = sourceItems.map(canonicalText);
	if (
		byteLength(text) > SUBAGENT_CONTEXT_TEXT_MAX_BYTES ||
		items.some((item) => byteLength(item) > SUBAGENT_CONTEXT_ITEM_MAX_BYTES)
	) {
		return untrusted("Child mailbox structured body exceeds its field byte cap");
	}
	let bodyBytes: number;
	let safeText: string;
	try {
		bodyBytes = byteLength(canonicalFoundationJson(body));
		safeText = canonicalFoundationJson({
			schemaVersion: 1,
			kind: messageValue.kind,
			text,
			items,
		});
	} catch {
		return untrusted("Child mailbox structured body is not canonical JSON");
	}
	if (bodyBytes > SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES || byteLength(safeText) > SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES) {
		return untrusted("Child mailbox structured body exceeds its total byte cap");
	}
	const base = {
		schemaVersion: 1 as const,
		source: "subagent_mailbox" as const,
		messageId: messageValue.messageId,
		childAgentInstanceId: messageValue.fromAgentInstanceId,
		kind: messageValue.kind,
		safeText,
		trust: "untrusted_child_output" as const,
		producedAt: messageValue.createdAt,
	};
	return Result.ok(cloneDeepFrozen({ ...base, digest: fingerprintFoundationValue(base) }));
}

async function resolveResultReference(
	options: SubagentContextIngressOptions,
	message: ChildMailboxMessage,
): Promise<ResultValue<SafeChildResultProjection, FoundationError>> {
	const body = message.body;
	if (
		!isRecord(body) ||
		!exactKeys(body, RESULT_REF_BODY_KEYS) ||
		body.schemaVersion !== 1 ||
		(body.objectType !== "attempt_receipt" && body.objectType !== "task_result") ||
		typeof body.objectId !== "string" ||
		!IDENTIFIER_PATTERN.test(body.objectId) ||
		!isRecord(body.digest) ||
		!exactKeys(body.digest, DIGEST_KEYS) ||
		body.digest.algorithm !== "sha256" ||
		typeof body.digest.value !== "string" ||
		!/^[0-9a-f]{64}$/.test(body.digest.value)
	) {
		return untrusted("Child result_ref body has an invalid exact shape");
	}
	let durable: Awaited<ReturnType<SessionLedger["get"]>>;
	try {
		durable = await options.ledger.get(body.objectType, body.objectId);
	} catch {
		return untrusted("Child result_ref durable source could not be read");
	}
	if (
		durable === undefined ||
		durable.kind !== "fact" ||
		durable.objectType !== body.objectType ||
		durable.objectId !== body.objectId ||
		!fingerprintMatches(body.digest as unknown as Fingerprint, fingerprintFoundationValue(durable.payload))
	) {
		return untrusted("Child result_ref does not match an immutable durable source");
	}
	if (body.objectType === "attempt_receipt") {
		const receipt = validateAttemptReceipt(durable.payload, { providerClass: "agent" });
		if (!receipt.ok || receipt.value.agentInstanceId === undefined) {
			return untrusted("Child result_ref does not resolve to an agent AttemptReceipt");
		}
		return projectSafeChildResult(
			{
				artifactStore: options.artifactStore,
				ledger: options.ledger,
				sessionId: options.sessionId,
				childLaneId: durable.lane,
				parentLaneId: options.parentLaneId,
			},
			{
				schemaVersion: 1,
				type: "attempt_receipt",
				childAgentInstanceId: message.fromAgentInstanceId,
				taskId: receipt.value.taskId,
				receipt: receipt.value,
			},
		);
	}
	const taskResult = validateTaskResult(durable.payload);
	if (!taskResult.ok) return untrusted("Child result_ref does not resolve to a TaskResult");
	const receipts: AttemptReceipt[] = [];
	let childLaneId: string | undefined;
	for (const receiptId of taskResult.value.sourceAttemptReceiptIds) {
		const record = await options.ledger.get("attempt_receipt", receiptId).catch(() => undefined);
		if (record === undefined || record.kind !== "fact") return untrusted("Child TaskResult source receipt is missing");
		const receipt = validateAttemptReceipt(record.payload, { providerClass: "agent" });
		if (!receipt.ok || receipt.value.agentInstanceId === undefined) return untrusted("Child TaskResult source receipt is invalid");
		if (childLaneId !== undefined && childLaneId !== record.lane) return untrusted("Child TaskResult source lanes are inconsistent");
		childLaneId = record.lane;
		receipts.push(receipt.value);
	}
	const first = receipts[0];
	if (
		first === undefined ||
		receipts.some((receipt) => receipt.agentInstanceId !== first.agentInstanceId || receipt.taskId !== taskResult.value.taskId)
	) {
		return untrusted("Child TaskResult source identity is inconsistent");
	}
	return projectSafeChildResult(
		{
			artifactStore: options.artifactStore,
			ledger: options.ledger,
			sessionId: options.sessionId,
			childLaneId: childLaneId ?? durable.lane,
			parentLaneId: options.parentLaneId,
		},
		{
			schemaVersion: 1,
			type: "task_result",
			childAgentInstanceId: message.fromAgentInstanceId,
			taskId: taskResult.value.taskId,
			taskResult: taskResult.value,
			sourceReceipts: receipts,
		},
	);
}

export class SubagentContextIngress {
	private readonly options: SubagentContextIngressOptions;

	constructor(options: SubagentContextIngressOptions) {
		if (
			options.schemaVersion !== 1 ||
			!IDENTIFIER_PATTERN.test(options.sessionId) ||
			!IDENTIFIER_PATTERN.test(options.parentLaneId) ||
			options.artifactStore.providerClass !== "store"
		) {
			throw new FoundationError("subagent_result_untrusted", "Subagent Context ingress options are invalid");
		}
		this.options = Object.freeze({ ...options });
	}

	async consumeNextTurn(
		input: ConsumeChildMailboxInput,
	): Promise<ResultValue<readonly SafeSubagentNextTurnContext[], FoundationError>> {
		if (input.limit > SUBAGENT_CONTEXT_CONSUME_MAX_ITEMS) {
			return untrusted("Subagent Context consume exceeds its item-count cap");
		}
		const consumed = await this.options.mailbox.consume(input);
		if (!consumed.ok) return consumed;
		const projected: SafeSubagentNextTurnContext[] = [];
		for (const message of consumed.value) {
			if (
				!validateMessageEnvelope(message) ||
				message.toAgentInstanceId !== input.toAgentInstanceId ||
				message.ack?.byAttemptId !== input.byAttemptId ||
				message.correlation.sessionId !== this.options.sessionId
			) {
				return untrusted("Consumed child mailbox message does not match its parent Context boundary");
			}
			if (message.kind === "result_ref") {
				const result = await resolveResultReference(this.options, message);
				if (!result.ok) return result;
				projected.push(result.value);
				continue;
			}
			const sanitized = sanitizeChildMailboxContext(message);
			if (!sanitized.ok) return sanitized;
			projected.push(sanitized.value);
		}
		return Result.ok(Object.freeze(projected.map((entry) => cloneDeepFrozen(entry))));
	}
}

export function validateSafeChildMailboxContext(
	value: unknown,
): ResultValue<SafeChildMailboxContext, FoundationError> {
	if (
		!isRecord(value) ||
		!exactKeys(value, SAFE_MAILBOX_KEYS) ||
		value.schemaVersion !== 1 ||
		value.source !== "subagent_mailbox" ||
		typeof value.messageId !== "string" ||
		!IDENTIFIER_PATTERN.test(value.messageId) ||
		typeof value.childAgentInstanceId !== "string" ||
		!IDENTIFIER_PATTERN.test(value.childAgentInstanceId) ||
		!(["input", "query", "notice"] as const).includes(value.kind as "input") ||
		typeof value.safeText !== "string" ||
		byteLength(value.safeText) > SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES ||
		value.trust !== "untrusted_child_output" ||
		!isRecord(value.digest) ||
		!exactKeys(value.digest, DIGEST_KEYS) ||
		value.digest.algorithm !== "sha256" ||
		typeof value.digest.value !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.digest.value) ||
		!canonicalTimestamp(value.producedAt)
	) {
		return untrusted("Safe child mailbox Context projection has an invalid exact shape");
	}
	const detached = cloneDeepFrozen(value) as unknown as SafeChildMailboxContext;
	const { digest, ...base } = detached;
	if (!fingerprintMatches(digest, fingerprintFoundationValue(base))) {
		return untrusted("Safe child mailbox Context projection digest does not match its content");
	}
	return Result.ok(detached);
}

export function renderSubagentNextTurnContext(entries: readonly SafeSubagentNextTurnContext[]): string {
	if (entries.length === 0) return "";
	if (entries.length > SUBAGENT_CONTEXT_CONSUME_MAX_ITEMS) {
		throw new FoundationError("subagent_result_untrusted", "Subagent Context render exceeds its item-count cap");
	}
	for (const entry of entries) {
		const checked = "source" in entry
			? validateSafeChildMailboxContext(entry)
			: validateSafeChildResultProjection(entry);
		if (!checked.ok) throw checked.error;
	}
	return `<subagent-context trust="untrusted_child_output">\n${canonicalFoundationJson(entries)}\n</subagent-context>`;
}
