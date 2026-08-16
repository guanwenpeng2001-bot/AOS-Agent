import type {
	BlobResourceContents,
	Prompt,
	Resource,
	ResourceTemplate,
	TextResourceContents,
} from "@modelcontextprotocol/sdk/types";

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
}

export const DEFAULT_MCP_CONTENT_LIMITS: MCPContentLimits = {
	maxBlocks: 128,
	maxTextLength: 100_000,
	maxMediaBytes: 5_000_000,
};

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
 * `truncated` is true only when a limit (text length, media size, block cap)
 * cut the payload short; audio and non-image binary are dropped for
 * representability and reported through `droppedBlocks`/`droppedBytes`
 * without setting `truncated`.
 */
export interface MCPNormalizedContent {
	blocks: ReadonlyArray<MCPNormalizedContentBlock>;
	/** True when any configured limit truncated or dropped content. */
	truncated: boolean;
	/** Number of input blocks not represented in the output. */
	droppedBlocks: number;
	/** Total media bytes of dropped image/audio/resource data. */
	droppedBytes: number;
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
 * - audio is always dropped (not representable in model-visible content);
 * - a resource block surfaces its text, or its blob when the blob is an image,
 *   and is dropped otherwise;
 * - once `maxBlocks` blocks were produced the remaining input is dropped.
 */
export function normalizeContentBlocks(
	blocks: ReadonlyArray<MCPContentBlockInput>,
	limits: MCPContentLimits,
): MCPNormalizedContent {
	const out: MCPNormalizedContentBlock[] = [];
	let truncated = false;
	let droppedBlocks = 0;
	let droppedBytes = 0;
	const drop = (block: MCPContentBlockInput): void => {
		droppedBlocks += 1;
		droppedBytes += mediaBytesOf(block);
	};
	for (const block of blocks) {
		if (out.length >= limits.maxBlocks) {
			truncated = true;
			drop(block);
			continue;
		}
		switch (block.type) {
			case "text":
				if (block.text.length > limits.maxTextLength) {
					truncated = true;
				}
				out.push({ type: "text", text: block.text.slice(0, limits.maxTextLength) });
				break;
			case "image":
				if (block.data.length > limits.maxMediaBytes) {
					truncated = true;
					drop(block);
					break;
				}
				out.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "audio":
				// Never representable in model-visible content.
				drop(block);
				break;
			case "toolUse":
			case "toolResult":
			case "resource_link":
				// Transcript artifacts and links, never content.
				drop(block);
				break;
			case "resource": {
				const resource = block.resource;
				if (resource.text !== undefined) {
					if (resource.text.length > limits.maxTextLength) {
						truncated = true;
					}
					out.push({ type: "text", text: resource.text.slice(0, limits.maxTextLength) });
				} else if (resource.blob !== undefined && (resource.mimeType ?? "").startsWith("image/")) {
					if (resource.blob.length > limits.maxMediaBytes) {
						truncated = true;
						drop(block);
						break;
					}
					out.push({
						type: "image",
						data: resource.blob,
						mimeType: resource.mimeType ?? "image/png",
					});
				} else {
					drop(block);
				}
				break;
			}
		}
	}
	return { blocks: out, truncated, droppedBlocks, droppedBytes };
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

/** Secret-free view of a discovered resource. */
export interface MCPResourceView {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
	size?: number;
}

export function mapResourceToView(resource: Resource): MCPResourceView {
	return {
		uri: resource.uri,
		name: resource.name,
		...(resource.description !== undefined ? { description: resource.description } : {}),
		...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
		...(resource.size !== undefined ? { size: resource.size } : {}),
	};
}

/** Secret-free view of a discovered resource template. */
export interface MCPResourceTemplateView {
	uriTemplate: string;
	name: string;
	description?: string;
	mimeType?: string;
}

export function mapResourceTemplateToView(template: ResourceTemplate): MCPResourceTemplateView {
	return {
		uriTemplate: template.uriTemplate,
		name: template.name,
		...(template.description !== undefined ? { description: template.description } : {}),
		...(template.mimeType !== undefined ? { mimeType: template.mimeType } : {}),
	};
}

/** Secret-free view of a discovered prompt. */
export interface MCPPromptView {
	name: string;
	description?: string;
	arguments?: ReadonlyArray<{ name: string; description?: string; required?: boolean }>;
}

export function mapPromptToView(prompt: Prompt): MCPPromptView {
	const promptArguments = prompt.arguments;
	return {
		name: prompt.name,
		...(prompt.description !== undefined ? { description: prompt.description } : {}),
		...(promptArguments !== undefined
			? {
					arguments: promptArguments.map((argument) => ({
						name: argument.name,
						...(argument.description !== undefined ? { description: argument.description } : {}),
						...(argument.required !== undefined ? { required: argument.required } : {}),
					})),
				}
			: {}),
	};
}

/** Normalized result of reading a resource. */
export interface MCPReadResourceResult {
	serverId: string;
	uri: string;
	content: MCPNormalizedContent;
}

/** One message of a normalized prompt result. */
export interface MCPPromptMessageView {
	role: "user" | "assistant";
	content: MCPNormalizedContent;
}

/** Normalized result of fetching a prompt. */
export interface MCPGetPromptResult {
	serverId: string;
	promptName: string;
	description?: string;
	messages: ReadonlyArray<MCPPromptMessageView>;
}
