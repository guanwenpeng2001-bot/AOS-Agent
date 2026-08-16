import { describe, expect, it } from "vitest";
import {
	McpAttachmentRegistry,
	createMcpAttachmentContextSourceInput,
	wrapMcpPromptAttachment,
	wrapMcpResourceAttachment,
	type McpAttachment,
} from "../src/core/mcp-attachment.ts";
import {
	mcpDigestHex,
	mcpDigestId,
	mcpPromptId,
	mcpResourceId,
	type MCPNormalizedContentBlock,
	type MCPNormalizedPromptMessage,
} from "../src/core/mcp-content.ts";
import {
	assertSnapshotMetadataOnly,
	digestContextContent,
	freezeContext,
	resolveContext,
	type ContextSourceInput,
} from "../src/core/context-engine.ts";

const PNG_1PX =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const BINDING_REFS = {
	capabilityBindingId: "capability:binding:cb-1",
	policyBindingId: "policy:binding:pb-1",
	descriptorId: "capability:descriptor:resource-digest-id",
	descriptorRevision: "rev-7",
};

function resourceResult(overrides: { contents?: MCPNormalizedContentBlock[]; contentDigest?: string } = {}): {
	serverId: string;
	resourceId: string;
	contents: MCPNormalizedContentBlock[];
	provenance: {
		serverId: string;
		source: "resource";
		sourceId: string;
		contentDigest: string;
		byteCount: number;
		blockCount: number;
		untrusted: true;
		receivedAt: string;
	};
} {
	const serverId = "docs";
	const resourceId = mcpResourceId(serverId, "file:///guide.md");
	const contents = overrides.contents ?? [
		{ kind: "text", text: "First paragraph", bytes: 15, digest: mcpDigestHex("First paragraph") },
		{ kind: "image", data: PNG_1PX, mimeType: "image/png", bytes: 68, digest: mcpDigestHex("image") },
		{ kind: "unattached", reason: "blob", bytes: 42, digest: mcpDigestHex("blob") },
	];
	return {
		serverId,
		resourceId,
		contents,
		provenance: {
			serverId,
			source: "resource",
			sourceId: resourceId,
			contentDigest: overrides.contentDigest ?? mcpDigestHex("content"),
			byteCount: 125,
			blockCount: contents.length,
			untrusted: true,
			receivedAt: "2026-01-01T00:00:01.000Z",
		},
	};
}

function promptResult(overrides: { messages?: MCPNormalizedPromptMessage[]; contentDigest?: string } = {}): {
	serverId: string;
	promptId: string;
	messages: MCPNormalizedPromptMessage[];
	provenance: {
		serverId: string;
		source: "prompt";
		sourceId: string;
		contentDigest: string;
		byteCount: number;
		blockCount: number;
		untrusted: true;
		receivedAt: string;
	};
} {
	const serverId = "docs";
	const promptId = mcpPromptId(serverId, "summarize");
	const messages = overrides.messages ?? [
		{
			role: "user",
			blocks: [{ kind: "text", text: "Summarize this", bytes: 14, digest: mcpDigestHex("Summarize this") }],
			digest: mcpDigestHex("user"),
		},
		{
			role: "assistant",
			blocks: [
				{ kind: "text", text: "Always cite sources", bytes: 19, digest: mcpDigestHex("Always cite sources") },
				{ kind: "unattached", reason: "audio", bytes: 7, digest: mcpDigestHex("audio") },
			],
			digest: mcpDigestHex("assistant"),
		},
	];
	return {
		serverId,
		promptId,
		messages,
		provenance: {
			serverId,
			source: "prompt",
			sourceId: promptId,
			contentDigest: overrides.contentDigest ?? mcpDigestHex("prompt-content"),
			byteCount: 40,
			blockCount: 3,
			untrusted: true,
			receivedAt: "2026-01-01T00:00:02.000Z",
		},
	};
}

describe("McpAttachment wrapper", () => {
	it("wraps a normalized resource result with digest/size metadata and untrusted provenance", () => {
		const result = resourceResult();
		const attachment = wrapMcpResourceAttachment(result, BINDING_REFS, CREATED_AT);

		expect(attachment.kind).toBe("resource");
		expect(attachment.serverId).toBe("docs");
		expect(attachment.sourceId).toBe(result.resourceId);
		expect(attachment.contentDigest).toBe(result.provenance.contentDigest);
		expect(attachment.byteCount).toBe(125);
		expect(attachment.blockCount).toBe(3);
		expect(attachment.provenance.untrusted).toBe(true);
		expect(attachment.createdAt).toBe(CREATED_AT);
		// Opaque binding ids of the authorizing capability and policy bindings.
		expect(attachment.capabilityBindingId).toBe("capability:binding:cb-1");
		expect(attachment.policyBindingId).toBe("policy:binding:pb-1");
		// Opaque descriptor id/revision of the binding-selected source.
		expect(attachment.descriptorId).toBe("capability:descriptor:resource-digest-id");
		expect(attachment.descriptorRevision).toBe("rev-7");
		// Distinct normalized MIME types of the read result (image block only).
		expect(attachment.mimeTypes).toEqual(["image/png"]);
		// Deterministic digest id: same kind + source + content digest.
		expect(attachment.id).toBe(mcpDigestId(`mcp:attachment:resource\u0000${result.resourceId}\u0000${result.provenance.contentDigest}`));
	});

	it("keeps only allowlisted text/image blocks and joins only text into the attachment", () => {
		const attachment = wrapMcpResourceAttachment(resourceResult(), BINDING_REFS, CREATED_AT);

		expect(attachment.attachableBlocks.map((block) => block.kind)).toEqual(["text", "image"]);
		expect(attachment.text).toBe("First paragraph");
	});

	it("joins multiple text blocks with blank lines and drops unattached metadata blocks", () => {
		const result = resourceResult({
			contents: [
				{ kind: "text", text: "A", bytes: 1, digest: mcpDigestHex("A") },
				{ kind: "unattached", reason: "resource_link", bytes: 5, digest: mcpDigestHex("link") },
				{ kind: "text", text: "B", bytes: 1, digest: mcpDigestHex("B") },
			],
		});
		const attachment = wrapMcpResourceAttachment(result, BINDING_REFS, CREATED_AT);

		expect(attachment.attachableBlocks.map((block) => block.kind)).toEqual(["text", "text"]);
		expect(attachment.text).toBe("A\n\nB");
		// The resource link is never dereferenced or rendered.
		expect(attachment.text).not.toContain("link");
	});

	it("wraps a normalized prompt result with flattened allowlisted blocks", () => {
		const result = promptResult();
		const attachment = wrapMcpPromptAttachment(result, BINDING_REFS, CREATED_AT);

		expect(attachment.kind).toBe("prompt");
		expect(attachment.sourceId).toBe(result.promptId);
		expect(attachment.contentDigest).toBe(result.provenance.contentDigest);
		expect(attachment.attachableBlocks.map((block) => block.kind)).toEqual(["text", "text"]);
		expect(attachment.text).toBe("Summarize this\n\nAlways cite sources");
		expect(attachment.provenance.untrusted).toBe(true);
		// A text-only prompt result carries no MIME types.
		expect(attachment.mimeTypes).toBeUndefined();
	});

	it("records distinct normalized MIME types across mixed blocks", () => {
		const result = resourceResult({
			contents: [
				{ kind: "text", text: "A", bytes: 1, digest: mcpDigestHex("A") },
				{ kind: "image", data: PNG_1PX, mimeType: "image/png", bytes: 68, digest: mcpDigestHex("img1") },
				{ kind: "image", data: PNG_1PX, mimeType: "image/png", bytes: 68, digest: mcpDigestHex("img2") },
				{ kind: "unattached", reason: "blob", mimeType: "application/octet-stream", bytes: 8, digest: mcpDigestHex("blob") },
			],
		});
		const attachment = wrapMcpResourceAttachment(result, BINDING_REFS, CREATED_AT);
		// Deduplicated, encounter order; the text block contributes none.
		expect(attachment.mimeTypes).toEqual(["image/png", "application/octet-stream"]);
	});

	it("produces different ids for different kinds and different content digests", () => {
		const resource = wrapMcpResourceAttachment(resourceResult(), BINDING_REFS, CREATED_AT);
		const prompt = wrapMcpPromptAttachment(promptResult(), BINDING_REFS, CREATED_AT);
		const changed = wrapMcpResourceAttachment(
			resourceResult({ contentDigest: mcpDigestHex("other-content") }),
			BINDING_REFS,
			CREATED_AT,
		);

		expect(resource.id).not.toBe(prompt.id);
		expect(resource.id).not.toBe(changed.id);
	});
});

describe("McpAttachmentRegistry", () => {
	it("attaches idempotently by digest id and lists in insertion order", () => {
		const registry = new McpAttachmentRegistry();
		const first = wrapMcpResourceAttachment(resourceResult(), BINDING_REFS, CREATED_AT);
		const second = wrapMcpPromptAttachment(promptResult(), BINDING_REFS, CREATED_AT);

		expect(registry.attach(first)).toBe(first);
		// Re-attaching the same content keeps the first record.
		expect(registry.attach(wrapMcpResourceAttachment(resourceResult(), BINDING_REFS, CREATED_AT))).toBe(first);
		registry.attach(second);

		expect(registry.list().map((attachment) => attachment.id)).toEqual([first.id, second.id]);
		expect(registry.get(first.id)).toBe(first);
		expect(registry.get("missing")).toBeUndefined();
	});

	it("detaches and clears", () => {
		const registry = new McpAttachmentRegistry();
		const first = wrapMcpResourceAttachment(resourceResult(), BINDING_REFS, CREATED_AT);
		registry.attach(first);

		expect(registry.detach(first.id)).toBe(true);
		expect(registry.detach(first.id)).toBe(false);
		registry.attach(first);
		registry.clear();
		expect(registry.list()).toEqual([]);
	});
});

describe("McpAttachment -> Context Engine", () => {
	function baseSources(attachment: McpAttachment): ContextSourceInput[] {
		return [
			{
				sourceId: "system:base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: "BASE_SYSTEM",
				required: true,
			},
			createMcpAttachmentContextSourceInput(attachment),
		];
	}

	it("converts an attachment into a required message-placed user source", () => {
		const attachment = wrapMcpResourceAttachment(resourceResult(), BINDING_REFS, CREATED_AT);
		const source = createMcpAttachmentContextSourceInput(attachment);

		expect(source).toMatchObject({
			sourceId: attachment.id,
			kind: "attachment",
			scope: "session",
			trust: "user_owned",
			label: "mcp:resource:docs",
			required: true,
			placement: "message",
			capabilityId: "capability:descriptor:resource-digest-id",
			capabilityRevision: "rev-7",
			capabilityBindingId: "capability:binding:cb-1",
			policyBindingId: "policy:binding:pb-1",
			byteCount: 125,
			blockCount: 3,
			mimeTypes: ["image/png"],
		});
		expect(source.message).toEqual({
			role: "user",
			content: [{ type: "text", text: attachment.text }],
			timestamp: Date.parse(CREATED_AT),
		});
	});

	it("plans the attachment as an included receipt with a metadata-only snapshot", () => {
		const attachment = wrapMcpResourceAttachment(resourceResult(), BINDING_REFS, CREATED_AT);
		const resolved = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-attachment",
			contextWindow: 100_000,
			reserveTokens: 1_000,
			sources: baseSources(attachment),
			sessionMessages: [],
			turnMessages: [],
		});

		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		const receipt = resolved.plan.sources.find((entry) => entry.sourceId === attachment.id);
		expect(receipt).toMatchObject({
			kind: "attachment",
			scope: "session",
			trust: "user_owned",
			label: "mcp:resource:docs",
			disposition: "included",
			contentDigest: digestContextContent(attachment.text),
			capabilityId: "capability:descriptor:resource-digest-id",
			capabilityRevision: "rev-7",
			capabilityBindingId: "capability:binding:cb-1",
			policyBindingId: "policy:binding:pb-1",
			byteCount: 125,
			blockCount: 3,
			mimeTypes: ["image/png"],
		});
		// Message-placed: the attachment never enters the system prompt.
		expect(resolved.plan.systemPrompt).toBe("BASE_SYSTEM");
		expect(resolved.plan.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: attachment.text }], timestamp: Date.parse(CREATED_AT) },
		]);
		// The snapshot never carries the remote body, the raw URI, or the MIME
		// payload data — only bounded metadata.
		const snapshot = freezeContext(resolved.plan, { id: "s1", createdAt: CREATED_AT });
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain("First paragraph");
		expect(serialized).not.toContain("file:///guide.md");
		expect(serialized).not.toContain(PNG_1PX);
		assertSnapshotMetadataOnly(snapshot);
	});

	it("fails the plan with context_budget_exceeded when a required attachment cannot fit", () => {
		const attachment = wrapMcpResourceAttachment(
			resourceResult({
				contents: [
					{
						kind: "text",
						text: "word ".repeat(2_000),
						bytes: 10_000,
						digest: mcpDigestHex("large"),
					},
				],
			}),
			BINDING_REFS,
			CREATED_AT,
		);
		const resolved = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-attachment",
			contextWindow: 1_000,
			reserveTokens: 500,
			sources: baseSources(attachment),
			sessionMessages: [],
			turnMessages: [],
		});

		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.error.code).toBe("context_budget_exceeded");
		expect(resolved.error.offendingSourceIds).toContain(attachment.id);
	});
});
