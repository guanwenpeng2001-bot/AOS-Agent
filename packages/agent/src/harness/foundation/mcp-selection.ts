import { Result, type ResultValue } from "../result.ts";
import { Type } from "typebox";
import { FoundationError } from "./errors.ts";
import { canonicalFoundationJson, fingerprintFoundationValue, type Fingerprint } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { ResourceSelectorSchema, type ResourceSelector } from "./reference.ts";
import { FingerprintSchema, validateExactShape } from "./schema.ts";

export interface McpCapabilityBindingDescriptor {
	readonly id: string;
	readonly revision: string;
	readonly kind: string;
	readonly name: string;
	readonly exposedToolName?: string;
	readonly parentId?: string;
	readonly mcpServerId?: string;
}

/** Minimal, public-safe CapabilityBinding facts required to resolve MCP. */
export interface McpCapabilityBinding {
	readonly id: string;
	readonly descriptors: readonly McpCapabilityBindingDescriptor[];
	readonly toolAllowlist: readonly string[];
}

/** Structural subset of one immutable Tool Gateway route. */
export interface McpToolRoute {
	readonly kind: string;
	readonly namespace?: string;
	readonly toolName: string;
	readonly providerId: string;
	readonly revision: number;
}

export interface McpToolSelection {
	readonly toolId: string;
	readonly descriptorId: string;
	readonly descriptorRevision: string;
	readonly providerId: string;
	readonly routeRevision: number;
}

export interface McpServerSelection {
	readonly serverId: string;
	readonly descriptorId: string;
	readonly descriptorRevision: string;
	readonly tools: readonly McpToolSelection[];
}

/** Exact, canonical MCP set frozen into AgentBinding. */
export interface McpSelection {
	readonly schemaVersion: 1;
	readonly capabilityBindingId: string;
	/** Digest of the Role selector that produced this exact set; the expression itself is not forwarded. */
	readonly selectorDigest: Fingerprint;
	readonly servers: readonly McpServerSelection[];
	readonly digest: Fingerprint;
}

export interface ResolveMcpSelectionInput {
	readonly selector: ResourceSelector;
	readonly capabilityBinding: McpCapabilityBinding;
	readonly routeCatalog: readonly McpToolRoute[];
}

export interface ValidateChildMcpSelectionInput {
	readonly parentSelection: McpSelection;
	readonly childSelection: McpSelection;
}

export interface ValidatedChildMcpSelection {
	readonly selection: McpSelection;
}

const McpToolSelectionSchema = Type.Object(
	{
		toolId: Type.String({ minLength: 1 }),
		descriptorId: Type.String({ minLength: 1 }),
		descriptorRevision: Type.String({ minLength: 1 }),
		providerId: Type.String({ minLength: 1 }),
		routeRevision: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const McpServerSelectionSchema = Type.Object(
	{
		serverId: Type.String({ minLength: 1 }),
		descriptorId: Type.String({ minLength: 1 }),
		descriptorRevision: Type.String({ minLength: 1 }),
		tools: Type.Array(McpToolSelectionSchema),
	},
	{ additionalProperties: false },
);

export const McpSelectionSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		capabilityBindingId: Type.String({ minLength: 1 }),
		selectorDigest: FingerprintSchema,
		servers: Type.Array(McpServerSelectionSchema),
		digest: FingerprintSchema,
	},
	{ additionalProperties: false },
);

function selectionError(message: string): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError("binding_required_fact", message));
}

function childSelectionError(message: string): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError("subagent_binding_projection_invalid", message));
}

function selectedBy(selector: ResourceSelector, serverId: string): boolean {
	switch (selector.policy) {
		case "all":
			return true;
		case "none":
			return false;
		case "named":
			return (selector.named ?? []).includes(serverId);
		case "except":
			return !(selector.named ?? []).includes(serverId);
	}
}

function normalizedSelector(selector: ResourceSelector): ResourceSelector {
	if (selector.policy === "all" || selector.policy === "none") return { policy: selector.policy };
	return { policy: selector.policy, named: [...new Set(selector.named ?? [])].sort() };
}

function selectionBase(selection: McpSelection): Omit<McpSelection, "digest"> {
	return {
		schemaVersion: selection.schemaVersion,
		capabilityBindingId: selection.capabilityBindingId,
		selectorDigest: selection.selectorDigest,
		servers: selection.servers,
	};
}

function isCanonicalSelection(selection: McpSelection): boolean {
	const serverIds = selection.servers.map((server) => server.serverId);
	if (new Set(serverIds).size !== serverIds.length) return false;
	if (canonicalFoundationJson(serverIds) !== canonicalFoundationJson([...serverIds].sort())) return false;
	for (const server of selection.servers) {
		const toolIds = server.tools.map((tool) => tool.toolId);
		if (new Set(toolIds).size !== toolIds.length) return false;
		if (canonicalFoundationJson(toolIds) !== canonicalFoundationJson([...toolIds].sort())) return false;
	}
	return true;
}

export function validateMcpSelection(value: unknown): ResultValue<McpSelection, FoundationError> {
	const checked = validateExactShape<McpSelection>(McpSelectionSchema, value, "mcp_selection");
	if (!checked.ok) return checked;
	if (!isCanonicalSelection(checked.value)) return selectionError("MCP selection is not canonical");
	const expected = fingerprintFoundationValue(selectionBase(checked.value));
	if (expected.value !== checked.value.digest.value) return selectionError("MCP selection digest does not match its exact set");
	return Result.ok(cloneDeepFrozen(checked.value));
}

export function validateMcpSelectionForBinding(
	value: unknown,
	selector: ResourceSelector,
	capabilityBindingId: string,
): ResultValue<McpSelection, FoundationError> {
	const checked = validateMcpSelection(value);
	if (!checked.ok) return checked;
	const expectedSelectorDigest = fingerprintFoundationValue(normalizedSelector(selector));
	if (
		checked.value.capabilityBindingId !== capabilityBindingId ||
		checked.value.selectorDigest.value !== expectedSelectorDigest.value
	) {
		return selectionError("MCP selection does not match its Role selector and CapabilityBinding");
	}
	if (selector.policy === "none" && checked.value.servers.length !== 0) {
		return selectionError("MCP none selector resolved to a non-empty exact set");
	}
	if (selector.policy === "named") {
		const expected = [...new Set(selector.named ?? [])].sort();
		const actual = checked.value.servers.map((server) => server.serverId);
		if (canonicalFoundationJson(actual) !== canonicalFoundationJson(expected)) {
			return selectionError("MCP named selector did not resolve every exact server id");
		}
	}
	if (
		selector.policy === "except" &&
		checked.value.servers.some((server) => (selector.named ?? []).includes(server.serverId))
	) {
		return selectionError("MCP except selector resolved an excluded server id");
	}
	return checked;
}

export function createEmptyMcpSelection(capabilityBindingId: string): McpSelection {
	const base = {
		schemaVersion: 1 as const,
		capabilityBindingId,
		selectorDigest: fingerprintFoundationValue({ policy: "none" }),
		servers: [] as const,
	};
	return cloneDeepFrozen({ ...base, digest: fingerprintFoundationValue(base) });
}

/** Tighten an already exact parent set with a child Role selector; never discovers new routes. */
export function projectMcpSelectionToSelector(
	parentValue: unknown,
	selectorValue: ResourceSelector,
	capabilityBindingId: string,
): ResultValue<McpSelection, FoundationError> {
	const parent = validateMcpSelection(parentValue);
	if (!parent.ok) return parent;
	const selector = validateExactShape<ResourceSelector>(ResourceSelectorSchema, selectorValue, "mcp_selector");
	if (!selector.ok) return selectionError("MCP selector is invalid");
	if (selector.value.policy === "named") {
		const available = new Set(parent.value.servers.map((server) => server.serverId));
		if ([...new Set(selector.value.named ?? [])].some((serverId) => !available.has(serverId))) {
			return selectionError("Child MCP selector references a server outside the parent exact set");
		}
	}
	const base = {
		schemaVersion: 1 as const,
		capabilityBindingId,
		selectorDigest: fingerprintFoundationValue(normalizedSelector(selector.value)),
		servers: parent.value.servers.filter((server) => selectedBy(selector.value, server.serverId)),
	};
	return Result.ok(cloneDeepFrozen({ ...base, digest: fingerprintFoundationValue(base) }));
}

/** Resolve a Role expression to one canonical, exact MCP server/tool route set. */
export function resolveMcpSelection(input: ResolveMcpSelectionInput): ResultValue<McpSelection, FoundationError> {
	const selector = validateExactShape<ResourceSelector>(ResourceSelectorSchema, input.selector, "mcp_selector");
	if (!selector.ok) return selectionError("MCP selector is invalid");
	if (input.capabilityBinding.id.length === 0) return selectionError("MCP resolution requires a CapabilityBinding id");

	const routeKeys = new Set<string>();
	for (const route of input.routeCatalog) {
		if (route.kind !== "mcp") continue;
		if (
			route.namespace === undefined ||
			route.namespace.length === 0 ||
			route.toolName.length === 0 ||
			route.providerId.length === 0 ||
			!Number.isSafeInteger(route.revision) ||
			route.revision < 1
		) {
			return selectionError("MCP Tool Gateway route catalog is invalid");
		}
		const key = canonicalFoundationJson([route.namespace, route.toolName]);
		if (routeKeys.has(key)) return selectionError("MCP Tool Gateway route catalog is ambiguous");
		routeKeys.add(key);
	}

	const serverDescriptors = new Map<string, McpCapabilityBindingDescriptor>();
	const toolDescriptors: McpCapabilityBindingDescriptor[] = [];
	const descriptorIds = new Set<string>();
	for (const descriptor of input.capabilityBinding.descriptors) {
		if (
			descriptor.id.length === 0 ||
			descriptor.revision.length === 0 ||
			descriptor.kind.length === 0 ||
			descriptor.name.length === 0 ||
			descriptorIds.has(descriptor.id)
		) {
			return selectionError("MCP resolution received invalid CapabilityBinding descriptors");
		}
		descriptorIds.add(descriptor.id);
		if (descriptor.kind === "mcp_server") {
			if (descriptor.mcpServerId === undefined || descriptor.mcpServerId.length === 0 || serverDescriptors.has(descriptor.mcpServerId)) {
				return selectionError("MCP server descriptors are missing or ambiguous");
			}
			serverDescriptors.set(descriptor.mcpServerId, descriptor);
		} else if (descriptor.kind === "mcp_tool") {
			toolDescriptors.push(descriptor);
		}
	}

	if (selector.value.policy === "named") {
		for (const serverId of new Set(selector.value.named ?? [])) {
			if (!serverDescriptors.has(serverId)) return selectionError("MCP named selector references an unavailable server id");
		}
	}

	const allowedToolNames = new Set(input.capabilityBinding.toolAllowlist);
	const resolvedTools = new Map<string, McpToolSelection[]>();
	const resolvedToolKeys = new Set<string>();
	for (const descriptor of toolDescriptors) {
		const serverId = descriptor.mcpServerId;
		if (
			serverId === undefined ||
			serverId.length === 0 ||
			descriptor.exposedToolName === undefined ||
			descriptor.exposedToolName.length === 0
		) {
			return selectionError("MCP tool descriptor is missing exact route identity");
		}
		const server = serverDescriptors.get(serverId);
		if (server === undefined || descriptor.parentId !== server.id) {
			return selectionError("MCP tool descriptor does not belong to its selected server descriptor");
		}
		if (!allowedToolNames.has(descriptor.exposedToolName)) continue;
		if (!selectedBy(selector.value, serverId)) continue;
		const expectedExposedName = `mcp__${serverId}__${descriptor.name}`;
		if (descriptor.exposedToolName !== expectedExposedName) {
			return selectionError("MCP tool descriptor exposed name does not match its exact server/tool ids");
		}
		const matches = input.routeCatalog.filter(
			(route) => route.kind === "mcp" && route.namespace === serverId && route.toolName === descriptor.name,
		);
		if (matches.length !== 1) return selectionError("MCP selected tool does not have one exact Tool Gateway route");
		const key = canonicalFoundationJson([serverId, descriptor.name]);
		if (resolvedToolKeys.has(key)) return selectionError("MCP selected tool descriptors are ambiguous");
		resolvedToolKeys.add(key);
		const route = matches[0]!;
		const tools = resolvedTools.get(serverId) ?? [];
		tools.push({
			toolId: descriptor.name,
			descriptorId: descriptor.id,
			descriptorRevision: descriptor.revision,
			providerId: route.providerId,
			routeRevision: route.revision,
		});
		resolvedTools.set(serverId, tools);
	}

	for (const exposedToolName of allowedToolNames) {
		if (!exposedToolName.startsWith("mcp__")) continue;
		if (!toolDescriptors.some((descriptor) => descriptor.exposedToolName === exposedToolName)) {
			return selectionError("MCP tool allowlist references a missing CapabilityBinding descriptor");
		}
	}

	const servers = [...serverDescriptors.entries()]
		.filter(([serverId]) => selectedBy(selector.value, serverId))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([serverId, descriptor]): McpServerSelection => ({
			serverId,
			descriptorId: descriptor.id,
			descriptorRevision: descriptor.revision,
			tools: (resolvedTools.get(serverId) ?? []).sort((left, right) => left.toolId.localeCompare(right.toolId)),
		}));
	const base = {
		schemaVersion: 1 as const,
		capabilityBindingId: input.capabilityBinding.id,
		selectorDigest: fingerprintFoundationValue(normalizedSelector(selector.value)),
		servers,
	};
	return Result.ok(cloneDeepFrozen({ ...base, digest: fingerprintFoundationValue(base) }));
}

/** True only when every child server/tool route is byte-for-byte present in the parent exact set. */
export function isMcpSelectionSubset(parent: McpSelection, child: McpSelection): boolean {
	for (const childServer of child.servers) {
		const parentServer = parent.servers.find((server) => server.serverId === childServer.serverId);
		if (
			parentServer === undefined ||
			parentServer.descriptorId !== childServer.descriptorId ||
			parentServer.descriptorRevision !== childServer.descriptorRevision
		) {
			return false;
		}
		for (const childTool of childServer.tools) {
			const parentTool = parentServer.tools.find((tool) => tool.toolId === childTool.toolId);
			if (parentTool === undefined || canonicalFoundationJson(parentTool) !== canonicalFoundationJson(childTool)) return false;
		}
	}
	return true;
}

/** Validate only the exact child subset. Policy approval is a Host authority concern. */
export function validateChildMcpSelection(
	input: ValidateChildMcpSelectionInput,
): ResultValue<ValidatedChildMcpSelection, FoundationError> {
	const parent = validateMcpSelection(input.parentSelection);
	if (!parent.ok) return childSelectionError("Parent MCP selection is invalid");
	const child = validateMcpSelection(input.childSelection);
	if (!child.ok) return childSelectionError("Child MCP selection is invalid");
	if (!isMcpSelectionSubset(parent.value, child.value)) {
		return childSelectionError("Child MCP selection cannot widen or replace the parent exact set");
	}
	return Result.ok(cloneDeepFrozen({ selection: child.value }));
}
