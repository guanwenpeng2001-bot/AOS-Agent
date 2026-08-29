import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fakeAssistantMessage, registerFakeProvider } from "@aos-agent/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentRuntimeComposition,
	createAgentRuntimeCompositionFactory,
} from "../src/core/agent-runtime-composition.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/session/runtime.ts";
import type { AgentSession, ExtensionBindings } from "../src/core/session/agent-session.ts";
import { AuthStorage } from "../src/core/policy/auth-storage.ts";
import { CurrentSessionScope } from "../src/core/session/current-scope.ts";
import { createExternalConnectorRegistry } from "../src/core/connector/registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session/manager.ts";
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

const transitionFlows = ["new", "switch", "fork", "import", "reload"] as const;
type TransitionFlow = (typeof transitionFlows)[number];
const transitionFaults = ["construction", "validation", "readiness", "rebind", "commit"] as const;
type TransitionFault = (typeof transitionFaults)[number];
const transitionFaultCases = transitionFlows.flatMap((flow) =>
	transitionFaults.map((fault) => [flow, fault] as const),
);

function createDeferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: () => {
			if (resolvePromise === undefined) throw new Error("Deferred resolver is unavailable");
			resolvePromise();
		},
	};
}

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		vi.restoreAllMocks();
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `aos-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const fake = registerFakeProvider();
		fake.setResponses([fakeAssistantMessage("one"), fakeAssistantMessage("two"), fakeAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(fake.getModel().provider, async () => ({ type: "api_key", key: "fake-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = fake.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model: fake.getModel(),
			runtimeComposition: createAgentRuntimeCompositionFactory({
				externalConnectorRegistry: () => createExternalConnectorRegistry(),
			}),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		let nextFactoryFault: Extract<TransitionFault, "construction" | "validation" | "readiness"> | undefined;
		let failedConstructionSession: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
		const createdSessions: Array<Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"]> = [];
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
			registerCandidateSession,
		}) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			const created = await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: fake.getModel(),
				});
			createdSessions.push(created.session);
			registerCandidateSession(created.session);
			const factoryFault = nextFactoryFault;
			nextFactoryFault = undefined;
			if (factoryFault === "construction") {
				failedConstructionSession = created.session;
				await created.session.prompt("candidate construction artifact");
				throw new Error("construction after allocation fault");
			}
			if (factoryFault === "readiness") {
				vi.spyOn(created.session, "whenCapabilitiesReady").mockRejectedValueOnce(
					new Error("candidate readiness fault"),
				);
			}
			const runtimeComposition: AgentRuntimeComposition = factoryFault === "validation"
				? Object.freeze({ ...created.runtimeComposition })
				: created.runtimeComposition;
			return {
				...created,
				runtimeComposition,
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			session: { mode: "new" },
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			fake.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return {
			runtimeHost,
			fake,
			tempDir,
			failConstructionAfterAllocation: () => {
				nextFactoryFault = "construction";
			},
			setNextFactoryFault: (fault: Extract<TransitionFault, "construction" | "validation" | "readiness">) => {
				nextFactoryFault = fault;
			},
			createdSessions,
			getFailedConstructionSession: () => failedConstructionSession,
		};
	}

	async function prepareTransition(
		fixture: Awaited<ReturnType<typeof createRuntimeHost>>,
		flow: TransitionFlow,
	): Promise<() => Promise<unknown>> {
		if (flow === "new") return () => fixture.runtimeHost.newSession();
		if (flow === "reload") return () => fixture.runtimeHost.reload();

		await fixture.runtimeHost.session.prompt(`matrix ${flow} source`);
		const sourceFile = fixture.runtimeHost.session.sessionFile!;
		if (flow === "switch") {
			const targetPath = join(fixture.tempDir, "matrix-switch.jsonl");
			copyFileSync(sourceFile, targetPath);
			return () => fixture.runtimeHost.switchSession(targetPath);
		}
		if (flow === "import") {
			const importDir = join(fixture.tempDir, "matrix-import-source");
			mkdirSync(importDir, { recursive: true });
			const inputPath = join(importDir, "matrix-import.jsonl");
			copyFileSync(sourceFile, inputPath);
			return () => fixture.runtimeHost.importFromJsonl(inputPath);
		}

		const entryId = fixture.runtimeHost.session.getUserMessagesForForking()[0]!.entryId;
		return () => fixture.runtimeHost.fork(entryId);
	}

	async function bindRuntimeCommandActions(
		fixture: Awaited<ReturnType<typeof createRuntimeHost>>,
		reload: () => Promise<void> = () => fixture.runtimeHost.reload(),
	): Promise<void> {
		const bindings = (session: AgentSession): ExtensionBindings => ({
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => fixture.runtimeHost.newSession(options),
				fork: async (entryId, options) => {
					const result = await fixture.runtimeHost.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: (sessionPath, options) => fixture.runtimeHost.switchSession(sessionPath, options),
				reload,
			},
		});
		fixture.runtimeHost.setPrepareSessionRebind(async (session) => {
			await session.prepareExtensionBindings(bindings(session));
			return {
				commit: () => undefined,
				activate: () => session.activateExtensionBindings(),
			};
		});
		await fixture.runtimeHost.session.bindExtensions(bindings(fixture.runtimeHost.session));
	}

	function injectTransitionFault(
		fixture: Awaited<ReturnType<typeof createRuntimeHost>>,
		fault: TransitionFault,
	): string {
		if (fault === "construction" || fault === "validation" || fault === "readiness") {
			fixture.setNextFactoryFault(fault);
			return fault === "construction"
				? "construction after allocation fault"
				: fault === "validation"
					? "Replacement runtime must derive from the original runtime composition"
					: "candidate readiness fault";
		}
		if (fault === "rebind") {
			fixture.runtimeHost.setPrepareSessionRebind(() => {
				throw new Error("candidate rebind fault");
			});
			return "candidate rebind fault";
		}

		const currentScope = Reflect.get(fixture.runtimeHost, "currentScope");
		if (!(currentScope instanceof CurrentSessionScope)) {
			throw new TypeError("AgentSessionRuntime current scope is unavailable");
		}
		const replace = currentScope.replace.bind(currentScope);
		vi.spyOn(currentScope, "replace").mockImplementation((options) => replace({
			...options,
			commit: () => {
				throw new Error("candidate commit gate fault");
			},
		}));
		return "candidate commit gate fault";
	}

	it.each(transitionFlows)("publishes one fresh complete scope for a successful %s transition", async (flow) => {
		const fixture = await createRuntimeHost(() => undefined);
		const transition = await prepareTransition(fixture, flow);
		const oldSession = fixture.runtimeHost.session;
		const oldServices = fixture.runtimeHost.services;
		const oldComposition = fixture.runtimeHost.runtimeComposition;
		const oldDiagnostics = fixture.runtimeHost.diagnostics;
		const oldDispose = vi.spyOn(oldSession, "dispose");

		await transition();

		const candidate = fixture.runtimeHost.session;
		expect(candidate).not.toBe(oldSession);
		expect(fixture.runtimeHost.services).not.toBe(oldServices);
		expect(fixture.runtimeHost.runtimeComposition).not.toBe(oldComposition);
		expect(fixture.runtimeHost.diagnostics).not.toBe(oldDiagnostics);
		expect(fixture.runtimeHost.runtimeComposition).toBe(candidate.agentRuntimeComposition);
		expect(fixture.runtimeHost.runtimeComposition.factory).toBe(fixture.runtimeHost.services.runtimeComposition);
		expect(fixture.runtimeHost.runtimeComposition.session).not.toBe(oldComposition.session);
		expect(fixture.runtimeHost.runtimeComposition.harness).not.toBe(oldComposition.harness);
		expect(fixture.runtimeHost.runtimeComposition.externalConnectorRegistry).toBeDefined();
		expect(fixture.runtimeHost.runtimeComposition.externalConnectorRegistry).not.toBe(
			oldComposition.externalConnectorRegistry,
		);
		await oldSession.waitForDispose();
		expect(oldDispose).toHaveBeenCalledTimes(1);
	});

	it.each(transitionFaultCases)(
		"keeps a usable old scope and releases the candidate after a %s %s fault",
		async (flow, fault) => {
			const fixture = await createRuntimeHost(() => undefined);
			const transition = await prepareTransition(fixture, flow);
			const oldSession = fixture.runtimeHost.session;
			const oldServices = fixture.runtimeHost.services;
			const oldComposition = fixture.runtimeHost.runtimeComposition;
			const oldDiagnostics = fixture.runtimeHost.diagnostics;
			const oldDispose = vi.spyOn(oldSession, "dispose");
			const sessionCountBefore = fixture.createdSessions.length;
			const expectedError = injectTransitionFault(fixture, fault);

			await expect(transition()).rejects.toThrow(expectedError);

			expect(fixture.createdSessions).toHaveLength(sessionCountBefore + 1);
			const candidate = fixture.createdSessions.at(-1)!;
			expect(candidate).not.toBe(oldSession);
			await candidate.waitForDispose();
			expect(fixture.runtimeHost.session).toBe(oldSession);
			expect(fixture.runtimeHost.services).toBe(oldServices);
			expect(fixture.runtimeHost.runtimeComposition).toBe(oldComposition);
			expect(fixture.runtimeHost.diagnostics).toBe(oldDiagnostics);
			expect(oldDispose).not.toHaveBeenCalled();
			await oldSession.sendCustomMessage({
				customType: `matrix-${flow}-${fault}`,
				content: "old scope remains usable",
				display: false,
			});
			expect(oldSession.messages).toContainEqual(
				expect.objectContaining({ role: "custom", customType: `matrix-${flow}-${fault}` }),
			);
		},
	);

	it("exposes only whole old or new runtime scopes while readiness is pending", async () => {
		const fixture = await createRuntimeHost(() => undefined);
		const old = {
			session: fixture.runtimeHost.session,
			services: fixture.runtimeHost.services,
			composition: fixture.runtimeHost.runtimeComposition,
			diagnostics: fixture.runtimeHost.diagnostics,
		};
		const readinessEntered = createDeferred();
		const releaseReadiness = createDeferred();
		const observations: Array<typeof old> = [];
		const observe = (): void => {
			observations.push({
				session: fixture.runtimeHost.session,
				services: fixture.runtimeHost.services,
				composition: fixture.runtimeHost.runtimeComposition,
				diagnostics: fixture.runtimeHost.diagnostics,
			});
		};
		fixture.runtimeHost.setPrepareSessionRebind(() => ({
			commit: observe,
		}));

		const replacement = fixture.runtimeHost.newSession({
			setup: async () => {
				observe();
				readinessEntered.resolve();
				await releaseReadiness.promise;
				observe();
			},
		});
		await readinessEntered.promise;
		for (let index = 0; index < 10; index += 1) observe();
		expect(fixture.runtimeHost.session).toBe(old.session);
		releaseReadiness.resolve();
		await replacement;
		observe();
		const current = observations.at(-1)!;
		expect(current.session).not.toBe(old.session);

		for (const observation of observations) {
			const isWholeOld = observation.session === old.session &&
				observation.services === old.services &&
				observation.composition === old.composition &&
				observation.diagnostics === old.diagnostics;
			const isWholeNew = observation.session === current.session &&
				observation.services === current.services &&
				observation.composition === current.composition &&
				observation.diagnostics === current.diagnostics;
			expect(isWholeOld || isWholeNew).toBe(true);
		}
	});

	it("exposes only the usable old scope when an overlapping candidate fails", async () => {
		const fixture = await createRuntimeHost(() => undefined);
		const old = {
			session: fixture.runtimeHost.session,
			services: fixture.runtimeHost.services,
			composition: fixture.runtimeHost.runtimeComposition,
			diagnostics: fixture.runtimeHost.diagnostics,
		};
		const readinessEntered = createDeferred();
		const rejectReadiness = createDeferred();
		const observations: Array<typeof old> = [];
		const observe = (): void => {
			observations.push({
				session: fixture.runtimeHost.session,
				services: fixture.runtimeHost.services,
				composition: fixture.runtimeHost.runtimeComposition,
				diagnostics: fixture.runtimeHost.diagnostics,
			});
		};

		const replacement = fixture.runtimeHost.newSession({
			setup: async () => {
				readinessEntered.resolve();
				await rejectReadiness.promise;
				throw new Error("overlapping candidate fault");
			},
		});
		await readinessEntered.promise;
		for (let index = 0; index < 10; index += 1) observe();
		rejectReadiness.resolve();
		await expect(replacement).rejects.toThrow("overlapping candidate fault");
		observe();

		expect(observations.every((observation) =>
			observation.session === old.session &&
			observation.services === old.services &&
			observation.composition === old.composition &&
			observation.diagnostics === old.diagnostics
		)).toBe(true);
		await old.session.sendCustomMessage({
			customType: "overlap-old-usable",
			content: "old scope remains usable",
			display: false,
		});
	});

	it("rejects an old prompt whose async input preflight crosses the admission fence", async () => {
		const preflightEntered = createDeferred();
		const releasePreflight = createDeferred();
		const fixture = await createRuntimeHost((extension) => {
			extension.on("input", async (event) => {
				if (event.text !== "blocked old-scope prompt") return { action: "continue" };
				preflightEntered.resolve();
				await releasePreflight.promise;
				return { action: "continue" };
			});
		});
		const oldSession = fixture.runtimeHost.session;
		const promptFailure = oldSession.prompt("blocked old-scope prompt").then(
			() => undefined,
			(error: unknown) => error,
		);
		await preflightEntered.promise;

		const reload = fixture.runtimeHost.reload();
		await vi.waitFor(() => expect(fixture.runtimeHost.session).not.toBe(oldSession));
		releasePreflight.resolve();

		expect(await promptFailure).toMatchObject({ message: "Session scope transition is in progress" });
		await reload;
		expect(JSON.stringify(oldSession.sessionRead.getEntries())).not.toContain("blocked old-scope prompt");
	});

	it("drains an accepted async extension command before publishing reload", async () => {
		const commandEntered = createDeferred();
		const releaseCommand = createDeferred();
		const phases: string[] = [];
		let extensionInstance = 0;
		const fixture = await createRuntimeHost((extension) => {
			const instance = ++extensionInstance;
			extension.registerCommand("blocked-command", {
				description: "Blocked command fixture",
				handler: async () => {
					if (instance !== 1) return;
					phases.push("command-entered");
					commandEntered.resolve();
					await releaseCommand.promise;
					extension.appendEntry("fixture.command-after-release", { accepted: true });
					phases.push("command-finished");
				},
			});
		});
		const oldSession = fixture.runtimeHost.session;
		await oldSession.prompt("persist async command source");
		const command = oldSession.prompt("/blocked-command");
		await commandEntered.promise;
		const delegate: unknown = Reflect.get(oldSession, "delegate");
		if (typeof delegate !== "object" || delegate === null) throw new TypeError("Old Session delegate is unavailable");
		const activePromptTasks: unknown = Reflect.get(delegate, "activePromptTasks");
		if (!(activePromptTasks instanceof Set)) throw new TypeError("Active prompt task set is unavailable");
		expect(activePromptTasks.size).toBe(1);

		const abortEntered = createDeferred();
		const abort = oldSession.abort.bind(oldSession);
		vi.spyOn(oldSession, "abort").mockImplementation(async () => {
			phases.push("abort-entered");
			abortEntered.resolve();
			await abort();
			phases.push("abort-finished");
		});
		fixture.runtimeHost.setPrepareSessionRebind(() => ({
			commit: () => undefined,
			activate: () => {
				phases.push("candidate-activated");
			},
		}));
		let reloadSettled = false;
		const reload = fixture.runtimeHost.reload().finally(() => {
			reloadSettled = true;
		});
		await abortEntered.promise;

		expect(fixture.runtimeHost.session).toBe(oldSession);
		expect(reloadSettled).toBe(false);
		expect(activePromptTasks.size).toBe(1);
		releaseCommand.resolve();
		await Promise.all([command, reload]);

		expect(fixture.runtimeHost.session).not.toBe(oldSession);
		expect(phases).toEqual([
			"command-entered",
			"abort-entered",
			"command-finished",
			"abort-finished",
			"abort-entered",
			"abort-finished",
			"candidate-activated",
		]);
		const stored = readFileSync(fixture.runtimeHost.session.sessionFile!, "utf8");
		expect(stored.match(/fixture\.command-after-release/g)).toHaveLength(1);
	});

	it("allows an accepted extension command to initiate its own reload without deadlock", async () => {
		const phases: string[] = [];
		const fixture = await createRuntimeHost((extension) => {
			extension.registerCommand("self-reload", {
				description: "Command-owned reload fixture",
				handler: async (_args, context) => {
					phases.push("command-before-reload");
					await context.reload();
					phases.push("command-after-reload");
				},
			});
		});
		await bindRuntimeCommandActions(fixture);
		const oldSession = fixture.runtimeHost.session;
		await oldSession.prompt("persist command-owned reload source");
		const sessionCountBefore = fixture.createdSessions.length;

		const command = oldSession.prompt("/self-reload");
		await vi.waitFor(() => expect(fixture.runtimeHost.session).not.toBe(oldSession));
		await command;

		expect(fixture.createdSessions).toHaveLength(sessionCountBefore + 1);
		expect(phases).toEqual(["command-before-reload", "command-after-reload"]);
	});

	it("resumes command tracking when a command reload action is a no-op", async () => {
		const commandEntered = createDeferred();
		const releaseReloadCall = createDeferred();
		const reloadReturned = createDeferred();
		const releaseCommand = createDeferred();
		const fixture = await createRuntimeHost((extension) => {
			extension.registerCommand("noop-reload", {
				description: "No-op reload fixture",
				handler: async (_args, context) => {
					commandEntered.resolve();
					await releaseReloadCall.promise;
					await context.reload();
					reloadReturned.resolve();
					await releaseCommand.promise;
				},
			});
		});
		await bindRuntimeCommandActions(fixture, () => Promise.resolve());
		const oldSession = fixture.runtimeHost.session;
		const command = oldSession.prompt("/noop-reload");
		await commandEntered.promise;
		const delegate: unknown = Reflect.get(oldSession, "delegate");
		if (typeof delegate !== "object" || delegate === null) throw new TypeError("Old Session delegate is unavailable");
		const activePromptTasks: unknown = Reflect.get(delegate, "activePromptTasks");
		if (!(activePromptTasks instanceof Set)) throw new TypeError("Active prompt task set is unavailable");
		const drainIteration = createDeferred();
		const iterateActivePromptTasks = activePromptTasks[Symbol.iterator].bind(activePromptTasks);
		const activePromptTaskIterator = vi.spyOn(activePromptTasks, Symbol.iterator).mockImplementation(() => {
			drainIteration.resolve();
			return iterateActivePromptTasks();
		});
		let externalReloadSettled = false;
		const externalReload = fixture.runtimeHost.reload().finally(() => {
			externalReloadSettled = true;
		});
		await drainIteration.promise;
		releaseReloadCall.resolve();
		await reloadReturned.promise;
		expect(activePromptTasks.size).toBe(1);
		expect(fixture.runtimeHost.session).toBe(oldSession);
		expect(externalReloadSettled).toBe(false);
		releaseCommand.resolve();
		await Promise.all([command, externalReload]);
		expect(activePromptTaskIterator).toHaveBeenCalledTimes(2);
		expect(fixture.runtimeHost.session).not.toBe(oldSession);
	});

	it("rejects a queued stale command reload after an external reload wins", async () => {
		const commandEntered = createDeferred();
		const releaseCommand = createDeferred();
		const reloadRequested = createDeferred();
		let staleTransitionError: unknown;
		let lateWriteError: unknown;
		const fixture = await createRuntimeHost((extension) => {
			extension.registerCommand("losing-reload", {
				description: "External reload winner fixture",
				handler: async (_args, context) => {
					commandEntered.resolve();
					await releaseCommand.promise;
					reloadRequested.resolve();
					try {
						await context.reload();
					} catch (error) {
						staleTransitionError = error;
					}
					try {
						extension.appendEntry("fixture.late-old-command-write", { accepted: false });
					} catch (error) {
						lateWriteError = error;
					}
				},
			});
		});
		await bindRuntimeCommandActions(fixture);
		const oldSession = fixture.runtimeHost.session;
		await oldSession.prompt("persist external reload winner source");
		const sessionCountBefore = fixture.createdSessions.length;
		const command = oldSession.prompt("/losing-reload");
		await commandEntered.promise;
		const delegate: unknown = Reflect.get(oldSession, "delegate");
		if (typeof delegate !== "object" || delegate === null) throw new TypeError("Old Session delegate is unavailable");
		const activePromptTasks: unknown = Reflect.get(delegate, "activePromptTasks");
		if (!(activePromptTasks instanceof Set)) throw new TypeError("Active prompt task set is unavailable");
		expect(activePromptTasks.size).toBe(1);

		const abortEntered = createDeferred();
		const releaseAbort = createDeferred();
		const abort = oldSession.abort.bind(oldSession);
		vi.spyOn(oldSession, "abort").mockImplementation(async () => {
			abortEntered.resolve();
			await releaseAbort.promise;
			await abort();
		});
		const externalReload = fixture.runtimeHost.reload();
		await abortEntered.promise;
		releaseCommand.resolve();
		await reloadRequested.promise;
		await vi.waitFor(() => expect(activePromptTasks.size).toBe(0));
		expect(fixture.runtimeHost.session).toBe(oldSession);

		releaseAbort.resolve();
		await Promise.all([externalReload, command]);

		expect(fixture.runtimeHost.session).not.toBe(oldSession);
		expect(fixture.createdSessions).toHaveLength(sessionCountBefore + 1);
		expect(staleTransitionError).toMatchObject({
			message: "Extension command Session transition origin is no longer current",
		});
		expect(lateWriteError).toMatchObject({
			message: expect.stringContaining("stale after session replacement or reload"),
		});
		expect(readFileSync(fixture.runtimeHost.session.sessionFile!, "utf8")).not.toContain(
			"fixture.late-old-command-write",
		);
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((agent) => {
			agent.on("session_before_switch", (event) => {
				events.push(event);
			});
			agent.on("session_shutdown", (event) => {
				events.push(event);
			});
			agent.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((agent) => {
			agent.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			agent.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("keeps the old Session usable when prepared host binding fails", async () => {
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		const oldSession = runtimeHost.session;
		const oldAbort = vi.spyOn(oldSession, "abort");
		let candidateSession: typeof oldSession | undefined;
		runtimeHost.setPrepareSessionRebind(async (session) => {
			candidateSession = session;
			await session.prepareExtensionBindings({});
			throw new Error("candidate host binding fault");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("candidate host binding fault");

		expect(runtimeHost.session).toBe(oldSession);
		expect(oldAbort).not.toHaveBeenCalled();
		await oldSession.prompt("old session remains usable");
		expect(oldSession.getLastAssistantText()).toBe("one");
		expect(candidateSession).toBeDefined();
		await candidateSession?.waitForDispose();
	});

	it("uses one resolved path for tilde switch staging, opening, and rollback", async () => {
		const beforeSwitchTargets: Array<string | undefined> = [];
		const { runtimeHost } = await createRuntimeHost((agent) => {
			agent.on("session_before_switch", (event) => {
				beforeSwitchTargets.push(event.targetSessionFile);
			});
		});
		const homeTempDir = mkdtempSync(join(homedir(), "aos-runtime-switch-"));
		cleanups.push(() => rmSync(homeTempDir, { recursive: true, force: true }));
		const oldSession = runtimeHost.session;
		await oldSession.prompt("persist switch source");
		const targetPath = join(homeTempDir, "target.jsonl");
		copyFileSync(oldSession.sessionFile!, targetPath);
		const originalTarget = readFileSync(targetPath);
		const tildePath = `~/${basename(homeTempDir)}/target.jsonl`;
		runtimeHost.setPrepareSessionRebind(async (candidate) => {
			await candidate.prompt("mutate tilde candidate");
			throw new Error("tilde candidate host fault");
		});

		await expect(runtimeHost.switchSession(tildePath)).rejects.toThrow("tilde candidate host fault");

		expect(beforeSwitchTargets).toEqual([targetPath]);
		expect(readFileSync(targetPath)).toEqual(originalTarget);
		expect(runtimeHost.session).toBe(oldSession);
		await oldSession.prompt("old Session after tilde fault");
		expect(oldSession.getLastAssistantText()).toBe("three");
	});

	it("restores same-file switch storage when the candidate writes before failing", async () => {
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		const oldSession = runtimeHost.session;
		await oldSession.prompt("persist same-file source");
		const sessionFile = oldSession.sessionFile!;
		const originalEntries = structuredClone(oldSession.sessionRead.getEntries());
		const originalFile = readFileSync(sessionFile);
		let candidateSession: typeof oldSession | undefined;
		runtimeHost.setPrepareSessionRebind(async (candidate) => {
			candidateSession = candidate;
			await candidate.prompt("same-file candidate write");
			expect(readFileSync(sessionFile, "utf8")).not.toContain("same-file candidate write");
			throw new Error("same-file candidate host fault");
		});

		await expect(runtimeHost.switchSession(sessionFile)).rejects.toThrow("same-file candidate host fault");

		expect(candidateSession).toBeDefined();
		expect(candidateSession?.sessionRead).not.toBe(oldSession.sessionRead);
		expect(oldSession.sessionRead.getEntries()).toEqual(originalEntries);
		expect(readFileSync(sessionFile)).toEqual(originalFile);
		expect(runtimeHost.session).toBe(oldSession);
		await oldSession.prompt("old Session after same-file fault");
		expect(oldSession.getLastAssistantText()).toBe("three");
	});

	it("restores same-file import storage when the candidate writes before failing", async () => {
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		const oldSession = runtimeHost.session;
		await oldSession.prompt("persist same-file import source");
		const sessionFile = oldSession.sessionFile!;
		const originalFile = readFileSync(sessionFile);
		runtimeHost.setPrepareSessionRebind(async (candidate) => {
			await candidate.prompt("same-file import candidate write");
			expect(readFileSync(sessionFile, "utf8")).not.toContain("same-file import candidate write");
			throw new Error("same-file import host fault");
		});

		await expect(runtimeHost.importFromJsonl(sessionFile)).rejects.toThrow("same-file import host fault");

		expect(readFileSync(sessionFile)).toEqual(originalFile);
		expect(runtimeHost.session).toBe(oldSession);
		await oldSession.prompt("old Session after same-file import fault");
		expect(oldSession.getLastAssistantText()).toBe("three");
	});

	it("preserves a cwd override for a same-file detached switch", async () => {
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		const sessionFile = runtimeHost.session.sessionFile!;
		const overrideCwd = join(tmpdir(), `aos-runtime-override-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(overrideCwd, { recursive: true });
		cleanups.push(() => rmSync(overrideCwd, { recursive: true, force: true }));

		await runtimeHost.switchSession(sessionFile, { cwdOverride: overrideCwd });

		expect(runtimeHost.cwd).toBe(overrideCwd);
		expect(runtimeHost.session.sessionFile).toBe(sessionFile);
	});

	it("isolates reload storage and preserves concurrent old-scope writes when the candidate fails", async () => {
		const { runtimeHost, fake } = await createRuntimeHost(() => undefined);
		fake.setResponses([
			fakeAssistantMessage("one"),
			fakeAssistantMessage("two"),
			fakeAssistantMessage("three"),
			fakeAssistantMessage("four"),
		]);
		const oldSession = runtimeHost.session;
		await oldSession.prompt("persist reload source");
		const sessionFile = oldSession.sessionFile!;
		const originalEntries = structuredClone(oldSession.sessionRead.getEntries());
		const originalFile = readFileSync(sessionFile);
		let candidateSession: typeof oldSession | undefined;
		const candidateWritten = createDeferred();
		const failCandidate = createDeferred();
		runtimeHost.setPrepareSessionRebind(async (candidate) => {
			candidateSession = candidate;
			await candidate.prompt("reload candidate write");
			candidateWritten.resolve();
			await failCandidate.promise;
			throw new Error("reload candidate host fault");
		});

		const reloadResult = runtimeHost.reload();
		await candidateWritten.promise;
		expect(readFileSync(sessionFile, "utf8")).not.toContain("reload candidate write");
		await oldSession.prompt("concurrent old Session write");
		const entriesAfterOldWrite = structuredClone(oldSession.sessionRead.getEntries());
		failCandidate.resolve();
		await expect(reloadResult).rejects.toThrow("reload candidate host fault");

		expect(candidateSession).toBeDefined();
		expect(candidateSession?.sessionRead).not.toBe(oldSession.sessionRead);
		expect(entriesAfterOldWrite.length).toBeGreaterThan(originalEntries.length);
		expect(oldSession.sessionRead.getEntries()).toEqual(entriesAfterOldWrite);
		const restoredFile = readFileSync(sessionFile, "utf8");
		expect(restoredFile).toContain("concurrent old Session write");
		expect(restoredFile).not.toContain("reload candidate write");
		expect(Buffer.byteLength(restoredFile)).toBeGreaterThan(originalFile.byteLength);
		expect(runtimeHost.session).toBe(oldSession);
		await oldSession.prompt("old Session after reload fault");
		expect(oldSession.getLastAssistantText()).toBe("four");
	});

	it("commits same-file reload through one writer and merges accepted old-scope writes", async () => {
		const { runtimeHost, fake } = await createRuntimeHost(() => undefined);
		fake.setResponses([
			fakeAssistantMessage("one"),
			fakeAssistantMessage("two"),
			fakeAssistantMessage("three"),
		]);
		const oldSession = runtimeHost.session;
		await oldSession.prompt("persist reload success source");
		const sessionFile = oldSession.sessionFile!;
		const candidateWritten = createDeferred();
		const releaseCandidate = createDeferred();
		runtimeHost.setPrepareSessionRebind(async (candidate) => {
			await candidate.prompt("staged reload candidate write");
			candidateWritten.resolve();
			await releaseCandidate.promise;
			return { commit: () => undefined };
		});

		const reloadResult = runtimeHost.reload();
		await candidateWritten.promise;
		expect(readFileSync(sessionFile, "utf8")).not.toContain("staged reload candidate write");
		await oldSession.prompt("accepted old write during reload");
		releaseCandidate.resolve();
		await reloadResult;

		const currentEntries = runtimeHost.session.sessionRead.getEntries();
		const stored = readFileSync(sessionFile, "utf8");
		const storedPhysicalEntries = `${stored.split("\n").filter((line) => line.length > 0).slice(1).join("\n")}\n`;
		const scope = Reflect.get(runtimeHost, "currentScope");
		if (!(scope instanceof CurrentSessionScope)) throw new TypeError("Current Session scope is unavailable");
		const currentManager = Reflect.get(scope.current, "sessionManager");
		if (!(currentManager instanceof SessionManager)) throw new TypeError("Current Session writer is unavailable");
		const branchUserText = runtimeHost.session.sessionRead.getBranch().flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			if (typeof entry.message.content === "string") return [entry.message.content];
			return entry.message.content.flatMap((block) => block.type === "text" ? [block.text] : []);
		});
		const contextUserText = runtimeHost.session.sessionRead.buildSessionContext().messages.flatMap((message) => {
			if (message.role !== "user") return [];
			if (typeof message.content === "string") return [message.content];
			return message.content.flatMap((block) => block.type === "text" ? [block.text] : []);
		});
		expect(runtimeHost.session).not.toBe(oldSession);
		expect(branchUserText).toEqual([
			"persist reload success source",
			"accepted old write during reload",
			"staged reload candidate write",
		]);
		expect(contextUserText).toEqual(branchUserText);
		expect(JSON.stringify(currentEntries)).toContain("accepted old write during reload");
		expect(JSON.stringify(currentEntries)).toContain("staged reload candidate write");
		expect(stored).toContain("accepted old write during reload");
		expect(stored).toContain("staged reload candidate write");
		expect(`${currentManager.getPhysicalEntries().map((entry) => JSON.stringify(entry)).join("\n")}\n`).toBe(
			storedPhysicalEntries,
		);
	});

	for (const flow of ["switch", "import"] as const) {
		it(`commits same-file ${flow} through the detached writer`, async () => {
			const { runtimeHost, fake } = await createRuntimeHost(() => undefined);
			fake.setResponses([
				fakeAssistantMessage("one"),
				fakeAssistantMessage("two"),
				fakeAssistantMessage("three"),
			]);
			const oldSession = runtimeHost.session;
			await oldSession.prompt(`persist same-file ${flow} source`);
			const sessionFile = oldSession.sessionFile!;
			const candidateWritten = createDeferred();
			const releaseCandidate = createDeferred();
			runtimeHost.setPrepareSessionRebind(async (candidate) => {
				await candidate.prompt(`staged same-file ${flow} candidate write`);
				candidateWritten.resolve();
				await releaseCandidate.promise;
				return { commit: () => undefined };
			});

			const transition = flow === "switch"
				? runtimeHost.switchSession(sessionFile)
				: runtimeHost.importFromJsonl(sessionFile);
			await candidateWritten.promise;
			expect(readFileSync(sessionFile, "utf8")).not.toContain(`staged same-file ${flow} candidate write`);
			await oldSession.prompt(`accepted old write during same-file ${flow}`);
			releaseCandidate.resolve();
			await transition;

			const stored = readFileSync(sessionFile, "utf8");
			expect(stored).toContain(`accepted old write during same-file ${flow}`);
			expect(stored).toContain(`staged same-file ${flow} candidate write`);
			expect(JSON.stringify(runtimeHost.session.sessionRead.getBranch())).toContain(
				`accepted old write during same-file ${flow}`,
			);
		});
	}

	it("fences non-prompt writes after the old canonical drain", async () => {
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		const oldSession = runtimeHost.session;
		await oldSession.prompt("persist write-fence source");
		const baseEntry = oldSession.sessionRead.getEntries().find((entry) => entry.type === "message");
		if (baseEntry === undefined) throw new Error("Expected a base entry for the write-fence test");
		const candidateDrainEntered = createDeferred();
		const releaseCandidateDrain = createDeferred();
		runtimeHost.setPrepareSessionRebind((candidate) => {
			const delegate: unknown = Reflect.get(candidate, "delegate");
			if (typeof delegate !== "object" || delegate === null) throw new TypeError("Candidate delegate is unavailable");
			const candidateStorage: unknown = Reflect.get(delegate, "canonicalStorage");
			if (
				typeof candidateStorage !== "object" ||
				candidateStorage === null ||
				!("drain" in candidateStorage) ||
				typeof candidateStorage.drain !== "function"
			) {
				throw new TypeError("Candidate canonical storage is unavailable");
			}
			const checkedStorage = candidateStorage as { drain(): Promise<void> };
			const drain = checkedStorage.drain.bind(checkedStorage);
			vi.spyOn(checkedStorage, "drain").mockImplementation(async () => {
				candidateDrainEntered.resolve();
				await releaseCandidateDrain.promise;
				await drain();
			});
			return { commit: () => undefined };
		});

		const reload = runtimeHost.reload();
		await candidateDrainEntered.promise;
		expect(() => oldSession.setSessionLabel(baseEntry.id, "late fenced label")).toThrow(
			"Session scope no longer accepts writes",
		);
		releaseCandidateDrain.resolve();
		await reload;
		expect(readFileSync(runtimeHost.session.sessionFile!, "utf8")).not.toContain("late fenced label");
	});

	it("disposes a registered partial Session and removes its artifact when construction fails", async () => {
		const {
			runtimeHost,
			failConstructionAfterAllocation,
			getFailedConstructionSession,
		} = await createRuntimeHost(() => undefined);
		const oldSession = runtimeHost.session;
		failConstructionAfterAllocation();

		await expect(runtimeHost.newSession()).rejects.toThrow("construction after allocation fault");

		const failedSession = getFailedConstructionSession();
		expect(failedSession).toBeDefined();
		await failedSession?.waitForDispose();
		expect(failedSession?.sessionFile).toBeTruthy();
		expect(existsSync(failedSession!.sessionFile!)).toBe(false);
		expect(runtimeHost.session).toBe(oldSession);
		await oldSession.prompt("old Session after construction fault");
		expect(oldSession.getLastAssistantText()).toBe("two");
	});

	it("removes a new-session artifact after candidate host preparation fails", async () => {
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		const oldSession = runtimeHost.session;
		let candidateFile: string | undefined;
		runtimeHost.setPrepareSessionRebind(() => {
			throw new Error("new candidate host fault");
		});

		await expect(runtimeHost.newSession({
			setup: async (candidate) => {
				await candidate.prompt("persist new candidate");
				candidateFile = candidate.sessionFile;
			},
		})).rejects.toThrow("new candidate host fault");

		expect(candidateFile).toBeTruthy();
		expect(existsSync(candidateFile!)).toBe(false);
		expect(runtimeHost.session).toBe(oldSession);
		await oldSession.prompt("old Session after new fault");
		expect(oldSession.getLastAssistantText()).toBe("two");
	});

	it("removes a fork artifact after candidate host preparation fails", async () => {
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		const oldSession = runtimeHost.session;
		await oldSession.prompt("fork source");
		const entryId = oldSession.getUserMessagesForForking()[0]!.entryId;
		let candidateFile: string | undefined;
		runtimeHost.setPrepareSessionRebind((_candidate) => {
			candidateFile = _candidate.sessionFile;
			throw new Error("fork candidate host fault");
		});

		await expect(runtimeHost.fork(entryId)).rejects.toThrow("fork candidate host fault");

		expect(candidateFile).toBeTruthy();
		expect(existsSync(candidateFile!)).toBe(false);
		expect(runtimeHost.session).toBe(oldSession);
		await oldSession.prompt("old Session after fork fault");
		expect(oldSession.getLastAssistantText()).toBe("two");
	});

	it("preserves an existing import target and removes the failed candidate copy", async () => {
		const { runtimeHost, tempDir } = await createRuntimeHost(() => undefined);
		const oldSession = runtimeHost.session;
		await oldSession.prompt("import source");
		const sourceDir = join(tempDir, "import-source");
		mkdirSync(sourceDir, { recursive: true });
		const inputPath = join(sourceDir, "collision.jsonl");
		copyFileSync(oldSession.sessionFile!, inputPath);
		const existingTarget = join(oldSession.sessionRead.getSessionDir(), "collision.jsonl");
		writeFileSync(existingTarget, "existing target sentinel");
		let candidateFile: string | undefined;
		runtimeHost.setPrepareSessionRebind((candidate) => {
			candidateFile = candidate.sessionFile;
			throw new Error("import candidate host fault");
		});

		await expect(runtimeHost.importFromJsonl(inputPath)).rejects.toThrow("import candidate host fault");

		expect(readFileSync(existingTarget, "utf8")).toBe("existing target sentinel");
		expect(candidateFile).toBeTruthy();
		expect(candidateFile).not.toBe(existingTarget);
		expect(existsSync(candidateFile!)).toBe(false);
		expect(runtimeHost.session).toBe(oldSession);
		await oldSession.prompt("old Session after import fault");
		expect(oldSession.getLastAssistantText()).toBe("two");
	});

	it("records withSession failures as post-commit diagnostics", async () => {
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		const previousSession = runtimeHost.session;

		await expect(runtimeHost.newSession({
			withSession: async () => {
				throw new Error("withSession callback fault");
			},
		})).resolves.toEqual({ cancelled: false });

		expect(runtimeHost.session).not.toBe(previousSession);
		expect(runtimeHost.diagnostics).toContainEqual({
			type: "warning",
			message: "Session scope with session failed after commit: withSession callback fault",
		});
	});

	it("runs beforeSessionInvalidate after session_shutdown and before candidate activation", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((agent) => {
			agent.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionRead.getCwd());
		});
		runtimeHost.setPrepareSessionRebind(async (session) => {
			await session.prepareExtensionBindings({});
			return {
				commit: () => undefined,
				activate: async () => {
					phases.push("candidateActivation");
					await session.activateExtensionBindings();
				},
			};
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "candidateActivation"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured agent or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setPrepareSessionRebind(undefined);
	});

	it("replaces the Session scope and preserves reload event order", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((agent) => {
			agent.on("session_shutdown", (event) => {
				events.push(event);
			});
			agent.on("session_start", (event) => {
				events.push(event);
			});
		});
		const previousSession = runtimeHost.session;
		events.length = 0;
		runtimeHost.setPrepareSessionRebind(async (session) => {
			await session.prepareExtensionBindings({});
			return {
				commit: () => undefined,
				activate: () => session.activateExtensionBindings(),
			};
		});

		await runtimeHost.reload();

		expect(runtimeHost.session).not.toBe(previousSession);
		expect(events).toEqual([
			{ type: "session_shutdown", reason: "reload", targetSessionFile: undefined },
			{ type: "session_start", reason: "reload" },
		]);
		runtimeHost.setPrepareSessionRebind(undefined);
	});

	it("routes public AgentSession.reload through the owning runtime transaction", async () => {
		const { runtimeHost } = await createRuntimeHost(() => undefined);
		const previousSession = runtimeHost.session;

		await previousSession.reload();

		expect(runtimeHost.session).not.toBe(previousSession);
		await previousSession.waitForDispose();
		await expect(previousSession.reload()).rejects.toThrow("AgentSession is no longer the current runtime scope");
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((agent) => {
			agent.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			agent.on("session_shutdown", (event) => {
				events.push(event);
			});
			agent.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
