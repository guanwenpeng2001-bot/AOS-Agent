/**
 * Explicit session / project memory for Context Engine v1.
 *
 * Memory is default-off, user-explicit, and revocable. There is no API that
 * extracts memory from model replies, tool results, or project files.
 *
 * - Session scope: Session custom entries (`context.memory`), append-only fold.
 * - Project scope: user-private JSONL under the agent dir, keyed by hashed
 *   canonical project root. Never writes into the project working tree.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import {
	digestContextContent,
	estimateContextTextTokens,
	type ContextSourceInput,
} from "./context-engine.ts";

export const CONTEXT_MEMORY_CUSTOM_TYPE = "context.memory";
export const CONTEXT_MEMORY_SCHEMA_VERSION = 1 as const;

export type ContextMemoryScope = "session" | "project";
export type ContextMemoryStatus = "active" | "revoked";

export interface ContextMemory {
	schemaVersion: typeof CONTEXT_MEMORY_SCHEMA_VERSION;
	id: string;
	scope: ContextMemoryScope;
	text: string;
	sourceEntryIds: string[];
	createdAt: string;
	expiresAt?: string;
	status: ContextMemoryStatus;
}

export interface ExplicitContextMemoryWrite {
	scope: ContextMemoryScope;
	text: string;
	sourceEntryIds?: string[];
	expiresAt?: string;
	/** Required for session scope persistence. */
	sessionId?: string;
	/** Required for project scope isolation. */
	projectRoot?: string;
	/** Session custom-entry append hook (session scope only). */
	appendSessionEntry?: (customType: string, data: unknown) => string;
	/** Optional clock for tests. */
	now?: () => Date;
	/** Optional id factory for tests. */
	createId?: () => string;
}

export interface ContextMemoryListInput {
	scope: ContextMemoryScope;
	sessionId?: string;
	projectRoot?: string;
	/** Session entries for folding session memory (session scope). */
	sessionCustomEntries?: ReadonlyArray<{ customType: string; data?: unknown }>;
	/** Include revoked tombstones (default false). */
	includeRevoked?: boolean;
	/** Agent dir override for project store location (tests). */
	agentDir?: string;
	now?: () => Date;
}

export interface ContextMemoryRevokeInput {
	id: string;
	scope: ContextMemoryScope;
	sessionId?: string;
	projectRoot?: string;
	appendSessionEntry?: (customType: string, data: unknown) => string;
	agentDir?: string;
	now?: () => Date;
}

type MemoryLedgerKind = "add" | "revoke";

interface MemoryLedgerEntry {
	schemaVersion: typeof CONTEXT_MEMORY_SCHEMA_VERSION;
	kind: MemoryLedgerKind;
	memory?: ContextMemory;
	id?: string;
	at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMemory(value: unknown): ContextMemory | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.schemaVersion !== CONTEXT_MEMORY_SCHEMA_VERSION) {
		return undefined;
	}
	if (typeof value.id !== "string" || typeof value.text !== "string") {
		return undefined;
	}
	if (value.scope !== "session" && value.scope !== "project") {
		return undefined;
	}
	if (value.status !== "active" && value.status !== "revoked") {
		return undefined;
	}
	if (typeof value.createdAt !== "string") {
		return undefined;
	}
	if (!Array.isArray(value.sourceEntryIds) || !value.sourceEntryIds.every((id) => typeof id === "string")) {
		return undefined;
	}
	const memory: ContextMemory = {
		schemaVersion: CONTEXT_MEMORY_SCHEMA_VERSION,
		id: value.id,
		scope: value.scope,
		text: value.text,
		sourceEntryIds: value.sourceEntryIds.slice(),
		createdAt: value.createdAt,
		status: value.status,
	};
	if (typeof value.expiresAt === "string") {
		memory.expiresAt = value.expiresAt;
	}
	return memory;
}

function parseLedgerEntry(value: unknown): MemoryLedgerEntry | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.schemaVersion !== CONTEXT_MEMORY_SCHEMA_VERSION) {
		return undefined;
	}
	if (value.kind !== "add" && value.kind !== "revoke") {
		return undefined;
	}
	if (typeof value.at !== "string") {
		return undefined;
	}
	const entry: MemoryLedgerEntry = {
		schemaVersion: CONTEXT_MEMORY_SCHEMA_VERSION,
		kind: value.kind,
		at: value.at,
	};
	if (value.kind === "add") {
		const memory = parseMemory(value.memory);
		if (!memory) {
			return undefined;
		}
		entry.memory = memory;
	} else if (typeof value.id === "string") {
		entry.id = value.id;
	} else {
		return undefined;
	}
	return entry;
}

function foldMemoryLedger(entries: readonly MemoryLedgerEntry[], now: Date, includeRevoked: boolean): ContextMemory[] {
	const byId = new Map<string, ContextMemory>();
	for (const entry of entries) {
		if (entry.kind === "add" && entry.memory) {
			byId.set(entry.memory.id, { ...entry.memory, sourceEntryIds: entry.memory.sourceEntryIds.slice() });
		} else if (entry.kind === "revoke" && entry.id) {
			const existing = byId.get(entry.id);
			if (existing) {
				byId.set(entry.id, { ...existing, status: "revoked" });
			} else {
				// Tombstone without body text for audit of unknown ids.
				byId.set(entry.id, {
					schemaVersion: CONTEXT_MEMORY_SCHEMA_VERSION,
					id: entry.id,
					scope: "session",
					text: "",
					sourceEntryIds: [],
					createdAt: entry.at,
					status: "revoked",
				});
			}
		}
	}

	const nowMs = now.getTime();
	const result: ContextMemory[] = [];
	for (const memory of byId.values()) {
		if (memory.expiresAt) {
			const expiresMs = Date.parse(memory.expiresAt);
			if (!Number.isNaN(expiresMs) && expiresMs <= nowMs && memory.status === "active") {
				// Treat expired as inactive without mutating store.
				if (!includeRevoked) {
					continue;
				}
				result.push({ ...memory, status: "revoked" });
				continue;
			}
		}
		if (memory.status === "revoked" && !includeRevoked) {
			continue;
		}
		if (memory.status === "revoked" && memory.text === "" && !includeRevoked) {
			continue;
		}
		result.push(memory);
	}
	return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Stable hash of a canonical project root for store isolation. */
export function hashProjectRoot(projectRoot: string): string {
	const normalized = canonicalizePath(resolvePath(projectRoot)).replace(/\\/g, "/");
	const canonical = process.platform === "win32" ? normalized.toLowerCase() : normalized;
	return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

export function getProjectMemoryDir(agentDir: string = getAgentDir()): string {
	return join(resolvePath(agentDir), "context-memory", "projects");
}

export function getProjectMemoryFilePath(projectRoot: string, agentDir: string = getAgentDir()): string {
	return join(getProjectMemoryDir(agentDir), `${hashProjectRoot(projectRoot)}.jsonl`);
}

function readProjectLedger(projectRoot: string, agentDir: string): MemoryLedgerEntry[] {
	const filePath = getProjectMemoryFilePath(projectRoot, agentDir);
	if (!existsSync(filePath)) {
		return [];
	}
	const text = readFileSync(filePath, "utf8");
	const entries: MemoryLedgerEntry[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (line.trim().length === 0) {
			continue;
		}
		try {
			const parsed = parseLedgerEntry(JSON.parse(line));
			if (parsed) {
				entries.push(parsed);
			}
		} catch {
			// skip malformed lines
		}
	}
	return entries;
}

function appendProjectLedger(projectRoot: string, entry: MemoryLedgerEntry, agentDir: string): void {
	const dir = getProjectMemoryDir(agentDir);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const filePath = getProjectMemoryFilePath(projectRoot, agentDir);
	appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

function readSessionLedger(sessionCustomEntries: ReadonlyArray<{ customType: string; data?: unknown }>): MemoryLedgerEntry[] {
	const entries: MemoryLedgerEntry[] = [];
	for (const custom of sessionCustomEntries) {
		if (custom.customType !== CONTEXT_MEMORY_CUSTOM_TYPE) {
			continue;
		}
		const parsed = parseLedgerEntry(custom.data);
		if (parsed) {
			entries.push(parsed);
		}
	}
	return entries;
}

/**
 * Explicit memory store. All writes require caller-supplied text; no automatic extraction.
 */
export class ContextMemoryStore {
	private agentDir: string;

	constructor(options?: { agentDir?: string }) {
		this.agentDir = options?.agentDir ?? getAgentDir();
	}

	async list(input: ContextMemoryListInput): Promise<ContextMemory[]> {
		const now = input.now?.() ?? new Date();
		const includeRevoked = input.includeRevoked === true;
		if (input.scope === "session") {
			const ledger = readSessionLedger(input.sessionCustomEntries ?? []);
			return foldMemoryLedger(ledger, now, includeRevoked).map((memory) => ({
				...memory,
				scope: "session",
			}));
		}
		if (!input.projectRoot) {
			return [];
		}
		const agentDir = input.agentDir ?? this.agentDir;
		const ledger = readProjectLedger(input.projectRoot, agentDir);
		return foldMemoryLedger(ledger, now, includeRevoked).map((memory) => ({
			...memory,
			scope: "project",
		}));
	}

	async add(input: ExplicitContextMemoryWrite): Promise<ContextMemory> {
		const text = input.text;
		if (typeof text !== "string" || text.length === 0) {
			throw new Error("context memory text is required for explicit write");
		}
		const now = input.now?.() ?? new Date();
		const id = input.createId?.() ?? randomUUID();
		const memory: ContextMemory = {
			schemaVersion: CONTEXT_MEMORY_SCHEMA_VERSION,
			id,
			scope: input.scope,
			text,
			sourceEntryIds: input.sourceEntryIds?.slice() ?? [],
			createdAt: now.toISOString(),
			status: "active",
		};
		if (input.expiresAt !== undefined) {
			memory.expiresAt = input.expiresAt;
		}

		const ledgerEntry: MemoryLedgerEntry = {
			schemaVersion: CONTEXT_MEMORY_SCHEMA_VERSION,
			kind: "add",
			memory,
			at: memory.createdAt,
		};

		if (input.scope === "session") {
			if (!input.appendSessionEntry) {
				throw new Error("session memory requires appendSessionEntry");
			}
			input.appendSessionEntry(CONTEXT_MEMORY_CUSTOM_TYPE, ledgerEntry);
			return memory;
		}

		if (!input.projectRoot) {
			throw new Error("project memory requires projectRoot");
		}
		// Refuse paths that would write under the project working directory.
		const projectRoot = resolvePath(input.projectRoot);
		const storePath = getProjectMemoryFilePath(projectRoot, this.agentDir);
		const canonicalProject = canonicalizePath(projectRoot).replace(/\\/g, "/");
		const canonicalStore = canonicalizePath(storePath).replace(/\\/g, "/");
		const comparableProject = process.platform === "win32" ? canonicalProject.toLowerCase() : canonicalProject;
		const comparableStore = process.platform === "win32" ? canonicalStore.toLowerCase() : canonicalStore;
		if (comparableStore === comparableProject || comparableStore.startsWith(`${comparableProject}/`)) {
			throw new Error("project memory store must not write into the project working directory");
		}
		appendProjectLedger(projectRoot, ledgerEntry, this.agentDir);
		return memory;
	}

	async revoke(input: ContextMemoryRevokeInput): Promise<void> {
		const now = input.now?.() ?? new Date();
		const ledgerEntry: MemoryLedgerEntry = {
			schemaVersion: CONTEXT_MEMORY_SCHEMA_VERSION,
			kind: "revoke",
			id: input.id,
			at: now.toISOString(),
		};
		if (input.scope === "session") {
			if (!input.appendSessionEntry) {
				throw new Error("session memory revoke requires appendSessionEntry");
			}
			input.appendSessionEntry(CONTEXT_MEMORY_CUSTOM_TYPE, ledgerEntry);
			return;
		}
		if (!input.projectRoot) {
			throw new Error("project memory revoke requires projectRoot");
		}
		appendProjectLedger(input.projectRoot, ledgerEntry, input.agentDir ?? this.agentDir);
	}
}

/** Convert active memory records into Context Engine source inputs. */
export function memoryToContextSourceInputs(
	memories: readonly ContextMemory[],
	options?: { enabled: boolean },
): ContextSourceInput[] {
	const enabled = options?.enabled ?? true;
	return memories.map((memory) => {
		const input: ContextSourceInput = {
			sourceId: `memory:${memory.scope}:${memory.id}`,
			kind: "memory",
			scope: memory.scope === "session" ? "session" : "project",
			trust: "user_owned",
			content: memory.text,
			required: false,
			refId: memory.id,
		};
		if (!enabled) {
			input.preDisposition = { disposition: "excluded", reason: "disabled" };
		} else if (memory.status === "revoked") {
			input.preDisposition = { disposition: "excluded", reason: "revoked" };
		}
		return input;
	});
}

/** Snapshot-safe memory receipt fields (no body text). */
export function memoryReceiptMeta(memory: ContextMemory): {
	refId: string;
	contentDigest: string;
	estimatedTokens: number;
	status: ContextMemoryStatus;
	scope: ContextMemoryScope;
} {
	return {
		refId: memory.id,
		contentDigest: digestContextContent(memory.text),
		estimatedTokens: estimateContextTextTokens(memory.text),
		status: memory.status,
		scope: memory.scope,
	};
}
