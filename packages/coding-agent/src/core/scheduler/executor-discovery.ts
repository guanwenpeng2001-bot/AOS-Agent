/**
 * Shared-ledger executor discovery.
 *
 * Registration, heartbeat, and explicit unregister are durable facts. The
 * process-local SchedulerExecutorRegistry remains a compatibility projection:
 * only live records for which this Host can resolve a provider route are
 * projected, and expired/offline records are removed before selection.
 */
import {
	canonicalFoundationJson,
	FoundationError,
	type FoundationRecord,
	Result,
	type ResultValue,
	type Session,
	type SessionLedgerWriter,
	type TaskExecutorProvider,
} from "@aos-agent/agent-core";
import {
	cloneStoreValue,
	createStoreWriter,
	jsonValue,
	writeFact,
} from "../orchestration/durable-store.ts";
import { runtimeClockFor, type RuntimeClock } from "../runtime/clock.ts";
import {
	type SchedulerExecutorRegistration,
	type SchedulerExecutorRegistry,
	type SchedulerExecutorRuntimeSnapshot,
	validateSchedulerExecutorRuntimeSnapshot,
} from "./executors.ts";
import {
	parseSchedulerExecutorEntry,
	SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS,
	serializeSchedulerExecutorEntry,
	type SchedulerExecutorEntry,
} from "./host.ts";
import type { SchedulerQueueStore, SchedulerRecoveryOutcome } from "./queue.ts";

export const SCHEDULER_EXECUTOR_DISCOVERY_OBJECT_TYPE = "scheduler.executor_registration";
export const SCHEDULER_EXECUTOR_HEARTBEAT_MIN_TTL_MS = 1_000;
export const SCHEDULER_EXECUTOR_HEARTBEAT_MAX_TTL_MS = 15 * 60 * 1_000;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export type SchedulerExecutorDiscoveryStatus = "online" | "offline";

export interface SchedulerExecutorDiscoveryRecord {
	readonly schemaVersion: 1;
	readonly hostId: string;
	readonly entry: SchedulerExecutorEntry;
	readonly trusted: boolean;
	readonly latencyMs: number;
	readonly load: number;
	readonly maxConcurrency: number;
	readonly runtimeSnapshot?: SchedulerExecutorRuntimeSnapshot;
	readonly status: SchedulerExecutorDiscoveryStatus;
	readonly heartbeatAt: string;
	readonly expiresAt: string;
	readonly revision: number;
}

export interface SchedulerDiscoveredExecutorRoute {
	readonly provider: TaskExecutorProvider;
	readonly quota?: SchedulerExecutorRegistration["quota"];
	readonly budget?: SchedulerExecutorRegistration["budget"];
}

export type SchedulerDiscoveredExecutorResolver = (
	record: SchedulerExecutorDiscoveryRecord,
) => SchedulerDiscoveredExecutorRoute | undefined;

export interface SchedulerExecutorDiscoveryOptions {
	readonly session: Session;
	readonly registry: SchedulerExecutorRegistry;
	readonly ownerId: string;
	readonly writer?: SessionLedgerWriter;
	readonly resolveExecutor: SchedulerDiscoveredExecutorResolver;
	readonly now?: () => string;
}

export interface SchedulerExecutorRegisterRequest {
	readonly hostId: string;
	readonly registration: SchedulerExecutorRegistration;
	readonly ttlMs: number;
	readonly clientRequestId: string;
}

export interface SchedulerExecutorHeartbeatRequest {
	readonly hostId: string;
	readonly providerId: string;
	readonly ttlMs: number;
	readonly clientRequestId: string;
	readonly latencyMs?: number;
	readonly load?: number;
}

export interface SchedulerExecutorUnregisterRequest {
	readonly hostId: string;
	readonly providerId: string;
	readonly clientRequestId: string;
}

export interface SchedulerExecutorDiscoverySnapshot {
	readonly records: readonly SchedulerExecutorDiscoveryRecord[];
	readonly live: readonly SchedulerExecutorDiscoveryRecord[];
	readonly offline: readonly SchedulerExecutorDiscoveryRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && SAFE_IDENTIFIER.test(value);
}

function isInteger(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function canonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function discoveryError(message: string): FoundationError {
	return new FoundationError("scheduler_executor_unavailable", message);
}

function validateTtl(ttlMs: number): ResultValue<number, FoundationError> {
	if (
		!Number.isSafeInteger(ttlMs) ||
		ttlMs < SCHEDULER_EXECUTOR_HEARTBEAT_MIN_TTL_MS ||
		ttlMs > SCHEDULER_EXECUTOR_HEARTBEAT_MAX_TTL_MS
	) {
		return Result.err(
			new FoundationError("foundation_schema_invalid_shape", "Executor heartbeat TTL is outside the allowed range"),
		);
	}
	return Result.ok(ttlMs);
}

function serializeRecord(record: SchedulerExecutorDiscoveryRecord): SchedulerExecutorDiscoveryRecord {
	return cloneStoreValue({
		schemaVersion: 1 as const,
		hostId: record.hostId,
		entry: serializeSchedulerExecutorEntry(record.entry),
		trusted: record.trusted,
		latencyMs: record.latencyMs,
		load: record.load,
		maxConcurrency: record.maxConcurrency,
		...(record.runtimeSnapshot === undefined ? {} : { runtimeSnapshot: record.runtimeSnapshot }),
		status: record.status,
		heartbeatAt: record.heartbeatAt,
		expiresAt: record.expiresAt,
		revision: record.revision,
	});
}

function parseRecord(value: unknown): ResultValue<SchedulerExecutorDiscoveryRecord, FoundationError> {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!isIdentifier(value.hostId) ||
		typeof value.trusted !== "boolean" ||
		!isInteger(value.latencyMs) ||
		!isInteger(value.load) ||
		!isInteger(value.maxConcurrency, 1) ||
		(value.status !== "online" && value.status !== "offline") ||
		!canonicalTimestamp(value.heartbeatAt) ||
		!canonicalTimestamp(value.expiresAt) ||
		!isInteger(value.revision) ||
		Object.keys(value).some(
			(key) =>
				![
					"schemaVersion",
					"hostId",
					"entry",
					"trusted",
					"latencyMs",
					"load",
					"maxConcurrency",
					"runtimeSnapshot",
					"status",
					"heartbeatAt",
					"expiresAt",
					"revision",
				].includes(key),
		) ||
		Date.parse(value.expiresAt) < Date.parse(value.heartbeatAt)
	) {
		return Result.err(discoveryError("Stored executor discovery record is invalid"));
	}
	const entry = parseSchedulerExecutorEntry(value.entry);
	if (!entry.ok) return Result.err(discoveryError("Stored executor descriptor is invalid"));
	let runtimeSnapshot: SchedulerExecutorRuntimeSnapshot | undefined;
	if (value.runtimeSnapshot !== undefined) {
		const runtime = validateSchedulerExecutorRuntimeSnapshot(
			value.runtimeSnapshot as SchedulerExecutorRuntimeSnapshot,
		);
		if (!runtime.ok) return Result.err(discoveryError("Stored executor runtime snapshot is invalid"));
		runtimeSnapshot = runtime.value;
	}
	return Result.ok(
		serializeRecord({
			schemaVersion: 1,
			hostId: value.hostId,
			entry: entry.value,
			trusted: value.trusted,
			latencyMs: value.latencyMs,
			load: value.load,
			maxConcurrency: value.maxConcurrency,
			...(runtimeSnapshot === undefined ? {} : { runtimeSnapshot }),
			status: value.status,
			heartbeatAt: value.heartbeatAt,
			expiresAt: value.expiresAt,
			revision: value.revision,
		}),
	);
}

function asFact(record: FoundationRecord): Extract<FoundationRecord, { kind: "fact" }> | undefined {
	return record.kind === "fact" ? record : undefined;
}

export class SchedulerExecutorDiscovery {
	private readonly session: Session;
	private readonly registry: SchedulerExecutorRegistry;
	private readonly writer: SessionLedgerWriter;
	private readonly ownsWriter: boolean;
	private readonly resolveExecutor: SchedulerDiscoveredExecutorResolver;
	private readonly clock: RuntimeClock;
	private readonly nowFn: () => string;
	private records = new Map<string, SchedulerExecutorDiscoveryRecord>();
	private latestRequestIds = new Map<string, string>();
	private localRoutes = new Map<string, SchedulerDiscoveredExecutorRoute>();
	private projectedHosts = new Set<string>();
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(options: SchedulerExecutorDiscoveryOptions) {
		this.session = options.session;
		this.registry = options.registry;
		this.writer = createStoreWriter(options.session, {
			ownerId: options.ownerId,
			...(options.writer === undefined ? {} : { writer: options.writer }),
		});
		this.ownsWriter = options.writer === undefined;
		this.resolveExecutor = options.resolveExecutor;
		this.clock = runtimeClockFor(options);
		this.nowFn = options.now ?? (() => new Date(this.clock.wallNow()).toISOString());
		this.registry.attachDiscovery({
			sync: async () => {
				const synced = await this.sync();
				return synced.ok ? Result.ok(undefined) : Result.err(synced.error);
			},
			isOwnerAvailable: (ownerId) => this.isHostAvailable(ownerId),
		});
	}

	async register(
		request: SchedulerExecutorRegisterRequest,
	): Promise<ResultValue<SchedulerExecutorDiscoveryRecord, FoundationError>> {
		return this.withMutation(async () => {
			if (!isIdentifier(request.hostId) || !isIdentifier(request.clientRequestId)) {
				return Result.err(discoveryError("Executor registration identity is invalid"));
			}
			const ttl = validateTtl(request.ttlMs);
			if (!ttl.ok) return ttl;
			const loaded = await this.reload();
			if (!loaded.ok) return loaded;
			const providerId = request.registration.entry.descriptor.providerId;
			const existing = this.records.get(providerId);
			if (existing !== undefined && this.latestRequestIds.get(providerId) === request.clientRequestId) {
				if (
					existing.hostId !== request.hostId ||
					canonicalFoundationJson(existing.entry) !== canonicalFoundationJson(request.registration.entry) ||
					existing.trusted !== request.registration.trusted ||
					existing.latencyMs !== request.registration.latencyMs ||
					existing.load !== (request.registration.load ?? 0) ||
					existing.maxConcurrency !==
						(request.registration.maxConcurrency ?? SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS)
				) {
					return Result.err(discoveryError("Executor registration request identity conflicts with durable content"));
				}
				this.localRoutes.set(providerId, {
					provider: request.registration.provider,
					...(request.registration.quota === undefined ? {} : { quota: request.registration.quota }),
					...(request.registration.budget === undefined ? {} : { budget: request.registration.budget }),
				});
				const synced = await this.syncUnlocked();
				return synced.ok ? Result.ok(existing) : Result.err(synced.error);
			}
			const now = this.nowIso();
			const candidate: SchedulerExecutorDiscoveryRecord = {
				schemaVersion: 1,
				hostId: request.hostId,
				entry: request.registration.entry,
				trusted: request.registration.trusted,
				latencyMs: request.registration.latencyMs,
				load: request.registration.load ?? 0,
				maxConcurrency: request.registration.maxConcurrency ?? SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS,
				...(request.registration.runtimeSnapshot === undefined
					? {}
					: { runtimeSnapshot: request.registration.runtimeSnapshot }),
				status: "online",
				heartbeatAt: now,
				expiresAt: new Date(Date.parse(now) + ttl.value).toISOString(),
				revision: existing === undefined ? 0 : existing.revision + 1,
			};
			const parsed = parseRecord(candidate);
			if (!parsed.ok) return parsed;
			if (existing !== undefined) {
				if (
					existing.hostId !== request.hostId ||
					(existing.status === "online" && Date.parse(existing.expiresAt) > Date.parse(now))
				) {
					return Result.err(discoveryError("Executor provider identity already has a live owner"));
				}
			}
			this.localRoutes.set(providerId, {
				provider: request.registration.provider,
				...(request.registration.quota === undefined ? {} : { quota: request.registration.quota }),
				...(request.registration.budget === undefined ? {} : { budget: request.registration.budget }),
			});
			const written = await this.write(parsed.value, request.clientRequestId, existing?.revision ?? -1);
			if (!written.ok) return written;
			const synced = await this.syncUnlocked();
			return synced.ok ? Result.ok(written.value) : Result.err(synced.error);
		});
	}

	async heartbeat(
		request: SchedulerExecutorHeartbeatRequest,
	): Promise<ResultValue<SchedulerExecutorDiscoveryRecord, FoundationError>> {
		return this.withMutation(async () => {
			if (!isIdentifier(request.hostId) || !isIdentifier(request.providerId) || !isIdentifier(request.clientRequestId)) {
				return Result.err(discoveryError("Executor heartbeat identity is invalid"));
			}
			const ttl = validateTtl(request.ttlMs);
			if (!ttl.ok) return ttl;
			const loaded = await this.reload();
			if (!loaded.ok) return loaded;
			const existing = this.records.get(request.providerId);
			if (existing === undefined || existing.hostId !== request.hostId || existing.status !== "online") {
				return Result.err(discoveryError("Executor heartbeat has no live registration"));
			}
			if (this.latestRequestIds.get(request.providerId) === request.clientRequestId) {
				const ttlMs = Date.parse(existing.expiresAt) - Date.parse(existing.heartbeatAt);
				if (
					ttlMs !== request.ttlMs ||
					(request.latencyMs !== undefined && request.latencyMs !== existing.latencyMs) ||
					(request.load !== undefined && request.load !== existing.load)
				) {
					return Result.err(discoveryError("Executor heartbeat request identity conflicts with durable content"));
				}
				return Result.ok(existing);
			}
			if (request.latencyMs !== undefined && !isInteger(request.latencyMs)) {
				return Result.err(discoveryError("Executor heartbeat latency is invalid"));
			}
			if (request.load !== undefined && !isInteger(request.load)) {
				return Result.err(discoveryError("Executor heartbeat load is invalid"));
			}
			const now = this.nowIso();
			const next = serializeRecord({
				...existing,
				latencyMs: request.latencyMs ?? existing.latencyMs,
				load: request.load ?? existing.load,
				heartbeatAt: now,
				expiresAt: new Date(Date.parse(now) + ttl.value).toISOString(),
				revision: existing.revision + 1,
			});
			const written = await this.write(next, request.clientRequestId, existing.revision);
			if (!written.ok) return written;
			const synced = await this.syncUnlocked();
			return synced.ok ? Result.ok(written.value) : Result.err(synced.error);
		});
	}

	async unregister(
		request: SchedulerExecutorUnregisterRequest,
	): Promise<ResultValue<SchedulerExecutorDiscoveryRecord, FoundationError>> {
		return this.withMutation(async () => {
			if (!isIdentifier(request.hostId) || !isIdentifier(request.providerId) || !isIdentifier(request.clientRequestId)) {
				return Result.err(discoveryError("Executor unregister identity is invalid"));
			}
			const loaded = await this.reload();
			if (!loaded.ok) return loaded;
			const existing = this.records.get(request.providerId);
			if (existing === undefined || existing.hostId !== request.hostId) {
				return Result.err(discoveryError("Executor unregister has no matching registration"));
			}
			if (this.latestRequestIds.get(request.providerId) === request.clientRequestId) return Result.ok(existing);
			if (existing.status === "offline") return Result.ok(existing);
			const now = this.nowIso();
			const next = serializeRecord({
				...existing,
				status: "offline",
				heartbeatAt: now,
				expiresAt: now,
				revision: existing.revision + 1,
			});
			const written = await this.write(next, request.clientRequestId, existing.revision);
			if (!written.ok) return written;
			this.localRoutes.delete(request.providerId);
			const synced = await this.syncUnlocked();
			return synced.ok ? Result.ok(written.value) : Result.err(synced.error);
		});
	}

	async sync(): Promise<ResultValue<SchedulerExecutorDiscoverySnapshot, FoundationError>> {
		return this.withMutation(() => this.syncUnlocked());
	}

	async isHostAvailable(hostId: string): Promise<boolean> {
		const synced = await this.sync();
		return synced.ok && this.projectedHosts.has(hostId);
	}

	/** Lost executors stop renewing claims; the existing queue recovery remains authoritative. */
	async reconcileLostExecutors(
		queue: Pick<SchedulerQueueStore, "recoverExpired">,
	): Promise<ResultValue<readonly SchedulerRecoveryOutcome[], FoundationError>> {
		const synced = await this.sync();
		if (!synced.ok) return synced;
		return queue.recoverExpired();
	}

	async dispose(): Promise<void> {
		if (this.ownsWriter) await this.writer.releaseLease();
	}

	private async syncUnlocked(): Promise<ResultValue<SchedulerExecutorDiscoverySnapshot, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const now = Date.parse(this.nowIso());
		const live = [...this.records.values()]
			.filter((record) => record.status === "online" && Date.parse(record.expiresAt) > now)
			.sort((left, right) => left.entry.descriptor.providerId.localeCompare(right.entry.descriptor.providerId));
		const registrations: SchedulerExecutorRegistration[] = [];
		const projectedHosts = new Set<string>();
		for (const record of live) {
			const route = this.localRoutes.get(record.entry.descriptor.providerId) ?? this.resolveExecutor(record);
			if (route === undefined) continue;
			registrations.push({
				entry: record.entry,
				provider: route.provider,
				trusted: record.trusted,
				latencyMs: record.latencyMs,
				load: record.load,
				maxConcurrency: record.maxConcurrency,
				...(record.runtimeSnapshot === undefined ? {} : { runtimeSnapshot: record.runtimeSnapshot }),
				...(route.quota === undefined ? {} : { quota: route.quota }),
				...(route.budget === undefined ? {} : { budget: route.budget }),
			});
			projectedHosts.add(record.hostId);
		}
		const projected = await this.registry.replaceDiscovered(registrations);
		if (!projected.ok) return projected;
		this.projectedHosts = projectedHosts;
		const records = [...this.records.values()].sort((left, right) =>
			left.entry.descriptor.providerId.localeCompare(right.entry.descriptor.providerId),
		);
		const liveIds = new Set(live.map((record) => record.entry.descriptor.providerId));
		return Result.ok({
			records: records.map(serializeRecord),
			live: live.map(serializeRecord),
			offline: records.filter((record) => !liveIds.has(record.entry.descriptor.providerId)).map(serializeRecord),
		});
	}

	private async reload(): Promise<ResultValue<void, FoundationError>> {
		try {
			const records = await this.session.findFoundationRecords({
				objectType: SCHEDULER_EXECUTOR_DISCOVERY_OBJECT_TYPE,
				kind: "fact",
				order: "oldestFirst",
				includePruned: true,
			});
			const replayed = new Map<string, SchedulerExecutorDiscoveryRecord>();
			const latestRequestIds = new Map<string, string>();
			for (const raw of records) {
				const fact = asFact(raw);
				if (fact === undefined) continue;
				const parsed = parseRecord(fact.payload);
				if (!parsed.ok) return parsed;
				const providerId = parsed.value.entry.descriptor.providerId;
				if (fact.objectId !== providerId) return Result.err(discoveryError("Executor discovery object identity changed"));
				const previous = replayed.get(providerId);
				if (
					(previous === undefined && parsed.value.revision !== 0) ||
					(previous !== undefined && parsed.value.revision !== previous.revision + 1) ||
					(previous !== undefined && previous.hostId !== parsed.value.hostId)
				) {
					return Result.err(discoveryError("Executor discovery revision chain is invalid"));
				}
				replayed.set(providerId, parsed.value);
				latestRequestIds.set(providerId, fact.clientRequestId);
			}
			this.records = replayed;
			this.latestRequestIds = latestRequestIds;
			return Result.ok(undefined);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_persistence_failed", "Executor discovery reload failed", { cause: error }),
			);
		}
	}

	private async write(
		record: SchedulerExecutorDiscoveryRecord,
		clientRequestId: string,
		previousPayloadRevision: number,
	): Promise<ResultValue<SchedulerExecutorDiscoveryRecord, FoundationError>> {
		try {
			const written = await writeFact(
				this.writer,
				SCHEDULER_EXECUTOR_DISCOVERY_OBJECT_TYPE,
				record.entry.descriptor.providerId,
				jsonValue(serializeRecord(record), "executor discovery record"),
				clientRequestId,
				previousPayloadRevision + 1,
			);
			const parsed = parseRecord(written.value);
			if (!parsed.ok) return parsed;
			if (canonicalFoundationJson(parsed.value) !== canonicalFoundationJson(record)) {
				return Result.err(discoveryError("Executor discovery idempotency replay does not match"));
			}
			this.records.set(record.entry.descriptor.providerId, parsed.value);
			this.latestRequestIds.set(record.entry.descriptor.providerId, clientRequestId);
			return Result.ok(parsed.value);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError("scheduler_persistence_failed", "Executor discovery append failed", { cause: error }),
			);
		}
	}

	private nowIso(): string {
		const value = this.nowFn();
		if (!canonicalTimestamp(value)) throw new TypeError("Executor discovery clock must return canonical UTC time");
		return value;
	}

	private async withMutation<T>(
		operation: () => Promise<ResultValue<T, FoundationError>>,
	): Promise<ResultValue<T, FoundationError>> {
		const predecessor = this.mutationTail;
		let release = (): void => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.mutationTail = predecessor.then(() => current);
		await predecessor;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}
