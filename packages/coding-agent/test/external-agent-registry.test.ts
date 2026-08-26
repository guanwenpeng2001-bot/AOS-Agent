import { describe, expect, it } from "vitest";
import {
	type ExternalAgentAdapter,
	ExternalAgentError,
	type ExternalAgentSelection,
	type ExternalAgentTarget,
	isExternalAgentIdentifier,
} from "../src/core/external-agent-adapter.ts";
import {
	createExternalAgentAdapterRegistry,
	type ExternalAgentAdapterDescriptor,
	type ExternalAgentAdapterRegistry,
	isExternalAgentAdapterRegistry,
} from "../src/core/external-agent-registry.ts";

/** Minimal trusted adapter instance; none of its methods run in registry tests. */
function fakeAdapter(adapterId: string = "fake-adapter"): ExternalAgentAdapter {
	return {
		id: adapterId,
		async probe() {
			throw new Error("probe must not run in registry tests");
		},
		async prepare() {
			throw new Error("prepare must not run in registry tests");
		},
		async start() {
			throw new Error("start must not run in registry tests");
		},
	};
}

function registryWith(
	options: { readonly displayName?: string; readonly version?: string; readonly targets?: ReadonlyArray<string> } = {},
): { readonly registry: ExternalAgentAdapterRegistry; readonly adapter: ExternalAgentAdapter } {
	const registry = createExternalAgentAdapterRegistry();
	const adapter = fakeAdapter();
	registry.register(adapter, {
		displayName: "Fake Adapter",
		version: "1",
		targets: ["target-a", "target-b"],
		...options,
	});
	return { registry, adapter };
}

function expectAdapterInvalid(fn: () => unknown): void {
	expect(fn).toThrowError(expect.objectContaining({ code: "external_agent_adapter_invalid" }));
}

function expectTargetNotFound(fn: () => unknown): void {
	expect(fn).toThrowError(expect.objectContaining({ code: "external_agent_target_not_found" }));
}

describe("trusted external agent adapter registry", () => {
	it("accepts constructed adapter instances and resolves them by id", () => {
		const { registry, adapter } = registryWith();
		expect(registry.get("fake-adapter")).toBe(adapter);
		expect(registry.has("fake-adapter")).toBe(true);
		expect(registry.get("unknown-adapter")).toBeUndefined();
		expect(registry.has("unknown-adapter")).toBe(false);
		expect(isExternalAgentAdapterRegistry(registry)).toBe(true);
	});

	it("starts empty and never resolves before registration", () => {
		const registry = createExternalAgentAdapterRegistry();
		expect(registry.list()).toEqual([]);
		expect(registry.has("fake-adapter")).toBe(false);
		expectTargetNotFound(() => registry.resolve({ adapterId: "fake-adapter", targetId: "target-a" }));
	});

	it("lists only safe descriptors without connection data", () => {
		const { registry } = registryWith();
		const descriptors = registry.list();
		expect(descriptors).toEqual([{ adapterId: "fake-adapter", displayName: "Fake Adapter", version: "1" }]);
		for (const descriptor of descriptors) {
			expect(Object.keys(descriptor)).toEqual(["adapterId", "displayName", "version"]);
			expect(Object.isFrozen(descriptor)).toBe(true);
		}
	});

	it("preserves registration order in the read-only list", () => {
		const registry = createExternalAgentAdapterRegistry();
		registry.register(fakeAdapter("adapter-a"), { targets: ["t1"] });
		registry.register(fakeAdapter("adapter-b"), { targets: ["t1"] });
		registry.register(fakeAdapter("adapter-c"), { targets: ["t1"] });
		expect(registry.list().map(({ adapterId }) => adapterId)).toEqual(["adapter-a", "adapter-b", "adapter-c"]);
	});

	it("seals Host registration before publishing the read-only view", () => {
		const { registry, adapter } = registryWith();
		const published = registry.seal();
		expect(Object.isFrozen(published)).toBe(true);
		expect(published.get(adapter.id)).toBe(adapter);
		expect(published.list()).toEqual([{ adapterId: "fake-adapter", displayName: "Fake Adapter", version: "1" }]);
		expectAdapterInvalid(() => registry.register(fakeAdapter("late-adapter")));
	});

	it("defaults descriptor displayName and version to safe values", () => {
		const registry = createExternalAgentAdapterRegistry();
		registry.register(fakeAdapter("minimal-adapter"));
		expect(registry.list()).toEqual([{ adapterId: "minimal-adapter", displayName: "minimal-adapter", version: "1" }]);
	});

	it("rejects duplicate adapter ids", () => {
		const registry = createExternalAgentAdapterRegistry();
		registry.register(fakeAdapter());
		expectAdapterInvalid(() => registry.register(fakeAdapter()));
	});

	it("rejects non-instance registrations including config, URL, command, and provider names", () => {
		const registry = createExternalAgentAdapterRegistry();
		// A bare string (provider/model name, module path, or command) is never a registration source.
		expectAdapterInvalid(() => registry.register("claude-sonnet-4" as unknown as ExternalAgentAdapter));
		expectAdapterInvalid(() => registry.register("npx vendor-agent" as unknown as ExternalAgentAdapter));
		expectAdapterInvalid(() => registry.register("https://example.com/agent" as unknown as ExternalAgentAdapter));
		// A config-shaped object is not a constructed adapter instance.
		expectAdapterInvalid(() =>
			registry.register({
				type: "external-agent",
				command: "vendor-agent",
				endpoint: "https://example.com",
			} as unknown as ExternalAgentAdapter),
		);
		// An object missing any of the three contract methods is not an instance.
		expectAdapterInvalid(() =>
			registry.register({ id: "adapter", probe: 1, prepare: 2, start: 3 } as unknown as ExternalAgentAdapter),
		);
		expectAdapterInvalid(() => registry.register({ id: "adapter" } as unknown as ExternalAgentAdapter));
	});

	it("rejects adapters whose id is unsafe", () => {
		const registry = createExternalAgentAdapterRegistry();
		for (const adapterId of [
			"https://example.com/agent",
			"/usr/bin/vendor-agent",
			"npx vendor-agent",
			"anthropic/claude",
			"target@host:path",
			"sk-secret-token",
			"",
		]) {
			expectAdapterInvalid(() => registry.register(fakeAdapter(adapterId)));
		}
		expect(registry.list()).toEqual([]);
	});

	it("rejects unsafe descriptor fields", () => {
		const registry = createExternalAgentAdapterRegistry();
		expectAdapterInvalid(() => registry.register(fakeAdapter(), { displayName: "sk-secret-token" }));
		expectAdapterInvalid(() => registry.register(fakeAdapter(), { displayName: "" }));
		expectAdapterInvalid(() => registry.register(fakeAdapter(), { displayName: "bad\nname" }));
		expectAdapterInvalid(() => registry.register(fakeAdapter(), { version: "1.0\n0" }));
		expectAdapterInvalid(() => registry.register(fakeAdapter(), { version: "https://example.com/v1" }));
		expectAdapterInvalid(() => registry.register(fakeAdapter(), { version: "" }));
		expect(registry.list()).toEqual([]);
	});

	it("rejects unsafe target ids at registration", () => {
		const registry = createExternalAgentAdapterRegistry();
		expectAdapterInvalid(() =>
			registry.register(fakeAdapter("with-bad-target"), {
				targets: ["target-a", "https://example.com/target"],
			}),
		);
		expectAdapterInvalid(() => registry.register(fakeAdapter("with-bad-target"), { targets: ["/usr/bin/target"] }));
		expectAdapterInvalid(() => registry.register(fakeAdapter("with-bad-target"), { targets: ["ghp_secret-token"] }));
		expect(registry.has("with-bad-target")).toBe(false);
	});

	it("rejects malformed registration option shapes instead of coercing them", () => {
		const registry = createExternalAgentAdapterRegistry();
		// Non-object options values fail closed with the stable code; a raw
		// TypeError or a silently ignored shape must never reach callers.
		expectAdapterInvalid(() => registry.register(fakeAdapter("null-options"), null as unknown as object));
		expectAdapterInvalid(() => registry.register(fakeAdapter("string-options"), "target-a" as unknown as object));
		// A string targets value must not be iterated into character targets.
		expectAdapterInvalid(() =>
			registry.register(fakeAdapter("string-targets"), { targets: "target-a" as unknown as ReadonlyArray<string> }),
		);
		// Unknown keys are rejected, not silently ignored.
		expectAdapterInvalid(() =>
			registry.register(fakeAdapter("unknown-key"), {
				targets: ["target-a"],
				endpoint: "https://example.com/adapter",
			} as unknown as object),
		);
		expect(registry.has("null-options")).toBe(false);
		expect(registry.has("string-options")).toBe(false);
		expect(registry.has("string-targets")).toBe(false);
		expect(registry.has("unknown-key")).toBe(false);
	});

	it("deduplicates repeated target ids within one registration", () => {
		const registry = createExternalAgentAdapterRegistry();
		registry.register(fakeAdapter(), { targets: ["target-a", "target-a", "target-b"] });
		expect(registry.lookupTarget("fake-adapter", "target-a")).toEqual({ targetId: "target-a" });
	});

	it("looks up targets only inside the owning adapter", () => {
		const { registry } = registryWith();
		expect(registry.lookupTarget("fake-adapter", "target-a")).toEqual({ targetId: "target-a" });
		expect(registry.lookupTarget("fake-adapter", "target-b")).toEqual({ targetId: "target-b" });
		expect(registry.lookupTarget("fake-adapter", "unknown-target")).toBeUndefined();
		expect(registry.lookupTarget("unknown-adapter", "target-a")).toBeUndefined();
		expect(registry.lookupTarget("fake-adapter", "https://example.com")).toBeUndefined();
		expect(registry.lookupTarget("https://example.com", "target-a")).toBeUndefined();
	});

	it("resolves an explicit selection to the adapter and its owned target", () => {
		const { registry, adapter } = registryWith();
		const resolved = registry.resolve({ adapterId: "fake-adapter", targetId: "target-a" });
		expect(resolved.adapter).toBe(adapter);
		expect(resolved.target).toEqual({ targetId: "target-a" });
		expect(resolved.selection).toEqual({ adapterId: "fake-adapter", targetId: "target-a" });
		expect(Object.keys(resolved.target)).toEqual(["targetId"]);
		expect(Object.keys(resolved.selection)).toEqual(["adapterId", "targetId"]);
		expect(Object.isFrozen(resolved)).toBe(true);
		expect(Object.isFrozen(resolved.target)).toBe(true);
		expect(Object.isFrozen(resolved.selection)).toBe(true);
	});

	it("rejects selections with unknown adapters or unknown targets", () => {
		const { registry } = registryWith();
		expectTargetNotFound(() => registry.resolve({ adapterId: "unknown-adapter", targetId: "target-a" }));
		expectTargetNotFound(() => registry.resolve({ adapterId: "fake-adapter", targetId: "unknown-target" }));
		expectTargetNotFound(() => registry.resolve({ adapterId: "claude-sonnet-4", targetId: "target-a" }));
	});

	it("rejects unsafe selections with the adapter-invalid code", () => {
		const { registry } = registryWith();
		expectAdapterInvalid(() => registry.resolve({ adapterId: "https://example.com/agent", targetId: "target-a" }));
		expectAdapterInvalid(() => registry.resolve({ adapterId: "fake-adapter", targetId: "/usr/bin/target" }));
		expectAdapterInvalid(() => registry.resolve({ adapterId: "fake-adapter", targetId: "sk-secret" }));
		expectAdapterInvalid(() =>
			registry.resolve({
				adapterId: "fake-adapter",
				targetId: "target-a",
				extra: "field",
			} as unknown as ExternalAgentSelection),
		);
		expectAdapterInvalid(() => registry.resolve({ adapterId: "fake-adapter" } as unknown as ExternalAgentSelection));
		expectAdapterInvalid(() => registry.resolve(null as unknown as ExternalAgentSelection));
	});

	it("throws stable ExternalAgentError instances with code-derived messages", () => {
		const { registry } = registryWith();
		let caught: unknown;
		try {
			registry.register(fakeAdapter());
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ExternalAgentError);
		expect(caught).toMatchObject({ code: "external_agent_adapter_invalid", retryable: false });
		if (caught instanceof Error) {
			expect(caught.message).toMatch(/invalid/i);
		}
		let targetCaught: unknown;
		try {
			registry.resolve({ adapterId: "fake-adapter", targetId: "unknown-target" });
		} catch (error) {
			targetCaught = error;
		}
		expect(targetCaught).toBeInstanceOf(ExternalAgentError);
		expect(targetCaught).toMatchObject({ code: "external_agent_target_not_found", retryable: false });
	});

	it("keeps list results detached from later registrations", () => {
		const registry = createExternalAgentAdapterRegistry();
		registry.register(fakeAdapter("adapter-a"), { targets: ["t1"] });
		const first = registry.list();
		registry.register(fakeAdapter("adapter-b"), { targets: ["t1"] });
		expect(first.map(({ adapterId }) => adapterId)).toEqual(["adapter-a"]);
		expect(registry.list().map(({ adapterId }) => adapterId)).toEqual(["adapter-a", "adapter-b"]);
	});

	it("never exposes mutable registry state through list or lookups", () => {
		const registry = createExternalAgentAdapterRegistry();
		registry.register(fakeAdapter(), { targets: ["target-a"] });
		const descriptors = registry.list() as ExternalAgentAdapterDescriptor[];
		expect(() => {
			(descriptors[0] as { displayName: string }).displayName = "mutated";
		}).toThrowError(TypeError);
		expect(registry.list()[0]).toEqual({ adapterId: "fake-adapter", displayName: "fake-adapter", version: "1" });
		const resolved = registry.resolve({ adapterId: "fake-adapter", targetId: "target-a" });
		expect(Object.isFrozen(resolved.target)).toBe(true);
		expect(Object.isFrozen(resolved.selection)).toBe(true);
	});

	it("exposes no registration source beyond constructed instances", () => {
		const registry = createExternalAgentAdapterRegistry();
		expect(typeof registry.register).toBe("function");
		// The registry surface has no config/URL/command/module-path/provider inputs.
		expect(Object.keys(registry).sort()).toEqual([]);
		expect((registry as unknown as Record<string, unknown>).configure).toBeUndefined();
		expect((registry as unknown as Record<string, unknown>).load).toBeUndefined();
		expect((registry as unknown as Record<string, unknown>).unregister).toBeUndefined();
		expect((registry as unknown as Record<string, unknown>).clear).toBeUndefined();
	});

	it("keeps returned target ids bounded and free of endpoint data", () => {
		const { registry } = registryWith({ targets: ["target-a"] });
		const target = registry.lookupTarget("fake-adapter", "target-a") as ExternalAgentTarget;
		expect(Object.keys(target)).toEqual(["targetId"]);
		expect(target.targetId.length).toBeGreaterThan(0);
		expect(target.targetId.length).toBeLessThanOrEqual(256);
		expect(isExternalAgentIdentifier(target.targetId)).toBe(true);
	});

	it("recognizes only registry-shaped objects", () => {
		expect(isExternalAgentAdapterRegistry(createExternalAgentAdapterRegistry())).toBe(true);
		expect(isExternalAgentAdapterRegistry(fakeAdapter())).toBe(false);
		expect(isExternalAgentAdapterRegistry({})).toBe(false);
		expect(isExternalAgentAdapterRegistry(null)).toBe(false);
		expect(isExternalAgentAdapterRegistry("registry")).toBe(false);
	});

	it("accepts an adapter with no declared targets", () => {
		const registry = createExternalAgentAdapterRegistry();
		registry.register(fakeAdapter("targetless"));
		expect(registry.has("targetless")).toBe(true);
		expect(registry.list()).toEqual([{ adapterId: "targetless", displayName: "targetless", version: "1" }]);
		expectTargetNotFound(() => registry.resolve({ adapterId: "targetless", targetId: "any-target" }));
	});
});
