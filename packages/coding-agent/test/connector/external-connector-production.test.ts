import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	FoundationError,
	Result,
	createConnectorCapabilitySnapshot,
	fingerprintFoundationValue,
	type ConnectorCapabilitySnapshot,
	type ExternalAgentConnector,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import { DurableExternalAgentConnector } from "../../src/core/connector/durable-connector.ts";
import type {
	ExternalConnectorDurableStore,
	ExternalConnectorOperation,
} from "../../src/core/connector/operation.ts";
import { ProductionExternalConnectorProcessController } from "../../src/core/connector/process-controller.ts";
import {
	createProductionExternalAgentConnector,
	createProductionExternalConnectorSupervision,
	getProductionExternalConnectorStartupStatus,
	getProductionExternalConnectorTarget,
} from "../../src/core/connector/production.ts";
import { cloneCanonicalExternalConnectorMapping } from "../../src/core/connector/session-mapping.ts";
import {
	ExternalConnectorBoundedSupervisor,
	FileExternalConnectorSupervisorPrivateStateStore,
	externalConnectorProcessContainment,
} from "../../src/core/connector/supervisor.ts";
import {
	DEFAULT_RUNTIME_LIMITS,
	encodeRuntimeLimitsOperationNonce,
} from "../../src/core/runtime/limits.ts";
import { DeterministicClock } from "../support/deterministic-clock.ts";
import * as CodingAgent from "../../src/index.ts";
import {
	createAgentRuntimeCompositionFactory,
	buildExternalConnectorTargetConfig,
	createExternalConnectorRegistry,
	type AgentRuntimeCompositionContext,
	type ExternalConnectorCapabilityCeiling,
	type ExternalConnectorResolvedTarget,
	type ExternalConnectorTargetDefinition,
} from "../../src/index.ts";
import type { ExternalConnectorVendorDriver } from "../../src/core/connector/vendor/types.ts";

const processOptions = {
	executablePath: process.execPath,
	arguments: ["-e", "setInterval(function(){},2147483647)"],
	trustedProvenance: {
		modulePath: process.execPath,
		cwd: process.cwd(),
		version: process.version,
		executableIdentity: `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`,
		moduleIdentity: `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`,
	},
} as const;

function resolvedProductionTarget(
	capability: ConnectorCapabilitySnapshot,
	overrides: Partial<ExternalConnectorCapabilityCeiling> = {},
): ExternalConnectorResolvedTarget {
	const definition: ExternalConnectorTargetDefinition = {
		schemaVersion: 1,
		targetId: `${capability.providerId}-target`,
		providerId: capability.providerId,
		executablePath: processOptions.executablePath,
		modulePath: processOptions.trustedProvenance.modulePath,
		cwd: processOptions.trustedProvenance.cwd,
		version: processOptions.trustedProvenance.version,
		executableIdentity: processOptions.trustedProvenance.executableIdentity,
		moduleIdentity: processOptions.trustedProvenance.moduleIdentity,
		endpoint: "https://connector.invalid/rpc",
		accountReference: { schemaVersion: 1, namespace: "test", accountId: "production-account" },
		capabilityCeiling: {
			modelAccess: [capability.modelAccess],
			resume: capability.resume,
			toolGateway: capability.toolGateway,
			artifacts: capability.artifacts,
			images: capability.images,
			...overrides,
		},
	};
	const config = buildExternalConnectorTargetConfig({
		managed: { schemaVersion: 1, targets: [definition] },
		explicitTargetId: definition.targetId,
	});
	if (config.selectedTarget === undefined) throw new Error("Expected explicit production target selection");
	return config.selectedTarget;
}

function processIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("production External Connector composition", () => {
	it("wires the host controller and File private-state store instead of injectable test supervision", () => {
		const supervision = createProductionExternalConnectorSupervision({
			privateStatePath: join(tmpdir(), `aos-external-production-${process.pid}.json`),
			process: processOptions,
		});
		expect(supervision.containment).toBe(externalConnectorProcessContainment());
		expect(supervision.processController).toBeInstanceOf(ProductionExternalConnectorProcessController);
		expect(supervision.privateStateStore).toBeInstanceOf(FileExternalConnectorSupervisorPrivateStateStore);
	});

	it("creates the production connector only after its startup recovery sweep", async () => {
		const capability = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: "production-connector",
			revision: 1,
			protocol: { name: "production-protocol", version: "1" },
			modelAccess: "agent_owned",
			resume: false,
			toolGateway: false,
			artifacts: false,
			images: false,
		});
		const connector = await createProductionExternalAgentConnector({
			providerId: "production-connector",
			capability,
			capabilityProbe: async () => Result.ok(capability),
			store: Object.freeze({}) as ExternalConnectorDurableStore,
			driver: Object.freeze({ dispose: async () => undefined }) as unknown as ExternalConnectorVendorDriver,
			privateStatePath: join(tmpdir(), `aos-external-production-factory-${process.pid}.json`),
			process: processOptions,
		});
		expect(connector).toBeInstanceOf(DurableExternalAgentConnector);
		expect(getProductionExternalConnectorStartupStatus(connector)).toEqual({
			schemaVersion: 1,
			trust: "host_configured",
			readiness: "ready",
			recovery: [],
		});
		const registry = createExternalConnectorRegistry();
		const registered = await registry.register({
			descriptor: {
				schemaVersion: 1,
				providerId: capability.providerId,
				providerClass: "external_connector",
				revision: capability.revision,
				capabilitySnapshotDigest: capability.digest,
			},
			connector,
		});
		if (!registered.ok) throw registered.error;
		expect(registered).toMatchObject({ ok: true });
		const composition = createAgentRuntimeCompositionFactory({
			externalConnectorRegistry: () => registry,
		}).create({
			session: Object.freeze({}),
			harness: Object.freeze({}),
			sessionId: "production-external-connector-composition",
			models: Object.freeze({}),
		} as unknown as AgentRuntimeCompositionContext);
		expect(composition.externalConnectorRegistry).toBe(registry);
		expect(composition.externalConnectorRegistry?.list()).toEqual([
			{
				schemaVersion: 1,
				providerId: capability.providerId,
				providerClass: "external_connector",
				revision: capability.revision,
				capabilitySnapshotDigest: capability.digest,
			},
		]);
		await registry.dispose();
	});

	it("binds production creation to an attested target and rejects capability widening before probing", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-external-production-target-"));
		const capability = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: "production-target-connector",
			revision: 1,
			protocol: { name: "production-protocol", version: "1" },
			modelAccess: "agent_owned",
			resume: false,
			toolGateway: false,
			artifacts: false,
			images: false,
		});
		const target = resolvedProductionTarget(capability);
		const connector = await createProductionExternalAgentConnector({
			providerId: capability.providerId,
			capability,
			capabilityProbe: async () => Result.ok(capability),
			store: Object.freeze({}) as ExternalConnectorDurableStore,
			driver: Object.freeze({ dispose: async () => undefined }) as unknown as ExternalConnectorVendorDriver,
			privateStatePath: join(root, "selected.json"),
			target,
		});
		try {
			expect(getProductionExternalConnectorTarget(connector)).toBe(target);
			expect(getProductionExternalConnectorStartupStatus(connector)).toMatchObject({ readiness: "ready" });
		} finally {
			await connector.dispose();
		}

		const widenedCapability = createConnectorCapabilitySnapshot({
			schemaVersion: capability.schemaVersion,
			providerId: capability.providerId,
			revision: capability.revision,
			protocol: capability.protocol,
			modelAccess: capability.modelAccess,
			resume: capability.resume,
			toolGateway: capability.toolGateway,
			artifacts: capability.artifacts,
			images: true,
		});
		const restrictedTarget = resolvedProductionTarget(widenedCapability, { images: false });
		let probeCalls = 0;
		await expect(createProductionExternalAgentConnector({
			providerId: widenedCapability.providerId,
			capability: widenedCapability,
			capabilityProbe: async () => {
				probeCalls += 1;
				return Result.ok(widenedCapability);
			},
			store: Object.freeze({}) as ExternalConnectorDurableStore,
			driver: Object.freeze({ dispose: async () => undefined }) as unknown as ExternalConnectorVendorDriver,
			privateStatePath: join(root, "widened.json"),
			target: restrictedTarget,
		})).rejects.toMatchObject({
			code: "external_connector_config_invalid",
			reason: "capability_widened",
		});
		expect(probeCalls).toBe(0);
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects rebinding one vendor driver to a different trusted process target", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-external-production-driver-binding-"));
		const capability = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: "production-driver-binding-connector",
			revision: 1,
			protocol: { name: "production-protocol", version: "1" },
			modelAccess: "none",
			resume: false,
			toolGateway: false,
			artifacts: false,
			images: false,
		});
		const driver = Object.freeze({ dispose: async () => undefined }) as unknown as ExternalConnectorVendorDriver;
		const connector = await createProductionExternalAgentConnector({
			providerId: capability.providerId,
			capability,
			capabilityProbe: async () => Result.ok(capability),
			store: Object.freeze({}) as ExternalConnectorDurableStore,
			driver,
			privateStatePath: join(root, "first.json"),
			process: processOptions,
		});
		try {
			await expect(createProductionExternalAgentConnector({
				providerId: capability.providerId,
				capability,
				capabilityProbe: async () => Result.ok(capability),
				store: Object.freeze({}) as ExternalConnectorDurableStore,
				driver,
				privateStatePath: join(root, "rebound.json"),
				process: { ...processOptions, arguments: [...processOptions.arguments, "--different-target"] },
			})).rejects.toThrow("vendor driver is already bound to another trusted process target");
		} finally {
			await connector.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps production driver evidence getters outside the package root", () => {
		for (const privateExport of [
			"getProductionExternalConnectorDriverProvenance",
			"getProductionExternalConnectorVendorDriver",
			"getProductionExternalConnectorVendorDriverProcess",
			"getProductionExternalConnectorVendorDriverProvenance",
		]) {
			expect(privateExport in CodingAgent).toBe(false);
		}
	});

	it("retains and exposes quarantined startup recovery through registry readiness", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-external-production-quarantine-"));
		const privateStatePath = join(root, "private", "supervisors.json");
		const attemptId = "attempt-production-quarantine";
		const capability = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: "production-quarantine-connector",
			revision: 1,
			protocol: { name: "production-protocol", version: "1" },
			modelAccess: "agent_owned",
			resume: false,
			toolGateway: false,
			artifacts: false,
			images: false,
		});
		const privateStore = new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath);
		await privateStore.write(attemptId, {
			schemaVersion: 1,
			reference: { schemaVersion: 1, supervisorRef: "quarantine-supervisor", operationNonce: "quarantine-nonce" },
			detached: false,
			containment: externalConnectorProcessContainment(),
			processIdentity: {
				pid: 2_147_483_000,
				startToken: "missing-start",
				executableIdentity: "sha256:missing",
				fileIdentity: "file:missing",
			},
		});
		const connector = await createProductionExternalAgentConnector({
			providerId: capability.providerId,
			capability,
			capabilityProbe: async () => Result.ok(capability),
			store: Object.freeze({
				readOperation: async () => undefined,
				readMapping: async () => undefined,
			}) as unknown as ExternalConnectorDurableStore,
			driver: Object.freeze({ dispose: async () => undefined }) as unknown as ExternalConnectorVendorDriver,
			privateStatePath,
			process: processOptions,
		});
		const registry = createExternalConnectorRegistry();
		try {
			expect(getProductionExternalConnectorStartupStatus(connector)).toEqual({
				schemaVersion: 1,
				trust: "host_configured",
				readiness: "quarantined",
				recovery: [{ attemptId, status: "quarantined" }],
			});
			expect(registry.registerPrepared({
				descriptor: {
					schemaVersion: 1,
					providerId: capability.providerId,
					providerClass: "external_connector",
					revision: capability.revision,
					capabilitySnapshotDigest: capability.digest,
				},
				connector,
			}, capability)).toMatchObject({ ok: true });
			expect(registry.readiness()).toEqual([{
				schemaVersion: 1,
				providerId: capability.providerId,
				trust: "host_configured",
				status: "quarantined",
				reasonCode: "cleanup_unconfirmed",
			}]);
			expect(await registry.select({
				providerId: capability.providerId,
				revision: capability.revision,
				capabilitySnapshotDigest: capability.digest,
			})).toMatchObject({ ok: false });
			expect(await registry.probeReadiness({
				providerId: capability.providerId,
				revision: capability.revision,
				capabilitySnapshotDigest: capability.digest,
			})).toMatchObject({ status: "quarantined", reasonCode: "cleanup_unconfirmed" });
			expect(await registry.select({
				providerId: capability.providerId,
				revision: capability.revision,
				capabilitySnapshotDigest: capability.digest,
			})).toMatchObject({ ok: false });
		} finally {
			await registry.dispose().catch(() => undefined);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("requires bounded active capability evidence before production connector publication", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-external-production-capability-probe-"));
		const capability = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: "production-capability-probe-connector",
			revision: 1,
			protocol: { name: "production-protocol", version: "1" },
			modelAccess: "agent_owned",
			resume: false,
			toolGateway: false,
			artifacts: false,
			images: false,
		});
		const mismatched = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: capability.providerId,
			revision: 2,
			protocol: capability.protocol,
			modelAccess: capability.modelAccess,
			resume: capability.resume,
			toolGateway: capability.toolGateway,
			artifacts: capability.artifacts,
			images: capability.images,
		});
		const base = {
			providerId: capability.providerId,
			capability,
			store: Object.freeze({}) as ExternalConnectorDurableStore,
			driver: Object.freeze({ dispose: async () => undefined }) as unknown as ExternalConnectorVendorDriver,
			process: processOptions,
		};
		try {
			await expect(
				createProductionExternalAgentConnector({
					...base,
					capabilityProbe: undefined,
					privateStatePath: join(root, "missing.json"),
				} as unknown as Parameters<typeof createProductionExternalAgentConnector>[0]),
			).rejects.toThrow("explicit capability probe");

			let invalidLimitProbeCalls = 0;
			await expect(
				createProductionExternalAgentConnector({
					...base,
					capabilityProbe: async () => {
						invalidLimitProbeCalls += 1;
						return Result.ok(capability);
					},
					privateStatePath: join(root, "invalid-limits.json"),
					runtimeLimits: { global: { readinessHardMs: Number.POSITIVE_INFINITY } },
				}),
			).rejects.toThrow("RuntimeLimits");
			expect(invalidLimitProbeCalls).toBe(0);

			const clock = new DeterministicClock();
			const hanging = createProductionExternalAgentConnector({
				...base,
				capabilityProbe: async (options) =>
					new Promise<never>((_resolve, reject) => {
						const abort = (): void => reject(new Error("capability probe aborted"));
						if (options?.signal?.aborted === true) abort();
						else options?.signal?.addEventListener("abort", abort, { once: true });
					}),
				privateStatePath: join(root, "hanging.json"),
				deadlines: { start: { hardMs: 5, idleMs: 50 } },
				clock,
			});
			clock.advanceBy(5);
			await expect(hanging).rejects.toMatchObject({ code: "side_effect_unknown", segment: "start" });

			const runtimeLimitsClock = new DeterministicClock();
			const runtimeLimitsBounded = createProductionExternalAgentConnector({
				...base,
				capabilityProbe: async (options) =>
					new Promise<never>((_resolve, reject) => {
						const abort = (): void => reject(new Error("capability probe aborted"));
						if (options?.signal?.aborted === true) abort();
						else options?.signal?.addEventListener("abort", abort, { once: true });
					}),
				privateStatePath: join(root, "runtime-limits-bounded.json"),
				runtimeLimits: { global: { readinessHardMs: 7, readinessIdleMs: 50 } },
				clock: runtimeLimitsClock,
			});
			runtimeLimitsClock.advanceBy(7);
			await expect(runtimeLimitsBounded).rejects.toMatchObject({ code: "side_effect_unknown", segment: "start" });

			let cleanupStarted = false;
			const cleanupStartedAt = Date.now();
			await expect(createProductionExternalAgentConnector({
				...base,
				capabilityProbe: async () => new Promise<never>(() => undefined),
				driver: Object.freeze({
					dispose: async () => {
						cleanupStarted = true;
						await new Promise<never>(() => undefined);
					},
				}) as unknown as ExternalConnectorVendorDriver,
				privateStatePath: join(root, "non-cooperative.json"),
				deadlines: {
					start: { hardMs: 20, idleMs: 20 },
					dispose: { hardMs: 20, idleMs: 20 },
				},
			})).rejects.toMatchObject({ code: "side_effect_unknown", segment: "start" });
			expect(cleanupStarted).toBe(true);
			expect(Date.now() - cleanupStartedAt).toBeLessThan(250);

			await expect(
				createProductionExternalAgentConnector({
					...base,
					capabilityProbe: async () => Result.err(new FoundationError("provider_spawn_failed", "probe failed")),
					privateStatePath: join(root, "failed.json"),
				}),
			).rejects.toMatchObject({ code: "external_connector_not_ready" });

			await expect(
				createProductionExternalAgentConnector({
					...base,
					capabilityProbe: async () => Result.ok(mismatched),
					privateStatePath: join(root, "mismatched.json"),
				}),
			).rejects.toMatchObject({ code: "external_capability_mismatch" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("propagates the trusted capability probe so explicit readiness detects runtime drift", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-external-production-probe-"));
		const capability = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: "production-probe-connector",
			revision: 1,
			protocol: { name: "production-protocol", version: "1" },
			modelAccess: "agent_owned",
			resume: false,
			toolGateway: false,
			artifacts: false,
			images: false,
		});
		const drifted = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: capability.providerId,
			revision: 2,
			protocol: capability.protocol,
			modelAccess: capability.modelAccess,
			resume: capability.resume,
			toolGateway: capability.toolGateway,
			artifacts: capability.artifacts,
			images: capability.images,
		});
		let drift = false;
		let probeCalls = 0;
		const registry = createExternalConnectorRegistry();
		try {
			const connector = await createProductionExternalAgentConnector({
				providerId: capability.providerId,
				capability,
				capabilityProbe: async () => {
					probeCalls += 1;
					return Result.ok(drift ? drifted : capability);
				},
				store: Object.freeze({}) as ExternalConnectorDurableStore,
				driver: Object.freeze({ dispose: async () => undefined }) as unknown as ExternalConnectorVendorDriver,
				privateStatePath: join(root, "private", "supervisors.json"),
				process: processOptions,
			});
			expect(
				await registry.register({
					descriptor: {
						schemaVersion: 1,
						providerId: capability.providerId,
						providerClass: "external_connector",
						revision: capability.revision,
						capabilitySnapshotDigest: capability.digest,
					},
					connector,
				}),
			).toMatchObject({ ok: true });
			drift = true;

			expect(
				await registry.probeReadiness({
					providerId: capability.providerId,
					revision: capability.revision,
					capabilitySnapshotDigest: capability.digest,
				}),
			).toMatchObject({ status: "not_ready", reasonCode: "probe_failed" });
			expect(probeCalls).toBe(3);
		} finally {
			await registry.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves a reattachable mapped operation during production restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-external-production-resume-"));
		const privateStatePath = join(root, "private", "supervisors.json");
		const targetPidPath = join(root, "target.pid");
		const providerId = "production-resume-connector";
		const attemptId = "attempt-production-resume";
		const operationNonce = "production-resume-nonce";
		const supervisorRef = "production-resume-supervisor";
		const capability = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId,
			revision: 1,
			protocol: { name: "production-protocol", version: "1" },
			modelAccess: "agent_owned",
			resume: true,
			toolGateway: false,
			artifacts: false,
			images: false,
		});
		const bindingDigest = fingerprintFoundationValue("production-resume-binding");
		const operation: ExternalConnectorOperation = {
			schemaVersion: 1,
			providerId,
			attemptId,
			bindingId: "binding-production-resume",
			bindingEpochId: "binding-epoch-production-resume",
			bindingDigest,
			bindingRevision: 1,
			capabilityDigest: capability.digest,
			capabilityRevision: capability.revision,
			operationNonce: encodeRuntimeLimitsOperationNonce(DEFAULT_RUNTIME_LIMITS, operationNonce),
			correlation: {
				sessionId: "session-production-resume",
				laneId: "main",
				revision: 1,
				taskId: "task-production-resume",
				dispatchId: "dispatch-production-resume",
				attemptId,
				bindingId: "binding-production-resume",
				bindingEpochId: "binding-epoch-production-resume",
				providerId,
			},
			status: "running",
			revision: 3,
			updatedAt: "2026-08-27T00:00:00.000Z",
		};
		const mapping = cloneCanonicalExternalConnectorMapping({
			schemaVersion: 1,
			providerId,
			attemptId,
			externalSessionId: "external-session-production-resume",
			binding: { digest: bindingDigest, revision: 1 },
			capability: { digest: capability.digest, revision: capability.revision },
			supervisor: { ref: supervisorRef, nonce: operationNonce },
			createdAt: "2026-08-27T00:00:00.000Z",
		});
		const processConfiguration = {
			...processOptions,
			arguments: [
				"-e",
				"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(function(){},2147483647)",
				targetPidPath,
			],
		} as const;
		const controller = new ProductionExternalConnectorProcessController({ process: processConfiguration });
		const first = new ExternalConnectorBoundedSupervisor({
			reference: { schemaVersion: 1, supervisorRef, operationNonce },
			containment: externalConnectorProcessContainment(),
			processController: controller,
			artifactsAllowed: false,
			deadlines: { dispose: { hardMs: 10_000, idleMs: 10_000 } },
		});
		const privateStore = new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath);
		let connector: ExternalAgentConnector | undefined;
		try {
			await first.launch((state) => privateStore.write(attemptId, state));
			await expect.poll(() => existsSync(targetPidPath)).toBe(true);
			const targetPid = Number(readFileSync(targetPidPath, "utf8"));
			const store = Object.freeze({
				readOperation: async (candidateAttemptId: string) =>
					candidateAttemptId === attemptId ? operation : undefined,
				readMapping: async (candidateAttemptId: string) => (candidateAttemptId === attemptId ? mapping : undefined),
			}) as unknown as ExternalConnectorDurableStore;
			const created = await createProductionExternalAgentConnector({
				providerId,
				capability,
				capabilityProbe: async () => Result.ok(capability),
				store,
				driver: Object.freeze({ dispose: async () => undefined }) as unknown as ExternalConnectorVendorDriver,
				privateStatePath,
				process: processConfiguration,
			});
			connector = created;

			expect(processIsLive(targetPid)).toBe(true);
			expect(getProductionExternalConnectorStartupStatus(created)).toEqual({
				schemaVersion: 1,
				trust: "host_configured",
				readiness: "ready",
				recovery: [{ attemptId, status: "reattached" }],
			});
			expect(await privateStore.list()).toHaveLength(1);
			await created.dispose();
			connector = undefined;
			await expect.poll(() => processIsLive(targetPid), { timeout: 10_000 }).toBe(false);
			expect(await privateStore.list()).toEqual([]);
		} finally {
			await connector?.dispose().catch(() => undefined);
			await first.dispose().catch(() => undefined);
			if ((await privateStore.list().catch(() => [{ attemptId }])).length === 0) {
				rmSync(root, { recursive: true, force: true });
			}
		}
	}, 30_000);

	// The Windows test worker is already in a kill-on-close Job, so it cannot leave a nested guardian orphan.
	it.skipIf(process.platform === "win32")(
		"exact-reaps an orphan after a real Host hard crash and separate production restart",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "aos-external-production-hard-crash-"));
			const privateStatePath = join(root, "private", "supervisors.json");
			const targetPidPath = join(root, "target.pid");
			const readyPath = join(root, "ready.json");
			const fixturePath = join(import.meta.dirname, "fixtures", "external-connector-hard-crash-host.ts");
			const tsxPath = join(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs");
			const hardCrashCapability = createConnectorCapabilitySnapshot({
				schemaVersion: 1,
				providerId: "production-hard-crash-connector",
				revision: 1,
				protocol: { name: "production-protocol", version: "1" },
				modelAccess: "agent_owned",
				resume: true,
				toolGateway: false,
				artifacts: false,
				images: false,
			});
			const recover = async (): Promise<void> => {
				await createProductionExternalAgentConnector({
					providerId: "production-hard-crash-connector",
					capability: hardCrashCapability,
					capabilityProbe: async () => Result.ok(hardCrashCapability),
					store: Object.freeze({
						readOperation: async () => undefined,
						readMapping: async () => undefined,
					}) as unknown as ExternalConnectorDurableStore,
					driver: Object.freeze({}) as ExternalConnectorVendorDriver,
					privateStatePath,
					process: {
						executablePath: process.execPath,
						arguments: [
							"-e",
							"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(function(){},2147483647)",
							targetPidPath,
						],
						trustedProvenance: processOptions.trustedProvenance,
					},
				});
			};
			const host = spawn(process.execPath, [tsxPath, fixturePath, privateStatePath, targetPidPath, readyPath], {
				shell: false,
				stdio: "ignore",
				windowsHide: true,
			});
			try {
				await expect.poll(() => existsSync(readyPath), { timeout: 20_000 }).toBe(true);
				await new Promise<void>((resolve, reject) => {
					if (host.exitCode !== null || host.signalCode !== null) return resolve();
					const timer = setTimeout(() => reject(new Error("hard-crash Host did not exit")), 10_000);
					timer.unref();
					host.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
				});
				const ready = JSON.parse(readFileSync(readyPath, "utf8")) as { guardianPid: number; targetPid: number };
				expect(processIsLive(ready.guardianPid)).toBe(true);
				expect(processIsLive(ready.targetPid)).toBe(true);

				await recover();

				await expect.poll(() => processIsLive(ready.guardianPid), { timeout: 10_000 }).toBe(false);
				await expect.poll(() => processIsLive(ready.targetPid), { timeout: 10_000 }).toBe(false);
				expect(await new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath).list()).toEqual([]);
			} finally {
				if (host.exitCode === null && host.signalCode === null) {
					host.kill("SIGKILL");
					await new Promise<void>((resolve) => host.once("exit", () => resolve()));
				}
				let cleanupConfirmed = !existsSync(privateStatePath);
				if (!cleanupConfirmed) {
					await recover().catch(() => undefined);
					cleanupConfirmed = await new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath)
						.list()
						.then(
							(entries) => entries.length === 0,
							() => false,
						);
				}
				if (cleanupConfirmed) rmSync(root, { recursive: true, force: true });
			}
		},
		45_000,
	);
});
