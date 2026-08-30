import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentBinding,
	Attempt,
	AttemptReceipt,
	ConnectorCapabilitySnapshot,
	Dispatch,
	ExternalAgentConnector,
	Fingerprint,
	FoundationError,
	FoundationJsonValue,
	FoundationProviderCapability,
	FoundationProviderExecutionOptions,
	Result,
	TaskExecutorAttemptContext,
	ToolExecutionResult,
} from "../../../../agent/src/internal.ts";

export const PACKAGED_EXTERNAL_AGENT_DRIVER_NAMES = Object.freeze(["fake-connector"] as const);
export type PackagedExternalAgentDriverName = (typeof PACKAGED_EXTERNAL_AGENT_DRIVER_NAMES)[number];
export type PackagedExternalAgentDriverOperationKind = "capabilities" | "start" | "tool" | "resume" | "cancel";

export interface PackagedExternalAgentDriverOperation {
	readonly sequence: number;
	readonly kind: PackagedExternalAgentDriverOperationKind;
	readonly input: string;
	readonly output: string;
}

/** Non-secret deterministic fixture shipped for package and binary verification. */
export interface PackagedExternalAgentDriver {
	readonly schemaVersion: 1;
	readonly fixtureId: "aos.fake-connector";
	readonly providerId: "aos.fake-connector";
	readonly fakeProviderId: "aos.fake-provider";
	readonly defaultEnabled: false;
	readonly credentialMode: "none";
	readonly networkMode: "disabled";
	readonly operations: readonly PackagedExternalAgentDriverOperation[];
}

export interface PackagedExternalAgentDriverLifecycle {
	readonly capabilities: number;
	readonly probeCapabilities: number;
	readonly createAttempt: number;
	readonly runAttempt: number;
	readonly tool: number;
	readonly resumeAttempt: number;
	readonly cancelAttempt: number;
	readonly reconcileAttempt: number;
	readonly dispose: number;
}

export interface PackagedExternalAgentDriverReceipt {
	readonly phase: "run" | "resume" | "cancel";
	readonly attemptReceiptId: string;
	readonly attemptId: string;
	readonly providerId: "aos.fake-connector";
	readonly status: "suspended" | "succeeded" | "cancelled";
	readonly sideEffectState: "none";
}

export interface PackagedExternalAgentDriverToolResult {
	readonly toolCallId: "aos.fake-tool-call";
	readonly toolName: "fixture.echo";
	readonly ok: true;
	readonly sideEffectState: "none";
	readonly output: "echo:deterministic";
}

export type PackagedExternalAgentDriverAssetErrorCode =
	| "external_agent_driver_asset_missing"
	| "external_agent_driver_asset_invalid";

export class PackagedExternalAgentDriverAssetError extends Error {
	readonly code: PackagedExternalAgentDriverAssetErrorCode;

	constructor(code: PackagedExternalAgentDriverAssetErrorCode, message: string) {
		super(message);
		this.name = "PackagedExternalAgentDriverAssetError";
		this.code = code;
	}
}

const EXACT_DRIVER_KEYS = new Set([
	"schemaVersion",
	"fixtureId",
	"providerId",
	"fakeProviderId",
	"defaultEnabled",
	"credentialMode",
	"networkMode",
	"operations",
]);
const EXACT_OPERATION_KEYS = new Set(["sequence", "kind", "input", "output"]);
const OPERATION_KINDS: ReadonlySet<string> = new Set(["start", "tool", "resume", "cancel"]);
const COMPILED_BUN_URL_MARKERS = Object.freeze(["$bunfs", "~BUN", "%7EBUN"]);
const PACKAGED_NOW = "2026-08-29T00:00:00.000Z";
const PACKAGED_PROVIDER_ID = "aos.fake-connector" as const;
const PACKAGED_TOOL_CALL_ID = "aos.fake-tool-call" as const;
const PACKAGED_TOOL_NAME = "fixture.echo" as const;

function ok<T>(value: T): Result<T, FoundationError> {
	return { ok: true, value };
}

function fingerprint(value: unknown): Fingerprint {
	return {
		algorithm: "sha256",
		value: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
	};
}

function operationInput(
	fixture: PackagedExternalAgentDriver,
	kind: Exclude<PackagedExternalAgentDriverOperationKind, "capabilities">,
): string {
	const operation = fixture.operations.find((candidate) => candidate.kind === kind);
	if (operation === undefined) {
		throw new PackagedExternalAgentDriverAssetError(
			"external_agent_driver_asset_invalid",
			"The packaged External Agent driver fixture is invalid.",
		);
	}
	return operation.input;
}

function attemptIdFor(dispatchId: string): string {
	return `fake_attempt_${dispatchId}`;
}

function receiptSummary(
	phase: PackagedExternalAgentDriverReceipt["phase"],
	receipt: AttemptReceipt,
): PackagedExternalAgentDriverReceipt {
	const expectedStatus = phase === "run" ? "suspended" : phase === "resume" ? "succeeded" : "cancelled";
	if (
		receipt.providerId !== PACKAGED_PROVIDER_ID ||
		receipt.sideEffectState !== "none" ||
		receipt.status !== expectedStatus
	) {
		throw new Error(`Packaged fake Connector produced an invalid ${phase} receipt.`);
	}
	return Object.freeze({
		phase,
		attemptReceiptId: receipt.attemptReceiptId,
		attemptId: receipt.attemptId,
		providerId: PACKAGED_PROVIDER_ID,
		status: expectedStatus,
		sideEffectState: "none",
	});
}

/** A real, deterministic implementation of the public ExternalAgentConnector lifecycle. */
class PackagedFakeExternalAgentConnector implements ExternalAgentConnector {
	readonly schemaVersion = 1 as const;
	readonly providerId = PACKAGED_PROVIDER_ID;
	readonly providerClass = "external_connector" as const;
	readonly #fixture: PackagedExternalAgentDriver;
	readonly #capability: ConnectorCapabilitySnapshot;
	readonly #attempts = new Map<string, Attempt>();
	readonly #receipts = new Map<string, AttemptReceipt>();
	readonly #events: PackagedExternalAgentDriverOperation[] = [];
	readonly #lifecycle = {
		capabilities: 0,
		probeCapabilities: 0,
		createAttempt: 0,
		runAttempt: 0,
		tool: 0,
		resumeAttempt: 0,
		cancelAttempt: 0,
		reconcileAttempt: 0,
		dispose: 0,
	};
	#toolResult: ToolExecutionResult | undefined;
	#disposed = false;

	constructor(fixture: PackagedExternalAgentDriver) {
		this.#fixture = fixture;
		const snapshot = {
			schemaVersion: 1 as const,
			providerId: this.providerId,
			revision: 1,
			protocol: { name: "aos.fake-connector", version: "1" },
			modelAccess: "none" as const,
			resume: true,
			toolGateway: true,
			artifacts: false,
			images: false,
		};
		this.#capability = Object.freeze({ ...snapshot, digest: fingerprint(snapshot) });
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		this.#assertActive();
		this.#lifecycle.capabilities += 1;
		const capabilities = Object.freeze([
			Object.freeze({ schemaVersion: 1, id: "external_connector.lifecycle", version: 1 }),
			Object.freeze({ schemaVersion: 1, id: "external_connector.tool_gateway", version: 1 }),
		]);
		this.#record(
			"capabilities",
			"connector:capabilities",
			capabilities.map((capability) => `${capability.id}:${capability.version}`).join(","),
		);
		return capabilities;
	}

	async probeCapabilities(
		_options?: FoundationProviderExecutionOptions,
	): Promise<Result<ConnectorCapabilitySnapshot, FoundationError>> {
		this.#assertActive();
		this.#lifecycle.probeCapabilities += 1;
		return ok(this.#capability);
	}

	async createAttempt(
		dispatch: Dispatch,
		binding: AgentBinding,
		context?: TaskExecutorAttemptContext,
	): Promise<Result<Attempt, FoundationError>> {
		this.#assertActive();
		if (
			context === undefined ||
			dispatch.taskExecutorProviderId !== this.providerId ||
			dispatch.taskId !== binding.taskId ||
			dispatch.bindingId !== binding.bindingId
		) {
			throw new Error("Packaged fake Connector received an invalid Dispatch or AgentBinding.");
		}
		const attemptId = attemptIdFor(dispatch.dispatchId);
		if (
			context.initialBindingEpoch.attemptId !== attemptId ||
			context.initialBindingEpoch.taskId !== dispatch.taskId ||
			context.initialBindingEpoch.bindingId !== binding.bindingId
		) {
			throw new Error("Packaged fake Connector received an invalid initial BindingEpoch.");
		}
		const attempt = Object.freeze({
			schemaVersion: 1 as const,
			attemptId,
			dispatchId: dispatch.dispatchId,
			taskId: dispatch.taskId,
			providerId: this.providerId,
			bindingId: binding.bindingId,
			bindingEpochIds: Object.freeze([context.initialBindingEpoch.bindingEpochId]),
			status: "starting" as const,
			startedAt: PACKAGED_NOW,
		});
		this.#attempts.set(attemptId, attempt);
		this.#lifecycle.createAttempt += 1;
		if (!this.#events.some((event) => event.kind === "start")) {
			this.#record("start", operationInput(this.#fixture, "start"), `attempt:${attempt.status}`);
		}
		return ok(attempt);
	}

	async runAttempt(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<Result<AttemptReceipt, FoundationError>> {
		this.#assertActive();
		this.#requireAttempt(attempt, "starting");
		this.#lifecycle.runAttempt += 1;
		const toolResult = this.#executeTool(operationInput(this.#fixture, "tool"));
		this.#toolResult = toolResult;
		this.#record("tool", operationInput(this.#fixture, "tool"), toolResult.ok ? "tool:ok" : "tool:failed");
		const receipt = this.#makeReceipt(attempt, "suspended", "run", options);
		this.#receipts.set(attempt.attemptId, receipt);
		return ok(receipt);
	}

	async resumeAttempt(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<Result<AttemptReceipt, FoundationError>> {
		this.#assertActive();
		const current = this.#requireAttempt(attempt);
		if (current.status !== "suspended") throw new Error("Packaged fake Connector Attempt is not suspended.");
		this.#lifecycle.resumeAttempt += 1;
		const receipt = this.#makeReceipt(attempt, "succeeded", "resume", options);
		this.#receipts.set(attempt.attemptId, receipt);
		this.#record("resume", operationInput(this.#fixture, "resume"), `receipt:${receipt.status}`);
		return ok(receipt);
	}

	async cancelAttempt(attemptId: string): Promise<Result<void, FoundationError>> {
		this.#assertActive();
		const attempt = this.#attempts.get(attemptId);
		if (attempt === undefined || attempt.status !== "starting") {
			throw new Error("Packaged fake Connector has no cancellable Attempt.");
		}
		this.#lifecycle.cancelAttempt += 1;
		const receipt = this.#makeReceipt(attempt, "cancelled", "cancel");
		this.#receipts.set(attemptId, receipt);
		this.#record("cancel", operationInput(this.#fixture, "cancel"), `receipt:${receipt.status}`);
		return ok(undefined);
	}

	async reconcileAttempt(
		attempt: Attempt,
		_options?: FoundationProviderExecutionOptions,
	): Promise<Result<AttemptReceipt, FoundationError>> {
		this.#assertActive();
		this.#lifecycle.reconcileAttempt += 1;
		const receipt = this.#receipts.get(attempt.attemptId);
		if (receipt === undefined) throw new Error("Packaged fake Connector has no durable receipt to reconcile.");
		return ok(receipt);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifecycle.dispose += 1;
	}

	trace(): {
		readonly events: readonly PackagedExternalAgentDriverOperation[];
		readonly lifecycle: PackagedExternalAgentDriverLifecycle;
		readonly toolResult: PackagedExternalAgentDriverToolResult;
	} {
		if (!this.#disposed || this.#toolResult === undefined) {
			throw new Error("Packaged fake Connector lifecycle did not finish.");
		}
		const result = this.#toolResult.result;
		if (
			result === undefined ||
			typeof result !== "object" ||
			result === null ||
			Array.isArray(result) ||
			result.output !== "echo:deterministic"
		) {
			throw new Error("Packaged fake Connector tool execution did not produce the expected result.");
		}
		return Object.freeze({
			events: Object.freeze(this.#events.map((event) => Object.freeze({ ...event }))),
			lifecycle: Object.freeze({ ...this.#lifecycle }),
			toolResult: Object.freeze({
				toolCallId: PACKAGED_TOOL_CALL_ID,
				toolName: PACKAGED_TOOL_NAME,
				ok: true,
				sideEffectState: "none",
				output: result.output,
			}),
		});
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Packaged fake Connector is disposed.");
	}

	#record(kind: PackagedExternalAgentDriverOperationKind, input: string, output: string): void {
		this.#events.push({ sequence: this.#events.length + 1, kind, input, output });
	}

	#requireAttempt(attempt: Attempt, status?: Attempt["status"]): Attempt {
		const current = this.#attempts.get(attempt.attemptId);
		if (
			current === undefined ||
			current.dispatchId !== attempt.dispatchId ||
			current.bindingId !== attempt.bindingId ||
			(status !== undefined && current.status !== status)
		) {
			throw new Error("Packaged fake Connector received an unknown Attempt.");
		}
		return current;
	}

	#executeTool(toolName: string): ToolExecutionResult {
		if (toolName !== PACKAGED_TOOL_NAME) throw new Error("Packaged fake Connector tool route is unavailable.");
		this.#lifecycle.tool += 1;
		return Object.freeze({
			schemaVersion: 1,
			toolCallId: PACKAGED_TOOL_CALL_ID,
			toolName: PACKAGED_TOOL_NAME,
			ok: true,
			sideEffectState: "none",
			result: Object.freeze({ output: "echo:deterministic" }) as FoundationJsonValue,
			toolReceiptRef: "fake-tool-receipt",
		});
	}

	#makeReceipt(
		attempt: Attempt,
		status: AttemptReceipt["status"],
		phase: PackagedExternalAgentDriverReceipt["phase"],
		options?: FoundationProviderExecutionOptions,
	): AttemptReceipt {
		const attemptReceiptId = `fake_receipt_${phase}_${attempt.attemptId}`;
		const receipt = Object.freeze({
			schemaVersion: 1 as const,
			attemptReceiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			bindingId: attempt.bindingId,
			bindingEpochIds: Object.freeze([...attempt.bindingEpochIds]),
			status,
			workerReceiptRefs: Object.freeze([]),
			artifacts: Object.freeze([]),
			provenance: Object.freeze({
				producerKind: "external_connector" as const,
				providerId: this.providerId,
				producedAt: PACKAGED_NOW,
				correlation: Object.freeze({
					...(options?.correlation ?? { sessionId: "fake-session", laneId: "main", revision: 1 }),
					taskId: attempt.taskId,
					dispatchId: attempt.dispatchId,
					attemptId: attempt.attemptId,
					bindingId: attempt.bindingId,
					bindingEpochId: attempt.bindingEpochIds[0],
					providerId: this.providerId,
					attemptReceiptId,
				}),
			}),
			sideEffectState: "none" as const,
		});
		this.#attempts.set(
			attempt.attemptId,
			Object.freeze({
				...attempt,
				status: status === "suspended" ? "suspended" : status,
				...(status === "suspended" ? {} : { completedAt: PACKAGED_NOW }),
			}),
		);
		return receipt;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	const ownKeys = Reflect.ownKeys(value);
	return ownKeys.length === keys.size && ownKeys.every((key) => typeof key === "string" && keys.has(key));
}

function isOperation(value: unknown, sequence: number): value is PackagedExternalAgentDriverOperation {
	return (
		isRecord(value) &&
		hasExactKeys(value, EXACT_OPERATION_KEYS) &&
		value.sequence === sequence &&
		typeof value.kind === "string" &&
		OPERATION_KINDS.has(value.kind) &&
		typeof value.input === "string" &&
		value.input.length > 0 &&
		typeof value.output === "string" &&
		value.output.length > 0
	);
}

function parseDriver(value: unknown): PackagedExternalAgentDriver {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, EXACT_DRIVER_KEYS) ||
		value.schemaVersion !== 1 ||
		value.fixtureId !== "aos.fake-connector" ||
		value.providerId !== "aos.fake-connector" ||
		value.fakeProviderId !== "aos.fake-provider" ||
		value.defaultEnabled !== false ||
		value.credentialMode !== "none" ||
		value.networkMode !== "disabled" ||
		!Array.isArray(value.operations) ||
		value.operations.length !== 4 ||
		!value.operations.every((operation, index) => isOperation(operation, index + 1)) ||
		value.operations.map((operation) => operation.kind).join(",") !== "start,tool,resume,cancel"
	) {
		throw new PackagedExternalAgentDriverAssetError(
			"external_agent_driver_asset_invalid",
			"The packaged External Agent driver fixture is invalid.",
		);
	}
	return Object.freeze({
		schemaVersion: 1,
		fixtureId: value.fixtureId,
		providerId: value.providerId,
		fakeProviderId: value.fakeProviderId,
		defaultEnabled: false,
		credentialMode: "none",
		networkMode: "disabled",
		operations: Object.freeze(value.operations.map((operation) => Object.freeze({ ...operation }))),
	});
}

function packagedAssetDirectory(): string {
	const compiled = COMPILED_BUN_URL_MARKERS.some((marker) => import.meta.url.includes(marker));
	return compiled
		? join(dirname(process.execPath), "external-connector-assets")
		: join(dirname(fileURLToPath(import.meta.url)), "assets");
}

/** Exact packaged process module admitted by settings-based product composition. */
export function packagedExternalAgentDriverProcessModulePath(name: PackagedExternalAgentDriverName): string {
	if (name !== "fake-connector") {
		throw new PackagedExternalAgentDriverAssetError(
			"external_agent_driver_asset_missing",
			"The requested packaged External Agent driver fixture is unavailable.",
		);
	}
	return join(packagedAssetDirectory(), "fake-connector-process.mjs");
}

/** Load an allowlisted packaged fixture without enabling a production Connector. */
export function loadPackagedExternalAgentDriver(name: string): PackagedExternalAgentDriver {
	if (name !== "fake-connector") {
		throw new PackagedExternalAgentDriverAssetError(
			"external_agent_driver_asset_missing",
			"The requested packaged External Agent driver fixture is unavailable.",
		);
	}
	let serialized: string;
	try {
		serialized = readFileSync(join(packagedAssetDirectory(), "fake-connector.json"), "utf8");
	} catch {
		throw new PackagedExternalAgentDriverAssetError(
			"external_agent_driver_asset_missing",
			"The requested packaged External Agent driver fixture is unavailable.",
		);
	}
	try {
		return parseDriver(JSON.parse(serialized));
	} catch (error) {
		if (error instanceof PackagedExternalAgentDriverAssetError) throw error;
		throw new PackagedExternalAgentDriverAssetError(
			"external_agent_driver_asset_invalid",
			"The packaged External Agent driver fixture is invalid.",
		);
	}
}

export interface PackagedExternalAgentDriverTrace {
	readonly schemaVersion: 1;
	readonly fixtureId: "aos.fake-connector";
	readonly providerId: "aos.fake-connector";
	readonly fakeProviderId: "aos.fake-provider";
	readonly defaultEnabled: false;
	readonly credentialMode: "none";
	readonly networkMode: "disabled";
	readonly events: readonly PackagedExternalAgentDriverOperation[];
	readonly receipts: readonly PackagedExternalAgentDriverReceipt[];
	readonly toolResult: PackagedExternalAgentDriverToolResult;
	readonly lifecycle: PackagedExternalAgentDriverLifecycle;
}

function packagedBinding(taskId: string): AgentBinding {
	const immutableReference = (type: string, id: string) =>
		Object.freeze({
			schemaVersion: 1 as const,
			type,
			id,
			revision: 1,
			fingerprint: fingerprint({ type, id, revision: 1 }),
		});
	const capabilityRevision = immutableReference("capability_binding", "fake-capability-binding");
	const mcpSelectionBase = {
		schemaVersion: 1 as const,
		capabilityBindingId: capabilityRevision.id,
		selectorDigest: fingerprint({ policy: "none" }),
		servers: Object.freeze([]),
	};
	const binding = {
		schemaVersion: 1 as const,
		bindingId: "fake-binding",
		taskId,
		goalId: "fake-goal",
		roleRevision: immutableReference("role_revision", "fake-role-revision"),
		modelProfileRevision: immutableReference("model_profile_revision", "fake-model-profile"),
		modelRoute: Object.freeze({ provider: "none", model: "none" }),
		contextRevision: immutableReference("external_agent_binding", "fake-external-binding"),
		capabilityRevision,
		modelBrokerBindingRevision: immutableReference("model_broker_binding", "fake-model-binding"),
		policyRevision: immutableReference("policy_binding", "fake-policy-binding"),
		capabilitySelector: Object.freeze({ policy: "all" as const }),
		mcpSelection: Object.freeze({ ...mcpSelectionBase, digest: fingerprint(mcpSelectionBase) }),
		budget: Object.freeze({}),
		sourceTrace: Object.freeze([]),
		conflicts: Object.freeze([]),
		resolvedAt: PACKAGED_NOW,
	};
	return Object.freeze({ ...binding, fingerprint: fingerprint(binding) });
}

function packagedDispatch(dispatchId: string, taskId: string, bindingId: string): Dispatch {
	return Object.freeze({
		schemaVersion: 1,
		dispatchId,
		taskId,
		bindingId,
		taskExecutorProviderId: PACKAGED_PROVIDER_ID,
		status: "pending",
		createdAt: PACKAGED_NOW,
	});
}

function packagedAttemptContext(dispatch: Dispatch): TaskExecutorAttemptContext {
	return Object.freeze({
		initialBindingEpoch: Object.freeze({
			schemaVersion: 1,
			bindingEpochId: `fake_epoch_${dispatch.dispatchId}`,
			taskId: dispatch.taskId,
			attemptId: attemptIdFor(dispatch.dispatchId),
			bindingId: dispatch.bindingId,
			ordinal: 0,
			activationReason: "attempt_started",
			activatedByCommandId: dispatch.dispatchId,
			activatedAt: PACKAGED_NOW,
		}),
	});
}

function requireOk<T>(result: Result<T, FoundationError>, phase: string): T {
	if (!result.ok) throw new Error(`Packaged fake Connector ${phase} failed: ${result.error.code}`);
	return result.value;
}

/** Execute capabilities/start/tool/resume/cancel through one real fake Connector instance. */
export async function runPackagedExternalAgentDriverFixture(): Promise<PackagedExternalAgentDriverTrace> {
	const fixture = loadPackagedExternalAgentDriver("fake-connector");
	const connector = new PackagedFakeExternalAgentConnector(fixture);
	const taskId = "fake-task";
	const binding = packagedBinding(taskId);
	const capabilities = await connector.capabilities();
	const probed = requireOk(await connector.probeCapabilities(), "capability probe");
	if (
		capabilities.map((capability) => `${capability.id}:${capability.version}`).join(",") !==
			"external_connector.lifecycle:1,external_connector.tool_gateway:1" ||
		probed.providerId !== fixture.providerId ||
		probed.resume !== true ||
		probed.toolGateway !== true
	) {
		throw new Error("Packaged fake Connector capability negotiation failed.");
	}
	const primaryDispatch = packagedDispatch("fake-dispatch-primary", taskId, binding.bindingId);
	const primaryAttempt = requireOk(
		await connector.createAttempt(primaryDispatch, binding, packagedAttemptContext(primaryDispatch)),
		"start",
	);
	const correlation = Object.freeze({ sessionId: "fake-session", laneId: "main", revision: 1 });
	const runReceipt = requireOk(await connector.runAttempt(primaryAttempt, { correlation }), "tool run");
	const resumeReceipt = requireOk(await connector.resumeAttempt(primaryAttempt, { correlation }), "resume");

	const cancelDispatch = packagedDispatch("fake-dispatch-cancel", taskId, binding.bindingId);
	const cancelAttempt = requireOk(
		await connector.createAttempt(cancelDispatch, binding, packagedAttemptContext(cancelDispatch)),
		"cancel start",
	);
	requireOk(await connector.cancelAttempt(cancelAttempt.attemptId), "cancel");
	const cancelReceipt = requireOk(await connector.reconcileAttempt(cancelAttempt, { correlation }), "cancel receipt");
	await connector.dispose();
	const executed = connector.trace();
	return Object.freeze({
		schemaVersion: 1,
		fixtureId: fixture.fixtureId,
		providerId: fixture.providerId,
		fakeProviderId: fixture.fakeProviderId,
		defaultEnabled: fixture.defaultEnabled,
		credentialMode: fixture.credentialMode,
		networkMode: fixture.networkMode,
		events: executed.events,
		receipts: Object.freeze([
			receiptSummary("run", runReceipt),
			receiptSummary("resume", resumeReceipt),
			receiptSummary("cancel", cancelReceipt),
		]),
		toolResult: executed.toolResult,
		lifecycle: executed.lifecycle,
	});
}
