import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExecutionPolicyProfile } from "../../src/core/policy/execution.ts";
import { resolveExecutionPolicyProfile } from "../../src/core/policy/execution.ts";
import { createBuiltinToolPolicy, createSandboxHandleOperationProvider } from "../../src/core/policy/sandbox-host.ts";
import type { SandboxHandle, SandboxOperationRequest, SandboxOperationResult } from "../../src/core/policy/sandbox.ts";
import { runOperationWorkerProcess } from "../../src/worker-entry.ts";

const execFileAsync = promisify(execFile);
const providerId = "sandbox-worker";
const root = process.env.AOS_WORKER_SANDBOX_ROOT;
const runId = process.env.AOS_WORKER_RUN_ID;
if (root === undefined || runId === undefined || !isAbsolute(root)) {
	throw new Error("Trusted real-sandbox Worker composition is incomplete");
}
const resolvedRoot = await realpath(root);

const profile: ExecutionPolicyProfile = {
	id: "real-worker-sandbox",
	enforcement: "sandbox",
	sandboxProvider: providerId,
	defaultAction: "allow",
	workspace: { read: ["workspace"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
	process: { action: "allow", inheritEnvironment: false, allowEnvironment: [] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "allow" },
};
const resolved = resolveExecutionPolicyProfile({
	profiles: { [profile.id]: profile },
	defaultProfile: profile.id,
	workspaceIdentity: "real-worker-workspace",
	runId,
	createdAt: "2026-08-21T00:00:00.000Z",
	sandbox: {
		providerConfigured: true,
		providerId,
		providerStatus: "ready",
		providerCapabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
	},
});
if (!resolved.ok) throw resolved.error;

function sandboxPath(requestedPath: string | undefined): string {
	if (requestedPath === undefined || requestedPath.length === 0) throw new Error("Sandbox path is required");
	const target = resolve(resolvedRoot, requestedPath);
	const relation = relative(resolvedRoot, target);
	if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("Sandbox path escaped the workspace");
	return target;
}

const handle: SandboxHandle = {
	id: "real-worker-sandbox-handle",
	bindingId: resolved.binding.id,
	providerId,
	status: "ready",
	capabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
	async execute(request: SandboxOperationRequest): Promise<SandboxOperationResult> {
		if (request.resource === "filesystem.read" && request.operation === "file.read") {
			return { content: await readFile(sandboxPath(request.path)) };
		}
		if (request.resource === "filesystem.write" && request.operation === "file.write") {
			await writeFile(sandboxPath(request.path), request.content ?? "", "utf8");
			return { content: request.content ?? "" };
		}
		if (request.resource === "filesystem.read" && request.operation === "directory.list") {
			return { entries: await readdir(sandboxPath(request.path)) };
		}
		if (request.resource === "process.spawn" && request.command === process.execPath) {
			const result = await execFileAsync(request.command, [...(request.args ?? [])], {
				cwd: sandboxPath(request.cwd ?? "."),
				env: {},
				timeout: request.timeoutMs,
				signal: request.signal,
			});
			return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
		}
		throw new Error("Sandbox operation is unsupported");
	},
};

function resultBytes(result: SandboxOperationResult): Buffer {
	if (result.content !== undefined) return Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content);
	if (result.stdout !== undefined) return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
	if (result.entries !== undefined) return Buffer.from(JSON.stringify(result.entries));
	return Buffer.alloc(0);
}

const policy = createBuiltinToolPolicy({
	profile,
	binding: resolved.binding,
	roots: { workspace: resolvedRoot },
	sandbox: handle,
	source: "builtin",
});
const operationProvider = createSandboxHandleOperationProvider({
	providerId,
	policy,
	correlation: { sessionId: "real-worker-session", laneId: "main" },
	capabilities: [
		{ schemaVersion: 1, id: "filesystem.read", version: 1 },
		{ schemaVersion: 1, id: "filesystem.write", version: 1 },
		{ schemaVersion: 1, id: "process.spawn", version: 1 },
	],
	mapResult: (result, operation) => {
		const bytes = resultBytes(result);
		const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
		return [{
			schemaVersion: 1,
			artifactId: `artifact:${operation.resource}:${digest.slice(-16)}`,
			mediaType: "application/octet-stream",
			digest,
			sizeBytes: bytes.byteLength,
			producer: providerId,
		}];
	},
});

await runOperationWorkerProcess({ provider: operationProvider });
