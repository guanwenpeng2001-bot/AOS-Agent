import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/policy/auth-storage.ts";
import { LocalCredentialVault } from "../../src/core/policy/credential-vault.ts";
import { TaskCredentialError } from "../../src/core/policy/task-credential-lease.ts";
import {
	createTaskCredentialLocalVaultProvider,
	type TaskCredentialReferenceProjectRequest,
	type TaskCredentialReferenceTarget,
} from "../../src/core/policy/task-credential-provider.ts";

const START_MS = Date.parse("2026-09-02T00:00:00.000Z");

describe("LocalCredentialVault", () => {
	const tempDir = join(tmpdir(), `aos-credential-vault-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const authPath = join(tempDir, "auth.json");
	const statePath = join(tempDir, "credential-vault.json");
	let nowMs = START_MS;
	let idSequence = 0;

	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(authPath, JSON.stringify({ registry: { type: "api_key", key: "long-lived-old" } }));
		nowMs = START_MS;
		idSequence = 0;
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function createVault(): LocalCredentialVault {
		return new LocalCredentialVault({
			authPath,
			statePath,
			now: () => nowMs,
			createId: () => `id${++idSequence}`,
		});
	}

	function issue(vault: LocalCredentialVault, leaseId: string = "lease_001"): Readonly<Record<string, string>> {
		return vault.issue({
			leaseId,
			grantId: `grant_${leaseId}`,
			bindingId: `binding_${leaseId}`,
			credentialNames: ["registry"],
			requestedTtlMs: 30_000,
		});
	}

	it("expires projections without persisting plaintext or allowing renewal after expiry", () => {
		const vault = createVault();
		const references = issue(vault);
		const reference = references.registry;
		expect(reference).toMatch(/^credential_projection_/);
		expect(vault.resolve(reference)).toEqual({ type: "api_key", key: "long-lived-old" });

		const persisted = readFileSync(statePath, "utf8");
		expect(persisted).toContain(reference);
		expect(persisted).not.toContain("long-lived-old");

		nowMs += 30_000;
		expect(vault.resolve(reference)).toBeUndefined();
		expect(() =>
			vault.renew({
				leaseId: "lease_001",
				grantId: "grant_lease_001",
				bindingId: "binding_lease_001",
				requestedTtlMs: 30_000,
			}),
		).toThrow("credential_projection_expired");
		nowMs -= 10_000;
		expect(vault.resolve(reference)).toBeUndefined();
	});

	it("keeps old and new auth revisions live during rotation and revokes the old revision immediately", async () => {
		const vault = createVault();
		const oldReference = issue(vault).registry;
		const rotation = vault.rotateCredential(
			"registry",
			{ type: "api_key", key: "long-lived-new" },
			{
				transitionTtlMs: 60_000,
				nowMs,
				createRevisionId: () => `rotation${++idSequence}`,
			},
		);
		const newReference = issue(vault, "lease_002").registry;

		expect(vault.resolve(oldReference)).toEqual({ type: "api_key", key: "long-lived-old" });
		expect(vault.resolve(newReference)).toEqual({ type: "api_key", key: "long-lived-new" });
		await expect(AuthStorage.create(authPath).read("registry")).resolves.toEqual({
			type: "api_key",
			key: "long-lived-new",
		});
		expect(rotation.previousRevisionId).toBeDefined();
		expect(vault.revokeCredentialRevision("registry", rotation.previousRevisionId as string)).toBe(true);
		expect(vault.resolve(oldReference)).toBeUndefined();
		expect(vault.resolve(newReference)).toEqual({ type: "api_key", key: "long-lived-new" });
	});

	it("preserves live projection and rotation state across vault restart", () => {
		const first = createVault();
		const oldReference = issue(first).registry;
		first.rotateCredential(
			"registry",
			{ type: "api_key", key: "long-lived-new" },
			{
				transitionTtlMs: 60_000,
				nowMs,
				createRevisionId: () => `rotation${++idSequence}`,
			},
		);

		const restarted = createVault();
		expect(restarted.resolve(oldReference)).toEqual({ type: "api_key", key: "long-lived-old" });
		expect(restarted.getLeaseReferences("lease_001", "grant_lease_001", "binding_lease_001")).toEqual({
			registry: oldReference,
		});
		nowMs += 60_000;
		expect(restarted.resolve(oldReference)).toBeUndefined();
	});

	it("projects only references through Task Credential target lifecycle and revokes them immediately", () => {
		const vault = createVault();
		let projected: TaskCredentialReferenceProjectRequest | undefined;
		const target: TaskCredentialReferenceTarget = {
			getCapabilities: (request) => ({
				schemaVersion: 1,
				targetId: request.targetId,
				targetKind: request.targetKind,
				bindingId: request.bindingId,
				canReceiveShortLivedCredential: true,
				canRenewCredential: true,
				canRevokeCredential: true,
				supportsPerBindingIsolation: true,
				supportsDeliveryReceipt: true,
			}),
			project: (request) => {
				projected = request;
				return {
					schemaVersion: 1,
					leaseId: request.leaseId,
					grantId: request.grantId,
					bindingId: request.bindingId,
					targetId: request.targetId,
					status: "succeeded",
					recordedAt: new Date(nowMs).toISOString(),
				};
			},
			renew: (request) => ({
				schemaVersion: 1,
				leaseId: request.leaseId,
				grantId: request.grantId,
				bindingId: request.bindingId,
				status: "renewed",
				recordedAt: new Date(nowMs).toISOString(),
			}),
			revoke: (request) => ({
				schemaVersion: 1,
				leaseId: request.leaseId,
				grantId: request.grantId,
				bindingId: request.bindingId,
				status: "revoked",
				recordedAt: new Date(nowMs).toISOString(),
			}),
		};
		const provider = createTaskCredentialLocalVaultProvider({
			vault,
			target,
			now: () => new Date(nowMs).toISOString(),
		});
		provider.issuer.issue({
			schemaVersion: 1,
			leaseId: "lease_001",
			grantId: "grant_001",
			binding: {
				schemaVersion: 1,
				bindingId: "binding_001",
				sessionId: "session_001",
				taskId: "task_001",
				graphRevision: 1,
				nodeId: "node_001",
				runId: "run_001",
				capabilityBindingId: "capability_001",
				policyBindingId: "policy_001",
				createdAt: new Date(nowMs).toISOString(),
				bindingRevision: 1,
			},
			scopes: [
				{
					credentialName: "registry",
					purpose: "dependency_read",
					operations: ["read"],
					targetKinds: ["isolated_sandbox"],
				},
			],
			requestedTtlMs: 30_000,
			requestedAt: new Date(nowMs).toISOString(),
		});
		provider.target.project({
			schemaVersion: 1,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			targetId: "target_001",
			requestedAt: new Date(nowMs).toISOString(),
		});

		const reference = projected?.references.registry;
		expect(reference).toMatch(/^credential_projection_/);
		expect(JSON.stringify(projected)).not.toContain("long-lived-old");
		expect(vault.resolve(reference as string)).toEqual({ type: "api_key", key: "long-lived-old" });
		provider.issuer.revoke({
			schemaVersion: 1,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			requestedAt: new Date(nowMs).toISOString(),
		});
		expect(vault.resolve(reference as string)).toBeUndefined();
		expect(() =>
			provider.issuer.renew({
				schemaVersion: 1,
				leaseId: "lease_001",
				grantId: "grant_001",
				bindingId: "binding_001",
				requestedTtlMs: 30_000,
				requestedAt: new Date(nowMs).toISOString(),
			}),
		).toThrow(TaskCredentialError);
	});
});
