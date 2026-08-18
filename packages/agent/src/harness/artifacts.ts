import { sha256HexValue, type FoundationJsonValue } from "./foundation/index.ts";
import type { FileSystem } from "./types.ts";
import type { Session } from "./session/session.ts";
import { SessionLedgerWriter, T5_LEDGER_OBJECT_TYPES, type SessionLedgerWriterOptions } from "./session/t5.ts";

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
export interface ArtifactManifestV1 {
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
	readonly validation: ArtifactManifestV1["validation"];
	readonly validationState: ArtifactValidationState;
	readonly producer?: string;
	readonly createdAt: number;
	readonly manifest: ArtifactManifestV1;
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
	readonly validation?: ArtifactManifestV1["validation"];
	readonly producer?: string;
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
	if (!isValidArtifactId(artifactId) || !isValidArtifactDigest(value.digest)) throw new ArtifactStoreError("invalid_manifest", "Invalid artifact reference");
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

function cloneManifest(value: ArtifactManifestV1): ArtifactManifestV1 {
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

function metadataFromManifest(manifest: ArtifactManifestV1): ArtifactMetadata {
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
}): ArtifactManifestV1 {
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

/** Blob-only backend. It cannot create a reference or a manifest by itself. */
export class InMemoryArtifactBlobStore implements ArtifactBlobStore {
	private readonly blobs = new Map<ArtifactId, Uint8Array>();

	async put(id: ArtifactId, content: Uint8Array): Promise<void> {
		this.blobs.set(id, cloneBytes(content));
	}
	async get(id: ArtifactId): Promise<Uint8Array | undefined> {
		const content = this.blobs.get(id);
		return content === undefined ? undefined : cloneBytes(content);
	}
	async has(id: ArtifactId): Promise<boolean> {
		return this.blobs.has(id);
	}
	async remove(id: ArtifactId): Promise<boolean> {
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
		return unwrap(await this.fs.joinPath([this.root, "blobs", id.slice(0, 2), id.slice(2)]));
	}

	async put(id: ArtifactId, content: Uint8Array): Promise<void> {
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
		this.blobs = options.blobStore ?? new InMemoryArtifactBlobStore();
		this.now = options.now ?? Date.now;
	}

	async put(content: Uint8Array, options?: ArtifactPutOptions): Promise<ArtifactMetadata> {
		const id = sha256Hex(content);
		const existing = await this.manifest(id);
		if (existing !== undefined) {
			if (existing.sizeBytes !== content.byteLength || existing.digest !== artifactDigestFromId(id)) throw new ArtifactStoreError("invalid_manifest", `Artifact manifest ${id} does not match content`);
			if (!(await this.blobs.has(id))) await this.blobs.put(id, content);
			return metadataFromManifest(existing);
		}
		const manifest = manifestPayload({ id, size: content.byteLength, put: options, now: this.now() });
		await this.blobs.put(id, content);
		const accepted = await this.writer.writeFact({
			objectType: T5_LEDGER_OBJECT_TYPES.artifactManifest,
			objectId: id,
			payload: manifest as unknown as FoundationJsonValue,
		});
		return metadataFromManifest(accepted.payload as unknown as ArtifactManifestV1);
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
		if (expired(manifest.retention, this.now())) return "unknown";
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
		await this.writer.tombstone({ objectType: T5_LEDGER_OBJECT_TYPES.artifactManifest, objectId: id, reason: "artifact_removed" });
		await this.blobs.remove(id);
		return true;
	}

	async list(): Promise<ArtifactMetadata[]> {
		const facts = await this.writer.listFacts({ objectType: T5_LEDGER_OBJECT_TYPES.artifactManifest });
		return facts.map((fact) => metadataFromManifest(fact.payload as unknown as ArtifactManifestV1));
	}

	private async manifest(id: ArtifactId): Promise<ArtifactManifestV1 | undefined> {
		if (!isValidArtifactId(id)) throw new ArtifactStoreError("invalid_id", `Invalid artifact id: ${id}`);
		const result = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.artifactManifest, id);
		return result === undefined ? undefined : result.payload as unknown as ArtifactManifestV1;
	}

	private async requireManifest(id: ArtifactId): Promise<ArtifactManifestV1> {
		const manifest = await this.manifest(id);
		if (manifest === undefined) throw new ArtifactStoreError("not_found", `Artifact manifest not found: ${id}`);
		if (expired(manifest.retention, this.now())) throw new ArtifactStoreError("expired", `Artifact retention expired: ${id}`);
		return manifest;
	}

	private assertReadable(manifest: ArtifactManifestV1, principal: string): void {
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
