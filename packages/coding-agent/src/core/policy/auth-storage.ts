/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth handling belongs to ModelRuntime and the AOS Agent model layer.
 */

import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@aos-agent/ai";
import { randomUUID } from "node:crypto";
import { join } from "path";
import { getAgentDir } from "../../config.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { getFileRevision, normalizePath } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import {
	LockedAtomicFileStorage,
	readControlPlaneState,
	readControlPlaneStateReadOnly,
} from "../control-plane-atomic-storage.ts";
import { isCommandConfigValue, resolveConfigValue } from "../resolve-config-value.ts";

export const AUTH_CREDENTIAL_ROTATION_SCHEMA_VERSION = 1 as const;

const AUTH_CREDENTIAL_ROTATION_KEY = "_aosCredentialRotation";
const AUTH_CREDENTIAL_REVISION_MAX_LENGTH = 128;

export interface AuthCredentialPreviousRevision {
	revisionId: string;
	credential: Credential;
	validUntil: string;
}

export interface AuthCredentialRotationMetadata {
	schemaVersion: typeof AUTH_CREDENTIAL_ROTATION_SCHEMA_VERSION;
	activeRevisionId: string;
	previous?: AuthCredentialPreviousRevision;
}

export interface AuthCredentialRotationSnapshot {
	activeRevisionId: string;
	previousRevisionId?: string;
	previousValidUntil?: string;
}

type StoredCredential = Credential & {
	_aosCredentialRotation?: AuthCredentialRotationMetadata;
};

type AuthStorageData = Record<string, StoredCredential>;

type LockResult<T> = {
	result: T;
	next?: string;
};

type AuthFileReload = {
	controller: AbortController;
	promise: Promise<AuthStorageData>;
	readers: number;
};

type AuthFileReadState = {
	data: AuthStorageData;
	valid: boolean;
	revision?: string;
	reload?: AuthFileReload;
};

let sharedAuthFileReadState: { authPath: string; readState: AuthFileReadState } | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const epochMs = Date.parse(value);
	return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
}

function isCredentialRevisionId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= AUTH_CREDENTIAL_REVISION_MAX_LENGTH &&
		/^[A-Za-z0-9._-]+$/.test(value)
	);
}

function parseCredential(value: unknown, providerId: string): Credential {
	if (!isRecord(value)) {
		throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
	}
	if (value.type === "api_key") {
		const key = typeof value.key === "string" ? value.key : undefined;
		const validKey = value.key === undefined || key !== undefined;
		const validEnv =
			value.env === undefined ||
			(isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === "string"));
		if (validKey && validEnv) {
			return {
				type: "api_key",
				...(key === undefined ? {} : { key }),
				...(value.env === undefined ? {} : { env: { ...value.env } as Record<string, string> }),
			};
		}
	} else if (
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	) {
		const credential = structuredClone(value);
		delete credential[AUTH_CREDENTIAL_ROTATION_KEY];
		return credential as Credential;
	}
	throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
}

function parseRotationMetadata(value: unknown, providerId: string): AuthCredentialRotationMetadata | undefined {
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(["schemaVersion", "activeRevisionId", "previous"])) ||
		value.schemaVersion !== AUTH_CREDENTIAL_ROTATION_SCHEMA_VERSION ||
		!isCredentialRevisionId(value.activeRevisionId)
	) {
		throw new Error(`Invalid auth.json rotation metadata for provider "${providerId}"`);
	}
	let previous: AuthCredentialPreviousRevision | undefined;
	if (value.previous !== undefined) {
		if (
			!isRecord(value.previous) ||
			!hasOnlyKeys(value.previous, new Set(["revisionId", "credential", "validUntil"])) ||
			!isCredentialRevisionId(value.previous.revisionId) ||
			!isCanonicalTimestamp(value.previous.validUntil) ||
			value.previous.revisionId === value.activeRevisionId
		) {
			throw new Error(`Invalid auth.json rotation metadata for provider "${providerId}"`);
		}
		previous = {
			revisionId: value.previous.revisionId,
			credential: parseCredential(value.previous.credential, providerId),
			validUntil: value.previous.validUntil,
		};
	}
	return {
		schemaVersion: AUTH_CREDENTIAL_ROTATION_SCHEMA_VERSION,
		activeRevisionId: value.activeRevisionId,
		...(previous === undefined ? {} : { previous }),
	};
}

function storedCredential(credential: Credential, rotation?: AuthCredentialRotationMetadata): StoredCredential {
	const stored = structuredClone(credential) as StoredCredential;
	delete stored._aosCredentialRotation;
	if (rotation !== undefined) stored._aosCredentialRotation = structuredClone(rotation);
	return stored;
}

function credentialFromStored(value: StoredCredential): Credential {
	const credential = structuredClone(value) as StoredCredential;
	delete credential._aosCredentialRotation;
	return credential;
}

function rotationFromStored(value: StoredCredential): AuthCredentialRotationMetadata | undefined {
	return value._aosCredentialRotation === undefined ? undefined : structuredClone(value._aosCredentialRotation);
}

function parseAuthStorageData(content: string): AuthStorageData {
	const parsed: unknown = JSON.parse(stripBom(content));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Invalid auth.json: expected an object");
	}
	const data: AuthStorageData = {};
	for (const [providerId, value] of Object.entries(parsed)) {
		const credential = parseCredential(value, providerId);
		const rotation = parseRotationMetadata(isRecord(value) ? value[AUTH_CREDENTIAL_ROTATION_KEY] : undefined, providerId);
		data[providerId] = storedCredential(credential, rotation);
	}
	return data;
}

const AUTH_STORAGE_OPTIONS = {
	validate: (content: string) => {
		parseAuthStorageData(content);
	},
	mode: 0o600,
	directoryMode: 0o700,
} as const;

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private readonly storage: LockedAtomicFileStorage;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.storage = new LockedAtomicFileStorage(normalizePath(authPath), "{}", AUTH_STORAGE_OPTIONS);
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		return this.storage.withLock(fn);
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		return this.storage.withLockAsync(fn, options);
	}
}

export class ReadOnlyAuthStorage implements CredentialStore {
	private readonly authPath: string;
	private data: AuthStorageData | undefined;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private load(): AuthStorageData {
		if (this.data) return this.data;

		const content = readControlPlaneStateReadOnly(this.authPath, AUTH_STORAGE_OPTIONS);
		this.data = content === undefined ? {} : parseAuthStorageData(content);
		return this.data;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const stored = this.load()[providerId];
		options?.signal?.throwIfAborted();
		if (!stored) return undefined;
		const credential = credentialFromStored(stored);
		if (credential.type !== "api_key" || !credential.key || isCommandConfigValue(credential.key)) {
			return structuredClone(credential);
		}
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = Object.entries(this.load()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
		options?.signal?.throwIfAborted();
		return credentials;
	}

	async modify(
		_providerId: string,
		_fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}

	async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncChain: Promise<unknown> = Promise.resolve();

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		const previous = this.asyncChain;
		const operation = (async () => {
			await previous.catch(() => {});
			options?.signal?.throwIfAborted();
			const { result, next } = await fn(this.value);
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		})();
		this.asyncChain = operation.catch(() => {});
		return raceWithAbortSignal(operation, options?.signal);
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage implements CredentialStore {
	private storage: AuthStorageBackend;
	private authPath: string | undefined;
	private readState: AuthFileReadState;

	private constructor(storage: AuthStorageBackend, authPath?: string) {
		this.storage = storage;
		this.authPath = authPath;
		this.readState =
			authPath && sharedAuthFileReadState?.authPath === authPath
				? sharedAuthFileReadState.readState
				: { data: {}, valid: false };
		if (authPath && !sharedAuthFileReadState) {
			sharedAuthFileReadState = { authPath, readState: this.readState };
		}
		if (authPath) {
			const revision = getFileRevision(authPath);
			if (this.readState.valid && revision !== undefined && revision === this.readState.revision) return;
		}
		this.reload();
	}

	static create(authPath: string = join(getAgentDir(), "auth.json")): AuthStorage {
		const normalizedAuthPath = normalizePath(authPath);
		return new AuthStorage(new FileAuthStorageBackend(normalizedAuthPath), normalizedAuthPath);
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return parseAuthStorageData(content);
	}

	private updateReadState(data: AuthStorageData, revision?: string): void {
		this.readState.data = data;
		this.readState.valid = true;
		this.readState.revision = revision;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		let revision: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: undefined };
			});
			this.updateReadState(this.parseStorageData(content), revision);
		} catch {
			// Preserve the last valid in-memory snapshot.
		}
	}

	private async reloadFromStorageAsync(options?: AuthOperationOptions): Promise<AuthStorageData> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const revision = this.authPath ? getFileRevision(this.authPath) : undefined;
			this.updateReadState(currentData, revision);
			return { result: currentData };
		}, options);
	}

	private async readLatestData(options?: AuthOperationOptions): Promise<AuthStorageData> {
		options?.signal?.throwIfAborted();
		if (!this.authPath) {
			const reload = this.reloadFromStorageAsync(options);
			return options?.signal
				? reload
				: reload.catch((error: unknown) => {
						if (this.readState.valid) return this.readState.data;
						throw error;
					});
		}
		const revision = getFileRevision(this.authPath);
		if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		if (!this.readState.reload) {
			const controller = new AbortController();
			const reload: AuthFileReload = {
				controller,
				promise: this.reloadFromStorageAsync({ signal: controller.signal }),
				readers: 0,
			};
			this.readState.reload = reload;
			void reload.promise.then(
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
			);
		}

		const reload = this.readState.reload;
		reload.readers++;
		try {
			const result = raceWithAbortSignal(reload.promise, options?.signal);
			return options?.signal
				? await result
				: await result.catch((error: unknown) => {
						if (this.readState.valid) return this.readState.data;
						throw error;
					});
		} finally {
			reload.readers--;
			if (reload.readers === 0 && this.readState.reload === reload) {
				this.readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const stored = (await this.readLatestData(options))[provider];
		options?.signal?.throwIfAborted();
		const credential = stored === undefined ? undefined : credentialFromStored(stored);
		if (credential?.type !== "api_key") return credential;
		if (credential.key === undefined) return credential;
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		let latestData = this.readState.data;
		let revision: string | undefined;
		const result = await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const current = currentData[provider];
			const next = await fn(current === undefined ? undefined : credentialFromStored(current));
			if (next === undefined) {
				latestData = currentData;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: current === undefined ? undefined : credentialFromStored(current) };
			}

			const merged: AuthStorageData = {
				...currentData,
				[provider]: storedCredential(next, current === undefined ? undefined : rotationFromStored(current)),
			};
			latestData = merged;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		}, options);
		this.updateReadState(latestData, revision);
		return result;
	}

	async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		let latestData = this.readState.data;
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			latestData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		}, options);
		this.updateReadState(latestData);
	}

	/** List credential metadata without resolving configured key values. */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = Object.entries(await this.readLatestData(options));
		options?.signal?.throwIfAborted();
		return entries.map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
}

/**
 * One-off synchronous read of a stored credential from an auth.json file,
 * without instantiating a store or resolving configured key values.
 */
export function readStoredCredential(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	const content = readControlPlaneState(normalizePath(authPath), AUTH_STORAGE_OPTIONS);
	const stored = content === undefined ? undefined : parseAuthStorageData(content)[providerId];
	return stored === undefined ? undefined : credentialFromStored(stored);
}

function createCredentialRevisionId(): string {
	return `credential_revision_${randomUUID().replaceAll("-", "")}`;
}

function validateRotationClock(nowMs: number): void {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
		throw new TypeError("Credential rotation requires a valid epoch timestamp");
	}
}

function validateTransitionTtl(transitionTtlMs: number): void {
	if (!Number.isSafeInteger(transitionTtlMs) || transitionTtlMs <= 0) {
		throw new TypeError("Credential rotation transition TTL must be a positive safe integer");
	}
}

function rotationSnapshot(metadata: AuthCredentialRotationMetadata): AuthCredentialRotationSnapshot {
	return {
		activeRevisionId: metadata.activeRevisionId,
		...(metadata.previous === undefined
			? {}
			: {
					previousRevisionId: metadata.previous.revisionId,
					previousValidUntil: metadata.previous.validUntil,
				}),
	};
}

/** Ensure a stored provider credential has a stable revision id for projection binding. */
export function ensureStoredCredentialRevision(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
	createRevision: () => string = createCredentialRevisionId,
): AuthCredentialRotationSnapshot {
	const backend = new FileAuthStorageBackend(authPath);
	return backend.withLock((content) => {
		const data = content === undefined ? {} : parseAuthStorageData(content);
		const current = data[providerId];
		if (current === undefined) throw new Error("Credential is not configured");
		const existing = rotationFromStored(current);
		if (existing !== undefined) return { result: rotationSnapshot(existing) };
		const activeRevisionId = createRevision();
		if (!isCredentialRevisionId(activeRevisionId)) throw new TypeError("Credential revision id is invalid");
		const metadata: AuthCredentialRotationMetadata = {
			schemaVersion: AUTH_CREDENTIAL_ROTATION_SCHEMA_VERSION,
			activeRevisionId,
		};
		data[providerId] = storedCredential(credentialFromStored(current), metadata);
		return { result: rotationSnapshot(metadata), next: JSON.stringify(data, null, 2) };
	});
}

export interface RotateStoredCredentialOptions {
	transitionTtlMs: number;
	nowMs?: number;
	createRevisionId?: () => string;
}

/** Atomically install a new active credential and retain the old revision for a bounded transition window. */
export function rotateStoredCredential(
	providerId: string,
	nextCredential: Credential,
	options: RotateStoredCredentialOptions,
	authPath: string = join(getAgentDir(), "auth.json"),
): AuthCredentialRotationSnapshot {
	const nowMs = options.nowMs ?? Date.now();
	validateRotationClock(nowMs);
	validateTransitionTtl(options.transitionTtlMs);
	const parsedNext = parseCredential(nextCredential, providerId);
	const createRevision = options.createRevisionId ?? createCredentialRevisionId;
	const backend = new FileAuthStorageBackend(authPath);
	return backend.withLock((content) => {
		const data = content === undefined ? {} : parseAuthStorageData(content);
		const current = data[providerId];
		if (current === undefined) throw new Error("Credential is not configured");
		const currentRotation = rotationFromStored(current);
		const previousRevisionId = currentRotation?.activeRevisionId ?? createRevision();
		const activeRevisionId = createRevision();
		if (
			!isCredentialRevisionId(previousRevisionId) ||
			!isCredentialRevisionId(activeRevisionId) ||
			previousRevisionId === activeRevisionId
		) {
			throw new TypeError("Credential revision id is invalid");
		}
		const metadata: AuthCredentialRotationMetadata = {
			schemaVersion: AUTH_CREDENTIAL_ROTATION_SCHEMA_VERSION,
			activeRevisionId,
			previous: {
				revisionId: previousRevisionId,
				credential: credentialFromStored(current),
				validUntil: new Date(nowMs + options.transitionTtlMs).toISOString(),
			},
		};
		data[providerId] = storedCredential(parsedNext, metadata);
		return { result: rotationSnapshot(metadata), next: JSON.stringify(data, null, 2) };
	});
}

/** Atomically revoke the retained old credential revision. Active credentials cannot be revoked through this path. */
export function revokeStoredCredentialRevision(
	providerId: string,
	revisionId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
): boolean {
	if (!isCredentialRevisionId(revisionId)) throw new TypeError("Credential revision id is invalid");
	const backend = new FileAuthStorageBackend(authPath);
	return backend.withLock((content) => {
		const data = content === undefined ? {} : parseAuthStorageData(content);
		const current = data[providerId];
		if (current === undefined) return { result: false };
		const rotation = rotationFromStored(current);
		if (rotation?.previous?.revisionId !== revisionId) return { result: false };
		const nextRotation: AuthCredentialRotationMetadata = {
			schemaVersion: AUTH_CREDENTIAL_ROTATION_SCHEMA_VERSION,
			activeRevisionId: rotation.activeRevisionId,
		};
		data[providerId] = storedCredential(credentialFromStored(current), nextRotation);
		return { result: true, next: JSON.stringify(data, null, 2) };
	});
}

/** Resolve one exact credential revision while its transition window remains valid. */
export function readStoredCredentialRevision(
	providerId: string,
	revisionId: string,
	nowMs: number = Date.now(),
	authPath: string = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	if (!isCredentialRevisionId(revisionId)) return undefined;
	validateRotationClock(nowMs);
	const content = readControlPlaneState(normalizePath(authPath), AUTH_STORAGE_OPTIONS);
	if (content === undefined) return undefined;
	const current = parseAuthStorageData(content)[providerId];
	if (current === undefined) return undefined;
	const rotation = rotationFromStored(current);
	if (rotation?.activeRevisionId === revisionId) return credentialFromStored(current);
	if (rotation?.previous?.revisionId !== revisionId || nowMs >= Date.parse(rotation.previous.validUntil)) {
		return undefined;
	}
	return structuredClone(rotation.previous.credential);
}
