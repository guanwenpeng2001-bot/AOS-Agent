import { describe, expect, it } from "vitest";

import {
	SandboxCapabilityError,
	SandboxError,
	SandboxHandleDisposedError,
} from "../src/index.ts";
import type {
	PolicyDecisionSummary,
	SandboxCapabilities,
	SandboxDirectoryEntry,
	SandboxHandle,
	SandboxLifecycleStatus,
	SandboxMCPTransportRequest,
	SandboxOperationRequest,
	SandboxOperationResult,
	SandboxProvider,
} from "../src/index.ts";
import * as publicApi from "../src/index.ts";

describe("public policy and sandbox API", () => {
	it("exports the SDK sandbox contract without the session implementation", () => {
		const capabilities: SandboxCapabilities = {
			filesystem: true,
			process: true,
			network: true,
			credentialIsolation: true,
		};
		const operation: SandboxOperationRequest = {
			bindingId: "binding-1",
			resource: "filesystem.read",
			operation: "file.read",
			path: "README.md",
		};
		const entry: SandboxDirectoryEntry = { name: "README.md", isDirectory: false };
		const result: SandboxOperationResult = { content: "ok", entries: [entry] };
		const handle: SandboxHandle = {
			id: "handle-1",
			capabilities,
			execute: async () => result,
		};
		const provider: SandboxProvider = {
			id: "provider-1",
			capabilities,
			prepare: async () => handle,
			dispose: async () => undefined,
		};
		const transportRequest: SandboxMCPTransportRequest = {
			bindingId: "binding-1",
			serverId: "server-1",
			config: { id: "server-1", transport: "stdio", command: "mcp-server" },
			environment: {},
			headers: {},
		};
		const lifecycleStatus: SandboxLifecycleStatus = "ready";
		const summary: PolicyDecisionSummary = {
			bindingId: "binding-1",
			profileId: "legacy",
			profileRevision: "1",
			projectTrust: "trusted",
			enforcement: "legacy",
			sandboxStatus: "not_required",
			sandboxCapabilities: capabilities,
			resource: "filesystem.read",
			action: "allow",
			outcome: "allow",
			timestamp: "2026-08-13T00:00:00.000Z",
		};

		expect(provider.id).toBe("provider-1");
		expect(operation.resource).toBe("filesystem.read");
		expect(result.entries).toEqual([entry]);
		expect(transportRequest.serverId).toBe("server-1");
		expect(lifecycleStatus).toBe("ready");
		expect(summary.outcome).toBe("allow");
		expect("SandboxSession" in publicApi).toBe(false);
	});

	it("exports stable sandbox error classes", () => {
		expect(new SandboxError("sandbox_unavailable").code).toBe("sandbox_unavailable");
		expect(new SandboxCapabilityError("provider-1", "filesystem").code).toBe(
			"sandbox_capability_insufficient",
		);
		expect(new SandboxHandleDisposedError("handle-1").code).toBe("sandbox_unavailable");
	});
});
