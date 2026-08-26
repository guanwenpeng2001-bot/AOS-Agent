import { strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	FoundationError,
	InMemorySessionStorage,
	Result,
	Session,
	createFoundationToolGateway,
	createLocalToolGatewayProvider,
	createSandboxOperationToolGatewayProvider,
	type SandboxOperationProvider,
} from "@aos-agent/agent-core";
import { registerFauxProvider } from "@aos-agent/ai/compat";
import * as CodingAgent from "../../src/index.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createExternalAgentAdapterRegistry,
	createRpcTransport,
	getPackageDir,
	SchedulerHost,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
	type ExternalAgentAdapter,
	type SchedulerHostOptions,
} from "../../src/index.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { withRuntimeClock } from "../../src/core/runtime-clock.ts";
import { isSchedulerSideEffectRetryable } from "../../src/core/scheduler.ts";
import { SchedulerQueueStore } from "../../src/core/scheduler-queue.ts";
import { TaskGraphStore } from "../../src/core/task-graph.ts";
import { WorkerSupervisorV1 } from "../../src/core/worker-supervisor.ts";
import type { WorkerBindingV1 } from "../../src/core/worker.ts";
import { sourceProcessArgs, sourceProcessEnv } from "../cli-process.ts";
import { FakeWorkerProtocolTransportV1 } from "../fixtures/worker-protocol-fake-transport.ts";
import { DeterministicClock } from "../support/deterministic-clock.ts";
import {
	LINE13_T0_BASE_SHA,
	defineLine13KnownGapCase,
	defineLine13KnownGapCaseShard,
	defineLine13ResolvedCase,
} from "../support/line13-known-gaps.ts";

const CHILD_ENTRY = fileURLToPath(new URL("../fixtures/fake-worker-child.ts", import.meta.url));
const NOW = "2026-08-25T00:00:00.000Z";

interface ProcessOutcome {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function runProcess(
	executable: string,
	args: readonly string[],
	options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number },
): Promise<ProcessOutcome> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 5_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (exitCode) => {
			clearTimeout(timer);
			resolve({ exitCode, stdout, stderr });
		});
	});
}

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

const ac18 = defineLine13KnownGapCase({
	entry: {
		ac: "AC-18",
		fullTestName: "Line 13 AC-18 routes SIGINT through bounded non-cooperative shutdown",
		baseSha: LINE13_T0_BASE_SHA,
		ownerStage: "T9c",
		mode: "fails",
		expectedFailure: {
			reason: "shutdown.sigint_bound",
			fingerprint: "sha256:c11e32e97570e7a95a27bc80c60ce2c0b8e8b0e6b5a4d35795b6994c8b730732",
		},
	},
	scenario: {
		fixture: () => {
			const directory = mkdtempSync(join(tmpdir(), "aos-line13-ac18-"));
			return {
				directory,
				driverPath: join(directory, "sigint-driver.ts"),
				markerPath: join(directory, "shutdown-started"),
				recordPath: join(directory, "result.json"),
				outcome: undefined as ProcessOutcome | undefined,
			};
		},
		setup: async (fixture) => {
			const sourceRoot = fileURLToPath(new URL("../../src", import.meta.url));
			const indexUrl = pathToFileURL(join(sourceRoot, "index.ts")).href;
			const authUrl = pathToFileURL(join(sourceRoot, "core", "auth-storage.ts")).href;
			const rpcModeUrl = pathToFileURL(join(sourceRoot, "modes", "rpc", "rpc-mode.ts")).href;
			const aiCompatUrl = pathToFileURL(join(sourceRoot, "..", "..", "ai", "src", "compat.ts")).href;
			writeFileSync(
				fixture.driverPath,
				`import { writeFileSync } from "node:fs";\nimport { registerFauxProvider } from ${JSON.stringify(aiCompatUrl)};\nimport { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices } from ${JSON.stringify(indexUrl)};\nimport { AuthStorage } from ${JSON.stringify(authUrl)};\nimport { runRpcMode } from ${JSON.stringify(rpcModeUrl)};\nconst marker = ${JSON.stringify(fixture.markerPath)};\nconst record = ${JSON.stringify(fixture.recordPath)};\nconst directory = ${JSON.stringify(fixture.directory)};\nconst faux = registerFauxProvider();\nconst auth = AuthStorage.inMemory();\nawait auth.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));\nconst createRuntime = async ({ cwd, sessionManager, sessionStartEvent, registerCandidateSession }) => { const services = await createAgentSessionServices({ cwd, agentDir: directory, authStorage: auth, model: faux.getModel(), resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [(agent) => { agent.registerProvider(faux.getModel().provider, { baseUrl: faux.getModel().baseUrl, apiKey: "faux-key", api: faux.api, models: faux.models }); agent.on("session_shutdown", async () => { writeFileSync(marker, "started"); await new Promise(() => {}); }); }] } }); const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel() }); registerCandidateSession(created.session); return { ...created, services, diagnostics: services.diagnostics }; };\nconst runtime = await createAgentSessionRuntime(createRuntime, { cwd: directory, agentDir: directory, session: { mode: "memory" } });\nawait runtime.session.bindExtensions({});\nvoid runRpcMode(runtime);\nsetTimeout(() => { const listener = process.listenerCount("SIGINT") > 0; writeFileSync(record, JSON.stringify({ listener })); process.emit("SIGINT"); setTimeout(() => { writeFileSync(record, JSON.stringify({ listener, watchdog: true })); process.exit(91); }, 750); }, 250);\n`,
				"utf8",
			);
			fixture.outcome = await runProcess(process.execPath, sourceProcessArgs(fixture.driverPath), {
				cwd: fixture.directory,
				env: sourceProcessEnv(),
				timeoutMs: 2_000,
			});
		},
		assertion: (fixture) => {
			const record = (existsSync(fixture.recordPath) ? JSON.parse(readFileSync(fixture.recordPath, "utf8")) : {}) as {
				readonly listener?: boolean;
				readonly watchdog?: boolean;
			};
			strictEqual(
				record.listener === true && existsSync(fixture.markerPath) && record.watchdog !== true && fixture.outcome?.exitCode !== 91,
				true,
				"SIGINT must enter shutdown and bound non-cooperative cleanup before the watchdog",
			);
		},
		cleanup: (fixture) => rmSync(fixture.directory, { recursive: true, force: true }),
	},
});

const ac19 = defineLine13KnownGapCase({
	entry: {
		ac: "AC-19",
		fullTestName: "Line 13 AC-19 binds orphan cleanup to a non-reusable process identity",
		baseSha: LINE13_T0_BASE_SHA,
		ownerStage: "T9c",
		mode: "fails",
		expectedFailure: {
			reason: "worker.pid_reuse",
			fingerprint: "sha256:efc70b64c573fb23dab43b640719bfddfa90d3846f0a8cc693694cd99a6357a3",
		},
	},
	scenario: {
		fixture: () => {
			const profileId = "reclaim_unknown";
			return {
				supervisor: new WorkerSupervisorV1({
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId,
					profileRevision: 1,
					capabilities: ["filesystem.read", "process.spawn"],
					environment: { AOS_SAFE_TEST_MARKER: "1" },
					readyTimeoutMs: 2_000,
					heartbeatTimeoutMs: 250,
					cancelTimeoutMs: 100,
					terminateTimeoutMs: 100,
				}),
				binding: workerBinding(profileId),
				identityBound: false,
				cleaned: false,
			};
		},
		setup: async (fixture) => {
			const preflight = fixture.supervisor.preflight({ binding: fixture.binding, runAccepted: true });
			if (!preflight.ok) throw preflight.error;
			const activated = await fixture.supervisor.activate(preflight.value);
			if (!activated.ok) throw activated.error;
			const privateState = fixture.supervisor as unknown as Record<string, unknown>;
			fixture.identityBound = Object.entries(privateState).some(([key, value]) => {
				if (!/(identity|containment)/i.test(key) || value === null || typeof value !== "object") return false;
				const identity = value as Record<string, unknown>;
				return typeof identity.pid === "number" && (typeof identity.startedAt === "string" || typeof identity.startTime === "number");
			});
			const reclaimed = await fixture.supervisor.reclaim();
			if (!reclaimed.ok) throw reclaimed.error;
			fixture.cleaned = !fixture.supervisor.snapshot.hasLiveProcess && fixture.supervisor.snapshot.quarantined;
		},
		assertion: (fixture) => {
			strictEqual(
				fixture.cleaned && fixture.identityBound,
				true,
				"orphan cleanup must retain process-start identity so a reused PID is never signalled",
			);
		},
		cleanup: async ({ supervisor }) => {
			await supervisor.dispose();
		},
	},
});

const ac20 = defineLine13KnownGapCase({
	entry: {
		ac: "AC-20",
		fullTestName: "Line 13 AC-20 drains bounded ordered protocol writes before transport close",
		baseSha: LINE13_T0_BASE_SHA,
		ownerStage: "T9c",
		mode: "fails",
		expectedFailure: {
			reason: "transport.pending_drain",
			fingerprint: "sha256:bc8941d5af185a0022de298f5bfc992d451b652eeb3b4d499536bbe913e5fa84",
		},
	},
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

const ac21 = defineLine13KnownGapCase({
	entry: {
		ac: "AC-21",
		fullTestName: "Line 13 AC-21 validates gateway catalog before readiness and releases exact in-flight state",
		baseSha: LINE13_T0_BASE_SHA,
		ownerStage: "T5",
		mode: "fails",
		expectedFailure: {
			reason: "gateway.readiness_cleanup",
			fingerprint: "sha256:e77927b78f5c0f55ecbade4c55698f1663af20274cd23e1e7202888b14ee7756",
		},
	},
	scenario: {
		fixture: () => ({ catalogUnavailable: false, callbackFailed: false, cancelled: [] as string[] }),
		setup: async (fixture) => {
			const invalidProvider = createLocalToolGatewayProvider({
				providerId: "catalog-provider",
				routes: [
					{ kind: "local", toolName: "read", namespace: "line13", providerId: "missing-provider", revision: 1 },
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
			const invalidGateway = createFoundationToolGateway({ gatewayId: "invalid-catalog", providers: [invalidProvider] });
			try {
				await invalidGateway.capabilities();
			} catch (error) {
				fixture.catalogUnavailable = error instanceof FoundationError && error.code === "invalid_identifier";
			}
			await invalidGateway.dispose();

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
				async dispose() {},
			};
			const provider = createSandboxOperationToolGatewayProvider({
				providerId: "sandbox-provider",
				routes: [
					{ kind: "sandbox", toolName: "write", namespace: "line13", providerId: "sandbox-provider", revision: 1 },
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
				fixture.catalogUnavailable && fixture.callbackFailed && fixture.cancelled.length === 0,
				true,
				"gateway readiness must reject an invalid catalog and exact cleanup must not retain failed pre-start work",
			);
		},
	},
});

const ac22 = defineLine13KnownGapCase({
	entry: {
		ac: "AC-22",
		fullTestName: "Line 13 AC-22 ships the fake connector for npm and Bun and fails safely on missing assets",
		baseSha: LINE13_T0_BASE_SHA,
		ownerStage: "T10",
		mode: "fails",
		expectedFailure: {
			reason: "package.connector_assets",
			fingerprint: "sha256:0e32fc7c070f94db26791d541f3ebffcdb31da45b390900e0eff16108883eb2a",
		},
	},
	scenario: {
		fixture: () => {
			const directory = mkdtempSync(join(tmpdir(), "aos-line13-ac22-"));
			return {
				directory,
				scriptPath: join(directory, "package-smoke.ts"),
				nodeOutcome: undefined as ProcessOutcome | undefined,
				bunOutcome: undefined as ProcessOutcome | undefined,
				copyAssets: "",
				copyBinaryAssets: "",
				missingCode: "",
			};
		},
		setup: async (fixture) => {
			const packageDirectory = getPackageDir();
			const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
				readonly scripts?: Record<string, unknown>;
			};
			fixture.copyAssets = String(manifest.scripts?.["copy-assets"] ?? "");
			fixture.copyBinaryAssets = String(manifest.scripts?.["copy-binary-assets"] ?? "");
			const sourceIndexUrl = pathToFileURL(fileURLToPath(new URL("../../src/index.ts", import.meta.url))).href;
			writeFileSync(
				fixture.scriptPath,
				`import { createExternalAgentAdapterRegistry, getPackageDir } from ${JSON.stringify(sourceIndexUrl)};\nconst registry = createExternalAgentAdapterRegistry();\nprocess.stdout.write(JSON.stringify({ packageDir: getPackageDir(), adapters: registry.list().length }));\n`,
				"utf8",
			);
			fixture.nodeOutcome = await runProcess(process.execPath, sourceProcessArgs(fixture.scriptPath), {
				cwd: fixture.directory,
				env: sourceProcessEnv(),
			});
			fixture.bunOutcome = await runProcess("bun", [fixture.scriptPath], {
				cwd: fixture.directory,
				env: sourceProcessEnv(),
			});
			const loader = Reflect.get(CodingAgent, "loadPackagedExternalAgentDriver");
			if (typeof loader !== "function") {
				fixture.missingCode = "missing_public_loader";
			} else {
				try {
					await Reflect.apply(loader, undefined, ["line13-missing-connector"]);
				} catch (error) {
					fixture.missingCode =
						typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unsafe_error";
				}
			}
		},
		assertion: (fixture) => {
			strictEqual(
				fixture.nodeOutcome?.exitCode === 0 &&
					fixture.bunOutcome?.exitCode === 0 &&
					fixture.copyAssets.includes("fake-connector") &&
					fixture.copyBinaryAssets.includes("fake-connector") &&
					fixture.missingCode === "external_agent_driver_asset_missing",
				true,
				"npm and Bun packages must ship the fake connector and missing assets must fail with a safe code",
			);
		},
		cleanup: (fixture) => rmSync(fixture.directory, { recursive: true, force: true }),
	},
});

const ac23 = defineLine13KnownGapCase({
	entry: {
		ac: "AC-23",
		fullTestName: "Line 13 AC-23 binds exact trusted driver provenance and a minimal environment",
		baseSha: LINE13_T0_BASE_SHA,
		ownerStage: "T9c",
		mode: "fails",
		expectedFailure: {
			reason: "driver.provenance",
			fingerprint: "sha256:17dca2a5d7c574563d25c3c75cc09989b43f8a16ff1971d09ac7adde6554c58b",
		},
	},
	scenario: {
		fixture: () => ({ trustedLauncher: false, exactSelection: false, safeProjection: false, provenanceBound: false }),
		setup: (fixture) => {
			const profileId = "trusted-driver";
			const supervisor = new WorkerSupervisorV1({
				executable: process.execPath,
				entrypoint: CHILD_ENTRY,
				profileId,
				profileRevision: 1,
				capabilities: ["filesystem.read", "process.spawn"],
				environment: { AOS_DRIVER_PROTOCOL: "line13" },
			});
			const accepted = supervisor.preflight({ binding: workerBinding(profileId), runAccepted: true });
			const unsafe = new WorkerSupervisorV1({
				executable: "node",
				entrypoint: CHILD_ENTRY,
				profileId,
				profileRevision: 1,
				capabilities: ["filesystem.read", "process.spawn"],
				environment: { AOS_DRIVER_TOKEN: "secret" },
			}).preflight({ binding: workerBinding(profileId), runAccepted: true });
			fixture.trustedLauncher =
				accepted.ok &&
				!unsafe.ok &&
				unsafe.error.code === "worker_profile_untrusted" &&
				isAbsolute(process.execPath) &&
				isAbsolute(CHILD_ENTRY) &&
				statSync(CHILD_ENTRY).isFile();

			const adapter: ExternalAgentAdapter = {
				id: "line13-driver",
				async probe() {
					throw new Error("probe is outside this registry regression");
				},
				async prepare() {
					throw new Error("prepare is outside this registry regression");
				},
				async start() {
					throw new Error("start is outside this registry regression");
				},
			};
			const registry = createExternalAgentAdapterRegistry();
			registry.register(adapter, { displayName: "Line 13 driver", version: "1.0.0", targets: ["target-one"] });
			const resolved = registry.resolve({ adapterId: adapter.id, targetId: "target-one" });
			fixture.exactSelection = resolved.adapter === adapter && resolved.selection.adapterId === adapter.id;
			fixture.safeProjection = JSON.stringify(resolved.target) === '{"targetId":"target-one"}';
			const privateResolution = resolved as unknown as Record<string, unknown>;
			const provenance = privateResolution.driverProvenance;
			fixture.provenanceBound =
				typeof provenance === "object" &&
				provenance !== null &&
				isAbsolute(String(Reflect.get(provenance, "executable"))) &&
				isAbsolute(String(Reflect.get(provenance, "entrypoint"))) &&
				typeof Reflect.get(provenance, "sourceVersion") === "string" &&
				typeof Reflect.get(provenance, "fileIdentity") === "string";
		},
		assertion: (fixture) => {
			strictEqual(
				fixture.trustedLauncher && fixture.exactSelection && fixture.safeProjection && fixture.provenanceBound,
				true,
				"exact adapter selection must retain private absolute driver provenance with an allowlisted environment",
			);
		},
	},
});

const ac24 = defineLine13KnownGapCase({
	entry: {
		ac: "AC-24",
		fullTestName: "Line 13 AC-24 applies RuntimeLimits and exposes deterministic terminal resource status",
		baseSha: LINE13_T0_BASE_SHA,
		ownerStage: "T10",
		mode: "fails",
		expectedFailure: {
			reason: "runtime.limits_status",
			fingerprint: "sha256:b0d86b954bcbe1313c2122afcecac188a32a977259ab55b741b1bc025de8cc02",
		},
	},
	scenario: {
		fixture: () => ({ plateau: false, sideEffectUnknownTerminal: false, limitsApplied: false, statusObservable: false }),
		setup: async (fixture) => {
			const clock = new DeterministicClock({ wallTimeMs: Date.parse(NOW) });
			const manager = SessionManager.inMemory("C:/line13/runtime-limits", { id: "session-line13-runtime" });
			const graph = new TaskGraphStore(
				manager,
				{ get: () => undefined },
				{ getByBusinessKey: () => undefined },
				{ now: () => new Date(clock.wallNow()).toISOString() },
			);
			const ledger = new Session(new InMemorySessionStorage({ id: "session-line13-runtime", createdAt: 1 }));
			const queue = new SchedulerQueueStore(
				withRuntimeClock(
					{
						ledger,
						sessionId: "session-line13-runtime",
						ownerId: "line13-runtime-owner",
						now: () => new Date(clock.wallNow()).toISOString(),
					},
					clock,
				),
			);
			const options = {
				enabled: true,
				sessionId: "session-line13-runtime",
				ownerId: "line13-runtime-owner",
				graph,
				queue,
				dispatch: {
					dispatchRunClaimed: async () => Result.err(new FoundationError("scheduler_no_executor", "no work expected")),
				},
				fanIn: {
					settle: async () => Result.err(new FoundationError("scheduler_fanin_invalid", "no work expected")),
				},
				resolveRunAssociation: async () =>
					Result.err(new FoundationError("scheduler_not_found", "no work expected")),
				settleRunAtHost: async () => Result.ok(undefined),
				pollIntervalMs: 50,
				runtimeLimits: {
					maxGraphsPerTick: 2,
					maxNodesPerTick: 2,
					maxConcurrentAttempts: 2,
					maxPendingWriteBytes: 64 * 1024,
				},
			} satisfies SchedulerHostOptions & {
				readonly runtimeLimits: {
					readonly maxGraphsPerTick: number;
					readonly maxNodesPerTick: number;
					readonly maxConcurrentAttempts: number;
					readonly maxPendingWriteBytes: number;
				};
			};
			const host = new SchedulerHost(withRuntimeClock(options, clock));
			host.start();
			let peakResources = 0;
			for (let iteration = 0; iteration < 256; iteration += 1) {
				clock.advanceBy(50);
				await host.tick();
				peakResources = Math.max(peakResources, clock.pendingCount());
			}
			host.stop();
			fixture.plateau = peakResources <= 1 && clock.pendingCount() === 0;
			fixture.sideEffectUnknownTerminal = !isSchedulerSideEffectRetryable("side_effect_unknown");
			const privateHost = host as unknown as Record<string, unknown>;
			fixture.limitsApplied = privateHost.maxConcurrentAttempts === 2 && privateHost.maxGraphsPerTick === 2;
			const status = typeof privateHost.status === "function" ? Reflect.apply(privateHost.status, host, []) : undefined;
			const statusText = status === undefined ? "" : JSON.stringify(status);
			fixture.statusObservable =
				statusText.includes("runtimeLimits") &&
				statusText.includes("side_effect_unknown") &&
				statusText.includes("backoff") &&
				statusText.includes("terminal");
		},
		assertion: (fixture) => {
			strictEqual(
				fixture.plateau &&
					fixture.sideEffectUnknownTerminal &&
					fixture.limitsApplied &&
					fixture.statusObservable,
				true,
				"RuntimeLimits, retry classification, terminal status, and deterministic resource plateau must be observable",
			);
		},
	},
});

export const line13KnownGapCasesAc17Ac24 = defineLine13KnownGapCaseShard({
	schemaVersion: 1,
	shardId: "ac-17-24",
	complete: true,
	cases: [ac18, ac19, ac20, ac21, ac22, ac23, ac24],
	resolvedCases: [ac17],
});
