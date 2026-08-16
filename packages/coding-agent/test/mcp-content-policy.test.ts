import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CapabilityPublicIdentity } from "../src/core/capability-public-identity.ts";
import {
	buildCapabilityCatalog as buildCapabilityCatalogWithIdentity,
	type CapabilityCandidate,
	type CapabilityCatalog,
	type CapabilityCatalogInput,
	type CapabilityDecision,
	CapabilityRegistry,
	type CapabilityProfileRule,
	type CapabilitySelector,
	findCapabilityDescriptor,
	getCapabilityLocalName,
	resolveCapabilityBinding,
	resolveCapabilityDecisions,
} from "../src/core/capability-registry.ts";
import {
	buildCapabilitySettings,
	type CapabilitySettingsError,
} from "../src/core/capability-settings.ts";
import {
	POLICY_DEFAULT_PROFILE,
	POLICY_RESOURCE_CATEGORIES,
	POLICY_RESOURCES,
	type ExecutionPolicyProfile,
	type PolicyAction,
	resolveExecutionPolicy,
} from "../src/core/execution-policy.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../src/core/source-info.ts";

const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "mcp-content-policy-test-"));
const TEST_IDENTITY = CapabilityPublicIdentity.loadSync(TEST_AGENT_DIR);

afterAll(() => {
	rmSync(TEST_AGENT_DIR, { recursive: true, force: true });
});

function buildCapabilityCatalog(input: CapabilityCatalogInput): CapabilityCatalog {
	return buildCapabilityCatalogWithIdentity(input, TEST_IDENTITY);
}

const TMP_SOURCE: SourceInfo = createSyntheticSourceInfo("/test", {
	source: "test-src",
	scope: "temporary",
	origin: "top-level",
});

const SERVER_SOURCE_IDENTITY = "mcp:global";
const SERVER_ID = "docs";
const RESOURCE_ID = "resource-digest-1";
const TEMPLATE_ID = "template-digest-1";
const PROMPT_ID = "prompt-digest-1";

function serverCandidate(): CapabilityCandidate {
	return {
		kind: "mcp_server",
		name: SERVER_ID,
		localName: SERVER_ID,
		mcpServerId: SERVER_ID,
		sourceIdentity: SERVER_SOURCE_IDENTITY,
		source: TMP_SOURCE,
		trusted: true,
		revisionInput: { transport: "stdio", command: "docs-server" },
	};
}

function contentCandidates(): CapabilityCandidate[] {
	const base = {
		mcpServerId: SERVER_ID,
		parentId: `mcp_server:${SERVER_SOURCE_IDENTITY}:${SERVER_ID}`,
		sourceIdentity: SERVER_SOURCE_IDENTITY,
		source: TMP_SOURCE,
		trusted: true,
	};
	return [
		{
			...base,
			kind: "mcp_resource",
			name: "guide",
			localName: RESOURCE_ID,
			revisionInput: { name: "guide", title: "Guide", mimeType: "text/markdown" },
		},
		{
			...base,
			kind: "mcp_resource_template",
			name: "issue-{id}",
			localName: TEMPLATE_ID,
			revisionInput: { name: "issue-{id}", displayPattern: "issues/" },
		},
		{
			...base,
			kind: "mcp_prompt",
			name: "summarize",
			localName: PROMPT_ID,
			revisionInput: { name: "summarize", description: "Summarize a resource", arguments: [] },
		},
	];
}

function contentCatalog(): CapabilityCatalog {
	return buildCapabilityCatalog({
		candidates: [serverCandidate(), ...contentCandidates()],
	});
}

function rule(selector: CapabilitySelector, action: CapabilityDecision): CapabilityProfileRule {
	return { selector, action };
}

function allowServerAndContentProfile(): { default: { rules: CapabilityProfileRule[] } } {
	return {
		default: {
			rules: [
				rule({ kind: "mcp_server", mcpServerId: SERVER_ID }, "allow"),
				rule({ kind: "mcp_resource", mcpServerId: SERVER_ID }, "allow"),
				rule({ kind: "mcp_resource_template", mcpServerId: SERVER_ID }, "allow"),
				rule({ kind: "mcp_prompt", mcpServerId: SERVER_ID }, "allow"),
			],
		},
	};
}

function bind(catalog: CapabilityCatalog, profiles?: Record<string, { rules: CapabilityProfileRule[] }>) {
	return resolveCapabilityBinding({
		catalog,
		profile: "default",
		profiles: (profiles ?? allowServerAndContentProfile()) as never,
		now: "2026-08-16T00:00:00.000Z",
	});
}

describe("capability registry MCP content kinds", () => {
	it("resolves content descriptors as children of the mcp_server with default deny", () => {
		const catalog = contentCatalog();
		const decisions = resolveCapabilityDecisions(catalog);

		const server = findCapabilityDescriptor(catalog, "mcp_server", SERVER_ID, SERVER_ID);
		const resource = findCapabilityDescriptor(catalog, "mcp_resource", SERVER_ID, RESOURCE_ID);
		const template = findCapabilityDescriptor(catalog, "mcp_resource_template", SERVER_ID, TEMPLATE_ID);
		const prompt = findCapabilityDescriptor(catalog, "mcp_prompt", SERVER_ID, PROMPT_ID);

		expect(server).toBeDefined();
		expect(resource).toBeDefined();
		expect(template).toBeDefined();
		expect(prompt).toBeDefined();
		if (server === undefined || resource === undefined || template === undefined || prompt === undefined) return;

		expect(server.parentId).toBeUndefined();
		expect(server.mcpServerId).toBe(SERVER_ID);
		for (const descriptor of [resource, template, prompt]) {
			// The internal parent id is resolved to the server's public id.
			expect(descriptor.parentId).toBe(server.id);
			expect(descriptor.mcpServerId).toBe(SERVER_ID);
			expect(decisions.get(descriptor.id)).toBe("deny");
		}
		expect(decisions.get(server.id)).toBe("deny");
	});

	it("keeps content capability ids and revisions secret-free and revision-stable", () => {
		const first = contentCatalog();
		const second = contentCatalog();
		const changed = buildCapabilityCatalog({
			candidates: [
				serverCandidate(),
				...contentCandidates().map((candidate) =>
					candidate.kind === "mcp_resource"
						? { ...candidate, revisionInput: { name: "guide", title: "Guide", mimeType: "text/html" } }
						: candidate,
				),
			],
		});

		const resource = findCapabilityDescriptor(first, "mcp_resource", SERVER_ID, RESOURCE_ID);
		expect(resource).toBeDefined();
		if (resource === undefined) return;
		expect(getCapabilityLocalName(resource)).toBe(RESOURCE_ID);
		expect(resource.id).toMatch(/^mcp_resource:source:[A-Za-z0-9_-]{43}:resource-digest-1$/);
		expect(resource.id).not.toContain("mcp:global");
		expect(resource.revision).toMatch(/^rev:/);

		const sameResource = findCapabilityDescriptor(second, "mcp_resource", SERVER_ID, RESOURCE_ID);
		const changedResource = findCapabilityDescriptor(changed, "mcp_resource", SERVER_ID, RESOURCE_ID);
		expect(sameResource?.revision).toBe(resource.revision);
		expect(changedResource?.revision).not.toBe(resource.revision);
		// The public id is stable across metadata changes.
		expect(changedResource?.id).toBe(resource.id);
	});

	it("allows content capabilities only when the server and the item are both allowed", () => {
		const catalog = contentCatalog();
		const binding = bind(catalog);

		expect(binding.decisionSummary).toEqual({ allowed: 4, awaitingApproval: 0, denied: 0 });
		expect(binding.descriptors).toHaveLength(4);
		expect(binding.toolAllowlist).toEqual([]);
		const serverRef = binding.descriptors.find((ref) => ref.id === findCapabilityDescriptor(catalog, "mcp_server", SERVER_ID, SERVER_ID)?.id);
		const resourceRef = binding.descriptors.find(
			(ref) => ref.id === findCapabilityDescriptor(catalog, "mcp_resource", SERVER_ID, RESOURCE_ID)?.id,
		);
		expect(serverRef?.revision).toMatch(/^rev:/);
		expect(resourceRef?.revision).toMatch(/^rev:/);
	});

	it("never lets a content capability be more permissive than its server", () => {
		const catalog = contentCatalog();
		const resourceId = findCapabilityDescriptor(catalog, "mcp_resource", SERVER_ID, RESOURCE_ID)?.id;

		const denyServer = resolveCapabilityBinding({
			catalog,
			profile: "default",
			profiles: {
				default: {
					rules: [
						rule({ kind: "mcp_server", mcpServerId: SERVER_ID }, "deny"),
						rule({ kind: "mcp_resource", mcpServerId: SERVER_ID }, "allow"),
					],
				},
			},
			now: "2026-08-16T00:00:00.000Z",
		});
		expect(denyServer.decisionSummary.denied).toBe(4);
		expect(denyServer.descriptors.some((ref) => ref.id === resourceId)).toBe(false);

		const askServer = resolveCapabilityBinding({
			catalog,
			profile: "default",
			profiles: {
				default: {
					rules: [
						rule({ kind: "mcp_server", mcpServerId: SERVER_ID }, "ask"),
						rule({ kind: "mcp_resource", mcpServerId: SERVER_ID }, "allow"),
						rule({ kind: "mcp_resource_template", mcpServerId: SERVER_ID }, "allow"),
						rule({ kind: "mcp_prompt", mcpServerId: SERVER_ID }, "allow"),
					],
				},
			},
			now: "2026-08-16T00:00:00.000Z",
		});
		// The server cap inherits down: every content item stays ask without an approval.
		expect(askServer.decisionSummary).toEqual({ allowed: 0, awaitingApproval: 4, denied: 0 });

		const approvedServer = resolveCapabilityBinding({
			catalog,
			profile: "default",
			profiles: {
				default: {
					rules: [
						rule({ kind: "mcp_server", mcpServerId: SERVER_ID }, "ask"),
						rule({ kind: "mcp_resource", mcpServerId: SERVER_ID }, "allow"),
						rule({ kind: "mcp_resource_template", mcpServerId: SERVER_ID }, "allow"),
						rule({ kind: "mcp_prompt", mcpServerId: SERVER_ID }, "allow"),
					],
				},
			},
			approvedDescriptorIds: [findCapabilityDescriptor(catalog, "mcp_server", SERVER_ID, SERVER_ID)?.id ?? ""],
			now: "2026-08-16T00:00:00.000Z",
		});
		// Approving only the server selects it; every content item inherits the
		// ask cap and still needs its own approval before it enters the binding.
		expect(approvedServer.decisionSummary).toEqual({ allowed: 1, awaitingApproval: 3, denied: 0 });
	});

	it("force-denies untrusted project content even when the profile allows it", () => {
		const untrustedSource = createSyntheticSourceInfo("/project", {
			source: "mcp:project",
			scope: "project",
			origin: "top-level",
		});
		const catalog = buildCapabilityCatalog({
			candidates: [
				{
					kind: "mcp_server",
					name: SERVER_ID,
					localName: SERVER_ID,
					mcpServerId: SERVER_ID,
					sourceIdentity: "mcp:project",
					source: untrustedSource,
					trusted: false,
					revisionInput: { transport: "stdio", command: "docs-server" },
				},
				{
					kind: "mcp_prompt",
					name: "summarize",
					localName: PROMPT_ID,
					mcpServerId: SERVER_ID,
					parentId: `mcp_server:mcp:project:${SERVER_ID}`,
					sourceIdentity: "mcp:project",
					source: untrustedSource,
					trusted: false,
					revisionInput: { name: "summarize" },
				},
			],
		});
		const binding = resolveCapabilityBinding({
			catalog,
			profile: "default",
			profiles: {
				default: {
					rules: [
						rule({ kind: "mcp_server", mcpServerId: SERVER_ID }, "allow"),
						rule({ kind: "mcp_prompt", mcpServerId: SERVER_ID }, "allow"),
					],
				},
			},
			now: "2026-08-16T00:00:00.000Z",
		});
		expect(binding.descriptors).toHaveLength(0);
		expect(binding.decisionSummary.denied).toBe(2);
	});

	it("exposes content descriptors through the catalog view with parent linkage", () => {
		const registry = new CapabilityRegistry(TEST_IDENTITY);
		registry.buildCatalog({ candidates: [serverCandidate(), ...contentCandidates()] });
		const view = registry.inspectCatalog();
		expect(view).toBeDefined();
		const resourceView = view?.descriptors.find((descriptor) => descriptor.kind === "mcp_resource");
		expect(resourceView).toMatchObject({
			kind: "mcp_resource",
			mcpServerId: SERVER_ID,
			decision: "deny",
			trusted: true,
		});
		expect(resourceView?.parentId).toBeDefined();
		expect(resourceView?.exposedToolName).toBeUndefined();
	});
});

describe("capability settings MCP content kinds", () => {
	it("accepts MCP content kinds in profile selectors", () => {
		const settings = buildCapabilitySettings({
			global: {
				capabilities: {
					defaultProfile: "content",
					profiles: {
						content: {
							rules: [
								{ selector: { kind: "mcp_resource", mcpServerId: "docs" }, action: "allow" },
								{ selector: { kind: "mcp_resource_template" }, action: "ask" },
								{ selector: { kind: "mcp_prompt", mcpServerId: "docs" }, action: "deny" },
							],
						},
					},
				},
			},
			projectTrusted: false,
		});
		expect(settings.profiles.content.rules).toHaveLength(3);
		expect(settings.profiles.content.rules[0].action).toBe("allow");
	});

	it("rejects unknown content kinds in selectors", () => {
		let error: CapabilitySettingsError | undefined;
		try {
			buildCapabilitySettings({
				global: {
					capabilities: {
						defaultProfile: "default",
						profiles: { default: { rules: [{ selector: { kind: "mcp_widget" }, action: "allow" }] } },
					},
				},
				projectTrusted: false,
			});
		} catch (caught) {
			error = caught as CapabilitySettingsError;
		}
		expect(error?.code).toBe("capability_settings_invalid_selector");
	});
});

const legacyProfile: ExecutionPolicyProfile = {
	id: POLICY_DEFAULT_PROFILE,
	enforcement: "legacy",
	defaultAction: "allow",
	workspace: { read: ["workspace", "declared-read-only"], write: ["workspace"], deny: [] },
	process: { action: "allow", inheritEnvironment: true, allowEnvironment: [] },
	network: { action: "allow", allowDestinations: [] },
	credentials: { action: "allow", allowNames: [] },
	approvals: { writeOutsideWorkspace: "allow", network: "allow", process: "allow" },
};

const hostProfile: ExecutionPolicyProfile = {
	...legacyProfile,
	id: "host-safe",
	enforcement: "host",
	defaultAction: "deny",
	approvals: { writeOutsideWorkspace: "deny", network: "ask", process: "ask" },
};

const sandboxProfile: ExecutionPolicyProfile = {
	...hostProfile,
	id: "sandbox-safe",
	enforcement: "sandbox",
	sandboxProvider: "fake-sandbox",
};

const sandboxAllowProfile: ExecutionPolicyProfile = {
	...legacyProfile,
	id: "sandbox-allow",
	enforcement: "sandbox",
	sandboxProvider: "fake-sandbox",
};

function resolvePolicy(
	profile: ExecutionPolicyProfile,
	operation: Record<string, unknown>,
	options: Record<string, unknown> = {},
): ReturnType<typeof resolveExecutionPolicy> {
	return resolveExecutionPolicy({
		profiles: { [profile.id]: profile },
		defaultProfile: profile.id,
		operation,
		createdAt: "2026-08-16T00:00:00.000Z",
		runId: "run-test",
		workspaceIdentity: "workspace-test",
		...options,
	});
}

function contentBindingInput(serverId: string, serverRevision: string, itemId: string, itemRevision: string) {
	return {
		id: "capability-binding-content",
		descriptors: [
			{ id: serverId, revision: serverRevision },
			{ id: itemId, revision: itemRevision },
		],
	};
}

describe("execution policy MCP content operations", () => {
	const serverDescriptorId = `mcp_server:source:server-digest:${SERVER_ID}`;
	const resourceDescriptorId = `mcp_resource:source:resource-digest:${RESOURCE_ID}`;
	const serverRevision = "rev:server-revision-1";
	const resourceRevision = "rev:resource-revision-1";

	it("allows a content read when the item and its parent server are frozen in the binding", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.content.read",
				source: "mcp",
				serverId: SERVER_ID,
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				parentId: serverDescriptorId,
				revision: resourceRevision,
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "allow", action: "allow", hardDeny: false });
		}
	});

	it("denies a content read whose item is not in the frozen binding", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.content.read",
				source: "mcp",
				serverId: SERVER_ID,
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				parentId: serverDescriptorId,
				revision: resourceRevision,
			},
			{
				capabilityBinding: {
					id: "capability-binding-content",
					descriptors: [{ id: serverDescriptorId, revision: serverRevision }],
				},
			},
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
		}
	});

	it("denies a content read whose revision moved past the frozen binding", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.content.read",
				source: "mcp",
				serverId: SERVER_ID,
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				parentId: serverDescriptorId,
				revision: "rev:resource-revision-2",
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
		}
	});

	it("denies a content read when the binding records no revision for the item", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.content.read",
				source: "mcp",
				serverId: SERVER_ID,
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				parentId: serverDescriptorId,
				revision: resourceRevision,
			},
			{
				capabilityBinding: {
					id: "capability-binding-content",
					descriptors: [{ id: serverDescriptorId, revision: serverRevision }, { id: resourceDescriptorId }],
				},
			},
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
		}
	});

	it("denies a content read without its parent mcp_server selected", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.content.read",
				source: "mcp",
				serverId: SERVER_ID,
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				revision: resourceRevision,
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
		}
	});

	it("denies content operations that omit the governing capability id", () => {
		for (const resource of [
			"mcp.auth",
			"mcp.content.list",
			"mcp.content.read",
			"mcp.content.attach",
		] as const) {
			const result = resolvePolicy(
				legacyProfile,
				{ resource, source: "mcp", serverId: SERVER_ID, sourceId: RESOURCE_ID, revision: resourceRevision },
				{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied" });
			}
		}
	});

	it("denies MCP operations that omit the revision of the governing descriptor", () => {
		for (const resource of [
			"mcp.auth",
			"mcp.content.list",
			"mcp.content.read",
			"mcp.content.attach",
		] as const) {
			const result = resolvePolicy(
				legacyProfile,
				{
					resource,
					source: "mcp",
					serverId: SERVER_ID,
					sourceId: RESOURCE_ID,
					capabilityId: resource === "mcp.content.read" || resource === "mcp.content.attach" ? resourceDescriptorId : serverDescriptorId,
					...(resource === "mcp.content.read" || resource === "mcp.content.attach" ? { parentId: serverDescriptorId } : {}),
				},
				{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
			}
		}
	});

	it("allows an auth flow when the mcp_server is selected in the binding", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.auth",
				source: "mcp",
				serverId: SERVER_ID,
				capabilityId: serverDescriptorId,
				revision: serverRevision,
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "allow", action: "allow", hardDeny: false });
		}
	});

	it("denies an auth flow when the server revision moved past the binding", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.auth",
				source: "mcp",
				serverId: SERVER_ID,
				capabilityId: serverDescriptorId,
				revision: "rev:server-revision-2",
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
		}
	});

	it("allows a content attach when the item and its parent server are frozen in the binding", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.content.attach",
				source: "mcp",
				serverId: SERVER_ID,
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				parentId: serverDescriptorId,
				revision: resourceRevision,
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "allow", action: "allow", hardDeny: false });
		}
	});

	it("keeps attach distinct from read: a profile can allow read while asking attach", () => {
		const profile: ExecutionPolicyProfile = {
			...hostProfile,
			id: "content-attach-ask",
			defaultAction: "deny",
			rules: [
				{ resource: "mcp.content.read", action: "allow" },
				{ resource: "mcp.content.attach", action: "ask" },
			],
		};
		const operation = {
			resource: "mcp.content.attach" as const,
			source: "mcp",
			serverId: SERVER_ID,
			sourceId: RESOURCE_ID,
			capabilityId: resourceDescriptorId,
			parentId: serverDescriptorId,
			revision: resourceRevision,
		};
		const attach = resolvePolicy(profile, operation, {
			capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision),
		});
		expect(attach.ok).toBe(true);
		if (attach.ok) {
			expect(attach.decision).toMatchObject({
				action: "ask",
				outcome: "ask",
				reasonCode: "policy_approval_required",
				hardDeny: false,
			});
		}
		const read = resolvePolicy(profile, { ...operation, resource: "mcp.content.read" }, {
			capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision),
		});
		expect(read.ok).toBe(true);
		if (read.ok) {
			expect(read.decision).toMatchObject({ action: "allow", outcome: "allow" });
		}
	});

	it("denies a content attach without its parent mcp_server selected", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.content.attach",
				source: "mcp",
				serverId: SERVER_ID,
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				revision: resourceRevision,
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
		}
	});

	it("denies a content list when the server revision moved past the binding", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.content.list",
				source: "mcp",
				serverId: SERVER_ID,
				capabilityId: serverDescriptorId,
				revision: "rev:server-revision-2",
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
		}
	});

	it("turns a profile ask on content reads into an approval request", () => {
		const profile: ExecutionPolicyProfile = {
			...hostProfile,
			id: "content-ask",
			defaultAction: "deny",
			rules: [{ resource: "mcp.content.read", action: "ask" }],
		};
		const result = resolvePolicy(
			profile,
			{
				resource: "mcp.content.read",
				source: "mcp",
				serverId: SERVER_ID,
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				parentId: serverDescriptorId,
				revision: resourceRevision,
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({
				action: "ask",
				outcome: "ask",
				reasonCode: "policy_approval_required",
				hardDeny: false,
			});
			expect(result.approval).toMatchObject({ resource: "mcp.content.read", reasonCode: "policy_approval_required" });
			expect(JSON.stringify(result.approval)).not.toContain(RESOURCE_ID);
			expect(JSON.stringify(result.approval)).not.toContain(serverDescriptorId);
		}
	});

	it("applies the profile default action to content operations", () => {
		const denied = resolvePolicy(
			hostProfile,
			{
				resource: "mcp.content.read",
				source: "mcp",
				serverId: SERVER_ID,
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				parentId: serverDescriptorId,
				revision: resourceRevision,
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);
		expect(denied.ok).toBe(true);
		if (denied.ok) {
			expect(denied.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
		}
	});

	it("requires the full sandbox isolation report for content operations under sandbox enforcement", () => {
		const operation = {
			resource: "mcp.content.read",
			source: "mcp",
			serverId: SERVER_ID,
			sourceId: RESOURCE_ID,
			capabilityId: resourceDescriptorId,
			parentId: serverDescriptorId,
			revision: resourceRevision,
		};
		const noSandbox = resolvePolicy(
			sandboxProfile,
			operation,
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);
		expect(noSandbox.ok).toBe(true);
		if (noSandbox.ok) {
			expect(noSandbox.decision).toMatchObject({
				outcome: "sandbox_required",
				reasonCode: "sandbox_required",
				hardDeny: true,
			});
		}

		const ready = resolvePolicy(
			sandboxAllowProfile,
			operation,
			{
				capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision),
				sandbox: {
					configured: true,
					providerId: "fake-sandbox",
					status: "ready",
					capabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
				},
			},
		);
		expect(ready.ok).toBe(true);
		if (ready.ok) {
			expect(ready.decision).toMatchObject({ outcome: "allow" });
		}

		const partial = resolvePolicy(
			sandboxAllowProfile,
			operation,
			{
				capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision),
				sandbox: {
					configured: true,
					providerId: "fake-sandbox",
					status: "ready",
					capabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
				},
			},
		);
		expect(partial.ok).toBe(true);
		if (partial.ok) {
			expect(partial.decision).toMatchObject({
				outcome: "deny",
				reasonCode: "sandbox_capability_insufficient",
				hardDeny: true,
			});
		}
	});

	it("rejects content operation fields carrying control characters", () => {
		const result = resolvePolicy(
			legacyProfile,
			{
				resource: "mcp.content.read",
				source: "mcp",
				serverId: "docs\ninjected",
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				parentId: serverDescriptorId,
				revision: resourceRevision,
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "policy_settings_invalid" } });
	});

	it("rejects capability bindings with malformed descriptor revisions", () => {
		const result = resolvePolicy(
			legacyProfile,
			{ resource: "mcp.content.list", source: "mcp", capabilityId: serverDescriptorId, revision: serverRevision },
			{
				capabilityBinding: {
					id: "capability-binding-content",
					descriptors: [{ id: serverDescriptorId, revision: "bad\nrevision" }],
				},
			},
		);
		expect(result).toMatchObject({ ok: false, error: { code: "policy_settings_invalid" } });
	});

	it("keeps content resource names out of the profile-not-found path", () => {
		// A content operation against a missing profile fails with the same
		// fixed code as any other resource; no operation detail leaks.
		const result = resolvePolicy(
			hostProfile,
			{ resource: "mcp.content.read", source: "mcp" },
			{ defaultProfile: "missing-profile" },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "policy_profile_not_found" } });
		expect(JSON.stringify(result)).not.toContain(SERVER_ID);
	});
});

describe("execution policy content resource constants", () => {
	it("exposes MCP operation resources in the public categories", () => {
		expect(POLICY_RESOURCE_CATEGORIES).toContain("mcp.auth");
		expect(POLICY_RESOURCE_CATEGORIES).toContain("mcp.content.list");
		expect(POLICY_RESOURCE_CATEGORIES).toContain("mcp.content.read");
		expect(POLICY_RESOURCE_CATEGORIES).toContain("mcp.content.attach");
		expect(POLICY_RESOURCES).toContain("mcp.content.attach");
	});
});

describe("execution policy ask approval content identity", () => {
	const serverDescriptorId = `mcp_server:source:server-digest:${SERVER_ID}`;
	const resourceDescriptorId = `mcp_resource:source:resource-digest:${RESOURCE_ID}`;
	const serverRevision = "rev:server-revision-1";
	const resourceRevision = "rev:resource-revision-1";
	it("keeps ask decisions requestable and hard-deny flags correct", () => {
		const profile: ExecutionPolicyProfile = {
			...hostProfile,
			id: "content-ask-2",
			defaultAction: "deny",
			rules: [{ resource: "mcp.content.read", action: "ask" as PolicyAction }],
		};
		const result = resolvePolicy(
			profile,
			{
				resource: "mcp.content.read",
				source: "mcp",
				serverId: SERVER_ID,
				sourceId: RESOURCE_ID,
				capabilityId: resourceDescriptorId,
				parentId: serverDescriptorId,
				revision: resourceRevision,
			},
			{ capabilityBinding: contentBindingInput(serverDescriptorId, serverRevision, resourceDescriptorId, resourceRevision) },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision?.action).toBe("ask");
			expect(result.decision?.hardDeny).toBe(false);
			expect(result.decision?.requestId).toBeDefined();
		}
	});
});
