import { sha256HexValue, type FoundationJsonValue } from "./foundation/index.ts";
import type { FileSystem } from "./types.ts";
import type { Session } from "./session/session.ts";
import {
	SessionLedgerWriter,
	LEDGER_OBJECT_TYPES,
	assertSessionLedgerWriterSession,
	type SessionLedgerWriterOptions,
} from "./session/ledger-writer.ts";

export type ArtifactId = string;
export type ArtifactDigest = `sha256:${string}`;
export type ArtifactValidationState = "verified" | "pending" | "corrupt" | "unknown" | "missing";

export interface ArtifactRetentionPolicy {
	readonly policy: "session" | "task" | "goal" | "project" | "indefinite";
	readonly expiresAt?: number | string;
}

export interface ArtifactAcl {
	readonly owner: string;
	readonly readers: readonly string[];
	readonly writers: readonly string[];
}

/** Manifest is durable metadata. It never contains the artifact body. */
export interface ArtifactManifest {
	readonly schemaVersion: 1;
	readonly artifactId: ArtifactId;
	readonly digest: ArtifactDigest;
	readonly sha256: ArtifactId;
	readonly sizeBytes: number;
	readonly name?: string;
	readonly mediaType: string;
	readonly permissions: readonly string[];
	readonly acl: ArtifactAcl;
	readonly retention: ArtifactRetentionPolicy;
	readonly validation: {
		readonly state: ArtifactValidationState;
		readonly validator?: string;
		readonly validatedAt?: number;
		readonly error?: string;
	};
	readonly producer?: string;
	readonly createdAt: number;
}

export interface ArtifactMetadata {
	readonly id: ArtifactId;
	readonly artifactId: ArtifactId;
	readonly sha256: ArtifactId;
	readonly digest: ArtifactDigest;
	readonly size: number;
	readonly sizeBytes: number;
	readonly name?: string;
	readonly mediaType: string;
	readonly contentType: string;
	readonly permissions: readonly string[];
	readonly acl: ArtifactAcl;
	readonly retention: ArtifactRetentionPolicy;
	readonly validation: ArtifactManifest["validation"];
	readonly validationState: ArtifactValidationState;
	readonly producer?: string;
	readonly createdAt: number;
	readonly manifest: ArtifactManifest;
}

export interface ArtifactReference {
	readonly type: "artifact";
	readonly artifactId: ArtifactId;
	readonly id: ArtifactId;
	readonly digest: ArtifactDigest;
	readonly mediaType: string;
	readonly sizeBytes: number;
	readonly redacted: true;
}
export type RedactedArtifactReference = ArtifactReference;
export type AttachmentReference = ArtifactReference;
export type StructuredResultReference = ArtifactReference;

export interface Artifact {
	readonly metadata: ArtifactMetadata;
	readonly content: Uint8Array;
}

export interface ArtifactPutOptions {
	readonly name?: string;
	readonly mediaType?: string;
	readonly contentType?: string;
	readonly principal?: string;
	readonly permissions?: readonly string[];
	readonly acl?: Partial<ArtifactAcl>;
	readonly retention?: ArtifactRetentionPolicy;
	readonly validation?: ArtifactManifest["validation"];
	readonly producer?: string;
	/** Stable idempotency key for a caller-owned manifest mutation. */
	readonly clientRequestId?: string;
}

export interface ArtifactBlobStore {
	put(id: ArtifactId, content: Uint8Array): Promise<void>;
	get(id: ArtifactId): Promise<Uint8Array | undefined>;
	has(id: ArtifactId): Promise<boolean>;
	remove(id: ArtifactId): Promise<boolean>;
}

export interface ArtifactStoreOptions extends SessionLedgerWriterOptions {
	readonly blobStore?: ArtifactBlobStore;
	readonly writer?: SessionLedgerWriter;
	/** Filesystem capability and root for an explicitly selected blob backend. */
	readonly fs?: FileSystem;
	readonly artifactRoot?: string;
	/** In-memory blobs are test-only and must be opted into explicitly. */
	readonly allowInMemory?: boolean;
}

export type ArtifactStoreErrorCode =
	| "invalid_id"
	| "invalid_manifest"
	| "forbidden"
	| "expired"
	| "too_large"
	| "limit_reached"
	| "corrupt"
	| "missing"
	| "not_found"
	| "in_use"
	| "storage";

export class ArtifactStoreError extends Error {
	readonly code: ArtifactStoreErrorCode;

	constructor(code: ArtifactStoreErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ArtifactStoreError";
		this.code = code;
	}
}

export function isValidArtifactId(id: string): boolean {
	return /^[0-9a-f]{64}$/.test(id);
}

export function isValidArtifactDigest(digest: string): digest is ArtifactDigest {
	return /^sha256:[0-9a-f]{64}$/.test(digest);
}

export function artifactDigestFromId(id: ArtifactId): ArtifactDigest {
	if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
	return `sha256:${id}`;
}

export function artifactIdFromDigest(digest: ArtifactDigest): ArtifactId {
	if (!isValidArtifactDigest(digest)) throw new ArtifactStoreError("invalid_id", `Invalid artifact digest: ${digest}`);
	return digest.slice("sha256:".length);
}

export function sha256Hex(content: Uint8Array): ArtifactId {
	return sha256HexValue(content);
}

export function verifyArtifact(content: Uint8Array, id: ArtifactId): boolean {
	return isValidArtifactId(id) && sha256Hex(content) === id;
}

export function redactArtifactReference(value: ArtifactMetadata | ArtifactReference): ArtifactReference {
	const artifactId = value.artifactId;
	if (
		!isValidArtifactId(artifactId) ||
		!isValidArtifactDigest(value.digest) ||
		value.digest !== artifactDigestFromId(artifactId) ||
		typeof value.mediaType !== "string" ||
		value.mediaType.length === 0 ||
		(!Number.isSafeInteger("size" in value ? value.size : value.sizeBytes) || ("size" in value ? value.size : value.sizeBytes) < 0)
	) throw new ArtifactStoreError("invalid_manifest", "Invalid artifact reference");
	return {
		type: "artifact",
		artifactId,
		id: artifactId,
		digest: value.digest,
		mediaType: value.mediaType,
		sizeBytes: "size" in value ? value.size : value.sizeBytes,
		redacted: true,
	};
}
export const projectArtifactReference = redactArtifactReference;

function cloneBytes(value: Uint8Array): Uint8Array {
	return Uint8Array.from(value);
}

function cloneManifest(value: ArtifactManifest): ArtifactManifest {
	return structuredClone(value);
}

function validateText(value: string | undefined, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) throw new ArtifactStoreError("invalid_manifest", `Invalid artifact ${field}`);
	return value.slice(0, 255);
}

function normalizeRetention(value: ArtifactRetentionPolicy | undefined): ArtifactRetentionPolicy {
	const retention = value ?? { policy: "session" as const };
	if (!("session|task|goal|project|indefinite" as const).split("|").includes(retention.policy)) throw new ArtifactStoreError("invalid_manifest", "Invalid artifact retention policy");
	if (typeof retention.expiresAt === "number" && (!Number.isFinite(retention.expiresAt) || retention.expiresAt < 0)) throw new ArtifactStoreError("invalid_manifest", "Invalid artifact expiry");
	return { policy: retention.policy, ...(retention.expiresAt === undefined ? {} : { expiresAt: typeof retention.expiresAt === "string" ? validateText(retention.expiresAt, "expiry") : retention.expiresAt }) };
}

function normalizeAcl(options: ArtifactPutOptions | undefined): ArtifactAcl {
	const owner = options?.acl?.owner ?? options?.principal ?? "system";
	const readers = [...new Set(options?.acl?.readers ?? options?.permissions ?? [owner])].filter((value) => value.length > 0).sort();
	const writers = [...new Set(options?.acl?.writers ?? [owner])].filter((value) => value.length > 0).sort();
	if (owner.length === 0 || readers.length === 0 || writers.length === 0) throw new ArtifactStoreError("invalid_manifest", "Artifact ACL must name an owner and principal");
	return { owner, readers, writers };
}

function expired(retention: ArtifactRetentionPolicy, now: number): boolean {
	if (retention.expiresAt === undefined) return false;
	const expiry = typeof retention.expiresAt === "number" ? retention.expiresAt : Date.parse(retention.expiresAt);
	return Number.isFinite(expiry) && expiry <= now;
}

function metadataFromManifest(manifest: ArtifactManifest): ArtifactMetadata {
	return {
		id: manifest.artifactId,
		artifactId: manifest.artifactId,
		sha256: manifest.sha256,
		digest: manifest.digest,
		size: manifest.sizeBytes,
		sizeBytes: manifest.sizeBytes,
		...(manifest.name === undefined ? {} : { name: manifest.name }),
		mediaType: manifest.mediaType,
		contentType: manifest.mediaType,
		permissions: [...manifest.permissions],
		acl: structuredClone(manifest.acl),
		retention: structuredClone(manifest.retention),
		validation: structuredClone(manifest.validation),
		validationState: manifest.validation.state,
		...(manifest.producer === undefined ? {} : { producer: manifest.producer }),
		createdAt: manifest.createdAt,
		manifest: cloneManifest(manifest),
	};
}

function manifestPayload(options: {
	readonly id: ArtifactId;
	readonly size: number;
	readonly put?: ArtifactPutOptions;
	readonly now: number;
}): ArtifactManifest {
	const mediaType = validateText(options.put?.mediaType ?? options.put?.contentType ?? "application/octet-stream", "mediaType")!;
	const acl = normalizeAcl(options.put);
	const validation = options.put?.validation ?? { state: "verified" as const, validatedAt: options.now };
	if (!("verified|pending|corrupt|unknown|missing" as const).split("|").includes(validation.state)) throw new ArtifactStoreError("invalid_manifest", "Invalid artifact validation state");
	const digest = artifactDigestFromId(options.id);
	return {
		schemaVersion: 1,
		artifactId: options.id,
		digest,
		sha256: options.id,
		sizeBytes: options.size,
		...(validateText(options.put?.name, "name") === undefined ? {} : { name: validateText(options.put?.name, "name") }),
		mediaType,
		permissions: [...acl.readers],
		acl,
		retention: normalizeRetention(options.put?.retention),
		validation,
		...(validateText(options.put?.producer, "producer") === undefined ? {} : { producer: validateText(options.put?.producer, "producer") }),
		createdAt: options.now,
	};
}

function validateManifest(value: ArtifactManifest): ArtifactManifest {
	if (value === null || typeof value !== "object") throw new ArtifactStoreError("invalid_manifest", "Artifact manifest must be an object");
	if (value.schemaVersion !== 1 || !isValidArtifactId(value.artifactId) || value.sha256 !== value.artifactId || value.digest !== artifactDigestFromId(value.artifactId)) {
		throw new ArtifactStoreError("invalid_manifest", "Artifact manifest digest identity is invalid");
	}
	if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || typeof value.mediaType !== "string" || value.mediaType.length === 0) {
		throw new ArtifactStoreError("invalid_manifest", `Artifact manifest ${value.artifactId} has invalid metadata`);
	}
	const retention = value.retention;
	const validRetention =
		retention !== undefined &&
		retention !== null &&
		typeof retention === "object" &&
		("session|task|goal|project|indefinite" as const).split("|").includes(retention.policy) &&
		(retention.expiresAt === undefined ||
			(typeof retention.expiresAt === "number" && Number.isFinite(retention.expiresAt) && retention.expiresAt >= 0) ||
			(typeof retention.expiresAt === "string" && Number.isFinite(Date.parse(retention.expiresAt))));
	const acl = value.acl;
	const validAcl =
		acl !== undefined &&
		acl !== null &&
		typeof acl === "object" &&
		typeof acl.owner === "string" &&
		acl.owner.length > 0 &&
		Array.isArray(acl.readers) &&
		acl.readers.length > 0 &&
		acl.readers.every((principal) => typeof principal === "string" && principal.length > 0) &&
		Array.isArray(acl.writers) &&
		acl.writers.length > 0 &&
		acl.writers.every((principal) => typeof principal === "string" && principal.length > 0);
	const validation = value.validation;
	const validValidation =
		validation !== undefined &&
		validation !== null &&
		typeof validation === "object" &&
		("verified|pending|corrupt|unknown|missing" as const).split("|").includes(validation.state) &&
		(validation.validatedAt === undefined || Number.isFinite(validation.validatedAt));
	if (!validAcl || !validRetention || !validValidation || !Array.isArray(value.permissions) || value.permissions.some((principal) => typeof principal !== "string")) {
		throw new ArtifactStoreError("invalid_manifest", `Artifact manifest ${value.artifactId} has an invalid ACL`);
	}
	return value;
}

/** Blob-only backend. It cannot create a reference or a manifest by itself. */
export class InMemoryArtifactBlobStore implements ArtifactBlobStore {
	private readonly blobs = new Map<ArtifactId, Uint8Array>();

	async put(id: ArtifactId, content: Uint8Array): Promise<void> {
		if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
		if (!verifyArtifact(content, id)) throw new ArtifactStoreError("corrupt", `Blob content does not match artifact id: ${id}`);
		this.blobs.set(id, cloneBytes(content));
	}
	async get(id: ArtifactId): Promise<Uint8Array | undefined> {
		if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
		const content = this.blobs.get(id);
		return content === undefined ? undefined : cloneBytes(content);
	}
	async has(id: ArtifactId): Promise<boolean> {
		if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
		return this.blobs.has(id);
	}
	async remove(id: ArtifactId): Promise<boolean> {
		if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
		return this.blobs.delete(id);
	}
	/** Test/recovery hook; the manifest remains in Session and exposes corruption. */
	corrupt(id: ArtifactId, content: Uint8Array): void {
		this.blobs.set(id, cloneBytes(content));
	}
}

function unwrap<T>(value: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!value.ok) throw value.error;
	return value.value;
}

/** Filesystem blob backend. Manifests remain exclusively in Session. */
export class FileSystemArtifactBlobStore implements ArtifactBlobStore {
	private readonly fs: FileSystem;
	private readonly root: string;

	constructor(fs: FileSystem, root: string) {
		this.fs = fs;
		this.root = root;
	}

	private async path(id: ArtifactId): Promise<string> {
		if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
		return unwrap(await this.fs.joinPath([this.root, "blobs", id.slice(0, 2), id.slice(2)]));
	}

	async put(id: ArtifactId, content: Uint8Array): Promise<void> {
		if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
		if (!verifyArtifact(content, id)) throw new ArtifactStoreError("corrupt", `Blob content does not match artifact id: ${id}`);
		const path = await this.path(id);
		const directory = unwrap(await this.fs.joinPath([this.root, "blobs", id.slice(0, 2)]));
		unwrap(await this.fs.createDir(directory, { recursive: true }));
		unwrap(await this.fs.writeFile(path, content));
	}
	async get(id: ArtifactId): Promise<Uint8Array | undefined> {
		const result = await this.fs.readBinaryFile(await this.path(id));
		if (!result.ok && result.error.code === "not_found") return undefined;
		return unwrap(result);
	}
	async has(id: ArtifactId): Promise<boolean> {
		return unwrap(await this.fs.exists(await this.path(id)));
	}
	async remove(id: ArtifactId): Promise<boolean> {
		const path = await this.path(id);
		if (!unwrap(await this.fs.exists(path))) return false;
		unwrap(await this.fs.remove(path, { force: true }));
		return true;
	}
}

/** Durable reference fact used to protect shared CAS content from early deletion. */
export interface ArtifactReferenceRecord {
	readonly schemaVersion: 1;
	readonly referenceId: string;
	readonly artifactId: ArtifactId;
	readonly consumerType: string;
	readonly consumerId: string;
	readonly createdAt: number;
	readonly expiresAt?: number;
}

function validateReference(value: ArtifactReferenceRecord): ArtifactReferenceRecord {
	if (
		value === null ||
		typeof value !== "object" ||
		value.schemaVersion !== 1 ||
		typeof value.referenceId !== "string" ||
		value.referenceId.length === 0 ||
		!isValidArtifactId(value.artifactId) ||
		typeof value.consumerType !== "string" ||
		value.consumerType.length === 0 ||
		typeof value.consumerId !== "string" ||
		value.consumerId.length === 0 ||
		!Number.isFinite(value.createdAt) ||
		(value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt < 0))
	) {
		throw new ArtifactStoreError("invalid_manifest", "Artifact reference is invalid");
	}
	return value;
}

/**
 * Default Node backend for a persistent Session. The blob root is derived
 * from the JSONL session path, so reopening the same Session metadata finds
 * the same bytes. In-memory Sessions must pass an explicit blobStore (or the
 * test-only allowInMemory option) instead of silently losing artifacts.
 */
class SessionFileArtifactBlobStore implements ArtifactBlobStore {
	private readonly configuredRoot?: string;
	private readonly session: Session;
	private rootsPromise?: Promise<SessionArtifactRoots>;

	constructor(session: Session, root?: string) {
		this.session = session;
		this.configuredRoot = root;
	}

	private roots(): Promise<SessionArtifactRoots> {
		if (this.rootsPromise === undefined) {
			this.rootsPromise = this.configuredRoot === undefined
				? this.deriveRoots()
				: Promise.resolve({ current: this.configuredRoot });
		}
		return this.rootsPromise;
	}

	private async deriveRoots(): Promise<SessionArtifactRoots> {
		const metadata = await this.session.getMetadata();
		const path = (metadata as SessionMetadataWithPath).path;
		if (typeof path !== "string" || path.length === 0) {
			throw new ArtifactStoreError(
				"storage",
				"A persistent artifact root is unavailable for this Session; pass an explicit blobStore for tests",
			);
		}
		return {
			current: `${path}.context-artifacts`,
			legacy: `${path}.t5-artifacts`,
		};
	}

	private path(root: string, id: ArtifactId): string {
		if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
		return joinArtifactPath(root, "blobs", id.slice(0, 2), id.slice(2));
	}

	private async readRoot(): Promise<string> {
		const roots = await this.roots();
		if (roots.legacy === undefined) return roots.current;
		try {
			await nodeFileSystemPromises().access(roots.current);
			return roots.current;
		} catch (error) {
			if (isNodeNotFoundError(error)) return roots.legacy;
			throw error;
		}
	}

	async put(id: ArtifactId, content: Uint8Array): Promise<void> {
		if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
		if (!verifyArtifact(content, id)) throw new ArtifactStoreError("corrupt", `Blob content does not match artifact id: ${id}`);
		const root = (await this.roots()).current;
		const path = this.path(root, id);
		const fs = nodeFileSystemPromises();
		await fs.mkdir(joinArtifactPath(root, "blobs", id.slice(0, 2)), { recursive: true });
		await fs.writeFile(path, content);
	}

	async get(id: ArtifactId): Promise<Uint8Array | undefined> {
		const fs = nodeFileSystemPromises();
		try {
			return Uint8Array.from(await fs.readFile(this.path(await this.readRoot(), id)));
		} catch (error) {
			if (isNodeNotFoundError(error)) return undefined;
			throw new ArtifactStoreError("storage", `Failed to read artifact blob ${id}`, error instanceof Error ? error : undefined);
		}
	}

	async has(id: ArtifactId): Promise<boolean> {
		const fs = nodeFileSystemPromises();
		try {
			await fs.access(this.path(await this.readRoot(), id));
			return true;
		} catch (error) {
			if (isNodeNotFoundError(error)) return false;
			throw new ArtifactStoreError("storage", `Failed to inspect artifact blob ${id}`, error instanceof Error ? error : undefined);
		}
	}

	async remove(id: ArtifactId): Promise<boolean> {
		const fs = nodeFileSystemPromises();
		try {
			await fs.unlink(this.path(await this.readRoot(), id));
			return true;
		} catch (error) {
			if (isNodeNotFoundError(error)) return false;
			throw new ArtifactStoreError("storage", `Failed to remove artifact blob ${id}`, error instanceof Error ? error : undefined);
		}
	}
}

interface SessionArtifactRoots {
	readonly current: string;
	readonly legacy?: string;
}

interface SessionMetadataWithPath {
	readonly path?: string;
}

interface NodeFileSystemPromises {
	access(path: string): Promise<void>;
	mkdir(path: string, options: { readonly recursive: true }): Promise<string | undefined>;
	readFile(path: string): Promise<Uint8Array>;
	unlink(path: string): Promise<void>;
	writeFile(path: string, content: Uint8Array): Promise<void>;
}

function nodeFileSystemPromises(): NodeFileSystemPromises {
	const processValue = (globalThis as { readonly process?: { readonly getBuiltinModule?: (name: string) => unknown } }).process;
	const module = processValue?.getBuiltinModule?.("node:fs/promises") as NodeFileSystemPromises | undefined;
	if (module === undefined) throw new ArtifactStoreError("storage", "The default persistent artifact backend requires Node filesystem capabilities");
	return module;
}

function isNodeNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function joinArtifactPath(root: string, ...parts: string[]): string {
	const separator = root.includes("\\") ? "\\" : "/";
	return [root.replace(/[\\/]$/, ""), ...parts].join(separator);
}

/**
 * Session-backed content-addressed artifact store. The blob backend is only
 * a recoverable cache; manifest, ACL, retention, and validation authority are
 * all Foundation facts in the supplied Session.
 */
export class SessionArtifactStore {
	readonly session: Session;
	readonly writer: SessionLedgerWriter;
	readonly blobs: ArtifactBlobStore;
	private readonly now: () => number;

	constructor(session: Session, options: ArtifactStoreOptions = {}) {
		this.session = session;
		this.writer = options.writer ?? new SessionLedgerWriter(session, options);
		if (options.writer !== undefined) assertSessionLedgerWriterSession(session, options.writer, "ArtifactStore");
		this.blobs =
			options.blobStore ??
			(options.fs !== undefined && options.artifactRoot !== undefined
				? new FileSystemArtifactBlobStore(options.fs, options.artifactRoot)
				: options.allowInMemory === true
					? new InMemoryArtifactBlobStore()
					: new SessionFileArtifactBlobStore(session, options.artifactRoot));
		this.now = options.now ?? Date.now;
	}

	async put(content: Uint8Array, options?: ArtifactPutOptions): Promise<ArtifactMetadata> {
		const id = sha256Hex(content);
		const existing = await this.manifest(id);
		if (existing !== undefined) {
			if (existing.sizeBytes !== content.byteLength || existing.digest !== artifactDigestFromId(id)) throw new ArtifactStoreError("invalid_manifest", `Artifact manifest ${id} does not match content`);
			const stored = await this.blobs.get(id);
			if (stored === undefined || !verifyArtifact(stored, id) || stored.byteLength !== content.byteLength) await this.blobs.put(id, content);
			return metadataFromManifest(existing);
		}
		const manifest = manifestPayload({ id, size: content.byteLength, put: options, now: this.now() });
		await this.blobs.put(id, content);
		const accepted = await this.writer.writeFact({
			objectType: LEDGER_OBJECT_TYPES.artifactManifest,
			objectId: id,
			clientRequestId: options?.clientRequestId ?? `artifact-manifest:${id}`,
			payload: manifest as unknown as FoundationJsonValue,
		});
		return metadataFromManifest(accepted.payload as unknown as ArtifactManifest);
	}

	async get(id: ArtifactId, principal = "system"): Promise<Artifact> {
		const manifest = await this.requireManifest(id);
		this.assertReadable(manifest, principal);
		const content = await this.blobs.get(id);
		if (content === undefined) throw new ArtifactStoreError("missing", `Artifact blob is missing: ${id}`);
		if (content.byteLength !== manifest.sizeBytes || !verifyArtifact(content, id)) throw new ArtifactStoreError("corrupt", `Artifact blob is corrupt: ${id}`);
		return { metadata: metadataFromManifest(manifest), content };
	}

	async getReference(id: ArtifactId, principal = "system"): Promise<ArtifactReference> {
		const manifest = await this.requireManifest(id);
		this.assertReadable(manifest, principal);
		return redactArtifactReference(metadataFromManifest(manifest));
	}

	async putAttachment(content: Uint8Array, options: ArtifactPutOptions = {}): Promise<ArtifactReference> {
		return redactArtifactReference(await this.put(content, { ...options, mediaType: options.mediaType ?? "application/octet-stream" }));
	}

	async putStructuredResult(content: Uint8Array, options: ArtifactPutOptions = {}): Promise<ArtifactReference> {
		return redactArtifactReference(await this.put(content, { ...options, mediaType: options.mediaType ?? "application/json" }));
	}

	async verify(id: ArtifactId): Promise<ArtifactValidationState> {
		const manifest = await this.manifest(id);
		if (manifest === undefined) return "unknown";
		if (expired(manifest.retention, this.now()) && !(await this.hasLiveReference(id))) return "unknown";
		const content = await this.blobs.get(id);
		if (content === undefined) return "missing";
		return content.byteLength === manifest.sizeBytes && verifyArtifact(content, id) ? "verified" : "corrupt";
	}

	async has(id: ArtifactId): Promise<boolean> {
		return (await this.manifest(id)) !== undefined;
	}

	async remove(id: ArtifactId, principal = "system"): Promise<boolean> {
		const manifest = await this.manifest(id);
		if (manifest === undefined) return false;
		if (!manifest.acl.writers.includes("*") && !manifest.acl.writers.includes(principal)) throw new ArtifactStoreError("forbidden", `Principal ${principal} cannot remove artifact ${id}`);
		if ((await this.listReferences(id)).length > 0) {
			throw new ArtifactStoreError("in_use", `Artifact ${id} is still referenced by live Session objects`);
		}
		await this.writer.tombstone({ objectType: LEDGER_OBJECT_TYPES.artifactManifest, objectId: id, reason: "artifact_removed" });
		await this.blobs.remove(id);
		return true;
	}

	async list(): Promise<ArtifactMetadata[]> {
		const facts = await this.writer.listFacts({ objectType: LEDGER_OBJECT_TYPES.artifactManifest });
		const current = new Map<string, ArtifactMetadata>();
		for (const fact of facts) {
			const object = await this.writer.readFact<FoundationJsonValue>(LEDGER_OBJECT_TYPES.artifactManifest, fact.objectId);
			if (object !== undefined) {
				const manifest = validateManifest(object.payload as unknown as ArtifactManifest);
				if (manifest.artifactId !== fact.objectId) throw new ArtifactStoreError("invalid_manifest", `Artifact manifest ${fact.objectId} has a mismatched identity`);
				current.set(fact.objectId, metadataFromManifest(manifest));
			}
		}
		return [...current.values()].sort((left, right) => left.id.localeCompare(right.id));
	}

	/** Add one durable owner reference; repeating the same reference is a replay. */
	async retainReference(options: {
		readonly artifactId: ArtifactId;
		readonly referenceId: string;
		readonly consumerType: string;
		readonly consumerId: string;
		readonly expiresAt?: number;
	}): Promise<ArtifactReferenceRecord> {
		const manifest = await this.manifest(options.artifactId);
		if (manifest === undefined) throw new ArtifactStoreError("not_found", `Artifact manifest not found: ${options.artifactId}`);
		const existing = await this.writer.readFact<FoundationJsonValue>(LEDGER_OBJECT_TYPES.artifactReference, options.referenceId);
		if (existing !== undefined) {
			const stored = validateReference(existing.payload as unknown as ArtifactReferenceRecord);
			if (
				stored.referenceId !== options.referenceId ||
				stored.artifactId !== options.artifactId ||
				stored.consumerType !== options.consumerType ||
				stored.consumerId !== options.consumerId
			) {
				throw new ArtifactStoreError("invalid_manifest", `Artifact reference ${options.referenceId} is immutable`);
			}
			return stored;
		}
		const reference: ArtifactReferenceRecord = {
			schemaVersion: 1,
			referenceId: options.referenceId,
			artifactId: options.artifactId,
			consumerType: options.consumerType,
			consumerId: options.consumerId,
			createdAt: this.now(),
			...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
		};
		const accepted = await this.writer.writeFact({
			objectType: LEDGER_OBJECT_TYPES.artifactReference,
			objectId: options.referenceId,
			clientRequestId: `artifact-reference:${options.referenceId}`,
			payload: reference as unknown as FoundationJsonValue,
		});
		return accepted.payload as unknown as ArtifactReferenceRecord;
	}

	/** Release one owner reference. The manifest/blob remain while another owner exists. */
	async releaseReference(referenceId: string): Promise<boolean> {
		const current = await this.writer.readFact<FoundationJsonValue>(LEDGER_OBJECT_TYPES.artifactReference, referenceId);
		if (current === undefined) return false;
		await this.writer.tombstone({
			objectType: LEDGER_OBJECT_TYPES.artifactReference,
			objectId: referenceId,
			clientRequestId: `artifact-reference-release:${referenceId}`,
			reason: "artifact_reference_released",
		});
		return true;
	}

	async listReferences(artifactId?: ArtifactId): Promise<ArtifactReferenceRecord[]> {
		const facts = await this.writer.listFacts({ objectType: LEDGER_OBJECT_TYPES.artifactReference });
		const references: ArtifactReferenceRecord[] = [];
		for (const fact of facts) {
			const current = await this.writer.readFact<FoundationJsonValue>(LEDGER_OBJECT_TYPES.artifactReference, fact.objectId);
			if (current === undefined) continue;
			const reference = validateReference(current.payload as unknown as ArtifactReferenceRecord);
			if (reference.referenceId !== fact.objectId) throw new ArtifactStoreError("invalid_manifest", `Artifact reference ${fact.objectId} has a mismatched identity`);
			if (reference.expiresAt !== undefined && reference.expiresAt <= this.now()) continue;
			if (artifactId === undefined || reference.artifactId === artifactId) references.push(reference);
		}
		return references;
	}

	private async hasLiveReference(artifactId: ArtifactId): Promise<boolean> {
		return (await this.listReferences(artifactId)).length > 0;
	}

	private async manifest(id: ArtifactId): Promise<ArtifactManifest | undefined> {
		if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
		const result = await this.writer.readFact<FoundationJsonValue>(LEDGER_OBJECT_TYPES.artifactManifest, id);
		if (result === undefined) return undefined;
		const manifest = validateManifest(result.payload as unknown as ArtifactManifest);
		if (manifest.artifactId !== id) throw new ArtifactStoreError("invalid_manifest", `Artifact manifest ${id} has a mismatched identity`);
		return manifest;
	}

	private async requireManifest(id: ArtifactId): Promise<ArtifactManifest> {
		const manifest = await this.manifest(id);
		if (manifest === undefined) throw new ArtifactStoreError("not_found", `Artifact manifest not found: ${id}`);
		if (expired(manifest.retention, this.now()) && !(await this.hasLiveReference(id))) throw new ArtifactStoreError("expired", `Artifact retention expired: ${id}`);
		return manifest;
	}

	private assertReadable(manifest: ArtifactManifest, principal: string): void {
		if (!manifest.acl.readers.includes("*") && !manifest.acl.readers.includes(principal)) throw new ArtifactStoreError("forbidden", `Principal ${principal} cannot read artifact ${manifest.artifactId}`);
	}
}

/** Explicitly Session-backed convenience class; no unconnected fixture store is exported. */
export class InMemoryArtifactStore extends SessionArtifactStore {
	constructor(session: Session, options: Omit<ArtifactStoreOptions, "blobStore"> = {}) {
		super(session, { ...options, blobStore: new InMemoryArtifactBlobStore() });
	}
}

export class FileSystemArtifactStore extends SessionArtifactStore {
	constructor(session: Session, fs: FileSystem, root: string, options: Omit<ArtifactStoreOptions, "blobStore"> = {}) {
		super(session, { ...options, blobStore: new FileSystemArtifactBlobStore(fs, root) });
	}
}
