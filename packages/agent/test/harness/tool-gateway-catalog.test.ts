import { describe, expect, it } from "vitest";
import {
	buildToolGatewayCatalog,
	createFoundationToolGateway,
	createLocalToolGatewayProvider,
	createSandboxOperationToolGatewayProvider,
	lookupToolGatewayRoute,
	type LocalToolGatewayProviderOptions,
	type ToolGatewayRoute,
} from "../../src/harness/tool-gateway.ts";
import type { SandboxOperationProvider, ToolGatewayRequest } from "../../src/harness/foundation/providers.ts";
import { Result } from "../../src/harness/result.ts";

const request = {
	schemaVersion: 1 as const,
	toolCallId: "call-1",
	toolName: "read",
	namespace: "mcp-server",
	originalArguments: { path: "file.txt" },
	context: { schemaVersion: 1 as const, bindingId: "binding-1", bindingEpochId: "epoch-1", taskId: "task-1" },
};

function route(providerId: string, toolName = "read", revision = 1): ToolGatewayRoute {
	return {
		kind: "local",
		namespace: "mcp-server",
		toolName,
		providerId,
		revision,
		operation: { resource: "filesystem.read", effects: ["read"] },
	};
}

function success(toolCallId: string, toolName: string) {
	return Result.ok({ schemaVersion: 1 as const, toolCallId, toolName, ok: true, sideEffectState: "none" as const });
}

describe("immutable Tool Gateway catalog", () => {
	it("performs exact route lookup and rejects ambiguity", () => {
		const selected = lookupToolGatewayRoute([route("provider-1")], "read", "mcp-server");
		expect(selected).toMatchObject({ ok: true, value: { providerId: "provider-1", revision: 1 } });
		const ambiguous = lookupToolGatewayRoute([route("provider-1"), route("provider-2")], "read", "mcp-server");
		expect(ambiguous).toMatchObject({ ok: false, error: { code: "invalid_identifier" } });
		const unknownNamespace = lookupToolGatewayRoute([route("provider-1")], "read", "other");
		expect(unknownNamespace).toMatchObject({ ok: false, error: { code: "invalid_identifier" } });
	});

	it("rejects missing providers and route/provider revision mismatches", async () => {
		const missingProvider = createLocalToolGatewayProvider({
			providerId: "provider-1",
			revision: 1,
			routes: [{ ...route("missing-provider") }],
			invoke: async (value: ToolGatewayRequest) => success(value.toolCallId, value.toolName),
		});
		expect(() => createFoundationToolGateway({ gatewayId: "gateway-missing", providers: [missingProvider] })).toThrow(/catalog/i);

		const revisionMismatch = createLocalToolGatewayProvider({
			providerId: "provider-1",
			revision: 2,
			routes: [route("provider-1", "read", 1)],
			invoke: async (value) => success(value.toolCallId, value.toolName),
		});
		expect(() => createFoundationToolGateway({ gatewayId: "gateway-revision", providers: [revisionMismatch] })).toThrow(/catalog/i);

		const omittedRevision = createLocalToolGatewayProvider({
			providerId: "provider-omitted",
			routes: [route("provider-omitted")],
			invoke: async (value: ToolGatewayRequest) => success(value.toolCallId, value.toolName),
		} as unknown as LocalToolGatewayProviderOptions);
		expect(buildToolGatewayCatalog({ gatewayId: "gateway-omitted", providers: [omittedRevision] })).toMatchObject({
			ok: false,
			error: { code: "tool_gateway_catalog_invalid" },
		});

		const runtimeProvider = createLocalToolGatewayProvider({
			providerId: "provider-runtime",
			revision: 1,
			routes: [route("provider-runtime")],
			invoke: async (value) => success(value.toolCallId, value.toolName),
		});
		const runtimeGateway = createFoundationToolGateway({ gatewayId: "gateway-runtime", providers: [runtimeProvider] });
		(runtimeProvider as unknown as { revision: number }).revision = 2;
		expect(await runtimeGateway.execute(request)).toMatchObject({ ok: false, error: { code: "tool_gateway_catalog_invalid" } });
		await runtimeGateway.dispose();
	});

	it("rejects missing, unknown, and underdeclared route operation contracts", () => {
		const invalidRoutes = [
			{ kind: "local", namespace: "mcp-server", toolName: "persist", providerId: "provider-invalid", revision: 1 },
			{ ...route("provider-invalid"), operation: { resource: "capability.invoke", effects: [] } },
			{
				...route("provider-invalid"),
				operation: { resource: "process.spawn", effects: ["command"], requiresSandbox: true },
			},
		] as unknown as ToolGatewayRoute[];
		for (const [index, invalidRoute] of invalidRoutes.entries()) {
			const provider = createLocalToolGatewayProvider({
				providerId: "provider-invalid",
				revision: 1,
				routes: [invalidRoute],
				invoke: async (value) => success(value.toolCallId, value.toolName),
			});
			expect(buildToolGatewayCatalog({ gatewayId: `gateway-invalid-${index}`, providers: [provider] })).toMatchObject({
				ok: false,
				error: { code: "tool_gateway_catalog_invalid" },
			});
		}
	});

	it("does not publish invalid startup or reload candidates", async () => {
		const provider = createLocalToolGatewayProvider({
			providerId: "provider-1",
			revision: 1,
			routes: [route("provider-1")],
			invoke: async (value) => success(value.toolCallId, value.toolName),
		});
		const startupInvalid = buildToolGatewayCatalog({ gatewayId: "gateway-startup", providers: [provider, provider] });
		expect(startupInvalid).toMatchObject({ ok: false, error: { code: "tool_gateway_catalog_invalid" } });

		const gateway = createFoundationToolGateway({ gatewayId: "gateway-reload", providers: [provider] });
		const before = gateway.getCatalogSnapshot();
		const reloadInvalid = gateway.reload({ providers: [provider, provider] });
		expect(reloadInvalid).toMatchObject({ ok: false, error: { code: "tool_gateway_catalog_invalid" } });
		expect(gateway.getCatalogSnapshot()).toBe(before);
		expect(await gateway.execute(request)).toMatchObject({ ok: true, value: { toolName: "read" } });
		await gateway.dispose();
	});

	it("publishes frozen route and provider revision snapshots", () => {
		const sourceRoute = route("provider-1");
		const provider = createLocalToolGatewayProvider({
			providerId: "provider-1",
			revision: 1,
			routes: [sourceRoute],
			invoke: async (value) => success(value.toolCallId, value.toolName),
		});
		const gateway = createFoundationToolGateway({ gatewayId: "gateway-frozen", providers: [provider] });
		const snapshot = gateway.getCatalogSnapshot();
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.providers)).toBe(true);
		expect(Object.isFrozen(snapshot.providers[0])).toBe(true);
		expect(Object.isFrozen(snapshot.routes)).toBe(true);
		expect(Object.isFrozen(snapshot.routes[0])).toBe(true);
		expect(Object.isFrozen(snapshot.routes[0]?.operation)).toBe(true);
		expect(Object.isFrozen(snapshot.routes[0]?.operation.effects)).toBe(true);
		expect(snapshot.providers[0]).toMatchObject({ providerId: "provider-1", kind: "local", revision: 1 });

		const mutableSourceRoute = sourceRoute as unknown as { toolName: string; operation: { effects: string[] } };
		mutableSourceRoute.toolName = "changed";
		mutableSourceRoute.operation.effects[0] = "write";
		expect(snapshot.routes[0]?.toolName).toBe("read");
		expect(snapshot.routes[0]?.operation.effects).toEqual(["read"]);
		const mutableSnapshotRoute = snapshot.routes[0] as unknown as { toolName: string };
		expect(() => {
			mutableSnapshotRoute.toolName = "changed";
		}).toThrow();
	});

	it("cleans gateway and provider tracking after callback and provider throws", async () => {
		const callbackProvider = createLocalToolGatewayProvider({
			providerId: "callback-provider",
			revision: 1,
			routes: [route("callback-provider")],
			invoke: async () => {
				throw new Error("callback failed");
			},
		});
		const callbackGateway = createFoundationToolGateway({ gatewayId: "gateway-callback", providers: [callbackProvider] });
		await expect(callbackGateway.execute(request)).rejects.toThrow("callback failed");
		expect(callbackGateway.getInFlightCount()).toBe(0);
		expect(callbackProvider.getInFlightCount?.()).toBe(0);
		await callbackGateway.dispose();

		let providerCancelCalls = 0;
		const sandbox: SandboxOperationProvider = {
			// A thrown start may have reserved worker state before it rejects.
			// The gateway must issue the matching cancellation before rethrowing.
			schemaVersion: 1,
			providerId: "provider-throw",
			providerClass: "operation_worker",
			cancel: async () => {
				providerCancelCalls += 1;
				return Result.ok(undefined);
			},
			capabilities: async () => [],
			start: async () => {
				throw new Error("provider failed");
			},
			dispose: async () => {},
		};
		const providerThrow = createSandboxOperationToolGatewayProvider({
			providerId: sandbox.providerId,
			revision: 1,
			routes: [{
				kind: "sandbox",
				namespace: "mcp-server",
				toolName: "read",
				providerId: sandbox.providerId,
				revision: 1,
				operation: { resource: "filesystem.read", effects: ["read"] },
			}],
			sandbox,
		});
		const providerGateway = createFoundationToolGateway({ gatewayId: "gateway-provider", providers: [providerThrow] });
		await expect(providerGateway.execute(request)).rejects.toThrow("provider failed");
		expect(providerGateway.getInFlightCount()).toBe(0);
		expect(providerThrow.getInFlightCount?.()).toBe(0);
		expect(providerCancelCalls).toBe(1);
		await providerGateway.dispose();
	});

	it("cancels and disposes with no tracked executions left", async () => {
		let resolveInvocation: ((value: ReturnType<typeof success>) => void) | undefined;
		const provider = createLocalToolGatewayProvider({
			providerId: "provider-cancel",
			revision: 1,
			routes: [route("provider-cancel")],
			invoke: async (value, options) => new Promise((resolve) => {
				resolveInvocation = resolve as (value: ReturnType<typeof success>) => void;
				options?.signal?.addEventListener("abort", () => resolve(success(value.toolCallId, value.toolName)), { once: true });
			}),
		});
		const gateway = createFoundationToolGateway({ gatewayId: "gateway-cancel", providers: [provider] });
		const pending = gateway.execute({ ...request, toolCallId: "cancel-me" });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(gateway.getInFlightCount()).toBe(1);
		expect(provider.getInFlightCount?.()).toBe(1);
		expect((await gateway.cancel("cancel-me")).ok).toBe(true);
		expect(gateway.getInFlightCount()).toBe(0);
		expect(provider.getInFlightCount?.()).toBe(0);
		resolveInvocation?.(success("cancel-me", "read"));
		await pending;
		await gateway.dispose();
		expect(gateway.getInFlightCount()).toBe(0);
		expect(provider.getInFlightCount?.()).toBe(0);
	});
});
