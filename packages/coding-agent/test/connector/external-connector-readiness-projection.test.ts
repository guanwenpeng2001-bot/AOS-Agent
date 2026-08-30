import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnectorCapabilitySnapshot, Result } from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/policy/auth-storage.ts";
import type { ExternalConnectorDurableStore } from "../../src/core/connector/operation.ts";
import { createExternalConnectorRegistry } from "../../src/core/connector/registry.ts";
import { createProductionExternalAgentConnector } from "../../src/core/connector/production.ts";
import {
	externalConnectorProcessContainment,
	FileExternalConnectorSupervisorPrivateStateStore,
} from "../../src/core/connector/supervisor.ts";
import type { ExternalConnectorVendorDriver } from "../../src/core/connector/vendor/types.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentRuntimeCompositionFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SettingsManager,
} from "../../src/index.ts";
import { createRpcHostController } from "../../src/modes/rpc/rpc-host.ts";

describe("RPC initialize external connector readiness projection", () => {
	it("projects public readiness details without effects or private connector values", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-readiness-projection-"));
		const privateStatePath = join(root, "private", "supervisors.json");
		const providerId = "third-party.readiness-connector";
		const privateSupervisorRef = "private-supervisor-reference";
		const privateOperationNonce = "private-operation-nonce";
		const snapshot = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId,
			revision: 1,
			protocol: { name: "readiness-protocol", version: "1" },
			modelAccess: "none",
			resume: false,
			toolGateway: false,
			artifacts: false,
			images: false,
		});
		const effects = { probe: 0, spawn: 0, network: 0, account: 0, task: 0, tool: 0 };
		let controller: ReturnType<typeof createRpcHostController> | undefined;

		try {
			await new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath).write("readiness-quarantine", {
				schemaVersion: 1,
				reference: {
					schemaVersion: 1,
					supervisorRef: privateSupervisorRef,
					operationNonce: privateOperationNonce,
				},
				detached: false,
				containment: externalConnectorProcessContainment(),
				processIdentity: {
					pid: 2_147_483_000,
					startToken: "missing",
					executableIdentity: "sha256:missing",
					fileIdentity: "file:missing",
				},
			});
			const executableDigest = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
			const connector = await createProductionExternalAgentConnector({
				providerId,
				capability: snapshot,
				capabilityProbe: async () => {
					effects.probe += 1;
					effects.network += 1;
					return Result.ok(snapshot);
				},
				store: Object.freeze({
					readOperation: async () => {
						effects.task += 1;
						return undefined;
					},
					readMapping: async () => {
						effects.task += 1;
						return undefined;
					},
				}) as unknown as ExternalConnectorDurableStore,
				driver: Object.freeze({
					spawn: async () => {
						effects.spawn += 1;
						effects.account += 1;
						throw new Error("Passive readiness projection spawned a driver");
					},
					write: async () => {
						effects.tool += 1;
					},
					dispose: async () => undefined,
				}) as unknown as ExternalConnectorVendorDriver,
				privateStatePath,
				process: {
					executablePath: process.execPath,
					arguments: ["-e", "setInterval(function(){},2147483647)"],
					trustedProvenance: {
						modulePath: process.execPath,
						cwd: root,
						version: process.version,
						executableIdentity: `sha256:${executableDigest}`,
						moduleIdentity: `sha256:${executableDigest}`,
					},
				},
			});
			const expectedDescriptor = {
				schemaVersion: 1 as const,
				providerId,
				providerClass: "external_connector" as const,
				revision: snapshot.revision,
				capabilitySnapshotDigest: snapshot.digest,
			};
			const registry = createExternalConnectorRegistry();
			const registered = registry.registerPrepared({ descriptor: expectedDescriptor, connector }, snapshot);
			if (!registered.ok) throw registered.error;
			const runtimeComposition = createAgentRuntimeCompositionFactory({
				externalConnectorRegistry: () => registry,
			});
			const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
			const settingsManager = SettingsManager.inMemory();
			const services = await createAgentSessionServices({
				cwd: root,
				agentDir: root,
				modelRuntime,
				settingsManager,
				runtimeComposition,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
				const created = await createAgentSessionFromServices({
					services,
					sessionManager: runtimeOptions.sessionManager,
					sessionStartEvent: runtimeOptions.sessionStartEvent,
					noTools: "all",
				});
				runtimeOptions.registerCandidateSession(created.session);
				return { ...created, services, diagnostics: services.diagnostics };
			};
			const runtime = await createAgentSessionRuntime(createRuntime, {
				cwd: root,
				agentDir: root,
				session: { mode: "memory", id: "readiness-projection-rpc" },
			});
			controller = createRpcHostController(runtime);
			await controller.start();
			const before = { ...effects };
			const expectedReadiness = [
				{
					schemaVersion: 1,
					providerId,
					trust: "host_configured",
					status: "quarantined",
					reasonCode: "cleanup_unconfirmed",
				},
			];

			const first = await controller.dispatch({ id: "readiness-first", type: "initialize", protocolVersion: 1 });
			if (first === undefined || first.command !== "initialize" || !first.success) {
				throw new Error("Product RPC did not return its initialize readiness projection");
			}
			expect(first.data.externalConnectors).toEqual([expectedDescriptor]);
			expect(first.data.externalConnectorReadiness).toEqual(expectedReadiness);
			expect(first.data.externalConnectorRuntimeStatus).toEqual([
				expect.objectContaining({
					schemaVersion: 1,
					providerId,
					availability: "unavailable",
					reasonCode: "status_source_missing",
					readiness: expect.objectContaining({
						state: "quarantined",
						reasonCode: "cleanup_unconfirmed",
					}),
				}),
			]);
			expect(effects).toEqual(before);

			const second = await controller.dispatch({ id: "readiness-second", type: "initialize", protocolVersion: 1 });
			if (second === undefined || second.command !== "initialize" || !second.success) {
				throw new Error("Product RPC did not repeat its passive readiness projection");
			}
			expect(second.data.externalConnectors).toEqual([expectedDescriptor]);
			expect(second.data.externalConnectorReadiness).toEqual(expectedReadiness);
			expect(second.data.externalConnectorRuntimeStatus).toEqual([
				expect.objectContaining({
					schemaVersion: 1,
					providerId,
					availability: "unavailable",
					reasonCode: "status_source_missing",
					readiness: expect.objectContaining({
						state: "quarantined",
						reasonCode: "cleanup_unconfirmed",
					}),
				}),
			]);
			expect(effects).toEqual(before);

			const publicProjection = JSON.stringify({
				descriptors: second.data.externalConnectors,
				readiness: second.data.externalConnectorReadiness,
				runtimeStatus: second.data.externalConnectorRuntimeStatus,
			});
			for (const privateValue of [
				root,
				privateStatePath,
				process.execPath,
				privateOperationNonce,
				privateSupervisorRef,
			]) {
				expect(publicProjection).not.toContain(privateValue);
			}
		} finally {
			await controller?.shutdown().catch(() => undefined);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
