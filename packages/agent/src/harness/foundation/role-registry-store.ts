import { Type } from "typebox";
import { Result, type Result as ResultValue } from "../result.ts";
import type { Entry, EntryQuery } from "../session/types.ts";
import { FoundationError, toFoundationError } from "./errors.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { validateExactShape } from "./schema.ts";
import {
	InMemoryRoleRegistryV1,
	RoleRegistryRecordV1Schema,
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
	type RoleTombstoneV1,
} from "./role-registry.ts";
import { ModelProfileV1Schema, type ModelProfileV1 } from "./role.ts";
import { validateSecretFreeModelProfileV1 } from "./model-profile.ts";

/** Custom Session entry used for the latest immutable Role Registry snapshot. */
export const ROLE_REGISTRY_CUSTOM_TYPE_V1 = "foundation.role_registry.v1";

export interface RoleRegistrySession {
	findEntries(query: EntryQuery): Promise<readonly Entry[]>;
	appendCustomEntry(customType: string, data?: unknown): Promise<string>;
}

export interface DurableRoleRegistryOptions {
	readonly now?: () => string;
}

interface RoleRegistrySnapshotV1 {
	schemaVersion: 1;
	type: "snapshot";
	records: readonly RoleRegistryRecordV1[];
}

const RoleRegistrySnapshotV1Schema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		type: Type.Literal("snapshot"),
		records: Type.Array(RoleRegistryRecordV1Schema),
	},
	{ additionalProperties: false },
);

/**
 * Session-backed Role Registry facade. Mutations are serialized and persisted before they
 * resolve, so a later harness opening the same Session sees revisions and tombstones.
 */
export class DurableRoleRegistryV1 {
	private readonly session: RoleRegistrySession;
	private readonly registry: InMemoryRoleRegistryV1;
	private readonly now: () => string;
	private mutationTail: Promise<void> = Promise.resolve();

	private constructor(session: RoleRegistrySession, registry: InMemoryRoleRegistryV1, options: DurableRoleRegistryOptions) {
		this.session = session;
		this.registry = registry;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	static async create(session: RoleRegistrySession, options: DurableRoleRegistryOptions = {}): Promise<DurableRoleRegistryV1> {
		const now = options.now ?? (() => new Date().toISOString());
		try {
			const registry = new InMemoryRoleRegistryV1({ now });
			const entries = await session.findEntries({ customType: ROLE_REGISTRY_CUSTOM_TYPE_V1, order: "oldestFirst" });
			let records: readonly RoleRegistryRecordV1[] | undefined;
			for (const entry of entries) {
				if (entry.type !== "custom" || entry.customType !== ROLE_REGISTRY_CUSTOM_TYPE_V1) continue;
				const snapshot = validateExactShape<RoleRegistrySnapshotV1>(RoleRegistrySnapshotV1Schema, entry.data, "role_registry_snapshot", "role_registry_persistence_invalid");
				if (!snapshot.ok) throw snapshot.error;
				records = snapshot.value.records;
			}
			if (records !== undefined) {
				const imported = registry.import({ schemaVersion: 1, exportedAt: now(), records });
				if (!imported.ok) throw imported.error;
			}
			return new DurableRoleRegistryV1(session, registry, options);
		} catch (error) {
			throw toFoundationError(error, "role_registry_persistence_invalid");
		}
	}

	async create(input: RoleRegistryCreateInputV1): Promise<ResultValue<RoleRegistryRecordV1, FoundationError>> { return this.mutate(() => this.registry.create(input)); }
	async get(query: RoleRegistryGetQueryV1): Promise<ResultValue<RoleRegistryRecordV1, FoundationError>> { return this.read(() => this.registry.get(query)); }
	async list(query: RoleRegistryListQueryV1 = {}): Promise<ResultValue<readonly RoleRegistryRecordV1[], FoundationError>> { return this.read(() => this.registry.list(query)); }
	async search(query: RoleRegistrySearchQueryV1): Promise<ResultValue<readonly RoleRegistryRecordV1[], FoundationError>> { return this.read(() => this.registry.search(query)); }
	async edit(input: RoleRegistryEditInputV1): Promise<ResultValue<RoleRegistryRecordV1, FoundationError>> { return this.mutate(() => this.registry.edit(input)); }
	async copy(input: RoleRegistryCopyInputV1): Promise<ResultValue<RoleRegistryRecordV1, FoundationError>> { return this.mutate(() => this.registry.copy(input)); }
	async delete(input: RoleRegistryDeleteInputV1): Promise<ResultValue<RoleTombstoneV1, FoundationError>> { return this.mutate(() => this.registry.delete(input)); }
	async import(input: RoleRegistryImportV1): Promise<ResultValue<readonly RoleRegistryRecordV1[], FoundationError>> { return this.mutate(() => this.registry.import(input)); }
	async export(query: RoleRegistryExportQueryV1 = {}): Promise<ResultValue<RoleRegistryExportV1, FoundationError>> { return this.read(() => this.registry.export(query)); }
	async resolve(input: RoleResolveInputV1): Promise<ResultValue<RoleResolutionPreviewV1, FoundationError>> { return this.read(() => this.registry.resolve(input)); }

	private async read<T>(operation: () => ResultValue<T, FoundationError>): Promise<ResultValue<T, FoundationError>> {
		await this.mutationTail;
		return operation();
	}

	private mutate<T>(operation: () => ResultValue<T, FoundationError>): Promise<ResultValue<T, FoundationError>> {
		const result = this.mutationTail.then(async () => {
			const previous = this.registry.list({ includeTombstones: true });
			if (!previous.ok) return previous as ResultValue<T, FoundationError>;
			const next = operation();
			if (!next.ok) return next;
			try {
				await this.persist();
				return next;
			} catch (error) {
				this.registry.import({ schemaVersion: 1, exportedAt: this.now(), records: previous.value });
				return Result.err(toFoundationError(error, "role_registry_persistence_failed"));
			}
		});
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private async persist(): Promise<void> {
		const records = this.registry.list({ includeTombstones: true });
		if (!records.ok) throw records.error;
		const snapshot: RoleRegistrySnapshotV1 = { schemaVersion: 1, type: "snapshot", records: records.value };
		await this.session.appendCustomEntry(ROLE_REGISTRY_CUSTOM_TYPE_V1, snapshot);
	}
}

export const DurableRoleRegistry = DurableRoleRegistryV1;

/** Custom Session entry used for the latest immutable Model Profile snapshot. */
export const MODEL_PROFILE_CUSTOM_TYPE_V1 = "foundation.model_profile.v1";

export interface ModelProfileSession {
	findEntries(query: EntryQuery): Promise<readonly Entry[]>;
	appendCustomEntry(customType: string, data?: unknown): Promise<string>;
}

export interface ModelProfileRecordV1 {
	schemaVersion: 1;
	modelProfileId: string;
	currentRevision: ModelProfileV1;
	revisions: readonly ModelProfileV1[];
}

export interface ModelProfilePutInputV1 { profile: ModelProfileV1; }
export interface ModelProfileGetQueryV1 { modelProfileId: string; revision?: number; }

const ModelProfileRecordV1Schema = Type.Object({ schemaVersion: Type.Literal(1), modelProfileId: Type.String({ minLength: 1 }), currentRevision: ModelProfileV1Schema, revisions: Type.Array(ModelProfileV1Schema) }, { additionalProperties: false });
const ModelProfileSnapshotV1Schema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.Literal("snapshot"), records: Type.Array(ModelProfileRecordV1Schema) }, { additionalProperties: false });
interface ModelProfileSnapshotV1 { schemaVersion: 1; type: "snapshot"; records: readonly ModelProfileRecordV1[]; }

/** Session-backed storage for secret-free, independently versioned ModelProfile revisions. */
export class DurableModelProfileStoreV1 {
	private readonly session: ModelProfileSession;
	private readonly records = new Map<string, ModelProfileRecordV1>();
	private mutationTail: Promise<void> = Promise.resolve();

	private constructor(session: ModelProfileSession) { this.session = session; }

	static async create(session: ModelProfileSession): Promise<DurableModelProfileStoreV1> {
		try {
			const store = new DurableModelProfileStoreV1(session);
			const entries = await session.findEntries({ customType: MODEL_PROFILE_CUSTOM_TYPE_V1, order: "oldestFirst" });
			for (const entry of entries) {
				if (entry.type !== "custom" || entry.customType !== MODEL_PROFILE_CUSTOM_TYPE_V1) continue;
				const snapshot = validateExactShape<ModelProfileSnapshotV1>(ModelProfileSnapshotV1Schema, entry.data, "model_profile_snapshot", "model_profile_persistence_invalid");
				if (!snapshot.ok) throw snapshot.error;
				store.records.clear();
				for (const record of snapshot.value.records) {
					const current = validateSecretFreeModelProfileV1(record.currentRevision);
					if (!current.ok || current.value.modelProfileId !== record.modelProfileId) throw new FoundationError("model_profile_persistence_invalid", "Model Profile snapshot identity is invalid");
					for (const revision of record.revisions) {
						const checked = validateSecretFreeModelProfileV1(revision);
						if (!checked.ok || checked.value.modelProfileId !== record.modelProfileId) throw new FoundationError("model_profile_persistence_invalid", "Model Profile snapshot revision is invalid");
					}
					store.records.set(record.modelProfileId, cloneDeepFrozen(record));
				}
			}
			return store;
		} catch (error) {
			throw toFoundationError(error, "model_profile_persistence_invalid");
		}
	}

	async register(input: ModelProfilePutInputV1): Promise<ResultValue<ModelProfileV1, FoundationError>> {
		return this.mutate(() => {
			const checked = validateSecretFreeModelProfileV1(input.profile);
			if (!checked.ok) return checked;
			const profile = checked.value;
			const existing = this.records.get(profile.modelProfileId);
			if (existing === undefined) {
				this.records.set(profile.modelProfileId, cloneDeepFrozen({ schemaVersion: 1, modelProfileId: profile.modelProfileId, currentRevision: profile, revisions: [profile] }));
				return Result.ok(profile);
			}
			const same = existing.revisions.find((revision) => revision.revision === profile.revision);
			if (same !== undefined) return same.fingerprint.value === profile.fingerprint.value ? Result.ok(cloneDeepFrozen(same)) : Result.err(new FoundationError("profile_conflict", "Model Profile revision is immutable", { details: { modelProfileId: profile.modelProfileId, revision: profile.revision } }));
			if (profile.revision !== existing.currentRevision.revision + 1) return Result.err(new FoundationError("role_revision_immutable", "Model Profile revisions must be appended in order", { details: { modelProfileId: profile.modelProfileId, revision: profile.revision } }));
			const next = cloneDeepFrozen({ ...existing, currentRevision: profile, revisions: [...existing.revisions, profile] });
			this.records.set(profile.modelProfileId, next);
			return Result.ok(profile);
		});
	}

	async get(query: ModelProfileGetQueryV1): Promise<ResultValue<ModelProfileV1, FoundationError>> {
		await this.mutationTail;
		const record = this.records.get(query.modelProfileId);
		if (record === undefined) return Result.err(new FoundationError("model_profile_not_found", "Model Profile is not registered", { details: { modelProfileId: query.modelProfileId } }));
		if (query.revision === undefined) return Result.ok(cloneDeepFrozen(record.currentRevision));
		const revision = record.revisions.find((candidate) => candidate.revision === query.revision);
		return revision === undefined ? Result.err(new FoundationError("model_profile_not_found", "Model Profile revision is not registered", { details: { modelProfileId: query.modelProfileId, revision: query.revision } })) : Result.ok(cloneDeepFrozen(revision));
	}

	async list(): Promise<readonly ModelProfileRecordV1[]> {
		await this.mutationTail;
		return [...this.records.values()].sort((left, right) => left.modelProfileId.localeCompare(right.modelProfileId)).map((record) => cloneDeepFrozen(record));
	}

	private mutate<T>(operation: () => ResultValue<T, FoundationError>): Promise<ResultValue<T, FoundationError>> {
		const result = this.mutationTail.then(async () => {
			const previous = new Map(this.records);
			const next = operation();
			if (!next.ok) return next;
			try {
				await this.persist();
				return next;
			} catch (error) {
				this.records.clear();
				for (const [key, record] of previous) this.records.set(key, record);
				return Result.err(toFoundationError(error, "model_profile_persistence_failed"));
			}
		});
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private async persist(): Promise<void> {
		const snapshot: ModelProfileSnapshotV1 = { schemaVersion: 1, type: "snapshot", records: [...this.records.values()].sort((left, right) => left.modelProfileId.localeCompare(right.modelProfileId)) };
		await this.session.appendCustomEntry(MODEL_PROFILE_CUSTOM_TYPE_V1, snapshot);
	}
}

export const DurableModelProfileStore = DurableModelProfileStoreV1;
