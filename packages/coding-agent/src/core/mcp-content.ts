import type { ImageContent, TextContent } from "@aos-agent/ai";
import { createHash } from "node:crypto";
import type {
	MCPContentLimits,
	MCPPromptArgumentSummary,
	MCPPromptSummary,
	MCPResourceSummary,
	MCPResourceTemplateSummary,
} from "./mcp-types.ts";

/**
 * Fixed content-safety error codes. Every message is constructed from a fixed
 * template by {@link MCPContentError}; remote text, raw URIs, argument values,
 * and content bytes never appear in the error, its JSON form, or logs.
 */
export type MCPContentErrorCode =
	| "mcp_content_malformed"
	| "mcp_content_oversize"
	| "mcp_content_unsupported"
	| "mcp_content_encoding"
	| "mcp_content_mime"
	| "mcp_resource_unavailable"
	| "mcp_prompt_unavailable";

/** Redacted, serializable view of a content-safety failure. */
export interface MCPContentErrorView {
	code: MCPContentErrorCode;
	serverId: string;
	message: string;
}

function contentErrorMessage(code: MCPContentErrorCode, serverId: string): string {
	switch (code) {
		case "mcp_content_malformed":
			return `MCP server "${serverId}" returned malformed content`;
		case "mcp_content_oversize":
			return `MCP server "${serverId}" returned content over the safety limits`;
		case "mcp_content_unsupported":
			return `MCP server "${serverId}" returned unsupported content`;
		case "mcp_content_encoding":
			return `MCP server "${serverId}" returned content with an invalid encoding`;
		case "mcp_content_mime":
			return `MCP server "${serverId}" returned content with an invalid MIME type`;
		case "mcp_resource_unavailable":
			return `MCP server "${serverId}" does not support resources`;
		case "mcp_prompt_unavailable":
			return `MCP server "${serverId}" does not support prompts`;
	}
}

/** Fixed content-safety failure. Never retains remote text or raw values. */
export class MCPContentError extends Error {
	readonly code: MCPContentErrorCode;
	readonly serverId: string;

	constructor(code: MCPContentErrorCode, serverId: string) {
		super(contentErrorMessage(code, serverId));
		this.name = "MCPContentError";
		this.code = code;
		this.serverId = serverId;
	}

	toJSON(): MCPContentErrorView {
		return {
			code: this.code,
			serverId: this.serverId,
			message: this.message,
		};
	}
}

/**
 * A content block after validation and normalization. `text` and `image`
 * blocks are attachable; `unattached` blocks carry bounded metadata only and
 * must never be dereferenced or rendered as content.
 */
export type MCPNormalizedContentBlock =
	| { kind: "text"; text: string; bytes: number; digest: string }
	| { kind: "image"; data: string; mimeType: string; bytes: number; digest: string }
	| {
			kind: "unattached";
			reason: "blob" | "audio" | "resource_link" | "embedded_blob";
			bytes: number;
			digest: string;
			mimeType?: string;
			size?: number;
	  };

/** One prompt message with its role preserved; every block is untrusted. */
export interface MCPNormalizedPromptMessage {
	role: "user" | "assistant";
	blocks: ReadonlyArray<MCPNormalizedContentBlock>;
	/** SHA-256 hex digest over the message's normalized blocks. */
	digest: string;
}

/**
 * Provenance of normalized remote content. `untrusted` is always true: remote
 * content is never treated as trusted instructions or data.
 */
export interface MCPContentProvenance {
	serverId: string;
	source: "resource" | "prompt";
	/** Deterministic digest id of the source entry; never a raw URI or name. */
	sourceId: string;
	/** SHA-256 hex digest over all normalized blocks. */
	contentDigest: string;
	byteCount: number;
	blockCount: number;
	untrusted: true;
	receivedAt: string;
}

/** Normalized result of readResource. The raw URI is never retained. */
export interface MCPReadResourceResult {
	serverId: string;
	/** Deterministic digest id of the resource. */
	resourceId: string;
	contents: ReadonlyArray<MCPNormalizedContentBlock>;
	provenance: MCPContentProvenance;
}

/** Normalized result of getPrompt. Argument values are never retained. */
export interface MCPGetPromptResult {
	serverId: string;
	/** Deterministic digest id of the prompt. */
	promptId: string;
	messages: ReadonlyArray<MCPNormalizedPromptMessage>;
	provenance: MCPContentProvenance;
}

// Bounded metadata field limits. Every remote field is sanitized (control
// characters stripped) and truncated to its byte budget; the digest id is the
// authoritative identity.
const MAX_URI_BYTES = 4096;
const MAX_NAME_BYTES = 256;
const MAX_TITLE_BYTES = 512;
const MAX_DESCRIPTION_BYTES = 4096;
const MAX_MIME_BYTES = 128;
const MAX_TEMPLATE_PATTERN_BYTES = 512;
const MAX_ARGUMENT_NAME_BYTES = 256;
const MAX_ARGUMENT_DESCRIPTION_BYTES = 1024;
const MAX_PROMPT_NAME_BYTES = 256;

/** SHA-256 hex digest; used for revisions and content digests. */
export function mcpDigestHex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** SHA-256 base64url digest; used for opaque, secret-free ids. */
export function mcpDigestId(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("base64url");
}

/** Deterministic digest id of a resource; the URI itself is never stored. */
export function mcpResourceId(serverId: string, uri: string): string {
	return mcpDigestId(`mcp:resource:${serverId}\u0000${uri}`);
}

/** Deterministic digest id of a resource template. */
export function mcpResourceTemplateId(serverId: string, uriTemplate: string): string {
	return mcpDigestId(`mcp:resource_template:${serverId}\u0000${uriTemplate}`);
}

/** Deterministic digest id of a prompt. */
export function mcpPromptId(serverId: string, name: string): string {
	return mcpDigestId(`mcp:prompt:${serverId}\u0000${name}`);
}

/**
 * Strips C0 control characters (except tab, LF, CR), C1 control characters,
 * and DEL, and replaces lone surrogates with U+FFFD. Callers that need
 * fail-closed encoding validation check well-formedness with
 * {@link isWellFormedMCPText} before calling this.
 */
export function sanitizeMCPText(value: string): string {
	let out = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		const isC0 = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
		if (isC0 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			continue;
		}
		if (code >= 0xd800 && code <= 0xdfff) {
			out += "\ufffd";
			continue;
		}
		out += char;
	}
	return out;
}

/** True when the string has no lone surrogates. */
export function isWellFormedMCPText(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) {
				return false;
			}
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/**
 * Truncates a string to a UTF-8 byte budget without splitting a code point or
 * a surrogate pair. Used for catalog metadata fields only; content blocks fail
 * closed instead of truncating.
 */
export function truncateMCPField(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) {
		return value;
	}
	let end = value.length;
	while (end > 0) {
		const code = value.charCodeAt(end - 1);
		if (code >= 0xdc00 && code <= 0xdfff && end >= 2) {
			const lead = value.charCodeAt(end - 2);
			if (lead >= 0xd800 && lead <= 0xdbff) {
				end -= 1; // keep the pair together
			}
		}
		end -= 1;
		if (Buffer.byteLength(value.slice(0, end), "utf8") <= maxBytes) {
			return value.slice(0, end);
		}
	}
	return "";
}

/** RFC 7231 token characters of a MIME type/subtype. */
const MIME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validates and normalizes a MIME type: lowercase `type/subtype` without
 * parameters. Returns undefined when the value is absent, invalid, or longer
 * than the field budget.
 */
export function normalizeMCPMimeType(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	if (Buffer.byteLength(value, "utf8") > MAX_MIME_BYTES || !isWellFormedMCPText(value)) {
		return undefined;
	}
	const typeAndSubtype = value.split(";", 1)[0].trim().toLowerCase();
	const slash = typeAndSubtype.indexOf("/");
	if (slash <= 0 || slash === typeAndSubtype.length - 1) {
		return undefined;
	}
	const type = typeAndSubtype.slice(0, slash);
	const subtype = typeAndSubtype.slice(slash + 1);
	if (!MIME_TOKEN.test(type) || !MIME_TOKEN.test(subtype)) {
		return undefined;
	}
	return `${type}/${subtype}`;
}

const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** True when the value is strict base64 with correct padding. */
export function isValidMCPBase64(value: string): boolean {
	return (
		value.length % 4 === 0 &&
		value.length > 0 &&
		STRICT_BASE64.test(value) &&
		(!value.includes("=") || /={1,2}$/.test(value))
	);
}

/** Decoded byte length of strict base64 without allocating the decoded buffer. */
function base64DecodedBytes(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return Math.floor((value.length * 3) / 4) - padding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, serverId: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new MCPContentError("mcp_content_malformed", serverId);
	}
	return value;
}

function requireStringField(
	block: Record<string, unknown>,
	field: string,
	serverId: string,
): string {
	const value = block[field];
	if (typeof value !== "string") {
		throw new MCPContentError("mcp_content_malformed", serverId);
	}
	return value;
}

/** Validates a content MIME type; invalid values fail closed. */
function requireContentMimeType(mimeType: unknown, serverId: string): string | undefined {
	const normalized = normalizeMCPMimeType(mimeType);
	if (normalized === undefined && mimeType !== undefined) {
		throw new MCPContentError("mcp_content_mime", serverId);
	}
	return normalized;
}

/** Validates strict base64 content; invalid values fail closed. */
function requireBase64Content(data: string, serverId: string): void {
	if (!isValidMCPBase64(data)) {
		throw new MCPContentError("mcp_content_encoding", serverId);
	}
}

interface ContentAccumulatorOptions {
	serverId: string;
	limits: MCPContentLimits;
}

/**
 * Accumulates normalized blocks while enforcing the block-count and total-byte
 * limits. Throws {@link MCPContentError} (`mcp_content_oversize`) when a limit
 * is exceeded, so malformed or oversized remote content can never grow memory
 * without bound.
 */
class ContentAccumulator {
	private readonly serverId: string;
	readonly limits: MCPContentLimits;
	private readonly blocks: MCPNormalizedContentBlock[] = [];
	private totalBytes = 0;

	constructor(options: ContentAccumulatorOptions) {
		this.serverId = options.serverId;
		this.limits = options.limits;
	}

	push(block: MCPNormalizedContentBlock): void {
		this.blocks.push(block);
		this.totalBytes += block.bytes;
		if (this.blocks.length > this.limits.maxBlocks) {
			throw new MCPContentError("mcp_content_oversize", this.serverId);
		}
		if (this.totalBytes > this.limits.maxAttachmentBytes) {
			throw new MCPContentError("mcp_content_oversize", this.serverId);
		}
	}

	getBlocks(): MCPNormalizedContentBlock[] {
		return this.blocks;
	}
}

function normalizeTextBlock(
	accumulator: ContentAccumulator,
	serverId: string,
	text: string,
): void {
	if (!isWellFormedMCPText(text)) {
		throw new MCPContentError("mcp_content_encoding", serverId);
	}
	const sanitized = sanitizeMCPText(text);
	const bytes = Buffer.byteLength(sanitized, "utf8");
	if (bytes > accumulator.limits.maxTextBytes) {
		throw new MCPContentError("mcp_content_oversize", serverId);
	}
	accumulator.push({
		kind: "text",
		text: sanitized,
		bytes,
		digest: mcpDigestHex(sanitized),
	});
}

function normalizeImageBlock(
	accumulator: ContentAccumulator,
	serverId: string,
	data: string,
	mimeType: string,
): void {
	requireBase64Content(data, serverId);
	const normalizedMime = requireContentMimeType(mimeType, serverId) ?? "application/octet-stream";
	const bytes = base64DecodedBytes(data);
	if (bytes > accumulator.limits.maxBlobBytes) {
		throw new MCPContentError("mcp_content_oversize", serverId);
	}
	accumulator.push({ kind: "image", data, mimeType: normalizedMime, bytes, digest: mcpDigestHex(data) });
}

function normalizeUnattachedBlock(
	accumulator: ContentAccumulator,
	serverId: string,
	reason: "blob" | "audio" | "resource_link" | "embedded_blob",
	payload: string,
	mimeType?: string,
	size?: number,
): void {
	requireBase64Content(payload, serverId);
	const normalizedMime = normalizeMCPMimeType(mimeType);
	const bytes = base64DecodedBytes(payload);
	if (bytes > accumulator.limits.maxBlobBytes) {
		throw new MCPContentError("mcp_content_oversize", serverId);
	}
	accumulator.push({
		kind: "unattached",
		reason,
		bytes,
		digest: mcpDigestHex(payload),
		...(normalizedMime !== undefined ? { mimeType: normalizedMime } : {}),
		...(Number.isFinite(size) && typeof size === "number" && size >= 0 ? { size } : {}),
	});
}

/**
 * Normalizes one MCP content block (the SDK ContentBlock union) into bounded
 * attachable text/image blocks or non-attachable metadata. Unknown types and
 * invalid structures fail closed with a fixed error. Embedded resource links
 * are never dereferenced; embedded text is part of the returned message.
 */
export function normalizeMCPContentBlock(
	serverId: string,
	block: unknown,
	limits: MCPContentLimits,
	accumulator: ContentAccumulator,
): void {
	const record = requireRecord(block, serverId);
	const type = record.type;
	switch (type) {
		case "text": {
			const text = record.text;
			if (typeof text !== "string") {
				throw new MCPContentError("mcp_content_malformed", serverId);
			}
			normalizeTextBlock(accumulator, serverId, text);
			break;
		}
		case "image": {
			const data = record.data;
			const mimeType = record.mimeType;
			if (typeof data !== "string" || typeof mimeType !== "string") {
				throw new MCPContentError("mcp_content_malformed", serverId);
			}
			normalizeImageBlock(accumulator, serverId, data, mimeType);
			break;
		}
		case "audio": {
			const data = record.data;
			const mimeType = record.mimeType;
			if (typeof data !== "string" || typeof mimeType !== "string") {
				throw new MCPContentError("mcp_content_malformed", serverId);
			}
			requireBase64Content(data, serverId);
			normalizeUnattachedBlock(accumulator, serverId, "audio", data, mimeType);
			break;
		}
		case "resource": {
			const resource = requireRecord(record.resource, serverId);
			requireStringField(resource, "uri", serverId);
			const text = resource.text;
			const blob = resource.blob;
			if (typeof text === "string" && blob === undefined) {
				normalizeTextBlock(accumulator, serverId, text);
			} else if (typeof blob === "string" && text === undefined) {
				normalizeUnattachedBlock(
					accumulator,
					serverId,
					"embedded_blob",
					blob,
					typeof resource.mimeType === "string" ? resource.mimeType : undefined,
				);
			} else {
				throw new MCPContentError("mcp_content_malformed", serverId);
			}
			break;
		}
		case "resource_link": {
			requireStringField(record, "uri", serverId);
			requireStringField(record, "name", serverId);
			const size = record.size;
			const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
			const normalizedMime = normalizeMCPMimeType(mimeType);
			// A resource link is never dereferenced: it becomes non-attachable
			// metadata whose digest covers the link identity, never the URI.
			const uri = record.uri as string;
			const name = record.name as string;
			accumulator.push({
				kind: "unattached",
				reason: "resource_link",
				bytes: 0,
				digest: mcpDigestHex(`resource_link\u0000${uri}\u0000${name}`),
				...(normalizedMime !== undefined ? { mimeType: normalizedMime } : {}),
				...(typeof size === "number" && Number.isFinite(size) && size >= 0 ? { size } : {}),
			});
			break;
		}
		default:
			throw new MCPContentError("mcp_content_unsupported", serverId);
	}
}

/**
 * Normalizes readResource contents (TextResourceContents | BlobResourceContents
 * entries) into bounded blocks. Blob contents become non-attachable metadata;
 * text contents become attachable text blocks.
 */
export function normalizeMCPResourceContents(
	serverId: string,
	contents: ReadonlyArray<unknown>,
	limits: MCPContentLimits,
): MCPNormalizedContentBlock[] {
	const accumulator = new ContentAccumulator({ serverId, limits });
	for (const entry of contents) {
		const record = requireRecord(entry, serverId);
		const uri = record.uri;
		if (typeof uri !== "string" || !isWellFormedMCPText(uri)) {
			throw new MCPContentError("mcp_content_malformed", serverId);
		}
		const text = record.text;
		const blob = record.blob;
		const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
		if (typeof text === "string" && blob === undefined) {
			normalizeTextBlock(accumulator, serverId, text);
		} else if (typeof blob === "string" && text === undefined) {
			normalizeUnattachedBlock(accumulator, serverId, "blob", blob, mimeType);
		} else {
			throw new MCPContentError("mcp_content_malformed", serverId);
		}
	}
	return accumulator.getBlocks();
}

/**
 * Normalizes getPrompt messages, preserving the user/assistant role. Per the
 * SDK 1.30 contract each message carries exactly one content block; arrays or
 * other shapes fail closed. Every block is marked untrusted through the
 * returned provenance; embedded resource links are never dereferenced and
 * never bypass resource policy.
 */
export function normalizeMCPPromptMessages(
	serverId: string,
	messages: ReadonlyArray<unknown>,
	limits: MCPContentLimits,
): MCPNormalizedPromptMessage[] {
	const out: MCPNormalizedPromptMessage[] = [];
	for (const message of messages) {
		const record = requireRecord(message, serverId);
		const role = record.role;
		if (role !== "user" && role !== "assistant") {
			throw new MCPContentError("mcp_content_malformed", serverId);
		}
		const content = record.content;
		if (isRecord(content)) {
			const accumulator = new ContentAccumulator({ serverId, limits });
			normalizeMCPContentBlock(serverId, content, limits, accumulator);
			const blocks = accumulator.getBlocks();
			out.push({
				role,
				blocks,
				digest: mcpDigestHex(blocks.map((block) => `${block.kind}\u0000${block.bytes}\u0000${block.digest}`).join("\n")),
			});
		} else {
			// A content array or any other shape is not the SDK 1.30 prompt
			// message contract; fail closed instead of guessing.
			throw new MCPContentError("mcp_content_malformed", serverId);
		}
	}
	return out;
}

function digestOfBlocks(blocks: ReadonlyArray<MCPNormalizedContentBlock>): string {
	return mcpDigestHex(
		blocks.map((block) => `${block.kind}\u0000${block.bytes}\u0000${block.digest}`).join("\n"),
	);
}

function createProvenance(
	serverId: string,
	source: "resource" | "prompt",
	sourceId: string,
	blocks: ReadonlyArray<MCPNormalizedContentBlock>,
	receivedAt: string,
): MCPContentProvenance {
	return {
		serverId,
		source,
		sourceId,
		contentDigest: digestOfBlocks(blocks),
		byteCount: blocks.reduce((total, block) => total + block.bytes, 0),
		blockCount: blocks.length,
		untrusted: true,
		receivedAt,
	};
}

/** Validates a readResource URI argument. Never retained after the call. */
export function validateMCPResourceUri(uri: unknown, serverId: string): string {
	if (typeof uri !== "string") {
		throw new MCPContentError("mcp_content_malformed", serverId);
	}
	if (uri.length === 0 || Buffer.byteLength(uri, "utf8") > MAX_URI_BYTES || !isWellFormedMCPText(uri)) {
		throw new MCPContentError("mcp_content_malformed", serverId);
	}
	return sanitizeMCPText(uri);
}

/** Validates a getPrompt name argument. Never retained after the call. */
export function validateMCPPromptName(name: unknown, serverId: string): string {
	if (typeof name !== "string") {
		throw new MCPContentError("mcp_content_malformed", serverId);
	}
	const sanitized = sanitizeMCPText(name);
	if (!isWellFormedMCPText(name) || sanitized.length === 0 || Buffer.byteLength(sanitized, "utf8") > MAX_PROMPT_NAME_BYTES) {
		throw new MCPContentError("mcp_content_malformed", serverId);
	}
	return sanitized;
}

/**
 * Validates getPrompt argument values: strings only, per-value and total byte
 * budgets, control characters stripped. Values are never retained after the
 * call.
 */
export function validateMCPPromptArguments(
	args: unknown,
	limits: MCPContentLimits,
	serverId: string,
): Record<string, string> {
	if (args === undefined) {
		return {};
	}
	if (!isRecord(args)) {
		throw new MCPContentError("mcp_content_malformed", serverId);
	}
	const out: Record<string, string> = {};
	let totalBytes = 0;
	for (const [key, value] of Object.entries(args)) {
		if (typeof value !== "string") {
			throw new MCPContentError("mcp_content_malformed", serverId);
		}
		const sanitized = sanitizeMCPText(value);
		const bytes = Buffer.byteLength(sanitized, "utf8");
		if (bytes > limits.maxPromptArgumentBytes) {
			throw new MCPContentError("mcp_content_oversize", serverId);
		}
		totalBytes += bytes;
		if (totalBytes > limits.maxRunAttachmentBytes) {
			throw new MCPContentError("mcp_content_oversize", serverId);
		}
		out[key] = sanitized;
	}
	return out;
}

/** Sanitizes and bounds a catalog metadata field; malformed encodings drop it. */
function sanitizeSummaryField(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	if (!isWellFormedMCPText(value)) {
		return undefined;
	}
	const sanitized = sanitizeMCPText(value);
	if (sanitized.length === 0) {
		return undefined;
	}
	return truncateMCPField(sanitized, maxBytes);
}

function sanitizeSummaryName(value: unknown, serverId: string): string {
	const name = sanitizeSummaryField(value, MAX_NAME_BYTES);
	if (name === undefined) {
		throw new MCPContentError("mcp_content_malformed", serverId);
	}
	return name;
}

/** Strips control characters, userinfo, query, and fragment from a URI template for display. */
function sanitizeUriTemplatePattern(value: string): string | undefined {
	const sanitized = sanitizeMCPText(value);
	if (sanitized.length === 0) {
		return undefined;
	}
	const withoutUserinfo = sanitized.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1");
	const queryIndex = withoutUserinfo.search(/[?#]/);
	const pattern = queryIndex >= 0 ? withoutUserinfo.slice(0, queryIndex) : withoutUserinfo;
	if (pattern.length === 0) {
		return undefined;
	}
	return truncateMCPField(pattern, MAX_TEMPLATE_PATTERN_BYTES);
}

function summaryRevision(fields: ReadonlyArray<string | undefined>): string {
	return mcpDigestHex(fields.map((field) => field ?? "").join("\u0000"));
}

/**
 * Normalizes a listResources page into bounded, secret-free summaries. The raw
 * URI never leaves the call: resourceId is its digest.
 */
export function normalizeMCPResourceSummaries(
	serverId: string,
	resources: ReadonlyArray<unknown>,
	limits: MCPContentLimits,
): MCPResourceSummary[] {
	if (resources.length > limits.maxResourcesPerPage) {
		throw new MCPContentError("mcp_content_oversize", serverId);
	}
	return resources.map((entry) => {
		const record = requireRecord(entry, serverId);
		const uri = record.uri;
		if (typeof uri !== "string" || uri.length === 0 || !isWellFormedMCPText(uri)) {
			throw new MCPContentError("mcp_content_malformed", serverId);
		}
		const name = sanitizeSummaryName(record.name, serverId);
		const title = sanitizeSummaryField(record.title, MAX_TITLE_BYTES);
		const description = sanitizeSummaryField(record.description, MAX_DESCRIPTION_BYTES);
		const mimeType = normalizeMCPMimeType(record.mimeType);
		const rawSize = record.size;
		const size = typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : undefined;
		const resourceId = mcpResourceId(serverId, uri);
		return {
			resourceId,
			serverId,
			name,
			...(title !== undefined ? { title } : {}),
			...(description !== undefined ? { description } : {}),
			...(mimeType !== undefined ? { mimeType } : {}),
			...(size !== undefined ? { size } : {}),
			provenanceId: resourceId,
			revision: summaryRevision([name, title, description, mimeType, size?.toString()]),
		};
	});
}

/** Normalizes a listResourceTemplates page into bounded, secret-free summaries. */
export function normalizeMCPResourceTemplateSummaries(
	serverId: string,
	resourceTemplates: ReadonlyArray<unknown>,
	limits: MCPContentLimits,
): MCPResourceTemplateSummary[] {
	if (resourceTemplates.length > limits.maxResourcesPerPage) {
		throw new MCPContentError("mcp_content_oversize", serverId);
	}
	return resourceTemplates.map((entry) => {
		const record = requireRecord(entry, serverId);
		const uriTemplate = record.uriTemplate;
		if (typeof uriTemplate !== "string" || uriTemplate.length === 0 || !isWellFormedMCPText(uriTemplate)) {
			throw new MCPContentError("mcp_content_malformed", serverId);
		}
		const name = sanitizeSummaryName(record.name, serverId);
		const title = sanitizeSummaryField(record.title, MAX_TITLE_BYTES);
		const description = sanitizeSummaryField(record.description, MAX_DESCRIPTION_BYTES);
		const mimeType = normalizeMCPMimeType(record.mimeType);
		const templateId = mcpResourceTemplateId(serverId, uriTemplate);
		const displayPattern = sanitizeUriTemplatePattern(uriTemplate);
		return {
			templateId,
			serverId,
			name,
			...(displayPattern !== undefined ? { displayPattern } : {}),
			uriTemplateDigest: mcpDigestHex(uriTemplate),
			...(title !== undefined ? { title } : {}),
			...(description !== undefined ? { description } : {}),
			...(mimeType !== undefined ? { mimeType } : {}),
			provenanceId: templateId,
			revision: summaryRevision([name, title, description, mimeType, displayPattern]),
		};
	});
}

/** Normalizes a listPrompts page into bounded, secret-free summaries. */
export function normalizeMCPPromptSummaries(
	serverId: string,
	prompts: ReadonlyArray<unknown>,
	limits: MCPContentLimits,
): MCPPromptSummary[] {
	if (prompts.length > limits.maxPromptsPerPage) {
		throw new MCPContentError("mcp_content_oversize", serverId);
	}
	return prompts.map((entry) => {
		const record = requireRecord(entry, serverId);
		const name = sanitizeSummaryName(record.name, serverId);
		const title = sanitizeSummaryField(record.title, MAX_TITLE_BYTES);
		const description = sanitizeSummaryField(record.description, MAX_DESCRIPTION_BYTES);
		const rawArguments = record.arguments;
		const argumentsList: MCPPromptArgumentSummary[] = [];
		if (rawArguments !== undefined) {
			if (!Array.isArray(rawArguments)) {
				throw new MCPContentError("mcp_content_malformed", serverId);
			}
			for (const argument of rawArguments) {
				const argumentRecord = requireRecord(argument, serverId);
				const argumentName = sanitizeSummaryField(argumentRecord.name, MAX_ARGUMENT_NAME_BYTES);
				if (argumentName === undefined) {
					throw new MCPContentError("mcp_content_malformed", serverId);
				}
				const argumentDescription = sanitizeSummaryField(
					argumentRecord.description,
					MAX_ARGUMENT_DESCRIPTION_BYTES,
				);
				const required = argumentRecord.required;
				argumentsList.push({
					name: argumentName,
					...(argumentDescription !== undefined ? { description: argumentDescription } : {}),
					...(typeof required === "boolean" ? { required } : {}),
				});
			}
		}
		const promptId = mcpPromptId(serverId, name);
		return {
			promptId,
			serverId,
			name,
			...(title !== undefined ? { title } : {}),
			...(description !== undefined ? { description } : {}),
			arguments: argumentsList,
			provenanceId: promptId,
			revision: summaryRevision([
				name,
				title,
				description,
				...argumentsList.map(
					(argument) => `${argument.name}\u0000${argument.description ?? ""}\u0000${argument.required ?? ""}`,
				),
			]),
		};
	});
}

/**
 * Builds the normalized readResource result, bundling the digest-based
 * resource id, bounded blocks, and the untrusted provenance wrapper. The raw
 * URI is used only inside this call.
 */
export function normalizeMCPResourceRead(
	serverId: string,
	uri: string,
	contents: ReadonlyArray<unknown>,
	limits: MCPContentLimits,
	receivedAt = new Date().toISOString(),
): MCPReadResourceResult {
	const blocks = normalizeMCPResourceContents(serverId, contents, limits);
	const resourceId = mcpResourceId(serverId, uri);
	return {
		serverId,
		resourceId,
		contents: blocks,
		provenance: createProvenance(serverId, "resource", resourceId, blocks, receivedAt),
	};
}

/** Builds the normalized getPrompt result with roles preserved and untrusted provenance. */
export function normalizeMCPPromptGet(
	serverId: string,
	name: string,
	messages: ReadonlyArray<unknown>,
	limits: MCPContentLimits,
	receivedAt = new Date().toISOString(),
): MCPGetPromptResult {
	const normalizedMessages = normalizeMCPPromptMessages(serverId, messages, limits);
	const promptId = mcpPromptId(serverId, name);
	const blocks = normalizedMessages.flatMap((message) => message.blocks);
	return {
		serverId,
		promptId,
		messages: normalizedMessages,
		provenance: createProvenance(serverId, "prompt", promptId, blocks, receivedAt),
	};
}

/**
 * Maps attachable normalized blocks to AOS agent content. Unattached metadata
 * blocks are never mapped to agent content.
 */
export function mapMCPNormalizedBlocksToAgentContent(
	blocks: ReadonlyArray<MCPNormalizedContentBlock>,
): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	for (const block of blocks) {
		switch (block.kind) {
			case "text":
				out.push({ type: "text", text: block.text });
				break;
			case "image":
				out.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "unattached":
				break;
		}
	}
	return out;
}
