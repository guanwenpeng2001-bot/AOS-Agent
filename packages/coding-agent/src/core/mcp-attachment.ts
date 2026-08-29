import type { AgentMessage } from "@aos-agent/agent-core";
import {
	type MCPContentProvenance,
	type MCPGetPromptResult,
	type MCPNormalizedContentBlock,
	type MCPReadResourceResult,
	isValidMCPBase64,
	isWellFormedMCPText,
	mcpDigestHex,
	mcpDigestId,
	normalizeMCPMimeType,
	sanitizeMCPText,
} from "./mcp-content.ts";
import type { ContextSourceInput } from "./session/context-engine.ts";
import { DEFAULT_MCP_CONTENT_LIMITS } from "./mcp-types.ts";

export const MCP_ATTACHMENT_SCHEMA_VERSION = 1 as const;
export const MCP_ATTACHMENT_CUSTOM_TYPE = "mcp.attachment" as const;

export interface McpAttachmentAddRecord {
	readonly schemaVersion: typeof MCP_ATTACHMENT_SCHEMA_VERSION;
	readonly kind: "add";
	readonly attachment: McpAttachment;
}

export interface McpAttachmentTombstone {
	readonly schemaVersion: typeof MCP_ATTACHMENT_SCHEMA_VERSION;
	readonly kind: "remove";
	readonly attachmentId: string;
}

export type McpAttachmentPersistedRecord = McpAttachmentAddRecord | McpAttachmentTombstone;

export class McpAttachmentRecordError extends Error {
	readonly code: "mcp_attachment_malformed" | "mcp_attachment_unknown_schema" | "mcp_attachment_unknown_kind";

	constructor(code: McpAttachmentRecordError["code"]) {
		super(code === "mcp_attachment_unknown_schema"
			? "MCP attachment record uses an unsupported schema version."
			: code === "mcp_attachment_unknown_kind"
				? "MCP attachment record uses an unsupported kind."
				: "MCP attachment record is malformed.");
		this.name = "McpAttachmentRecordError";
		this.code = code;
	}
}

/**
 * Structured external attachment: the explicit, session-owned result of an
 * MCP readResource / getPrompt after D's content normalization.
 *
 * The wrapper is untrusted by construction: `provenance.untrusted` is always
 * true and every field is digest/metadata only — the raw URI, prompt name,
 * argument values, and remote text never leave the read/get call. The block
 * allowlist keeps only attachable text/image blocks; unattached metadata
 * (blobs, audio, resource links) is never attachable.
 */
export type McpAttachmentKind = "resource" | "prompt";

export interface McpAttachment {
	/** Deterministic digest id: kind + source digest id + content digest. */
	id: string;
	kind: McpAttachmentKind;
	serverId: string;
	/** Digest id of the source resource or prompt; never the raw URI or name. */
	sourceId: string;
	/** Untrusted provenance wrapper of the normalized read/get result. */
	provenance: MCPContentProvenance;
	/** SHA-256 hex digest over all normalized blocks of the read/get result. */
	contentDigest: string;
	/** Total normalized byte count of the read/get result. */
	byteCount: number;
	/** Total normalized block count of the read/get result. */
	blockCount: number;
	/**
	 * Opaque capability binding id of the frozen binding that authorized the
	 * attach. Recorded for Run receipt / Audit correlation; never secrets.
	 */
	capabilityBindingId: string;
	/**
	 * Opaque execution policy binding id that authorized the attach. Recorded
	 * for Run receipt / Audit correlation; never secrets.
	 */
	policyBindingId: string;
	/**
	 * Opaque capability descriptor id of the binding-selected source that
	 * authorized this attach. Digest-derived; never the raw URI or name.
	 */
	descriptorId?: string;
	/** Descriptor revision the frozen binding held at attach time. */
	descriptorRevision?: string;
	/**
	 * Distinct normalized MIME types across the normalized blocks, when any
	 * block carries one (image/unattached). MIME types are bounded validated
	 * tokens; a text-only read/get result has none.
	 */
	mimeTypes?: ReadonlyArray<string>;
	/**
	 * Block allowlist result: only attachable text/image blocks. Unattached
	 * metadata blocks are excluded and never dereferenced or rendered.
	 */
	attachableBlocks: ReadonlyArray<MCPNormalizedContentBlock>;
	/** Joined attachable text; the only content that can enter the context engine. */
	text: string;
	createdAt: string;
}

function attachmentId(kind: McpAttachmentKind, sourceId: string, contentDigest: string): string {
	return mcpDigestId(`mcp:attachment:${kind}\u0000${sourceId}\u0000${contentDigest}`);
}

function persistedRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new McpAttachmentRecordError("mcp_attachment_malformed");
	}
	return value as Record<string, unknown>;
}

function validSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizePersistedAttachment(value: unknown): McpAttachment {
	const attachment = persistedRecord(value);
	if (
		(attachment.kind !== "resource" && attachment.kind !== "prompt") ||
		typeof attachment.id !== "string" ||
		typeof attachment.serverId !== "string" ||
		typeof attachment.sourceId !== "string" ||
		typeof attachment.contentDigest !== "string" ||
		typeof attachment.capabilityBindingId !== "string" ||
		typeof attachment.policyBindingId !== "string" ||
		!validSafeInteger(attachment.byteCount) ||
		!validSafeInteger(attachment.blockCount) ||
		attachment.byteCount > DEFAULT_MCP_CONTENT_LIMITS.maxAttachmentBytes ||
		attachment.blockCount > DEFAULT_MCP_CONTENT_LIMITS.maxBlocks ||
		!validTimestamp(attachment.createdAt) ||
		!Array.isArray(attachment.attachableBlocks) ||
		typeof attachment.text !== "string" ||
		!isWellFormedMCPText(attachment.text) ||
		sanitizeMCPText(attachment.text) !== attachment.text
	) {
		throw new McpAttachmentRecordError("mcp_attachment_malformed");
	}
	const provenance = persistedRecord(attachment.provenance);
	if (
		provenance.serverId !== attachment.serverId ||
		provenance.source !== attachment.kind ||
		provenance.sourceId !== attachment.sourceId ||
		provenance.contentDigest !== attachment.contentDigest ||
		provenance.byteCount !== attachment.byteCount ||
		provenance.blockCount !== attachment.blockCount ||
		provenance.untrusted !== true ||
		!validTimestamp(provenance.receivedAt) ||
		attachment.id !== attachmentId(attachment.kind, attachment.sourceId, attachment.contentDigest)
	) {
		throw new McpAttachmentRecordError("mcp_attachment_malformed");
	}
	const blocks: MCPNormalizedContentBlock[] = attachment.attachableBlocks.map((candidate) => {
		const block = persistedRecord(candidate);
		if (block.kind === "text") {
			if (
				typeof block.text !== "string" ||
				!isWellFormedMCPText(block.text) ||
				sanitizeMCPText(block.text) !== block.text ||
				!validSafeInteger(block.bytes) ||
				block.bytes !== Buffer.byteLength(block.text, "utf8") ||
				block.digest !== mcpDigestHex(block.text)
			) throw new McpAttachmentRecordError("mcp_attachment_malformed");
			return { kind: "text", text: block.text, bytes: block.bytes, digest: block.digest as string };
		}
		if (block.kind === "image") {
			const mimeType = normalizeMCPMimeType(block.mimeType);
			if (
				typeof block.data !== "string" ||
				!isValidMCPBase64(block.data) ||
				mimeType === undefined ||
				!validSafeInteger(block.bytes) ||
				block.digest !== mcpDigestHex(block.data)
			) throw new McpAttachmentRecordError("mcp_attachment_malformed");
			return { kind: "image", data: block.data, mimeType, bytes: block.bytes, digest: block.digest as string };
		}
		throw new McpAttachmentRecordError("mcp_attachment_malformed");
	});
	const text = blocks
		.filter((block): block is Extract<MCPNormalizedContentBlock, { kind: "text" }> => block.kind === "text")
		.map((block) => block.text)
		.join("\n\n");
	if (text !== attachment.text) throw new McpAttachmentRecordError("mcp_attachment_malformed");
	return structuredClone({ ...attachment, provenance, attachableBlocks: blocks }) as unknown as McpAttachment;
}

export function serializeMcpAttachmentRecord(attachment: McpAttachment): McpAttachmentAddRecord {
	return { schemaVersion: MCP_ATTACHMENT_SCHEMA_VERSION, kind: "add", attachment: normalizePersistedAttachment(attachment) };
}

export function createMcpAttachmentTombstone(attachmentIdValue: string): McpAttachmentTombstone {
	if (typeof attachmentIdValue !== "string" || attachmentIdValue.length === 0) {
		throw new McpAttachmentRecordError("mcp_attachment_malformed");
	}
	return { schemaVersion: MCP_ATTACHMENT_SCHEMA_VERSION, kind: "remove", attachmentId: attachmentIdValue };
}

export function normalizeMcpAttachmentRecord(value: unknown): McpAttachmentPersistedRecord {
	const record = persistedRecord(value);
	if (record.schemaVersion !== MCP_ATTACHMENT_SCHEMA_VERSION) {
		throw new McpAttachmentRecordError("mcp_attachment_unknown_schema");
	}
	if (record.kind === "add") {
		return { schemaVersion: MCP_ATTACHMENT_SCHEMA_VERSION, kind: "add", attachment: normalizePersistedAttachment(record.attachment) };
	}
	if (record.kind === "remove") {
		return createMcpAttachmentTombstone(typeof record.attachmentId === "string" ? record.attachmentId : "");
	}
	throw new McpAttachmentRecordError("mcp_attachment_unknown_kind");
}

export interface McpAttachmentFoldResult {
	readonly attachments: ReadonlyArray<McpAttachment>;
	readonly byId: ReadonlyMap<string, McpAttachment>;
	readonly tombstones: ReadonlySet<string>;
}

export function foldMcpAttachmentEntries(entries: ReadonlyArray<unknown>): McpAttachmentFoldResult {
	const byId = new Map<string, McpAttachment>();
	const tombstones = new Set<string>();
	for (const candidate of entries) {
		const entry = persistedRecord(candidate);
		if (entry.type !== "custom" || entry.customType !== MCP_ATTACHMENT_CUSTOM_TYPE) continue;
		const record = normalizeMcpAttachmentRecord(entry.data);
		if (record.kind === "remove") {
			tombstones.add(record.attachmentId);
			byId.delete(record.attachmentId);
		} else if (!tombstones.has(record.attachment.id) && !byId.has(record.attachment.id)) {
			byId.set(record.attachment.id, record.attachment);
		}
	}
	return { attachments: [...byId.values()], byId, tombstones };
}

/** Opaque binding ids of the frozen bindings that authorized an attach. */
export interface McpAttachmentBindingRefs {
	capabilityBindingId: string;
	policyBindingId: string;
	/** Opaque capability descriptor id of the binding-selected source. */
	descriptorId?: string;
	/** Descriptor revision the frozen binding held at attach time. */
	descriptorRevision?: string;
}

/** Distinct normalized MIME types of the normalized blocks, in encounter order. */
function mimeTypesOf(blocks: ReadonlyArray<MCPNormalizedContentBlock>): string[] {
	const seen = new Set<string>();
	const mimeTypes: string[] = [];
	for (const block of blocks) {
		if (block.kind === "image") {
			if (!seen.has(block.mimeType)) {
				seen.add(block.mimeType);
				mimeTypes.push(block.mimeType);
			}
		} else if (block.kind === "unattached" && block.mimeType !== undefined) {
			if (!seen.has(block.mimeType)) {
				seen.add(block.mimeType);
				mimeTypes.push(block.mimeType);
			}
		}
	}
	return mimeTypes;
}

/** Block allowlist: text and image blocks are attachable; everything else is not. */
function attachableBlocksOf(blocks: ReadonlyArray<MCPNormalizedContentBlock>): MCPNormalizedContentBlock[] {
	return blocks.filter((block) => block.kind === "text" || block.kind === "image");
}

function attachableTextOf(blocks: ReadonlyArray<MCPNormalizedContentBlock>): string {
	return blocks
		.filter((block): block is Extract<MCPNormalizedContentBlock, { kind: "text" }> => block.kind === "text")
		.map((block) => block.text)
		.join("\n\n");
}

/** Wrap a normalized readResource result into a structured external attachment. */
export function wrapMcpResourceAttachment(
	result: MCPReadResourceResult,
	bindingRefs: McpAttachmentBindingRefs,
	createdAt = new Date().toISOString(),
): McpAttachment {
	const blocks = attachableBlocksOf(result.contents);
	const mimeTypes = mimeTypesOf(result.contents);
	return {
		id: attachmentId("resource", result.resourceId, result.provenance.contentDigest),
		kind: "resource",
		serverId: result.serverId,
		sourceId: result.resourceId,
		provenance: result.provenance,
		contentDigest: result.provenance.contentDigest,
		byteCount: result.provenance.byteCount,
		blockCount: result.provenance.blockCount,
		capabilityBindingId: bindingRefs.capabilityBindingId,
		policyBindingId: bindingRefs.policyBindingId,
		descriptorId: bindingRefs.descriptorId,
		descriptorRevision: bindingRefs.descriptorRevision,
		...(mimeTypes.length === 0 ? {} : { mimeTypes }),
		attachableBlocks: blocks,
		text: attachableTextOf(blocks),
		createdAt,
	};
}

/** Wrap a normalized getPrompt result into a structured external attachment. */
export function wrapMcpPromptAttachment(
	result: MCPGetPromptResult,
	bindingRefs: McpAttachmentBindingRefs,
	createdAt = new Date().toISOString(),
): McpAttachment {
	const blocks = attachableBlocksOf(result.messages.flatMap((message) => message.blocks));
	const mimeTypes = mimeTypesOf(result.messages.flatMap((message) => message.blocks));
	return {
		id: attachmentId("prompt", result.promptId, result.provenance.contentDigest),
		kind: "prompt",
		serverId: result.serverId,
		sourceId: result.promptId,
		provenance: result.provenance,
		contentDigest: result.provenance.contentDigest,
		byteCount: result.provenance.byteCount,
		blockCount: result.provenance.blockCount,
		capabilityBindingId: bindingRefs.capabilityBindingId,
		policyBindingId: bindingRefs.policyBindingId,
		descriptorId: bindingRefs.descriptorId,
		descriptorRevision: bindingRefs.descriptorRevision,
		...(mimeTypes.length === 0 ? {} : { mimeTypes }),
		attachableBlocks: blocks,
		text: attachableTextOf(blocks),
		createdAt,
	};
}

/**
 * Session-owned attachment registry. Attaching the same content twice is
 * idempotent: the deterministic digest id resolves to the existing attachment.
 */
export class McpAttachmentRegistry {
	private readonly attachments = new Map<string, McpAttachment>();

	/** Registers an attachment; re-attaching the same digest id keeps the first. */
	attach(attachment: McpAttachment): McpAttachment {
		const existing = this.attachments.get(attachment.id);
		if (existing !== undefined) {
			return existing;
		}
		this.attachments.set(attachment.id, attachment);
		return attachment;
	}

	/** Snapshot of all registered attachments in insertion order. */
	list(): ReadonlyArray<McpAttachment> {
		return [...this.attachments.values()];
	}

	get(attachmentId: string): McpAttachment | undefined {
		return this.attachments.get(attachmentId);
	}

	/** Removes one attachment; resolves false when it was not registered. */
	detach(attachmentId: string): boolean {
		return this.attachments.delete(attachmentId);
	}

	clear(): void {
		this.attachments.clear();
	}
}

/**
 * Convert one structured external attachment into a Context Engine source.
 *
 * The source is message-placed, never system-placed: attached remote content
 * must not mutate system or developer instructions. Trust is `user_owned`
 * because the user explicitly attached the content; the untrusted provenance
 * of the remote read/get stays on the {@link McpAttachment} record itself.
 * Attachments are required so an oversized one fails the run start with
 * `context_budget_exceeded` instead of being silently trimmed. The engine
 * digests and estimates only the allowlisted attachable text. The opaque
 * capability and policy binding ids of the authorizing bindings are carried
 * onto the source and its receipt for Run/Audit correlation.
 */
export function createMcpAttachmentContextSourceInput(attachment: McpAttachment): ContextSourceInput {
	const createdAt = Date.parse(attachment.createdAt);
	const message: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: attachment.text }],
		timestamp: Number.isFinite(createdAt) ? createdAt : Date.now(),
	};
	return {
		sourceId: attachment.id,
		kind: "attachment",
		scope: "session",
		trust: "user_owned",
		label: `mcp:${attachment.kind}:${attachment.serverId}`,
		content: attachment.text,
		required: true,
		placement: "message",
		message,
		capabilityId: attachment.descriptorId,
		capabilityRevision: attachment.descriptorRevision,
		capabilityBindingId: attachment.capabilityBindingId,
		policyBindingId: attachment.policyBindingId,
		byteCount: attachment.byteCount,
		blockCount: attachment.blockCount,
		...(attachment.mimeTypes === undefined || attachment.mimeTypes.length === 0
			? {}
			: { mimeTypes: [...attachment.mimeTypes] }),
	};
}
