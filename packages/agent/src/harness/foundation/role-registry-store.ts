import { Result, type Result as ResultValue } from "../result.ts";
import type { Session } from "../session/session.ts";
import { DurableLedgerError } from "../session/durable/errors.ts";
import { FoundationError, toFoundationError } from "./errors.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { SessionLedgerV1 } from "./session-ledger.ts";
import {
	InMemoryRoleRegistryV1,
	type RoleRegistryCreateInputV1,
	type RoleRegistryCopyInputV1,
	type RoleRegistryDeleteInputV1,
	type RoleRegistryEditInputV1,
	type RoleRegistryExportQueryV1,
	type RoleRegistryExportV1,
	type RoleRegistryGetQueryV1,
	type RoleRegistryImportV1,
	type RoleRegistryListQueryV1,
	type RoleRegistryRecordV1,
	type RoleRegistrySearchQueryV1,
	type RoleResolveInputV1,
	type RoleResolutionPreviewV1,
	type RoleResolutionOverrideV1,
	type RoleTombstoneV1,
	validateRoleRegistryRecordV1,
} from "./role-registry.ts";
import { validateRoleRevisionV1, type ModelProfileV1, type RoleRevisionV1 } from "./role.ts";
import { validateSecretFreeModelProfileV1 } from "./model-profile.ts";
import { canonicalFoundationJson, fingerprintFoundationValue } from "./identity.ts";
import { validateTaskEnvelope } from "./task.ts";

/** Durable object kinds. Role/profile history remains in the object payload; Session is the authority. */
export const ROLE_REGISTRY_OBJECT_TYPE_V1 = "role_registry";
export const MODEL_PROFILE_OBJECT_TYPE_V1 = "model_profile";

export interface DurableRoleRegistryOptions {
	readonly now?: () => string;
	readonly ownerId?: string;
}

function roleObjectId(roleId: string, scope: "global" | "project"): string {
	return `${scope}:${roleId}`;
}

function resultError<T>(error: unknown, fallback: string): ResultValue<T, FoundationError> {
	return Result.err(error instanceof DurableLedgerError ? new FoundationError(error.code, error.message, { cause: error }) : toFoundationError(error, fallback));
}

interface StoredRoleRecordV1 {
	readonly payload: RoleRegistryRecordV1;
	readonly revision: number;
}

function durableReferenceMatches(reference: { readonly id: string; readonly revision: number; readonly fingerprint?: { readonly value: string } }, payload: unknown): boolean {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload) || reference.fingerprint === undefined) return false;
	const record = payload as Record<string, unknown>;
	return record.revision === reference.revision && fingerprintFoundationValue(payload).value === reference.fingerprint.value;
}

function immutableRoleRevisionValid(value: RoleRevisionV1): boolean {
	const { fingerprint, ...base } = value;
	return fingerprint.value === fingerprintFoundationValue(base).value;
}

function findRoleRevision(records: readonly RoleRegistryRecordV1[], roleRevisionId: string, revision: number): RoleRevisionV1 | undefined {
	for (const record of records) {
		for (const candidate of record.revisions) {
			const checked = validateRoleRevisionV1(candidate);
			if (checked.ok && immutableRoleRevisionValid(checked.value) && checked.value.roleRevisionId === roleRevisionId && checked.value.revision === revision) return checked.value;
		}
	}
	return undefined;
}

function modelProfileFromPayload(payload: unknown, modelProfileId: string, revision: number): ModelProfileV1 | undefined {
	const direct = validateSecretFreeModelProfileV1(payload);
	if (direct.ok && direct.value.modelProfileId === modelProfileId && direct.value.revision === revision) return direct.value;
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	if (record.modelProfileId !== modelProfileId || !Array.isArray(record.revisions)) return undefined;
	for (const candidate of record.revisions) {
		const checked = validateSecretFreeModelProfileV1(candidate);
		if (checked.ok && checked.value.modelProfileId === modelProfileId && checked.value.revision === revision) return checked.value;
	}
	return undefined;
}

/**
 * Session-backed Role Registry. A transient resolver is rebuilt per operation, but
 * no retained Map or snapshot is authoritative; every read starts at the Session
 * ledger and every mutation is an object-level CAS append under writer fencing.
 */
export class DurableRoleRegistryV1 {
	private readonly now: () => string;
	private readonly ledger: SessionLedgerV1;
	private mutationTail: Promise<void> = Promise.resolve();

	private constructor(session: Session, options: DurableRoleRegistryOptions) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.ledger = new SessionLedgerV1(session, { ownerId: options.ownerId });
	}

	static async create(session: Session, options: DurableRoleRegistryOptions = {}): Promise<DurableRoleRegistryV1> {
		const store = new DurableRoleRegistryV1(session, options);
		try {
			await store.loadRecords();
			return store;
		} catch (error) {
			throw error instanceof DurableLedgerError ? new FoundationError(error.code, error.message, { cause: error }) : toFoundationError(error, "role_registry_persistence_invalid");
		}
	}

	async create(input: RoleRegistryCreateInputV1): Promise<ResultValue<RoleRegistryRecordV1, FoundationError>> {
		return this.mutate((registry) => registry.create(input));
	}

	async get(query: RoleRegistryGetQueryV1): Promise<ResultValue<RoleRegistryRecordV1, FoundationError>> {
		return this.read((registry) => registry.get(query));
	}

	async list(query: RoleRegistryListQueryV1 = {}): Promise<ResultValue<readonly RoleRegistryRecordV1[], FoundationError>> {
		return this.read((registry) => registry.list(query));
	}

	async search(query: RoleRegistrySearchQueryV1): Promise<ResultValue<readonly RoleRegistryRecordV1[], FoundationError>> {
		return this.read((registry) => registry.search(query));
	}

	async edit(input: RoleRegistryEditInputV1): Promise<ResultValue<RoleRegistryRecordV1, FoundationError>> {
		return this.mutate((registry) => registry.edit(input));
	}

	async copy(input: RoleRegistryCopyInputV1): Promise<ResultValue<RoleRegistryRecordV1, FoundationError>> {
		return this.mutate((registry) => registry.copy(input));
	}

	async delete(input: RoleRegistryDeleteInputV1): Promise<ResultValue<RoleTombstoneV1, FoundationError>> {
		return this.mutate((registry) => registry.delete(input));
	}

	async import(input: RoleRegistryImportV1): Promise<ResultValue<readonly RoleRegistryRecordV1[], FoundationError>> {
		return this.mutate((registry) => registry.import(input));
	}

	async export(query: RoleRegistryExportQueryV1 = {}): Promise<ResultValue<RoleRegistryExportV1, FoundationError>> {
		return this.read((registry) => registry.export(query));
	}

	async resolve(input: RoleResolveInputV1): Promise<ResultValue<RoleResolutionPreviewV1, FoundationError>> {
		await this.mutationTail;
		try {
			const checked = await this.validateDurableResolutionInput(input);
			if (!checked.ok) return checked;
			const registry = await this.loadRegistry();
			return registry.resolve(checked.value);
		} catch (error) {
			return resultError(error, "role_registry_persistence_invalid");
		}
	}

	async release(): Promise<void> { await this.ledger.release(); }

	private async read<T>(operation: (registry: InMemoryRoleRegistryV1) => ResultValue<T, FoundationError>): Promise<ResultValue<T, FoundationError>> {
		await this.mutationTail;
		try {
			const registry = await this.loadRegistry();
			return operation(registry);
		} catch (error) {
			return resultError(error, "role_registry_persistence_invalid");
		}
	}

	private mutate<T>(operation: (registry: InMemoryRoleRegistryV1) => ResultValue<T, FoundationError>): Promise<ResultValue<T, FoundationError>> {
		const result = this.mutationTail.then(async () => {
			try {
				const beforeFacts = await this.loadRecordFacts();
				const before = beforeFacts.map((fact) => fact.payload);
				const registry = new InMemoryRoleRegistryV1({ now: this.now });
				const imported = registry.import({ schemaVersion: 1, exportedAt: this.now(), records: before });
				if (!imported.ok) return imported as ResultValue<T, FoundationError>;
				const next = operation(registry);
				if (!next.ok) return next;
				const after = registry.list({ includeTombstones: true });
				if (!after.ok) return after as ResultValue<T, FoundationError>;
				await this.persistChanged(beforeFacts, after.value);
				return next;
			} catch (error) {
				return resultError<T>(error, "role_registry_persistence_failed");
			}
		});
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private async loadRegistry(): Promise<InMemoryRoleRegistryV1> {
		const registry = new InMemoryRoleRegistryV1({ now: this.now });
		const records = await this.loadRecords();
		const imported = registry.import({ schemaVersion: 1, exportedAt: this.now(), records });
		if (!imported.ok) throw imported.error;
		return registry;
	}

	private async loadRecords(): Promise<readonly RoleRegistryRecordV1[]> {
		return (await this.loadRecordFacts()).map((fact) => fact.payload);
	}

	private async loadRecordFacts(): Promise<readonly StoredRoleRecordV1[]> {
		const records = await this.ledger.find({ kind: "fact", objectType: ROLE_REGISTRY_OBJECT_TYPE_V1, order: "oldestFirst" });
		const latest: StoredRoleRecordV1[] = [];
		for (const record of records) {
			if (record.kind !== "fact") continue;
			const checked = validateRoleRegistryRecordV1(record.payload);
			if (!checked.ok) throw checked.error;
			const existing = latest.findIndex((candidate) => candidate.payload.roleId === checked.value.roleId && candidate.payload.scope === checked.value.scope);
			const stored = { payload: checked.value, revision: record.revision };
			if (existing >= 0) latest[existing] = stored;
			else latest.push(stored);
		}
		return latest;
	}

	private async validateDurableResolutionInput(input: RoleResolveInputV1): Promise<ResultValue<RoleResolveInputV1, FoundationError>> {
		const taskRecord = await this.ledger.get("task", input.task.taskId);
		if (taskRecord === undefined || taskRecord.kind !== "fact") return Result.err(new FoundationError("role_resolver_task_required", "Role resolution requires a TaskEnvelope that is durable in Session", { details: { taskId: input.task.taskId } }));
		const task = validateTaskEnvelope(taskRecord.payload);
		if (!task.ok) return Result.err(new FoundationError("role_resolver_task_required", "Role resolution requires an exact durable TaskEnvelope", { details: { taskId: input.task.taskId } }));
		if (canonicalFoundationJson(task.value) !== canonicalFoundationJson(input.task)) return Result.err(new FoundationError("role_resolver_task_required", "Role resolution must consume the durable TaskEnvelope", { details: { taskId: input.task.taskId } }));
		const modelProfile = await this.findDurableModelProfile(input.modelProfile.modelProfileId, input.modelProfile.revision);
		if (modelProfile === undefined) return Result.err(new FoundationError("binding_required_fact", "Role resolution ModelProfile must resolve from a durable registry fact", { details: { modelProfileId: input.modelProfile.modelProfileId, revision: input.modelProfile.revision } }));
		const records = await this.loadRecords();
		const canonicalOverrides: RoleResolutionOverrideV1[] = [];
		for (const override of input.overrides ?? []) {
			const roleRevision = override.roleRevision === undefined ? undefined : findRoleRevision(records, override.roleRevision.roleRevisionId, override.roleRevision.revision);
			if (override.roleRevision !== undefined && roleRevision === undefined) return Result.err(new FoundationError("binding_required_fact", "Role resolution RoleRevision override must resolve from a durable registry fact", { details: { roleRevisionId: override.roleRevision.roleRevisionId, revision: override.roleRevision.revision } }));
			const modelProfile = override.modelProfile === undefined ? undefined : await this.findDurableModelProfile(override.modelProfile.modelProfileId, override.modelProfile.revision);
			if (override.modelProfile !== undefined) {
				if (modelProfile === undefined) return Result.err(new FoundationError("binding_required_fact", "Role resolution ModelProfile override must resolve from a durable registry fact", { details: { modelProfileId: override.modelProfile.modelProfileId, revision: override.modelProfile.revision } }));
			}
			const overrideWithoutRoute = { ...override };
			delete overrideWithoutRoute.modelRoute;
			canonicalOverrides.push({
				...overrideWithoutRoute,
				...(roleRevision === undefined ? {} : { roleRevision }),
				...(modelProfile === undefined ? {} : { modelProfile }),
				// Routing metadata is derived from the canonical profile. A caller
				// may select a profile revision, but cannot supply route values.
				...(modelProfile === undefined ? {} : { modelRoute: { provider: modelProfile.provider, model: modelProfile.model, ...(modelProfile.effort === undefined ? {} : { effort: modelProfile.effort }), ...(modelProfile.serviceTier === undefined ? {} : { serviceTier: modelProfile.serviceTier }) } }),
			});
		}
		const context = input.externalAgentBindingRevision ?? input.contextRevision;
		if (input.externalAgentBindingRevision !== undefined && input.contextRevision !== undefined && canonicalFoundationJson(input.externalAgentBindingRevision) !== canonicalFoundationJson(input.contextRevision)) return Result.err(new FoundationError("binding_required_fact", "Role resolution received conflicting External-Agent Binding aliases"));
		const sources: readonly [string, typeof context][] = [
			["external_agent_binding", context],
			["capability_binding", input.capabilityRevision],
			["model_broker_binding", input.modelBrokerBindingRevision],
			["policy_binding", input.policyRevision],
		];
		for (const [objectType, reference] of sources) {
			if (reference === undefined) return Result.err(new FoundationError("binding_required_fact", "Role resolution requires all four durable binding source facts", { details: { objectType, taskId: task.value.taskId } }));
			const source = await this.ledger.get(objectType, reference.id);
			if (source === undefined || source.kind !== "fact" || !durableReferenceMatches(reference, source.payload)) return Result.err(new FoundationError("binding_required_fact", "Role resolution binding source does not match its durable Session fact", { details: { objectType, objectId: reference.id, revision: reference.revision } }));
		}
		for (const override of input.overrides ?? []) {
			const external = override.externalAgentBindingRevision ?? override.contextRevision;
			const overrideSources: readonly [string, typeof external][] = [["external_agent_binding", external], ["model_broker_binding", override.modelBrokerBindingRevision], ["policy_binding", override.policyRevision]];
			for (const [objectType, reference] of overrideSources) {
				if (reference === undefined) continue;
				const source = await this.ledger.get(objectType, reference.id);
				if (source === undefined || source.kind !== "fact" || !durableReferenceMatches(reference, source.payload)) return Result.err(new FoundationError("binding_required_fact", "Role resolution override source does not match its durable Session fact", { details: { objectType, objectId: reference.id, revision: reference.revision } }));
			}
		}
		return Result.ok({ ...input, task: task.value, modelProfile, overrides: canonicalOverrides });
	}

	private async findDurableModelProfile(modelProfileId: string, revision: number): Promise<ModelProfileV1 | undefined> {
		const direct = await this.ledger.get("model_profile_revision", modelProfileId);
		if (direct?.kind === "fact") {
			const profile = modelProfileFromPayload(direct.payload, modelProfileId, revision);
			if (profile !== undefined) return profile;
		}
		const records = await this.ledger.find({ kind: "fact", objectType: MODEL_PROFILE_OBJECT_TYPE_V1, order: "oldestFirst" });
		for (const record of records) {
			if (record.kind !== "fact") continue;
			const profile = modelProfileFromPayload(record.payload, modelProfileId, revision);
			if (profile !== undefined) return profile;
		}
		return undefined;
	}

	private async persistChanged(before: readonly StoredRoleRecordV1[], after: readonly RoleRegistryRecordV1[]): Promise<void> {
		for (const record of after) {
			const previous = before.find((candidate) => candidate.payload.roleId === record.roleId && candidate.payload.scope === record.scope);
			if (previous !== undefined && fingerprintFoundationValue(previous.payload).value === fingerprintFoundationValue(record).value) continue;
			await this.ledger.appendFact(ROLE_REGISTRY_OBJECT_TYPE_V1, roleObjectId(record.roleId, record.scope), record, {
				clientRequestId: `role-registry:${record.scope}:${record.roleId}:${record.currentRevision.revision}:${record.tombstone?.deletedRevision ?? "active"}`,
				expectedRevision: previous?.revision ?? 0,
				correlation: { roleId: record.roleId, roleRevisionId: record.currentRevision.roleRevisionId },
			});
		}
	}
}

export const DurableRoleRegistry = DurableRoleRegistryV1;

export interface ModelProfileRecordV1 {
	schemaVersion: 1;
	modelProfileId: string;
	currentRevision: ModelProfileV1;
	revisions: readonly ModelProfileV1[];
}

export interface ModelProfilePutInputV1 { profile: ModelProfileV1; }
export interface ModelProfileGetQueryV1 { modelProfileId: string; revision?: number; }

/** Session-backed storage for secret-free, independently versioned ModelProfile revisions. */
export class DurableModelProfileStoreV1 {
	private readonly ledger: SessionLedgerV1;
	private mutationTail: Promise<void> = Promise.resolve();

	private constructor(session: Session, options: DurableRoleRegistryOptions) {
		this.ledger = new SessionLedgerV1(session, { ownerId: options.ownerId });
	}

	static async create(session: Session, options: DurableRoleRegistryOptions = {}): Promise<DurableModelProfileStoreV1> {
		const store = new DurableModelProfileStoreV1(session, options);
		try {
			await store.loadRecords();
			return store;
		} catch (error) {
			throw error instanceof DurableLedgerError ? new FoundationError(error.code, error.message, { cause: error }) : toFoundationError(error, "model_profile_persistence_invalid");
		}
	}

	async register(input: ModelProfilePutInputV1): Promise<ResultValue<ModelProfileV1, FoundationError>> {
		const result = this.mutationTail.then(async () => {
			try {
				const existingFact = await this.loadRecordFact(input.profile.modelProfileId);
				const existing = existingFact?.payload;
				const checked = validateSecretFreeModelProfileV1(input.profile);
				if (!checked.ok) return checked;
				const profile = checked.value;
				if (existing === undefined) {
					const record: ModelProfileRecordV1 = { schemaVersion: 1, modelProfileId: profile.modelProfileId, currentRevision: profile, revisions: [profile] };
					await this.persist(record, 0);
					return Result.ok(profile);
				}
				const same = existing.revisions.find((revision) => revision.revision === profile.revision);
				if (same !== undefined) return same.fingerprint.value === profile.fingerprint.value ? Result.ok(cloneDeepFrozen(same)) : Result.err(new FoundationError("profile_conflict", "Model Profile revision is immutable", { details: { modelProfileId: profile.modelProfileId, revision: profile.revision } }));
				if (profile.revision !== existing.currentRevision.revision + 1) return Result.err(new FoundationError("role_revision_immutable", "Model Profile revisions must be appended in order", { details: { modelProfileId: profile.modelProfileId, revision: profile.revision } }));
				const next: ModelProfileRecordV1 = { ...existing, currentRevision: profile, revisions: [...existing.revisions, profile] };
				await this.persist(next, existingFact?.revision ?? 0);
				return Result.ok(profile);
			} catch (error) {
				return resultError<ModelProfileV1>(error, "model_profile_persistence_failed");
			}
		});
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	async get(query: ModelProfileGetQueryV1): Promise<ResultValue<ModelProfileV1, FoundationError>> {
		await this.mutationTail;
		try {
			const record = await this.loadRecord(query.modelProfileId);
			if (record === undefined) return Result.err(new FoundationError("model_profile_not_found", "Model Profile is not registered", { details: { modelProfileId: query.modelProfileId } }));
			if (query.revision === undefined) return Result.ok(cloneDeepFrozen(record.currentRevision));
			const revision = record.revisions.find((candidate) => candidate.revision === query.revision);
			return revision === undefined ? Result.err(new FoundationError("model_profile_not_found", "Model Profile revision is not registered", { details: { modelProfileId: query.modelProfileId, revision: query.revision } })) : Result.ok(cloneDeepFrozen(revision));
		} catch (error) {
			return resultError(error, "model_profile_persistence_invalid");
		}
	}

	async list(): Promise<readonly ModelProfileRecordV1[]> {
		await this.mutationTail;
		const records = await this.loadRecords();
		return records.sort((left, right) => left.modelProfileId.localeCompare(right.modelProfileId)).map((record) => cloneDeepFrozen(record));
	}

	async release(): Promise<void> { await this.ledger.release(); }

	private async loadRecord(modelProfileId: string): Promise<ModelProfileRecordV1 | undefined> {
		return (await this.loadRecordFact(modelProfileId))?.payload;
	}

	private async loadRecords(): Promise<ModelProfileRecordV1[]> {
		return (await this.loadRecordFacts()).map((fact) => fact.payload);
	}

	private async loadRecordFacts(): Promise<readonly { readonly payload: ModelProfileRecordV1; readonly revision: number }[]> {
		const facts = await this.ledger.find({ kind: "fact", objectType: MODEL_PROFILE_OBJECT_TYPE_V1, order: "oldestFirst" });
		const records: { readonly payload: ModelProfileRecordV1; readonly revision: number }[] = [];
		for (const fact of facts) {
			if (fact.kind !== "fact") continue;
			const checked = validateModelProfileRecord(fact.payload);
			const existing = records.findIndex((record) => record.payload.modelProfileId === checked.modelProfileId);
			const stored = { payload: checked, revision: fact.revision };
			if (existing >= 0) records[existing] = stored;
			else records.push(stored);
		}
		return records;
	}

	private async loadRecordFact(modelProfileId: string): Promise<{ readonly payload: ModelProfileRecordV1; readonly revision: number } | undefined> {
		const records = await this.loadRecordFacts();
		return records.find((record) => record.payload.modelProfileId === modelProfileId);
	}

	private async persist(record: ModelProfileRecordV1, expectedRevision: number): Promise<void> {
		await this.ledger.appendFact(MODEL_PROFILE_OBJECT_TYPE_V1, record.modelProfileId, record, {
			clientRequestId: `model-profile:${record.modelProfileId}:${record.currentRevision.revision}`,
			expectedRevision,
			correlation: { modelProfileId: record.modelProfileId, modelProfileRevisionId: record.currentRevision.modelProfileId },
		});
	}
}

function validateModelProfileRecord(payload: unknown): ModelProfileRecordV1 {
	if (typeof payload !== "object" || payload === null) throw new FoundationError("model_profile_persistence_invalid", "Model Profile record is not an object");
	const candidate = payload as Record<string, unknown>;
	if (candidate.schemaVersion !== 1 || typeof candidate.modelProfileId !== "string" || !Array.isArray(candidate.revisions)) throw new FoundationError("model_profile_persistence_invalid", "Model Profile record shape is invalid");
	const current = validateSecretFreeModelProfileV1(candidate.currentRevision);
	if (!current.ok || current.value.modelProfileId !== candidate.modelProfileId) throw new FoundationError("model_profile_persistence_invalid", "Model Profile record identity is invalid");
	const revisions: ModelProfileV1[] = [];
	for (const revision of candidate.revisions) {
		const checked = validateSecretFreeModelProfileV1(revision);
		if (!checked.ok || checked.value.modelProfileId !== candidate.modelProfileId) throw new FoundationError("model_profile_persistence_invalid", "Model Profile revision identity is invalid");
		revisions.push(checked.value);
	}
	return { schemaVersion: 1, modelProfileId: candidate.modelProfileId, currentRevision: current.value, revisions };
}

export const DurableModelProfileStore = DurableModelProfileStoreV1;
