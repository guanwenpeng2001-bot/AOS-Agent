import { realpathSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkspaceIdentity, type PolicyBinding, type SandboxCapabilities } from "../src/core/execution-policy.ts";
import { SandboxHandleDisposedError, type SandboxHandle } from "../src/core/sandbox.ts";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { toRemoteOperationErrorInfo } from "../src/core/remote-operation.ts";
import {
	createGondolinSandboxProvider,
	GONDOLIN_SANDBOX_CAPABILITIES,
	GONDOLIN_SANDBOX_PROVIDER_ID,
} from "../examples/extensions/gondolin/provider.ts";
import {
	GondolinAdapterError,
	createGondolinPathMapper,
	type HostPathOperations,
	type HostPathStat,
} from "../examples/extensions/gondolin/path-mapper.ts";
import {
	createGondolinFilesystemOperations,
	executeGondolinFilesystemOperation,
} from "../examples/extensions/gondolin/filesystem-operations.ts";
import { executeGondolinProcessOperation } from "../examples/extensions/gondolin/process-operations.ts";
import {
	createFakeGondolinVm,
	createFakeGondolinVmFactory,
	type FakeGondolinVmOptions,
	type FakeGondolinVmState,
} from "./fixtures/fake-gondolin-vm.ts";

const workspaces: string[] = [];

const capabilities: SandboxCapabilities = {
	filesystem: true,
	process: true,
	network: false,
	credentialIsolation: true,
};

function createBinding(workspaceRoot: string, overrides: Partial<PolicyBinding> = {}): PolicyBinding {
	return {
		schemaVersion: 1,
		id: "policy-binding:gondolin-test",
		profileId: "gondolin-test",
		profileRevision: "revision:gondolin-test",
		projectTrust: "trusted",
		enforcement: "sandbox",
		sandboxProviderId: GONDOLIN_SANDBOX_PROVIDER_ID,
		sandboxCapabilities: capabilities,
		sandboxStatus: "ready",
		runId: "run:gondolin-test",
		createdAt: "2026-01-01T00:00:00.000Z",
		workspaceIdentity: createWorkspaceIdentity(realpathSync(workspaceRoot)),
		constraints: {
			workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
			process: { action: "allow", inheritEnvironment: false, allowedEnvironmentCount: 2, cwdScopes: ["workspace"] },
			network: { action: "deny", allowedDestinationCount: 0 },
			credentials: { action: "deny", allowedNameCount: 0 },
		},
		bindingHash: "digest:gondolin-test",
		...overrides,
	};
}

async function createWorkspace(): Promise<string> {
	const workspace = await mkdtemp(path.join(os.tmpdir(), "aos-gondolin-test-"));
	workspaces.push(workspace);
	return workspace;
}

function createProvider(workspaceRoot: string, vm: FakeGondolinVmState, options: FakeGondolinVmOptions = {}) {
	const state = Object.keys(options).length === 0 ? vm : createFakeGondolinVm(options);
	return {
		provider: createGondolinSandboxProvider({
			workspaceRoot,
			vmFactory: createFakeGondolinVmFactory(state),
		}),
		state,
	};
}

function createSymlinkHostOperations(workspaceRoot: string, outsideRoot: string): HostPathOperations {
	const link = path.join(workspaceRoot, "junction");
	const directory: HostPathStat = { isDirectory: () => true, isSymbolicLink: () => false };
	const linkStat: HostPathStat = { isDirectory: () => true, isSymbolicLink: () => true };
	const missing = (value: string): Error & { readonly code: "ENOENT" } =>
		Object.assign(new Error(`missing ${value}`), { code: "ENOENT" as const });
	return {
		lstat: async (value) => {
			if (value === workspaceRoot || value === outsideRoot) return directory;
			if (value === link) return linkStat;
			if (value.startsWith(`${link}${path.sep}`)) throw missing(value);
			throw missing(value);
		},
		realpath: async (value) => {
			if (value === link || value.startsWith(`${link}${path.sep}`)) {
				return path.join(outsideRoot, value.slice(link.length + 1));
			}
			return value;
		},
	};
}

afterEach(async () => {
	while (workspaces.length > 0) {
		const workspace = workspaces.pop();
		if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
	}
});

describe("Gondolin provider identity and lifecycle", () => {
	it("is explicit and inert until registered and prepared", async () => {
		const workspace = await createWorkspace();
		const vm = createFakeGondolinVm();
		const { provider, state } = createProvider(workspace, vm);

		expect(provider.id).toBe("gondolin-local");
		expect(provider.id).toBe(GONDOLIN_SANDBOX_PROVIDER_ID);
		expect(provider.capabilities).toEqual(GONDOLIN_SANDBOX_CAPABILITIES);
		expect(state.factoryCalls).toHaveLength(0);
		expect(state.execCalls).toHaveLength(0);
	});

	it("fails closed when no VM factory is supplied", async () => {
		const workspace = await createWorkspace();
		const provider = createGondolinSandboxProvider({ workspaceRoot: workspace });
		await expect(provider.prepare(createBinding(workspace))).rejects.toMatchObject({
			code: "sandbox_start_failed",
		});
	});

	it("never declares credential delivery and fails closed when a binding requires it", async () => {
		const workspace = await createWorkspace();
		const vm = createFakeGondolinVm();
		const { provider } = createProvider(workspace, vm);

		expect(provider.capabilities.credentialDelivery).toBe(false);
		expect(GONDOLIN_SANDBOX_CAPABILITIES.credentialDelivery).toBe(false);

		const requiring = createBinding(workspace, {
			sandboxCapabilities: {
				filesystem: true,
				process: true,
				network: false,
				credentialIsolation: true,
				credentialDelivery: true,
			},
		});
		await expect(provider.prepare(requiring)).rejects.toMatchObject({
			code: "sandbox_capability_insufficient",
			providerId: "gondolin-local",
		});

		const handle = await provider.prepare(createBinding(workspace));
		expect(handle.projectCredential).toBeUndefined();
		expect(handle.renewCredential).toBeUndefined();
		expect(handle.revokeCredential).toBeUndefined();
	});

	it("binds capabilities and rejects mismatched or unavailable bindings before VM creation", async () => {
		const workspace = await createWorkspace();
		const vm = createFakeGondolinVm();
		const { provider, state } = createProvider(workspace, vm);

		await expect(provider.prepare(createBinding(workspace, { sandboxProviderId: "other-provider" }))).rejects.toMatchObject({
			code: "sandbox_start_failed",
		});
		await expect(provider.prepare(createBinding(workspace, { enforcement: "host" }))).rejects.toMatchObject({
			code: "sandbox_start_failed",
		});
		await expect(
			provider.prepare(
				createBinding(workspace, {
					sandboxCapabilities: { ...capabilities, network: true },
				}),
			),
		).rejects.toMatchObject({ code: "sandbox_capability_insufficient" });
		const inheritedEnvironmentBinding = createBinding(workspace);
		await expect(
			provider.prepare({
				...inheritedEnvironmentBinding,
				constraints: {
					...inheritedEnvironmentBinding.constraints,
					process: { ...inheritedEnvironmentBinding.constraints.process, inheritEnvironment: true },
				},
			}),
		).rejects.toMatchObject({ code: "sandbox_capability_insufficient" });
		await expect(
			provider.prepare(createBinding(workspace, { workspaceIdentity: createWorkspaceIdentity(`${workspace}-other`) })),
		).rejects.toMatchObject({ code: "sandbox_start_failed" });
		expect(state.factoryCalls).toHaveLength(0);
	});

	it("deduplicates repeat prepare, closes idempotently, and rejects reuse after dispose", async () => {
		const workspace = await createWorkspace();
		const vm = createFakeGondolinVm();
		const { provider, state } = createProvider(workspace, vm);
		const binding = createBinding(workspace);

		const first = await provider.prepare(binding);
		const repeat = await provider.prepare(binding);
		expect(repeat).toBe(first);
		expect(state.factoryCalls).toHaveLength(1);

		await Promise.all([provider.dispose(first), provider.dispose(first)]);
		await provider.dispose(first);
		expect(state.closeCount()).toBe(1);
		expect(first.status).toBe("closed");
		await expect(first.execute({ bindingId: binding.id, resource: "process.spawn" })).rejects.toBeInstanceOf(
			SandboxHandleDisposedError,
		);

		const next = await provider.prepare(binding);
		expect(next).not.toBe(first);
		expect(next.id).not.toBe(first.id);
		await provider.dispose(next);
		expect(state.closeCount()).toBe(1);
	});

	it("aborts and closes a VM created during prepare", async () => {
		const workspace = await createWorkspace();
		const controller = new AbortController();
		const vm = createFakeGondolinVm();
		const { state } = createProvider(workspace, vm);
		const factory = createFakeGondolinVmFactory(state, () => controller.abort());
		const abortingProvider = createGondolinSandboxProvider({ workspaceRoot: workspace, vmFactory: factory });

		await expect(abortingProvider.prepare(createBinding(workspace), controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(state.closeCount()).toBe(1);
		expect(state.isClosed()).toBe(true);
	});
});

describe("Gondolin guest path boundary", () => {
	it("maps relative and absolute workspace paths to /workspace", async () => {
		const workspace = await createWorkspace();
		const mapper = createGondolinPathMapper(workspace);

		expect(await mapper.toGuestPath(workspace)).toBe("/workspace");
		expect(await mapper.toGuestPath(`@${path.join("src", "main.ts")}`)).toBe("/workspace/src/main.ts");
		expect(await mapper.toGuestPath(path.join(workspace, "src", "new.ts"))).toBe("/workspace/src/new.ts");
	});

	it("maps POSIX absolute workspace paths without treating them as Windows roots", async () => {
		const workspace = await createWorkspace();
		const mapper = createGondolinPathMapper(workspace);
		const posixWorkspace = workspace.split(path.sep).join("/");
		const posixFile = `${posixWorkspace.replace(/\/$/, "")}/src/main.ts`;

		expect(await mapper.toGuestPath(posixFile)).toBe("/workspace/src/main.ts");
		expect(String(await mapper.toGuestPath(posixFile).catch((reason: unknown) => reason))).not.toContain(
			"workspace_boundary_violation",
		);
	});

	it("rejects outside, traversal, drive, and UNC paths without revealing host paths", async () => {
		const workspace = await createWorkspace();
		const mapper = createGondolinPathMapper(workspace);
		const foreignDrive = path.win32.parse(workspace).root.toUpperCase() === "C:\\" ? "D:\\outside\\secret.txt" : "C:\\outside\\secret.txt";
		const candidates = [
			path.join(workspace, "..", "outside.txt"),
			"../outside.txt",
			foreignDrive,
			String.raw`\\server\share\secret.txt`,
		];

		for (const candidate of candidates) {
			const error = await mapper.toGuestPath(candidate).catch((reason: unknown) => reason);
			expect(error).toMatchObject({ code: "workspace_boundary_violation" });
			expect(String(error)).not.toContain(workspace);
		}
	});

	it("rejects symlink and junction escapes, including missing leaves below the link", async () => {
		const workspace = await createWorkspace();
		const outside = await createWorkspace();
		const mapper = createGondolinPathMapper({
			workspaceRoot: workspace,
			hostOperations: createSymlinkHostOperations(workspace, outside),
		});

		await expect(mapper.toGuestPath(path.join(workspace, "junction"))).rejects.toBeInstanceOf(GondolinAdapterError);
		await expect(mapper.toGuestPath(path.join(workspace, "junction", "secret.txt"))).rejects.toMatchObject({
			code: "workspace_boundary_violation",
		});
	});
});

describe("Gondolin guest filesystem and process operations", () => {
	async function prepared(options: FakeGondolinVmOptions = {}) {
		const workspace = await createWorkspace();
		const state = createFakeGondolinVm({
			files: {
				"/workspace/src/main.ts": "needle one\nplain\n",
				"/workspace/src/nested/other.ts": "needle two\n",
				"/workspace/node_modules/ignored.ts": "needle ignored\n",
				...options.files,
			},
			...options,
		});
		const { provider } = createProvider(workspace, state);
		const handle = await provider.prepare(createBinding(workspace));
		return { workspace, state, provider, handle };
	}

	it("routes read, write, and list through the guest filesystem", async () => {
		const test = await prepared();
		const filePath = path.join(test.workspace, "src", "main.ts");

		const read = await test.handle.execute({
			bindingId: "policy-binding:gondolin-test",
			resource: "filesystem.read",
			operation: "file.read",
			path: filePath,
		});
		expect(read.content).toEqual(Buffer.from("needle one\nplain\n"));
		expect(test.state.filesystem.calls).toContainEqual({ operation: "readFile", path: "/workspace/src/main.ts", encoding: null });

		await test.handle.execute({
			bindingId: "policy-binding:gondolin-test",
			resource: "filesystem.write",
			operation: "file.write",
			path: path.join(test.workspace, "generated", "out.txt"),
			content: "guest write",
		});
		expect(test.state.filesystem.files.get("/workspace/generated/out.txt")).toEqual(Buffer.from("guest write"));

		const listed = await test.handle.execute({
			bindingId: "policy-binding:gondolin-test",
			resource: "filesystem.read",
			operation: "directory.list",
			path: test.workspace,
			limit: 2,
		});
		expect(listed.isDirectory).toBe(true);
		expect(listed.entries).toEqual([
			{ name: "generated", isDirectory: true },
			{ name: "node_modules", isDirectory: true },
		]);
		await test.provider.dispose(test.handle);
	});

	it("routes bounded find and grep through the guest and returns host-coordinate labels", async () => {
		const test = await prepared();
		const canonicalWorkspace = await realpath(test.workspace);
		const find = await test.handle.execute({
			bindingId: "policy-binding:gondolin-test",
			resource: "filesystem.find",
			operation: "filesystem.find",
			path: test.workspace,
			pattern: "*.ts",
			limit: 10,
		});
		expect(find.entries).toEqual(["src/main.ts", "src/nested/other.ts"]);

		const grep = await test.handle.execute({
			bindingId: "policy-binding:gondolin-test",
			resource: "filesystem.grep",
			operation: "filesystem.grep",
			path: test.workspace,
			pattern: "needle",
			literal: true,
		});
		const records = String(grep.stdout)
			.split("\n")
			.map((line) => JSON.parse(line) as { readonly data: { readonly path: { readonly text: string } } });
		expect(records).toHaveLength(2);
		expect(records.every((record) => record.data.path.text.startsWith(canonicalWorkspace))).toBe(true);
		expect(records.some((record) => record.data.path.text.endsWith(path.join("src", "main.ts")))).toBe(true);
		await test.provider.dispose(test.handle);
	});

	it("executes only inside the guest with filtered explicit environment and streamed output", async () => {
		const output: Buffer[] = [];
		const test = await prepared({
			onExec: (call) => {
				if (!Array.isArray(call.command) || !call.command.includes("printf guest")) return { exitCode: 0 };
				return {
					exitCode: 0,
					chunks: [
						{ stream: "stdout", data: Buffer.from("guest out") },
						{ stream: "stderr", data: Buffer.from("guest err") },
					],
				};
			},
		});
		const result = await test.handle.execute({
			bindingId: "policy-binding:gondolin-test",
			resource: "process.spawn",
			command: "printf guest",
			cwd: test.workspace,
			env: { PATH: "/bin", LANG: "C" },
			onData: (data) => output.push(data),
		});
		const processCall = test.state.execCalls.at(-1);
		expect(processCall?.command).toEqual(["/bin/sh", "-lc", "printf guest"]);
		expect(processCall?.cwd).toBe("/workspace");
		expect(processCall?.env).toEqual({ PATH: "/bin", LANG: "C" });
		expect(processCall?.env).not.toHaveProperty("AOS_GONDOLIN_TEST_SECRET");
		expect(result.stdout).toEqual(Buffer.from("guest out"));
		expect(result.stderr).toEqual(Buffer.from("guest err"));
		expect(Buffer.concat(output)).toEqual(Buffer.from("guest outguest err"));
		await test.provider.dispose(test.handle);
	});

	it("does not provide network or MCP fallback", async () => {
		const test = await prepared();
		await expect(
			test.handle.execute({ bindingId: "policy-binding:gondolin-test", resource: "network.connect" }),
		).rejects.toMatchObject({ code: "sandbox_capability_insufficient" });
		await expect(
			test.handle.execute({ bindingId: "policy-binding:gondolin-test", resource: "credential.expose" }),
		).rejects.toMatchObject({ code: "policy_violation" });
		expect(test.handle.createMcpTransport).toBeUndefined();
		expect(test.state.execCalls).toHaveLength(0);
		await test.provider.dispose(test.handle);
	});

	it("returns safe errors and never falls back to host I/O for rejected paths", async () => {
		const test = await prepared();
		const beforeFsCalls = test.state.filesystem.calls.length;
		const beforeExecCalls = test.state.execCalls.length;
		const outside = path.join(test.workspace, "..", "secret.txt");

		await expect(
			test.handle.execute({
				bindingId: "policy-binding:gondolin-test",
				resource: "filesystem.read",
				operation: "file.read",
				path: outside,
			}),
		).rejects.toMatchObject({ code: "workspace_boundary_violation" });
		await expect(
			test.handle.execute({
				bindingId: "policy-binding:gondolin-test",
				resource: "process.spawn",
				command: "cat host-secret.txt",
				cwd: outside,
			}),
		).rejects.toMatchObject({ code: "workspace_boundary_violation" });
		expect(test.state.filesystem.calls.length).toBe(beforeFsCalls);
		expect(test.state.execCalls.length).toBe(beforeExecCalls);
		await test.provider.dispose(test.handle);
	});
});

describe("Gondolin cancellation and timeout ordering", () => {
	async function pendingProcess() {
		const workspace = await createWorkspace();
		const state = createFakeGondolinVm({ onExec: () => ({ waitForAbort: true }) });
		const { provider } = createProvider(workspace, state);
		const handle = await provider.prepare(createBinding(workspace));
		return { workspace, state, provider, handle };
	}

	it("checks cancellation before dispatch", async () => {
		const test = await pendingProcess();
		const controller = new AbortController();
		controller.abort();
		await expect(
			test.handle.execute({
				bindingId: "policy-binding:gondolin-test",
				resource: "process.spawn",
				command: "sleep 1",
				cwd: test.workspace,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(test.state.execCalls).toHaveLength(0);
		await test.provider.dispose(test.handle);
	});

	it("propagates cancellation after guest dispatch before reporting success", async () => {
		const test = await pendingProcess();
		const controller = new AbortController();
		const operation = test.handle.execute({
			bindingId: "policy-binding:gondolin-test",
			resource: "process.spawn",
			command: "sleep 1",
			cwd: test.workspace,
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(test.state.execCalls).toHaveLength(1));
		controller.abort();
		await expect(operation).rejects.toMatchObject({ category: "side-effect-unknown", sideEffects: "unknown" });
		expect(test.state.execCalls[0]?.aborted).toBe(true);
		await test.provider.dispose(test.handle);
	});

	it("aborts a dispatched guest process on timeout and returns a safe failure", async () => {
		const test = await pendingProcess();
		const operation = test.handle.execute({
			bindingId: "policy-binding:gondolin-test",
			resource: "process.spawn",
			command: "sleep 1",
			cwd: test.workspace,
			timeoutMs: 5,
		});
		await expect(operation).rejects.toMatchObject({
			code: "policy_violation",
			category: "side-effect-unknown",
			sideEffects: "unknown",
		});
		const error = await operation.catch((reason: unknown) => reason);
		expect(toRemoteOperationErrorInfo(error, "unknown")).toEqual({
			category: "side-effect-unknown",
			code: "side-effect-unknown",
			retryable: false,
			sideEffects: "unknown",
		});
		const jsonView = (error as { readonly toJSON?: () => unknown }).toJSON?.();
		expect(jsonView).toMatchObject({
			code: "policy_violation",
			category: "side-effect-unknown",
			sideEffects: "unknown",
			sideEffectStatus: "unknown",
		});
		expect(toRemoteOperationErrorInfo(jsonView, "unknown")).toEqual({
			category: "side-effect-unknown",
			code: "side-effect-unknown",
			retryable: false,
			sideEffects: "unknown",
		});
		expect(test.state.execCalls[0]?.aborted).toBe(true);
		await test.provider.dispose(test.handle);
	});

	it("stops active guest processes before VM close during dispose", async () => {
		const test = await pendingProcess();
		const operation = test.handle.execute({
			bindingId: "policy-binding:gondolin-test",
			resource: "process.spawn",
			command: "sleep 1",
			cwd: test.workspace,
		});
		await vi.waitFor(() => expect(test.state.execCalls).toHaveLength(1));
		const settledOperation = operation.catch((error: unknown) => error);
		await test.provider.dispose(test.handle);
		await expect(settledOperation).resolves.toMatchObject({ category: "side-effect-unknown" });
		expect(test.state.execCalls[0]?.aborted).toBe(true);
		expect(test.state.isClosed()).toBe(true);
	});

	it("does not downgrade unknown guest side effects to cancellation", async () => {
		const controller = new AbortController();
		const unknownSideEffect = Object.assign(new Error("safe provider error"), {
			category: "side-effect-unknown" as const,
			sideEffects: "unknown" as const,
			sideEffectStatus: "unknown" as const,
		});
		const sandbox: SandboxHandle = {
			id: "gondolin-test-handle",
			capabilities: GONDOLIN_SANDBOX_CAPABILITIES,
			execute: async () => {
				controller.abort();
				throw unknownSideEffect;
			},
		};

		await expect(
			executeBashWithOperations("echo guest", process.cwd(), { exec: async () => ({ exitCode: 0 }) }, {
				sandbox,
				bindingId: "policy-binding:gondolin-test",
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ category: "side-effect-unknown", sideEffects: "unknown" });
	});
});

describe("direct operation seams", () => {
	it("accept injected filesystem and process seams without host execution", async () => {
		const workspace = await createWorkspace();
		const state = createFakeGondolinVm({ files: { "/workspace/readme.txt": "guest" } });
		const mapper = createGondolinPathMapper(workspace);
		const filesystem = createGondolinFilesystemOperations(state.vm, mapper);
		const read = await executeGondolinFilesystemOperation(state.vm, mapper, {
			bindingId: "binding",
			resource: "filesystem.read",
			operation: "file.read",
			path: path.join(workspace, "readme.txt"),
		});
		expect(read.content).toEqual(Buffer.from("guest"));
		expect(await filesystem.readFile(path.join(workspace, "readme.txt"))).toEqual(Buffer.from("guest"));
		const process = await executeGondolinProcessOperation(state.vm, mapper, {
			bindingId: "binding",
			resource: "process.spawn",
			command: "true",
			cwd: workspace,
		});
		expect(process.exitCode).toBe(0);
		expect(state.execCalls.every((call) => Array.isArray(call.command))).toBe(true);
	});
});
