import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/policy/auth-storage.ts";
import { LocalCredentialVault } from "../../src/core/policy/credential-vault.ts";
import { ExternalConnectorModelGateway } from "../../src/core/connector/model-gateway.ts";
import { ModelRuntime } from "../../src/core/runtime/model-runtime.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("External Connector model gateway", () => {
	it("opens only a live reference-backed loopback capability and revokes it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "aos-model-gateway-"));
		directories.push(directory);
		const authPath = join(directory, "auth.json");
		const credentials = AuthStorage.create(authPath);
		await credentials.modify("openai", async () => ({ type: "api_key", key: "model-gateway-secret-canary" }));
		const vault = new LocalCredentialVault({ authPath });
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const gateway = new ExternalConnectorModelGateway({ targetId: "codex-gateway", runtime, vault });
		const lease = {
			schemaVersion: 1 as const,
			leaseId: "lease-model-gateway",
			grantId: "grant-model-gateway",
			bindingId: "binding-model-gateway",
			scopeDigest: `sha256:${"b".repeat(64)}`,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			clientRequestId: "request-model-gateway",
		};
		const references = vault.issue({
			leaseId: lease.leaseId,
			grantId: lease.grantId,
			bindingId: lease.bindingId,
			credentialNames: ["openai"],
			requestedTtlMs: 60_000,
		});
		gateway.project({
			schemaVersion: 1,
			leaseId: lease.leaseId,
			grantId: lease.grantId,
			bindingId: lease.bindingId,
			targetId: "codex-gateway",
			references,
			projectedAt: new Date().toISOString(),
		});
		const projection = {
			schemaVersion: 1 as const,
			provider: "openai",
			model: "gpt-test",
			effort: "high",
			serviceTier: "priority",
			fallbackDecision: { kind: "primary" as const, reason: "fallback_not_used" as const },
			bindingDigest: { algorithm: "sha256" as const, value: "a".repeat(64) },
		};
		const capability = await gateway.open(lease, projection);
		expect(capability).toMatchObject({
			endpoint: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/),
			leaseId: lease.leaseId,
			modelBindingDigest: projection.bindingDigest.value,
		});
		expect(JSON.stringify(capability)).not.toContain("model-gateway-secret-canary");
		if (capability === undefined) throw new Error("Model gateway capability was not created");
		expect(gateway.close(capability)).toBe(true);
		expect(gateway.close(capability)).toBe(false);
		gateway.revoke({
			schemaVersion: 1,
			leaseId: lease.leaseId,
			grantId: lease.grantId,
			bindingId: lease.bindingId,
			targetId: "codex-gateway",
			requestedAt: new Date().toISOString(),
		});
		expect(await gateway.open(lease, projection)).toBeUndefined();
		expect(await gateway.open({ ...lease, expiresAt: new Date(Date.now() - 1).toISOString() }, projection)).toBeUndefined();
		await gateway.dispose();
	});
});
