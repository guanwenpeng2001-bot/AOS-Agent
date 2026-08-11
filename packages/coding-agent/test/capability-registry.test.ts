import { describe, expect, it } from "vitest";
import {
	buildCapabilityCatalog,
	type CapabilityBinding,
	type CapabilityCandidate,
	type CapabilityCatalog,
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
	createCapabilityId,
	createCapabilityRevision,
	type ResolveBindingInput,
	resolveCapabilityBinding,
} from "../src/core/capability-registry.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../src/core/source-info.ts";

const TMP_SOURCE: SourceInfo = createSyntheticSourceInfo("/test", {
	source: "test-src",
	scope: "temporary",
	origin: "top-level",
});

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
		...(overrides.revisionInput !== undefined ? { revisionInput: overrides.revisionInput } : {}),
	};
}

function rule(selector: CapabilitySelector, action: CapabilityDecision): CapabilityProfileRule {
	return { selector, action };
}

function profile(...rules: CapabilityProfileRule[]): CapabilityProfile {
	return { rules };
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
	it("builds ids from kind, source identity and local name", () => {
		expect(createCapabilityId("builtin_tool", "builtin", "Read")).toBe("builtin_tool:builtin:Read");
		expect(createCapabilityId("mcp_tool", "mcp:docs", "list")).toBe("mcp_tool:mcp:docs:list");
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
					parentId: "mcp_server:mcp:docs",
					sourceIdentity: "mcp",
				}),
			],
		});

		const read = catalog.descriptors.find((d) => d.name === "Read");
		expect(read).toMatchObject({
			id: "builtin_tool:test-src:Read",
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
			id: "mcp_server:mcp:docs",
			decision: "deny",
			mcpServerId: "docs",
		});
		expect(server?.exposedToolName).toBeUndefined();

		const tool = catalog.descriptors.find((d) => d.kind === "mcp_tool");
		expect(tool).toMatchObject({
			id: "mcp_tool:mcp:list",
			parentId: "mcp_server:mcp:docs",
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
		expect(catalog.descriptors[0].id).toBe("builtin_tool:test-src:Read");
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
});

describe("profile resolution", () => {
	it("applies the last matching rule", () => {
		const catalog = buildCapabilityCatalog({
			candidates: [cand({ kind: "builtin_tool", name: "Read" }), cand({ kind: "builtin_tool", name: "Write" })],
		});
		const p = profile(rule({ kind: "builtin_tool" }, "deny"), rule({ id: "builtin_tool:test-src:Read" }, "allow"));
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
			"builtin_tool:test-src:ext-tool".replace("builtin_tool", "extension_tool"),
			"skill:test-src:docs-skill",
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
			approved: ["builtin_tool:test-src:NetworkCall"],
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
		const binding = bind(catalog, { profiles: { default: p }, approved: ["builtin_tool:test-src:NetworkCall"] });
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
					parentId: "mcp_server:mcp:docs",
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
			parentId: "mcp_server:mcp:docs",
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
			rule({ parentId: "mcp_server:mcp:docs", id: "mcp_tool:mcp:list" }, "deny"),
		);
		const binding = bind(catalog, { profiles: { default: p } });
		expect(binding.descriptors.map((d) => d.id)).toEqual(["mcp_server:mcp:docs"]);
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
			approved: ["mcp_tool:mcp:list"],
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
					parentId: "mcp_server:mcp:docs",
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
		expect(view.descriptors[0].source.path).toBe("https://host/proj/.aos-agent");
		expect(view.descriptors[0]).toMatchObject({
			id: "extension:test-src:proj-ext",
			kind: "extension",
			name: "proj-ext",
			availability: "available",
			decision: "deny",
		});
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
				{ id: "builtin_tool:test-src:Read", revision: binding.descriptors[0].revision, exposedToolName: "Read" },
			],
			decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
			toolAllowlist: ["Read"],
		});
	});

	it("supports the stateful registry facade for inspection", () => {
		const registry = new CapabilityRegistry();
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
