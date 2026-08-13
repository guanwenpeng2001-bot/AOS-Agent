import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ExecutionPolicyProfile,
	resolveExecutionPolicyProfile,
} from "../src/core/execution-policy.ts";
import { createBuiltinToolPolicy } from "../src/core/sandbox-host.ts";
import {
	type SandboxHandle,
	SandboxHandleDisposedError,
	type SandboxOperationRequest,
	type SandboxOperationResult,
	SandboxSession,
	type SandboxProvider,
} from "../src/core/sandbox.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createFakeSandboxProvider } from "./fixtures/fake-sandbox-provider.ts";
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/core/tools/index.ts";

const hostProfile: ExecutionPolicyProfile = {
	id: "host-safe",
	enforcement: "host",
	defaultAction: "allow",
	workspace: { read: ["workspace", "declared-read-only"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
	process: {
		action: "allow",
		inheritEnvironment: false,
		allowEnvironment: ["PATH"],
		cwdScopes: ["workspace"],
		timeoutMs: 1000,
	},
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "allow" },
};

const sandboxProfile: ExecutionPolicyProfile = {
	...hostProfile,
	id: "sandbox-safe",
	enforcement: "sandbox",
	sandboxProvider: "fake-sandbox",
};

function ripgrepMatch(filePath: string, lineNumber: number, text: string): string {
	return JSON.stringify({
		type: "match",
		data: {
			path: { text: filePath },
			line_number: lineNumber,
			lines: { text },
		},
	});
}

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "aos-sandbox-tools-"));
}

function binding(profile: ExecutionPolicyProfile, workspace: string, sandboxReady = false) {
	const result = resolveExecutionPolicyProfile({
		profiles: { [profile.id]: profile },
		defaultProfile: profile.id,
		workspaceIdentity: "workspace-test",
		runId: `run-${profile.id}`,
		createdAt: "2026-08-13T00:00:00.000Z",
		sandbox: sandboxReady
			? {
				providerConfigured: true,
				providerStatus: "ready",
				providerCapabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
			}
			: undefined,
	});
	if (!result.ok) throw result.error;
	return result.binding;
}

describe("sandbox host policy for built-in tools", () => {
	it("blocks path traversal before read operations run", async () => {
		const workspace = await tempRoot();
		const outside = await tempRoot();
		try {
			const policy = createBuiltinToolPolicy({
				profile: hostProfile,
				binding: binding(hostProfile, workspace),
				roots: { workspace },
			});
			let readStarted = false;
			const read = createReadTool(workspace, {
				policy,
				operations: {
					access: async () => {},
					readFile: async () => {
						readStarted = true;
						return Buffer.from("secret");
					},
				},
			});

			await expect(read.execute("read-traversal", { path: join(outside, "secret.txt") })).rejects.toMatchObject({
				code: "workspace_boundary_violation",
			});
			expect(readStarted).toBe(false);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("blocks new-file parents outside the workspace before mkdir or write", async () => {
		const workspace = await tempRoot();
		const outside = await tempRoot();
		try {
			const policy = createBuiltinToolPolicy({
				profile: hostProfile,
				binding: binding(hostProfile, workspace),
				roots: { workspace },
			});
			const calls: string[] = [];
			const write = createWriteTool(workspace, {
				policy,
				operations: {
					mkdir: async () => {
						calls.push("mkdir");
					},
					writeFile: async () => {
						calls.push("write");
					},
				},
			});

			await expect(write.execute("write-outside", { path: join(outside, "new.txt"), content: "x" })).rejects.toMatchObject({
				code: "workspace_boundary_violation",
			});
			expect(calls).toEqual([]);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("distinguishes read-only roots from writable workspace roots", async () => {
		const workspace = await tempRoot();
		const readOnly = await tempRoot();
		try {
			const file = join(readOnly, "note.txt");
			writeFileSync(file, "readable");
			const policy = createBuiltinToolPolicy({
				profile: hostProfile,
				binding: binding(hostProfile, workspace),
				roots: { workspace, declaredReadOnly: [readOnly] },
			});
			const read = createReadTool(workspace, { policy });
			const write = createWriteTool(workspace, { policy });

			const result = await read.execute("read-ro", { path: file });
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toBe("readable");
			await expect(write.execute("write-ro", { path: file, content: "changed" })).rejects.toMatchObject({
				code: "workspace_boundary_violation",
			});
			expect(await readFile(file, "utf-8")).toBe("readable");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
			rmSync(readOnly, { recursive: true, force: true });
		}
	});

	it("rejects symlink escapes instead of trusting string paths", async () => {
		const workspace = await tempRoot();
		const outside = await tempRoot();
		try {
			const secret = join(outside, "secret.txt");
			const link = join(workspace, "link.txt");
			writeFileSync(secret, "secret");
			try {
				symlinkSync(secret, link);
			} catch {
				return;
			}
			const policy = createBuiltinToolPolicy({
				profile: hostProfile,
				binding: binding(hostProfile, workspace),
				roots: { workspace },
			});
			const read = createReadTool(workspace, { policy });

			await expect(read.execute("read-link", { path: link })).rejects.toMatchObject({
				code: "workspace_boundary_violation",
			});
		} finally {
			rmSync(workspace, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("normalizes same-root case on case-insensitive platforms", async () => {
		if (process.platform !== "win32") return;
		const workspace = await tempRoot();
		try {
			const file = join(workspace, "case.txt");
			writeFileSync(file, "ok");
			const policy = createBuiltinToolPolicy({
				profile: hostProfile,
				binding: binding(hostProfile, workspace),
				roots: { workspace: workspace.toUpperCase() },
			});
			const read = createReadTool(workspace, { policy });

			const result = await read.execute("read-case", { path: file.toLowerCase() });
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toBe("ok");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("blocks denied processes, invalid cwd, and timeout violations before exec", async () => {
		const workspace = await tempRoot();
		const outside = await tempRoot();
		try {
			const deniedProfile: ExecutionPolicyProfile = { ...hostProfile, process: { ...hostProfile.process, action: "deny" } };
			const policy = createBuiltinToolPolicy({
				profile: deniedProfile,
				binding: binding(deniedProfile, workspace),
				roots: { workspace },
			});
			let execStarted = false;
			const operations: BashOperations = {
				exec: async () => {
					execStarted = true;
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(workspace, { policy, operations, exposeSessionEnvironment: false });

			await expect(bash.execute("process-deny", { command: "echo no" })).rejects.toMatchObject({ code: "policy_denied" });
			expect(execStarted).toBe(false);
			await expect(createBashTool(outside, { policy, operations }).execute("bad-cwd", { command: "echo no" })).rejects.toMatchObject({
				code: "workspace_boundary_violation",
			});
			await expect(bash.execute("bad-timeout", { command: "echo no", timeout: 2 })).rejects.toMatchObject({
				code: "policy_denied",
			});
		} finally {
			rmSync(workspace, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("uses the process environment allowlist without exposeSessionEnvironment bypass", async () => {
		const workspace = await tempRoot();
		try {
			const policy = createBuiltinToolPolicy({
				profile: hostProfile,
				binding: binding(hostProfile, workspace),
				roots: { workspace },
			});
			let capturedEnv: NodeJS.ProcessEnv | undefined;
			const bash = createBashToolDefinition(workspace, {
				policy,
				exposeSessionEnvironment: true,
				operations: {
					exec: async (_command, _cwd, options) => {
						capturedEnv = options.env;
						return { exitCode: 0 };
					},
				},
			});
			const ctx = {
				model: { provider: "openai", id: "model" },
				thinkingLevel: "high",
				sessionManager: {
					getSessionId: () => "session-secret",
					getSessionFile: () => join(workspace, "session.jsonl"),
				},
			} as unknown as ExtensionContext;
			await bash.execute("env-filter", { command: "env" }, undefined, undefined, ctx);
			expect(capturedEnv?.PATH).toBeDefined();
			expect(capturedEnv?.AOS_AGENT_SESSION_ID).toBeUndefined();
			expect(capturedEnv?.AOS_AGENT_MODEL).toBeUndefined();
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("does not fall back to host execution for strict sandbox process profiles", async () => {
		const workspace = await tempRoot();
		try {
			const policy = createBuiltinToolPolicy({
				profile: sandboxProfile,
				binding: binding(sandboxProfile, workspace, true),
				roots: { workspace },
			});
			let execStarted = false;
			const bash = createBashTool(workspace, {
				policy,
				operations: {
					exec: async () => {
						execStarted = true;
						return { exitCode: 0 };
					},
				},
			});

			await expect(bash.execute("strict-no-handle", { command: "echo no" })).rejects.toMatchObject({
				code: "sandbox_required",
			});
			expect(execStarted).toBe(false);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("routes strict bash execution through a real sandbox handle", async () => {
		const workspace = await tempRoot();
		try {
			const requests: SandboxOperationRequest[] = [];
			const sandbox: SandboxHandle = {
				id: "handle-1",
				capabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
				execute: async (request): Promise<SandboxOperationResult> => {
					requests.push(request);
					request.onData?.(Buffer.from("sandboxed\n"));
					return { exitCode: 0 };
				},
			};
			const policy = createBuiltinToolPolicy({
				profile: sandboxProfile,
				binding: binding(sandboxProfile, workspace, true),
				roots: { workspace },
				sandbox,
			});
			let hostStarted = false;
			const bash = createBashTool(workspace, {
				policy,
				operations: {
					exec: async () => {
						hostStarted = true;
						return { exitCode: 0 };
					},
				},
			});

			const result = await bash.execute("strict-handle", { command: "echo ok" });
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toBe("sandboxed\n");
			expect(hostStarted).toBe(false);
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({ bindingId: policy.binding.id, resource: "process.spawn" });
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("rejects sandbox handles that belong to another binding", async () => {
		const workspace = await tempRoot();
		try {
			const policyBinding = binding(sandboxProfile, workspace, true);
			const staleHandle: SandboxHandle = {
				id: "stale-handle",
				bindingId: "policy-binding:old-run",
				providerId: "fake-sandbox",
				status: "ready",
				capabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
				execute: async () => ({ exitCode: 0 }),
			};
			const provider: SandboxProvider = {
				id: "fake-sandbox",
				capabilities: staleHandle.capabilities,
				prepare: async () => staleHandle,
				dispose: async () => {},
			};
			const session = new SandboxSession(provider, policyBinding);
			await expect(session.prepare()).rejects.toMatchObject({ code: "sandbox_start_failed" });
			expect(session.currentStatus).toBe("failed");

			let hostStarted = false;
			const policy = createBuiltinToolPolicy({
				profile: sandboxProfile,
				binding: policyBinding,
				roots: { workspace },
				sandbox: staleHandle,
			});
			const bash = createBashTool(workspace, {
				policy,
				operations: {
					exec: async () => {
						hostStarted = true;
						return { exitCode: 0 };
					},
				},
			});
			await expect(bash.execute("stale-handle", { command: "echo no" })).rejects.toMatchObject({
				code: "sandbox_unavailable",
			});
			expect(hostStarted).toBe(false);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("routes strict filesystem tools through a sandbox handle without host operations", async () => {
		const workspace = await tempRoot();
		try {
			const editPath = join(workspace, "edit.txt");
			const writePath = join(workspace, "write.txt");
			writeFileSync(editPath, "host stale");
			const requests: SandboxOperationRequest[] = [];
			const hostCalls: string[] = [];
			const sandbox: SandboxHandle = {
				id: "handle-filesystem",
				capabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
				execute: async (request): Promise<SandboxOperationResult> => {
					requests.push(request);
					if (request.operation === "file.read") {
						return { content: request.path === editPath ? "old\n" : "sandbox read\n" };
					}
					if (request.operation === "file.write") {
						writeFileSync(request.path ?? "", request.content ?? "", "utf-8");
						return {};
					}
					if (request.operation === "directory.list") {
						return { isDirectory: true, entries: [{ name: "dir", isDirectory: true }, { name: "file.txt" }] };
					}
					if (request.operation === "filesystem.find") {
						return { entries: [join(request.path ?? "", "src", "a.ts"), "relative/b.ts"] };
					}
					if (request.operation === "filesystem.grep") {
						return { content: "src/a.ts:1: needle\n" };
					}
					throw new Error(`Unexpected sandbox operation: ${request.operation}`);
				},
			};
			const policy = createBuiltinToolPolicy({
				profile: sandboxProfile,
				binding: binding(sandboxProfile, workspace, true),
				roots: { workspace },
				sandbox,
			});

			const read = createReadTool(workspace, {
				policy,
				operations: {
					access: async () => {
						hostCalls.push("read.access");
					},
					readFile: async () => {
						hostCalls.push("read.readFile");
						return Buffer.from("host");
					},
				},
			});
			const write = createWriteTool(workspace, {
				policy,
				operations: {
					mkdir: async () => {
						hostCalls.push("write.mkdir");
					},
					writeFile: async () => {
						hostCalls.push("write.writeFile");
					},
				},
			});
			const edit = createEditTool(workspace, {
				policy,
				operations: {
					access: async () => {
						hostCalls.push("edit.access");
					},
					readFile: async () => {
						hostCalls.push("edit.readFile");
						return Buffer.from("host stale");
					},
					writeFile: async () => {
						hostCalls.push("edit.writeFile");
					},
				},
			});
			const ls = createLsTool(workspace, {
				policy,
				operations: {
					exists: () => {
						hostCalls.push("ls.exists");
						return false;
					},
					stat: () => {
						hostCalls.push("ls.stat");
						return { isDirectory: () => false };
					},
					readdir: () => {
						hostCalls.push("ls.readdir");
						return [];
					},
				},
			});
			const find = createFindTool(workspace, {
				policy,
				operations: {
					exists: () => {
						hostCalls.push("find.exists");
						return false;
					},
					glob: () => {
						hostCalls.push("find.glob");
						return [];
					},
				},
			});
			const grep = createGrepTool(workspace, {
				policy,
				operations: {
					isDirectory: () => {
						hostCalls.push("grep.isDirectory");
						return false;
					},
					readFile: () => {
						hostCalls.push("grep.readFile");
						return "host";
					},
				},
			});

			const readResult = await read.execute("strict-read", { path: "read.txt" });
			await write.execute("strict-write", { path: "write.txt", content: "sandbox write\n" });
			await edit.execute("strict-edit", { path: "edit.txt", edits: [{ oldText: "old", newText: "new" }] });
			const lsResult = await ls.execute("strict-ls", { path: "." });
			const findResult = await find.execute("strict-find", { pattern: "**/*.ts", path: "." });
			const grepResult = await grep.execute("strict-grep", { pattern: "needle", path: "." });

			expect(readResult.content[0]?.type === "text" ? readResult.content[0].text : "").toBe("sandbox read\n");
			expect(readFileSync(writePath, "utf-8")).toBe("sandbox write\n");
			expect(readFileSync(editPath, "utf-8")).toBe("new\n");
			expect(lsResult.content[0]?.type === "text" ? lsResult.content[0].text : "").toBe("dir/\nfile.txt");
			expect(findResult.content[0]?.type === "text" ? findResult.content[0].text : "").toContain("src/a.ts");
			expect(grepResult.content[0]?.type === "text" ? grepResult.content[0].text : "").toBe("src/a.ts:1: needle\n");
			expect(hostCalls).toEqual([]);
			expect(requests.map((request) => request.operation)).toEqual([
				"file.read",
				"file.write",
				"file.read",
				"file.write",
				"directory.list",
				"filesystem.find",
				"filesystem.grep",
			]);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("routes strict find and grep through fake-sandbox after process authorization", async () => {
		const workspace = await tempRoot();
		const previousSecret = process.env.SECRET_TOKEN;
		const searchProfile: ExecutionPolicyProfile = {
			...sandboxProfile,
			process: { ...sandboxProfile.process, allowEnvironment: ["PATH", "Path"] },
		};
		const fake = createFakeSandboxProvider({
			onExecute: async (request): Promise<SandboxOperationResult | undefined> => {
				if (request.operation === "filesystem.find") {
					return {
						content: [join(request.path ?? "", "src", "a.ts"), join(request.path ?? "", "src", "b.ts")].join("\n"),
					};
				}
				if (request.operation === "filesystem.grep") {
					return {
						content: [
							ripgrepMatch(join(request.path ?? "", "src", "a.ts"), 2, "const value = 'needle';\n"),
							ripgrepMatch(join(request.path ?? "", "src", "b.ts"), 4, "const other = 'needle';\n"),
						].join("\n"),
					};
				}
				throw new Error(`Unexpected sandbox operation: ${request.operation}`);
			},
		});
		let sandbox: SandboxHandle | undefined;
		try {
			process.env.SECRET_TOKEN = "do-not-forward";
			const policyBinding = binding(searchProfile, workspace, true);
			sandbox = await fake.provider.prepare(policyBinding);
			const decisionResources: string[] = [];
			const policy = createBuiltinToolPolicy({
				profile: searchProfile,
				binding: policyBinding,
				roots: { workspace },
				sandbox,
				hooks: {
					onDecision: (decision) => {
						decisionResources.push(decision.resource);
					},
				},
			});
			const hostCalls: string[] = [];
			const find = createFindTool(workspace, {
				policy,
				operations: {
					exists: () => {
						hostCalls.push("find.exists");
						return false;
					},
					glob: () => {
						hostCalls.push("find.glob");
						return [];
					},
				},
			});
			const grep = createGrepTool(workspace, {
				policy,
				operations: {
					isDirectory: () => {
						hostCalls.push("grep.isDirectory");
						return false;
					},
					readFile: () => {
						hostCalls.push("grep.readFile");
						return "host";
					},
				},
			});

			const findResult = await find.execute("strict-find-process", { pattern: "**/*.ts", path: ".", limit: 1 });
			const grepResult = await grep.execute("strict-grep-process", { pattern: "needle", path: ".", limit: 1 });

			const findText = findResult.content[0]?.type === "text" ? findResult.content[0].text : "";
			const grepText = grepResult.content[0]?.type === "text" ? grepResult.content[0].text : "";
			expect(findText).toContain("src/a.ts");
			expect(findText).toContain("1 results limit reached");
			expect(grepText).toContain("src/a.ts:2: const value = 'needle';");
			expect(grepText).toContain("1 matches limit reached");
			expect(decisionResources).toEqual([
				"filesystem.find",
				"process.spawn",
				"filesystem.grep",
				"process.spawn",
			]);
			expect(hostCalls).toEqual([]);
			expect(fake.state.invocations.map((invocation) => invocation.operation)).toEqual([
				"filesystem.find",
				"filesystem.grep",
			]);
			expect(fake.state.invocations.map((invocation) => invocation.resource)).toEqual([
				"filesystem.find",
				"filesystem.grep",
			]);
			for (const invocation of fake.state.invocations) {
				expect(invocation.bindingId).toBe(policy.binding.id);
				expect(invocation.cwd).toBe(workspace);
				expect(invocation.args).toContain("--hidden");
				expect(invocation.env.SECRET_TOKEN).toBeUndefined();
				expect(Object.keys(invocation.env).some((name) => name.toLowerCase() === "path")).toBe(true);
			}
		} finally {
			if (sandbox !== undefined) await fake.provider.dispose(sandbox);
			if (previousSecret === undefined) {
				delete process.env.SECRET_TOKEN;
			} else {
				process.env.SECRET_TOKEN = previousSecret;
			}
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("fails closed for strict filesystem profiles without a usable sandbox handle", async () => {
		const workspace = await tempRoot();
		try {
			const noHandlePolicy = createBuiltinToolPolicy({
				profile: sandboxProfile,
				binding: binding(sandboxProfile, workspace, true),
				roots: { workspace },
			});
			const insufficientPolicy = createBuiltinToolPolicy({
				profile: sandboxProfile,
				binding: binding(sandboxProfile, workspace, true),
				roots: { workspace },
				sandbox: {
					id: "no-filesystem",
					capabilities: { filesystem: false, process: true, network: false, credentialIsolation: true },
					execute: async () => ({ content: "should not run" }),
				},
			});
			let disposedCalls = 0;
			const disposedPolicy = createBuiltinToolPolicy({
				profile: sandboxProfile,
				binding: binding(sandboxProfile, workspace, true),
				roots: { workspace },
				sandbox: {
					id: "disposed",
					capabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
					execute: async () => {
						disposedCalls++;
						throw new SandboxHandleDisposedError("disposed");
					},
				},
			});
			let hostReadStarted = false;
			const readWithNoHandle = createReadTool(workspace, {
				policy: noHandlePolicy,
				operations: {
					access: async () => {
						hostReadStarted = true;
					},
					readFile: async () => {
						hostReadStarted = true;
						return Buffer.from("host");
					},
				},
			});

			await expect(readWithNoHandle.execute("strict-read-no-handle", { path: "missing.txt" })).rejects.toMatchObject({
				code: "sandbox_required",
			});
			expect(hostReadStarted).toBe(false);
			await expect(
				createWriteTool(workspace, { policy: insufficientPolicy }).execute("strict-write-insufficient", {
					path: "x.txt",
					content: "x",
				}),
			).rejects.toMatchObject({ code: "sandbox_capability_insufficient" });
			await expect(
				createLsTool(workspace, { policy: disposedPolicy }).execute("strict-ls-disposed", { path: "." }),
			).rejects.toMatchObject({ code: "sandbox_unavailable" });
			expect(disposedCalls).toBe(1);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("keeps the mutation queue locked through cancellation cleanup", async () => {
		const workspace = await tempRoot();
		try {
			const file = join(workspace, "queued.txt");
			writeFileSync(file, "old");
			const policy = createBuiltinToolPolicy({
				profile: hostProfile,
				binding: binding(hostProfile, workspace),
				roots: { workspace },
			});
			const writes: string[] = [];
			const edit = createEditTool(workspace, {
				policy,
				operations: {
					access: async () => {},
					readFile: async () => Buffer.from("old"),
					writeFile: async (_path, content) => {
						writes.push(content);
					},
				},
			});
			const controller = new AbortController();
			controller.abort();

			await expect(
				edit.execute("edit-abort", { path: file, edits: [{ oldText: "old", newText: "new" }] }, controller.signal),
			).rejects.toThrow("Operation aborted");
			expect(writes).toEqual([]);
			expect(dirname(await realpath(file))).toBe(await realpath(workspace));
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
