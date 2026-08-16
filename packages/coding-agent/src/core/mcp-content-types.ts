import type {
	BlobResourceContents,
	Prompt,
	Resource,
	ResourceTemplate,
	TextResourceContents,
} from "@modelcontextprotocol/sdk/types";
import { createHash } from "node:crypto";
import { mcpNamespaceSegmentError } from "./mcp-types.ts";

/**
 * Limits applied when normalizing remote MCP content into model-visible
 * blocks. Every limit is fail-closed: content beyond a limit is truncated or
 * dropped and reported on the normalized result instead of being passed
 * through unbounded.
 */
export interface MCPContentLimits {
	/** Maximum number of normalized blocks returned per content payload. */
	maxBlocks: number;
	/** Maximum characters kept from a single text block. */
	maxTextLength: number;
	/** Maximum base64 length of image/audio data; longer media is dropped whole. */
	maxMediaBytes: number;
	/**
	 * Aggregate budget (text characters plus media bytes) of one normalized
	 * content payload. Once the budget is exhausted the remaining input blocks
	 * are dropped whole and `truncated` is set, so a multi-block payload can
	 * never bypass the per-block caps.
	 */
	maxPayloadBytes: number;
	/** Maximum characters of a single prompt argument value; longer values fail closed. */
	maxPromptArgumentBytes: number;
	/** Maximum total characters across all prompt argument values; larger sets fail closed. */
	maxPromptArgumentsBytes: number;
	/**
	 * Maximum characters of one display field (name/description/mimeType/uri
	 * template). Longer metadata is sliced to this bound in catalog views.
	 */
	maxFieldLength: number;
	/** Maximum characters of a resource URI accepted for an explicit read. */
	maxResourceUriLength: number;
	/**
	 * Maximum total characters of all pending staged attachments for one run
	 * turn. Staging another attachment beyond the budget fails closed.
	 */
	maxRunAttachmentBytes: number;
}

export const DEFAULT_MCP_CONTENT_LIMITS: MCPContentLimits = {
	maxBlocks: 128,
	maxTextLength: 100_000,
	maxMediaBytes: 5_000_000,
	maxPayloadBytes: 1_000_000,
	maxPromptArgumentBytes: 8_000,
	maxPromptArgumentsBytes: 64_000,
	maxFieldLength: 2_000,
	maxResourceUriLength: 4_096,
	maxRunAttachmentBytes: 2_000_000,
};

/**
 * MIME types whose image data is safe to surface as model-visible content.
 * Anything else (svg, unknown subtypes, malformed values) is fail-closed:
 * the block is dropped and never reaches the model or an attachment.
 */
const SAFE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const UTF8_ENCODER = new TextEncoder();

/** UTF-8 byte length of a string; used for every byte-named budget so multi-byte characters cannot bypass limits. */
export function utf8ByteLength(value: string): number {
	return UTF8_ENCODER.encode(value).length;
}

/** True when the mime type is a bounded, control-character-free safe raster image. */
export function isSafeMCPImageMime(mimeType: string, limits: MCPContentLimits): boolean {
	if (mimeType.length === 0 || mimeType.length > limits.maxFieldLength) {
		return false;
	}
	if (/[\u0000-\u001f\u007f]/u.test(mimeType)) {
		return false;
	}
	return SAFE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

/** Per-page cap applied to paginated listings. */
export interface MCPPageLimits {
	/** Maximum items accepted from a single server page. */
	maxItemsPerPage: number;
}

export const DEFAULT_MCP_PAGE_LIMITS: MCPPageLimits = {
	maxItemsPerPage: 100,
};

/**
 * Content block shapes accepted by the normalizer. Tool results, prompt
 * messages, and resource contents all reduce to these shapes; the normalizer
 * never depends on the SDK's richer block types.
 */
export type MCPContentBlockInput =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "audio"; data: string; mimeType: string }
	| { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
	// Transcript artifacts and links never representable as content; dropped
	// by the normalizer.
	| { type: "toolUse"; id: string; name: string }
	| { type: "toolResult"; toolCallId: string }
	| { type: "resource_link"; uri: string; name: string };

/**
 * A model-visible content block. Audio and non-image binary are never
 * representable and are dropped by the normalizer instead.
 */
export type MCPNormalizedContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/**
 * Result of normalizing a remote content payload.
 *
 * `truncated` is true only when a limit (text length, media size, block cap,
 * payload budget) cut the payload short; audio and non-image binary are
 * dropped for representability and reported through `droppedBlocks`/
 * `droppedBytes` without setting `truncated`.
 */
export interface MCPNormalizedContent {
	blocks: ReadonlyArray<MCPNormalizedContentBlock>;
	/** True when any configured limit truncated or dropped content. */
	truncated: boolean;
	/**
	 * True when any input block was dropped for safety (dangerous/unknown MIME,
	 * transcript artifacts, resource links, non-image binary). Reads may still
	 * return the bounded metadata, but attaching content marked unsafe fails
	 * closed.
	 */
	unsafe: boolean;
	/** Number of input blocks not represented in the output. */
	droppedBlocks: number;
	/** Total media bytes of dropped image/audio/resource data. */
	droppedBytes: number;
	/** Total bytes (text characters plus media bytes) of the kept blocks. */
	byteCount: number;
}

function mediaBytesOf(block: MCPContentBlockInput): number {
	switch (block.type) {
		case "image":
		case "audio":
			return block.data.length;
		case "resource":
			return block.resource.blob?.length ?? 0;
		case "text":
		case "toolUse":
		case "toolResult":
		case "resource_link":
			return 0;
	}
}

/**
 * Normalizes arbitrary MCP content blocks (tool results, prompt message
 * content) into model-visible blocks under the given limits.
 *
 * Rules, all fail-closed:
 * - text is kept up to `maxTextLength` characters;
 * - image data longer than `maxMediaBytes` is dropped whole;
 * - only safe raster image MIME types (png/jpeg/gif/webp) surface as image
 *   blocks; svg, unknown subtypes, and malformed mime values are dropped;
 * - audio is always dropped (not representable in model-visible content);
 * - a resource block surfaces its text, or its blob when the blob is a safe
 *   image, and is dropped otherwise;
 * - once `maxBlocks` blocks were produced the remaining input is dropped;
 * - once the aggregate `maxPayloadBytes` budget is exhausted the remaining
 *   input is dropped whole and `truncated` is set.
 */
export function normalizeContentBlocks(
	blocks: ReadonlyArray<MCPContentBlockInput>,
	limits: MCPContentLimits,
): MCPNormalizedContent {
	const out: MCPNormalizedContentBlock[] = [];
	let truncated = false;
	let unsafe = false;
	let droppedBlocks = 0;
	let droppedBytes = 0;
	let payloadBytes = 0;
	const drop = (block: MCPContentBlockInput): void => {
		droppedBlocks += 1;
		droppedBytes += mediaBytesOf(block);
	};
	const dropUnsafe = (block: MCPContentBlockInput): void => {
		unsafe = true;
		drop(block);
	};
	const hasBudget = (bytes: number): boolean => payloadBytes + bytes <= limits.maxPayloadBytes;
	for (const block of blocks) {
		if (out.length >= limits.maxBlocks) {
			truncated = true;
			drop(block);
			continue;
		}
		switch (block.type) {
			case "text": {
				const text = block.text.slice(0, limits.maxTextLength);
				if (block.text.length > limits.maxTextLength) {
					truncated = true;
				}
				const bytes = utf8ByteLength(text);
				if (!hasBudget(bytes)) {
					truncated = true;
					drop(block);
					break;
				}
				payloadBytes += bytes;
				out.push({ type: "text", text });
				break;
			}
			case "image":
				if (!isSafeMCPImageMime(block.mimeType, limits)) {
					// Unknown, dangerous (svg), or malformed MIME: fail closed and
					// mark the payload unsafe so attaches never stage it.
					dropUnsafe(block);
					break;
				}
				if (block.data.length > limits.maxMediaBytes) {
					truncated = true;
					drop(block);
					break;
				}
				if (!hasBudget(block.data.length)) {
					truncated = true;
					drop(block);
					break;
				}
				payloadBytes += block.data.length;
				out.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "audio":
				// Never representable in model-visible content.
				drop(block);
				break;
			case "toolUse":
			case "toolResult":
			case "resource_link":
				// Transcript artifacts and links are never content; their presence
				// marks the payload unsafe for attachment.
				dropUnsafe(block);
				break;
			case "resource": {
				const resource = block.resource;
				if (resource.text !== undefined) {
					const text = resource.text.slice(0, limits.maxTextLength);
					if (resource.text.length > limits.maxTextLength) {
						truncated = true;
					}
					const bytes = utf8ByteLength(text);
					if (!hasBudget(bytes)) {
						truncated = true;
						drop(block);
						break;
					}
					payloadBytes += bytes;
					out.push({ type: "text", text });
				} else if (resource.blob !== undefined && (resource.mimeType ?? "").startsWith("image/")) {
					if (!isSafeMCPImageMime(resource.mimeType ?? "", limits)) {
						dropUnsafe(block);
						break;
					}
					if (resource.blob.length > limits.maxMediaBytes) {
						truncated = true;
						drop(block);
						break;
					}
					if (!hasBudget(resource.blob.length)) {
						truncated = true;
						drop(block);
						break;
					}
					payloadBytes += resource.blob.length;
					out.push({
						type: "image",
						data: resource.blob,
						mimeType: resource.mimeType ?? "image/png",
					});
				} else {
					// Non-image binary and link-like resource contents never
					// surface; their presence marks the payload unsafe.
					dropUnsafe(block);
				}
				break;
			}
		}
	}
	return { blocks: out, truncated, unsafe, droppedBlocks, droppedBytes, byteCount: payloadBytes };
}

/**
 * Normalizes `resources/read` contents (text or blob items) under the given
 * limits. Blob contents surface only when their mime type is an image; all
 * other binary is dropped.
 */
export function normalizeResourceContents(
	contents: ReadonlyArray<TextResourceContents | BlobResourceContents>,
	limits: MCPContentLimits,
): MCPNormalizedContent {
	const blocks: MCPContentBlockInput[] = contents.map((item) =>
		"text" in item
			? { type: "text", text: item.text }
			: {
					type: "resource",
					resource: { uri: item.uri, blob: item.blob, mimeType: item.mimeType },
				},
	);
	return normalizeContentBlocks(blocks, limits);
}

/**
 * Applies the per-page item cap to a server page.
 *
 * A page that exceeds the cap is cut to the first `maxItemsPerPage` items and
 * its `nextCursor` is dropped: continuing a truncated page would silently skip
 * the cut items, so pagination stops and the caller sees `truncated: true`.
 */
export function applyPageLimit<T>(
	items: ReadonlyArray<T>,
	nextCursor: string | undefined,
	limits: MCPPageLimits,
): MCPPageResult<T> {
	if (items.length <= limits.maxItemsPerPage) {
		return { items, ...(nextCursor !== undefined ? { nextCursor } : {}), truncated: false };
	}
	return { items: items.slice(0, limits.maxItemsPerPage), truncated: true };
}

/** One page of a paginated listing. */
export interface MCPPageResult<T> {
	items: ReadonlyArray<T>;
	/** Server-supplied continuation cursor for the next page. */
	nextCursor?: string;
	/** True when the server page exceeded `maxItemsPerPage` and was cut. */
	truncated: boolean;
}

/**
 * Stable server-scoped opaque id for a resource. The digest covers the server
 * id and the raw URI, so the same URI on different servers never collides and
 * the raw URI (including any query) never appears in the id.
 */
export function mcpResourceId(serverId: string, uri: string): string {
	return `mcp-res-${createHash("sha256").update(`${serverId}\u0000${uri}`).digest("hex").slice(0, 16)}`;
}

/** Stable server-scoped opaque id for a resource template; never contains the raw pattern. */
export function mcpTemplateId(serverId: string, uriTemplate: string): string {
	return `mcp-tpl-${createHash("sha256").update(`${serverId}\u0000${uriTemplate}`).digest("hex").slice(0, 16)}`;
}

/** Stable server-scoped opaque id for a prompt; the server-facing name stays internal. */
export function mcpPromptId(serverId: string, name: string): string {
	return `mcp-prompt-${createHash("sha256").update(`${serverId}\u0000${name}`).digest("hex").slice(0, 16)}`;
}

/**
 * Stable secret-free provenance identity of one listed content item: a digest
 * of the server-visible identity parts (URI/template/name plus display
 * metadata), mirroring the capability local-name derivation exactly, so the
 * catalog and the frozen binding correlate. Cross-server isolation comes from
 * the server-scoped resourceId/promptId and the registry's mcpServerId, not
 * from this digest. Raw URIs, queries, and argument values never enter the id.
 */
export function mcpContentProvenanceId(...parts: Array<string | undefined>): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		hash.update(part ?? "");
		hash.update("\u0000");
	}
	return `mcp-content-${hash.digest("hex").slice(0, 16)}`;
}

/**
 * Stable secret-free revision of one listed content item: a digest of the
 * server id plus the same identity parts as the provenance id, so any metadata
 * change moves the revision while the provenance stays stable.
 */
export function mcpContentRevision(serverId: string, ...parts: Array<string | undefined>): string {
	const hash = createHash("sha256");
	hash.update(serverId);
	hash.update("\u0000");
	for (const part of parts) {
		hash.update(part ?? "");
		hash.update("\u0000");
	}
	return `rev:${hash.digest("hex").slice(0, 16)}`;
}

/** Secret-free view of a discovered resource. The raw URI never leaves the lifecycle. */
export interface MCPResourceView {
	serverId: string;
	/** Stable server-scoped opaque id; used to read/attach the resource. */
	resourceId: string;
	name: string;
	description?: string;
	mimeType?: string;
	size?: number;
	/** Stable digest identity of the listed item (see {@link mcpContentProvenanceId}). */
	provenanceId: string;
	/** Stable metadata digest; moves when the listed item changes. */
	revision: string;
}

/** Slices a display field to the configured bound; the full value never leaves the mapper. */
function boundField(value: string, limits: MCPContentLimits): string {
	return value.slice(0, limits.maxFieldLength);
}

/**
 * True when a resource URI is a usable identity: bounded in length and free of
 * whitespace and control characters. Invalid URIs fail closed: the item is
 * dropped from the catalog instead of being truncated into a wrong identity
 * that could never be read back.
 */
function isBoundedResourceIdentity(uri: string, limits: MCPContentLimits): boolean {
	return uri.length > 0 && uri.length <= limits.maxResourceUriLength && !/[\u0000-\u001f\u007f\s]/u.test(uri);
}

/**
 * True when a prompt name is a usable identity: a valid namespace segment
 * bounded in length. Invalid names fail closed: the prompt is dropped from the
 * catalog instead of being sliced into an identity that could never be fetched.
 */
function isBoundedPromptName(name: string, limits: MCPContentLimits): boolean {
	return name.length > 0 && name.length <= limits.maxFieldLength && mcpNamespaceSegmentError(name) === undefined;
}

export function mapResourceToView(
	resource: Resource,
	limits: MCPContentLimits = DEFAULT_MCP_CONTENT_LIMITS,
	serverId = "",
): MCPResourceView | undefined {
	if (!isBoundedResourceIdentity(resource.uri, limits)) {
		return undefined;
	}
	const name = boundField(resource.name, limits);
	const description = resource.description === undefined ? undefined : boundField(resource.description, limits);
	const mimeType = resource.mimeType === undefined ? undefined : boundField(resource.mimeType, limits);
	return {
		serverId,
		resourceId: mcpResourceId(serverId, resource.uri),
		name,
		...(description === undefined ? {} : { description }),
		...(mimeType === undefined ? {} : { mimeType }),
		...(resource.size !== undefined ? { size: resource.size } : {}),
		provenanceId: mcpContentProvenanceId(resource.uri, name, mimeType, description),
		revision: mcpContentRevision(serverId, resource.uri, name, mimeType, description),
	};
}

/** Secret-free view of a discovered resource template. */
export interface MCPResourceTemplateView {
	serverId: string;
	/** Stable server-scoped opaque id derived from the uri template digest. */
	templateId: string;
	name: string;
	description?: string;
	mimeType?: string;
	provenanceId: string;
	revision: string;
}

export function mapResourceTemplateToView(
	template: ResourceTemplate,
	limits: MCPContentLimits = DEFAULT_MCP_CONTENT_LIMITS,
	serverId = "",
): MCPResourceTemplateView | undefined {
	if (!isBoundedResourceIdentity(template.uriTemplate, limits)) {
		return undefined;
	}
	const name = boundField(template.name, limits);
	const description = template.description === undefined ? undefined : boundField(template.description, limits);
	const mimeType = template.mimeType === undefined ? undefined : boundField(template.mimeType, limits);
	return {
		serverId,
		templateId: mcpTemplateId(serverId, template.uriTemplate),
		name,
		...(description === undefined ? {} : { description }),
		...(mimeType === undefined ? {} : { mimeType }),
		provenanceId: mcpContentProvenanceId(template.uriTemplate, name, mimeType, description),
		revision: mcpContentRevision(serverId, template.uriTemplate, name, mimeType, description),
	};
}

/** Secret-free view of a discovered prompt. */
export interface MCPPromptView {
	serverId: string;
	/** Stable server-scoped opaque id derived from the prompt name digest. */
	promptId: string;
	/** Server-facing prompt name; kept only for display and server calls. */
	name: string;
	description?: string;
	arguments?: ReadonlyArray<{ name: string; description?: string; required?: boolean }>;
	provenanceId: string;
	revision: string;
}

/**
 * True when a declared prompt argument name is a usable key: non-empty,
 * bounded in length, and free of control characters. A declared argument with
 * an invalid name fails the whole prompt closed (it can never be validated or
 * fetched reliably), so the prompt is dropped from the catalog instead of
 * exposing a sliced argument identity.
 */
function isBoundedArgumentName(name: string, limits: MCPContentLimits): boolean {
	return name.length > 0 && name.length <= limits.maxFieldLength && !/[\u0000-\u001f\u007f]/u.test(name);
}

export function mapPromptToView(
	prompt: Prompt,
	limits: MCPContentLimits = DEFAULT_MCP_CONTENT_LIMITS,
	serverId = "",
): MCPPromptView | undefined {
	if (!isBoundedPromptName(prompt.name, limits)) {
		return undefined;
	}
	const promptArguments = prompt.arguments;
	if (promptArguments?.some((argument) => !isBoundedArgumentName(argument.name, limits)) === true) {
		return undefined;
	}
	const description = prompt.description === undefined ? undefined : boundField(prompt.description, limits);
	return {
		serverId,
		promptId: mcpPromptId(serverId, prompt.name),
		name: prompt.name,
		...(description === undefined ? {} : { description }),
		...(promptArguments !== undefined
			? {
					arguments: promptArguments.map((argument) => ({
						name: argument.name,
						...(argument.description !== undefined
							? { description: boundField(argument.description, limits) }
							: {}),
						...(argument.required !== undefined ? { required: argument.required } : {}),
					})),
				}
			: {}),
		provenanceId: mcpContentProvenanceId(prompt.name, description),
		revision: mcpContentRevision(serverId, prompt.name, description),
	};
}

/** Normalized result of reading a resource. The raw URI never leaves the lifecycle. */
export interface MCPReadResourceResult {
	serverId: string;
	/** Opaque resource id the read was performed for. */
	resourceId: string;
	content: MCPNormalizedContent;
	/** Total bytes (text characters plus media bytes) of the kept blocks. */
	byteCount: number;
	/** True when any configured limit truncated or dropped content. */
	truncated: boolean;
	/** Stable provenance identity of the listed item the read resolved from. */
	provenanceId: string;
	/** Stable metadata revision of the listed item the read resolved from. */
	revision: string;
}

/** One message of a normalized prompt result. */
export interface MCPPromptMessageView {
	role: "user" | "assistant";
	content: MCPNormalizedContent;
}

/** Normalized result of fetching a prompt. The server-facing name stays internal. */
export interface MCPGetPromptResult {
	serverId: string;
	/** Opaque prompt id the fetch was performed for. */
	promptId: string;
	description?: string;
	messages: ReadonlyArray<MCPPromptMessageView>;
	/** Stable provenance identity of the listed prompt the fetch resolved from. */
	provenanceId: string;
	/** Stable metadata revision of the listed prompt the fetch resolved from. */
	revision: string;
}

/** Classified problem with a prompt argument set; never carries names or values. */
export type MCPPromptArgumentsProblem =
	| { kind: "missing_required" }
	| { kind: "unknown_argument" }
	| { kind: "argument_too_long" }
	| { kind: "arguments_too_large" };

/**
 * Validates an explicit prompt argument set against the declared prompt
 * arguments and the configured limits. Fail-closed: missing required
 * arguments, undeclared arguments, an argument value longer than
 * `maxPromptArgumentBytes`, and a total above `maxPromptArgumentsBytes` are
 * all rejected. The problem is classified without echoing any argument name
 * or value, so callers can map it to a fixed error message.
 */
export function validateMcpPromptArguments(
	declared: ReadonlyArray<{ name: string; required?: boolean }> | undefined,
	args: Readonly<Record<string, string>> | undefined,
	limits: MCPContentLimits,
): MCPPromptArgumentsProblem | undefined {
	if (args === undefined || Object.keys(args).length === 0) {
		const required = declared?.filter((argument) => argument.required === true) ?? [];
		return required.length > 0 ? { kind: "missing_required" } : undefined;
	}
	const declaredNames = new Set(declared?.map((argument) => argument.name) ?? []);
	let totalBytes = 0;
	for (const [name, value] of Object.entries(args)) {
		if (!declaredNames.has(name)) {
			return { kind: "unknown_argument" };
		}
		const valueBytes = utf8ByteLength(value);
		if (valueBytes > limits.maxPromptArgumentBytes) {
			return { kind: "argument_too_long" };
		}
		totalBytes += valueBytes;
	}
	if (totalBytes > limits.maxPromptArgumentsBytes) {
		return { kind: "arguments_too_large" };
	}
	const required = declared?.filter((argument) => argument.required === true) ?? [];
	if (required.some((argument) => !(argument.name in args))) {
		return { kind: "missing_required" };
	}
	return undefined;
}
