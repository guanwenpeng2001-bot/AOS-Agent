/**
 * Local short-lived credential projections.
 *
 * The vault persists only opaque references and lease/revision metadata. Raw
 * credentials remain in auth.json and are resolved locally only when a
 * trusted host consumer presents a live reference.
 */

import type { Credential } from "@aos-agent/ai";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { normalizePath } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import { LockedAtomicFileStorage } from "../control-plane-atomic-storage.ts";
import { resolveConfigValue } from "../resolve-config-value.ts";
import {
	ensureStoredCredentialRevision,
	readStoredCredentialRevision,
	revokeStoredCredentialRevision,
	rotateStoredCredential,
	type AuthCredentialRotationSnapshot,
	type RotateStoredCredentialOptions,
} from "./auth-storage.ts";

export const CREDENTIAL_VAULT_SCHEMA_VERSION = 1 as const;

const CREDENTIAL_PROJECTION_REFERENCE_MAX_LENGTH = 160;
const CREDENTIAL_PROJECTION_IDENTIFIER_MAX_LENGTH = 200;
const CREDENTIAL_PROJECTION_MAX_PER_LEASE = 64;

export const CREDENTIAL_VAULT_ERROR_CODES = [
	"credential_projection_invalid",
	"credential_projection_not_found",
	"credential_projection_conflict",
	"credential_projection_expired",
	"credential_projection_revoked",
	"credential_revision_unavailable",
] as const;

export type CredentialVaultErrorCode = (typeof CREDENTIAL_VAULT_ERROR_CODES)[number];

export class CredentialVaultError extends Error {
	readonly code: CredentialVaultErrorCode;

	constructor(code: CredentialVaultErrorCode) {
		super(code);
		this.name = "CredentialVaultError";
		this.code = code;
	}
}

export type CredentialProjectionStatus = "active" | "expired" | "revoked";

/** Safe persisted projection metadata. Never contains credential material. */
export interface CredentialProjectionRecord {
	readonly schemaVersion: typeof CREDENTIAL_VAULT_SCHEMA_VERSION;
	readonly reference: string;
	readonly credentialName: string;
	readonly credentialRevisionId: string;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly status: CredentialProjectionStatus;
	readonly issuedAt: string;
	readonly expiresAt: string;
	expiredAt?: string;
	revokedAt?: string;
}

interface CredentialVaultState {
	readonly schemaVersion: typeof CREDENTIAL_VAULT_SCHEMA_VERSION;
	readonly projections: ReadonlyArray<CredentialProjectionRecord>;
}

export interface CredentialProjectionIssueRequest {
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly credentialNames: ReadonlyArray<string>;
	readonly requestedTtlMs: number;
	readonly issuedAtMs?: number;
}

export interface CredentialProjectionRenewRequest {
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly requestedTtlMs: number;
	readonly renewedAtMs?: number;
}

export interface CredentialProjectionRevokeRequest {
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly revokedAtMs?: number;
}

export interface LocalCredentialVaultOptions {
	authPath?: string;
	statePath?: string;
	now?: () => number;
	createId?: () => string;
}

const VAULT_STORAGE_OPTIONS = {
	validate: (content: string) => {
		parseCredentialVaultState(content);
	},
	mode: 0o600,
	directoryMode: 0o700,
} as const;

const STATE_KEYS = new Set(["schemaVersion", "projections"]);
const PROJECTION_KEYS = new Set([
	"schemaVersion",
	"reference",
	"credentialName",
	"credentialRevisionId",
	"leaseId",
	"grantId",
	"bindingId",
	"status",
	"issuedAt",
	"expiresAt",
	"expiredAt",
	"revokedAt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= CREDENTIAL_PROJECTION_IDENTIFIER_MAX_LENGTH &&
		/^[A-Za-z0-9._:-]+$/.test(value)
	);
}

function isReference(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= CREDENTIAL_PROJECTION_REFERENCE_MAX_LENGTH &&
		/^credential_projection_[A-Za-z0-9_-]+$/.test(value)
	);
}

function isTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const epochMs = Date.parse(value);
	return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === value;
}

function isEpochMs(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveTtl(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseProjection(value: unknown): CredentialProjectionRecord | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, PROJECTION_KEYS)) return undefined;
	if (value.schemaVersion !== CREDENTIAL_VAULT_SCHEMA_VERSION) return undefined;
	if (
		!isReference(value.reference) ||
		!isIdentifier(value.credentialName) ||
		!isIdentifier(value.credentialRevisionId) ||
		!isIdentifier(value.leaseId) ||
		!isIdentifier(value.grantId) ||
		!isIdentifier(value.bindingId)
	) {
		return undefined;
	}
	if (value.status !== "active" && value.status !== "expired" && value.status !== "revoked") return undefined;
	if (!isTimestamp(value.issuedAt) || !isTimestamp(value.expiresAt)) return undefined;
	if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) return undefined;
	if (value.expiredAt !== undefined && !isTimestamp(value.expiredAt)) return undefined;
	if (value.revokedAt !== undefined && !isTimestamp(value.revokedAt)) return undefined;
	if ((value.status === "revoked") !== (value.revokedAt !== undefined)) return undefined;
	if (value.status === "active" && value.expiredAt !== undefined) return undefined;
	if (value.status === "expired" && value.expiredAt === undefined) return undefined;
	return {
		schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION,
		reference: value.reference,
		credentialName: value.credentialName,
		credentialRevisionId: value.credentialRevisionId,
		leaseId: value.leaseId,
		grantId: value.grantId,
		bindingId: value.bindingId,
		status: value.status,
		issuedAt: value.issuedAt,
		expiresAt: value.expiresAt,
		...(value.expiredAt === undefined ? {} : { expiredAt: value.expiredAt }),
		...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
	};
}

function parseCredentialVaultState(content: string): CredentialVaultState {
	const parsed: unknown = JSON.parse(stripBom(content));
	if (
		!isRecord(parsed) ||
		!hasOnlyKeys(parsed, STATE_KEYS) ||
		parsed.schemaVersion !== CREDENTIAL_VAULT_SCHEMA_VERSION ||
		!Array.isArray(parsed.projections)
	) {
		throw new Error("Invalid credential vault state");
	}
	const projections = parsed.projections.map((value) => parseProjection(value));
	if (projections.some((value) => value === undefined)) throw new Error("Invalid credential vault projection");
	const records = projections as CredentialProjectionRecord[];
	const references = new Set<string>();
	for (const record of records) {
		if (references.has(record.reference)) throw new Error("Duplicate credential vault projection reference");
		references.add(record.reference);
	}
	return { schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION, projections: records };
}

function serializeState(projections: ReadonlyArray<CredentialProjectionRecord>): string {
	return JSON.stringify({ schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION, projections }, null, 2);
}

function validateLeaseIdentity(leaseId: string, grantId: string, bindingId: string): void {
	if (!isIdentifier(leaseId) || !isIdentifier(grantId) || !isIdentifier(bindingId)) {
		throw new CredentialVaultError("credential_projection_invalid");
	}
}

function normalizeCredentialNames(names: ReadonlyArray<string>): ReadonlyArray<string> {
	if (!Array.isArray(names) || names.length === 0 || names.length > CREDENTIAL_PROJECTION_MAX_PER_LEASE) {
		throw new CredentialVaultError("credential_projection_invalid");
	}
	const unique = [...new Set(names)];
	if (unique.length !== names.length || unique.some((name) => !isIdentifier(name))) {
		throw new CredentialVaultError("credential_projection_invalid");
	}
	return unique.sort((left, right) => left.localeCompare(right));
}

function referencesFrom(records: ReadonlyArray<CredentialProjectionRecord>): Readonly<Record<string, string>> {
	return Object.fromEntries(records.map((record) => [record.credentialName, record.reference]));
}

function expireProjectionRecords(
	records: ReadonlyArray<CredentialProjectionRecord>,
	nowMs: number,
): { projections: ReadonlyArray<CredentialProjectionRecord>; changed: boolean } {
	let changed = false;
	const expiredAt = new Date(nowMs).toISOString();
	const projections = records.map((record): CredentialProjectionRecord => {
		if (record.status !== "active" || nowMs < Date.parse(record.expiresAt)) return record;
		changed = true;
		return { ...record, status: "expired", expiredAt };
	});
	return { projections, changed };
}

function defaultId(): string {
	return randomUUID().replaceAll("-", "");
}

export class LocalCredentialVault {
	private readonly authPath: string;
	private readonly storage: LockedAtomicFileStorage;
	private readonly now: () => number;
	private readonly createId: () => string;

	constructor(options: LocalCredentialVaultOptions = {}) {
		this.authPath = normalizePath(options.authPath ?? join(getAgentDir(), "auth.json"));
		const statePath = normalizePath(options.statePath ?? join(dirname(this.authPath), "credential-vault.json"));
		this.storage = new LockedAtomicFileStorage(
			statePath,
			serializeState([]),
			VAULT_STORAGE_OPTIONS,
		);
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? defaultId;
	}

	issue(request: CredentialProjectionIssueRequest): Readonly<Record<string, string>> {
		validateLeaseIdentity(request.leaseId, request.grantId, request.bindingId);
		if (!isPositiveTtl(request.requestedTtlMs)) {
			throw new CredentialVaultError("credential_projection_invalid");
		}
		const issuedAtMs = request.issuedAtMs ?? this.now();
		if (!isEpochMs(issuedAtMs)) throw new CredentialVaultError("credential_projection_invalid");
		const credentialNames = normalizeCredentialNames(request.credentialNames);
		const revisions = new Map<string, string>();
		for (const credentialName of credentialNames) {
			try {
				const rotation = ensureStoredCredentialRevision(credentialName, this.authPath, () => {
					const revisionId = `credential_revision_${this.createId()}`;
					return revisionId;
				});
				revisions.set(credentialName, rotation.activeRevisionId);
			} catch (error) {
				if (error instanceof CredentialVaultError) throw error;
				throw new CredentialVaultError("credential_revision_unavailable");
			}
		}

		return this.storage.withLock((content) => {
			const state = parseCredentialVaultState(content ?? serializeState([]));
			const existing = state.projections.filter((record) => record.leaseId === request.leaseId);
			if (existing.length > 0) {
				const existingNames = existing.map((record) => record.credentialName).sort((left, right) => left.localeCompare(right));
				if (
					existing.some(
						(record) => record.grantId !== request.grantId || record.bindingId !== request.bindingId,
					) ||
					existingNames.length !== credentialNames.length ||
					existingNames.some((name, index) => name !== credentialNames[index])
				) {
					throw new CredentialVaultError("credential_projection_conflict");
				}
				return { result: referencesFrom(existing) };
			}
			const issuedAt = new Date(issuedAtMs).toISOString();
			const expiresAt = new Date(issuedAtMs + request.requestedTtlMs).toISOString();
			const created = credentialNames.map((credentialName): CredentialProjectionRecord => {
				const credentialRevisionId = revisions.get(credentialName);
				if (credentialRevisionId === undefined) {
					throw new CredentialVaultError("credential_revision_unavailable");
				}
				return {
					schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION,
					reference: `credential_projection_${this.createId()}`,
					credentialName,
					credentialRevisionId,
					leaseId: request.leaseId,
					grantId: request.grantId,
					bindingId: request.bindingId,
					status: "active",
					issuedAt,
					expiresAt,
				};
			});
			if (created.some((record) => !isReference(record.reference))) {
				throw new CredentialVaultError("credential_projection_invalid");
			}
			const projections = [...state.projections, ...created];
			return { result: referencesFrom(created), next: serializeState(projections) };
		});
	}

	getLeaseReferences(
		leaseId: string,
		grantId: string,
		bindingId: string,
		nowMs: number = this.now(),
	): Readonly<Record<string, string>> {
		validateLeaseIdentity(leaseId, grantId, bindingId);
		if (!isEpochMs(nowMs)) throw new CredentialVaultError("credential_projection_invalid");
		const outcome = this.storage.withLock<
			| { readonly references: Readonly<Record<string, string>> }
			| { readonly error: "credential_projection_expired" | "credential_projection_revoked" }
		>((content) => {
			const state = parseCredentialVaultState(content ?? serializeState([]));
			const expired = expireProjectionRecords(state.projections, nowMs);
			const records = expired.projections.filter((record) => record.leaseId === leaseId);
			if (records.length === 0) throw new CredentialVaultError("credential_projection_not_found");
			if (records.some((record) => record.grantId !== grantId || record.bindingId !== bindingId)) {
				throw new CredentialVaultError("credential_projection_conflict");
			}
			for (const record of records) {
				if (record.status === "revoked") {
					return { result: { error: "credential_projection_revoked" as const } };
				}
				if (record.status === "expired") {
					return {
						result: { error: "credential_projection_expired" as const },
						...(expired.changed ? { next: serializeState(expired.projections) } : {}),
					};
				}
				if (
					readStoredCredentialRevision(
						record.credentialName,
						record.credentialRevisionId,
						nowMs,
						this.authPath,
					) === undefined
				) {
					throw new CredentialVaultError("credential_revision_unavailable");
				}
			}
			return {
				result: { references: referencesFrom(records) },
				...(expired.changed ? { next: serializeState(expired.projections) } : {}),
			};
		});
		if ("error" in outcome) throw new CredentialVaultError(outcome.error);
		return outcome.references;
	}

	resolve(reference: string, nowMs: number = this.now()): Credential | undefined {
		if (!isReference(reference) || !isEpochMs(nowMs)) return undefined;
		const record = this.storage.withLock((content) => {
			const state = parseCredentialVaultState(content ?? serializeState([]));
			const expired = expireProjectionRecords(state.projections, nowMs);
			return {
				result: expired.projections.find((candidate) => candidate.reference === reference),
				...(expired.changed ? { next: serializeState(expired.projections) } : {}),
			};
		});
		if (record === undefined || record.status !== "active") return undefined;
		const credential = readStoredCredentialRevision(
			record.credentialName,
			record.credentialRevisionId,
			nowMs,
			this.authPath,
		);
		if (credential?.type !== "api_key" || credential.key === undefined) return credential;
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	renew(request: CredentialProjectionRenewRequest): void {
		validateLeaseIdentity(request.leaseId, request.grantId, request.bindingId);
		if (!isPositiveTtl(request.requestedTtlMs)) {
			throw new CredentialVaultError("credential_projection_invalid");
		}
		const renewedAtMs = request.renewedAtMs ?? this.now();
		if (!isEpochMs(renewedAtMs)) throw new CredentialVaultError("credential_projection_invalid");
		const outcome = this.storage.withLock((content) => {
			const state = parseCredentialVaultState(content ?? serializeState([]));
			const expired = expireProjectionRecords(state.projections, renewedAtMs);
			const matching = expired.projections.filter((record) => record.leaseId === request.leaseId);
			if (matching.length === 0) throw new CredentialVaultError("credential_projection_not_found");
			for (const record of matching) {
				if (record.grantId !== request.grantId || record.bindingId !== request.bindingId) {
					throw new CredentialVaultError("credential_projection_conflict");
				}
				if (record.status === "revoked") return { result: "credential_projection_revoked" as const };
				if (record.status === "expired") {
					return {
						result: "credential_projection_expired" as const,
						...(expired.changed ? { next: serializeState(expired.projections) } : {}),
					};
				}
				if (
					readStoredCredentialRevision(
						record.credentialName,
						record.credentialRevisionId,
						renewedAtMs,
						this.authPath,
					) === undefined
				) {
					throw new CredentialVaultError("credential_revision_unavailable");
				}
			}
			const expiresAt = new Date(renewedAtMs + request.requestedTtlMs).toISOString();
			const projections = expired.projections.map((record) =>
				record.leaseId === request.leaseId ? { ...record, expiresAt } : record,
			);
			return { result: undefined, next: serializeState(projections) };
		});
		if (outcome !== undefined) throw new CredentialVaultError(outcome);
	}

	revoke(request: CredentialProjectionRevokeRequest): void {
		validateLeaseIdentity(request.leaseId, request.grantId, request.bindingId);
		const revokedAtMs = request.revokedAtMs ?? this.now();
		if (!isEpochMs(revokedAtMs)) throw new CredentialVaultError("credential_projection_invalid");
		this.storage.withLock((content) => {
			const state = parseCredentialVaultState(content ?? serializeState([]));
			const matching = state.projections.filter((record) => record.leaseId === request.leaseId);
			if (matching.length === 0) throw new CredentialVaultError("credential_projection_not_found");
			if (matching.some((record) => record.grantId !== request.grantId || record.bindingId !== request.bindingId)) {
				throw new CredentialVaultError("credential_projection_conflict");
			}
			const revokedAt = new Date(revokedAtMs).toISOString();
			const projections = state.projections.map((record): CredentialProjectionRecord =>
				record.leaseId !== request.leaseId || record.status === "revoked"
					? record
					: { ...record, status: "revoked", revokedAt },
			);
			return { result: undefined, next: serializeState(projections) };
		});
	}

	rotateCredential(
		providerId: string,
		nextCredential: Credential,
		options: RotateStoredCredentialOptions,
	): AuthCredentialRotationSnapshot {
		return rotateStoredCredential(providerId, nextCredential, options, this.authPath);
	}

	revokeCredentialRevision(providerId: string, revisionId: string): boolean {
		return revokeStoredCredentialRevision(providerId, revisionId, this.authPath);
	}
}
