import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentCanonicalSession } from "../../src/core/session/facade.ts";
import { AuthStorage } from "../../src/core/policy/auth-storage.ts";
import { LocalCredentialVault } from "../../src/core/policy/credential-vault.ts";
import { createTaskCredentialLocalVaultProvider } from "../../src/core/policy/task-credential-provider.ts";
import { ExternalConnectorModelGateway } from "../../src/core/connector/model-gateway.ts";
import { packagedExternalAgentDriverProcessModulePath } from "../../src/core/connector/packaged-driver.ts";
import { createPackagedExternalConnectorRegistryFactory } from "../../src/core/connector/packaged-runtime.ts";
import { preflightExternalConnectorProductRecovery } from "../../src/core/connector/product-run.ts";
import type { PrivateExternalConnectorVendorAdapterOverrides } from "../../src/core/connector/vendor/composition.ts";
import type { PrivateExternalConnectorVendorDriver } from "../../src/core/connector/vendor/identity.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentRuntimeCompositionFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SettingsManager,
} from "../../src/index.ts";
import type { ExternalConnectorTargetDefinition } from "../../src/external-connector.ts";
import { createRpcHostController } from "../../src/modes/rpc/rpc-host.ts";
import type { RpcHostOutputRecord } from "../../src/modes/rpc/rpc-host.ts";
import { crossLayerTargetDefinition } from "./fixtures/cross-layer.ts";
import {
	vendorAdapterFixture,
	type VendorAdapterFixtureCaptures,
} from "./fixtures/vendor-composition.ts";
import { externalCredentialPolicySettings } from "./fixtures/cross-layer.ts";

const directories: string[] = [];
const DEFAULT_MODEL: Model<"anthropic-messages"> = {
	id: "product-entry-model",
	name: "Product Entry Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function identity(path: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function packagedSettings(cwd: string): SettingsManager {
	const modulePath = packagedExternalAgentDriverProcessModulePath("fake-connector");
	return SettingsManager.inMemory({
		externalConnectors: {
			schemaVersion: 1,
			targetId: "packaged-fake",
			targets: [
				{
					schemaVersion: 1,
					targetId: "packaged-fake",
					providerId: "aos.fake-connector",
					executablePath: process.execPath,
					modulePath,
					cwd,
					version: "1",
					executableIdentity: identity(process.execPath),
					moduleIdentity: identity(modulePath),
					capabilityCeiling: {
						modelAccess: ["none"],
						resume: true,
						toolGateway: false,
						artifacts: false,
						images: false,
					},
				},
			],
		},
	});
}

function genericSettings(
	cwd: string,
	overrides: Partial<ExternalConnectorTargetDefinition> = {},
): SettingsManager {
	const target = {
		...crossLayerTargetDefinition(cwd, {
			targetId: "settings-generic-jsonl",
			providerId: "fixture.external-jsonl",
		}),
		...overrides,
	};
	return SettingsManager.inMemory({
		externalConnectors: {
			schemaVersion: 1,
			targetId: target.targetId,
			targets: [target],
		},
	});
}

async function createServices(
	cwd: string,
	settingsManager: SettingsManager,
	runtimeComposition?: ReturnType<typeof createAgentRuntimeCompositionFactory>,
	taskCredentialProviderAvailability?: { readonly available: boolean; readonly declaresDelivery: boolean },
	modelRuntime?: ModelRuntime,
) {
	return createAgentSessionServices({
		cwd,
		agentDir: cwd,
		settingsManager,
		modelRuntime: modelRuntime ?? await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null }),
		...(runtimeComposition === undefined ? {} : { runtimeComposition }),
		...(taskCredentialProviderAvailability === undefined ? {} : { taskCredentialProviderAvailability }),
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
}

async function createRuntime(
	cwd: string,
	settingsManager: SettingsManager,
	vendorAdapters?: PrivateExternalConnectorVendorAdapterOverrides,
	captures?: VendorAdapterFixtureCaptures,
) {
	let runtimeComposition: ReturnType<typeof createAgentRuntimeCompositionFactory> | undefined;
	let taskCredentialProviderAvailability: { readonly available: boolean; readonly declaresDelivery: boolean } | undefined;
	let modelRuntime: ModelRuntime | undefined;
	if (vendorAdapters !== undefined) {
		const targetConfig = settingsManager.getExternalConnectorTargetSettings();
		const target = targetConfig?.selectedTarget;
		if (targetConfig === undefined || target === undefined) throw new Error("Vendor target fixture is not selected");
		const externalConnectorRegistry = await createPackagedExternalConnectorRegistryFactory({
			target,
			agentDir: cwd,
			vendorAdapters,
		});
		const gateway = target.capabilityCeiling.modelAccess[0] === "aos_gateway";
		const gatewayResources = gateway ? await gatewayRuntime(cwd, target.targetId, captures) : undefined;
		runtimeComposition = createAgentRuntimeCompositionFactory({
			toolGatewayCatalog: () => ({
				gatewayId: `settings-vendor:${target.targetId}`,
				builtinLocalProviders: [],
				mcpProviders: [],
				sandboxProviders: [],
			}),
			externalConnectorTargetConfig: targetConfig,
			...(externalConnectorRegistry === undefined ? {} : { externalConnectorRegistry }),
			...(gatewayResources === undefined
				? {}
				: {
					externalConnectorCredentialIssueContext: () => (attempt, binding, correlation, modelProjection) => ({
						taskId: attempt.taskId,
						graphRevision: 1,
						nodeId: attempt.taskId,
						runId: correlation?.runId ?? attempt.attemptId,
						capabilityBindingId: binding.capabilityRevision.id,
						policyBindingId: binding.policyRevision.id,
						scopes: [{
							credentialName: modelProjection?.provider ?? binding.modelRoute.provider,
							purpose: "model_inference",
							operations: ["read"],
							targetKinds: ["external_connector"],
						}],
						requestedTtlMs: 30_000,
						clientRequestId: `gateway:${attempt.attemptId}`,
						nodeAttached: true,
					}),
					externalConnectorModelGateway: () => gatewayResources.gateway,
					taskCredentialProvider: () => gatewayResources.provider,
					taskCredentialPolicyMaxTtlMs: 30_000,
				}),
		});
		if (gateway) {
			taskCredentialProviderAvailability = { available: true, declaresDelivery: true };
			modelRuntime = gatewayResources!.runtime;
		}
	}
	void captures;
	const services = await createServices(
		cwd,
		settingsManager,
		runtimeComposition,
		taskCredentialProviderAvailability,
		modelRuntime,
	);
	const factory: CreateAgentSessionRuntimeFactory = async (options) => {
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			model: DEFAULT_MODEL,
		});
		options.registerCandidateSession(created.session);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	return createAgentSessionRuntime(factory, {
		cwd,
		agentDir: cwd,
		session: { mode: "memory", id: `product-entry-${directories.length}` },
	});
}

async function gatewayRuntime(cwd: string, targetId: string, captures?: VendorAdapterFixtureCaptures) {
	const credentials = AuthStorage.create(join(cwd, "auth.json"));
	await credentials.modify("amazon-bedrock", async () => ({ type: "api_key", key: "gateway-bedrock-canary" }));
	await credentials.modify("openai", async () => ({ type: "api_key", key: "gateway-openai-canary" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	for (const providerId of ["amazon-bedrock", "openai"] as const) {
		const gatewayModel: Model<Api> = {
			...DEFAULT_MODEL,
			id: "gateway-model",
			provider: providerId,
			api: providerId === "amazon-bedrock" ? "bedrock-converse-stream" : "openai-responses",
		};
		const provider: Provider = {
			id: providerId,
			name: providerId,
			auth: {},
			getModels: () => [gatewayModel],
			stream: () => { throw new Error("gateway fixture does not stream locally"); },
			streamSimple: () => { throw new Error("gateway fixture does not stream locally"); },
		};
		runtime.registerNativeProvider(provider);
	}
	const vault = new LocalCredentialVault({ authPath: join(cwd, "auth.json") });
	const gateway = new ExternalConnectorModelGateway({ targetId, runtime, vault });
	if (captures !== undefined) captures.modelGateway = gateway;
	const provider = createTaskCredentialLocalVaultProvider({ vault, target: gateway });
	const recordingProvider = {
		issuer: {
			issue: (request: Parameters<typeof provider.issuer.issue>[0]) => {
				captures?.credentialEvents?.push("issue");
				try {
					return provider.issuer.issue(request);
				} catch (error) {
					captures?.credentialEvents?.push(`issue-error:${error instanceof Error ? error.message : String(error)}`);
					throw error;
				}
			},
			renew: provider.issuer.renew,
			revoke: provider.issuer.revoke,
		},
		target: {
			getCapabilities: (request: Parameters<typeof provider.target.getCapabilities>[0]) => {
				captures?.credentialEvents?.push("capabilities");
				return provider.target.getCapabilities(request);
			},
			project: (request: Parameters<typeof provider.target.project>[0]) => {
				captures?.credentialEvents?.push("project");
				return provider.target.project(request);
			},
			renew: provider.target.renew,
			revoke: provider.target.revoke,
		},
	};
	return {
		runtime,
		gateway,
		provider: recordingProvider,
	};
}

function vendorSettings(
	cwd: string,
	driver: PrivateExternalConnectorVendorDriver,
	modelAccess: "agent_owned" | "none" | "aos_gateway",
	overrides: Partial<ExternalConnectorTargetDefinition> = {},
): SettingsManager {
	const modulePath = packagedExternalAgentDriverProcessModulePath("fake-connector");
	const version = driver === "claude" ? "0.3.246" : driver === "codex" ? "0.149.0" : "1.4.0";
	const target = {
		schemaVersion: 1 as const,
		targetId: `${driver}-${modelAccess}`,
		providerId: `fixture.${driver}.${modelAccess}`,
		driver,
		executablePath: process.execPath,
		modulePath,
		cwd,
		version,
		executableIdentity: identity(process.execPath),
		moduleIdentity: identity(modulePath),
		capabilityCeiling: {
			modelAccess: [modelAccess],
			resume: driver !== "claude",
			toolGateway: true,
			artifacts: false,
			images: false,
		},
		...(modelAccess === "aos_gateway"
			? { accountReference: { schemaVersion: 1 as const, namespace: "aos", accountId: "model-runtime" } }
			: {}),
		...overrides,
	};
	return SettingsManager.inMemory({
		...(modelAccess === "aos_gateway"
			? { executionPolicy: externalCredentialPolicySettings(["amazon-bedrock", "openai"]) }
			: {}),
		externalConnectors: {
			schemaVersion: 1,
			targetId: target.targetId,
			targets: [target],
		},
	});
}

describe("External Connector product entry composition", () => {
	it("awaits settings-vendor startup recovery before registry readiness", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-recovery-"));
		directories.push(cwd);
		const captures: VendorAdapterFixtureCaptures = {};
		const adapters = vendorAdapterFixture("codex", cwd, captures);
		const supervision = captures.supervision;
		if (supervision === undefined) throw new Error("Vendor supervision fixture is missing");
		const reference = {
			schemaVersion: 1 as const,
			supervisorRef: "settings-recovery-supervisor",
			operationNonce: "settings-recovery-nonce",
		};
		const handle = await supervision.processController.launch({
			...reference,
			detached: false,
			containment: supervision.options.containment,
		});
		await handle.activate();
		await supervision.privateStateStore.write("settings-recovery-attempt", {
			schemaVersion: 1,
			reference,
			detached: false,
			containment: supervision.options.containment,
			processIdentity: handle.identity,
		});
		supervision.processController.launchCalls = 0;

		const runtime = await createRuntime(cwd, vendorSettings(cwd, "codex", "agent_owned"), adapters, captures);
		const controller = createRpcHostController(runtime);
		await controller.start();
		try {
			await runtime.session.whenCapabilitiesReady();
			expect(supervision.processController.launchCalls).toBe(0);
			expect(supervision.processController.forceCalls).toBe(1);
			expect(await supervision.privateStateStore.read("settings-recovery-attempt")).toBeUndefined();
			expect(runtime.runtimeComposition.externalConnectorRegistry?.readiness()).toMatchObject([
				{ providerId: "fixture.codex.agent_owned", status: "ready" },
			]);
		} finally {
			await controller.shutdown();
		}
	});

	it("keeps settings-vendor readiness unavailable when startup recovery cannot enumerate state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-recovery-failure-"));
		directories.push(cwd);
		const captures: VendorAdapterFixtureCaptures = {};
		const adapters = vendorAdapterFixture("codex", cwd, captures);
		const supervision = captures.supervision;
		if (supervision === undefined) throw new Error("Vendor supervision fixture is missing");
		supervision.privateStateStore.failLists = 1;

		await expect(
			createRuntime(cwd, vendorSettings(cwd, "codex", "agent_owned"), adapters, captures),
		).rejects.toThrow("list failure");
		expect(supervision.processController.forceCalls).toBe(0);
	});

	it.each(["claude", "codex", "acp"] as const)("constructs the stock %s adapter without launching it", async (driver) => {
		const cwd = mkdtempSync(join(tmpdir(), `aos-product-entry-stock-${driver}-`));
		directories.push(cwd);
		const adapters = driver === "claude" ? vendorAdapterFixture(driver, cwd) : undefined;
		const runtime = await createRuntime(cwd, vendorSettings(cwd, driver, "agent_owned"), adapters);
		const controller = createRpcHostController(runtime);
		await controller.start();
		try {
			const initialized = await controller.dispatch({
				id: `stock-${driver}`,
				type: "initialize",
				protocolVersion: 1,
			});
			expect(initialized).toMatchObject({
				success: true,
				data: { externalConnectors: [{ providerId: `fixture.${driver}.agent_owned` }] },
			});
		} finally {
			await controller.shutdown();
		}
	});

	it.each([
		{ driver: "claude", resume: false, toolGateway: true },
		{ driver: "codex", resume: true, toolGateway: true },
		{ driver: "acp", resume: true, toolGateway: true },
	] as const)("maps $driver settings into the exact registry capability contract", async ({ driver, resume, toolGateway }) => {
		const cwd = mkdtempSync(join(tmpdir(), `aos-product-entry-capability-${driver}-`));
		directories.push(cwd);
		const runtime = await createRuntime(
			cwd,
			vendorSettings(cwd, driver, "agent_owned"),
			vendorAdapterFixture(driver, cwd),
		);
		try {
			const registry = runtime.runtimeComposition.externalConnectorRegistry;
			const descriptor = registry?.list()[0];
			if (registry === undefined || descriptor === undefined) throw new Error(`${driver} registry is unavailable`);
			const selected = await registry.select({
				providerId: descriptor.providerId,
				revision: descriptor.revision,
				capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
			});
			if (!selected.ok) throw selected.error;
			expect(selected.value.capabilitySnapshot).toMatchObject({
				providerId: `fixture.${driver}.agent_owned`,
				modelAccess: "agent_owned",
				resume,
				toolGateway,
				artifacts: false,
				images: false,
			});
		} finally {
			await runtime.dispose();
		}
	});

	it("reports an actionable missing Claude companion through the package-root service path", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-claude-companion-missing-"));
		directories.push(cwd);
		await expect(createServices(cwd, vendorSettings(cwd, "claude", "agent_owned"))).rejects.toThrow(
			"Install @anthropic-ai/claude-agent-sdk@0.3.246 and use the packaged aos entry",
		);
	});

	it.each([
		["claude", "agent_owned"],
		["claude", "none"],
		["codex", "agent_owned"],
		["codex", "none"],
		["acp", "agent_owned"],
		["acp", "none"],
	] as const)("runs a settings-selected %s %s vendor through registration and durable receipt", async (driver, modelAccess) => {
		const cwd = mkdtempSync(join(tmpdir(), `aos-product-entry-${driver}-`));
		directories.push(cwd);
		const settings = vendorSettings(cwd, driver, modelAccess);
		const runtime = await createRuntime(cwd, settings, vendorAdapterFixture(driver, cwd));
		const records: RpcHostOutputRecord[] = [];
		const controller = createRpcHostController(runtime, { output: { publish: (record) => records.push(record) } });
		await controller.start();
		try {
			const initialized = await controller.dispatch({
				id: `${driver}-init`,
				type: "initialize",
				protocolVersion: 1,
			});
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error(`${driver} settings entry did not initialize`);
			}
			const descriptor = initialized.data.externalConnectors?.[0];
			if (descriptor === undefined) throw new Error(`${driver} descriptor is missing`);
			await controller.handleCommand({
				id: `${driver}-start`,
				type: "run.start",
				message: `execute the ${driver} settings connector`,
				externalConnector: {
					providerId: descriptor.providerId,
					revision: descriptor.revision,
					capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
				},
			});
			await vi.waitFor(() =>
				expect(records.some((record) => record.type === "run.completed")).toBe(true),
				{ timeout: 60_000 },
			);
			const session = getAgentCanonicalSession(runtime.session);
			const receipts = await session.findFoundationRecords({ objectType: "attempt_receipt" });
			expect(receipts).toHaveLength(1);
			expect(receipts[0]).toMatchObject({
				payload: {
					providerId: `fixture.${driver}.${modelAccess}`,
					status: "succeeded",
					provenance: { producerKind: "external_connector" },
				},
			});
		} finally {
			await controller.shutdown();
		}
	}, 90_000);

	it.each(["claude", "codex"] as const)("runs a settings-selected %s aos_gateway with a leased canonical model", async (driver) => {
		const cwd = mkdtempSync(join(tmpdir(), `aos-product-entry-${driver}-gateway-`));
		directories.push(cwd);
		const settings = vendorSettings(cwd, driver, "aos_gateway");
		const captures: VendorAdapterFixtureCaptures = {};
		captures.credentialEvents = [];
		const runtime = await createRuntime(cwd, settings, vendorAdapterFixture(driver, cwd, captures), captures);
		const records: RpcHostOutputRecord[] = [];
		const controller = createRpcHostController(runtime, { output: { publish: (record) => records.push(record) } });
		await controller.start();
		try {
			const initialized = await controller.dispatch({ id: `${driver}-gateway-init`, type: "initialize", protocolVersion: 1 });
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error(`${driver} gateway settings entry did not initialize`);
			}
			const descriptor = initialized.data.externalConnectors?.[0];
			if (descriptor === undefined) throw new Error(`${driver} gateway descriptor is missing`);
			await controller.handleCommand({
				id: `${driver}-gateway-start`,
				type: "run.start",
				message: `execute the ${driver} gateway connector`,
				externalConnector: {
					providerId: descriptor.providerId,
					revision: descriptor.revision,
					capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
				},
				modelRoute: [{
					provider: driver === "claude" ? "amazon-bedrock" : "openai",
					modelId: "gateway-model",
					thinkingLevel: "high",
					serviceTier: driver === "claude" ? "none" : "priority",
				}],
			});
			await vi.waitFor(() => expect(records.some((record) =>
				record.type === "response" && record.id === `${driver}-gateway-start`)).toBe(true));
			const startResponse = records.find((record) =>
				record.type === "response" && record.id === `${driver}-gateway-start`);
			if (startResponse?.type !== "response" || !startResponse.success) {
				throw new Error(`Gateway start failed: ${JSON.stringify(records)}`);
			}
			try {
				await vi.waitFor(() => expect(records.some((record) =>
					record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled")).toBe(true), { timeout: 60_000 });
			} catch {
				const session = getAgentCanonicalSession(runtime.session);
				const operations = await session.findFoundationRecords({ objectType: "external_connector_operation" });
				const credentials = runtime.session.sessionRead.getEntries().filter((entry) =>
					entry.type === "custom" && entry.customType === "task.credential");
				throw new Error(`Gateway run did not settle: ${JSON.stringify({ records, operations, credentials, credentialEvents: captures.credentialEvents })}`);
			}
			const terminal = records.find((record) =>
				record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled");
			if (terminal?.type !== "run.completed") throw new Error(`Gateway run failed: ${JSON.stringify(records)}`);
			const accepted = records.find((record) =>
				record.type === "response" && record.id === `${driver}-gateway-start`);
			if (accepted?.type !== "response" || accepted.command !== "run.start" || !accepted.success) {
				throw new Error(`${driver} gateway run was not accepted`);
			}
			expect(accepted.data.projectedModel).toMatchObject({
				provider: driver === "claude" ? "amazon-bedrock" : "openai",
				model: "gateway-model",
				modelBindingDigest: { algorithm: "sha256" },
			});
			const session = getAgentCanonicalSession(runtime.session);
			const receipts = await session.findFoundationRecords({ objectType: "attempt_receipt" });
			const bindings = await session.findFoundationRecords({ objectType: "agent_binding" });
			expect(receipts).toHaveLength(1);
			expect(bindings).toHaveLength(1);
			const bindingRecord = bindings[0];
			if (bindingRecord?.kind !== "fact") throw new Error("Gateway AgentBinding fact is missing");
			expect(receipts[0]).toMatchObject({
				payload: {
					status: "succeeded",
					effectiveModel: {
						provider: driver === "claude" ? "amazon-bedrock" : "openai",
						model: "gateway-model",
						bindingDigest: accepted.data.projectedModel?.modelBindingDigest,
					},
				},
			});
			expect((bindingRecord.payload as { fingerprint: { value: string } }).fingerprint.value)
				.not.toBe(accepted.data.projectedModel?.modelBindingDigest.value);
			const credential = driver === "claude" ? captures.claudeQuery?.credential : captures.codexTransport?.credential;
			expect(credential).toMatchObject({ schemaVersion: 1, scopeDigest: expect.stringMatching(/^sha256:/) });
			expect(JSON.stringify(credential)).not.toContain("gateway-bedrock-canary");
			expect(JSON.stringify(credential)).not.toContain("gateway-openai-canary");
			const grants = runtime.session.getTaskCredentialService()?.getByRunId(accepted.data.runId) ?? [];
			expect(grants).toHaveLength(1);
			expect(grants[0]?.status).toBe("settled");
			if (driver === "codex") {
				const registry = runtime.runtimeComposition.externalConnectorRegistry;
				const modelBindingDigest = accepted.data.projectedModel?.modelBindingDigest;
				if (registry === undefined || modelBindingDigest === undefined) {
					throw new Error("Codex recovery projection authority is missing");
				}
				const recovery = {
					session,
					registry,
					runId: accepted.data.runId,
					providerId: descriptor.providerId,
					selection: {
						providerId: descriptor.providerId,
						revision: descriptor.revision,
						capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
					},
					expectedCanonicalInput: {
						schemaVersion: 1 as const,
						text: "execute the codex gateway connector",
						artifacts: [],
					},
					expectedGatewayModelRoute: {
						provider: "openai",
						model: "gateway-model",
						effort: "high",
						serviceTier: "priority",
						fallbackDecision: { kind: "primary" as const, reason: "fallback_not_used" as const },
						bindingDigest: modelBindingDigest,
					},
				};
				await expect(preflightExternalConnectorProductRecovery(recovery)).resolves.toBeUndefined();
				await expect(preflightExternalConnectorProductRecovery({
					...recovery,
					expectedGatewayModelRoute: {
						...recovery.expectedGatewayModelRoute,
						bindingDigest: { algorithm: "sha256", value: "0".repeat(64) },
					},
				})).rejects.toMatchObject({ code: "external_binding_invalid" });
			}
		} finally {
			await controller.shutdown();
		}
	}, 90_000);

	it("disposes gateway listeners, capabilities, and references across repeated session cycles", async () => {
		const endpoints: string[] = [];
		for (let cycle = 0; cycle < 2; cycle += 1) {
			const cwd = mkdtempSync(join(tmpdir(), `aos-product-entry-gateway-cycle-${cycle}-`));
			directories.push(cwd);
			const captures: VendorAdapterFixtureCaptures = { credentialEvents: [] };
			const settings = vendorSettings(cwd, "codex", "aos_gateway");
			const runtime = await createRuntime(cwd, settings, vendorAdapterFixture("codex", cwd, captures), captures);
			const records: RpcHostOutputRecord[] = [];
			const controller = createRpcHostController(runtime, { output: { publish: (record) => records.push(record) } });
			await controller.start();
			const initialized = await controller.dispatch({
				id: `cycle-${cycle}-init`,
				type: "initialize",
				protocolVersion: 1,
			});
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error("Gateway cycle did not initialize");
			}
			const descriptor = initialized.data.externalConnectors?.[0];
			if (descriptor === undefined) throw new Error("Gateway cycle descriptor is missing");
			await controller.handleCommand({
				id: `cycle-${cycle}-start`,
				type: "run.start",
				message: "execute gateway cycle",
				externalConnector: {
					providerId: descriptor.providerId,
					revision: descriptor.revision,
					capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
				},
				modelRoute: [{
					provider: "openai",
					modelId: "gateway-model",
					thinkingLevel: "high",
					serviceTier: "priority",
				}],
			});
			await vi.waitFor(() => expect(records.some((record) => record.type === "run.completed")).toBe(true), {
				timeout: 60_000,
			});
			const credential = captures.codexTransport?.credential;
			const gateway = captures.modelGateway;
			const environment = captures.supervision?.processController.launchOptions.at(-1)?.environment;
			if (credential === undefined || gateway === undefined || environment === undefined) {
				throw new Error("Gateway cycle did not capture its capability");
			}
			const endpoint = environment.AOS_MODEL_GATEWAY_ENDPOINT;
			const authorization = environment.AOS_MODEL_GATEWAY_AUTHORIZATION;
			const modelBindingDigest = environment.AOS_MODEL_GATEWAY_BINDING_DIGEST;
			if (endpoint === undefined || authorization === undefined || modelBindingDigest === undefined) {
				throw new Error("Gateway cycle environment is incomplete");
			}
			const capability = {
				schemaVersion: 1 as const,
				endpoint,
				authorization,
				leaseId: credential.leaseId,
				modelBindingDigest,
				expiresAt: credential.expiresAt,
			};
			endpoints.push(capability.endpoint);
			await controller.shutdown();
			expect(gateway.close(capability)).toBe(false);
			expect(() => gateway.revoke({
				schemaVersion: 1,
				leaseId: credential.leaseId,
				grantId: credential.grantId,
				bindingId: credential.bindingId,
				targetId: "codex-aos_gateway",
				requestedAt: new Date().toISOString(),
			})).toThrow("revocation is unknown");
			await expect(fetch(`${capability.endpoint}/responses`, {
				method: "POST",
				headers: { authorization: capability.authorization, "content-type": "application/json" },
				body: JSON.stringify({ model: "gateway-model", input: "after shutdown" }),
			})).rejects.toThrow();
		}
		expect(new Set(endpoints).size).toBe(2);
	}, 180_000);

	it("rejects acp aos_gateway settings before registration", async () => {
		const driver = "acp" as const;
		const cwd = mkdtempSync(join(tmpdir(), `aos-product-entry-${driver}-gateway-`));
		directories.push(cwd);
		const base = vendorSettings(cwd, driver, "agent_owned").getExternalConnectorTargetSettings()?.selectedTarget;
		if (base === undefined) throw new Error("Vendor gateway fixture target is missing");
		const settings = vendorSettings(cwd, driver, "agent_owned", {
			capabilityCeiling: { ...base.capabilityCeiling, modelAccess: ["aos_gateway"] },
		});
		await expect(createServices(cwd, settings)).rejects.toMatchObject({
			reason: "capability_widened",
			path: "$.global.targets[0].capabilityCeiling.modelAccess",
		});
	});

	it.each([
		{
			name: "identity drift",
			overrides: { moduleIdentity: `sha256:${"0".repeat(64)}` },
			message: "trusted driver file identity does not match",
		},
		{
			name: "version drift",
			overrides: { version: "0.148.0" },
			message: "requires version 0.149.0",
		},
		{
			name: "missing executable",
			overrides: {
				executablePath: join(tmpdir(), "missing-codex-executable"),
				executableIdentity: `sha256:${"1".repeat(64)}`,
			},
			message: "https://developers.openai.com/codex/cli",
		},
	])("rejects vendor $name before launch", async ({ overrides, message }) => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-vendor-invalid-"));
		directories.push(cwd);
		await expect(createServices(cwd, vendorSettings(cwd, "codex", "agent_owned", overrides))).rejects.toThrow(message);
	});

	it("uses a Host-explicit composition as a whole instead of merging settings", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-host-"));
		directories.push(cwd);
		const hostComposition = createAgentRuntimeCompositionFactory();
		const services = await createServices(cwd, packagedSettings(cwd), hostComposition);

		expect(services.runtimeComposition).toBe(hostComposition);
	});

	it("derives an executable packaged registry through the standard RPC session entry", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-settings-"));
		directories.push(cwd);
		const runtime = await createRuntime(cwd, packagedSettings(cwd));
		const records: RpcHostOutputRecord[] = [];
		const controller = createRpcHostController(runtime, { output: { publish: (record) => records.push(record) } });
		await controller.start();
		try {
			const initialized = await controller.dispatch({ id: "entry-init", type: "initialize", protocolVersion: 1 });
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error("Standard RPC entry did not initialize");
			}
			expect(initialized.data.externalConnectors).toHaveLength(1);
			const descriptor = initialized.data.externalConnectors?.[0];
			if (descriptor === undefined) throw new Error("Settings-derived Connector descriptor is missing");
			// wire/ledger field name; local alias below
			const capabilityDigest = descriptor.capabilitySnapshotDigest;
			const selection = {
				providerId: descriptor.providerId,
				revision: descriptor.revision,
				capabilitySnapshotDigest: capabilityDigest,
			};

			await controller.handleCommand({
				id: "entry-start",
				type: "run.start",
				message: "execute the packaged settings connector",
				externalConnector: selection,
			});
			await vi.waitFor(() =>
				expect(records).toContainEqual(
					expect.objectContaining({
						id: "entry-start",
						type: "response",
						command: "run.start",
						success: true,
					}),
				),
			);
			const started = records.find((record) => record.type === "response" && record.id === "entry-start");
			if (started?.type !== "response") throw new Error("Run did not return a response");
			if (started.command !== "run.start" || !started.success) throw new Error("Run was not accepted");

			const session = getAgentCanonicalSession(runtime.session);
			try {
				await vi.waitFor(
					() =>
						expect(
							records.some(
								(record) =>
									record.type === "run.completed" ||
									record.type === "run.failed" ||
									record.type === "run.cancelled",
							),
						).toBe(true),
					{ timeout: 60_000 },
				);
			} catch {
				throw new Error(`Packaged run did not settle: ${JSON.stringify(records)}`);
			}
			const terminal = records.find(
				(record) =>
					record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled",
			);
			if (terminal?.type !== "run.completed") throw new Error(`Packaged run failed: ${JSON.stringify(terminal)}`);
			const attemptReceipts = await session.findFoundationRecords({ objectType: "attempt_receipt" });
			const taskResults = await session.findFoundationRecords({ objectType: "task_result" });
			const runReceipts = await session.findFoundationRecords({ objectType: "run_receipt" });
			expect(attemptReceipts).toHaveLength(1);
			expect(attemptReceipts[0]).toMatchObject({
				payload: { providerId: "aos.fake-connector", status: "succeeded" },
			});
			expect(taskResults).toHaveLength(1);
			expect(runReceipts[0]).toMatchObject({ payload: { runId: started.data.runId, terminalStatus: "completed" } });
			expect(attemptReceipts[0]?.seq).toBeLessThan(taskResults[0]?.seq ?? 0);
			expect(taskResults[0]?.seq).toBeLessThan(runReceipts[0]?.seq ?? 0);
		} finally {
			await controller.shutdown();
		}
	}, 90_000);

	it("runs a non-packaged module target through settings, events, terminal, and receipt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-generic-"));
		directories.push(cwd);
		const runtime = await createRuntime(cwd, genericSettings(cwd));
		const records: RpcHostOutputRecord[] = [];
		const controller = createRpcHostController(runtime, { output: { publish: (record) => records.push(record) } });
		await controller.start();
		try {
			const initialized = await controller.dispatch({ id: "generic-init", type: "initialize", protocolVersion: 1 });
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error("Generic settings entry did not initialize");
			}
			expect(initialized.data.externalConnectors).toHaveLength(1);
			const descriptor = initialized.data.externalConnectors?.[0];
			if (descriptor === undefined) throw new Error("Generic settings connector descriptor is missing");
			const selection = {
				providerId: descriptor.providerId,
				revision: descriptor.revision,
				capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
			};

			await controller.handleCommand({
				id: "generic-start",
				type: "run.start",
				message: "execute the generic settings connector",
				externalConnector: selection,
			});
			await vi.waitFor(() =>
				expect(records).toContainEqual(
					expect.objectContaining({
						id: "generic-start",
						type: "response",
						command: "run.start",
						success: true,
					}),
				),
			);
			const started = records.find((record) => record.type === "response" && record.id === "generic-start");
			if (started?.type !== "response" || started.command !== "run.start" || !started.success) {
				throw new Error("Generic run was not accepted");
			}

			await vi.waitFor(
				() =>
					expect(
						records.some(
							(record) =>
								record.type === "run.completed" ||
								record.type === "run.failed" ||
								record.type === "run.cancelled",
						),
					).toBe(true),
				{ timeout: 60_000 },
			);
			const terminal = records.find(
				(record) =>
					record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled",
			);
			expect(records.some((record) => record.type === "run.started")).toBe(true);
			expect(terminal?.type).toBe("run.completed");
			const session = getAgentCanonicalSession(runtime.session);
			const attemptReceipts = await session.findFoundationRecords({ objectType: "attempt_receipt" });
			const taskResults = await session.findFoundationRecords({ objectType: "task_result" });
			const runReceipts = await session.findFoundationRecords({ objectType: "run_receipt" });
			expect(attemptReceipts).toHaveLength(1);
			expect(attemptReceipts[0]).toMatchObject({
				payload: { providerId: "fixture.external-jsonl", status: "succeeded" },
			});
			expect(taskResults).toHaveLength(1);
			expect(runReceipts[0]).toMatchObject({
				payload: { runId: started.data.runId, terminalStatus: "completed" },
			});
			expect(attemptReceipts[0]?.seq).toBeLessThan(taskResults[0]?.seq ?? 0);
			expect(taskResults[0]?.seq).toBeLessThan(runReceipts[0]?.seq ?? 0);
		} finally {
			await controller.shutdown();
		}
	}, 90_000);

	it.each([
		{
			name: "wrong digest",
			overrides: { moduleIdentity: `sha256:${"0".repeat(64)}` },
			message: "trusted driver file identity does not match",
		},
		{
			name: "relative module path",
			overrides: { modulePath: "relative-driver.mjs" },
			message: "absolute path",
		},
		{
			name: "missing version",
			overrides: { version: undefined },
			message: "version is invalid",
		},
	])("rejects $name from settings before launch", async ({ overrides, message }) => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-provenance-"));
		directories.push(cwd);
		await expect(createServices(cwd, genericSettings(cwd, overrides))).rejects.toThrow(message);
	});

	it("rejects aos_gateway anywhere in a generic settings ceiling", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-generic-gateway-"));
		directories.push(cwd);
		const base = crossLayerTargetDefinition(cwd).capabilityCeiling;
		await expect(createServices(cwd, genericSettings(cwd, {
			capabilityCeiling: { ...base, modelAccess: ["none", "aos_gateway"] },
		}))).rejects.toMatchObject({
			reason: "capability_widened",
			path: "$.global.targets[0].capabilityCeiling.modelAccess",
		});
	});

	it("keeps the empty fallback and unavailable error when settings omit connectors", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-empty-"));
		directories.push(cwd);
		const runtime = await createRuntime(cwd, SettingsManager.inMemory());
		expect(runtime.runtimeComposition.externalConnectorRegistry).toBeUndefined();
		const controller = createRpcHostController(runtime);
		await controller.start();
		try {
			await controller.dispatch({ id: "empty-init", type: "initialize", protocolVersion: 1 });
			const response = await controller.dispatch({
				id: "empty-start",
				type: "run.start",
				message: "connector remains default-off",
				externalConnector: {
					providerId: "missing.connector",
					revision: 1,
					capabilitySnapshotDigest: { algorithm: "sha256", value: "0".repeat(64) },
				},
			});
			expect(response).toMatchObject({ success: false, error: { code: "external_connector_unavailable" } });
		} finally {
			await controller.shutdown();
		}
	});
});
