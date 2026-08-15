import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWorkspaceIdentity } from "../../../src/core/execution-policy.ts";
import {
	createGondolinSandboxProvider,
	GONDOLIN_SANDBOX_PROVIDER_ID,
} from "./register.ts";

function text(value) {
	return value === undefined || value === null ? "" : Buffer.isBuffer(value) ? value.toString() : value;
}

function isUnknownSideEffect(value) {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value;
	return (
		candidate.category === "side-effect-unknown" &&
		(candidate.sideEffects === "unknown" || candidate.sideEffectStatus === "unknown")
	);
}

function assertQemuAvailable() {
	const locator = process.platform === "win32" ? "where.exe" : "which";
	const candidates =
		process.arch === "arm64"
			? ["qemu-system-aarch64", "qemu-system-x86_64"]
			: ["qemu-system-x86_64", "qemu-system-aarch64"];
	for (const candidate of candidates) {
		try {
			execFileSync(locator, [candidate], { stdio: "ignore" });
			return;
		} catch {
			// Try the next architecture-specific binary.
		}
	}
	throw new Error("Gondolin smoke requires a qemu-system-* binary on PATH.");
}

function qemuProcessIds() {
	try {
		if (process.platform === "win32") {
			const output = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
			return new Set(
				output
					.split(/\r?\n/)
					.map((line) => line.split('","').map((field) => field.replace(/^"|"$/g, "")))
					.filter((fields) => fields[0]?.toLowerCase().startsWith("qemu-system-") && fields[1] !== undefined)
					.map((fields) => fields[1]),
			);
		}
		const output = execFileSync("ps", ["-eo", "pid=,comm="], { encoding: "utf8" });
		return new Set(
			output
				.split(/\r?\n/)
				.map((line) => line.trim().split(/\s+/, 2))
				.filter((fields) => fields[1]?.startsWith("qemu-system-") && fields[0] !== undefined)
				.map((fields) => fields[0]),
		);
	} catch {
		return new Set();
	}
}

async function main() {
	if (process.env.AOS_AGENT_GONDOLIN_SMOKE !== "1") {
		console.log("Gondolin smoke skipped; set AOS_AGENT_GONDOLIN_SMOKE=1 to run it.");
		return;
	}

	assertQemuAvailable();
	const qemuBefore = qemuProcessIds();
	const workspace = await mkdtemp(path.join(os.tmpdir(), "aos-gondolin-smoke-"));
	const provider = createGondolinSandboxProvider({ workspaceRoot: workspace });
	const binding = {
		schemaVersion: 1,
		id: "policy-binding:gondolin-smoke",
		profileId: "workspace-safe",
		profileRevision: "revision:gondolin-smoke",
		projectTrust: "trusted",
		enforcement: "sandbox",
		sandboxProviderId: GONDOLIN_SANDBOX_PROVIDER_ID,
		sandboxCapabilities: provider.capabilities,
		sandboxStatus: "ready",
		runId: "run:gondolin-smoke",
		createdAt: new Date().toISOString(),
		workspaceIdentity: createWorkspaceIdentity(realpathSync(workspace)),
		constraints: {
			workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
			process: { action: "allow", inheritEnvironment: false, allowedEnvironmentCount: 1, cwdScopes: ["workspace"] },
			network: { action: "deny", allowedDestinationCount: 0 },
			credentials: { action: "deny", allowedNameCount: 0 },
		},
		bindingHash: "digest:gondolin-smoke",
	};

	let handle;
	let failure;
	try {
		await writeFile(path.join(workspace, "input.txt"), "guest smoke input\n");
		handle = await provider.prepare(binding);

		const read = await handle.execute({
			bindingId: binding.id,
			resource: "filesystem.read",
			operation: "file.read",
			path: path.join(workspace, "input.txt"),
		});
		if (text(read.content) !== "guest smoke input\n") throw new Error("Guest filesystem read failed.");

		await handle.execute({
			bindingId: binding.id,
			resource: "filesystem.write",
			operation: "file.write",
			path: path.join(workspace, "output.txt"),
			content: "guest smoke output\n",
		});
		if ((await readFile(path.join(workspace, "output.txt"), "utf8")) !== "guest smoke output\n") {
			throw new Error("Guest filesystem write-through failed.");
		}

		const processResult = await handle.execute({
			bindingId: binding.id,
			resource: "process.spawn",
			command: "printf '%s' \"$AOS_GONDOLIN_SMOKE\"",
			cwd: workspace,
			env: { AOS_GONDOLIN_SMOKE: "guest-only" },
		});
		if (text(processResult.stdout) !== "guest-only") throw new Error("Guest process execution failed.");

		const networkError = await handle
			.execute({ bindingId: binding.id, resource: "network.connect" })
			.then(() => undefined, (error) => error);
		if (typeof networkError !== "object" || networkError === null || networkError.code !== "sandbox_capability_insufficient") {
			throw new Error("Network capability was not rejected.");
		}

		const controller = new AbortController();
		const pending = handle.execute({
			bindingId: binding.id,
			resource: "process.spawn",
			command: "sleep 30",
			cwd: workspace,
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
		controller.abort();
		const cancellationError = await pending.catch((error) => error);
		if (!isUnknownSideEffect(cancellationError)) throw new Error("Cancelled guest process was not classified safely.");
	} catch (error) {
		failure = error;
	} finally {
		if (handle !== undefined) {
			try {
				await provider.dispose(handle);
			} catch (error) {
				failure ??= error;
			}
		}
		try {
			await rm(workspace, { recursive: true, force: true });
		} catch (error) {
			failure ??= error;
		}
		const lingeringQemu = [...qemuProcessIds()].filter((pid) => !qemuBefore.has(pid));
		if (lingeringQemu.length > 0) failure ??= new Error("Gondolin smoke found a residual QEMU process.");
	}

	if (failure !== undefined) throw failure;
	console.log("Gondolin smoke passed: filesystem, process, network policy, cancellation, and dispose.");
}

await main();
