import type { AgentMessage } from "@aos-agent/agent-core";
import { type ImageContent, type Message, type TextContent, type Usage, uuidv7 } from "@aos-agent/ai";
import { createHash, randomUUID } from "crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { createInterface } from "readline";
import { StringDecoder } from "string_decoder";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../../config.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import {
	CONTEXT_SNAPSHOT_CUSTOM_TYPE,
	CONTEXT_SNAPSHOT_SCHEMA_VERSION,
	type ContextSnapshot,
} from "./context-engine.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { SessionWriteCoordinator } from "./write-coordinator.ts";

export const CURRENT_SESSION_VERSION = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContextSourceKind(value: unknown): value is ContextSnapshot["sources"][number]["kind"] {
	return (
		value === "system" ||
		value === "instruction" ||
		value === "capability_index" ||
		value === "session_summary" ||
		value === "session_message" ||
		value === "memory" ||
		value === "extension"
	);
}

function isContextScope(value: unknown): value is ContextSnapshot["sources"][number]["scope"] {
	return value === "global" || value === "project" || value === "directory" || value === "session" || value === "turn";
}

function isContextTrust(value: unknown): value is ContextSnapshot["sources"][number]["trust"] {
	return (
		value === "builtin" ||
		value === "user_owned" ||
		value === "trusted_project" ||
		value === "untrusted_project" ||
		value === "untrusted_child_output"
	);
}

function isContextDisposition(value: unknown): value is ContextSnapshot["sources"][number]["disposition"] {
	return value === "included" || value === "trimmed" || value === "excluded";
}

function isContextDispositionReason(
	value: unknown,
): value is NonNullable<ContextSnapshot["sources"][number]["reason"]> {
	return (
		value === "within_budget" ||
		value === "budget_exhausted" ||
		value === "untrusted" ||
		value === "disabled" ||
		value === "revoked" ||
		value === "snapshot_only"
	);
}

function isContextExtensionVisibility(
	value: unknown,
): value is NonNullable<ContextSnapshot["sources"][number]["visibility"]> {
	return value === "snapshot_only" || value === "model_and_snapshot";
}

function parseContextSourceReceipt(value: unknown): ContextSnapshot["sources"][number] | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (
		typeof value.sourceId !== "string" ||
		value.sourceId.length === 0 ||
		!isContextSourceKind(value.kind) ||
		!isContextScope(value.scope) ||
		!isContextTrust(value.trust) ||
		typeof value.contentDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.contentDigest) ||
		typeof value.estimatedTokens !== "number" ||
		!Number.isFinite(value.estimatedTokens) ||
		value.estimatedTokens < 0 ||
		!isContextDisposition(value.disposition) ||
		(value.reason !== undefined && !isContextDispositionReason(value.reason)) ||
		(value.path !== undefined && typeof value.path !== "string") ||
		(value.refId !== undefined && typeof value.refId !== "string") ||
		(value.label !== undefined && typeof value.label !== "string") ||
		(value.visibility !== undefined && !isContextExtensionVisibility(value.visibility)) ||
		(value.kind === "extension" && (typeof value.label !== "string" || !isContextExtensionVisibility(value.visibility))) ||
		(value.kind !== "extension" && (value.label !== undefined || value.visibility !== undefined))
	) {
		return undefined;
	}
	const receipt: ContextSnapshot["sources"][number] = {
		sourceId: value.sourceId,
		kind: value.kind,
		scope: value.scope,
		trust: value.trust,
		contentDigest: value.contentDigest,
		estimatedTokens: value.estimatedTokens,
		disposition: value.disposition,
	};
	if (typeof value.path === "string") receipt.path = value.path;
	if (isContextDispositionReason(value.reason)) receipt.reason = value.reason;
	if (typeof value.refId === "string") receipt.refId = value.refId;
	if (typeof value.label === "string") receipt.label = value.label;
	if (isContextExtensionVisibility(value.visibility)) receipt.visibility = value.visibility;
	return receipt;
}

/** Parse a ContextSnapshot custom-entry payload; returns undefined when invalid. */
export function parseContextSnapshot(data: unknown): ContextSnapshot | undefined {
	if (!isRecord(data)) {
		return undefined;
	}
	if (data.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) {
		return undefined;
	}
	if (typeof data.id !== "string" || typeof data.sessionId !== "string") {
		return undefined;
	}
	if (data.purpose !== "agent_turn" && data.purpose !== "compaction" && data.purpose !== "branch_summary") {
		return undefined;
	}
	if (typeof data.createdAt !== "string") {
		return undefined;
	}
	if (!Array.isArray(data.sources) || !isRecord(data.budget)) {
		return undefined;
	}
	const parsedSources = data.sources.map(parseContextSourceReceipt);
	if (parsedSources.some((source) => source === undefined)) {
		return undefined;
	}
	const sources = parsedSources.filter(
		(source): source is ContextSnapshot["sources"][number] => source !== undefined,
	);
	const budget = data.budget;
	if (
		typeof budget.contextWindow !== "number" ||
		typeof budget.reserveTokens !== "number" ||
		typeof budget.inputLimit !== "number" ||
		typeof budget.estimatedInputTokens !== "number" ||
		!Number.isFinite(budget.contextWindow) ||
		!Number.isFinite(budget.reserveTokens) ||
		!Number.isFinite(budget.inputLimit) ||
		!Number.isFinite(budget.estimatedInputTokens)
	) {
		return undefined;
	}
	const snapshot: ContextSnapshot = {
		schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
		id: data.id,
		purpose: data.purpose,
		sessionId: data.sessionId,
		createdAt: data.createdAt,
		sources,
		budget: {
			contextWindow: budget.contextWindow,
			reserveTokens: budget.reserveTokens,
			inputLimit: budget.inputLimit,
			estimatedInputTokens: budget.estimatedInputTokens,
		},
	};
	if (typeof data.runId === "string") {
		snapshot.runId = data.runId;
	}
	if (typeof data.parentSnapshotId === "string") {
		snapshot.parentSnapshotId = data.parentSnapshotId;
	}
	return snapshot;
}

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** True if generated by an extension, undefined/false if aos-generated (backward compatible) */
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** Extension-specific data (not sent to LLM) */
	details?: T;
	/** Usage from the LLM call that generated this summary, if available */
	usage?: Usage;
	/** True if generated by an extension, false if aos-generated */
	fromHook?: boolean;
}

/**
 * Custom entry for extensions to store extension-specific data in the session.
 * Use customType to identify your extension's entries.
 *
 * Purpose: Persist extension state across session reloads. On reload, extensions can
 * scan entries for their customType and reconstruct internal state.
 *
 * Does NOT participate in LLM context (ignored by buildSessionContext).
 * For injecting content into context, see CustomMessageEntry.
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/** Label entry for user-defined bookmarks/markers on entries. */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** Session metadata entry (e.g., user-defined display name). */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * Custom message entry for extensions to inject messages into LLM context.
 * Use customType to identify your extension's entries.
 *
 * Unlike CustomEntry, this DOES participate in LLM context.
 * The content is converted to a user message in buildSessionContext().
 * Use details for extension-specific metadata (not sent to LLM).
 *
 * display controls TUI rendering:
 * - false: hidden entirely
 * - true: rendered with distinct styling (different from user messages)
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

/** Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager) */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry;

/** Raw file entry (includes header) */
export type FileEntry = SessionHeader | SessionEntry;

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
	/** Timestamp of the latest label change for this entry, if any */
	labelTimestamp?: string;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	/** User-defined display name from session_info entries. */
	name?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "buildContextEntries"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateVersionOneToVersionTwo(entries: FileEntry[]): void {
	const ids = new Set<string>();
	const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
	if (header === undefined) throw new Error("Session migration requires a header");
	let prevId: string | null = null;
	let entryIndex = 0;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entryIndex += 1;
		const digest = createHash("sha256")
			.update(JSON.stringify({ schemaVersion: 1, sessionId: header.id, index: entryIndex, entry }))
			.digest("hex");
		let id: string | undefined;
		for (let offset = 0; offset <= digest.length - 8; offset += 8) {
			const candidate = digest.slice(offset, offset + 8);
			if (!ids.has(candidate)) {
				id = candidate;
				break;
			}
		}
		if (id === undefined) throw new Error("Session migration entry id digest collision");
		entry.id = id;
		entry.parentId = prevId;
		prevId = entry.id;
		ids.add(entry.id);

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateVersionTwoToVersionThree(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// Update message entries with hookMessage role
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateVersionOneToVersionTwo(entries);
	if (version < 3) migrateVersionTwoToVersionThree(entries);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

type SessionFileCorruptionDisposition = "unrepaired" | "repaired" | "repair_failed";

/** Safe diagnostic for invalid JSONL. Raw session content is intentionally omitted. */
export class SessionFileCorruptionError extends Error {
	readonly lineNumber: number;
	readonly byteOffset: number;
	readonly disposition: SessionFileCorruptionDisposition;

	constructor(lineNumber: number, byteOffset: number, disposition: SessionFileCorruptionDisposition = "unrepaired") {
		const message =
			disposition === "repaired"
				? `Session file corruption detected at line ${lineNumber}. The valid prefix was preserved and the corrupt remainder was quarantined. Restart to continue from the repaired session.`
				: disposition === "repair_failed"
					? `Session file corruption detected at line ${lineNumber}. The session was not opened because the corrupt remainder could not be safely isolated.`
					: `Session file contains invalid JSONL at line ${lineNumber}.`;
		super(message);
		this.name = "SessionFileCorruptionError";
		this.lineNumber = lineNumber;
		this.byteOffset = byteOffset;
		this.disposition = disposition;
	}
}

/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.split("\n");
	let byteOffset = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const nextByteOffset = byteOffset + Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? 1 : 0);
		if (!line.trim()) {
			byteOffset = nextByteOffset;
			continue;
		}
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			throw new SessionFileCorruptionError(index + 1, byteOffset);
		}
		byteOffset = nextByteOffset;
	}

	return entries;
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) {
		index.set(entry.id, entry);
	}
	return index;
}

function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return [];
	}
	if (leafId) {
		leaf = index.get(leafId);
	}
	leaf ??= entries[entries.length - 1];
	if (!leaf) {
		return [];
	}

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

/**
 * Project one selected session entry into LLM/runtime messages.
 * Plain custom entries are display/state entries and do not participate in context.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		const message = entry.message;
		// Session files are parsed without validation; old versions, forks, or
		// hand-edited files can contain messages with null/missing content.
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	return [];
}

/**
 * Build the active, compaction-aware session entry list.
 *
 * This follows the current leaf path. If the path contains compaction entries,
 * the latest compaction is represented by the compaction entry itself, followed
 * by the kept entries starting at firstKeptEntryId and all entries after the
 * compaction entry. Older summarized entries are omitted.
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	if (!compaction) {
		return path;
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) {
		return path;
	}

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const path = buildSessionPath(entries, leafId, byId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const messages = buildContextEntries(entries, leafId, byId).flatMap(sessionEntryToContextMessages);
	return { messages, thinkingLevel, model };
}

/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.aos-agent/agent/sessions/.
 */
function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** Bound synchronous header discovery while allowing large cwd and custom metadata fields. */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

function parseSessionEntryLine(line: string, lineNumber: number, byteOffset: number): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		throw new SessionFileCorruptionError(lineNumber, byteOffset);
	}
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	const fd = openSync(resolvedFilePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = Buffer.alloc(0);
		let lineNumber = 1;
		let byteOffset = 0;

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			const chunk = Buffer.from(buffer.subarray(0, bytesRead));
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			let newlineIndex = pending.indexOf(0x0a);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(
					pending.subarray(0, newlineIndex).toString("utf8"),
					lineNumber,
					byteOffset,
				);
				if (entry) entries.push(entry);
				const consumedBytes = newlineIndex + 1;
				byteOffset += consumedBytes;
				lineNumber += 1;
				pending = Buffer.from(pending.subarray(consumedBytes));
				newlineIndex = pending.indexOf(0x0a);
			}
		}

		if (pending.length > 0) {
			const finalEntry = parseSessionEntryLine(pending.toString("utf8"), lineNumber, byteOffset);
			if (finalEntry) entries.push(finalEntry);
		}
	} finally {
		closeSync(fd);
	}

	// Validate session header
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	return entries;
}

function copyFileRange(source: number, target: number, start: number, end: number): void {
	const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
	let position = start;
	while (position < end) {
		const requested = Math.min(buffer.length, end - position);
		const bytesRead = readSync(source, buffer, 0, requested, position);
		if (bytesRead === 0) throw new Error("Session repair source ended unexpectedly");
		let written = 0;
		while (written < bytesRead) {
			const bytesWritten = writeSync(target, buffer, written, bytesRead - written);
			if (bytesWritten === 0) throw new Error("Session repair write made no progress");
			written += bytesWritten;
		}
		position += bytesRead;
	}
}

function repairCorruptSessionFile(filePath: string, corruption: SessionFileCorruptionError): void {
	const stats = statSync(filePath);
	if (corruption.byteOffset < 0 || corruption.byteOffset >= stats.size) {
		throw new Error("Session corruption offset is outside the source file");
	}

	const directory = dirname(filePath);
	const fileName = basename(filePath);
	const suffix = randomUUID().replaceAll("-", "");
	const repairedTempPath = join(directory, `.${fileName}.repair.${suffix}.tmp`);
	const quarantineTempPath = join(directory, `.${fileName}.corrupt.${suffix}.tmp`);
	const quarantinePath = join(directory, `.${fileName}.corrupt.${suffix}`);
	let source: number | undefined;
	let repaired: number | undefined;
	let quarantine: number | undefined;
	try {
		source = openSync(filePath, "r");
		const mode = stats.mode & 0o777;
		repaired = openSync(repairedTempPath, "wx", mode);
		quarantine = openSync(quarantineTempPath, "wx", mode);
		copyFileRange(source, repaired, 0, corruption.byteOffset);
		copyFileRange(source, quarantine, corruption.byteOffset, stats.size);
		fsyncSync(repaired);
		fsyncSync(quarantine);
		closeSync(repaired);
		repaired = undefined;
		closeSync(quarantine);
		quarantine = undefined;
		closeSync(source);
		source = undefined;
		renameSync(quarantineTempPath, quarantinePath);
		renameSync(repairedTempPath, filePath);
	} finally {
		if (source !== undefined) closeSync(source);
		if (repaired !== undefined) closeSync(repaired);
		if (quarantine !== undefined) closeSync(quarantine);
		rmSync(repairedTempPath, { force: true });
		rmSync(quarantineTempPath, { force: true });
	}
}

function loadSessionEntriesForOpen(filePath: string, sessionDir: string): FileEntry[] {
	try {
		return loadEntriesFromFile(filePath);
	} catch (initialError) {
		if (!(initialError instanceof SessionFileCorruptionError)) throw initialError;
		return new SessionWriteCoordinator(filePath, sessionDir).withWriteLock(() => {
			try {
				// An append may have been observed between writes. Re-read after acquiring
				// the writer lock so a completed line is never quarantined as a torn tail.
				return loadEntriesFromFile(filePath);
			} catch (lockedError) {
				if (!(lockedError instanceof SessionFileCorruptionError)) throw lockedError;
				try {
					repairCorruptSessionFile(filePath, lockedError);
				} catch {
					throw new SessionFileCorruptionError(
						lockedError.lineNumber,
						lockedError.byteOffset,
						"repair_failed",
					);
				}
				throw new SessionFileCorruptionError(lockedError.lineNumber, lockedError.byteOffset, "repaired");
			}
		});
	}
}

/**
 * Inspect a physical line while searching for the first parsed session entry.
 * Blank lines and malformed pre-header lines are skipped for bounded discovery only.
 * The authoritative full load rejects and repairs malformed lines before opening.
 * Returns undefined to keep scanning, null for a parsed non-header entry, or the header.
 */
function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	let entry: FileEntry | null;
	try {
		entry = parseSessionEntryLine(line, 1, 0);
	} catch (error) {
		if (error instanceof SessionFileCorruptionError) return undefined;
		throw error;
	}
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}

		// Probe for EOF so a final header without a newline is allowed when it ends
		// exactly at the scan limit. Any additional byte exceeds the bounded scan.
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		// Discovery is best-effort: unreadable or oversized files are not sessions,
		// and one corrupt file must not prevent other sessions from being found.
		return null;
	}
}

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.map((path) => ({ path, header: readSessionHeaderForDiscovery(path) }))
			.filter(
				(file): file is { path: string; header: SessionHeader } =>
					file.header !== null &&
					(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)),
			)
			.map(({ path }) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		// Directory access and stat races make recent-session discovery unavailable.
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const stats = await stat(filePath);
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;
		let lastActivityTime: number | undefined;
		let lineNumber = 0;

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			lineNumber += 1;
			const entry = parseSessionEntryLine(line, lineNumber, 0);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}

			// Extract session name (use latest, including explicit clears)
			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return null;

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}

type SessionReadProjectionInitializer = (manager: SessionManager) => void;

let sessionReadProjectionInitializer: SessionReadProjectionInitializer | undefined;

/** Register the canonical storage adapter used to derive mature read views. */
export function registerSessionReadProjectionInitializer(initializer: SessionReadProjectionInitializer): void {
	sessionReadProjectionInitializer = initializer;
}

function initializeSessionReadProjection(manager: SessionManager): SessionManager {
	sessionReadProjectionInitializer?.(manager);
	return manager;
}

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private entriesReadProjection: (() => SessionEntry[]) | undefined;
	private legacyLeafIdReadProjection: (() => string | null) | undefined;
	private leafIdReadProjection: (() => string | null) | undefined;
	private lanesReadProjection: (() => ReadonlyMap<string, string | null>) | undefined;
	private writesPaused = false;
	private writesRetired = false;
	private detachedSource: SessionManager | undefined;
	private detachedBaseEntryCount = 0;
	private detachedBaseLeafId: string | null = null;
	private detachedBaseCanonicalLeafIds = new Map<string, string | null>();
	private detachedFlushRequested = false;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}

		if (sessionFile) {
			this._setSessionFile(sessionFile, preloadedFileEntries);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
	}

	private _setSessionFile(sessionFile: string, preloadedFileEntries?: FileEntry[]): void {
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			this.fileEntries =
				preloadedFileEntries ?? loadSessionEntriesForOpen(this.sessionFile, this.sessionDir);

			// If file was empty, initialize it with a valid session header. If it was
			// non-empty but did not parse as an AOS Agent session, fail without modifying it.
			if (this.fileEntries.length === 0) {
				const explicitPath = this.sessionFile;
				if (statSync(explicitPath).size > 0) {
					throw new Error(`Session file is not a valid AOS Agent session: ${explicitPath}`);
				}
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
			this.sessionId = header?.id ?? createSessionId();

			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}

			this._buildIndex();
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // preserve explicit path from --session flag
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		return this.sessionFile;
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _withWriteLock<T>(operation: () => T): T {
		if (!this.persist || !this.sessionFile) return operation();
		return new SessionWriteCoordinator(this.sessionFile, this.sessionDir).withWriteLock(operation);
	}

	private assertWritesAllowed(): void {
		if (this.writesPaused) throw new Error("Session scope no longer accepts writes");
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		this._withWriteLock(() => this._rewriteFileUnlocked());
	}

	private _rewriteFileUnlocked(): void {
		const fd = openSync(this.sessionFile!, "w");
		try {
			for (const entry of this.fileEntries) {
				writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			}
		} finally {
			closeSync(fd);
		}
	}

	/** Persist the complete pending log after a canonical assistant response settles. */
	flushPendingSession(): void {
		this.assertWritesAllowed();
		if (this.writesRetired) return;
		if (this.detachedSource !== undefined) {
			this.detachedFlushRequested = true;
			this.flushed = true;
			return;
		}
		if (!this.persist || !this.sessionFile || this.flushed) return;
		this._rewriteFile();
		this.flushed = true;
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	_persist(entry: SessionEntry, entries: FileEntry[] = this.fileEntries): void {
		this.assertWritesAllowed();
		if (this.writesRetired) return;
		if (this.detachedSource !== undefined) return;
		if (!this.persist || !this.sessionFile) return;

		const hasAssistant = entries.some((e) => e.type === "message" && e.message.role === "assistant");
		if (!hasAssistant) {
			if (this.flushed) {
				this._withWriteLock(() => {
					appendFileSync(this.sessionFile!, `${JSON.stringify(entry)}\n`);
				});
			} else {
				// Mark as not flushed so when assistant arrives, all entries get written
				this.flushed = false;
			}
			return;
		}

		if (!this.flushed) {
			this._withWriteLock(() => {
				const fd = openSync(this.sessionFile!, "wx");
				try {
					for (const e of entries) {
						writeFileSync(fd, `${JSON.stringify(e)}\n`);
					}
				} finally {
					closeSync(fd);
				}
			});
			this.flushed = true;
		} else {
			this._withWriteLock(() => {
				appendFileSync(this.sessionFile!, `${JSON.stringify(entry)}\n`);
			});
		}
	}

	private _appendEntry(entry: SessionEntry): void {
		const nextEntries = [...this.fileEntries, entry];
		this._persist(entry, nextEntries);
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			usage,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Fold all valid Context Engine snapshots from custom entries (append order).
	 * Custom entries never participate in buildSessionContext / LLM messages.
	 */
	getContextSnapshots(): ContextSnapshot[] {
		const snapshots: ContextSnapshot[] = [];
		for (const entry of this.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== CONTEXT_SNAPSHOT_CUSTOM_TYPE) {
				continue;
			}
			const snapshot = parseContextSnapshot(entry.data);
			if (snapshot) {
				snapshots.push(snapshot);
			}
		}
		return snapshots;
	}

	/** Lookup a persisted Context Snapshot by id. */
	getContextSnapshot(id: string): ContextSnapshot | undefined {
		for (const snapshot of this.getContextSnapshots()) {
			if (snapshot.id === id) {
				return snapshot;
			}
		}
		return undefined;
	}

	/** Latest frozen snapshot id (for Run receipts). */
	getLatestContextSnapshotId(): string | undefined {
		const snapshots = this.getContextSnapshots();
		return snapshots.length > 0 ? snapshots[snapshots.length - 1]!.id : undefined;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		// Walk entries in reverse to find the latest session_info entry.
		// Empty names explicitly clear the session title.
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.legacyLeafIdReadProjection?.() ?? this.leafId;
	}

	/** Return the canonical main-lane leaf, including compatibility-hidden entries. */
	getCanonicalMainLaneLeafId(): string | null {
		return this.leafIdReadProjection?.() ?? this.leafId;
	}

	private getCanonicalLaneLeafIds(): Map<string, string | null> {
		return new Map(this.lanesReadProjection?.() ?? [["main", this.leafId]]);
	}

	getLeafEntry(): SessionEntry | undefined {
		const leafId = this.getLeafId();
		return leafId ? this.getEntry(leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		if (this.entriesReadProjection) return this.entriesReadProjection().find((entry) => entry.id === id);
		return this.byId.get(id);
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.entriesReadProjection?.() ?? this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const entries = this.getEntries();
		const byId = this.entriesReadProjection
			? new Map(entries.map((entry) => [entry.id, entry]))
			: this.byId;
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.getLeafId();
		let current = startId ? byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	/**
	 * Build the active, compaction-aware entry list for context/rendering.
	 * Uses tree traversal from current leaf.
	 */
	buildContextEntries(): SessionEntry[] {
		const entries = this.getEntries();
		return buildContextEntries(entries, this.getLeafId(), this.entriesReadProjection ? undefined : this.byId);
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionContext(): SessionContext {
		const entries = this.getEntries();
		return buildSessionContext(entries, this.getLeafId(), this.entriesReadProjection ? undefined : this.byId);
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * Get all session entries (excludes header). Returns a shallow copy.
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[] {
		return this.entriesReadProjection?.() ?? this.getPhysicalEntries();
	}

	/**
	 * Return the append-only physical entries without applying a compatibility
	 * read projection. Storage adapters use this to avoid projecting their own
	 * Foundation envelopes back into the durable source.
	 */
	getPhysicalEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	/** Bind a derived legacy read view while keeping fileEntries as the sole ledger. */
	setEntriesReadProjection(
		projection: (() => SessionEntry[]) | undefined,
		leafIdProjection?: () => string | null,
		canonicalLeafIdProjection?: () => string | null,
		canonicalLanesProjection?: () => ReadonlyMap<string, string | null>,
	): void {
		this.entriesReadProjection = projection;
		this.legacyLeafIdReadProjection = leafIdProjection;
		this.leafIdReadProjection = canonicalLeafIdProjection;
		this.lanesReadProjection = canonicalLanesProjection;
	}

	/**
	 * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// Build tree
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan - treat as root
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		this.assertWritesAllowed();
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		this.assertWritesAllowed();
		this.leafId = null;
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			usage,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to the specified leaf.
	 * Useful for extracting a single conversation path from a branched session.
	 * Returns the new session file path, or undefined if not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// Filter out LabelEntry from path - we'll recreate them from the resolved map.
		// Because labels are real tree entries, later entries can be children of labels;
		// removing labels requires re-chaining the retained path to avoid orphaned subtrees.
		const pathWithoutLabels: SessionEntry[] = [];
		let pathParentId: string | null = null;
		for (const entry of path) {
			if (entry.type === "label") continue;
			pathWithoutLabels.push({ ...entry, parentId: pathParentId });
			pathParentId = entry.id;
		}

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// Collect labels for entries in the path
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			// Build label entries
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			const nextFileEntries: FileEntry[] = [header, ...pathWithoutLabels, ...labelEntries];

			// Only write the file now if it contains an assistant message.
			// Otherwise defer to _persist(), which creates the file on the
			// first assistant response, matching the newSession() contract
			// and avoiding the duplicate-header bug when _persist()'s
			// no-assistant guard later resets flushed to false.
			const hasAssistant = nextFileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
			if (hasAssistant) {
				new SessionWriteCoordinator(newSessionFile, this.getSessionDir()).withWriteLock(() => {
					const fd = openSync(newSessionFile, "wx");
					try {
						for (const entry of nextFileEntries) {
							writeFileSync(fd, `${JSON.stringify(entry)}\n`);
						}
					} finally {
						closeSync(fd);
					}
				});
			}

			this.fileEntries = nextFileEntries;
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();
			this.flushed = hasAssistant;

			return newSessionFile;
		}

		// In-memory mode: replace current session with the path + labels
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.aos-agent/agent/sessions/<encoded-cwd>/).
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		let header: SessionHeader | null = null;
		let preloadedFileEntries: FileEntry[] | undefined;
		if (cwdOverride === undefined && existsSync(resolvedPath)) {
			try {
				header = readSessionHeader(resolvedPath);
			} catch (error) {
				if (!(error instanceof SessionHeaderScanLimitError)) throw error;
				// The bounded scan is only a discovery optimization. A full load remains
				// authoritative for legacy files with very large headers or prefixes.
				preloadedFileEntries = loadSessionEntriesForOpen(resolvedPath, resolve(resolvedPath, ".."));
				const firstEntry = preloadedFileEntries[0];
				header = firstEntry?.type === "session" ? firstEntry : null;
			}
		}
		const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
		// If no sessionDir provided, derive from file's parent directory
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return initializeSessionReadProjection(
			new SessionManager(cwd, dir, resolvedPath, true, undefined, preloadedFileEntries),
		);
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.aos-agent/agent/sessions/<encoded-cwd>/).
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const mostRecent = findMostRecentSession(dir, filterCwd ? cwd : undefined);
		if (mostRecent) {
			return initializeSessionReadProjection(new SessionManager(cwd, dir, mostRecent, true));
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	/** Create an in-memory session (no file persistence) */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options);
	}

	/**
	 * Create an independent manager over the current append-only state.
	 *
	 * Transactional reload uses this snapshot so candidate writes cannot mutate
	 * the current manager's in-memory tree before the candidate is published.
	 * Persisted snapshots retain the same target file; the transition owner must
	 * stage and restore that artifact if the candidate fails before commit.
	 */
	createDetachedSnapshot(cwdOverride?: string): SessionManager {
		const snapshot = new SessionManager(cwdOverride ?? this.cwd, "", undefined, false);
		snapshot.sessionId = this.sessionId;
		snapshot.sessionFile = this.sessionFile;
		snapshot.sessionDir = this.sessionDir;
		snapshot.persist = this.persist;
		snapshot.flushed = this.flushed;
		snapshot.fileEntries = structuredClone(this.fileEntries);
		snapshot._buildIndex();
		snapshot.leafId = this.leafId;
		snapshot.detachedSource = this;
		snapshot.detachedBaseEntryCount = snapshot.fileEntries.length;
		snapshot.detachedBaseLeafId = snapshot.leafId;
		snapshot.detachedBaseCanonicalLeafIds = this.getCanonicalLaneLeafIds();
		return initializeSessionReadProjection(snapshot);
	}

	/** @internal Whether this manager is a staged snapshot of the supplied writer. */
	isDetachedSnapshotOf(source: SessionManager): boolean {
		return this.detachedSource === source;
	}

	/**
	 * Publish a detached reload snapshot through its original physical writer.
	 * Candidate writes remain memory-only until this synchronous commit, while
	 * accepted source writes are merged before the candidate becomes current.
	 */
	commitDetachedSnapshot(source: SessionManager): void {
		if (this.detachedSource !== source) {
			throw new TypeError("Detached Session snapshot does not belong to the current writer");
		}
		if (this.sessionFile !== source.sessionFile || this.persist !== source.persist) {
			throw new TypeError("Detached Session snapshot storage does not match its current writer");
		}
		const candidateDelta = structuredClone(this.fileEntries.slice(this.detachedBaseEntryCount));
		const sourceEntries = structuredClone(source.fileEntries);
		const sourceIds = new Set(this.collectDurableIds(sourceEntries));
		const candidateIds = new Set<string>();
		for (const id of this.collectDurableIds(candidateDelta)) {
			if (sourceIds.has(id) || candidateIds.has(id)) {
				throw new Error(`Detached Session snapshot durable id collides with source entry ${id}`);
			}
			candidateIds.add(id);
		}
		const firstCandidateEntry = candidateDelta.find((entry): entry is SessionEntry => entry.type !== "session");
		if (firstCandidateEntry?.parentId === this.detachedBaseLeafId) {
			firstCandidateEntry.parentId = source.leafId;
		}
		const sourceCanonicalLeafIds = source.getCanonicalLaneLeafIds();
		const candidateTouchedLanes = new Set<string>();
		for (let index = 0; index < candidateDelta.length; index += 1) {
			const entry = candidateDelta[index]!;
			if (entry.type !== "custom" || !isRecord(entry.data)) continue;
			if (
				entry.customType === "__aos.foundation.lane.v1" &&
				entry.data.kind === "lane" &&
				typeof entry.data.lane === "string"
			) {
				if (
					this.detachedBaseCanonicalLeafIds.has(entry.data.lane) &&
					sourceCanonicalLeafIds.has(entry.data.lane) &&
					entry.data.leafId === this.detachedBaseCanonicalLeafIds.get(entry.data.lane)
				) {
					entry.data.leafId = sourceCanonicalLeafIds.get(entry.data.lane) ?? null;
					continue;
				}
				candidateTouchedLanes.add(entry.data.lane);
				continue;
			}
			if (
				entry.customType !== "__aos.foundation.entry.v1" ||
				entry.data.kind !== "entry" ||
				!isRecord(entry.data.entry)
			) continue;
			let advancedLane = "main";
			for (const following of candidateDelta.slice(index + 1)) {
				if (
					following.type === "custom" &&
					following.customType === "__aos.foundation.entry.v1" &&
					isRecord(following.data) &&
					following.data.kind === "entry"
				) break;
				if (
					following.type === "custom" &&
					following.customType === "__aos.foundation.lane.v1" &&
					isRecord(following.data) &&
					following.data.kind === "lane" &&
					typeof following.data.lane === "string" &&
					following.data.leafId === entry.data.entry.id
				) {
					advancedLane = following.data.lane;
					break;
				}
			}
			if (candidateTouchedLanes.has(advancedLane)) continue;
			candidateTouchedLanes.add(advancedLane);
			if (
				this.detachedBaseCanonicalLeafIds.has(advancedLane) &&
				sourceCanonicalLeafIds.has(advancedLane) &&
				entry.data.entry.parentId === this.detachedBaseCanonicalLeafIds.get(advancedLane)
			) {
				entry.data.entry.parentId = sourceCanonicalLeafIds.get(advancedLane) ?? null;
			}
		}
		const merged = [...sourceEntries, ...candidateDelta];
		this.normalizeFoundationSequences(merged);
		const hasAssistant = merged.some((entry) => entry.type === "message" && entry.message.role === "assistant");
		const shouldWrite = source.flushed || this.detachedFlushRequested || hasAssistant;

		source._withWriteLock(() => {
			if (!source.persist || !source.sessionFile || !shouldWrite) return;
			if (source.flushed && existsSync(source.sessionFile)) {
				if (candidateDelta.length > 0) {
					appendFileSync(source.sessionFile, candidateDelta.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
				}
				return;
			}
			const fd = openSync(source.sessionFile, "w");
			try {
				for (const entry of merged) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			} finally {
				closeSync(fd);
			}
		});

		this.fileEntries = merged;
		this.flushed = source.persist ? shouldWrite : source.flushed;
		this._buildIndex();
		this.detachedSource = undefined;
		this.detachedBaseEntryCount = 0;
		this.detachedBaseLeafId = null;
		this.detachedBaseCanonicalLeafIds.clear();
		this.detachedFlushRequested = false;
	}

	private collectDurableIds(entries: readonly FileEntry[]): string[] {
		const ids: string[] = [];
		for (const entry of entries) {
			if (entry.type === "session") continue;
			ids.push(entry.id);
			if (entry.type !== "custom" || !isRecord(entry.data)) continue;
			if (
				entry.customType === "__aos.foundation.entry.v1" &&
				entry.data.kind === "entry" &&
				isRecord(entry.data.entry) &&
				typeof entry.data.entry.id === "string"
			) ids.push(entry.data.entry.id);
			if (
				(entry.customType === "__aos.foundation.record.v1" ||
					entry.customType === "__aos.foundation.durable.v1") &&
				(entry.data.kind === "record" || entry.data.kind === "durable") &&
				isRecord(entry.data.record) &&
				typeof entry.data.record.id === "string"
			) ids.push(entry.data.record.id);
		}
		return ids;
	}

	private normalizeFoundationSequences(entries: FileEntry[]): void {
		let sequence = 0;
		for (const entry of entries) {
			if (entry.type === "session") continue;
			sequence += 1;
			if (entry.type !== "custom" || !isRecord(entry.data)) continue;
			if (
				entry.customType === "__aos.foundation.entry.v1" &&
				entry.data.kind === "entry" &&
				isRecord(entry.data.entry)
			) {
				entry.data.entry.seq = sequence;
			}
			if (
				entry.customType === "__aos.foundation.record.v1" &&
				entry.data.kind === "record" &&
				isRecord(entry.data.record)
			) {
				entry.data.record.seq = sequence;
			}
			if (
				entry.customType === "__aos.foundation.durable.v1" &&
				entry.data.kind === "durable" &&
				isRecord(entry.data.record)
			) {
				entry.data.record.seq = sequence;
			}
		}
	}

	/** @internal Keep disposal-local facts in memory after a same-file swap. */
	retireWrites(): void {
		this.writesRetired = true;
	}

	/** @internal Fence a replaced physical writer after its scope is unpublished. */
	pauseWrites(): void {
		this.writesPaused = true;
	}

	/** @internal Restore the old writer after a failed pre-commit transition. */
	resumeWrites(): void {
		this.writesPaused = false;
	}

	/**
	 * @internal Stage a candidate file rollback under the Session write lock.
	 * When the current manager writes after staging, its in-memory ledger is the
	 * authoritative rollback source so those concurrent old-scope writes survive.
	 */
	static stageArtifactRollback(
		filePath: string | undefined,
		concurrentWriter?: SessionManager,
	): { commit(): void; rollback(): void } | undefined {
		if (filePath === undefined) return undefined;
		const resolvedFilePath = resolvePath(filePath);
		if (
			concurrentWriter !== undefined &&
			(concurrentWriter.sessionFile === undefined || resolvePath(concurrentWriter.sessionFile) !== resolvedFilePath)
		) {
			throw new TypeError("Concurrent Session writer must own the staged artifact path");
		}
		const coordinator = new SessionWriteCoordinator(resolvedFilePath, resolve(resolvedFilePath, ".."));
		let originalContents: Buffer | undefined;
		let originalWriterEntryCount: number | undefined;
		coordinator.withWriteLock(() => {
			originalContents = existsSync(resolvedFilePath) ? readFileSync(resolvedFilePath) : undefined;
			originalWriterEntryCount = concurrentWriter?.getPhysicalEntries().length;
		});
		let settled = false;
		return {
			commit: () => {
				settled = true;
			},
			rollback: () => {
				if (settled) return;
				coordinator.withWriteLock(() => {
					if (
						concurrentWriter !== undefined &&
						originalWriterEntryCount !== concurrentWriter.getPhysicalEntries().length
					) {
						if (!concurrentWriter.flushed) {
							if (existsSync(resolvedFilePath)) unlinkSync(resolvedFilePath);
						} else {
							concurrentWriter._rewriteFileUnlocked();
						}
						return;
					}
					if (originalContents === undefined) {
						if (existsSync(resolvedFilePath)) unlinkSync(resolvedFilePath);
						return;
					}
					writeFileSync(resolvedFilePath, originalContents);
				});
				settled = true;
			},
		};
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Create new session file with new ID but forked content
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// Write new header pointing to source as parent, with updated cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		new SessionWriteCoordinator(newSessionFile, dir).withWriteLock(() => {
			writeFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`, { flag: "wx" });

			// Copy all non-header entries from source
			for (const entry of sourceEntries) {
				if (entry.type !== "session") {
					appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
				}
			}
		});

		return initializeSessionReadProjection(
			new SessionManager(resolvedTargetCwd, dir, newSessionFile, true),
		);
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.aos-agent/agent/sessions/<encoded-cwd>/).
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const resolvedCwd = resolvePath(cwd);
		const sessions = (await listSessionsFromDir(dir, onProgress)).filter(
			(session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd),
		);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	/**
	 * List all sessions across all project directories.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgress?: SessionListProgress,
	): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
		const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
		if (customSessionDir) {
			const sessions = await listSessionsFromDir(customSessionDir, progress);
			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		}

		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) {
				return [];
			}
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const dirs = entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => join(sessionsDir, entry.name));

			// Count total files first for accurate progress
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					dirFiles.push([]);
				}
			}

			// Process all files with progress tracking
			let loaded = 0;
			const sessions: SessionInfo[] = [];
			const allFiles = dirFiles.flat();

			const results = await buildSessionInfosWithConcurrency(allFiles, () => {
				loaded++;
				progress?.(loaded, totalFiles);
			});

			for (const info of results) {
				if (info) {
					sessions.push(info);
				}
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		} catch {
			return [];
		}
	}
}
