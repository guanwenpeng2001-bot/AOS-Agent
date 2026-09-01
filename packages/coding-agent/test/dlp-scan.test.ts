import { Buffer } from "node:buffer";
import type { AgentMessage } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	DLP_DENY_MARKER,
	DLP_REDACTION_MARKER,
	DLP_WARNING_MARKER,
	DlpScanner,
	DlpViolationError,
} from "../src/core/dlp.ts";
import type { DlpPolicy } from "../src/core/policy/execution.ts";
import { SessionManagerStorage } from "../src/core/session/manager-storage.ts";
import { SessionManager } from "../src/core/session/manager.ts";
import { createAgentSessionReadProjection } from "../src/core/session/read-projection.ts";
import { AuthStorage } from "../src/core/policy/auth-storage.ts";
import { RuntimeCredentials } from "../src/core/runtime/credentials.ts";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

function toolResult(text: string, details?: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "fixture",
		content: [{ type: "text", text }],
		...(details === undefined ? {} : { details }),
		isError: false,
		timestamp: 1,
	};
}

function scanner(policy: DlpPolicy, materials: readonly string[] = []): DlpScanner {
	return new DlpScanner({ policy: () => policy, credentialMaterials: async () => materials });
}

function textOf(message: ToolResultMessage): string {
	const block = message.content[0];
	return block?.type === "text" ? block.text : "";
}

function jwt(): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ sub: "user-1", iat: 1_700_000_000 })).toString("base64url");
	return `${header}.${payload}.${"a".repeat(32)}`;
}

describe("DLP secret scanning", () => {
	it("reads API-key, OAuth, and MCP namespace material from an in-memory credential store", async () => {
		const credentials = new RuntimeCredentials(AuthStorage.inMemory({
			openai: { type: "api_key", key: "stored-api-key-material" },
			anthropic: { type: "oauth", access: "oauth-access-material", refresh: "oauth-refresh-material", expires: 1 },
			mcp__fixture: { type: "oauth", access: "mcp-access-material", refresh: "mcp-refresh-material", expires: 1 },
		}));
		credentials.setRuntimeApiKey("runtime", "runtime-api-key-material");

		expect(await credentials.getDlpCredentialMaterials()).toEqual(expect.arrayContaining([
			"stored-api-key-material",
			"oauth-access-material",
			"oauth-refresh-material",
			"mcp-access-material",
			"mcp-refresh-material",
			"runtime-api-key-material",
		]));
	});

	it("redacts exact credential material before tool-result persistence", async () => {
		const credential = "known-secret-material-12345";
		const dlp = scanner({ enabled: true, action: "redact" }, [credential]);
		const manager = SessionManager.inMemory();
		const storage = new SessionManagerStorage(manager, { dlpScanner: dlp });

		const written = await storage.appendEntry({
			type: "message",
			id: "tool-result",
			message: toolResult(`token=${credential}`, { nested: credential }),
		}, "main");

		expect(written.type).toBe("message");
		if (written.type !== "message" || written.message.role !== "toolResult") throw new Error("Expected tool result");
		expect(textOf(written.message)).toBe(`token=${DLP_REDACTION_MARKER}`);
		expect(written.message.details).toEqual({ nested: DLP_REDACTION_MARKER });
		expect(JSON.stringify(manager.getPhysicalEntries())).not.toContain(credential);
	});

	it("never rewrites tool correlation metadata", async () => {
		const secretLikeId = `sk-${"M".repeat(24)}`;
		const message = {
			...toolResult(secretLikeId),
			toolCallId: secretLikeId,
			toolName: secretLikeId,
		};
		const protectedMessage = await scanner({ enabled: true, action: "redact" })
			.protectToolResultForPersistence(message);

		expect(protectedMessage.toolCallId).toBe(secretLikeId);
		expect(protectedMessage.toolName).toBe(secretLikeId);
		expect(textOf(protectedMessage)).toBe(DLP_REDACTION_MARKER);
	});

	it("redacts high-confidence OpenAI keys, JWTs, and private-key blocks", async () => {
		const openAiKey = `sk-${"A".repeat(24)}`;
		const privateKey = "-----BEGIN PRIVATE KEY-----\nZmFrZS1wcml2YXRlLWtleQ==\n-----END PRIVATE KEY-----";
		const source = `${openAiKey}\n${jwt()}\n${privateKey}`;
		const protectedMessage = await scanner({ enabled: true, action: "redact" })
			.protectToolResultForPersistence(toolResult(source));

		expect(textOf(protectedMessage)).toBe([
			DLP_REDACTION_MARKER,
			DLP_REDACTION_MARKER,
			DLP_REDACTION_MARKER,
		].join("\n"));
	});

	it("does not alter the conservative false-positive corpus", async () => {
		const cases = [
			"const prefix = 'sk-';",
			"sk-example and sk-short",
			"const token = process.env.OPENAI_API_KEY;",
			"sha256:6f1ed002ab5595859014ebf0951522d9",
			"550e8400-e29b-41d4-a716-446655440000",
			"eyJub3QiOiJqd3QifQ.invalid.signature",
			"-----BEGIN PUBLIC KEY-----",
			"/\\bsk-[A-Za-z0-9_-]{20,}\\b/",
			"package @scope/sk-helper exports a tokenizer",
		];
		const dlp = scanner({ enabled: true, action: "redact" });

		for (const value of cases) {
			const message = toolResult(value);
			expect(await dlp.protectToolResultForPersistence(message), value).toBe(message);
		}
	});

	it("denies a matching durable write without appending an entry", async () => {
		const dlp = scanner({ enabled: true, action: "deny" });
		const manager = SessionManager.inMemory();
		const storage = new SessionManagerStorage(manager, { dlpScanner: dlp });

		await expect(storage.appendEntry({
			type: "message",
			id: "denied-result",
			message: toolResult(`sk-${"B".repeat(24)}`),
		}, "main")).rejects.toBeInstanceOf(DlpViolationError);
		expect(await storage.getEntry("denied-result")).toBeUndefined();
	});

	it("warns at projection while retaining the configured durable value", async () => {
		const dlp = scanner({ enabled: true, action: "warn" });
		const manager = SessionManager.inMemory();
		const storage = new SessionManagerStorage(manager, { dlpScanner: dlp });
		const secret = `sk-${"C".repeat(24)}`;
		await storage.appendEntry({ type: "message", id: "warn-result", message: toolResult(secret) }, "main");

		const durable = await storage.getEntry("warn-result");
		expect(JSON.stringify(durable)).toContain(secret);
		const projected = createAgentSessionReadProjection(manager, dlp).getEntries()[0];
		if (projected?.type !== "message" || projected.message.role !== "toolResult") throw new Error("Expected projected tool result");
		expect(textOf(projected.message)).toBe(`${DLP_WARNING_MARKER}\n${secret}`);
	});

	it("omits matches from deny projections", async () => {
		const secret = `sk-${"D".repeat(24)}`;
		const projected = scanner({ enabled: true, action: "deny" }).projectToolResult(toolResult(secret));
		expect(textOf(projected)).toBe(DLP_DENY_MARKER);
		expect(textOf(projected)).not.toContain(secret);
	});

	it("does not read credentials or traverse values when disabled", async () => {
		let reads = 0;
		const dlp = new DlpScanner({
			policy: () => ({ enabled: false, action: "redact" }),
			credentialMaterials: async () => {
				reads += 1;
				return ["known-secret-material-12345"];
			},
		});
		const message = toolResult(`sk-${"E".repeat(24)}`);

		expect(await dlp.protectToolResultForPersistence(message)).toBe(message);
		expect(dlp.projectToolResult(message)).toBe(message);
		expect(reads).toBe(0);
	});
});
