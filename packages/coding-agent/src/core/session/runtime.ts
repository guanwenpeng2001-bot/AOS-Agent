import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type {
	AgentRuntimeComposition,
	AgentRuntimeCompositionFactory,
} from "../runtime/composition-factory.ts";
import {
	CurrentSessionScope,
	type PreparedSessionScopeRebind,
	type SessionScopePostCommitFailure,
} from "./current-scope.ts";
import {
	bindAgentSessionRuntimeReload,
	createAgentSessionForkTarget,
	drainAgentSessionWrites,
	getAgentSessionTransitionOrigin,
	pauseAgentSessionAdmission,
	resumeAgentSessionAdmission,
	useAgentSessionForkTarget,
} from "./facade.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../extensions/index.ts";
import { emitSessionShutdownEvent } from "../extensions/runner.ts";
import type { CreateAgentSessionResult } from "../runtime/sdk.ts";
import { assertSessionCwdExists } from "./cwd.ts";
import { createSessionManagerForOptions, type SessionCreationOptions } from "./creation.ts";
import { SessionManager } from "./manager.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
	/** Transfer ownership immediately after the factory allocates an AgentSession. */
	registerCandidateSession(session: AgentSession): void;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

interface AgentSessionScope {
	session: AgentSession;
	services: AgentSessionServices;
	sessionManager: SessionManager;
	runtimeComposition: AgentRuntimeComposition;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	modelFallbackMessage?: string;
}

interface ReplaceSessionScopeOptions {
	sessionManager: SessionManager;
	cwd: string;
	sessionStartEvent: SessionStartEvent;
	shutdownReason: SessionShutdownEvent["reason"];
	targetSessionFile?: string;
	projectTrustContext?: ProjectTrustContext;
	setup?: (session: AgentSession) => void | Promise<void>;
	beforeSessionStart?: () => void | Promise<void>;
	/** Post-commit continuation; failures become diagnostics and never imply rollback. */
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	candidateArtifact?: CandidateSessionArtifact;
}

interface CandidateSessionArtifact {
	commit(): void;
	rollback(): void;
}

function failureWithCleanup(error: unknown, cleanupFailures: readonly unknown[], message: string): unknown {
	if (cleanupFailures.length === 0) return error;
	return new AggregateError([error, ...cleanupFailures], message);
}

async function createRuntimeWithCandidateOwnership(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: Omit<Parameters<CreateAgentSessionRuntimeFactory>[0], "registerCandidateSession">,
): Promise<CreateAgentSessionRuntimeResult> {
	const ownedSessions = new Set<AgentSession>();
	let registeredSession: AgentSession | undefined;
	let registrationCount = 0;
	try {
		const result = await createRuntime({
			...options,
			registerCandidateSession: (session) => {
				registrationCount += 1;
				ownedSessions.add(session);
				if (registrationCount > 1) throw new TypeError("Runtime factory registered more than one candidate Session");
				registeredSession = session;
			},
		});
		ownedSessions.add(result.session);
		if (registrationCount === 0) {
			throw new TypeError("Runtime factory must register its candidate Session before returning");
		}
		if (registeredSession !== result.session) {
			throw new TypeError("Runtime factory returned a different Session than its registered candidate");
		}
		return result;
	} catch (error) {
		const cleanup = await Promise.allSettled(Array.from(ownedSessions, (session) => session.dispose()));
		const cleanupFailures = cleanup
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason);
		throw failureWithCleanup(error, cleanupFailures, "Runtime construction and candidate Session cleanup failed");
	}
}

/**
 * Owns the single current AgentSession scope pointer.
 *
 * Replacements prepare an invisible candidate, atomically swap this pointer,
 * then clean up the old scope. Pre-commit failures leave the old scope usable.
 */
export class AgentSessionRuntime {
	private prepareSessionRebind?: (
		session: AgentSession,
		previousSession: AgentSession,
	) => PreparedSessionScopeRebind | Promise<PreparedSessionScopeRebind>;
	private beforeSessionInvalidate?: () => void;
	private readonly currentScope: CurrentSessionScope<AgentSessionScope>;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly runtimeCompositionFactory: AgentRuntimeCompositionFactory;
	private shutdownAdmissionClosed = false;
	private transitionTail: Promise<void> = Promise.resolve();

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		sessionManager: SessionManager,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this.createRuntime = createRuntime;
		this.runtimeCompositionFactory = _services.runtimeComposition;
		if (_session.agentRuntimeComposition.factory !== this.runtimeCompositionFactory) {
			throw new TypeError("Initial runtime must derive from the services runtime composition");
		}
		this.currentScope = new CurrentSessionScope({
			session: _session,
			services: _services,
			sessionManager,
			runtimeComposition: _session.agentRuntimeComposition,
			diagnostics: _diagnostics,
			...(_modelFallbackMessage === undefined ? {} : { modelFallbackMessage: _modelFallbackMessage }),
		});
		this.bindPublicReload(_session);
	}

	get services(): AgentSessionServices {
		return this.currentScope.current.services;
	}

	get session(): AgentSession {
		return this.currentScope.current.session;
	}

	setSessionArchived(sessionPath: string, archived: boolean): ReturnType<SessionManager["setArchived"]> {
		const currentManager = this.currentScope.current.sessionManager;
		const currentPath = currentManager.getSessionFile();
		if (currentPath !== undefined && resolve(currentPath) === resolve(sessionPath)) {
			return currentManager.setArchived(archived);
		}
		return SessionManager.setArchived(sessionPath, archived);
	}

	get runtimeComposition(): AgentRuntimeComposition {
		return this.currentScope.current.runtimeComposition;
	}

	get cwd(): string {
		return this.currentScope.current.services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this.currentScope.current.diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this.currentScope.current.modelFallbackMessage;
	}

	/**
	 * Prepare every fallible host binding while the candidate is private. The
	 * returned commit may publish references and fences only and must not throw.
	 */
	setPrepareSessionRebind(
		prepareSessionRebind?: (
			session: AgentSession,
			previousSession: AgentSession,
		) => PreparedSessionScopeRebind | Promise<PreparedSessionScopeRebind>,
	): void {
		this.prepareSessionRebind = prepareSessionRebind;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	/** Synchronously fence prompts and Session transitions before process cleanup starts. */
	closeAdmissionForShutdown(): void {
		if (this.shutdownAdmissionClosed) return;
		pauseAgentSessionAdmission(this.session);
		this.shutdownAdmissionClosed = true;
	}

	/**
	 * Move accepted work toward the canonical abort/recovery boundary before
	 * fallible extension and provider disposal. The process coordinator bounds
	 * this promise; restart recovery still derives from facts persisted earlier.
	 */
	async handoffShutdownRecovery(): Promise<void> {
		await this.session.abort();
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async disposeReplacedScope(
		scope: AgentSessionScope,
		reason: SessionShutdownEvent["reason"],
		signal: AbortSignal,
		targetSessionFile?: string,
	): Promise<void> {
		const failures: unknown[] = [];
		try {
			await scope.session.abort();
		} catch (error) {
			failures.push(error);
		}
		try {
			await emitSessionShutdownEvent(scope.session.extensionRunner, {
				type: "session_shutdown",
				reason,
				targetSessionFile,
			});
		} catch (error) {
			failures.push(error);
		}
		if (!signal.aborted) {
			try {
				this.beforeSessionInvalidate?.();
			} catch (error) {
				failures.push(error);
			}
		}
		try {
			await scope.session.dispose();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Old session scope cleanup failed");
	}

	private scopeFromResult(
		result: CreateAgentSessionRuntimeResult,
		sessionManager: SessionManager,
	): AgentSessionScope {
		const scope = {
			session: result.session,
			services: result.services,
			sessionManager,
			runtimeComposition: result.runtimeComposition,
			diagnostics: result.diagnostics,
			...(result.modelFallbackMessage === undefined ? {} : { modelFallbackMessage: result.modelFallbackMessage }),
		};
		this.bindPublicReload(scope.session);
		return scope;
	}

	private bindPublicReload(session: AgentSession): void {
		bindAgentSessionRuntimeReload(session, (options) => {
			if (this.session !== session) throw new Error("AgentSession is no longer the current runtime scope");
			return this.reload(options);
		});
	}

	private openSessionCandidate(
		sessionPath: string,
		sessionDir: string | undefined,
		cwdOverride: string | undefined,
		previousManager: SessionManager,
	): SessionManager {
		const previousSessionFile = previousManager.getSessionFile();
		if (previousSessionFile === undefined || resolve(previousSessionFile) !== resolve(sessionPath)) {
			return SessionManager.open(sessionPath, sessionDir, cwdOverride);
		}
		return previousManager.createDetachedSnapshot(cwdOverride);
	}

	private validateCandidateScope(candidate: AgentSessionScope): void {
		if (
			candidate.services.runtimeComposition !== this.runtimeCompositionFactory ||
			candidate.runtimeComposition.factory !== this.runtimeCompositionFactory ||
			candidate.session.agentRuntimeComposition !== candidate.runtimeComposition
		) {
			throw new TypeError("Replacement runtime must derive from the original runtime composition");
		}
	}

	private recordPostCommitFailures(failures: readonly SessionScopePostCommitFailure[]): void {
		for (const failure of failures) {
			const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
			this.currentScope.current.diagnostics.push({
				type: "warning",
				message: `Session scope ${failure.phase.replaceAll("_", " ")} failed after commit: ${message}`,
			});
		}
	}

	private runTransition<TResult>(
		transition: () => Promise<TResult>,
		allowDuringShutdown = false,
	): Promise<TResult> {
		if (this.shutdownAdmissionClosed && !allowDuringShutdown) {
			return Promise.reject(new Error("AgentSessionRuntime is shutting down"));
		}
		const originatingSession = getAgentSessionTransitionOrigin();
		const execute = (): Promise<TResult> => {
			if (this.shutdownAdmissionClosed && !allowDuringShutdown) {
				throw new Error("AgentSessionRuntime is shutting down");
			}
			if (originatingSession !== undefined && this.session !== originatingSession) {
				throw new Error("Extension command Session transition origin is no longer current");
			}
			return transition();
		};
		const result = this.transitionTail.then(execute, execute);
		this.transitionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async replaceCurrentScope(options: ReplaceSessionScopeOptions): Promise<void> {
		let transition: Awaited<ReturnType<CurrentSessionScope<AgentSessionScope>["replace"]>>;
		let previousAdmissionPaused = false;
		let candidateAdmissionPaused = false;
		let previousWritesPaused = false;
		let candidateWritesPaused = false;
		let sameFileTransition = false;
		try {
			transition = await this.currentScope.replace({
				construct: async (previous) => {
					return this.scopeFromResult(
						await createRuntimeWithCandidateOwnership(this.createRuntime, {
							cwd: options.cwd,
							agentDir: previous.services.agentDir,
							sessionManager: options.sessionManager,
							sessionStartEvent: options.sessionStartEvent,
							projectTrustContext: options.projectTrustContext,
						}),
						options.sessionManager,
					);
				},
				validate: (candidate) => this.validateCandidateScope(candidate),
				checkReadiness: async (candidate) => {
					await options.setup?.(candidate.session);
					await candidate.session.whenCapabilitiesReady();
				},
				prepareRebind: (candidate, previous) => this.prepareSessionRebind?.(
					candidate.session,
					previous.session,
				) ?? { commit: () => undefined },
				beforeCommit: async (candidate, previous) => {
					pauseAgentSessionAdmission(previous.session);
					previousAdmissionPaused = true;
					await previous.session.abort();
					await drainAgentSessionWrites(previous.session);
					previous.sessionManager.pauseWrites();
					previousWritesPaused = true;
					pauseAgentSessionAdmission(candidate.session);
					candidateAdmissionPaused = true;
					await drainAgentSessionWrites(candidate.session);
					candidate.sessionManager.pauseWrites();
					candidateWritesPaused = true;
				},
				commit: (candidate, previous) => {
					sameFileTransition = candidate.sessionManager.isDetachedSnapshotOf(previous.sessionManager);
					if (sameFileTransition) {
						candidate.sessionManager.commitDetachedSnapshot(previous.sessionManager);
					}
					options.candidateArtifact?.commit();
				},
				rollbackPreCommit: (candidate, previous) => {
					if (candidateWritesPaused) {
						candidate.sessionManager.resumeWrites();
						candidateWritesPaused = false;
					}
					if (previousWritesPaused) {
						previous.sessionManager.resumeWrites();
						previousWritesPaused = false;
					}
					if (!previousAdmissionPaused || this.shutdownAdmissionClosed) return;
					resumeAgentSessionAdmission(previous.session);
					previousAdmissionPaused = false;
				},
				stopPreviousAdmission: (candidate, previous) => {
					previous.sessionManager.retireWrites();
					previous.sessionManager.resumeWrites();
					previousWritesPaused = false;
					candidate.sessionManager.resumeWrites();
					candidateWritesPaused = false;
					if (candidateAdmissionPaused && !this.shutdownAdmissionClosed) {
						resumeAgentSessionAdmission(candidate.session);
						candidateAdmissionPaused = false;
					}
				},
				disposeCandidate: async (candidate) => candidate.session.dispose(),
				disposePrevious: (previous, signal) => this.disposeReplacedScope(
					previous,
					options.shutdownReason,
					signal,
					options.targetSessionFile,
				),
				afterPreviousDisposed: (_candidate, previous) => {
					previous.sessionManager.pauseWrites();
				},
				beforeActivate: options.beforeSessionStart,
			});
		} catch (error) {
			const cleanupFailures: unknown[] = [];
			try {
				options.candidateArtifact?.rollback();
			} catch (cleanupError) {
				cleanupFailures.push(cleanupError);
			}
			throw failureWithCleanup(error, cleanupFailures, "Session transition and candidate artifact rollback failed");
		}

		const postCommitFailures = [...transition.postCommitFailures];
		if (options.withSession) {
			try {
				await options.withSession(this.session.createReplacedSessionContext());
			} catch (error) {
				postCommitFailures.push({ phase: "with_session", error });
			}
		}
		this.recordPostCommitFailures(postCommitFailures);
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		return this.runTransition(async () => {
			const resolvedSessionPath = resolvePath(sessionPath);
			const beforeResult = await this.emitBeforeSwitch("resume", resolvedSessionPath);
			if (beforeResult.cancelled) return beforeResult;

			const previousSessionFile = this.session.sessionFile;
			const previousManager = this.currentScope.current.sessionManager;
			const candidateArtifact = SessionManager.stageArtifactRollback(
				resolvedSessionPath,
				previousSessionFile !== undefined && resolve(previousSessionFile) === resolvedSessionPath
					? previousManager
					: undefined,
			);
			try {
				const sessionManager = this.openSessionCandidate(
					resolvedSessionPath,
					undefined,
					options?.cwdOverride,
					previousManager,
				);
				assertSessionCwdExists(sessionManager, this.cwd);
				await this.replaceCurrentScope({
					cwd: sessionManager.getCwd(),
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
					shutdownReason: "resume",
					targetSessionFile: sessionManager.getSessionFile(),
					projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
					withSession: options?.withSession,
					candidateArtifact,
				});
			} catch (error) {
				const cleanupFailures: unknown[] = [];
				try {
					candidateArtifact?.rollback();
				} catch (cleanupError) {
					cleanupFailures.push(cleanupError);
				}
				throw failureWithCleanup(error, cleanupFailures, "Session switch and candidate artifact rollback failed");
			}
			return { cancelled: false };
		});
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (session: AgentSession) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		return this.runTransition(async () => {
			const beforeResult = await this.emitBeforeSwitch("new");
			if (beforeResult.cancelled) return beforeResult;

			const previousSessionFile = this.session.sessionFile;
			const sessionDir = this.session.sessionRead.getSessionDir();
			const sessionManager = this.session.sessionRead.isPersisted()
				? SessionManager.create(this.cwd, sessionDir, { parentSession: options?.parentSession })
				: SessionManager.inMemory(this.cwd, { parentSession: options?.parentSession });
			const candidateArtifact = SessionManager.stageArtifactRollback(sessionManager.getSessionFile());

			await this.replaceCurrentScope({
				cwd: this.cwd,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
				shutdownReason: "new",
				targetSessionFile: sessionManager.getSessionFile(),
				setup: options?.setup,
				withSession: options?.withSession,
				candidateArtifact,
			});
			return { cancelled: false };
		});
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.runTransition(async () => {
			const position = options?.position ?? "before";
			const beforeResult = await this.emitBeforeFork(entryId, { position });
			if (beforeResult.cancelled) return { cancelled: true };
			const previousSessionFile = this.session.sessionFile;
			let candidateArtifact: CandidateSessionArtifact | undefined;
			let forked: Awaited<ReturnType<typeof createAgentSessionForkTarget>>;
			try {
				forked = await createAgentSessionForkTarget(this.session, entryId, position, (sessionFile) => {
					candidateArtifact = SessionManager.stageArtifactRollback(sessionFile);
				});
				await useAgentSessionForkTarget(forked, (sessionManager) => this.replaceCurrentScope({
					cwd: this.cwd,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					shutdownReason: "fork",
					targetSessionFile: forked.sessionFile,
					withSession: options?.withSession,
					candidateArtifact,
				}));
			} catch (error) {
				const cleanupFailures: unknown[] = [];
				try {
					candidateArtifact?.rollback();
				} catch (cleanupError) {
					cleanupFailures.push(cleanupError);
				}
				throw failureWithCleanup(error, cleanupFailures, "Session fork and candidate artifact rollback failed");
			}
			return {
				cancelled: false,
				...(forked.selectedText === undefined ? {} : { selectedText: forked.selectedText }),
			};
		});
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.runTransition(async () => {
			const resolvedPath = resolvePath(inputPath);
			if (!existsSync(resolvedPath)) throw new SessionImportFileNotFoundError(resolvedPath);

			const sessionDir = this.session.sessionRead.getSessionDir();
			if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

			const preferredDestinationPath = join(sessionDir, basename(resolvedPath));
			const destinationPath = resolve(preferredDestinationPath) !== resolvedPath && existsSync(preferredDestinationPath)
				? join(sessionDir, `import-${randomUUID()}-${basename(resolvedPath)}`)
				: preferredDestinationPath;
			const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
			if (beforeResult.cancelled) return beforeResult;

			const previousSessionFile = this.session.sessionFile;
			const previousManager = this.currentScope.current.sessionManager;
			const candidateArtifact = SessionManager.stageArtifactRollback(
				destinationPath,
				previousSessionFile !== undefined && resolve(previousSessionFile) === resolve(destinationPath)
					? previousManager
					: undefined,
			);
			try {
				if (resolve(destinationPath) !== resolvedPath) copyFileSync(resolvedPath, destinationPath);

				const sessionManager = this.openSessionCandidate(
					destinationPath,
					sessionDir,
					cwdOverride,
					previousManager,
				);
				assertSessionCwdExists(sessionManager, this.cwd);
				await this.replaceCurrentScope({
					cwd: sessionManager.getCwd(),
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
					shutdownReason: "resume",
					targetSessionFile: sessionManager.getSessionFile(),
					candidateArtifact,
				});
			} catch (error) {
				const cleanupFailures: unknown[] = [];
				try {
					candidateArtifact?.rollback();
				} catch (cleanupError) {
					cleanupFailures.push(cleanupError);
				}
				throw failureWithCleanup(error, cleanupFailures, "Session import and candidate artifact rollback failed");
			}
			return { cancelled: false };
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		return this.runTransition(async () => {
			const previousManager = this.currentScope.current.sessionManager;
			const candidateArtifact = SessionManager.stageArtifactRollback(previousManager.getSessionFile(), previousManager);
			try {
				await this.replaceCurrentScope({
					cwd: this.cwd,
					sessionManager: previousManager.createDetachedSnapshot(),
					sessionStartEvent: { type: "session_start", reason: "reload" },
					shutdownReason: "reload",
					beforeSessionStart: options?.beforeSessionStart,
					candidateArtifact,
				});
			} catch (error) {
				const cleanupFailures: unknown[] = [];
				try {
					candidateArtifact?.rollback();
				} catch (cleanupError) {
					cleanupFailures.push(cleanupError);
				}
				throw failureWithCleanup(error, cleanupFailures, "Session reload and candidate artifact rollback failed");
			}
		});
	}

	async dispose(): Promise<void> {
		this.closeAdmissionForShutdown();
		return this.runTransition(async () => {
			await emitSessionShutdownEvent(this.session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
			this.beforeSessionInvalidate?.();
			await this.session.dispose();
		}, true);
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd?: string;
		agentDir: string;
		session?: SessionCreationOptions;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	const { cwd, sessionManager } = createSessionManagerForOptions(options);
	return createAgentSessionRuntimeFromManager(createRuntime, {
		cwd,
		agentDir: options.agentDir,
		sessionManager,
		sessionStartEvent: options.sessionStartEvent,
	});
}

/** @internal Creates a runtime around a host-owned physical store. */
export async function createAgentSessionRuntimeFromManager(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntimeWithCandidateOwnership(createRuntime, options);
	try {
		return new AgentSessionRuntime(
			result.session,
			result.services,
			createRuntime,
			options.sessionManager,
			result.diagnostics,
			result.modelFallbackMessage,
		);
	} catch (error) {
		const cleanupFailures: unknown[] = [];
		try {
			await result.session.dispose();
		} catch (cleanupError) {
			cleanupFailures.push(cleanupError);
		}
		throw failureWithCleanup(error, cleanupFailures, "Initial runtime validation and Session cleanup failed");
	}
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./services.ts";
