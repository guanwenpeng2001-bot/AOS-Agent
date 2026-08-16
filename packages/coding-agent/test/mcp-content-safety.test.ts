import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
	isValidMCPBase64,
	mapMCPNormalizedBlocksToAgentContent,
	MCPContentError,
	mcpDigestHex,
	mcpDigestId,
	mcpPromptId,
	mcpResourceId,
	normalizeMCPMimeType,
	normalizeMCPPromptGet,
	normalizeMCPPromptSummaries,
	normalizeMCPResourceRead,
	normalizeMCPResourceSummaries,
	normalizeMCPResourceTemplateSummaries,
	sanitizeMCPText,
	truncateMCPField,
	validateMCPPromptArguments,
	validateMCPPromptName,
	validateMCPResourceUri,
} from "../src/core/mcp-content.ts";
import { DEFAULT_MCP_CONTENT_LIMITS, type MCPContentLimits } from "../src/core/mcp-types.ts";

const SERVER = "docs";
const limits: MCPContentLimits = DEFAULT_MCP_CONTENT_LIMITS;

function contentError(fn: () => unknown): MCPContentError {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(MCPContentError);
		return error as MCPContentError;
	}
	throw new Error("expected MCPContentError");
}

function expectFixedError(fn: () => unknown, code: MCPContentError["code"]): MCPContentError {
	const error = contentError(fn);
	expect(error.code).toBe(code);
	expect(error.serverId).toBe(SERVER);
	return error;
}

const PNG_1PX =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("mcp-content text normalization", () => {
	it("strips control characters but keeps tab, LF, and CR", () => {
		const blocks = normalizeMCPResourceRead(SERVER, "file:///a", [
			{ uri: "file:///a", text: "a\u0000b\u0007c\t\nd\r\u007fe\u0085f" },
		], limits).contents;
		expect(blocks).toEqual([
			{ kind: "text", text: "abc\t\nd\ref", bytes: 9, digest: mcpDigestHex("abc\t\nd\ref") },
		]);
	});

	it("rejects lone surrogates with a fixed encoding error", () => {
		expectFixedError(
			() => normalizeMCPResourceRead(SERVER, "file:///a", [{ uri: "file:///a", text: "bad \ud800 text" }], limits),
			"mcp_content_encoding",
		);
	});

	it("fails closed when a text block exceeds maxTextBytes", () => {
		expectFixedError(
			() =>
				normalizeMCPResourceRead(SERVER, "file:///a", [
					{ uri: "file:///a", text: "x".repeat(limits.maxTextBytes + 1) },
				], limits),
			"mcp_content_oversize",
		);
	});

	it("enforces the block count and total attachment byte limits", () => {
		const manyBlocks = Array.from({ length: limits.maxBlocks + 1 }, (_, index) => ({
			uri: "file:///a",
			text: `b${index}`,
		}));
		expectFixedError(
			() => normalizeMCPResourceRead(SERVER, "file:///a", manyBlocks, limits),
			"mcp_content_oversize",
		);

		const smallLimits: MCPContentLimits = { ...limits, maxAttachmentBytes: 10 };
		expectFixedError(
			() => normalizeMCPResourceRead(SERVER, "file:///a", [{ uri: "file:///a", text: "x".repeat(11) }], smallLimits),
			"mcp_content_oversize",
		);
	});

	it("rejects malformed structures with fixed errors", () => {
		expectFixedError(
			() => normalizeMCPResourceRead(SERVER, "file:///a", [null], limits),
			"mcp_content_malformed",
		);
		expectFixedError(
			() => normalizeMCPResourceRead(SERVER, "file:///a", [{ text: "no uri" }], limits),
			"mcp_content_malformed",
		);
		expectFixedError(
			() => normalizeMCPResourceRead(SERVER, "file:///a", [{ uri: "file:///a" }], limits),
			"mcp_content_malformed",
		);
		expectFixedError(
			() => normalizeMCPResourceRead(SERVER, "file:///a", [{ uri: "file:///a", text: 42 }], limits),
			"mcp_content_malformed",
		);
		expectFixedError(
			() => normalizeMCPResourceRead(SERVER, "file:///a", [{ uri: "file:///a", text: "a", blob: "b" }], limits),
			"mcp_content_malformed",
		);
	});

	it("never leaks remote text or URIs through fixed errors", () => {
		const secret = "remote-secret-content-abc123";
		const secretUri = "file:///secret/path?token=sk-leak";
		const error = contentError(() =>
			normalizeMCPResourceRead(SERVER, secretUri, [{ uri: secretUri, text: secret }], {
				...limits,
				maxTextBytes: 4,
			}),
		);
		const serialized = JSON.stringify(error);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain(secretUri);
		expect(inspect(error, { showHidden: true, depth: 5 })).not.toContain(secret);
		expect(error.message).toBe(`MCP server "${SERVER}" returned content over the safety limits`);
	});
});

describe("mcp-content image, MIME, and base64 handling", () => {
	it("normalizes image MIME types to lowercase type/subtype without parameters", () => {
		const blocks = normalizeMCPResourceRead(SERVER, "file:///img", [
			{ uri: "file:///img", blob: PNG_1PX, mimeType: "IMAGE/PNG; charset=binary" },
		], limits).contents;
		expect(blocks[0]).toMatchObject({ kind: "unattached", reason: "blob", mimeType: "image/png" });
	});

	it("accepts valid base64 and counts decoded bytes", () => {
		expect(isValidMCPBase64(PNG_1PX)).toBe(true);
		expect(isValidMCPBase64("aGk=")).toBe(true);
		expect(isValidMCPBase64("aGk")).toBe(false);
		expect(isValidMCPBase64("aGk===")).toBe(false);
		expect(isValidMCPBase64("aG k=")).toBe(false);
		expect(isValidMCPBase64("")).toBe(false);
		expect(normalizeMCPMimeType("image/png")).toBe("image/png");
		expect(normalizeMCPMimeType("Image/PNG")).toBe("image/png");
		expect(normalizeMCPMimeType("image/png; charset=utf-8")).toBe("image/png");
		expect(normalizeMCPMimeType("not-a-mime")).toBeUndefined();
		expect(normalizeMCPMimeType("image/")).toBeUndefined();
		expect(normalizeMCPMimeType("/png")).toBeUndefined();
		expect(normalizeMCPMimeType(42)).toBeUndefined();
	});

	it("fails closed on invalid base64 and invalid MIME in content blocks", () => {
		expectFixedError(
			() =>
				normalizeMCPPromptGet(SERVER, "p", [
					{ role: "user", content: { type: "image", data: "not-base64!", mimeType: "image/png" } },
				], limits),
			"mcp_content_encoding",
		);
		expectFixedError(
			() =>
				normalizeMCPPromptGet(SERVER, "p", [
					{ role: "user", content: { type: "image", data: PNG_1PX, mimeType: "not-a-mime" } },
				], limits),
			"mcp_content_mime",
		);
	});

	it("fails closed when a decoded blob exceeds maxBlobBytes", () => {
		const big = Buffer.alloc(limits.maxBlobBytes + 1, 1).toString("base64");
		expectFixedError(
			() => normalizeMCPResourceRead(SERVER, "file:///big", [{ uri: "file:///big", blob: big }], limits),
			"mcp_content_oversize",
		);
	});
});

describe("mcp-content prompt normalization", () => {
	it("preserves roles and normalizes text blocks", () => {
		const result = normalizeMCPPromptGet(SERVER, "hello", [
			{ role: "user", content: { type: "text", text: "hi" } },
			{ role: "assistant", content: { type: "text", text: "hello\u0000!" } },
		], limits);
		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(result.messages[1].blocks[0]).toMatchObject({ kind: "text", text: "hello!" });
		expect(result.provenance).toMatchObject({
			serverId: SERVER,
			source: "prompt",
			sourceId: mcpPromptId(SERVER, "hello"),
			untrusted: true,
			blockCount: 2,
		});
	});

	it("rejects unknown roles and malformed content shapes", () => {
		expectFixedError(
			() => normalizeMCPPromptGet(SERVER, "p", [{ role: "system", content: { type: "text", text: "x" } }], limits),
			"mcp_content_malformed",
		);
		expectFixedError(
			() => normalizeMCPPromptGet(SERVER, "p", [{ role: "user", content: "nope" }], limits),
			"mcp_content_malformed",
		);
		expectFixedError(
			() =>
				normalizeMCPPromptGet(
					SERVER,
					"p",
					[{ role: "user", content: [{ type: "text", text: "x" }] }],
					limits,
				),
			"mcp_content_malformed",
		);
	});

	it("turns embedded resource links into non-attachable metadata", () => {
		const result = normalizeMCPPromptGet(SERVER, "p", [
			{
				role: "user",
				content: {
					type: "resource_link",
					uri: "file:///secret?token=x",
					name: "secret",
					mimeType: "text/plain",
				},
			},
		], limits);
		const blocks = result.messages[0].blocks;
		expect(blocks[0]).toMatchObject({ kind: "unattached", reason: "resource_link", mimeType: "text/plain" });
		// the raw link URI never appears in the normalized result
		expect(JSON.stringify(result)).not.toContain("file:///secret");
		expect(JSON.stringify(result)).not.toContain("token=x");
		// and it is never mapped to attachable agent content
		expect(mapMCPNormalizedBlocksToAgentContent(blocks)).toEqual([]);
	});

	it("normalizes embedded resource text but never dereferences embedded blobs", () => {
		const result = normalizeMCPPromptGet(SERVER, "p", [
			{
				role: "assistant",
				content: { type: "resource", resource: { uri: "file:///r", text: "embedded" } },
			},
			{
				role: "assistant",
				content: { type: "resource", resource: { uri: "file:///b", blob: PNG_1PX, mimeType: "image/png" } },
			},
		], limits);
		const blocks = result.messages[0].blocks;
		expect(blocks[0]).toMatchObject({ kind: "text", text: "embedded" });
		expect(result.messages[1].blocks[0]).toMatchObject({ kind: "unattached", reason: "embedded_blob" });
	});

	it("rejects unknown content block types and malformed blocks", () => {
		expectFixedError(
			() => normalizeMCPPromptGet(SERVER, "p", [{ role: "user", content: { type: "future" } }], limits),
			"mcp_content_unsupported",
		);
		expectFixedError(
			() => normalizeMCPPromptGet(SERVER, "p", [{ role: "user", content: { type: "text" } }], limits),
			"mcp_content_malformed",
		);
		expectFixedError(
			() => normalizeMCPPromptGet(SERVER, "p", [{ role: "user", content: { type: "audio", data: "x", mimeType: "audio/wav" } }], limits),
			"mcp_content_encoding",
		);
	});

	it("validates prompt names and argument values without retaining them", () => {
		expect(validateMCPPromptName("hello", SERVER)).toBe("hello");
		expect(validateMCPPromptName("he\u0000llo", SERVER)).toBe("hello");
		expectFixedError(() => validateMCPPromptName("", SERVER), "mcp_content_malformed");
		expectFixedError(() => validateMCPPromptName(42, SERVER), "mcp_content_malformed");
		expectFixedError(
			() => validateMCPPromptName("x".repeat(300), SERVER),
			"mcp_content_malformed",
		);

		expect(validateMCPPromptArguments({ q: "a\u0000b" }, limits, SERVER)).toEqual({ q: "ab" });
		expectFixedError(() => validateMCPPromptArguments({ q: 42 }, limits, SERVER), "mcp_content_malformed");
		expectFixedError(
			() => validateMCPPromptArguments({ q: "x".repeat(limits.maxPromptArgumentBytes + 1) }, limits, SERVER),
			"mcp_content_oversize",
		);
		expectFixedError(
			() => validateMCPPromptArguments({ a: "x".repeat(5000), b: "y".repeat(5000) }, limits, SERVER),
			"mcp_content_oversize",
		);
	});

	it("validates resource URIs structurally without retaining them", () => {
		expect(validateMCPResourceUri("file:///docs/readme.md", SERVER)).toBe("file:///docs/readme.md");
		expect(validateMCPResourceUri("file:///docs/a\u0000b", SERVER)).toBe("file:///docs/ab");
		expectFixedError(() => validateMCPResourceUri("", SERVER), "mcp_content_malformed");
		expectFixedError(() => validateMCPResourceUri(42, SERVER), "mcp_content_malformed");
		expectFixedError(() => validateMCPResourceUri(`file:///${"x".repeat(5000)}`, SERVER), "mcp_content_malformed");
	});
});

describe("mcp-content catalog summaries", () => {
	it("normalizes resource summaries into secret-free digest ids", () => {
		const summaries = normalizeMCPResourceSummaries(SERVER, [
			{ uri: "file:///docs/readme.md", name: "read\u0000me", description: "desc", mimeType: "text/markdown", size: 12 },
		], limits);
		const summary = summaries[0];
		expect(summary).toMatchObject({
			serverId: SERVER,
			name: "readme",
			description: "desc",
			mimeType: "text/markdown",
			size: 12,
			provenanceId: summary.resourceId,
		});
		expect(summary.resourceId).toBe(mcpResourceId(SERVER, "file:///docs/readme.md"));
		expect(JSON.stringify(summary)).not.toContain("file:///docs/readme.md");
		expect(summary.revision).toMatch(/^[0-9a-f]{64}$/);
		// identical metadata produces an identical revision
		const again = normalizeMCPResourceSummaries(SERVER, [
			{ uri: "file:///docs/readme.md", name: "readme", description: "desc", mimeType: "text/markdown", size: 12 },
		], limits)[0];
		expect(again.revision).toBe(summary.revision);
		expect(again.resourceId).toBe(summary.resourceId);
	});

	it("drops invalid MIME and non-finite size fields from summaries", () => {
		const summary = normalizeMCPResourceSummaries(SERVER, [
			{ uri: "file:///a", name: "a", mimeType: "not-a-mime", size: Number.NaN },
		], limits)[0];
		expect(summary.mimeType).toBeUndefined();
		expect(summary.size).toBeUndefined();
	});

	it("truncates oversized metadata fields without splitting code points", () => {
		const longName = `a${"x".repeat(300)}`;
		const summary = normalizeMCPResourceSummaries(SERVER, [{ uri: "file:///a", name: longName }], limits)[0];
		expect(Buffer.byteLength(summary.name, "utf8")).toBeLessThanOrEqual(256);
		expect(summary.name).not.toBe(longName);
		// multi-byte truncation keeps the string well-formed
		const emojiName = `${"💎".repeat(200)}`;
		const emojiSummary = normalizeMCPResourceSummaries(SERVER, [{ uri: "file:///e", name: emojiName }], limits)[0];
		expect(Buffer.byteLength(emojiSummary.name, "utf8")).toBeLessThanOrEqual(256);
		expect(() => new TextEncoder().encode(emojiSummary.name)).not.toThrow();
	});

	it("sanitizes template display patterns and digests the raw template", () => {
		const summaries = normalizeMCPResourceTemplateSummaries(SERVER, [
			{
				uriTemplate: "https://user:pass@host.example/items/{id}?token=sk-leak#frag",
				name: "items\u0000by id",
				mimeType: "application/json",
			},
		], limits);
		const summary = summaries[0];
		expect(summary.displayPattern).toBe("https://host.example/items/{id}");
		expect(summary.uriTemplateDigest).toBe(mcpDigestHex("https://user:pass@host.example/items/{id}?token=sk-leak#frag"));
		expect(summary.templateId).toBe(mcpDigestId(`mcp:resource_template:${SERVER}\u0000https://user:pass@host.example/items/{id}?token=sk-leak#frag`));
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain("user:pass");
		expect(serialized).not.toContain("token=sk-leak");
		expect(serialized).not.toContain("sk-leak");
		expect(serialized).not.toContain("\u0000");
	});

	it("rejects pages over the per-page limit", () => {
		const many = Array.from({ length: limits.maxResourcesPerPage + 1 }, (_, index) => ({
			uri: `file:///${index}`,
			name: `r${index}`,
		}));
		expectFixedError(() => normalizeMCPResourceSummaries(SERVER, many, limits), "mcp_content_oversize");
		expectFixedError(() => normalizeMCPPromptSummaries(SERVER, many, limits), "mcp_content_oversize");
	});

	it("normalizes prompt summaries with sanitized argument metadata", () => {
		const summaries = normalizeMCPPromptSummaries(SERVER, [
			{
				name: "greet",
				description: "say hi",
				arguments: [
					{ name: "who\u0000", description: "the person", required: true },
					{ name: "loud", required: false },
				],
			},
		], limits);
		const summary = summaries[0];
		expect(summary).toMatchObject({
			promptId: mcpPromptId(SERVER, "greet"),
			name: "greet",
			description: "say hi",
			arguments: [
				{ name: "who", description: "the person", required: true },
				{ name: "loud", required: false },
			],
		});
		expect(summary.provenanceId).toBe(summary.promptId);
		expectFixedError(
			() => normalizeMCPPromptSummaries(SERVER, [{ name: "" }], limits),
			"mcp_content_malformed",
		);
	});

	it("maps only attachable text/image blocks to agent content", () => {
		const result = normalizeMCPResourceRead(SERVER, "file:///img", [
			{ uri: "file:///t", text: "text" },
			{ uri: "file:///img", blob: PNG_1PX, mimeType: "image/png" },
		], limits);
		const agent = mapMCPNormalizedBlocksToAgentContent(result.contents);
		expect(agent).toEqual([{ type: "text", text: "text" }]);
	});

	it("keeps digests and provenance deterministic and secret-free", () => {
		const first = normalizeMCPResourceRead(SERVER, "file:///a", [{ uri: "file:///a", text: "same" }], limits, "2026-01-01T00:00:00.000Z");
		const second = normalizeMCPResourceRead(SERVER, "file:///a", [{ uri: "file:///a", text: "same" }], limits, "2026-01-01T00:00:00.000Z");
		expect(second).toEqual(first);
		expect(first.provenance).toMatchObject({
			serverId: SERVER,
			source: "resource",
			sourceId: mcpResourceId(SERVER, "file:///a"),
			untrusted: true,
			byteCount: 4,
			blockCount: 1,
			receivedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(first.provenance.contentDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(first)).not.toContain("file:///a");
	});

	it("sanitizes and truncates text fields without throwing", () => {
		expect(sanitizeMCPText("a\u0000b\u001fc\ud800d")).toBe("abc\ufffdd");
		expect(truncateMCPField("hello", 3)).toBe("hel");
		expect(truncateMCPField("💎💎", 4)).toBe("💎");
		expect(truncateMCPField("💎💎", 3)).toBe("");
		expect(truncateMCPField("💎💎", 8)).toBe("💎💎");
	});
});
