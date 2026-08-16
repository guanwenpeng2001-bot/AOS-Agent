import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CapabilityPublicIdentity } from "../src/core/capability-public-identity.ts";
import {
	buildCapabilityCatalog as buildCapabilityCatalogWithIdentity,
	type CapabilityBinding,
	type CapabilityCandidate,
	type CapabilityCatalog,
	type CapabilityCatalogInput,
	type CapabilityDecision,
	type CapabilityError,
	CapabilityNameConflictError,
	type CapabilityProfile,
	CapabilityProfileNotFoundError,
	type CapabilityProfileRule,
	CapabilityRegistry,
	type CapabilitySelector,
	createCapabilityBindingView,
	createCapabilityCatalogView,
	createCapabilityId as createCapabilityIdWithIdentity,
	createCapabilityRevision as createCapabilityRevisionWithIdentity,
	type ResolveBindingInput,
	resolveCapabilityBinding,
} from "../src/core/capability-registry.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../src/core/source-info.ts";

const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "capability-registry-test-"));
const TEST_IDENTITY = CapabilityPublicIdentity.loadSync(TEST_AGENT_DIR);

afterAll(() => {
	rmSync(TEST_AGENT_DIR, { recursive: true, force: true });
});

function buildCapabilityCatalog(input: CapabilityCatalogInput): CapabilityCatalog {
	return buildCapabilityCatalogWithIdentity(input, TEST_IDENTITY);
}

function createCapabilityId(kind: CapabilityCandidate["kind"], sourceIdentity: string, localName: string): string {
	return createCapabilityIdWithIdentity(kind, sourceIdentity, localName, TEST_IDENTITY);
}

function createCapabilityRevision(input: unknown): string {
	return createCapabilityRevisionWithIdentity(input, TEST_IDENTITY);
}

const TMP_SOURCE: SourceInfo = createSyntheticSourceInfo("/test", {
	source: "test-src",
	scope: "temporary",
	origin: "top-level",
});
const PATH_MARKER_WIN = "C:\\audit-private\\capability-source";
const PATH_MARKER_POSIX = "/audit-private/capability-source";
const URL_MARKER = "https://audit-user:audit-secret@host.invalid/pkg?token=audit-query-secret#audit-fragment";
const PRIVATE_SOURCE_MARKERS = [
	PATH_MARKER_WIN,
	PATH_MARKER_POSIX,
	"audit-private",
	"capability-source",
	"audit-user",
	"audit-secret",
	"audit-query-secret",
	"audit-fragment",
];

function cand(
	overrides: Partial<CapabilityCandidate> & { kind: CapabilityCandidate["kind"]; name: string },
): CapabilityCandidate {
	return {
		kind: overrides.kind,
		name: overrides.name,
		sourceIdentity: overrides.sourceIdentity ?? "test-src",
		source: overrides.source ?? TMP_SOURCE,
		...(overrides.localName !== undefined ? { localName: overrides.localName } : {}),
		...(overrides.exposedToolName !== undefined ? { exposedToolName: overrides.exposedToolName } : {}),
		...(overrides.parentId !== undefined ? { parentId: overrides.parentId } : {}),
		...(overrides.mcpServerId !== undefined ? { mcpServerId: overrides.mcpServerId } : {}),
		...(overrides.trusted !== undefined ? { trusted: overrides.trusted } : {}),
		...(overrides.availability !== undefined ? { availability: overrides.availability } : {}),
		...(overrides.provenance !== undefined ? { provenance: overrides.provenance } : {}),
		...(overrides.revisionInput !== undefined ? { revisionInput: overrides.revisionInput } : {}),
	};
}

function rule(selector: CapabilitySelector, action: CapabilityDecision): CapabilityProfileRule {
	return { selector, action };
}

function profile(...rules: CapabilityProfileRule[]): CapabilityProfile {
	return { rules };
}

function expectNoPrivateSource(value: unknown): void {
	const serialized = JSON.stringify(value);
	for (const marker of PRIVATE_SOURCE_MARKERS) {
		expect(serialized).not.toContain(marker);
	}
}

function bind(
	catalog: CapabilityCatalog,
	opts?: {
		profile?: string;
		profiles?: Record<string, CapabilityProfile>;
		approved?: string[];
		tools?: string[];
		excludeTools?: string[];
		noTools?: boolean;
		now?: string;
	},
): CapabilityBinding {
	const input: ResolveBindingInput = {
		catalog,
		profile: opts?.profile ?? "default",
		profiles: opts?.profiles ?? { default: profile() },
		approvedDescriptorIds: opts?.approved,
		toolAllowlist: opts?.tools,
		excludeToolNames: opts?.excludeTools,
		noTools: opts?.noTools,
		now: opts?.now ?? "2026-08-11T00:00:00.000Z",
	};
	return resolveCapabilityBinding(input);
}

describe("createCapabilityId / createCapabilityRevision", () => {
	it("builds opaque ids from kind, source identity and local name", () => {
		const pathMarker = "C:\\audit-private\\capability-source";
		const id = createCapabilityId("builtin_tool", pathMarker, "Read");
		expect(id).toMatch(/^builtin_tool:source:[A-Za-z0-9_-]{43}:Read$/);
		expect(id).not.toContain(pathMarker);
		expect(createCapabilityId("mcp_tool", "mcp:docs", "list")).toMatch(
			/^mcp_tool:source:[A-Za-z0-9_-]{43}:list$/,
		);
	});

	it("produces a deterministic revision from the same input", () => {
		const input = { transport: "stdio", command: "node", args: ["server.js"], env: ["DOCS_TOKEN"] };
		expect(createCapabilityRevision(input)).toBe(createCapabilityRevision(input));
	});

	it("changes the revision when real content changes", () => {
		expect(createCapabilityRevision({ schema: { type: "object" } })).not.toBe(
			createCapabilityRevision({ schema: { type: "array" } }),
		);
	});

	it("ignores secret values so rotation never bumps the revision", () => {
		const base = { transport: "stdio", command: "node", args: ["server.js"], env: ["DOCS_TOKEN"] };
		const withToken = { ...base, token: "sk-super-secret-123" };
		expect(createCapabilityRevision(base)).toBe(createCapabilityRevision(withToken));
	});

	it("keeps env/header names but redacts their values from the revision", () => {
		expect(createCapabilityRevision({ env: { DOCS_TOKEN: "value-one" } })).toBe(
			createCapabilityRevision({ env: { DOCS_TOKEN: "value-two" } }),
		);
		expect(createCapabilityRevision({ headers: { Authorization: "Bearer abc" } })).toBe(
			createCapabilityRevision({ headers: { Authorization: "Bearer def" } }),
		);
	});

	it("redacts URL userinfo from the revision", () => {
		expect(createCapabilityRevision({ url: "https://user:pass@host/mcp" })).toBe(
			createCapabilityRevision({ url: "https://host/mcp" }),
		);
	});

	it("drops URL query values from the revision so rotation never bumps it", () => {
		expect(createCapabilityRevision({ url: "https://host/mcp?token=abc" })).toBe(
			createCapabilityRevision({ url: "https://host/mcp?token=xyz" }),
		);
		expect(createCapabilityRevision({ url: "https://host/mcp?token=abc" })).toBe(
			createCapabilityRevision({ url: "https://host/mcp" }),
		);
		expect(createCapabilityRevision({ url: "https://host/mcp?token=sk-leak" })).not.toContain("sk-leak");
	});

	it("never embeds a secret in the revision string", () => {
		expect(createCapabilityRevision({ token: "sk-super-secret" })).not.toContain("sk-super-secret");
	});
});

describe("secret-safe schema revision normalization", () => {
	const authSchema = (minLength: number) => ({
		type: "object",
		properties: {
			token: { type: "string", minLength },
			apiKey: { type: "string" },
			password: { type: "string" },
		},
		required: ["token", "apiKey", "password"],
	});

	it("preserves token/apiKey/password schema structure in the revision", () => {
		expect(createCapabilityRevision({ schema: authSchema(8) })).not.toBe(
			createCapabilityRevision({ schema: authSchema(16) }),
		);
		expect(createCapabilityRevision({ schema: authSchema(8) })).toBe(
			createCapabilityRevision({ schema: authSchema(8) }),
		);
	});

	it("changes the revision when a secret-named property type changes", () => {
		const stringKey = { type: "object", properties: { apiKey: { type: "string" } } };
		const arrayKey = { type: "object", properties: { apiKey: { type: "array", items: { type: "string" } } } };
		expect(createCapabilityRevision({ schema: stringKey })).not.toBe(createCapabilityRevision({ schema: arrayKey }));
	});

	it("redacts credential values while keeping schema structure", () => {
		const rev = createCapabilityRevision({
			schema: authSchema(8),
			token: "sk-top-secret",
			env: { API_KEY: "sk-env-secret", DB_PASSWORD: "hunter2" },
		});
		expect(rev).not.toContain("sk-top-secret");
		expect(rev).not.toContain("sk-env-secret");
		expect(rev).not.toContain("hunter2");
	});

	it("keeps the revision stable when credential values rotate around a schema", () => {
		const input = (token: string, envValue: string) => ({ schema: authSchema(8), token, env: { API_KEY: envValue } });
		expect(createCapabilityRevision(input("sk-one", "env-one"))).toBe(
			createCapabilityRevision(input("sk-two", "env-two")),
		);
	});

	it("changes the binding id when token/apiKey/password schema structure changes", () => {
		const bindingA = bind(
			buildCapabilityCatalog({
				candidates: [cand({ kind: "builtin_tool", name: "Auth", revisionInput: { schema: authSchema(8) } })],
			}),
		);
		const bindingB = bind(
			buildCapabilityCatalog({
				candidates: [cand({ kind: "builtin_tool", name: "Auth", revisionInput: { schema: authSchema(16) } })],
			}),
		);
		expect(bindingB.descriptors[0].revision).not.toBe(bindingA.descriptors[0].revision);
		expect(bindingB.id).not.toBe(bindingA.id);
	});

	it("keeps the binding id stable for identical schema structure", () => {
		const bindingA = bind(
			buildCapabilityCatalog({
				candidates: [cand({ kind: "builtin_tool", name: "Auth", revisionInput: { schema: authSchema(8) } })],
			}),
		);
		const bindingB = bind(
			buildCapabilityCatalog({
				candidates: [cand({ kind: "builtin_tool", name: "Auth", revisionInput: { schema: authSchema(8) } })],
			}),
		);
		expect(bindingB.id).toBe(bindingA.id);
	});

	it("never leaks credential values into the revision or ledger-facing views", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({
					kind: "builtin_tool",
					name: "Auth",
					revisionInput: { schema: authSchema(8), token: "sk-view-secret", env: { API_KEY: "sk-view-env" } },
				}),
			],
		});
		const binding = bind(catalog);
		const catalogViewJson = JSON.stringify(createCapabilityCatalogView(catalog));
		const bindingViewJson = JSON.stringify(createCapabilityBindingView(binding));
		expect(catalog.descriptors[0].revision).not.toContain("sk-view-secret");
		expect(catalog.descriptors[0].revision).not.toContain("sk-view-env");
		expect(catalogViewJson).not.toContain("sk-view-secret");
		expect(catalogViewJson).not.toContain("sk-view-env");
		expect(bindingViewJson).not.toContain("sk-view-secret");
		expect(bindingViewJson).not.toContain("sk-view-env");
	});
});

describe("buildCapabilityCatalog", () => {
	it("normalizes candidates into descriptors with default metadata", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({ kind: "builtin_tool", name: "Read" }),
				cand({ kind: "mcp_server", name: "docs", mcpServerId: "docs", sourceIdentity: "mcp" }),
				cand({
					kind: "mcp_tool",
					name: "list",
					localName: "list",
					mcpServerId: "docs",
					parentId: createCapabilityId("mcp_server", "mcp", "docs"),
					sourceIdentity: "mcp",
				}),
			],
		});

		const read = catalog.descriptors.find((d) => d.name === "Read");
		expect(read).toMatchObject({
			id: createCapabilityId("builtin_tool", "test-src", "Read"),
			kind: "builtin_tool",
			name: "Read",
			availability: "available",
			decision: "allow",
			trusted: true,
			exposedToolName: "Read",
		});
		expect(read?.revision).toMatch(/^rev:/);

		const server = catalog.descriptors.find((d) => d.kind === "mcp_server");
		expect(server).toMatchObject({
			id: createCapabilityId("mcp_server", "mcp", "docs"),
			decision: "deny",
			mcpServerId: "docs",
		});
		expect(server?.exposedToolName).toBeUndefined();

		const tool = catalog.descriptors.find((d) => d.kind === "mcp_tool");
		expect(tool).toMatchObject({
			id: createCapabilityId("mcp_tool", "mcp", "list"),
			parentId: createCapabilityId("mcp_server", "mcp", "docs"),
			mcpServerId: "docs",
			decision: "deny",
			exposedToolName: "mcp__docs__list",
		});
	});

	it("keeps the id stable across rediscovery and updates the revision", () => {
		const first = buildCapabilityCatalog({
			candidates: [cand({ kind: "builtin_tool", name: "Read", revisionInput: { schema: { type: "object" } } })],
		});
		const second = buildCapabilityCatalog({
			candidates: [
				cand({
					kind: "builtin_tool",
					name: "Read",
					revisionInput: { schema: { type: "object", properties: { extra: {} } } },
				}),
			],
		});
		expect(second.descriptors[0].id).toBe(first.descriptors[0].id);
		expect(second.descriptors[0].revision).not.toBe(first.descriptors[0].revision);
	});

	it("keeps the id stable when only the display name changes", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [cand({ kind: "builtin_tool", name: "Read Files", localName: "Read" })],
		});
		expect(catalog.descriptors[0].id).toBe(createCapabilityId("builtin_tool", "test-src", "Read"));
		expect(catalog.descriptors[0].name).toBe("Read Files");
	});

	it("marks project-scoped sources untrusted by default", () => {
		const project = createSyntheticSourceInfo("/proj", { source: "proj-ext", scope: "project", origin: "top-level" });
		const catalog = buildCapabilityCatalog({
			candidates: [cand({ kind: "extension", name: "ext", source: project })],
		});
		expect(catalog.descriptors[0].trusted).toBe(false);
		expect(catalog.descriptors[0].decision).toBe("deny");
	});

	it("fallback revision reflects behavior fields when revisionInput is absent", () => {
		const tool = (exposedToolName: string) =>
			cand({ kind: "extension_tool", name: "tool", localName: "tool", exposedToolName });
		const first = buildCapabilityCatalog({ candidates: [tool("alpha")] });
		const second = buildCapabilityCatalog({ candidates: [tool("beta")] });
		expect(first.descriptors[0].id).toBe(second.descriptors[0].id);
		expect(first.descriptors[0].revision).not.toBe(second.descriptors[0].revision);
	});

	it("fallback revision covers parent and server wiring", () => {
		const mcpTool = (parentId: string) =>
			cand({
				kind: "mcp_tool",
				name: "list",
				localName: "list",
				sourceIdentity: "mcp",
				mcpServerId: "docs",
				parentId,
			});
		const first = buildCapabilityCatalog({
			candidates: [mcpTool(createCapabilityId("mcp_server", "mcp", "docs-a"))],
		});
		const second = buildCapabilityCatalog({
			candidates: [mcpTool(createCapabilityId("mcp_server", "mcp", "docs-b"))],
		});
		expect(first.descriptors[0].id).toBe(second.descriptors[0].id);
		expect(first.descriptors[0].revision).not.toBe(second.descriptors[0].revision);
	});

	it("keeps the fallback revision stable when only the display name changes", () => {
		const first = buildCapabilityCatalog({
			candidates: [cand({ kind: "builtin_tool", name: "Read Files", localName: "Read" })],
		});
		const second = buildCapabilityCatalog({
			candidates: [cand({ kind: "builtin_tool", name: "Read Everything", localName: "Read" })],
		});
		expect(first.descriptors[0].id).toBe(second.descriptors[0].id);
		expect(first.descriptors[0].revision).toBe(second.descriptors[0].revision);
	});

	it("redacts credentials from the fallback revision", () => {
		const secretSource = createSyntheticSourceInfo("https://user:pass@host/proj", {
			source: "proj-ext",
			scope: "project",
			origin: "top-level",
		});
		const catalog = buildCapabilityCatalog({
			candidates: [cand({ kind: "extension", name: "ext", source: secretSource })],
		});
		expect(catalog.descriptors[0].revision).toMatch(/^rev:/);
		expect(catalog.descriptors[0].revision).not.toContain("user:pass");
	});
});

describe("profile resolution", () => {
	it("applies the last matching rule", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [cand({ kind: "builtin_tool", name: "Read" }), cand({ kind: "builtin_tool", name: "Write" })],
		});
		const p = profile(
			rule({ kind: "builtin_tool" }, "deny"),
			rule({ id: createCapabilityId("builtin_tool", "test-src", "Read") }, "allow"),
		);
		const binding = bind(catalog, { profiles: { default: p } });
		// Read matches both rules and the later allow wins; Write is denied
		expect(binding.toolAllowlist).toEqual(["Read"]);
		expect(binding.decisionSummary).toEqual({ allowed: 1, awaitingApproval: 0, denied: 1 });
	});

	it("falls back to safe defaults when no rule matches", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({ kind: "skill", name: "docs-skill" }),
				cand({ kind: "extension_tool", name: "ext-tool" }),
				cand({ kind: "mcp_server", name: "docs", mcpServerId: "docs", sourceIdentity: "mcp" }),
			],
		});
		const binding = bind(catalog);
		// static capabilities are allowed by default; MCP is denied by default
		expect(binding.decisionSummary).toEqual({ allowed: 2, awaitingApproval: 0, denied: 1 });
		expect(binding.descriptors.map((d) => d.id).sort()).toEqual([
			createCapabilityId("extension_tool", "test-src", "ext-tool"),
			createCapabilityId("skill", "test-src", "docs-skill"),
		]);
	});

	it("keeps ask capabilities out of the binding until approved", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [cand({ kind: "builtin_tool", name: "NetworkCall" })],
		});
		const p = profile(rule({ kind: "builtin_tool" }, "ask"));
		const pending = bind(catalog, { profiles: { default: p } });
		expect(pending.descriptors).toHaveLength(0);
		expect(pending.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 1, denied: 0 });

		const approved = bind(catalog, {
			profiles: { default: p },
			approved: [createCapabilityId("builtin_tool", "test-src", "NetworkCall")],
		});
		expect(approved.descriptors).toHaveLength(1);
		expect(approved.decisionSummary).toEqual({ allowed: 1, awaitingApproval: 0, denied: 0 });
		expect(approved.toolAllowlist).toEqual(["NetworkCall"]);
	});

	it("never lets an approval override a deny", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [cand({ kind: "builtin_tool", name: "NetworkCall" })],
		});
		const p = profile(rule({ kind: "builtin_tool" }, "deny"));
		const binding = bind(catalog, {
			profiles: { default: p },
			approved: [createCapabilityId("builtin_tool", "test-src", "NetworkCall")],
		});
		expect(binding.decisionSummary.denied).toBe(1);
		expect(binding.toolAllowlist).toEqual([]);
	});

	it("matches rules by mcpServerId across a server and its tools", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({ kind: "mcp_server", name: "docs", mcpServerId: "docs", sourceIdentity: "mcp" }),
				cand({
					kind: "mcp_tool",
					name: "list",
					mcpServerId: "docs",
					parentId: createCapabilityId("mcp_server", "mcp", "docs"),
					sourceIdentity: "mcp",
				}),
			],
		});
		const p = profile(rule({ mcpServerId: "docs" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 2, awaitingApproval: 0, denied: 0 });
	});

	it("throws capability_profile_not_found for an unknown profile", () => {
		const catalog = buildCapabilityCatalog({ candidates: [] });
		expect(() => bind(catalog, { profile: "nope" })).toThrow(CapabilityProfileNotFoundError);
		expect(() => bind(catalog, { profile: "nope" })).toThrow(/not found/);
	});
});

describe("MCP parent-server inheritance", () => {
	const server = () => cand({ kind: "mcp_server", name: "docs", mcpServerId: "docs", sourceIdentity: "mcp" });
	const tool = () =>
		cand({
			kind: "mcp_tool",
			name: "list",
			mcpServerId: "docs",
			parentId: createCapabilityId("mcp_server", "mcp", "docs"),
			sourceIdentity: "mcp",
		});

	it("denies a tool when its parent server is denied, even if a tool rule allows it", () => {
		const catalog = buildCapabilityCatalog({ candidates: [server(), tool()] });
		const p = profile(rule({ kind: "mcp_server" }, "deny"), rule({ kind: "mcp_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 2 });
	});

	it("allows a server while denying one of its tools", () => {
		const catalog = buildCapabilityCatalog({ candidates: [server(), tool()] });
		const p = profile(
			rule({ kind: "mcp_server" }, "allow"),
			rule(
				{
					parentId: createCapabilityId("mcp_server", "mcp", "docs"),
					id: createCapabilityId("mcp_tool", "mcp", "list"),
				},
				"deny",
			),
		);
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.descriptors.map((d) => d.id)).toEqual([createCapabilityId("mcp_server", "mcp", "docs")]);
		expect(binding.decisionSummary).toEqual({ allowed: 1, awaitingApproval: 0, denied: 1 });
	});

	it("caps a tool at the parent server's ask decision", () => {
		const catalog = buildCapabilityCatalog({ candidates: [server(), tool()] });
		const p = profile(rule({ kind: "mcp_server" }, "ask"), rule({ kind: "mcp_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 2, denied: 0 });
	});

	it("denies a tool with no known parent server", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [cand({ kind: "mcp_tool", name: "ghost", mcpServerId: "nope", sourceIdentity: "mcp" })],
		});
		const p = profile(rule({ kind: "mcp_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 1 });
	});

	it("exposes allowed MCP tools under their namespaced name", () => {
		const catalog = buildCapabilityCatalog({ candidates: [server(), tool()] });
		const p = profile(rule({ kind: "mcp_server" }, "allow"), rule({ kind: "mcp_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 2, awaitingApproval: 0, denied: 0 });
		expect(binding.toolAllowlist).toEqual(["mcp__docs__list"]);
	});

	it("does not select an approved child tool whose parent server is ask-unapproved", () => {
		const catalog = buildCapabilityCatalog({ candidates: [server(), tool()] });
		const p = profile(rule({ kind: "mcp_server" }, "ask"), rule({ kind: "mcp_tool" }, "allow"));
		const binding = bind(catalog, {
			profiles: { default: p },
			approved: [createCapabilityId("mcp_tool", "mcp", "list")],
		});
		expect(binding.descriptors).toHaveLength(0);
		expect(binding.toolAllowlist).toEqual([]);
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 2, denied: 0 });
	});

	it("does not select a child tool whose parent server is unavailable", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [{ ...server(), availability: "unavailable" }, tool()],
		});
		const p = profile(rule({ kind: "mcp_server" }, "allow"), rule({ kind: "mcp_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.descriptors).toHaveLength(0);
		expect(binding.toolAllowlist).toEqual([]);
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 1 });
	});
});

describe("generic parent inheritance for extension tools", () => {
	const extension = () => cand({ kind: "extension", name: "my-ext", localName: "my-ext", sourceIdentity: "ext" });
	const tool = () =>
		cand({
			kind: "extension_tool",
			name: "my-tool",
			localName: "my-tool",
			sourceIdentity: "ext",
			parentId: createCapabilityId("extension", "ext", "my-ext"),
		});

	it("allows an extension and its extension_tool child together", () => {
		const catalog = buildCapabilityCatalog({ candidates: [extension(), tool()] });
		const p = profile(rule({ kind: "extension" }, "allow"), rule({ kind: "extension_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 2, awaitingApproval: 0, denied: 0 });
		expect(binding.toolAllowlist).toEqual(["my-tool"]);
	});

	it("denies an extension_tool when its extension parent is denied", () => {
		const catalog = buildCapabilityCatalog({ candidates: [extension(), tool()] });
		const p = profile(rule({ kind: "extension" }, "deny"), rule({ kind: "extension_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 2 });
	});

	it("caps an extension_tool at the extension parent's ask decision", () => {
		const catalog = buildCapabilityCatalog({ candidates: [extension(), tool()] });
		const p = profile(rule({ kind: "extension" }, "ask"), rule({ kind: "extension_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 2, denied: 0 });
	});

	it("keeps an extension_tool out of the binding when its parent is unavailable", () => {
		const catalog = buildCapabilityCatalog({ candidates: [{ ...extension(), availability: "unavailable" }, tool()] });
		const p = profile(rule({ kind: "extension" }, "allow"), rule({ kind: "extension_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 1 });
	});

	it("denies an extension_tool with no known extension parent", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({
					kind: "extension_tool",
					name: "ghost",
					sourceIdentity: "ext",
					parentId: createCapabilityId("extension", "ext", "missing"),
				}),
			],
		});
		const p = profile(rule({ kind: "extension_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 1 });
	});
});

describe("MCP resource and prompt content capabilities", () => {
	const server = () => cand({ kind: "mcp_server", name: "docs", mcpServerId: "docs", sourceIdentity: "mcp" });
	const resource = () =>
		cand({
			kind: "mcp_resource",
			name: "README",
			localName: "MCPResourceDigestDocsReadme",
			mcpServerId: "docs",
			parentId: createCapabilityId("mcp_server", "mcp", "docs"),
			sourceIdentity: "mcp",
			provenance: "prov-resource-1",
			revisionInput: {
				resourceId: "MCPResourceDigestDocsReadme",
				name: "README",
				title: "README",
				description: "Docs readme",
				mimeType: "text/markdown",
				provenanceId: "prov-resource-1",
				revision: "rev-summary-1",
			},
		});
	const prompt = () =>
		cand({
			kind: "mcp_prompt",
			name: "summarize",
			localName: "MCPPromptDigestSummarize",
			mcpServerId: "docs",
			parentId: createCapabilityId("mcp_server", "mcp", "docs"),
			sourceIdentity: "mcp",
			provenance: "prov-prompt-1",
			revisionInput: {
				promptId: "MCPPromptDigestSummarize",
				name: "summarize",
				arguments: [{ name: "topic" }],
				provenanceId: "prov-prompt-1",
				revision: "rev-summary-2",
			},
		});
	const tool = () =>
		cand({
			kind: "mcp_tool",
			name: "list",
			mcpServerId: "docs",
			parentId: createCapabilityId("mcp_server", "mcp", "docs"),
			sourceIdentity: "mcp",
		});

	it("denies MCP content capabilities by default like their servers", () => {
		const catalog = buildCapabilityCatalog({ candidates: [server(), resource(), prompt()] });
		const binding = bind(catalog);
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 3 });
	});

	it("cascades a server deny to content children even when content rules allow", () => {
		const catalog = buildCapabilityCatalog({ candidates: [server(), resource(), prompt()] });
		const p = profile(
			rule({ kind: "mcp_server" }, "deny"),
			rule({ kind: "mcp_resource" }, "allow"),
			rule({ kind: "mcp_prompt" }, "allow"),
		);
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 3 });
		expect(binding.descriptors).toHaveLength(0);
	});

	it("caps content children at the parent server's ask decision", () => {
		const catalog = buildCapabilityCatalog({ candidates: [server(), resource(), prompt()] });
		const p = profile(
			rule({ kind: "mcp_server" }, "ask"),
			rule({ kind: "mcp_resource" }, "allow"),
			rule({ kind: "mcp_prompt" }, "allow"),
		);
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 3, denied: 0 });
		// Approving only the content child never selects it while the parent is ask-unapproved.
		const approved = bind(catalog, {
			profiles: { default: p },
			approved: [createCapabilityId("mcp_resource", "mcp", "MCPResourceDigestDocsReadme")],
		});
		expect(approved.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 3, denied: 0 });
	});

	it("denies a content capability with no known parent server", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({
					kind: "mcp_resource",
					name: "ghost",
					localName: "MCPResourceDigestGhost",
					mcpServerId: "nope",
					sourceIdentity: "mcp",
				}),
			],
		});
		const p = profile(rule({ kind: "mcp_resource" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 1 });
	});

	it("selects content capabilities by kind and mcpServerId parent matching", () => {
		const catalog = buildCapabilityCatalog({ candidates: [server(), resource(), prompt(), tool()] });
		const p = profile(
			rule({ kind: "mcp_server" }, "allow"),
			rule({ mcpServerId: "docs" }, "allow"),
		);
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 4, awaitingApproval: 0, denied: 0 });
		expect(binding.descriptors.map((descriptor) => descriptor.id).sort()).toEqual(
			[
				createCapabilityId("mcp_server", "mcp", "docs"),
				createCapabilityId("mcp_tool", "mcp", "list"),
				createCapabilityId("mcp_resource", "mcp", "MCPResourceDigestDocsReadme"),
				createCapabilityId("mcp_prompt", "mcp", "MCPPromptDigestSummarize"),
			].sort(),
		);
	});

	it("never adds resources or prompts to the model tool allowlist", () => {
		const catalog = buildCapabilityCatalog({ candidates: [server(), resource(), prompt(), tool()] });
		const p = profile(
			rule({ kind: "mcp_server" }, "allow"),
			rule({ kind: "mcp_tool" }, "allow"),
			rule({ kind: "mcp_resource" }, "allow"),
			rule({ kind: "mcp_prompt" }, "allow"),
		);
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary.allowed).toBe(4);
		// Only the tool is model-visible; resource/prompt descriptors stay in the
		// binding for governance but never surface as tool names.
		expect(binding.toolAllowlist).toEqual(["mcp__docs__list"]);
	});

	it("keeps content revisions and provenance secret-free in catalog views", () => {
		const secretSummary = {
			resourceId: "MCPResourceDigestDocsReadme",
			name: "README",
			title: "README",
			description: "Docs readme",
			mimeType: "text/markdown",
			provenanceId: "prov-resource-1",
			revision: "rev-summary-1",
			token: "sk-audit-secret-token",
			env: { DOCS_TOKEN: "audit-env-value" },
		};
		const withoutToken: Record<string, unknown> = {
			resourceId: "MCPResourceDigestDocsReadme",
			name: "README",
			title: "README",
			description: "Docs readme",
			mimeType: "text/markdown",
			provenanceId: "prov-resource-1",
			revision: "rev-summary-1",
			env: { DOCS_TOKEN: "audit-env-value" },
		};
		const catalog = buildCapabilityCatalog({
			candidates: [
				server(),
				cand({
					kind: "mcp_resource",
					name: "README",
					localName: "MCPResourceDigestDocsReadme",
					mcpServerId: "docs",
					parentId: createCapabilityId("mcp_server", "mcp", "docs"),
					sourceIdentity: "mcp",
					provenance: "prov-resource-1",
					revisionInput: secretSummary,
				}),
			],
		});
		const view = createCapabilityCatalogView(catalog);
		const descriptorView = view.descriptors.find((descriptor) => descriptor.kind === "mcp_resource");
		expect(descriptorView).toBeDefined();
		expect(descriptorView?.provenance).toBe("prov-resource-1");
		expect(descriptorView?.revision).toMatch(/^rev:[A-Za-z0-9_-]{43}$/);
		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain("sk-audit-secret-token");
		expect(serialized).not.toContain("audit-env-value");
		// Secret rotation never bumps the content capability revision.
		const withSecret = catalog.descriptors.find((descriptor) => descriptor.kind === "mcp_resource");
		expect(withSecret?.revision).toBe(createCapabilityRevision(withoutToken));
	});
});

describe("trust gating", () => {
	const untrustedProject = createSyntheticSourceInfo("/proj", {
		source: "proj-ext",
		scope: "project",
		origin: "top-level",
	});

	it("denies untrusted project capabilities regardless of profile allow", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({ kind: "extension", name: "proj-ext", source: untrustedProject }),
				cand({
					kind: "mcp_server",
					name: "docs",
					mcpServerId: "docs",
					sourceIdentity: "mcp",
					source: untrustedProject,
				}),
			],
		});
		const p = profile(rule({ kind: "extension" }, "allow"), rule({ kind: "mcp_server" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 0, denied: 2 });
	});

	it("allows a trusted project capability", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [cand({ kind: "extension", name: "proj-ext", source: untrustedProject, trusted: true })],
		});
		const binding = bind(catalog);
		expect(binding.decisionSummary.allowed).toBe(1);
	});

	it("propagates untrusted parent servers to their tools", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({
					kind: "mcp_server",
					name: "docs",
					mcpServerId: "docs",
					sourceIdentity: "mcp",
					source: untrustedProject,
				}),
				cand({
					kind: "mcp_tool",
					name: "list",
					mcpServerId: "docs",
					parentId: createCapabilityId("mcp_server", "mcp", "docs"),
					sourceIdentity: "mcp",
				}),
			],
		});
		const p = profile(rule({ kind: "mcp_server" }, "allow"), rule({ kind: "mcp_tool" }, "allow"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.decisionSummary.denied).toBe(2);
	});
});

describe("final tool allowlist intersection", () => {
	const catalog = buildCapabilityCatalog({
		candidates: [
			cand({ kind: "builtin_tool", name: "Read" }),
			cand({ kind: "builtin_tool", name: "Write" }),
			cand({ kind: "skill", name: "docs-skill" }),
		],
	});

	it("narrows to the tools allowlist after binding", () => {
		const binding = bind(catalog, { tools: ["Read"] });
		expect(binding.toolAllowlist).toEqual(["Read"]);
		// skills and other selected capabilities stay in the binding
		expect(binding.descriptors).toHaveLength(3);
		expect(binding.decisionSummary.allowed).toBe(3);
	});

	it("applies excludeTools", () => {
		const binding = bind(catalog, { excludeTools: ["Write"] });
		expect(binding.toolAllowlist).toEqual(["Read"]);
	});

	it("removes every tool under noTools while keeping skills", () => {
		const binding = bind(catalog, { noTools: true });
		expect(binding.toolAllowlist).toEqual([]);
		expect(binding.descriptors).toHaveLength(3);
	});

	it("cannot re-allow a Registry deny through the tools allowlist", () => {
		const p = profile(rule({ kind: "builtin_tool" }, "deny"));
		const binding = bind(catalog, { profiles: { default: p }, tools: ["Read", "Write"] });
		expect(binding.toolAllowlist).toEqual([]);
		expect(binding.decisionSummary.denied).toBe(2);
	});
});

describe("binding identity includes tool selection semantics", () => {
	const catalog = buildCapabilityCatalog({
		candidates: [cand({ kind: "builtin_tool", name: "Read" }), cand({ kind: "builtin_tool", name: "Write" })],
	});

	it("does not collide tools vs excludeTools that yield the same final allowlist", () => {
		const viaTools = bind(catalog, { tools: ["Read"] });
		const viaExclude = bind(catalog, { excludeTools: ["Write"] });
		expect(viaTools.toolAllowlist).toEqual(["Read"]);
		expect(viaExclude.toolAllowlist).toEqual(["Read"]);
		expect(viaTools.id).not.toBe(viaExclude.id);
	});

	it("does not collide noTools, an empty tools allowlist, or excluding everything", () => {
		const ids = [
			bind(catalog, { noTools: true }).id,
			bind(catalog, { tools: [] }).id,
			bind(catalog, { excludeTools: ["Read", "Write"] }).id,
		];
		expect(new Set(ids).size).toBe(3);
	});

	it("normalizes order and duplicates so equivalent selections stay stable", () => {
		const first = bind(catalog, { tools: ["Write", "Read", "Read"] });
		const second = bind(catalog, { tools: ["Read", "Write"] });
		expect(first.toolAllowlist).toEqual(["Read", "Write"]);
		expect(second.toolAllowlist).toEqual(first.toolAllowlist);
		expect(second.id).toBe(first.id);
	});

	it("changes the binding id when the final allowlist changes", () => {
		const readOnly = bind(catalog, { tools: ["Read"] });
		const both = bind(catalog, { tools: ["Read", "Write"] });
		expect(readOnly.id).not.toBe(both.id);
	});
});

describe("name-conflict failure", () => {
	it("fails with capability_name_conflict when two selected capabilities expose the same name", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({ kind: "builtin_tool", name: "read", exposedToolName: "read" }),
				cand({ kind: "sdk_tool", name: "read", sourceIdentity: "sdk", exposedToolName: "read" }),
			],
		});
		expect(() => bind(catalog)).toThrow(CapabilityNameConflictError);
		try {
			bind(catalog);
			expect.unreachable("expected a name conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(CapabilityNameConflictError);
			expect((error as CapabilityError).code).toBe("capability_name_conflict");
			expect((error as CapabilityNameConflictError).conflictingNames).toContain("read");
		}
	});

	it("does not conflict when one duplicate is denied", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({ kind: "builtin_tool", name: "read", exposedToolName: "read" }),
				cand({ kind: "sdk_tool", name: "read", sourceIdentity: "sdk", exposedToolName: "read" }),
			],
		});
		const p = profile(rule({ kind: "sdk_tool" }, "deny"));
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.toolAllowlist).toEqual(["read"]);
	});

	it("still fails when the colliding name would be narrowed away", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({ kind: "builtin_tool", name: "read", exposedToolName: "read" }),
				cand({ kind: "sdk_tool", name: "read", sourceIdentity: "sdk", exposedToolName: "read" }),
			],
		});
		expect(() => bind(catalog, { tools: [] })).toThrow(CapabilityNameConflictError);
	});
});

describe("public identity boundary", () => {
	it("keeps raw configured sources internal while serializing opaque IDs and source views", () => {
		const winSource = createSyntheticSourceInfo(PATH_MARKER_WIN, {
			source: PATH_MARKER_WIN,
			scope: "user",
			origin: "package",
		});
		const posixSource = createSyntheticSourceInfo(PATH_MARKER_POSIX, {
			source: PATH_MARKER_POSIX,
			scope: "user",
			origin: "package",
		});
		const urlSource = createSyntheticSourceInfo(URL_MARKER, {
			source: URL_MARKER,
			scope: "user",
			origin: "package",
		});
		const extensionId = createCapabilityId("extension", PATH_MARKER_WIN, "win-extension");
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({
					kind: "extension",
					name: "win-extension",
					localName: "win-extension",
					sourceIdentity: PATH_MARKER_WIN,
					source: winSource,
				}),
				cand({
					kind: "extension_tool",
					name: "win-tool",
					localName: "win-tool",
					sourceIdentity: PATH_MARKER_WIN,
					source: winSource,
					parentId: extensionId,
					exposedToolName: "win-tool",
				}),
				cand({
					kind: "skill",
					name: "posix-skill",
					sourceIdentity: PATH_MARKER_POSIX,
					source: posixSource,
				}),
				cand({
					kind: "sdk_tool",
					name: "url-tool",
					sourceIdentity: URL_MARKER,
					source: urlSource,
					exposedToolName: "url-tool",
				}),
			],
		});
		const binding = bind(catalog);
		const catalogView = createCapabilityCatalogView(catalog);
		const bindingView = createCapabilityBindingView(binding);

		expect(catalog.descriptors.find((descriptor) => descriptor.id === extensionId)?.source.source).toBe(PATH_MARKER_WIN);
		for (const descriptor of catalogView.descriptors) {
			expect(descriptor.id).toMatch(new RegExp(`^${descriptor.kind}:source:[A-Za-z0-9_-]{43}:`));
			expect(descriptor.revision).toMatch(/^rev:[A-Za-z0-9_-]{43}$/);
			expect(descriptor.source.source).toMatch(/^source:[A-Za-z0-9_-]{43}$/);
		}
		expect(binding.id).toMatch(/^binding:[A-Za-z0-9_-]{43}$/);
		expectNoPrivateSource(catalogView);
		expectNoPrivateSource(binding);
		expectNoPrivateSource(bindingView);

		const sourceDenied = bind(catalog, {
			profiles: { default: profile(rule({ sourceId: PATH_MARKER_WIN }, "deny")) },
		});
		expect(sourceDenied.descriptors.some((descriptor) => descriptor.id === extensionId)).toBe(false);
		expectNoPrivateSource(sourceDenied);
	});

	it("keeps hidden origins distinct and still fails closed on a public tool-name conflict", () => {
		const firstSource = createSyntheticSourceInfo(PATH_MARKER_WIN, {
			source: PATH_MARKER_WIN,
			scope: "user",
			origin: "package",
		});
		const secondSource = createSyntheticSourceInfo(PATH_MARKER_POSIX, {
			source: PATH_MARKER_POSIX,
			scope: "user",
			origin: "package",
		});
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({
					kind: "extension_tool",
					name: "shared",
					localName: "shared",
					sourceIdentity: PATH_MARKER_WIN,
					source: firstSource,
					exposedToolName: "shared",
				}),
				cand({
					kind: "extension_tool",
					name: "shared",
					localName: "shared",
					sourceIdentity: PATH_MARKER_POSIX,
					source: secondSource,
					exposedToolName: "shared",
				}),
			],
		});

		expect(catalog.descriptors).toHaveLength(2);
		expect(catalog.descriptors[0].id).not.toBe(catalog.descriptors[1].id);
		expect(() => bind(catalog)).toThrow(CapabilityNameConflictError);
	});

	it("keeps public identities stable for one agentDir and isolated across installations", () => {
		const firstAgentDir = mkdtempSync(join(tmpdir(), "capability-registry-identity-a-"));
		const secondAgentDir = mkdtempSync(join(tmpdir(), "capability-registry-identity-b-"));
		try {
			const firstIdentity = CapabilityPublicIdentity.loadSync(firstAgentDir);
			const reloadedIdentity = CapabilityPublicIdentity.loadSync(firstAgentDir);
			const secondIdentity = CapabilityPublicIdentity.loadSync(secondAgentDir);
			const input: CapabilityCatalogInput = {
				candidates: [
					cand({
						kind: "extension_tool",
						name: "private-tool",
						sourceIdentity: PATH_MARKER_WIN,
						source: createSyntheticSourceInfo(PATH_MARKER_WIN, {
							source: PATH_MARKER_WIN,
							scope: "user",
							origin: "package",
						}),
						revisionInput: { source: PATH_MARKER_WIN },
					}),
				],
			};
			const firstCatalog = buildCapabilityCatalogWithIdentity(input, firstIdentity);
			const reloadedCatalog = buildCapabilityCatalogWithIdentity(input, reloadedIdentity);
			const secondCatalog = buildCapabilityCatalogWithIdentity(input, secondIdentity);

			expect(firstCatalog.descriptors[0].id).toBe(reloadedCatalog.descriptors[0].id);
			expect(firstCatalog.descriptors[0].revision).toBe(reloadedCatalog.descriptors[0].revision);
			expect(bind(firstCatalog).id).toBe(bind(reloadedCatalog).id);
			expect(firstCatalog.descriptors[0].id).not.toBe(secondCatalog.descriptors[0].id);
			expect(firstCatalog.descriptors[0].revision).not.toBe(secondCatalog.descriptors[0].revision);
			expect(bind(firstCatalog).id).not.toBe(bind(secondCatalog).id);
		} finally {
			rmSync(firstAgentDir, { recursive: true, force: true });
			rmSync(secondAgentDir, { recursive: true, force: true });
		}
	});
});

describe("binding lifecycle and views", () => {
	it("excludes unavailable catalog items from the binding but keeps them for diagnosis", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({ kind: "builtin_tool", name: "Read" }),
				cand({ kind: "sdk_tool", name: "Flaky", sourceIdentity: "sdk", availability: "unavailable" }),
			],
		});
		expect(catalog.descriptors).toHaveLength(2);
		const binding = bind(catalog);
		expect(binding.descriptors).toHaveLength(1);
		expect(binding.toolAllowlist).toEqual(["Read"]);
		expect(binding.decisionSummary).toEqual({ allowed: 1, awaitingApproval: 0, denied: 0 });
	});

	it("produces a deterministic binding id independent of createdAt", () => {
		const catalog = buildCapabilityCatalog({ candidates: [cand({ kind: "builtin_tool", name: "Read" })] });
		const first = bind(catalog, { now: "2026-08-11T00:00:00.000Z" });
		const second = bind(catalog, { now: "2026-08-11T00:00:01.000Z" });
		expect(second.id).toBe(first.id);
		expect(second.createdAt).not.toBe(first.createdAt);
	});

	it("redacts secrets, credentials and URL query values from the catalog view", () => {
		const project = createSyntheticSourceInfo("https://user:secret@host/proj/.aos-agent?token=sk-query", {
			source: "proj-ext",
			scope: "project",
			origin: "top-level",
		});
		const catalog = buildCapabilityCatalog({
			candidates: [
				cand({ kind: "extension", name: "proj-ext", source: project, revisionInput: { token: "sk-hush" } }),
			],
		});
		const view = createCapabilityCatalogView(catalog);
		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain("sk-hush");
		expect(serialized).not.toContain("sk-query");
		expect(serialized).not.toContain("user:secret");
		expect("path" in view.descriptors[0].source).toBe(false);
		expect("baseDir" in view.descriptors[0].source).toBe(false);
		expect(view.descriptors[0]).toMatchObject({
			id: createCapabilityId("extension", "test-src", "proj-ext"),
			kind: "extension",
			name: "proj-ext",
			availability: "available",
			decision: "deny",
		});
	});

	it("deep-freezes catalogs, bindings, and their nested public data", () => {
		const catalog = buildCapabilityCatalog({ candidates: [cand({ kind: "builtin_tool", name: "Read" })] });
		const binding = bind(catalog);

		expect(Object.isFrozen(catalog)).toBe(true);
		expect(Object.isFrozen(catalog.descriptors)).toBe(true);
		expect(Object.isFrozen(catalog.descriptors[0])).toBe(true);
		expect(Object.isFrozen(catalog.descriptors[0].source)).toBe(true);
		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.isFrozen(binding.descriptors)).toBe(true);
		expect(Object.isFrozen(binding.descriptors[0])).toBe(true);
		expect(Object.isFrozen(binding.decisionSummary)).toBe(true);
		expect(Object.isFrozen(binding.toolAllowlist)).toBe(true);
	});

	it("produces a redacted binding view that mirrors the binding", () => {
		const catalog = buildCapabilityCatalog({ candidates: [cand({ kind: "builtin_tool", name: "Read" })] });
		const binding = bind(catalog);
		const view = createCapabilityBindingView(binding);
		expect(view).toEqual({
			id: binding.id,
			profile: "default",
			createdAt: "2026-08-11T00:00:00.000Z",
			descriptors: [
				{
					id: createCapabilityId("builtin_tool", "test-src", "Read"),
					revision: binding.descriptors[0].revision,
					exposedToolName: "Read",
				},
			],
			decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
			toolAllowlist: ["Read"],
		});
	});

	it("supports the stateful registry facade for inspection", () => {
		const registry = new CapabilityRegistry(TEST_IDENTITY);
		const catalog = registry.buildCatalog({ candidates: [cand({ kind: "builtin_tool", name: "Read" })] });
		const binding = registry.resolveBinding({
			catalog,
			profile: "default",
			profiles: { default: profile() },
			now: "2026-08-11T00:00:00.000Z",
		});
		expect(registry.inspectCatalog()?.descriptors).toHaveLength(1);
		expect(registry.inspectBinding(binding.id)).toMatchObject({ id: binding.id, profile: "default" });
		expect(registry.inspectBinding("missing")).toBeUndefined();
	});
});
