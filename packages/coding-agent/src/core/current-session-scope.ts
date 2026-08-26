/** A host rebind is prepared while the candidate is private. */
export interface PreparedSessionScopeRebind {
	/**
	 * Complete fallible preparation before publication. Product surfaces must
	 * not use this hook to publish a second current-session pointer.
	 */
	commit(): void;
	/** Emit post-commit lifecycle notifications or refresh presentation state. */
	activate?(): void | Promise<void>;
	/** Prepare post-commit presentation immediately before lifecycle activation. */
	prepareActivation?(): void | Promise<void>;
	disposeCandidate?(): void | Promise<void>;
	disposePrevious?(signal: AbortSignal): void | Promise<void>;
}

export type SessionScopePostCommitFailurePhase = "old_scope_cleanup" | "candidate_activation" | "with_session";

export interface SessionScopePostCommitFailure {
	phase: SessionScopePostCommitFailurePhase;
	error: unknown;
}

export interface SessionScopeTransitionOptions<TScope extends object> {
	construct(previous: TScope): TScope | Promise<TScope>;
	validate(candidate: TScope, previous: TScope): void | Promise<void>;
	checkReadiness(candidate: TScope, previous: TScope): void | Promise<void>;
	prepareRebind(candidate: TScope, previous: TScope): PreparedSessionScopeRebind | Promise<PreparedSessionScopeRebind>;
	/** Testable pre-commit gate immediately before the atomic pointer assignment. */
	beforeCommit?(candidate: TScope, previous: TScope): void | Promise<void>;
	/** Synchronous rollback-safe commit work; no asynchronous work may escape it. */
	commit?(candidate: TScope, previous: TScope): void;
	/** Restore pre-commit admission fences after any failure. */
	rollbackPreCommit?(candidate: TScope, previous: TScope): void | Promise<void>;
	/** Stop old-scope admission immediately after publication. This must not throw. */
	stopPreviousAdmission?(candidate: TScope, previous: TScope): void;
	/** Finalize admission fences after both bounded old-scope cleanup attempts. */
	afterPreviousDisposed?(candidate: TScope, previous: TScope): void;
	/** Post-commit hook that runs immediately before candidate activation. */
	beforeActivate?(candidate: TScope, previous: TScope): void | Promise<void>;
	disposeCandidate(candidate: TScope): void | Promise<void>;
	disposePrevious(previous: TScope, signal: AbortSignal): void | Promise<void>;
	oldCleanupTimeoutMs?: number;
}

export interface SessionScopeTransitionResult<TScope extends object> {
	current: TScope;
	previous: TScope;
	postCommitFailures: readonly SessionScopePostCommitFailure[];
}

const DEFAULT_OLD_SCOPE_CLEANUP_TIMEOUT_MS = 5_000;

async function disposeFailedCandidate<TScope extends object>(
	candidate: TScope,
	previous: TScope,
	preparedRebind: PreparedSessionScopeRebind | undefined,
	rollbackPreCommit: SessionScopeTransitionOptions<TScope>["rollbackPreCommit"],
	disposeCandidate: (candidate: TScope) => void | Promise<void>,
): Promise<unknown[]> {
	const cleanupFailures: unknown[] = [];
	try {
		await rollbackPreCommit?.(candidate, previous);
	} catch (error) {
		cleanupFailures.push(error);
	}
	try {
		await preparedRebind?.disposeCandidate?.();
	} catch (error) {
		cleanupFailures.push(error);
	}
	try {
		await disposeCandidate(candidate);
	} catch (error) {
		cleanupFailures.push(error);
	}
	return cleanupFailures;
}

function preCommitFailure(error: unknown, cleanupFailures: readonly unknown[]): unknown {
	if (cleanupFailures.length === 0) return error;
	return new AggregateError(
		[error, ...cleanupFailures],
		"Session scope transition failed before commit and candidate cleanup did not complete",
	);
}

async function runBoundedCleanup(
	label: string,
	cleanup: (signal: AbortSignal) => void | Promise<void>,
	timeoutMs: number,
): Promise<void> {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new RangeError("oldCleanupTimeoutMs must be a non-negative finite number");
	}

	let timeout: ReturnType<typeof setTimeout> | undefined;
	const controller = new AbortController();
	const cleanupPromise = Promise.resolve().then(() => cleanup(controller.signal));
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(
			() => {
				controller.abort();
				reject(new Error(`${label} exceeded ${timeoutMs}ms`));
			},
			timeoutMs,
		);
	});
	try {
		await Promise.race([cleanupPromise, timeoutPromise]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

/**
 * Owns the single current Session scope pointer.
 *
 * Candidate construction, validation, readiness, and host-rebind preparation
 * are pre-commit. The one runtime scope pointer is published synchronously in
 * one non-yielding commit turn. Bounded old-scope cleanup and lifecycle
 * activation are post-commit and cannot roll that pointer back.
 */
export class CurrentSessionScope<TScope extends object> {
	private currentScope: TScope;

	constructor(initialScope: TScope) {
		this.currentScope = initialScope;
	}

	get current(): TScope {
		return this.currentScope;
	}

	async replace(options: SessionScopeTransitionOptions<TScope>): Promise<SessionScopeTransitionResult<TScope>> {
		const previous = this.currentScope;
		let candidate: TScope | undefined;
		let preparedRebind: PreparedSessionScopeRebind | undefined;
		try {
			candidate = await options.construct(previous);
			await options.validate(candidate, previous);
			await options.checkReadiness(candidate, previous);
			preparedRebind = await options.prepareRebind(candidate, previous);
			await options.beforeCommit?.(candidate, previous);
			// No await is permitted between this rollback-safe commit work and the
			// one authoritative pointer assignment below.
			preparedRebind.commit();
			options.commit?.(candidate, previous);
		} catch (error) {
			if (candidate === undefined) throw error;
			const cleanupFailures = await disposeFailedCandidate(
				candidate,
				previous,
				preparedRebind,
				options.rollbackPreCommit,
				options.disposeCandidate,
			);
			throw preCommitFailure(error, cleanupFailures);
		}

		// This is the only publication point for the candidate runtime scope.
		this.currentScope = candidate;
		const postCommitFailures: SessionScopePostCommitFailure[] = [];
		try {
			options.stopPreviousAdmission?.(candidate, previous);
		} catch (error) {
			postCommitFailures.push({ phase: "old_scope_cleanup", error });
		}
		const cleanupFailures: unknown[] = [];
		const cleanupTimeoutMs = options.oldCleanupTimeoutMs ?? DEFAULT_OLD_SCOPE_CLEANUP_TIMEOUT_MS;
		try {
			await runBoundedCleanup(
				"Old host cleanup",
				(signal) => preparedRebind.disposePrevious?.(signal),
				cleanupTimeoutMs,
			);
		} catch (error) {
			cleanupFailures.push(error);
		}
		try {
			await runBoundedCleanup(
				"Old Session disposal",
				(signal) => options.disposePrevious(previous, signal),
				cleanupTimeoutMs,
			);
		} catch (error) {
			cleanupFailures.push(error);
		}
		if (cleanupFailures.length === 1) {
			postCommitFailures.push({ phase: "old_scope_cleanup", error: cleanupFailures[0] });
		} else if (cleanupFailures.length > 1) {
			postCommitFailures.push({
				phase: "old_scope_cleanup",
				error: new AggregateError(cleanupFailures, "Old session scope cleanup failed"),
			});
		}
		try {
			options.afterPreviousDisposed?.(candidate, previous);
		} catch (error) {
			postCommitFailures.push({ phase: "old_scope_cleanup", error });
		}
		for (const activate of [
			() => preparedRebind.prepareActivation?.(),
			() => options.beforeActivate?.(candidate, previous),
			() => preparedRebind.activate?.(),
		]) {
			try {
				await activate();
			} catch (error) {
				postCommitFailures.push({ phase: "candidate_activation", error });
			}
		}

		return { current: candidate, previous, postCommitFailures };
	}
}
