import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@aos-agent/ai/compat";
import { createAgentRuntimeCompositionFactory } from "./agent-runtime-composition.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "./agent-session-runtime.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import { AuthStorage } from "./auth-storage.ts";
import { createExternalConnectorRegistry } from "./external-agent-registry.ts";
import type { ExtensionAPI } from "./extensions/types.ts";

export const LINE13_PRODUCT_TRACE_OPERATIONS = Object.freeze([
	"run",
	"switch",
	"fork",
	"import",
	"reload",
	"cancel",
	"restart",
] as const);

export interface Line13ProductTraceOptions {
	readonly workDirectory: string;
	readonly iterations?: number;
}

export interface Line13CanonicalClosureSnapshot {
	readonly activeRuns: number;
	readonly backlog: number;
	readonly status: number;
	readonly credentials: number;
	readonly reservations: number;
	readonly processes: number;
	readonly timers: number;
	readonly files: number;
	readonly pendingWrites: number;
}

export interface Line13ProductTraceResult {
	readonly schemaVersion: 1;
	readonly entrypoint: "aos-agent/external-connector";
	readonly adapter: "standard_product_composition";
	readonly iterations: number;
	readonly operations: Readonly<Record<(typeof LINE13_PRODUCT_TRACE_OPERATIONS)[number], number>>;
	readonly canonicalOwners: readonly [
		"agent_harness",
		"external_connector_registry",
		"task_credential_service",
		"scheduler_selection_reservations",
		"worker_registry",
		"scheduler_status",
		"session_manager",
	];
	readonly samples: readonly Line13CanonicalClosureSnapshot[];
	readonly final: Line13CanonicalClosureSnapshot;
	readonly provider: {
		readonly kind: "faux";
		readonly pendingResponses: number;
	};
}

type Line13FauxModel = NonNullable<ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>>;

async function createTraceRuntime(
	workDirectory: string,
	authStorage: AuthStorage,
	model: Line13FauxModel,
): Promise<AgentSessionRuntime> {
	const runtimeOptions = {
		agentDir: workDirectory,
		authStorage,
		model,
		runtimeComposition: createAgentRuntimeCompositionFactory({
			externalConnectorRegistry: () => createExternalConnectorRegistry(),
		}),
		resourceLoaderOptions: {
			extensionFactories: [
				(agent: ExtensionAPI) => {
					agent.registerProvider(model.provider, {
						baseUrl: model.baseUrl,
						apiKey: "line13-faux-key",
						api: model.api,
						models: [{
							id: model.id,
							name: model.name,
							api: model.api,
							reasoning: model.reasoning,
							input: model.input,
							cost: model.cost,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
						}],
					});
				},
			],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		sessionManager,
		sessionStartEvent,
		registerCandidateSession,
	}) => {
		const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model,
		});
		registerCandidateSession(created.session);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: workDirectory,
		agentDir: workDirectory,
		session: { mode: "new" },
	});
	await runtime.session.bindExtensions({});
	return runtime;
}

async function readCanonicalClosure(runtime: AgentSessionRuntime): Promise<Line13CanonicalClosureSnapshot> {
	const composition = runtime.runtimeComposition;
	const harness = composition.harness;
	const statuses = runtime.session.getExternalConnectorRegistry()?.runtimeStatus() ?? [];
	const activeConnectorWork = statuses.reduce((count, status) =>
		status.availability === "available"
			? count + status.activity.active + status.activity.queued + status.activity.reconcile
			: count, 0);
	const credentials = runtime.session.getTaskCredentialService()?.snapshot() ?? [];
	const reservationsResult = await composition.schedulerSelectionReservations?.list();
	if (reservationsResult !== undefined && !reservationsResult.ok) {
		throw new Error("Canonical Scheduler reservation owner could not be read");
	}
	const scheduler = runtime.session.getSchedulerStatus();
	const sessionFile = runtime.session.sessionFile;
	return Object.freeze({
		activeRuns: (harness.isRunning ? 1 : 0) + activeConnectorWork,
		backlog: harness.pendingMessageCount + harness.durablePendingMessageCount,
		status: statuses.filter((status) => status.readiness.state === "ready").length,
		credentials: credentials.filter((credential) => credential.status === "active").length,
		reservations: reservationsResult?.value.filter((reservation) => reservation.status === "reserved").length ?? 0,
		processes: runtime.session.getWorkerRegistry()?.listWorkerRecords().filter((worker) => worker.status === "running").length ?? 0,
		timers: scheduler?.tickInFlight === true ? 1 : 0,
		files: sessionFile !== undefined && existsSync(sessionFile) ? 1 : 0,
		pendingWrites: harness.hasPendingExternalMessages ? 1 : 0,
	});
}

function assertClosed(snapshot: Line13CanonicalClosureSnapshot): void {
	for (const [owner, count] of Object.entries(snapshot)) {
		if (owner === "files") {
			if (count > 1) throw new Error(`Canonical ${owner} owner retained ${count} resources`);
			continue;
		}
		if (count !== 0) throw new Error(`Canonical ${owner} owner retained ${count} resources`);
	}
}

/**
 * Packaged-only Line 13 product trace. It drives the normal Session runtime and
 * reads closure exclusively from the runtime's canonical composition owners.
 */
export async function runPackagedLine13ProductTrace(
	options: Line13ProductTraceOptions,
): Promise<Line13ProductTraceResult> {
	const iterations = options.iterations ?? 28;
	if (!Number.isSafeInteger(iterations) || iterations < LINE13_PRODUCT_TRACE_OPERATIONS.length) {
		throw new RangeError(`iterations must be at least ${LINE13_PRODUCT_TRACE_OPERATIONS.length}`);
	}
	mkdirSync(options.workDirectory, { recursive: true });
	const faux = registerFauxProvider();
	const restartCount = Array.from({ length: iterations }, (_, index) =>
		LINE13_PRODUCT_TRACE_OPERATIONS[index % LINE13_PRODUCT_TRACE_OPERATIONS.length],
	).filter((operation) => operation === "restart").length;
	faux.setResponses(Array.from({ length: iterations - restartCount }, (_, index) => fauxAssistantMessage(`trace-${index}`)));
	const authStorage = AuthStorage.inMemory();
	const model = faux.getModel();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "line13-faux-key" }));
	let runtime = await createTraceRuntime(options.workDirectory, authStorage, model);
	const operations = Object.fromEntries(LINE13_PRODUCT_TRACE_OPERATIONS.map((operation) => [operation, 0])) as Record<
		(typeof LINE13_PRODUCT_TRACE_OPERATIONS)[number],
		number
	>;
	const samples: Line13CanonicalClosureSnapshot[] = [];

	try {
		for (let iteration = 0; iteration < iterations; iteration += 1) {
			const operation = LINE13_PRODUCT_TRACE_OPERATIONS[iteration % LINE13_PRODUCT_TRACE_OPERATIONS.length];
			operations[operation] += 1;
			if (operation === "run") {
				await runtime.session.prompt(`line13 product run ${iteration}`);
			} else if (operation === "cancel") {
				const prompt = runtime.session.prompt(`line13 product cancel ${iteration}`);
				await runtime.session.abort();
				await prompt.catch(() => undefined);
			} else if (operation === "restart") {
				const sessionFile = runtime.session.sessionFile;
				await runtime.dispose();
				runtime = await createTraceRuntime(options.workDirectory, authStorage, model);
				if (sessionFile !== undefined) await runtime.switchSession(sessionFile);
			} else {
				await runtime.session.prompt(`line13 product ${operation} ${iteration}`);
				const sessionFile = runtime.session.sessionFile;
				if (sessionFile === undefined) throw new Error(`${operation} did not publish a canonical Session file`);
				if (operation === "switch") {
					const target = join(options.workDirectory, `switch-${iteration}.jsonl`);
					copyFileSync(sessionFile, target);
					await runtime.switchSession(target);
				} else if (operation === "fork") {
					const entryId = runtime.session.getUserMessagesForForking()[0]?.entryId;
					if (entryId === undefined) throw new Error("Product fork source is unavailable");
					await runtime.fork(entryId);
				} else if (operation === "import") {
					const target = join(options.workDirectory, `import-${iteration}.jsonl`);
					copyFileSync(sessionFile, target);
					await runtime.importFromJsonl(target);
				} else {
					await runtime.reload();
				}
			}
			await runtime.session.waitForIdle();
			const sample = await readCanonicalClosure(runtime);
			assertClosed(sample);
			samples.push(sample);
		}
		const final = await readCanonicalClosure(runtime);
		assertClosed(final);
		return Object.freeze({
			schemaVersion: 1,
			entrypoint: "aos-agent/external-connector",
			adapter: "standard_product_composition",
			iterations,
			operations: Object.freeze({ ...operations }),
			canonicalOwners: Object.freeze([
				"agent_harness",
				"external_connector_registry",
				"task_credential_service",
				"scheduler_selection_reservations",
				"worker_registry",
				"scheduler_status",
				"session_manager",
			] as const),
			samples: Object.freeze(samples),
			final,
			provider: Object.freeze({ kind: "faux", pendingResponses: faux.getPendingResponseCount() }),
		});
	} finally {
		await runtime.dispose().catch(() => undefined);
		faux.unregister();
		for (const name of ["switch", "import"]) {
			for (let index = 0; index < iterations; index += 1) {
				const path = join(options.workDirectory, `${name}-${index}.jsonl`);
				if (existsSync(path)) rmSync(path, { force: true });
			}
		}
	}
}
