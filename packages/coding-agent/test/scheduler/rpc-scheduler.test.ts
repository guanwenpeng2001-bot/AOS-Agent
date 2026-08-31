import type { AgentSessionRuntime } from "../../src/core/session/runtime.ts";
import type { SchedulerSafeStatus } from "../../src/core/runtime/foundation-control-plane.ts";
import { RpcHostController } from "../../src/modes/rpc/rpc-host.ts";
import type {
	InitializeData,
	RpcCommand,
	RpcSchedulerCommandType,
	RpcSchedulerResponse,
	SchedulerStatusData,
} from "../../src/modes/index.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestSession, type TestSessionContext } from "../utilities.ts";

const SENSITIVE_MARKERS = [
	"scheduler-private-prompt",
	"scheduler-private-content",
	"scheduler-private-token",
	"C:\\scheduler-private\\workspace",
	"https://scheduler-user:scheduler-secret@host.invalid/raw",
] as const;
const SCHEDULER_STATUS_COMMAND: RpcSchedulerCommandType = "scheduler.status";

const SAFE_STATUS: SchedulerSafeStatus = {
	schemaVersion: 1,
	source: "scheduler",
	sessionId: "scheduler-session",
	enabled: true,
	started: true,
	tickInFlight: false,
	components: ["messages", "handoff", "workflow", "deadlock", "host", "fan_in"],
	ticksCompleted: 3,
	tickFailures: 0,
	lastTick: {
		workflow: { enabled: true, workflows: 1, scheduled: 1, completed: 0, stopped: 0, wakesFired: 0, errorCount: 0 },
		host: { enabled: true, scannedGraphs: 1, scannedNodes: 2, enqueued: 1, claimed: 1, dispatched: 1, settled: 0, rejected: 0, errorCount: 0 },
		deadlock: { enabled: true, scannedGraphs: 1, scannedNodes: 2, scannedEdges: 1, cycles: 0, failed: 0, facts: 0, signals: 0, retained: 0, ready: 1, timedOut: false, errorCount: 0 },
	},
};

interface SchedulerRpcHarness {
	readonly controller: RpcHostController;
	readonly getSchedulerStatus: ReturnType<typeof vi.fn<() => SchedulerSafeStatus | undefined>>;
	readonly context: TestSessionContext;
}

const harnesses: SchedulerRpcHarness[] = [];

async function createHarness(status: SchedulerSafeStatus | undefined): Promise<SchedulerRpcHarness> {
	const context = await createTestSession({ inMemory: true });
	const getSchedulerStatus = vi.fn<() => SchedulerSafeStatus | undefined>(() => status);
	Object.defineProperty(context.session, "getSchedulerStatus", {
		configurable: true,
		value: getSchedulerStatus,
	});
	const runtimeHost = {
		session: context.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setPrepareSessionRebind: vi.fn(),
	} as unknown as AgentSessionRuntime;
	const controller = new RpcHostController(runtimeHost);
	await controller.start();
	const harness = { controller, getSchedulerStatus, context };
	harnesses.push(harness);
	return harness;
}

function initializeData(response: Awaited<ReturnType<RpcHostController["dispatch"]>>): InitializeData {
	if (response === undefined || response.type !== "response" || response.command !== "initialize" || !("success" in response) || !response.success) {
		throw new Error("Expected successful initialize response");
	}
	return response.data;
}

describe("Scheduler RPC surface", () => {
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.controller.shutdown();
			harness.context.cleanup();
		}
	});

	it("advertises and returns only read-only safe status when enabled", async () => {
		const harness = await createHarness(SAFE_STATUS);
		expect(await harness.controller.dispatch({ id: "before-init", type: "scheduler.status" })).toMatchObject({
			success: false,
			error: { code: "host_not_initialized", retryable: false },
		});

		const initialized = await harness.controller.dispatch({ id: "initialize", type: "initialize", protocolVersion: 1 });
		expect(initializeData(initialized).schedulerCommands).toEqual([SCHEDULER_STATUS_COMMAND]);
		const response: RpcSchedulerResponse = await harness.controller.dispatch({
			id: "status",
			type: SCHEDULER_STATUS_COMMAND,
		});
		const data: SchedulerStatusData = { scheduler: SAFE_STATUS };
		expect(response).toEqual({
			id: "status",
			type: "response",
			command: "scheduler.status",
			success: true,
			data,
		});
		const serialized = JSON.stringify(response);
		for (const marker of SENSITIVE_MARKERS) expect(serialized).not.toContain(marker);
		for (const field of ["prompt", "message", "content", "payload", "token", "headers", "environment", "raw", "output", "stack"]) {
			expect(serialized).not.toContain(`"${field}"`);
		}
	});

	it("keeps capability advertisement and status unavailable when disabled", async () => {
		const harness = await createHarness(undefined);
		const initialized = await harness.controller.dispatch({ id: "initialize", type: "initialize", protocolVersion: 1 });
		expect(initializeData(initialized).schedulerCommands).toBeUndefined();
		expect(await harness.controller.dispatch({ id: "status", type: "scheduler.status" })).toMatchObject({
			success: false,
			error: { code: "scheduler_unavailable", retryable: false },
		});
	});

	it("rejects every extra or mutating input field before reading Scheduler state", async () => {
		const harness = await createHarness(SAFE_STATUS);
		await harness.controller.dispatch({ id: "initialize", type: "initialize", protocolVersion: 1 });
		harness.getSchedulerStatus.mockClear();
		const malformed = [
			{ id: "enable", type: "scheduler.status", enabled: true },
			{ id: "tick", type: "scheduler.status", tick: true },
			{ id: "payload", type: "scheduler.status", payload: { prompt: SENSITIVE_MARKERS[0] } },
		] as unknown as RpcCommand[];
		for (const command of malformed) {
			expect(await harness.controller.dispatch(command)).toMatchObject({
				success: false,
				error: { code: "scheduler_unavailable", retryable: false },
			});
		}
		expect(harness.getSchedulerStatus).not.toHaveBeenCalled();
	});
});
