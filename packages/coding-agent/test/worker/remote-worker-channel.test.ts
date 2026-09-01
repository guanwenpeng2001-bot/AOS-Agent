import {
	type ChildProcessWithoutNullStreams,
	spawn,
} from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxOperationRequest } from "../../../agent/src/internal.ts";
import {
	executeRemoteOperation,
	startRemoteOperation,
} from "../../src/core/runtime/remote-operation.ts";
import {
	parseOperationWorkerFrame,
	serializeWorkerFrameLine,
	type OperationWorkerEventFrame,
	type OperationWorkerRequestFrame,
	validateOperationWorkerEventFrame,
	validateOperationWorkerRequestFrame,
} from "../../src/core/worker/protocol.ts";
import {
	OperationWorkerSupervisor,
	type WorkerSupervisorConfig,
} from "../../src/core/worker/supervisor.ts";
import type { WorkerBinding } from "../../src/core/worker/lifecycle.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import {
	createRpcTransport,
	type RpcTransport,
	type RpcTransportConnection,
} from "../../src/modes/rpc/rpc-transport.ts";
import type { WebsocketRpcAddress } from "../../src/modes/rpc/rpc-transport-address.ts";

const LOOPBACK_HOST = "localhost";
const CHILD_ENTRY = fileURLToPath(new URL("../fixtures/fake-worker-child.ts", import.meta.url));
const TLS_FIXTURE_CERT = join(import.meta.dirname, "../../../../node_modules/ssh2/test/fixtures/https_cert.pem");
const TLS_FIXTURE_KEY = join(import.meta.dirname, "../../../../node_modules/ssh2/test/fixtures/https_key.pem");
const supervisors: OperationWorkerSupervisor[] = [];
const transports: Array<RpcTransport<OperationWorkerRequestFrame, OperationWorkerEventFrame, WebsocketRpcAddress>> = [];
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
	for (const supervisor of supervisors.splice(0)) await supervisor.dispose();
	for (const transport of transports.splice(0)) await transport.close();
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
	children.clear();
});

describe("remote Operation Worker channel", () => {
	it("runs the unchanged stdio frame contract through a bearer-authenticated WSS endpoint", async () => {
		const port = await getAvailablePort();
		const address: WebsocketRpcAddress = {
			transport: "websocket",
			host: LOOPBACK_HOST,
			port,
			path: "/rpc",
			auth: { scheme: "bearer", bearerToken: "remote-worker-test-token" },
			tls: {
				enabled: true,
				minVersion: "1.2",
				certRef: TLS_FIXTURE_CERT,
				keyRef: TLS_FIXTURE_KEY,
			},
		};
		const remote = await startRemoteEndpoint(address);

		const supervisorConfig: WorkerSupervisorConfig = {
			remoteEndpoint: {
				address,
				connectTimeoutMs: 2_000,
				tls: { caPath: TLS_FIXTURE_CERT },
			},
			profileId: "remote-success",
			profileRevision: 1,
			capabilities: ["filesystem.read", "process.spawn"],
			readyTimeoutMs: 5_000,
			heartbeatTimeoutMs: 2_000,
			cancelTimeoutMs: 200,
			terminateTimeoutMs: 1_000,
		};
		const supervisor = new OperationWorkerSupervisor(supervisorConfig);
		supervisors.push(supervisor);
		const workerBinding = binding();
		const plan = supervisor.preflight({ binding: workerBinding, runAccepted: true });
		expect(plan.ok).toBe(true);
		expect(remote.spawnCount()).toBe(0);
		if (!plan.ok) throw plan.error;

		await expect(supervisor.activate(plan.value)).resolves.toMatchObject({
			ok: true,
			value: { status: "ready" },
		});
		expect(remote.spawnCount()).toBe(1);
		expect(supervisor.snapshot.hasLiveProcess).toBe(true);
		await expect(supervisor.probeLiveness()).resolves.toEqual({ ok: true, value: undefined });
		const receipt = await executeRemoteOperation(
			supervisor.bindRemoteOperation(request(workerBinding)),
			{
				operationId: "operation-remote-1",
				runId: workerBinding.runId,
				sessionId: workerBinding.sessionId,
				deadlineAt: new Date(workerBinding.deadlineAt!).toISOString(),
			},
		);
		expect(receipt).toMatchObject({
			operationId: "operation-remote-1",
			status: "completed",
			runId: "run-1",
			sessionId: "session-1",
			sideEffects: "associated",
		});
		await remote.closeConnection();
		await expect(supervisor.reclaim()).resolves.toMatchObject({
			ok: true,
			value: { status: "reclaim_unknown" },
		});
		expect(supervisor.snapshot).toMatchObject({ hasLiveProcess: false, quarantined: true });
	});

	it("renews a remote-neutral lease only after a cross-host ping/pong and cancels the same wire operation", async () => {
		const port = await getAvailablePort();
		const address: WebsocketRpcAddress = {
			transport: "websocket",
			host: LOOPBACK_HOST,
			port,
			path: "/rpc",
			auth: { scheme: "bearer", bearerToken: "remote-worker-lease-token" },
			tls: {
				enabled: true,
				minVersion: "1.2",
				certRef: TLS_FIXTURE_CERT,
				keyRef: TLS_FIXTURE_KEY,
			},
		};
		await startRemoteEndpoint(address);

		const supervisor = new OperationWorkerSupervisor({
			remoteEndpoint: {
				address,
				connectTimeoutMs: 2_000,
				tls: { caPath: TLS_FIXTURE_CERT },
			},
			profileId: "cancel_success",
			profileRevision: 1,
			capabilities: ["filesystem.read", "process.spawn"],
			readyTimeoutMs: 5_000,
			heartbeatTimeoutMs: 2_000,
			cancelTimeoutMs: 500,
			terminateTimeoutMs: 1_000,
		});
		supervisors.push(supervisor);
		const workerBinding = { ...binding(), workerId: "worker-remote-lease", profileId: "cancel_success" };
		const plan = supervisor.preflight({ binding: workerBinding, runAccepted: true });
		if (!plan.ok) throw plan.error;
		const activated = await supervisor.activate(plan.value);
		if (!activated.ok) throw activated.error;
		const operationId = "operation-remote-lease";
		const initialExpiry = new Date(Date.now() + 5_000).toISOString();
		const handle = startRemoteOperation(
			supervisor.bindRemoteOperation({ ...request(workerBinding), operationId, sideEffect: "none" }),
			{
				operationId,
				runId: workerBinding.runId,
				sessionId: workerBinding.sessionId,
				lease: { leaseId: "remote-lease-1", expiresAt: initialExpiry },
			},
		);
		await waitForStatus(supervisor, "running");
		const renewed = await handle.heartbeat();
		expect(renewed.leaseId).toBe("remote-lease-1");
		expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(initialExpiry));
		await handle.cancel();
		await expect(handle.receipt).resolves.toMatchObject({
			operationId,
			status: "cancelled",
			heartbeatSequence: 1,
			lease: renewed,
		});
		await expect(supervisor.reclaim()).resolves.toMatchObject({
			ok: true,
			value: { status: "reclaimed" },
		});
	});
});

function binding(): WorkerBinding {
	return {
		schemaVersion: 1,
		workerId: "worker-remote-success",
		providerId: "sandbox-worker",
		sessionId: "session-1",
		laneId: "main",
		runId: "run-1",
		bindingId: "binding-1",
		bindingEpochId: "epoch-1",
		attemptId: "attempt-1",
		profileId: "remote-success",
		profileRevision: 1,
		capabilitySummary: ["filesystem.read", "process.spawn"],
		deadlineAt: Date.now() + 10_000,
		credentialTargetRefs: [],
		requestFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	};
}

function request(workerBinding: WorkerBinding): SandboxOperationRequest {
	return {
		schemaVersion: 1,
		operationId: "operation-remote-1",
		providerId: workerBinding.providerId,
		bindingId: workerBinding.bindingId,
		bindingEpochId: workerBinding.bindingEpochId,
		attemptId: workerBinding.attemptId,
		taskId: "task-1",
		dispatchId: "dispatch-1",
		payload: { action: "read" },
	};
}

async function waitForStatus(
	supervisor: OperationWorkerSupervisor,
	status: "running",
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (supervisor.snapshot.record?.status === status) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${status}`);
}

async function startRemoteEndpoint(address: WebsocketRpcAddress): Promise<{
	readonly spawnCount: () => number;
	readonly closeConnection: () => Promise<void>;
}> {
	let spawnCount = 0;
	let remoteChild: ChildProcessWithoutNullStreams | undefined;
	let remoteConnection: RpcTransportConnection<OperationWorkerRequestFrame, OperationWorkerEventFrame> | undefined;
	let detachChildOutput = (): void => undefined;
	let relayTail = Promise.resolve();
	const endpoint = createRpcTransport<OperationWorkerRequestFrame, OperationWorkerEventFrame>({
		address,
		parseCommand: (value) => {
			if (!validateOperationWorkerRequestFrame(value)) throw new Error("invalid remote Worker request");
			return value;
		},
		dispatch: (frame) => writeChildFrame(remoteChild, frame),
		onConnection: (connection) => {
			spawnCount += 1;
			remoteConnection = connection;
			const child = spawn(process.execPath, [CHILD_ENTRY], {
				env: { AOS_SAFE_TEST_MARKER: "1" },
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
			});
			remoteChild = child;
			children.add(child);
			child.stdout.setEncoding("utf8");
			detachChildOutput = attachJsonlLineReader(child.stdout, (line) => {
				relayTail = relayTail.then(() => relayWorkerEvent(connection, line));
				void relayTail.catch(() => {
					if (child.exitCode === null && child.signalCode === null) child.kill();
					void connection.close();
				});
			});
			child.stderr.resume();
			child.once("error", () => void connection.close());
			child.once("exit", () => {
				children.delete(child);
				detachChildOutput();
				void relayTail.finally(() => connection.close());
			});
		},
		onConnectionClose: () => {
			detachChildOutput();
			if (remoteChild !== undefined && remoteChild.exitCode === null && remoteChild.signalCode === null) {
				remoteChild.stdin.end();
			}
		},
	});
	transports.push(endpoint);
	await endpoint.start();
	return {
		spawnCount: () => spawnCount,
		closeConnection: () => remoteConnection?.close() ?? Promise.resolve(),
	};
}

function writeChildFrame(
	child: ChildProcessWithoutNullStreams | undefined,
	frame: OperationWorkerRequestFrame,
): Promise<void> {
	if (child === undefined || child.stdin.destroyed || !child.stdin.writable) {
		return Promise.reject(new Error("remote Worker process is unavailable"));
	}
	const line = serializeWorkerFrameLine(frame);
	return new Promise<void>((resolve, reject) => {
		child.stdin.write(line, "utf8", (error?: Error | null) => {
			if (error === undefined || error === null) resolve();
			else reject(error);
		});
	});
}

async function relayWorkerEvent(
	connection: RpcTransportConnection<OperationWorkerRequestFrame, OperationWorkerEventFrame>,
	line: string,
): Promise<void> {
	const parsed = parseOperationWorkerFrame(line);
	if (!parsed.ok || !validateOperationWorkerEventFrame(parsed.value)) {
		throw new Error("invalid remote Worker event");
	}
	await connection.send(parsed.value);
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Test listener did not expose a TCP port");
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return address.port;
}
