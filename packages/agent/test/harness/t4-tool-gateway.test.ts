import { describe, expect, it } from "vitest";
import {
	createDefaultSandboxOperationTranslator,
	createConsumerToolGatewayFake,
	createFoundationToolGateway,
	createLocalToolGatewayProvider,
	createSandboxOperationToolGatewayProvider,
} from "../../src/harness/tool-gateway.ts";
import type { SandboxOperationProvider } from "../../src/harness/foundation/providers.ts";
import type { ToolGateway } from "../../src/harness/foundation/providers.ts";
import { Result } from "../../src/harness/result.ts";

const request = {
	schemaVersion: 1 as const,
	toolCallId: "call-1",
	toolName: "read",
	namespace: "mcp-server",
	originalArguments: { path: "file.txt" },
	context: { schemaVersion: 1 as const, bindingId: "binding-1", bindingEpochId: "epoch-1", taskId: "task-1" },
};

describe("T4 ToolGateway and SandboxOperationProvider", () => {
	it("routes by namespace and tool name and validates provider results", async () => {
		const gateway = createFoundationToolGateway({
			gatewayId: "gateway-1",
			providers: [createLocalToolGatewayProvider({
				providerId: "local-1",
				routes: [{ kind: "local", namespace: "mcp-server", toolName: "read", providerId: "local-1", revision: 1 }],
				invoke: async (value) => ({ ok: true, value: { schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: true, sideEffectState: "none" } }),
			})],
		});

		expect(await gateway.execute(request)).toMatchObject({ ok: true, value: { toolCallId: "call-1", toolName: "read" } });
		expect((await gateway.execute({ ...request, namespace: "other" })).ok).toBe(false);
		expect((await gateway.execute({ ...request, originalArguments: undefined as never })).ok).toBe(false);
	});

	it("translates sandbox operations without creating a Worker and maps a validated WorkerReceipt", async () => {
		const starts: string[] = [];
		let disposed = false;
		const sandbox: SandboxOperationProvider = {
			schemaVersion: 1,
			providerId: "sandbox-1",
			providerClass: "operation_worker",
			capabilities: async () => [],
			start: async (operation) => {
				starts.push(operation.operationId);
				return Result.ok({
					schemaVersion: 1,
					workerReceiptId: "worker-receipt-1",
					sandboxProviderId: "sandbox-1",
					operationId: operation.operationId,
					status: "succeeded",
					sideEffectState: "none",
					provenance: { producerKind: "operation_worker", providerId: "sandbox-1", producedAt: "now", correlation: { sessionId: "session-t4", laneId: "main", operationId: operation.operationId, revision: 0 } },
					startedAt: "now",
					completedAt: "now",
				});
			},
			cancel: async () => Result.ok(undefined),
			dispose: async () => { disposed = true; },
		};
		const provider = createSandboxOperationToolGatewayProvider({
			providerId: "sandbox-1",
			routes: [{ kind: "sandbox", namespace: "mcp-server", toolName: "read", providerId: "sandbox-1", revision: 1 }],
			sandbox,
			translator: createDefaultSandboxOperationTranslator(() => "operation-1"),
		});
		const gateway = createFoundationToolGateway({ gatewayId: "gateway-2", providers: [provider] });

		expect(await gateway.execute(request)).toMatchObject({
			ok: true,
			value: { ok: true, sideEffectState: "none", toolReceiptRef: "worker-receipt-1" },
		});
		expect(starts).toEqual(["operation-1"]);
		await gateway.dispose();
		expect(disposed).toBe(true);

		const mismatched = await gateway.execute({ ...request, context: { ...request.context, providerId: "other-provider" } });
		expect(mismatched).toMatchObject({ ok: false, error: { code: "invalid_identifier" } });
		const payloadTampered = createSandboxOperationToolGatewayProvider({
			providerId: "sandbox-1",
			routes: [{ kind: "sandbox", namespace: "mcp-server", toolName: "read", providerId: "sandbox-1", revision: 1 }],
			sandbox,
			translator: { translate: () => Result.ok({ schemaVersion: 1, operationId: "tampered", providerId: "sandbox-1", bindingId: "binding-1", bindingEpochId: "epoch-1", toolCallId: "call-1", toolName: "read", namespace: "mcp-server", taskId: "task-1", payload: { path: "other.txt" } }) },
		});
		const payloadGateway = createFoundationToolGateway({ gatewayId: "gateway-payload", providers: [payloadTampered] });
		expect(await payloadGateway.execute(request)).toMatchObject({ ok: false, error: { code: "foundation_schema_invalid_shape" } });
	});

	it("rejects duplicate and missing-provider routes at construction", () => {
		const provider = (providerId: string) => createLocalToolGatewayProvider({
			providerId,
			routes: [{ kind: "local", toolName: "read", providerId, revision: 1 }],
			invoke: async (value) => ({ ok: true, value: { schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: true, sideEffectState: "none" } }),
		});
		expect(() => createFoundationToolGateway({ gatewayId: "gateway-3", providers: [provider("local-1"), provider("local-2")] }))
			.toThrow(expect.objectContaining({ code: "tool_gateway_catalog_invalid" }));
		const missing = createLocalToolGatewayProvider({
			providerId: "local-1",
			routes: [{ kind: "local", toolName: "read", providerId: "missing", revision: 1 }],
			invoke: async (value) => Result.ok({ schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: true, sideEffectState: "none" }),
		});
		expect(() => createFoundationToolGateway({ gatewayId: "gateway-missing", providers: [missing] }))
			.toThrow(expect.objectContaining({ code: "tool_gateway_catalog_invalid" }));
	});

	it("cleans sandbox tracking and always disposes when callbacks throw", async () => {
		let cancelCalls = 0;
		let disposeCalls = 0;
		const sandbox: SandboxOperationProvider = {
			schemaVersion: 1,
			providerId: "sandbox-cleanup",
			providerClass: "operation_worker",
			capabilities: async () => [],
			start: async () => new Promise<never>(() => undefined),
			cancel: async () => {
				cancelCalls += 1;
				throw new Error("cancel failed");
			},
			dispose: async () => {
				disposeCalls += 1;
			},
		};
		const throwingProvider = createSandboxOperationToolGatewayProvider({
			providerId: sandbox.providerId,
			routes: [{ kind: "sandbox", namespace: "mcp-server", toolName: "read", providerId: sandbox.providerId, revision: 1 }],
			sandbox,
			translator: createDefaultSandboxOperationTranslator(() => "callback-operation"),
			onOperationPayload: () => {
				throw new Error("payload callback failed");
			},
		});
		const throwingGateway = createFoundationToolGateway({ gatewayId: "gateway-callback", providers: [throwingProvider] });
		await expect(throwingGateway.execute(request)).rejects.toThrow("payload callback failed");
		await throwingGateway.dispose();
		expect({ cancelCalls, disposeCalls }).toEqual({ cancelCalls: 0, disposeCalls: 1 });

		const hangingProvider = createSandboxOperationToolGatewayProvider({
			providerId: sandbox.providerId,
			routes: [{ kind: "sandbox", namespace: "mcp-server", toolName: "read", providerId: sandbox.providerId, revision: 1 }],
			sandbox,
			translator: createDefaultSandboxOperationTranslator(() => "hanging-operation"),
		});
		const hangingGateway = createFoundationToolGateway({ gatewayId: "gateway-cancel", providers: [hangingProvider] });
		void hangingGateway.execute(request);
		await expect(hangingGateway.dispose()).rejects.toMatchObject({ code: "side_effect_unknown" });
		expect({ cancelCalls, disposeCalls }).toEqual({ cancelCalls: 1, disposeCalls: 2 });
	});

	it("drives the public consumer-shaped fake through success/failure/cancel/deadline/recovery settlements", async () => {
		let invoked = 0;
		const fake = createConsumerToolGatewayFake({
			nowMs: () => 100,
			invoke: async (value, options) => {
				invoked += 1;
				if (value.toolName === "failure") return Result.ok({ schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: false, sideEffectState: "none", error: { code: "provider_failure", message: "expected failure", retryable: false } });
				if (value.toolName === "cancel-inflight") {
					await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
				}
				return Result.ok({ schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: true, sideEffectState: "none" });
			},
		});
		const consumer: ToolGateway = fake;
		expect(await consumer.execute({ ...request, toolCallId: "consumer-success", toolName: "success" })).toMatchObject({ ok: true, value: { ok: true, sideEffectState: "none" } });
		expect(await consumer.execute({ ...request, toolCallId: "consumer-failure", toolName: "failure" })).toMatchObject({ ok: true, value: { ok: false, sideEffectState: "none", error: { code: "provider_failure" } } });
		const cancelled = new AbortController();
		cancelled.abort();
		expect(await consumer.execute({ ...request, toolCallId: "consumer-cancel", toolName: "cancel" }, { signal: cancelled.signal })).toMatchObject({ ok: true, value: { ok: false, sideEffectState: "none", error: { code: "tool_cancelled" } } });
		expect(await consumer.execute({ ...request, toolCallId: "consumer-deadline", toolName: "deadline", deadlineAt: 99 })).toMatchObject({ ok: true, value: { ok: false, sideEffectState: "none", error: { code: "deadline_exceeded" } } });
		const inFlightController = new AbortController();
		const inFlight = consumer.execute({ ...request, toolCallId: "consumer-cancel-inflight", toolName: "cancel-inflight" }, { signal: inFlightController.signal });
		setTimeout(() => inFlightController.abort(), 1);
		expect(await inFlight).toMatchObject({ ok: true, value: { ok: false, sideEffectState: "side_effect_unknown", error: { code: "tool_cancelled" } } });
		expect(invoked).toBe(3);
		expect(fake.recoverSettlements().map((settlement) => settlement.toolCallId)).toEqual([
			"consumer-cancel",
			"consumer-cancel-inflight",
			"consumer-deadline",
			"consumer-failure",
			"consumer-success",
		]);
	});
});
