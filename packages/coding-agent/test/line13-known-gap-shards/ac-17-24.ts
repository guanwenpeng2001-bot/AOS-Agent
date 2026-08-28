import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	FoundationError,
	InMemorySessionStorage,
	Result,
	Session,
	SessionLedger,
	createConnectorCapabilitySnapshot,
	createFoundationToolGateway,
	createLocalToolGatewayProvider,
	createSandboxOperationToolGatewayProvider,
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
	type ExecutionCorrelation,
	type FoundationJsonValue,
	type SandboxOperationProvider,
} from "@aos-agent/agent-core";
import { registerFauxProvider } from "@aos-agent/ai/compat";
import * as CodingAgent from "../../src/index.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createRpcTransport,
	getPackageDir,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
} from "../../src/index.ts";
import {
	loadPackagedExternalAgentDriver,
	runPackagedExternalAgentDriverFixture,
	runPackagedLine13ProductTrace,
} from "../../src/external-connector.ts";
import {
	CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS,
	createConnectorRuntimeAggregateSnapshot,
	projectConnectorRuntimeStatus,
} from "../../src/core/connector-runtime-status.ts";
import { ConnectorRetryCircuit } from "../../src/core/connector-retry-circuit.ts";
import {
	createDescriptorExternalConnectorActivationSource,
	createExternalConnectorReadinessSnapshot,
} from "../../src/core/external-connector-readiness.ts";
import { createExternalConnectorRegistry } from "../../src/core/external-agent-registry.ts";
import type {
	ExternalConnectorDurableStore,
	ExternalConnectorExecutionInput,
	ExternalConnectorOperation,
	ExternalConnectorToolGatewayExecution,
	ExternalConnectorToolGatewayIntent,
	ExternalConnectorToolGatewayIntentWrite,
	ExternalConnectorToolGatewayTerminal,
} from "../../src/core/external-agent-operation.ts";
import {
	createProductionExternalAgentConnector,
	getProductionExternalConnectorDriverProvenance,
	getProductionExternalConnectorVendorDriver,
	getProductionExternalConnectorVendorDriverProcess,
	getProductionExternalConnectorVendorDriverProvenance,
} from "../../src/core/external-connector-production.ts";
import { resolveProductionExternalConnectorDriverProvenance } from "../../src/core/external-connector-process-controller.ts";
import {
	ExternalConnectorBoundedSupervisor,
	ExternalConnectorSupervisorError,
	type ExternalConnectorSupervisorPrivateState,
} from "../../src/core/external-connector-supervisor.ts";
import type { CanonicalExternalConnectorMapping } from "../../src/core/external-session-mapping.ts";
import type {
	ExternalConnectorDriverEvent,
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../../src/core/vendor-drivers/types.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { withRuntimeClock } from "../../src/core/runtime-clock.ts";
import { resolveRuntimeLimits } from "../../src/core/runtime-limits.ts";
import {
	ShutdownCoordinator,
	type ShutdownResult,
	type ShutdownSignalHandlers,
	type TerminationSignal,
} from "../../src/core/shutdown-coordinator.ts";
import type { WorkerBindingV1 } from "../../src/core/worker.ts";
import { createExternalConnectorTestSupervision } from "../external-connector-test-supervision.ts";
import { FakeWorkerProtocolTransportV1 } from "../fixtures/worker-protocol-fake-transport.ts";
import { DeterministicClock } from "../support/deterministic-clock.ts";
import {
	defineLine13KnownGapCaseShard,
	defineLine13ResolvedCase,
} from "../support/line13-known-gaps.ts";

const CHILD_ENTRY = fileURLToPath(new URL("../fixtures/fake-worker-child.ts", import.meta.url));
const NOW = "2026-08-25T00:00:00.000Z";

function workerBinding(profileId: string): WorkerBindingV1 {
	return {
		schemaVersion: 1,
		workerId: `worker-${profileId}`,
		providerId: "sandbox-worker",
		sessionId: "session-line13",
		laneId: "main",
		runId: "run-line13",
		bindingId: "binding-line13",
		bindingEpochId: "epoch-line13",
		attemptId: "attempt-line13",
		profileId,
		profileRevision: 1,
		capabilitySummary: ["filesystem.read", "process.spawn"],
		deadlineAt: Date.now() + 10_000,
		credentialTargetRefs: [],
		requestFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	};
}

function reserveTcpPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("TCP port reservation did not return an address"));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}

const ac17 = defineLine13ResolvedCase({
	ac: "AC-17",
	fullTestName: "Line 13 AC-17 keeps session scope replacement atomic when construction fails",
	scenario: {
		fixture: async () => {
			const directory = mkdtempSync(join(tmpdir(), "aos-line13-ac17-"));
			const faux = registerFauxProvider();
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
			const state = { shutdowns: 0, replacementError: "" };
			const createProductRuntime: CreateAgentSessionRuntimeFactory = async ({
				cwd,
				sessionManager,
				sessionStartEvent,
				registerCandidateSession,
			}) => {
				const serviceOptions = {
					cwd,
					agentDir: directory,
					authStorage,
					model: faux.getModel(),
					resourceLoaderOptions: {
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						extensionFactories: [
							(agent: ExtensionAPI) => {
								agent.registerProvider(faux.getModel().provider, {
									baseUrl: faux.getModel().baseUrl,
									apiKey: "faux-key",
									api: faux.api,
									models: faux.models,
								});
								agent.on("session_shutdown", () => {
									state.shutdowns += 1;
								});
							},
						],
					},
				};
				const services = await createAgentSessionServices(serviceOptions);
				const created = await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				});
				registerCandidateSession(created.session);
				return { ...created, services, diagnostics: services.diagnostics };
			};
			let failReplacement = false;
			const factory: CreateAgentSessionRuntimeFactory = async (options) => {
				if (failReplacement) throw new Error("line13 replacement construction failed");
				return createProductRuntime(options);
			};
			const runtime = await createAgentSessionRuntime(factory, {
				cwd: directory,
				agentDir: directory,
				session: { mode: "memory" },
			});
			await runtime.session.bindExtensions({});
			failReplacement = true;
			return { directory, faux, runtime, state };
		},
		setup: async ({ runtime, state }) => {
			try {
				await runtime.newSession();
			} catch (error) {
				state.replacementError = error instanceof Error ? error.message : String(error);
			}
		},
		assertion: ({ state }) => {
			strictEqual(state.replacementError, "line13 replacement construction failed");
			strictEqual(state.shutdowns, 0, "failed session scope replacement must not tear down the active runtime");
		},
		cleanup: async ({ directory, faux, runtime }) => {
			await runtime.dispose();
			faux.unregister();
			rmSync(directory, { recursive: true, force: true });
		},
	},
});

const ac18 = defineLine13ResolvedCase({
	ac: "AC-18",
	fullTestName: "Line 13 AC-18 routes SIGINT through bounded non-cooperative shutdown",
	scenario: {
		fixture: () => {
			const clock = new DeterministicClock();
			const listeners = new Map<TerminationSignal, Set<() => void>>();
			const signalHandlers = {
				add(signal: TerminationSignal, handler: () => void): void {
					const handlers = listeners.get(signal) ?? new Set<() => void>();
					handlers.add(handler);
					listeners.set(signal, handlers);
				},
				remove(signal: TerminationSignal, handler: () => void): void {
					const handlers = listeners.get(signal);
					handlers?.delete(handler);
					if (handlers?.size === 0) listeners.delete(signal);
				},
				emit(signal: TerminationSignal): void {
					for (const handler of [...(listeners.get(signal) ?? [])]) handler();
				},
				listenerCount(): number {
					return [...listeners.values()].reduce((total, handlers) => total + handlers.size, 0);
				},
			} satisfies ShutdownSignalHandlers & {
				emit(signal: TerminationSignal): void;
				listenerCount(): number;
			};
			const state = {
				observedSignal: undefined as TerminationSignal | undefined,
				resourceAborted: false,
				exitCodes: [] as number[],
				result: undefined as ShutdownResult | undefined,
			};
			const coordinator = new ShutdownCoordinator({
				clock,
				signalHandlers,
				terminationSignals: ["SIGINT"],
				budget: { totalMs: 100, resourceMs: 60, finalizationMs: 20 },
				closeAdmission: (request) => {
					state.observedSignal = request.signal;
				},
				resourceGroups: [[{
					name: "non_cooperative",
					cleanup: (signal) => {
						signal.addEventListener("abort", () => {
							state.resourceAborted = true;
						}, { once: true });
						return new Promise<void>(() => {});
					},
				}]],
				exit: (exitCode) => state.exitCodes.push(exitCode),
			});
			return {
				clock,
				coordinator,
				signalHandlers,
				state,
			};
		},
		setup: async ({ clock, coordinator, signalHandlers, state }) => {
			coordinator.installSignalHandlers();
			signalHandlers.emit("SIGINT");
			clock.advanceBy(60);
			for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
			if (coordinator.completion === undefined) throw new Error("SIGINT did not start shutdown");
			state.result = await coordinator.completion;
		},
		assertion: ({ clock, signalHandlers, state }) => {
			strictEqual(state.observedSignal, "SIGINT");
			strictEqual(state.resourceAborted, true);
			deepStrictEqual(state.result?.failures.map(({ phase, resource, reason }) => ({ phase, resource, reason })), [{
				phase: "resource",
				resource: "non_cooperative",
				reason: "deadline_exceeded",
			}]);
			deepStrictEqual(state.exitCodes, [130]);
			strictEqual(signalHandlers.listenerCount(), 0);
			strictEqual(clock.pendingCount(), 0);
		},
	},
});

const ac19 = defineLine13ResolvedCase({
	ac: "AC-19",
	fullTestName: "Line 13 AC-19 binds orphan cleanup to a non-reusable process identity",
	scenario: {
		fixture: () => {
			const attemptId = "attempt-line13-identity-recovery";
			const supervision = createExternalConnectorTestSupervision();
			const createSupervisor = () => new ExternalConnectorBoundedSupervisor({
				reference: {
					schemaVersion: 1,
					supervisorRef: "line13-identity-supervisor",
					operationNonce: "line13-identity-nonce",
				},
				containment: supervision.options.containment,
				processController: supervision.processController,
				artifactsAllowed: false,
				deadlines: supervision.options.deadlines,
			});
			return {
				attemptId,
				createSupervisor,
				supervision,
				launchedState: undefined as ExternalConnectorSupervisorPrivateState | undefined,
				persistedState: undefined as ExternalConnectorSupervisorPrivateState | undefined,
				recoveryRejected: false,
				restarted: undefined as ExternalConnectorBoundedSupervisor | undefined,
			};
		},
		setup: async (fixture) => {
			const first = fixture.createSupervisor();
			fixture.launchedState = await first.launch((state) =>
				fixture.supervision.privateStateStore.write(fixture.attemptId, state));
			fixture.persistedState = await fixture.supervision.privateStateStore.read(fixture.attemptId);
			if (fixture.persistedState === undefined) throw new Error("canonical process identity was not persisted");
			fixture.supervision.processController.reattachResult = { status: "identity_mismatch" };
			fixture.restarted = fixture.createSupervisor();
			try {
				await fixture.restarted.recoverAndReap(fixture.persistedState);
			} catch (error) {
				fixture.recoveryRejected =
					error instanceof ExternalConnectorSupervisorError && error.code === "reconcile_required";
			}
		},
		assertion: (fixture) => {
			deepStrictEqual(fixture.persistedState?.processIdentity, fixture.launchedState?.processIdentity);
			strictEqual(fixture.recoveryRejected, true);
			strictEqual(fixture.restarted?.snapshot.quarantined, true);
			strictEqual(fixture.restarted?.snapshot.cleaned, false);
			strictEqual(fixture.supervision.processController.forceCalls, 0);
		},
		cleanup: ({ supervision }) => {
			supervision.processController.resolveExits();
		},
	},
});

const ac20 = defineLine13ResolvedCase({
	ac: "AC-20",
	fullTestName: "Line 13 AC-20 drains bounded ordered protocol writes before transport close",
	scenario: {
		fixture: () => ({ orderedProtocol: false, drained: false }),
		setup: async (fixture) => {
			const binding = workerBinding("protocol-order");
			const protocol = new FakeWorkerProtocolTransportV1(binding, "receipt");
			const initialized = protocol.send({ type: "initialize", requestId: "initialize-1", binding });
			if (!initialized.ok) throw initialized.error;
			const executed = protocol.send({
				type: "execute",
				requestId: "execute-1",
				workerId: binding.workerId,
				operationId: "operation-1",
				request: {
					schemaVersion: 1,
					operationId: "operation-1",
					providerId: binding.providerId,
					bindingId: binding.bindingId,
					bindingEpochId: binding.bindingEpochId,
					taskId: "task-1",
					dispatchId: "dispatch-1",
					attemptId: binding.attemptId,
					payload: { action: "read" },
				},
			});
			if (!executed.ok) throw executed.error;
			const eventTypes = [...initialized.value, ...executed.value].map((line) => {
				const parsed = JSON.parse(line) as { readonly type?: unknown };
				return parsed.type;
			});
			fixture.orderedProtocol = eventTypes.join(",") === "ready,operation.started,operation.completed,receipt";

			let dispatchStarted!: () => void;
			const dispatchReady = new Promise<void>((resolve) => {
				dispatchStarted = resolve;
			});
			let writes: Promise<void>[] = [];
			const outputs = Array.from({ length: 24 }, (_, sequence) => ({ sequence, payload: "x".repeat(32 * 1024) }));
			const port = await reserveTcpPort();
			const transport = createRpcTransport<{ readonly type: string }, (typeof outputs)[number]>({
				address: { transport: "tcp", host: "127.0.0.1", port },
				maxFrameBytes: 64 * 1024,
				dispatch: (_command, sink) => {
					writes = outputs.map((output) => sink.send(output));
					dispatchStarted();
				},
			});
			await transport.start();
			const address = transport.address;
			if (address === undefined) throw new Error("RPC transport did not bind");
			const socket = createConnection({ host: address.host, port: address.port });
			socket.setEncoding("utf8");
			let received = "";
			socket.on("data", (chunk: string) => {
				received += chunk;
			});
			socket.on("error", () => {});
			const connected = new Promise<void>((resolve) => socket.once("connect", resolve));
			const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
			await connected;
			socket.write('{"type":"soak"}\n');
			await dispatchReady;
			const settledWrites = Promise.allSettled(writes);
			await transport.close();
			await closed;
			const settlements = await settledWrites;
			const lines = received
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as { readonly sequence?: unknown });
			fixture.drained =
				settlements.every((settlement) => settlement.status === "fulfilled") &&
				lines.length === outputs.length &&
				lines.every((line, index) => line.sequence === index);
		},
		assertion: (fixture) => {
			strictEqual(
				fixture.orderedProtocol && fixture.drained,
				true,
				"framed events and pending writes must drain completely in order before transport close",
			);
		},
	},
});

const ac21 = defineLine13ResolvedCase({
		ac: "AC-21",
		fullTestName: "Line 13 AC-21 validates gateway catalog before readiness and releases exact in-flight state",
	scenario: {
		fixture: () => ({ catalogUnavailable: false, callbackFailed: false, disposed: false, cancelled: [] as string[] }),
		setup: async (fixture) => {
			const invalidProvider = createLocalToolGatewayProvider({
				providerId: "catalog-provider",
				revision: 1,
				routes: [
					{ kind: "local", toolName: "read", namespace: "line13", providerId: "missing-provider", revision: 1, operation: { resource: "filesystem.read", effects: ["read"] } },
				],
				invoke: async (request) =>
					Result.ok({
						schemaVersion: 1,
						toolCallId: request.toolCallId,
						toolName: request.toolName,
						ok: true,
						sideEffectState: "none",
					}),
			});
			try {
				createFoundationToolGateway({ gatewayId: "invalid-catalog", providers: [invalidProvider] });
			} catch (error) {
				fixture.catalogUnavailable = error instanceof FoundationError && error.code === "tool_gateway_catalog_invalid";
			}

			const sandbox: SandboxOperationProvider = {
				schemaVersion: 1,
				providerId: "sandbox-provider",
				providerClass: "operation_worker",
				async capabilities() {
					return [];
				},
				async start() {
					return Result.err(new FoundationError("worker_start_failed", "start should not be reached"));
				},
				async cancel(operationId) {
					fixture.cancelled.push(operationId);
					return Result.ok(undefined);
				},
				async dispose() {
					fixture.disposed = true;
				},
			};
			const provider = createSandboxOperationToolGatewayProvider({
				providerId: "sandbox-provider",
				revision: 1,
				routes: [
					{ kind: "sandbox", toolName: "write", namespace: "line13", providerId: "sandbox-provider", revision: 1, operation: { resource: "filesystem.write", effects: ["write", "create"] } },
				],
				sandbox,
				onOperationPayload: () => {
					throw new Error("payload observer failed");
				},
			});
			const gateway = createFoundationToolGateway({ gatewayId: "cleanup-gateway", providers: [provider] });
			try {
				await gateway.execute({
					schemaVersion: 1,
					toolCallId: "call-1",
					toolName: "write",
					namespace: "line13",
					originalArguments: { path: "safe.txt" },
					context: {
						schemaVersion: 1,
						bindingId: "binding-1",
						bindingEpochId: "epoch-1",
						taskId: "task-1",
					},
				});
			} catch (error) {
				fixture.callbackFailed = error instanceof Error && error.message === "payload observer failed";
			}
			await gateway.dispose();
		},
		assertion: (fixture) => {
			strictEqual(
				fixture.catalogUnavailable && fixture.callbackFailed && fixture.disposed && fixture.cancelled.length === 0,
				true,
				"gateway readiness must reject an invalid catalog and exact cleanup must not retain failed pre-start work",
			);
		},
	},
});

const ac22 = defineLine13ResolvedCase({
	ac: "AC-22",
	fullTestName: "Line 13 AC-22 ships the fake connector through the public Node package subpath",
	scenario: {
		fixture: () => ({
			packageMetadata: false,
			assetTrace: false,
			missingCode: "",
			isolatedOwnerPassed: false,
		}),
		setup: async (fixture) => {
			const packageDirectory = getPackageDir();
			const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
				readonly scripts?: Record<string, unknown>;
				readonly exports?: Record<string, unknown>;
			};
			const publicSubpath = manifest.exports?.["./external-connector"] as
				| { readonly types?: unknown; readonly import?: unknown }
				| undefined;
			fixture.packageMetadata =
				publicSubpath?.types === "./dist/external-connector.d.ts" &&
				publicSubpath.import === "./dist/external-connector.js" &&
				String(manifest.scripts?.["copy-assets"] ?? "").includes("fake-connector") &&
				String(manifest.scripts?.["copy-binary-assets"] ?? "").includes("fake-connector");

			const driver = loadPackagedExternalAgentDriver("fake-connector");
			const trace = await runPackagedExternalAgentDriverFixture();
			fixture.assetTrace =
				driver.defaultEnabled === false &&
				driver.networkMode === "disabled" &&
				trace.events.map(({ kind }) => kind).join("|") === "capabilities|start|tool|resume|cancel" &&
				trace.receipts.map(({ phase, status }) => `${phase}:${status}`).join("|") ===
					"run:suspended|resume:succeeded|cancel:cancelled" &&
				trace.lifecycle.createAttempt === 2;
			try {
				loadPackagedExternalAgentDriver("line13-missing-connector");
			} catch (error) {
				fixture.missingCode =
					typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unsafe_error";
			}

			const ownerTest = fileURLToPath(new URL("../../scripts/line13-pack-smoke.test.mjs", import.meta.url));
			const owner = spawnSync(process.execPath, ["--test", ownerTest], {
				cwd: packageDirectory,
				encoding: "utf8",
				timeout: 120_000,
			});
			fixture.isolatedOwnerPassed = owner.status === 0;
		},
		assertion: (fixture) => {
			strictEqual(
				fixture.packageMetadata &&
					fixture.assetTrace &&
					fixture.missingCode === "external_agent_driver_asset_missing" &&
					fixture.isolatedOwnerPassed,
				true,
				"the Node package owner must expose the public subpath, ship the fixture, install outside the repository, and fail safely on missing assets",
			);
		},
	},
});

class Line13ProductionDriverStore implements ExternalConnectorDurableStore {
	async readAttempt(_attemptId: string): Promise<Attempt | undefined> {
		return undefined;
	}

	async readBinding(_bindingId: string): Promise<AgentBinding | undefined> {
		return undefined;
	}

	async readExecutionInput(_taskId: string): Promise<ExternalConnectorExecutionInput | undefined> {
		return undefined;
	}

	async readOperation(_attemptId: string): Promise<ExternalConnectorOperation | undefined> {
		return undefined;
	}

	async writeOperation(operation: ExternalConnectorOperation): Promise<ExternalConnectorOperation> {
		return operation;
	}

	async readMapping(_attemptId: string): Promise<CanonicalExternalConnectorMapping | undefined> {
		return undefined;
	}

	async writeMapping(
		mapping: CanonicalExternalConnectorMapping,
		_correlation: ExecutionCorrelation,
	): Promise<CanonicalExternalConnectorMapping> {
		return mapping;
	}

	async readReceipt(_attemptId: string): Promise<AttemptReceipt | undefined> {
		return undefined;
	}

	async writeReceipt(receipt: AttemptReceipt): Promise<AttemptReceipt> {
		return receipt;
	}

	async readToolGatewayExecution(
		_attemptId: string,
		_toolCallId: string,
	): Promise<ExternalConnectorToolGatewayExecution | undefined> {
		return undefined;
	}

	async listToolGatewayExecutions(_attemptId: string): Promise<readonly ExternalConnectorToolGatewayExecution[]> {
		return [];
	}

	async writeToolGatewayIntent(
		intent: ExternalConnectorToolGatewayIntent,
	): Promise<ExternalConnectorToolGatewayIntentWrite> {
		return { intent, claimed: true };
	}

	async writeToolGatewayTerminal(
		terminal: ExternalConnectorToolGatewayTerminal,
	): Promise<ExternalConnectorToolGatewayTerminal> {
		return terminal;
	}
}

class Line13ProductionVendorDriver implements ExternalConnectorVendorDriver {
	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		return {
			externalSessionId: `external-${request.attempt.attemptId}`,
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	async *events(handle: ExternalConnectorDriverHandle): AsyncIterable<FoundationJsonValue> {
		const started: ExternalConnectorDriverEvent = {
			schemaVersion: 1,
			type: "started",
			externalSessionId: handle.externalSessionId,
			...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
			producedAt: NOW,
		};
		yield started;
	}

	async connect(mapping: CanonicalExternalConnectorMapping): Promise<ExternalConnectorDriverHandle> {
		return {
			externalSessionId: mapping.externalSessionId,
			...(mapping.externalTurnId === undefined ? {} : { externalTurnId: mapping.externalTurnId }),
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
		};
	}

	async lookup(mapping: CanonicalExternalConnectorMapping): Promise<ExternalConnectorDriverLookup> {
		return { status: "running", handle: await this.connect(mapping) };
	}

	async read(handle: ExternalConnectorDriverHandle): Promise<ExternalConnectorTerminalEvidence> {
		return this.terminal(handle, "succeeded");
	}

	async write(
		_handle: ExternalConnectorDriverHandle,
		_request: ExternalConnectorDriverWriteRequest,
		_options?: { readonly signal?: AbortSignal },
	): Promise<void> {}

	async heartbeat(
		_handle: ExternalConnectorDriverHandle,
		_options?: { readonly signal?: AbortSignal },
	): Promise<void> {}

	async cancel(
		handle: ExternalConnectorDriverHandle,
		_options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorTerminalEvidence> {
		return this.terminal(handle, "cancelled");
	}

	async dispose(_options?: { readonly signal?: AbortSignal }): Promise<void> {}

	private terminal(
		handle: ExternalConnectorDriverHandle,
		status: "succeeded" | "cancelled",
	): ExternalConnectorTerminalEvidence {
		return {
			externalSessionId: handle.externalSessionId,
			...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
			operationNonce: handle.operationNonce,
			status,
			sideEffectState: "none",
			producedAt: NOW,
		};
	}
}

const ac23 = defineLine13ResolvedCase({
		ac: "AC-23",
		fullTestName: "Line 13 AC-23 binds exact trusted driver provenance and a minimal environment",
	scenario: {
		fixture: async () => {
			const root = mkdtempSync(join(tmpdir(), "aos-line13-ac23-"));
			const providerId = "line13.driver-connector";
			const snapshot = createConnectorCapabilitySnapshot({
				schemaVersion: 1,
				providerId,
				revision: 1,
				protocol: { name: "line13-driver", version: "1" },
				modelAccess: "none",
				resume: false,
				toolGateway: false,
				artifacts: false,
				images: false,
			});
			const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
			const trustedProvenance = {
				modulePath: CHILD_ENTRY,
				cwd: root,
				version: process.version,
				executableIdentity: digest(process.execPath),
				moduleIdentity: digest(CHILD_ENTRY),
			} as const;
			const processTarget = {
				executablePath: process.execPath,
				arguments: [CHILD_ENTRY],
				trustedProvenance,
			} as const;
			let invalidIdentityRejected = false;
			let invalidVersionRejected = false;
			try {
				resolveProductionExternalConnectorDriverProvenance({
					executablePath: process.execPath,
					arguments: [CHILD_ENTRY],
					trustedProvenance: { ...trustedProvenance, moduleIdentity: "sha256:wrong" },
				});
			} catch {
				invalidIdentityRejected = true;
			}
			try {
				resolveProductionExternalConnectorDriverProvenance({
					executablePath: process.execPath,
					arguments: [CHILD_ENTRY],
					trustedProvenance: { ...trustedProvenance, version: "" },
				});
			} catch {
				invalidVersionRejected = true;
			}
			const driver = new Line13ProductionVendorDriver();
			const connector = await createProductionExternalAgentConnector({
				providerId,
				capability: snapshot,
				capabilityProbe: async () => Result.ok(snapshot),
				store: new Line13ProductionDriverStore(),
				driver,
				privateStatePath: join(root, "private", "supervisors.json"),
				process: processTarget,
			});
			let driverRebindRejected = false;
			try {
				await createProductionExternalAgentConnector({
					providerId,
					capability: snapshot,
					capabilityProbe: async () => Result.ok(snapshot),
					store: new Line13ProductionDriverStore(),
					driver,
					privateStatePath: join(root, "private", "rebound-supervisors.json"),
					process: { ...processTarget, arguments: [CHILD_ENTRY, "--different-target"] },
				});
			} catch {
				driverRebindRejected = true;
			}
			const descriptor = {
				schemaVersion: 1 as const,
				providerId,
				providerClass: "external_connector" as const,
				revision: snapshot.revision,
				capabilitySnapshotDigest: snapshot.digest,
			};
			const registry = createExternalConnectorRegistry();
			const registered = registry.registerPrepared({
				descriptor,
				connector,
			}, snapshot);
			if (!registered.ok) throw registered.error;
			return {
				root,
				connector,
				driver,
				registry,
				descriptor,
				driverRebindRejected,
				invalidIdentityRejected,
				invalidVersionRejected,
			};
		},
		assertion: ({
			root,
			connector,
			driver,
			registry,
			descriptor,
			driverRebindRejected,
			invalidIdentityRejected,
			invalidVersionRejected,
		}) => {
			const provenance = getProductionExternalConnectorDriverProvenance(connector);
			if (provenance === undefined) throw new Error("Production connector did not retain trusted provenance");
			const boundDriver = getProductionExternalConnectorVendorDriver(connector);
			if (boundDriver === undefined) throw new Error("Production connector did not retain its execution driver");
			strictEqual(boundDriver === driver, false);
			deepStrictEqual(getProductionExternalConnectorVendorDriverProcess(boundDriver), {
				executablePath: provenance.executablePath,
				arguments: [CHILD_ENTRY],
				trustedProvenance: {
					modulePath: provenance.modulePath,
					cwd: provenance.cwd,
					version: provenance.version,
					executableIdentity: provenance.executableIdentity,
					moduleIdentity: provenance.moduleIdentity,
				},
			});
			strictEqual(getProductionExternalConnectorVendorDriverProvenance(boundDriver), provenance);
			strictEqual(getProductionExternalConnectorVendorDriverProvenance(driver), provenance);
			strictEqual(provenance?.executablePath, realpathSync(process.execPath));
			strictEqual(provenance?.modulePath, realpathSync(CHILD_ENTRY));
			strictEqual(provenance?.cwd, realpathSync(root));
			strictEqual(provenance?.version, process.version);
			strictEqual(provenance?.shell, false);
			const allowedEnvironment = process.platform === "win32" ? ["SystemRoot", "TEMP", "TMP", "WINDIR"] : process.platform === "darwin" ? ["TMPDIR"] : [];
			const expectedEnvironment = allowedEnvironment.filter((allowedKey) => Object.keys(process.env).some((key) => process.platform === "win32" ? key.toLowerCase() === allowedKey.toLowerCase() : key === allowedKey)).sort();
			strictEqual(provenance?.environmentKeys.join(","), expectedEnvironment.join(","));
			strictEqual(provenance?.executableIdentity.startsWith("sha256:"), true);
			strictEqual(provenance?.moduleIdentity.startsWith("sha256:"), true);
			strictEqual(provenance?.executableFileIdentity.startsWith("file:"), true);
			strictEqual(provenance?.moduleFileIdentity.startsWith("file:"), true);
			strictEqual(invalidIdentityRejected, true);
			strictEqual(invalidVersionRejected, true);
			strictEqual(driverRebindRejected, true);
			const projection = JSON.stringify({ descriptors: registry.list(), readiness: registry.readiness() });
			for (const privateValue of [root, process.execPath, CHILD_ENTRY, process.version, provenance?.moduleIdentity ?? "missing"]) {
				strictEqual(projection.includes(privateValue), false);
			}
			strictEqual(registry.list()[0]?.providerId, descriptor.providerId);
			for (const privateExport of [
				"getProductionExternalConnectorDriverProvenance",
				"getProductionExternalConnectorVendorDriver",
				"getProductionExternalConnectorVendorDriverProcess",
				"getProductionExternalConnectorVendorDriverProvenance",
			]) {
				strictEqual(privateExport in CodingAgent, false);
			}
		},
		cleanup: async ({ root, registry }) => {
			await registry.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	},
});

const ac24 = defineLine13ResolvedCase({
	ac: "AC-24",
	fullTestName: "Line 13 AC-24 applies RuntimeLimits and exposes deterministic terminal resource status",
	scenario: {
		fixture: () => {
			const root = mkdtempSync(join(tmpdir(), "aos-line13-ac24-"));
			return {
				root,
				productClosure: false,
				sideEffectUnknownTerminal: false,
				limitsApplied: false,
				statusObservable: false,
			};
		},
		setup: async (fixture) => {
			const workDirectory = join(fixture.root, "state");
			mkdirSync(workDirectory);
			const trace = await runPackagedLine13ProductTrace({ workDirectory, iterations: 7 });
			fixture.productClosure =
				trace.entrypoint === "aos-agent/external-connector" &&
				trace.adapter === "standard_product_composition" &&
				trace.samples.length === 7 &&
				Object.values(trace.operations).every((count) => count === 1) &&
				trace.provider.kind === "faux" &&
				trace.provider.pendingResponses === 0 &&
				trace.final.activeRuns === 0 &&
				trace.final.backlog === 0 &&
				trace.final.status === 0 &&
				trace.final.credentials === 0 &&
				trace.final.reservations === 0 &&
				trace.final.processes === 0 &&
				trace.final.timers === 0 &&
				trace.final.files === 1 &&
				trace.final.pendingWrites === 0;

			const limits = resolveRuntimeLimits({
				global: { maxConcurrency: 4, maxBacklog: 32 },
				project: { maxConcurrency: 2, maxBacklog: 16 },
			});
			let noWiden = false;
			try {
				resolveRuntimeLimits({ global: { maxConcurrency: 4 }, project: { maxConcurrency: 5 } });
			} catch {
				noWiden = true;
			}
			fixture.limitsApplied =
				Object.isFrozen(limits) &&
				Object.isFrozen(limits.values) &&
				limits.values.maxConcurrency === 2 &&
				limits.values.maxBacklog === 16 &&
				noWiden;

			const observedAtMs = Date.parse(NOW);
			const capability = createConnectorCapabilitySnapshot({
				schemaVersion: 1,
				providerId: "line13.runtime-provider",
				revision: 1,
				protocol: { name: "fixture", version: "1" },
				modelAccess: "agent_owned",
				resume: true,
				toolGateway: false,
				artifacts: false,
				images: false,
			});
			const readiness = createExternalConnectorReadinessSnapshot({
				source: createDescriptorExternalConnectorActivationSource({
					providerId: capability.providerId,
					revision: capability.revision,
					capabilityDigest: capability.digest,
				}),
				status: "ready",
				reasonCode: "ready",
				state: "current",
				observedAtMs,
				ttlMs: 60_000,
			});
			const zeroCounts = CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS.map(() => 0);
			const runtime = createConnectorRuntimeAggregateSnapshot({
				providerId: capability.providerId,
				targetId: "line13.runtime-target",
				observedAtMs,
				ttlMs: 60_000,
				circuit: null,
				limits,
				activity: { active: 0, queued: 0, reconcile: 0 },
				counters: {
					startTotal: 0,
					resumeTotal: 0,
					cancelTotal: 0,
					forcedKillTotal: 0,
					limitRejectTotal: 0,
					frameRejectTotal: 0,
					eventDropTotal: 0,
				},
				latency: {
					cancelMs: { counts: zeroCounts, overflowCount: 0 },
					shutdownMs: { counts: zeroCounts, overflowCount: 0 },
				},
			});
			const status = projectConnectorRuntimeStatus({
				providerId: capability.providerId,
				readinessSnapshot: readiness,
				runtimeSnapshot: runtime,
				nowMs: observedAtMs,
			});
			fixture.statusObservable =
				status.availability === "available" &&
				status.readiness.state === "ready" &&
				status.circuit.state === "closed" &&
				status.circuit.nextTransition === "none" &&
				status.limits.digest.value === limits.digest.value &&
				status.activity.active === 0 &&
				status.activity.queued === 0 &&
				status.activity.reconcile === 0;

			const clock = new DeterministicClock({ wallTimeMs: observedAtMs, monotonicTimeMs: 0 });
			const session = new Session(new InMemorySessionStorage({ id: "session-line13-runtime", createdAt: 1 }));
			const ledger = new SessionLedger(session, { ownerId: "line13-runtime-owner" });
			try {
				const circuit = new ConnectorRetryCircuit(
					withRuntimeClock({ ledger, taskId: "task-line13-runtime" }, clock),
				);
				const decision = await circuit.recordFailure({
					operationId: "line13-side-effect-unknown",
					targetId: "line13.runtime-target",
					attemptCount: 1,
					guarantee: "idempotent",
					sideEffectState: "side_effect_unknown",
					error: {
						code: "external_connector_unavailable",
						message: "Connector unavailable.",
						category: "transient",
						retryable: true,
					},
				});
				fixture.sideEffectUnknownTerminal =
					decision.ok && decision.value.decision === "stop" && decision.value.reasonCode === "side_effect_unknown";
			} finally {
				await ledger.release();
			}
		},
		assertion: (fixture) => {
			strictEqual(
				fixture.productClosure &&
					fixture.sideEffectUnknownTerminal &&
					fixture.limitsApplied &&
					fixture.statusObservable,
				true,
				"the standard product trace, RuntimeLimits, passive status, and terminal unknown-side-effect retry decision must close through current owners",
			);
		},
		cleanup: ({ root }) => rmSync(root, { recursive: true, force: true }),
	},
});

export const line13KnownGapCasesAc17Ac24 = defineLine13KnownGapCaseShard({
	schemaVersion: 1,
	shardId: "ac-17-24",
	complete: true,
	cases: [],
	resolvedCases: [ac17, ac18, ac19, ac20, ac21, ac22, ac23, ac24],
});
