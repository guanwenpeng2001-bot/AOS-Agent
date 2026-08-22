import {
	type AcceptanceFactV1,
	type ArtifactRefV1,
	AskStore,
	type AskV1,
	canonicalFoundationJson,
	type FingerprintV1,
	FoundationError,
	type FoundationFactRecordV1,
	fingerprintFoundationValue,
	type RunReceiptV1,
	type Session,
	SessionLedgerV1,
	SessionLedgerWriter,
	type TaskResultV1,
	validateArtifactRef,
	validateRunReceiptV1,
	validateTaskResultV1,
} from "@aos-agent/agent-core";
import {
	applySchedulerMessageAck,
	parseSchedulerMessage,
	type SchedulerMessageCorrelationV1,
	type SchedulerMessageV1,
	serializeSchedulerMessage,
} from "./scheduler.ts";
import type { TaskGraphRecord, TaskGraphStore } from "./task-graph.ts";

export const SCHEDULER_MESSAGE_OBJECT_TYPES_V1 = Object.freeze({
	posted: "scheduler.message_posted",
	acked: "scheduler.message_acked",
	timeout: "scheduler.message_timeout",
	wait: "scheduler.message_wait",
	reclaim: "scheduler.message_reclaim",
	ask: "scheduler.message_ask",
} as const);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = new Set([
	"apikey",
	"args",
	"authorization",
	"body",
	"command",
	"content",
	"credentials",
	"credential",
	"cwd",
	"data",
	"environment",
	"env",
	"headers",
	"messages",
	"output",
	"password",
	"path",
	"payload",
	"prompt",
	"raw",
	"secret",
	"stderr",
	"stdout",
	"token",
	"tokens",
	"url",
]);

export interface SchedulerTaskResultReferenceV1 {
	readonly schemaVersion: 1;
	readonly type: "task_result";
	readonly sessionId: string;
	readonly id: string;
	readonly revision: number;
}

export interface SchedulerRunReceiptReferenceV1 {
	readonly schemaVersion: 1;
	readonly type: "run_receipt";
	readonly sessionId: string;
	readonly id: string;
	readonly runId: string;
	readonly revision: number;
}

export type SchedulerResultReferenceV1 = SchedulerTaskResultReferenceV1 | SchedulerRunReceiptReferenceV1;

export type SchedulerMessageMaterialV1 =
	| { readonly schemaVersion: 1; readonly kind: "fingerprint"; readonly fingerprint: FingerprintV1 }
	| {
			readonly schemaVersion: 1;
			readonly kind: "artifact";
			readonly sessionId: string;
			readonly artifact: ArtifactRefV1;
	  }
	| { readonly schemaVersion: 1; readonly kind: "task_result"; readonly reference: SchedulerTaskResultReferenceV1 }
	| { readonly schemaVersion: 1; readonly kind: "run_receipt"; readonly reference: SchedulerRunReceiptReferenceV1 };

export interface SchedulerMessagePostFactV1 {
	readonly schemaVersion: 1;
	readonly message: SchedulerMessageV1;
	readonly material?: SchedulerMessageMaterialV1;
}

export interface SchedulerMessageTimeoutFactV1 {
	readonly schemaVersion: 1;
	readonly messageId: string;
	readonly threadId: string;
	readonly fromSessionId: string;
	readonly toSessionId: string;
	readonly timedOutAt: string;
	readonly revision: number;
}

export interface SchedulerMessageThreadEntryV1 {
	readonly schemaVersion: 1;
	readonly messageId: string;
	readonly state: "posted" | "acked" | "timed_out";
	readonly message: SchedulerMessageV1;
	readonly material?: SchedulerMessageMaterialV1;
	readonly transmissions: readonly SchedulerMessageV1[];
	readonly timeout?: SchedulerMessageTimeoutFactV1;
}

export interface SchedulerMessageThreadV1 {
	readonly schemaVersion: 1;
	readonly threadId: string;
	readonly entries: readonly SchedulerMessageThreadEntryV1[];
}

export interface SchedulerMessageSessionEndpointV1 {
	readonly session: Session;
	readonly taskGraph: TaskGraphStore;
}

export interface SchedulerMessageOrchestratorOptionsV1 {
	readonly ownerId?: string;
}

export interface SchedulerMessagePostResultV1 {
	readonly message: SchedulerMessageV1;
	readonly replayed: boolean;
}

export interface SchedulerTaskWaitFactV1 {
	readonly schemaVersion: 1;
	readonly kind: "task";
	readonly waitId: string;
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly taskId: string;
	readonly graphRevision: number;
	readonly nodeId: string;
	readonly threadId: string;
	readonly messageId: string;
	readonly status: "waiting" | "succeeded" | "failed" | "cancelled" | "timed_out";
	readonly expiresAt: string;
	readonly observedAt: string;
}

export interface SchedulerAskWaitFactV1 {
	readonly schemaVersion: 1;
	readonly kind: "ask";
	readonly waitId: string;
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly askId: string;
	readonly threadId: string;
	readonly messageId: string;
	readonly questionDigest: FingerprintV1;
	readonly status: "waiting" | "answered" | "expired" | "escalated" | "cancelled";
	readonly dueAt: string;
	readonly escalationAt?: string;
	readonly observedAt: string;
	readonly evidence?: AcceptanceFactV1;
	readonly responseMessageId?: string;
}

export type SchedulerWaitFactV1 = SchedulerTaskWaitFactV1 | SchedulerAskWaitFactV1;

export interface SchedulerResultResolutionV1 {
	readonly reference: SchedulerResultReferenceV1;
	readonly status: TaskResultV1["status"] | RunReceiptV1["terminalStatus"];
}

export interface SchedulerResultReclaimFactV1 {
	readonly schemaVersion: 1;
	readonly readyMessageId: string;
	readonly reclaimMessageId: string;
	readonly threadId: string;
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly taskId: string;
	readonly reference: SchedulerResultReferenceV1;
	readonly clientRequestId: string;
	readonly reclaimedAt: string;
}

export interface SchedulerAskResolutionV1 {
	readonly askId: string;
	readonly status: AskV1["status"];
	readonly evidence?: AcceptanceFactV1;
	readonly message?: SchedulerMessageV1;
}

export interface SchedulerAskStateV1 {
	readonly schemaVersion: 1;
	readonly askId: string;
	readonly targetSessionId: string;
	readonly status: AskV1["status"];
	readonly revision: number;
}

interface EndpointState {
	readonly session: Session;
	readonly taskGraph: TaskGraphStore;
	readonly writer: SessionLedgerWriter;
	readonly ledger: SessionLedgerV1;
	readonly asks: AskStore;
}

interface MessageState {
	readonly transmissions: readonly SchedulerMessageV1[];
	readonly material?: SchedulerMessageMaterialV1;
	readonly current: SchedulerMessageV1;
	readonly timeout?: SchedulerMessageTimeoutFactV1;
}

interface SchedulerFactCorrelation {
	readonly taskId?: string;
	readonly goalId?: string;
	readonly parentId?: string;
}

function invalid(message: string): never {
	throw new FoundationError("scheduler_message_invalid", message);
}

function timeout(message: string): never {
	throw new FoundationError("scheduler_message_timeout", message);
}

function notFound(message: string): never {
	throw new FoundationError("scheduler_not_found", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function safeId(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID.test(value);
}

function canonicalTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function same(left: unknown, right: unknown): boolean {
	if (left === undefined || right === undefined) return left === right;
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

function assertNoForbiddenKeys(value: unknown): void {
	const pending: unknown[] = [value];
	const visited = new Set<object>();
	while (pending.length > 0) {
		const candidate = pending.pop();
		if (candidate === null || typeof candidate !== "object") continue;
		if (visited.has(candidate)) invalid("Scheduler message input must be acyclic");
		visited.add(candidate);
		if (Array.isArray(candidate)) {
			pending.push(...candidate);
			continue;
		}
		for (const [key, nested] of Object.entries(candidate)) {
			const normalized = key.replace(/[-_]/g, "").toLowerCase();
			if (FORBIDDEN_KEYS.has(normalized)) invalid("Scheduler message input contains forbidden material");
			pending.push(nested);
		}
	}
}

function assertSafeMessageIdentifiers(message: SchedulerMessageV1): void {
	if (
		!safeId(message.messageId) ||
		!safeId(message.threadId) ||
		!safeId(message.fromSessionId) ||
		!safeId(message.toSessionId)
	) {
		invalid("Scheduler message identities must be opaque identifiers");
	}
	for (const value of Object.values(message.correlation)) {
		if (!safeId(value)) invalid("Scheduler message correlation contains an unsafe identifier");
	}
	if (message.expiresAt !== undefined && Date.parse(message.expiresAt) <= Date.parse(message.createdAt)) {
		invalid("Scheduler message expiration must follow creation");
	}
}

function parseFingerprint(value: unknown): FingerprintV1 {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["algorithm", "value"]) ||
		value.algorithm !== "sha256" ||
		!SHA256.test(String(value.value))
	) {
		invalid("Scheduler message fingerprint is invalid");
	}
	return { algorithm: "sha256", value: String(value.value) };
}

function assertArtifactIdentity(value: ArtifactRefV1): void {
	if (!safeId(value.artifactId) || (value.producer !== undefined && !safeId(value.producer))) {
		invalid("Scheduler artifact reference contains a path or unsafe identity");
	}
	if (!/^sha256:[0-9a-f]{64}$/.test(value.digest))
		invalid("Scheduler artifact reference requires a canonical SHA-256 digest");
	if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value.mediaType)) {
		invalid("Scheduler artifact reference has an invalid media type");
	}
}

function parseTaskResultReference(value: unknown): SchedulerTaskResultReferenceV1 {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["schemaVersion", "type", "sessionId", "id", "revision"]) ||
		value.schemaVersion !== 1 ||
		value.type !== "task_result" ||
		!safeId(value.sessionId) ||
		!safeId(value.id) ||
		!nonNegativeInteger(value.revision) ||
		value.revision === 0
	) {
		invalid("Scheduler TaskResult reference is invalid");
	}
	return { schemaVersion: 1, type: "task_result", sessionId: value.sessionId, id: value.id, revision: value.revision };
}

function parseRunReceiptReference(value: unknown): SchedulerRunReceiptReferenceV1 {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["schemaVersion", "type", "sessionId", "id", "runId", "revision"]) ||
		value.schemaVersion !== 1 ||
		value.type !== "run_receipt" ||
		!safeId(value.sessionId) ||
		!safeId(value.id) ||
		!safeId(value.runId) ||
		!nonNegativeInteger(value.revision) ||
		value.revision === 0
	) {
		invalid("Scheduler RunReceipt reference is invalid");
	}
	return {
		schemaVersion: 1,
		type: "run_receipt",
		sessionId: value.sessionId,
		id: value.id,
		runId: value.runId,
		revision: value.revision,
	};
}

function parseMaterial(value: unknown): SchedulerMessageMaterialV1 {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== "string") {
		invalid("Scheduler message material is invalid");
	}
	if (value.kind === "fingerprint") {
		if (!hasOnlyKeys(value, ["schemaVersion", "kind", "fingerprint"]))
			invalid("Scheduler fingerprint material is not exact");
		return { schemaVersion: 1, kind: "fingerprint", fingerprint: parseFingerprint(value.fingerprint) };
	}
	if (value.kind === "artifact") {
		if (!hasOnlyKeys(value, ["schemaVersion", "kind", "sessionId", "artifact"]) || !safeId(value.sessionId)) {
			invalid("Scheduler artifact material is not exact");
		}
		const checked = validateArtifactRef(value.artifact);
		if (!checked.ok) throw checked.error;
		assertArtifactIdentity(checked.value);
		return { schemaVersion: 1, kind: "artifact", sessionId: value.sessionId, artifact: clone(checked.value) };
	}
	if (value.kind === "task_result") {
		if (!hasOnlyKeys(value, ["schemaVersion", "kind", "reference"]))
			invalid("Scheduler TaskResult material is not exact");
		return { schemaVersion: 1, kind: "task_result", reference: parseTaskResultReference(value.reference) };
	}
	if (value.kind === "run_receipt") {
		if (!hasOnlyKeys(value, ["schemaVersion", "kind", "reference"]))
			invalid("Scheduler RunReceipt material is not exact");
		return { schemaVersion: 1, kind: "run_receipt", reference: parseRunReceiptReference(value.reference) };
	}
	invalid("Scheduler message material kind is unsupported");
}

function materialDigest(material: SchedulerMessageMaterialV1): FingerprintV1 {
	return material.kind === "fingerprint" ? clone(material.fingerprint) : fingerprintFoundationValue(material);
}

function materialOwner(material: SchedulerMessageMaterialV1): string | undefined {
	if (material.kind === "artifact") return material.sessionId;
	if (material.kind === "task_result" || material.kind === "run_receipt") return material.reference.sessionId;
	return undefined;
}

function validateMessageMaterial(message: SchedulerMessageV1, material: SchedulerMessageMaterialV1 | undefined): void {
	if ((message.payloadDigest === undefined) !== (material === undefined)) {
		invalid("Scheduler message digest and material must be supplied together");
	}
	if (material !== undefined && !same(message.payloadDigest, materialDigest(material))) {
		invalid("Scheduler message digest does not match its safe material");
	}
	const owner = material === undefined ? undefined : materialOwner(material);
	if (message.type === "result.ready") {
		if ((material?.kind !== "task_result" && material?.kind !== "run_receipt") || owner !== message.fromSessionId) {
			invalid("result.ready must reference a result owned by its sending Session");
		}
		if (message.correlation.taskId === undefined) invalid("result.ready requires task correlation");
		return;
	}
	if (message.type === "result.reclaim") {
		if ((material?.kind !== "task_result" && material?.kind !== "run_receipt") || owner !== message.toSessionId) {
			invalid("result.reclaim must reference a result owned by its receiving Session");
		}
		if (message.correlation.taskId === undefined) invalid("result.reclaim requires task correlation");
		return;
	}
	if (material?.kind === "task_result" || material?.kind === "run_receipt") {
		invalid("Result references are restricted to result message types");
	}
	if (owner !== undefined && owner !== message.fromSessionId) {
		invalid("Scheduler message material belongs to another Session");
	}
}

function parsePostFact(value: unknown): SchedulerMessagePostFactV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "message", "material"]) || value.schemaVersion !== 1) {
		invalid("Durable scheduler post fact is malformed");
	}
	const parsed = parseSchedulerMessage(value.message);
	if (!parsed.ok) throw parsed.error;
	assertSafeMessageIdentifiers(parsed.value);
	const material = value.material === undefined ? undefined : parseMaterial(value.material);
	validateMessageMaterial(parsed.value, material);
	return {
		schemaVersion: 1,
		message: parsed.value,
		...(material === undefined ? {} : { material }),
	};
}

function parseTimeoutFact(value: unknown): SchedulerMessageTimeoutFactV1 {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"schemaVersion",
			"messageId",
			"threadId",
			"fromSessionId",
			"toSessionId",
			"timedOutAt",
			"revision",
		]) ||
		value.schemaVersion !== 1 ||
		!safeId(value.messageId) ||
		!safeId(value.threadId) ||
		!safeId(value.fromSessionId) ||
		!safeId(value.toSessionId) ||
		!canonicalTimestamp(value.timedOutAt) ||
		!nonNegativeInteger(value.revision)
	) {
		invalid("Durable scheduler timeout fact is malformed");
	}
	return {
		schemaVersion: 1,
		messageId: value.messageId,
		threadId: value.threadId,
		fromSessionId: value.fromSessionId,
		toSessionId: value.toSessionId,
		timedOutAt: value.timedOutAt,
		revision: value.revision,
	};
}

function immutableMessageIdentity(left: SchedulerMessageV1, right: SchedulerMessageV1): boolean {
	return (
		left.messageId === right.messageId &&
		left.type === right.type &&
		left.threadId === right.threadId &&
		left.fromSessionId === right.fromSessionId &&
		left.toSessionId === right.toSessionId &&
		same(left.correlation, right.correlation) &&
		left.ack === right.ack &&
		same(left.payloadDigest, right.payloadDigest)
	);
}

function correlationForMessage(message: SchedulerMessageV1): {
	readonly taskId?: string;
	readonly goalId?: string;
	readonly parentId: string;
} {
	return {
		...(message.correlation.taskId === undefined ? {} : { taskId: message.correlation.taskId }),
		...(message.correlation.goalId === undefined ? {} : { goalId: message.correlation.goalId }),
		parentId: message.messageId,
	};
}

function parseRequiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (!safeId(value)) invalid(`Invalid ${key}`);
	return value;
}

function parseRequiredTimestamp(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (!canonicalTimestamp(value)) invalid(`Invalid ${key}`);
	return value;
}

function safeAskState(ask: AskV1): SchedulerAskStateV1 {
	return {
		schemaVersion: 1,
		askId: ask.askId,
		targetSessionId: ask.sessionId,
		status: ask.status,
		revision: ask.revision,
	};
}

export class SchedulerMessageOrchestratorV1 {
	private readonly endpointStates: readonly [EndpointState, EndpointState];
	private readonly initialized: Promise<ReadonlyMap<string, EndpointState>>;

	constructor(
		endpoints: readonly [SchedulerMessageSessionEndpointV1, SchedulerMessageSessionEndpointV1],
		options: SchedulerMessageOrchestratorOptionsV1 = {},
	) {
		if (endpoints[0].session === endpoints[1].session)
			invalid("Cross-Session messaging requires two distinct Sessions");
		const ownerId = options.ownerId ?? "foundation-t7";
		this.endpointStates = endpoints.map((endpoint) => {
			const writer = new SessionLedgerWriter(endpoint.session, { ownerId });
			return {
				session: endpoint.session,
				taskGraph: endpoint.taskGraph,
				writer,
				ledger: new SessionLedgerV1(endpoint.session, { writer }),
				asks: new AskStore(endpoint.session, { writer }),
			};
		}) as unknown as readonly [EndpointState, EndpointState];
		this.initialized = this.initialize();
	}

	async release(): Promise<void> {
		await Promise.all(this.endpointStates.map((endpoint) => endpoint.writer.releaseLease()));
	}

	async post(input: unknown): Promise<SchedulerMessagePostResultV1> {
		assertNoForbiddenKeys(input);
		if (!isRecord(input) || !hasOnlyKeys(input, ["message", "material"]))
			invalid("Scheduler post input is not exact");
		const fact = parsePostFact({
			schemaVersion: 1,
			message: input.message,
			...(input.material === undefined ? {} : { material: input.material }),
		});
		if (fact.message.revision !== 0 || fact.message.ackedAt !== undefined)
			invalid("A new scheduler message must start at revision zero");
		const existing = await this.facts(SCHEDULER_MESSAGE_OBJECT_TYPES_V1.posted, fact.message.messageId);
		if (existing.length > 0) {
			const state = await this.loadMessage(fact.message.messageId);
			if (!same(state.transmissions[0], fact.message) || !same(state.material, fact.material)) {
				invalid("A scheduler message identity is already bound to different content");
			}
			await this.repairMirror(
				fact.message,
				SCHEDULER_MESSAGE_OBJECT_TYPES_V1.posted,
				fact.message.messageId,
				fact,
				`scheduler-post:${fact.message.messageId}:0`,
				0,
			);
			return { message: clone(state.current), replayed: true };
		}
		const result = await this.persistMirrored(
			fact.message,
			SCHEDULER_MESSAGE_OBJECT_TYPES_V1.posted,
			fact.message.messageId,
			fact,
			`scheduler-post:${fact.message.messageId}:0`,
			0,
		);
		return { message: clone(fact.message), replayed: result };
	}

	async acknowledge(input: unknown): Promise<SchedulerMessagePostResultV1> {
		if (!isRecord(input) || !hasOnlyKeys(input, ["sessionId", "messageId", "threadId", "at"])) {
			invalid("Scheduler acknowledgment input is not exact");
		}
		const sessionId = parseRequiredString(input, "sessionId");
		const messageId = parseRequiredString(input, "messageId");
		const threadId = parseRequiredString(input, "threadId");
		const at = parseRequiredTimestamp(input, "at");
		const state = await this.loadMessage(messageId);
		if (state.current.toSessionId !== sessionId || state.current.threadId !== threadId) {
			invalid("Scheduler acknowledgment references another Session, message, or thread");
		}
		if (state.timeout !== undefined) timeout("A timed-out scheduler message cannot be acknowledged");
		if (state.current.ackedAt !== undefined) {
			const fact: SchedulerMessagePostFactV1 = {
				schemaVersion: 1,
				message: state.current,
				...(state.material === undefined ? {} : { material: state.material }),
			};
			await this.repairMirror(
				fact.message,
				SCHEDULER_MESSAGE_OBJECT_TYPES_V1.acked,
				messageId,
				fact,
				`scheduler-ack:${messageId}:${fact.message.revision}`,
				0,
			);
			return { message: clone(state.current), replayed: true };
		}
		const applied = applySchedulerMessageAck(state.current, at);
		if (!applied.ok) throw applied.error;
		const fact: SchedulerMessagePostFactV1 = {
			schemaVersion: 1,
			message: applied.value,
			...(state.material === undefined ? {} : { material: state.material }),
		};
		const replayed = await this.persistMirrored(
			applied.value,
			SCHEDULER_MESSAGE_OBJECT_TYPES_V1.acked,
			messageId,
			fact,
			`scheduler-ack:${messageId}:${applied.value.revision}`,
			0,
		);
		return { message: clone(applied.value), replayed };
	}

	async replayRequiredMessage(input: unknown): Promise<SchedulerMessagePostResultV1> {
		if (!isRecord(input) || !hasOnlyKeys(input, ["sessionId", "messageId", "threadId", "at", "expiresAt"])) {
			invalid("Scheduler replay input is not exact");
		}
		const sessionId = parseRequiredString(input, "sessionId");
		const messageId = parseRequiredString(input, "messageId");
		const threadId = parseRequiredString(input, "threadId");
		const at = parseRequiredTimestamp(input, "at");
		const expiresAt = parseRequiredTimestamp(input, "expiresAt");
		const state = await this.loadMessage(messageId);
		if (state.current.fromSessionId !== sessionId || state.current.threadId !== threadId) {
			invalid("Scheduler replay references another Session, message, or thread");
		}
		if (state.current.ack !== "required" || state.current.expiresAt === undefined)
			invalid("Only required messages can replay");
		if (state.current.ackedAt !== undefined || state.timeout !== undefined)
			invalid("Settled scheduler messages cannot replay");
		if (state.transmissions.length === 2) {
			if (state.current.createdAt !== at || state.current.expiresAt !== expiresAt) {
				timeout("A scheduler message may be replayed only once");
			}
			const fact: SchedulerMessagePostFactV1 = {
				schemaVersion: 1,
				message: state.current,
				...(state.material === undefined ? {} : { material: state.material }),
			};
			await this.repairMirror(
				state.current,
				SCHEDULER_MESSAGE_OBJECT_TYPES_V1.posted,
				messageId,
				fact,
				`scheduler-post:${messageId}:${state.current.revision}`,
				1,
			);
			return { message: clone(state.current), replayed: true };
		}
		if (state.transmissions.length !== 1) timeout("A scheduler message may be replayed only once");
		if (Date.parse(at) < Date.parse(state.current.expiresAt))
			timeout("Scheduler message expiration has not been reached");
		if (Date.parse(expiresAt) <= Date.parse(at)) invalid("Scheduler replay expiration must follow its send time");
		const message = serializeSchedulerMessage({
			...state.current,
			createdAt: at,
			expiresAt,
			revision: state.current.revision + 1,
		});
		const fact: SchedulerMessagePostFactV1 = {
			schemaVersion: 1,
			message,
			...(state.material === undefined ? {} : { material: state.material }),
		};
		const replayed = await this.persistMirrored(
			message,
			SCHEDULER_MESSAGE_OBJECT_TYPES_V1.posted,
			messageId,
			fact,
			`scheduler-post:${messageId}:${message.revision}`,
			state.transmissions.length,
		);
		return { message, replayed };
	}

	async timeoutRequiredMessage(input: unknown): Promise<SchedulerMessageTimeoutFactV1> {
		if (!isRecord(input) || !hasOnlyKeys(input, ["sessionId", "messageId", "threadId", "at"])) {
			invalid("Scheduler timeout input is not exact");
		}
		const sessionId = parseRequiredString(input, "sessionId");
		const messageId = parseRequiredString(input, "messageId");
		const threadId = parseRequiredString(input, "threadId");
		const at = parseRequiredTimestamp(input, "at");
		const state = await this.loadMessage(messageId);
		if (state.current.fromSessionId !== sessionId || state.current.threadId !== threadId) {
			invalid("Scheduler timeout references another Session, message, or thread");
		}
		if (state.timeout !== undefined) {
			await this.repairMirror(
				state.current,
				SCHEDULER_MESSAGE_OBJECT_TYPES_V1.timeout,
				messageId,
				state.timeout,
				`scheduler-timeout:${messageId}:${state.timeout.revision}`,
				0,
			);
			return clone(state.timeout);
		}
		if (
			state.current.ack !== "required" ||
			state.current.expiresAt === undefined ||
			state.current.ackedAt !== undefined
		) {
			invalid("Only unacknowledged required messages can time out");
		}
		if (Date.parse(at) < Date.parse(state.current.expiresAt))
			timeout("Scheduler message expiration has not been reached");
		const fact: SchedulerMessageTimeoutFactV1 = {
			schemaVersion: 1,
			messageId,
			threadId,
			fromSessionId: state.current.fromSessionId,
			toSessionId: state.current.toSessionId,
			timedOutAt: at,
			revision: state.current.revision + 1,
		};
		await this.persistMirrored(
			state.current,
			SCHEDULER_MESSAGE_OBJECT_TYPES_V1.timeout,
			messageId,
			fact,
			`scheduler-timeout:${messageId}:${fact.revision}`,
			0,
		);
		return fact;
	}

	async rebuildThread(threadId: string): Promise<SchedulerMessageThreadV1> {
		if (!safeId(threadId)) invalid("Scheduler thread identifier is invalid");
		const endpoints = await this.initialized;
		const messageIds = new Set<string>();
		for (const endpoint of endpoints.values()) {
			const records = await endpoint.ledger.find({
				kind: "fact",
				objectType: SCHEDULER_MESSAGE_OBJECT_TYPES_V1.posted,
				order: "oldestFirst",
				includePruned: true,
			});
			for (const record of records) {
				if (record.kind !== "fact") continue;
				const fact = parsePostFact(record.payload);
				if (fact.message.threadId === threadId) messageIds.add(fact.message.messageId);
			}
		}
		const entries: SchedulerMessageThreadEntryV1[] = [];
		for (const messageId of messageIds) {
			const state = await this.loadMessage(messageId);
			if (state.current.threadId !== threadId)
				invalid("Scheduler thread rebuild found conflicting message identity");
			entries.push({
				schemaVersion: 1,
				messageId,
				state: state.timeout !== undefined ? "timed_out" : state.current.ackedAt !== undefined ? "acked" : "posted",
				message: clone(state.current),
				...(state.material === undefined ? {} : { material: clone(state.material) }),
				transmissions: clone(state.transmissions),
				...(state.timeout === undefined ? {} : { timeout: clone(state.timeout) }),
			});
		}
		entries.sort(
			(left, right) =>
				left.transmissions[0]!.createdAt.localeCompare(right.transmissions[0]!.createdAt) ||
				left.messageId.localeCompare(right.messageId),
		);
		return { schemaVersion: 1, threadId, entries };
	}

	async submitCrossSessionTask(input: unknown): Promise<{
		readonly graph: TaskGraphRecord;
		readonly wait: SchedulerTaskWaitFactV1;
		readonly message: SchedulerMessageV1;
		readonly reused: boolean;
	}> {
		if (
			!isRecord(input) ||
			!hasOnlyKeys(input, [
				"sourceSessionId",
				"targetSessionId",
				"taskId",
				"graphRevision",
				"nodeId",
				"waitId",
				"threadId",
				"messageId",
				"clientRequestId",
				"createdAt",
				"expiresAt",
				"goalId",
				"workflowId",
			])
		) {
			invalid("Cross-Session submit input is not exact");
		}
		const sourceSessionId = parseRequiredString(input, "sourceSessionId");
		const targetSessionId = parseRequiredString(input, "targetSessionId");
		const taskId = parseRequiredString(input, "taskId");
		const nodeId = parseRequiredString(input, "nodeId");
		const waitId = parseRequiredString(input, "waitId");
		const threadId = parseRequiredString(input, "threadId");
		const messageId = parseRequiredString(input, "messageId");
		const clientRequestId = parseRequiredString(input, "clientRequestId");
		const createdAt = parseRequiredTimestamp(input, "createdAt");
		const expiresAt = parseRequiredTimestamp(input, "expiresAt");
		if (!nonNegativeInteger(input.graphRevision) || input.graphRevision === 0) invalid("Invalid graphRevision");
		if (sourceSessionId === targetSessionId) invalid("Cross-Session submit requires different Sessions");
		if (Date.parse(expiresAt) <= Date.parse(createdAt))
			invalid("Cross-Session submit expiration must follow creation");
		const graphRevision = input.graphRevision;
		const goalId = input.goalId === undefined ? undefined : parseRequiredString(input, "goalId");
		const workflowId = input.workflowId === undefined ? undefined : parseRequiredString(input, "workflowId");
		const correlation: SchedulerMessageCorrelationV1 = {
			taskId,
			...(goalId === undefined ? {} : { goalId }),
			...(workflowId === undefined ? {} : { workflowId }),
		};
		const target = await this.endpoint(targetSessionId);
		const source = await this.endpoint(sourceSessionId);
		let graph = target.taskGraph.get(taskId, graphRevision);
		let reused = graph !== undefined;
		if (graph === undefined) {
			graph = target.taskGraph.create({
				taskId,
				graphRevision,
				nodes: [{ nodeId, dependsOn: [] }],
				clientRequestId,
			}).graph;
			reused = false;
		} else if (!graph.nodes.some((node) => node.nodeId === nodeId)) {
			invalid("Cross-Session submit cannot reuse a Graph without the requested node");
		}
		if (graph.sessionId !== targetSessionId) invalid("Target Task Graph belongs to another Session");
		const message: SchedulerMessageV1 = {
			schemaVersion: 1,
			messageId,
			type: "note",
			threadId,
			fromSessionId: sourceSessionId,
			toSessionId: targetSessionId,
			correlation,
			ack: "required",
			expiresAt,
			createdAt,
			revision: 0,
		};
		const posted = await this.post({ message });
		const acknowledged = await this.acknowledge({ sessionId: targetSessionId, messageId, threadId, at: createdAt });
		const wait: SchedulerTaskWaitFactV1 = {
			schemaVersion: 1,
			kind: "task",
			waitId,
			sourceSessionId,
			targetSessionId,
			taskId,
			graphRevision,
			nodeId,
			threadId,
			messageId,
			status: "waiting",
			expiresAt,
			observedAt: createdAt,
		};
		await this.persistImmutableFact(
			source,
			SCHEDULER_MESSAGE_OBJECT_TYPES_V1.wait,
			waitId,
			wait,
			`scheduler-task-wait:${waitId}:waiting`,
			{ taskId, parentId: messageId },
		);
		return { graph: clone(graph), wait, message: acknowledged.message, reused: reused || posted.replayed };
	}

	async waitForCrossSessionTask(input: unknown): Promise<SchedulerTaskWaitFactV1> {
		if (!isRecord(input) || !hasOnlyKeys(input, ["sourceSessionId", "waitId", "at"])) {
			invalid("Cross-Session task wait input is not exact");
		}
		const sourceSessionId = parseRequiredString(input, "sourceSessionId");
		const waitId = parseRequiredString(input, "waitId");
		const at = parseRequiredTimestamp(input, "at");
		const source = await this.endpoint(sourceSessionId);
		const stored = await source.ledger.getFact<SchedulerWaitFactV1>(SCHEDULER_MESSAGE_OBJECT_TYPES_V1.wait, waitId);
		if (stored === undefined || stored.payload.kind !== "task") notFound("Cross-Session task wait was not found");
		const wait = stored.payload;
		if (wait.sourceSessionId !== sourceSessionId || wait.waitId !== waitId)
			invalid("Cross-Session task wait belongs to another Session");
		if (wait.status !== "waiting") return clone(wait);
		const target = await this.endpoint(wait.targetSessionId);
		const graph = target.taskGraph.get(wait.taskId, wait.graphRevision);
		if (graph === undefined || graph.sessionId !== wait.targetSessionId)
			invalid("Target Task Graph is missing or belongs to another Session");
		const node = graph.nodes.find((candidate) => candidate.nodeId === wait.nodeId);
		if (node === undefined) invalid("Target Task Graph node is missing");
		const status =
			node.status === "succeeded" || node.status === "failed" || node.status === "cancelled"
				? node.status
				: Date.parse(at) >= Date.parse(wait.expiresAt)
					? "timed_out"
					: "waiting";
		if (status === "waiting") return clone(wait);
		const next: SchedulerTaskWaitFactV1 = { ...wait, status, observedAt: at };
		await source.ledger.appendFact(SCHEDULER_MESSAGE_OBJECT_TYPES_V1.wait, waitId, next, {
			clientRequestId: `scheduler-task-wait:${waitId}:${status}`,
			expectedRevision: stored.record.revision,
			correlation: { taskId: wait.taskId, parentId: wait.messageId },
		});
		return next;
	}

	async publishResultReady(input: unknown): Promise<SchedulerMessageV1> {
		if (
			!isRecord(input) ||
			!hasOnlyKeys(input, [
				"ownerSessionId",
				"consumerSessionId",
				"taskId",
				"threadId",
				"messageId",
				"createdAt",
				"expiresAt",
				"reference",
			])
		) {
			invalid("result.ready input is not exact");
		}
		const ownerSessionId = parseRequiredString(input, "ownerSessionId");
		const consumerSessionId = parseRequiredString(input, "consumerSessionId");
		const taskId = parseRequiredString(input, "taskId");
		const threadId = parseRequiredString(input, "threadId");
		const messageId = parseRequiredString(input, "messageId");
		const createdAt = parseRequiredTimestamp(input, "createdAt");
		const expiresAt = parseRequiredTimestamp(input, "expiresAt");
		const reference = this.parseResultReference(input.reference);
		if (reference.sessionId !== ownerSessionId) invalid("result.ready reference belongs to another Session");
		await this.resolveResultReference(reference, taskId);
		const material: SchedulerMessageMaterialV1 =
			reference.type === "task_result"
				? { schemaVersion: 1, kind: "task_result", reference }
				: { schemaVersion: 1, kind: "run_receipt", reference };
		const message: SchedulerMessageV1 = {
			schemaVersion: 1,
			messageId,
			type: "result.ready",
			threadId,
			fromSessionId: ownerSessionId,
			toSessionId: consumerSessionId,
			correlation: { taskId },
			ack: "required",
			expiresAt,
			payloadDigest: materialDigest(material),
			createdAt,
			revision: 0,
		};
		return (await this.post({ message, material })).message;
	}

	async reclaimResult(
		input: unknown,
	): Promise<SchedulerResultResolutionV1 & { readonly message: SchedulerMessageV1; readonly replayed: boolean }> {
		if (
			!isRecord(input) ||
			!hasOnlyKeys(input, [
				"sourceSessionId",
				"targetSessionId",
				"taskId",
				"threadId",
				"readyMessageId",
				"reclaimMessageId",
				"clientRequestId",
				"at",
			])
		) {
			invalid("result.reclaim input is not exact");
		}
		const sourceSessionId = parseRequiredString(input, "sourceSessionId");
		const targetSessionId = parseRequiredString(input, "targetSessionId");
		const taskId = parseRequiredString(input, "taskId");
		const threadId = parseRequiredString(input, "threadId");
		const readyMessageId = parseRequiredString(input, "readyMessageId");
		const reclaimMessageId = parseRequiredString(input, "reclaimMessageId");
		const clientRequestId = parseRequiredString(input, "clientRequestId");
		const at = parseRequiredTimestamp(input, "at");
		const state = await this.loadMessage(readyMessageId);
		if (
			state.current.type !== "result.ready" ||
			state.current.threadId !== threadId ||
			state.current.fromSessionId !== targetSessionId ||
			state.current.toSessionId !== sourceSessionId ||
			state.current.correlation.taskId !== taskId
		) {
			invalid("result.reclaim references a different ready message or correlation");
		}
		if (
			state.timeout !== undefined ||
			(state.current.expiresAt !== undefined && Date.parse(at) >= Date.parse(state.current.expiresAt))
		) {
			timeout("result.ready expired before reclaim");
		}
		if (state.material?.kind !== "task_result" && state.material?.kind !== "run_receipt") {
			invalid("result.ready has no safe result reference");
		}
		const reference = clone(state.material.reference);
		const resolved = await this.resolveResultReference(reference, taskId);
		const material: SchedulerMessageMaterialV1 =
			reference.type === "task_result"
				? { schemaVersion: 1, kind: "task_result", reference }
				: { schemaVersion: 1, kind: "run_receipt", reference };
		const source = await this.endpoint(sourceSessionId);
		const existing = await source.ledger.getFact<SchedulerResultReclaimFactV1>(
			SCHEDULER_MESSAGE_OBJECT_TYPES_V1.reclaim,
			readyMessageId,
		);
		if (existing !== undefined) {
			if (
				existing.payload.readyMessageId !== readyMessageId ||
				existing.payload.threadId !== threadId ||
				existing.payload.sourceSessionId !== sourceSessionId ||
				existing.payload.targetSessionId !== targetSessionId ||
				existing.payload.taskId !== taskId ||
				existing.payload.clientRequestId !== clientRequestId ||
				existing.payload.reclaimMessageId !== reclaimMessageId ||
				!same(existing.payload.reference, reference)
			) {
				invalid("A result reference was already reclaimed by another request");
			}
			const replay = await this.post({
				message: {
					schemaVersion: 1,
					messageId: reclaimMessageId,
					type: "result.reclaim",
					threadId,
					fromSessionId: sourceSessionId,
					toSessionId: targetSessionId,
					correlation: { taskId },
					ack: "none",
					payloadDigest: materialDigest(material),
					createdAt: existing.payload.reclaimedAt,
					revision: 0,
				},
				material,
			});
			return { ...resolved, message: replay.message, replayed: true };
		}
		await this.acknowledge({ sessionId: sourceSessionId, messageId: readyMessageId, threadId, at });
		const fact: SchedulerResultReclaimFactV1 = {
			schemaVersion: 1,
			readyMessageId,
			reclaimMessageId,
			threadId,
			sourceSessionId,
			targetSessionId,
			taskId,
			reference,
			clientRequestId,
			reclaimedAt: at,
		};
		await source.ledger.appendFact(SCHEDULER_MESSAGE_OBJECT_TYPES_V1.reclaim, readyMessageId, fact, {
			clientRequestId: `scheduler-result-reclaim:${clientRequestId}`,
			expectedRevision: 0,
			correlation: {
				taskId,
				parentId: readyMessageId,
				...(reference.type === "task_result"
					? { taskResultId: reference.id }
					: { runId: reference.runId, runReceiptId: reference.id }),
			},
		});
		const message: SchedulerMessageV1 = {
			schemaVersion: 1,
			messageId: reclaimMessageId,
			type: "result.reclaim",
			threadId,
			fromSessionId: sourceSessionId,
			toSessionId: targetSessionId,
			correlation: { taskId },
			ack: "none",
			payloadDigest: materialDigest(material),
			createdAt: at,
			revision: 0,
		};
		const posted = await this.post({ message, material });
		return { ...resolved, message: posted.message, replayed: false };
	}

	async createCrossSessionAsk(input: unknown): Promise<{
		readonly ask: SchedulerAskStateV1;
		readonly wait: SchedulerAskWaitFactV1;
		readonly message: SchedulerMessageV1;
	}> {
		assertNoForbiddenKeys(input);
		if (
			!isRecord(input) ||
			!hasOnlyKeys(input, [
				"sourceSessionId",
				"targetSessionId",
				"askId",
				"waitId",
				"threadId",
				"messageId",
				"question",
				"options",
				"goalId",
				"taskId",
				"dueAt",
				"escalationAt",
				"escalationTarget",
				"createdAt",
				"clientRequestId",
			])
		) {
			invalid("Cross-Session Ask input is not exact");
		}
		const sourceSessionId = parseRequiredString(input, "sourceSessionId");
		const targetSessionId = parseRequiredString(input, "targetSessionId");
		const askId = parseRequiredString(input, "askId");
		const waitId = parseRequiredString(input, "waitId");
		const threadId = parseRequiredString(input, "threadId");
		const messageId = parseRequiredString(input, "messageId");
		const dueAt = parseRequiredTimestamp(input, "dueAt");
		const createdAt = parseRequiredTimestamp(input, "createdAt");
		const clientRequestId = parseRequiredString(input, "clientRequestId");
		if (sourceSessionId === targetSessionId) invalid("Cross-Session Ask requires different Sessions");
		if (typeof input.question !== "string" || input.question.trim().length === 0)
			invalid("Cross-Session Ask question is invalid");
		if (
			!Array.isArray(input.options) ||
			input.options.length === 0 ||
			!input.options.every((value) => typeof value === "string" && value.trim().length > 0)
		) {
			invalid("Cross-Session Ask requires bounded options");
		}
		if (input.options.length > 32) invalid("Cross-Session Ask has too many options");
		const question = input.question.trim();
		const options = input.options.map((value) => String(value).trim());
		const escalationAt = input.escalationAt === undefined ? undefined : parseRequiredTimestamp(input, "escalationAt");
		const escalationTarget =
			input.escalationTarget === undefined ? undefined : parseRequiredString(input, "escalationTarget");
		if ((escalationAt === undefined) !== (escalationTarget === undefined))
			invalid("Ask escalation time and target must be supplied together");
		if (Date.parse(dueAt) <= Date.parse(createdAt)) invalid("Ask dueAt must follow creation");
		const source = await this.endpoint(sourceSessionId);
		const target = await this.endpoint(targetSessionId);
		const taskId = input.taskId === undefined ? undefined : parseRequiredString(input, "taskId");
		const goalId = input.goalId === undefined ? undefined : parseRequiredString(input, "goalId");
		const ask = await target.asks.create(
			{
				sessionId: targetSessionId,
				askId,
				question,
				options,
				...(goalId === undefined ? {} : { goalId }),
				...(taskId === undefined ? {} : { taskId }),
				dueAt,
				...(escalationAt === undefined || escalationTarget === undefined ? {} : { escalationAt, escalationTarget }),
			},
			{ clientRequestId, expectedRevision: 0 },
		);
		if (ask.sessionId !== targetSessionId || ask.askId !== askId)
			invalid("Created Ask identity does not match its target Session");
		const questionDigest = fingerprintFoundationValue({ askId, question, options });
		const material: SchedulerMessageMaterialV1 = {
			schemaVersion: 1,
			kind: "fingerprint",
			fingerprint: questionDigest,
		};
		const message: SchedulerMessageV1 = {
			schemaVersion: 1,
			messageId,
			type: "note",
			threadId,
			fromSessionId: sourceSessionId,
			toSessionId: targetSessionId,
			correlation: {
				...(taskId === undefined ? {} : { taskId }),
				...(goalId === undefined ? {} : { goalId }),
				askId,
			},
			ack: "required",
			expiresAt: dueAt,
			payloadDigest: materialDigest(material),
			createdAt,
			revision: 0,
		};
		await this.post({ message, material });
		const acknowledged = await this.acknowledge({ sessionId: targetSessionId, messageId, threadId, at: createdAt });
		const wait: SchedulerAskWaitFactV1 = {
			schemaVersion: 1,
			kind: "ask",
			waitId,
			sourceSessionId,
			targetSessionId,
			askId,
			threadId,
			messageId,
			questionDigest,
			status: "waiting",
			dueAt,
			...(escalationAt === undefined ? {} : { escalationAt }),
			observedAt: createdAt,
		};
		await this.persistImmutableFact(
			source,
			SCHEDULER_MESSAGE_OBJECT_TYPES_V1.wait,
			waitId,
			wait,
			`scheduler-ask-wait:${waitId}:waiting`,
			{
				...(taskId === undefined ? {} : { taskId }),
				...(goalId === undefined ? {} : { goalId }),
				parentId: askId,
			},
		);
		return { ask: safeAskState(ask), wait, message: acknowledged.message };
	}

	async replyCrossSessionAsk(input: unknown): Promise<SchedulerAskStateV1> {
		if (
			!isRecord(input) ||
			!hasOnlyKeys(input, ["targetSessionId", "askId", "optionIndex", "by", "replyId", "clientRequestId"])
		) {
			invalid("Cross-Session Ask reply input is not exact");
		}
		const targetSessionId = parseRequiredString(input, "targetSessionId");
		const askId = parseRequiredString(input, "askId");
		const by = parseRequiredString(input, "by");
		const replyId = parseRequiredString(input, "replyId");
		const clientRequestId = parseRequiredString(input, "clientRequestId");
		if (!nonNegativeInteger(input.optionIndex)) invalid("Ask optionIndex is invalid");
		const target = await this.endpoint(targetSessionId);
		const ask = await target.asks.get(askId);
		if (ask.sessionId !== targetSessionId) invalid("Ask belongs to another Session");
		if (ask.options === undefined || input.optionIndex >= ask.options.length)
			invalid("Ask optionIndex is outside the approved options");
		const answered = await target.asks.reply(
			askId,
			{ replyId, value: { optionIndex: input.optionIndex }, by },
			{ clientRequestId, expectedRevision: ask.revision },
		);
		return safeAskState(answered);
	}

	async resolveCrossSessionAsk(input: unknown): Promise<SchedulerAskResolutionV1> {
		if (
			!isRecord(input) ||
			!hasOnlyKeys(input, ["sourceSessionId", "waitId", "at", "clientRequestId", "messageId"])
		) {
			invalid("Cross-Session Ask resolution input is not exact");
		}
		const sourceSessionId = parseRequiredString(input, "sourceSessionId");
		const waitId = parseRequiredString(input, "waitId");
		const at = parseRequiredTimestamp(input, "at");
		const clientRequestId = parseRequiredString(input, "clientRequestId");
		const responseMessageId = parseRequiredString(input, "messageId");
		const source = await this.endpoint(sourceSessionId);
		const stored = await source.ledger.getFact<SchedulerWaitFactV1>(SCHEDULER_MESSAGE_OBJECT_TYPES_V1.wait, waitId);
		if (stored === undefined || stored.payload.kind !== "ask") notFound("Cross-Session Ask wait was not found");
		const wait = stored.payload;
		if (wait.sourceSessionId !== sourceSessionId || wait.waitId !== waitId)
			invalid("Cross-Session Ask wait belongs to another Session");
		const target = await this.endpoint(wait.targetSessionId);
		let ask = await target.asks.get(wait.askId);
		if (ask.sessionId !== wait.targetSessionId) invalid("Ask belongs to another Session");
		if (wait.status !== "waiting") {
			if (
				wait.evidence === undefined ||
				wait.responseMessageId === undefined ||
				wait.responseMessageId !== responseMessageId ||
				wait.status !== ask.status
			) {
				invalid("Settled Cross-Session Ask evidence is inconsistent");
			}
			const response = await this.loadMessage(responseMessageId);
			const expectedMaterial: SchedulerMessageMaterialV1 = {
				schemaVersion: 1,
				kind: "fingerprint",
				fingerprint: fingerprintFoundationValue(wait.evidence),
			};
			if (
				response.timeout !== undefined ||
				response.current.type !== "note" ||
				response.current.threadId !== wait.threadId ||
				response.current.fromSessionId !== wait.targetSessionId ||
				response.current.toSessionId !== wait.sourceSessionId ||
				response.current.correlation.askId !== wait.askId ||
				!same(response.material, expectedMaterial)
			) {
				invalid("Settled Cross-Session Ask response is inconsistent");
			}
			return {
				askId: wait.askId,
				status: ask.status,
				evidence: clone(wait.evidence),
				message: clone(response.current),
			};
		}
		if (ask.status === "pending") {
			const dueReached = Date.parse(at) >= Date.parse(wait.dueAt);
			const escalationReached = wait.escalationAt !== undefined && Date.parse(at) >= Date.parse(wait.escalationAt);
			if (dueReached || escalationReached) {
				const escalateFirst =
					escalationReached &&
					wait.escalationAt !== undefined &&
					Date.parse(wait.escalationAt) <= Date.parse(wait.dueAt);
				ask = escalateFirst
					? await target.asks.escalate(wait.askId, { at }, { clientRequestId, expectedRevision: ask.revision })
					: await target.asks.expire(wait.askId, { at }, { clientRequestId, expectedRevision: ask.revision });
			}
		}
		if (ask.status === "pending") return { askId: wait.askId, status: "pending" };
		if (
			ask.status !== "answered" &&
			ask.status !== "expired" &&
			ask.status !== "escalated" &&
			ask.status !== "cancelled"
		) {
			invalid("Ask reached an unsupported terminal state");
		}
		const observedAt = ask.settledAt ?? at;
		const evidence: AcceptanceFactV1 = {
			schemaVersion: 1,
			factId: `scheduler-ask-${wait.askId}-${ask.revision}-${responseMessageId}`,
			outcome: ask.status === "answered" ? "satisfied" : ask.status === "escalated" ? "pending" : "unsatisfied",
			verified: ask.status === "answered",
			source: { kind: "ask", ref: `${wait.targetSessionId}:${wait.askId}` },
			recordedAt: observedAt,
			observedAt,
			recordedBy: "scheduler",
		};
		await this.persistImmutableFact(
			source,
			SCHEDULER_MESSAGE_OBJECT_TYPES_V1.ask,
			wait.askId,
			evidence,
			`scheduler-ask-evidence:${wait.askId}:${ask.revision}`,
			{ parentId: wait.askId },
		);
		const material: SchedulerMessageMaterialV1 = {
			schemaVersion: 1,
			kind: "fingerprint",
			fingerprint: fingerprintFoundationValue(evidence),
		};
		const message: SchedulerMessageV1 = {
			schemaVersion: 1,
			messageId: responseMessageId,
			type: "note",
			threadId: wait.threadId,
			fromSessionId: wait.targetSessionId,
			toSessionId: wait.sourceSessionId,
			correlation: { askId: wait.askId },
			ack: "none",
			payloadDigest: materialDigest(material),
			createdAt: observedAt,
			revision: 0,
		};
		const posted = await this.post({ message, material });
		const next: SchedulerAskWaitFactV1 = {
			...wait,
			status: ask.status,
			observedAt,
			evidence,
			responseMessageId,
		};
		await source.ledger.appendFact(SCHEDULER_MESSAGE_OBJECT_TYPES_V1.wait, waitId, next, {
			clientRequestId: `scheduler-ask-wait:${waitId}:${ask.status}`,
			expectedRevision: stored.record.revision,
			correlation: { parentId: wait.askId },
		});
		return { askId: wait.askId, status: ask.status, evidence, message: posted.message };
	}

	private async initialize(): Promise<ReadonlyMap<string, EndpointState>> {
		const endpoints = new Map<string, EndpointState>();
		for (const endpoint of this.endpointStates) {
			const metadata = await endpoint.session.getMetadata();
			if (!safeId(metadata.id)) invalid("Session metadata has an unsafe identifier");
			if (endpoints.has(metadata.id)) invalid("Cross-Session messaging requires distinct Session identities");
			endpoints.set(metadata.id, endpoint);
		}
		return endpoints;
	}

	private async endpoint(sessionId: string): Promise<EndpointState> {
		const endpoint = (await this.initialized).get(sessionId);
		if (endpoint === undefined) invalid("Scheduler message references a Session outside this Host pair");
		if ((await endpoint.session.getMetadata()).id !== sessionId)
			invalid("Session metadata changed during scheduler operation");
		return endpoint;
	}

	private async persistImmutableFact<TPayload>(
		endpoint: EndpointState,
		objectType: string,
		objectId: string,
		payload: TPayload,
		clientRequestId: string,
		correlation: SchedulerFactCorrelation,
	): Promise<boolean> {
		const current = await endpoint.ledger.get(objectType, objectId);
		if (current !== undefined) {
			if (current.kind !== "fact" || !same(current.payload, payload)) {
				invalid("An immutable scheduler fact already exists with different content");
			}
			return true;
		}
		const result = await endpoint.ledger.appendFact(objectType, objectId, payload, {
			clientRequestId,
			expectedRevision: 0,
			correlation,
		});
		return result.replayed;
	}

	private async persistMirrored<TPayload>(
		message: SchedulerMessageV1,
		objectType: string,
		objectId: string,
		payload: TPayload,
		clientRequestId: string,
		expectedRevision: number,
	): Promise<boolean> {
		const [source, target] = await Promise.all([
			this.endpoint(message.fromSessionId),
			this.endpoint(message.toSessionId),
		]);
		const correlation = correlationForMessage(message);
		const results = await Promise.all(
			[source, target].map((endpoint) =>
				endpoint.ledger.appendFact(objectType, objectId, payload, {
					clientRequestId,
					expectedRevision,
					correlation,
				}),
			),
		);
		return results.every((result) => result.replayed);
	}

	private async repairMirror<TPayload>(
		message: SchedulerMessageV1,
		objectType: string,
		objectId: string,
		payload: TPayload,
		clientRequestId: string,
		expectedRevision: number,
	): Promise<void> {
		const [source, target] = await Promise.all([
			this.endpoint(message.fromSessionId),
			this.endpoint(message.toSessionId),
		]);
		for (const endpoint of [source, target]) {
			const current = await endpoint.ledger.get(objectType, objectId);
			if (current !== undefined) {
				if (current.kind === "fact" && same(current.payload, payload)) continue;
				if (current.kind !== "fact" || current.revision !== expectedRevision) {
					invalid("Mirrored scheduler fact conflicts with its peer");
				}
			}
			await endpoint.ledger.appendFact(objectType, objectId, payload, {
				clientRequestId,
				expectedRevision,
				correlation: correlationForMessage(message),
			});
		}
	}

	private async facts(objectType: string, objectId: string): Promise<readonly FoundationFactRecordV1[]> {
		const endpoints = await this.initialized;
		const records = await Promise.all(
			[...endpoints.values()].map((endpoint) =>
				endpoint.ledger.find({ kind: "fact", objectType, objectId, order: "oldestFirst", includePruned: true }),
			),
		);
		return records.flat().filter((record): record is FoundationFactRecordV1 => record.kind === "fact");
	}

	private async loadMessage(messageId: string): Promise<MessageState> {
		if (!safeId(messageId)) invalid("Scheduler message identifier is invalid");
		const postedRecords = await this.facts(SCHEDULER_MESSAGE_OBJECT_TYPES_V1.posted, messageId);
		if (postedRecords.length === 0) notFound("Scheduler message was not found");
		const byRevision = new Map<number, SchedulerMessagePostFactV1>();
		for (const record of postedRecords) {
			const fact = parsePostFact(record.payload);
			if (fact.message.messageId !== messageId)
				invalid("Durable scheduler post fact has the wrong message identity");
			const existing = byRevision.get(fact.message.revision);
			if (existing !== undefined && !same(existing, fact)) invalid("Mirrored scheduler post facts conflict");
			byRevision.set(fact.message.revision, fact);
		}
		const ordered = [...byRevision.values()].sort((left, right) => left.message.revision - right.message.revision);
		if (ordered.length > 2) invalid("Scheduler message has more than one replay");
		for (let index = 0; index < ordered.length; index += 1) {
			const fact = ordered[index]!;
			if (fact.message.revision !== index) invalid("Scheduler message revisions contain a gap");
			if (index > 0) {
				const previous = ordered[index - 1]!;
				if (!immutableMessageIdentity(previous.message, fact.message) || !same(previous.material, fact.material)) {
					invalid("Scheduler message replay changed immutable content");
				}
				if (
					Date.parse(fact.message.createdAt) < Date.parse(previous.message.expiresAt ?? previous.message.createdAt)
				) {
					invalid("Scheduler message replay precedes its prior expiration");
				}
			}
		}
		let current = ordered.at(-1)!.message;
		const material = ordered[0]!.material;
		const ackRecords = await this.facts(SCHEDULER_MESSAGE_OBJECT_TYPES_V1.acked, messageId);
		let ackFact: SchedulerMessagePostFactV1 | undefined;
		for (const record of ackRecords) {
			const fact = parsePostFact(record.payload);
			if (fact.message.messageId !== messageId || !same(fact.material, material))
				invalid("Durable scheduler acknowledgment is malformed");
			if (ackFact !== undefined && !same(ackFact, fact)) invalid("Mirrored scheduler acknowledgments conflict");
			ackFact = fact;
		}
		if (ackFact !== undefined) {
			const expected = applySchedulerMessageAck(current, ackFact.message.ackedAt ?? "");
			if (!expected.ok || !same(expected.value, ackFact.message))
				invalid("Scheduler acknowledgment revision or correlation is invalid");
			current = ackFact.message;
		}
		const timeoutRecords = await this.facts(SCHEDULER_MESSAGE_OBJECT_TYPES_V1.timeout, messageId);
		let timeoutFact: SchedulerMessageTimeoutFactV1 | undefined;
		for (const record of timeoutRecords) {
			const fact = parseTimeoutFact(record.payload);
			if (timeoutFact !== undefined && !same(timeoutFact, fact))
				invalid("Mirrored scheduler timeout facts conflict");
			timeoutFact = fact;
		}
		if (timeoutFact !== undefined) {
			const latestTransmission = ordered.at(-1)!.message;
			if (
				ackFact !== undefined ||
				timeoutFact.messageId !== messageId ||
				timeoutFact.threadId !== latestTransmission.threadId ||
				timeoutFact.fromSessionId !== latestTransmission.fromSessionId ||
				timeoutFact.toSessionId !== latestTransmission.toSessionId ||
				timeoutFact.revision !== latestTransmission.revision + 1 ||
				latestTransmission.expiresAt === undefined ||
				Date.parse(timeoutFact.timedOutAt) < Date.parse(latestTransmission.expiresAt)
			) {
				invalid("Scheduler timeout revision or correlation is invalid");
			}
		}
		return {
			transmissions: ordered.map((fact) => clone(fact.message)),
			...(material === undefined ? {} : { material: clone(material) }),
			current: clone(current),
			...(timeoutFact === undefined ? {} : { timeout: clone(timeoutFact) }),
		};
	}

	private parseResultReference(value: unknown): SchedulerResultReferenceV1 {
		if (!isRecord(value)) invalid("Scheduler result reference is invalid");
		return value.type === "task_result" ? parseTaskResultReference(value) : parseRunReceiptReference(value);
	}

	private async resolveResultReference(
		reference: SchedulerResultReferenceV1,
		taskId: string,
	): Promise<SchedulerResultResolutionV1> {
		const endpoint = await this.endpoint(reference.sessionId);
		if (reference.type === "task_result") {
			const stored = await endpoint.ledger.get("task_result", reference.id);
			if (stored === undefined || stored.kind !== "fact" || stored.revision !== reference.revision) {
				invalid("TaskResult reference does not resolve in its owning Session");
			}
			const checked = validateTaskResultV1(stored.payload);
			if (!checked.ok) throw checked.error;
			if (
				checked.value.taskResultId !== reference.id ||
				checked.value.taskId !== taskId ||
				checked.value.provenance.correlation?.sessionId !== reference.sessionId
			) {
				invalid("TaskResult reference has the wrong Session or task correlation");
			}
			return { reference: clone(reference), status: checked.value.status };
		}
		const stored = await endpoint.ledger.get("run_receipt", reference.runId);
		if (stored === undefined || stored.kind !== "fact" || stored.revision !== reference.revision) {
			invalid("RunReceipt reference does not resolve in its owning Session");
		}
		const checked = validateRunReceiptV1(stored.payload);
		if (!checked.ok) throw checked.error;
		if (
			checked.value.runReceiptId !== reference.id ||
			checked.value.runId !== reference.runId ||
			stored.correlation.sessionId !== reference.sessionId ||
			stored.correlation.taskId !== taskId
		) {
			invalid("RunReceipt reference has the wrong Session or task correlation");
		}
		if (checked.value.taskResultId !== undefined) {
			const taskResult = await endpoint.ledger.get("task_result", checked.value.taskResultId);
			if (taskResult === undefined || taskResult.kind !== "fact")
				invalid("RunReceipt references a missing TaskResult");
			const validatedTaskResult = validateTaskResultV1(taskResult.payload);
			if (!validatedTaskResult.ok || validatedTaskResult.value.taskId !== taskId) {
				invalid("RunReceipt TaskResult belongs to another task");
			}
		}
		return { reference: clone(reference), status: checked.value.terminalStatus };
	}
}

export const SchedulerMessageOrchestrator = SchedulerMessageOrchestratorV1;
