/** Production OS process containment for the current External Connector path. */

import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	externalConnectorProcessContainment,
	type ExternalConnectorProcessController,
	type ExternalConnectorProcessHandle,
	type ExternalConnectorProcessIdentity,
	type ExternalConnectorProcessLaunchRequest,
	type ExternalConnectorProcessReattachResult,
	type ExternalConnectorProcessTerminationRequest,
	type ExternalConnectorProcessTerminationResult,
} from "./external-connector-supervisor.ts";

const ACTIVATION_TIMEOUT_MS = 10_000;
const PROTOCOL_LIMIT_BYTES = 4_096;
const NONCE_MARKER_PREFIX = "AOS_EXTERNAL_CONNECTOR_NONCE=";

const POSIX_GUARDIAN_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const marker = process.argv[1];
let active = false;
let input = "";
process.stdout.write("READY " + marker + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	if (active) return;
	input += chunk;
	const newline = input.indexOf("\n");
	if (newline < 0) return;
	const prefix = "ACTIVATE " + marker + " ";
	const activation = input.slice(0, newline);
	if (!activation.startsWith(prefix)) process.exit(72);
	let processSpec;
	try {
		processSpec = JSON.parse(Buffer.from(activation.slice(prefix.length), "base64").toString("utf8"));
	} catch {
		process.exit(74);
	}
	active = true;
	const child = spawn(processSpec.executablePath, processSpec.arguments, {
		detached: false,
		shell: false,
		stdio: "ignore",
		windowsHide: true,
	});
	child.once("spawn", () => process.stdout.write("ACTIVE " + marker + "\n"));
	child.once("error", () => process.exit(75));
	child.once("exit", () => process.exit(76));
});
process.stdin.on("end", () => {
	if (!active) process.exit(73);
});
`;

const WINDOWS_JOB_GUARDIAN_SOURCE = String.raw`
$ErrorActionPreference = "Stop"
$marker = $args[0]
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class AosExternalConnectorJobHandle {
    public IntPtr Job { get; private set; }
    public IntPtr Process { get; private set; }

    public AosExternalConnectorJobHandle(IntPtr job, IntPtr process) {
        Job = job;
        Process = process;
    }
}

public static class AosExternalConnectorJob {
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    private static string QuoteArgument(string argument) {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) {
            return argument;
        }
        var quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in argument) {
            if (character == '\\') {
                backslashes++;
                continue;
            }
            if (character == '"') {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    public static AosExternalConnectorJobHandle Start(string executablePath, string[] arguments) {
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        const uint CREATE_SUSPENDED = 0x00000004;
        const uint CREATE_NO_WINDOW = 0x08000000;
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(limits);
        IntPtr limitsPointer = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, limitsPointer, false);
            if (!SetInformationJobObject(job, 9, limitsPointer, (uint)size)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        } finally {
            Marshal.FreeHGlobal(limitsPointer);
        }

        var startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(startup);
        PROCESS_INFORMATION process;
        var commandLine = new StringBuilder(QuoteArgument(executablePath));
        foreach (string argument in arguments) {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        if (!CreateProcess(
            executablePath,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            IntPtr.Zero,
            null,
            ref startup,
            out process
        )) {
            CloseHandle(job);
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try {
            if (!AssignProcessToJobObject(job, process.hProcess)) {
                TerminateProcess(process.hProcess, 74);
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (ResumeThread(process.hThread) == 0xffffffff) {
                TerminateProcess(process.hProcess, 75);
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        } catch {
            CloseHandle(process.hProcess);
            CloseHandle(job);
            throw;
        } finally {
            CloseHandle(process.hThread);
        }
        return new AosExternalConnectorJobHandle(job, process.hProcess);
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[Console]::Out.WriteLine("READY " + $marker)
$activation = [Console]::In.ReadLine()
$prefix = "ACTIVATE " + $marker + " "
if ($null -eq $activation -or !$activation.StartsWith($prefix)) { exit 72 }
$processSpecJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($activation.Substring($prefix.Length)))
$processSpec = $processSpecJson | ConvertFrom-Json
$contained = [AosExternalConnectorJob]::Start([string]$processSpec.executablePath, [string[]]@($processSpec.arguments))
[Console]::Out.WriteLine("ACTIVE " + $marker)
try {
	while ([AosExternalConnectorJob]::WaitForSingleObject($contained.Process, 3600000) -eq 258) {}
	exit 76
} finally {
	if ($contained.Process -ne [IntPtr]::Zero) { [AosExternalConnectorJob]::CloseHandle($contained.Process) | Out-Null }
	if ($contained.Job -ne [IntPtr]::Zero) { [AosExternalConnectorJob]::CloseHandle($contained.Job) | Out-Null }
}
`;

type SupportedExternalConnectorPlatform = "linux" | "win32";

interface LiveProcessInspection {
	readonly identity: ExternalConnectorProcessIdentity;
	readonly nonceMarkerPresent: boolean;
}

type ProcessInspection =
	| { readonly status: "live"; readonly value: LiveProcessInspection }
	| { readonly status: "not_found" | "ambiguous" };

export interface ProductionExternalConnectorProcessControllerOptions {
	readonly platform?: string;
	readonly process: ProductionExternalConnectorProcess;
}

export interface ProductionExternalConnectorProcess {
	readonly executablePath: string;
	readonly arguments?: readonly string[];
}

function supportedPlatform(platform: string): SupportedExternalConnectorPlatform {
	if (platform === "linux" || platform === "win32") return platform;
	throw new TypeError(`External Connector process supervision is unsupported on ${platform}`);
}

function nonceMarker(nonce: string): string {
	return `${NONCE_MARKER_PREFIX}${nonce}`;
}

function sameIdentity(left: ExternalConnectorProcessIdentity, right: ExternalConnectorProcessIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.startToken === right.startToken &&
		left.executableIdentity === right.executableIdentity &&
		left.fileIdentity === right.fileIdentity
	);
}

function executableIdentity(path: string): Pick<ExternalConnectorProcessIdentity, "executableIdentity" | "fileIdentity"> {
	const resolved = realpathSync(path);
	const stat = statSync(resolved, { bigint: true });
	const digest = createHash("sha256").update(readFileSync(resolved)).digest("hex");
	return {
		executableIdentity: `sha256:${digest}`,
		fileIdentity: `file:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`,
	};
}

function inspectLinuxProcess(pid: number, expectedNonce: string): ProcessInspection {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return { status: "ambiguous" };
		const fields = stat.slice(close + 2).trim().split(/\s+/u);
		const startToken = fields[19];
		if (startToken === undefined || !/^\d+$/u.test(startToken)) return { status: "ambiguous" };
		const command = readFileSync(`/proc/${pid}/cmdline`)
			.toString("utf8")
			.split("\0")
			.filter((part) => part.length > 0);
		const executablePath = realpathSync(`/proc/${pid}/exe`);
		return {
			status: "live",
			value: {
				identity: { pid, startToken, ...executableIdentity(executablePath) },
				nonceMarkerPresent: command.includes(nonceMarker(expectedNonce)),
			},
		};
	} catch (error) {
		return isMissingProcessError(error) ? { status: "not_found" } : { status: "ambiguous" };
	}
}

const WINDOWS_PROCESS_INSPECTION_SOURCE = `
$ErrorActionPreference = "Stop"
$targetPid = [int]$args[0]
$process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if ($null -eq $process) { exit 3 }
$cim = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $targetPid)
if ($null -eq $cim -or $null -eq $process.Path -or $null -eq $cim.CommandLine) { exit 4 }
@{
	path = $process.Path
	startToken = $process.StartTime.ToUniversalTime().Ticks.ToString()
	commandLine = $cim.CommandLine
} | ConvertTo-Json -Compress
`;

function powershellPath(): string {
	const systemRoot = process.env.SystemRoot;
	if (systemRoot === undefined || systemRoot.length === 0) {
		throw new TypeError("Windows External Connector supervision requires SystemRoot");
	}
	const path = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	statSync(path);
	return path;
}

function inspectWindowsProcess(pid: number, expectedNonce: string, shellPath: string): ProcessInspection {
	const inspected = spawnSync(
		shellPath,
		["-NoProfile", "-NonInteractive", "-Command", `& {\n${WINDOWS_PROCESS_INSPECTION_SOURCE}\n} '${pid}'`],
		{ encoding: "utf8", timeout: ACTIVATION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
	);
	if (inspected.status === 3) return { status: "not_found" };
	if (inspected.status !== 0 || inspected.error !== undefined) return { status: "ambiguous" };
	try {
		const value: unknown = JSON.parse(inspected.stdout.trim());
		if (
			typeof value !== "object" ||
			value === null ||
			!("path" in value) ||
			!("startToken" in value) ||
			!("commandLine" in value) ||
			typeof value.path !== "string" ||
			typeof value.startToken !== "string" ||
			typeof value.commandLine !== "string"
		) return { status: "ambiguous" };
		const marker = nonceMarker(expectedNonce);
		const markerPattern = new RegExp(`(?:^|[\\s"'])${escapeRegExp(marker)}(?:$|[\\s"'])`, "u");
		return {
			status: "live",
			value: {
				identity: { pid, startToken: value.startToken, ...executableIdentity(value.path) },
				nonceMarkerPresent: markerPattern.test(value.commandLine),
			},
		};
	} catch {
		return { status: "ambiguous" };
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isMissingProcessError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ESRCH")
	);
}

function childExited(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

function waitForProtocolLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = "";
		let errorOutput = "";
		const timer = setTimeout(() => finish(new Error("External Connector containment helper timed out")), ACTIVATION_TIMEOUT_MS);
		timer.unref();
		const onOutput = (chunk: Buffer): void => {
			output += chunk.toString("utf8");
			if (Buffer.byteLength(output, "utf8") > PROTOCOL_LIMIT_BYTES) {
				finish(new Error("External Connector containment helper output exceeded its limit"));
				return;
			}
			const newline = output.indexOf("\n");
			if (newline < 0) return;
			if (output.slice(0, newline).trimEnd() !== expected) {
				finish(new Error("External Connector containment helper protocol was invalid"));
				return;
			}
			finish();
		};
		const onErrorOutput = (chunk: Buffer): void => {
			errorOutput += chunk.toString("utf8");
			if (Buffer.byteLength(errorOutput, "utf8") > PROTOCOL_LIMIT_BYTES) {
				finish(new Error("External Connector containment helper error output exceeded its limit"));
			}
		};
		const onError = (error: Error): void => finish(error);
		const onExit = (): void => finish(new Error("External Connector containment helper exited early"));
		const cleanup = (): void => {
			clearTimeout(timer);
			child.stdout.off("data", onOutput);
			child.stderr.off("data", onErrorOutput);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		const finish = (error?: Error): void => {
			cleanup();
			if (error === undefined) resolve();
			else reject(error);
		};
		child.stdout.on("data", onOutput);
		child.stderr.on("data", onErrorOutput);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

class ProductionExternalConnectorProcessHandle implements ExternalConnectorProcessHandle {
	readonly operationNonce: string;
	readonly detached = false as const;
	readonly containment: "process_group" | "job_object";
	readonly identity: ExternalConnectorProcessIdentity;
	readonly exited: Promise<void>;
	readonly #activateOperation: () => Promise<void>;
	readonly #terminationOperation: (
		request: ExternalConnectorProcessTerminationRequest,
	) => ExternalConnectorProcessTerminationResult;
	#activated: boolean;

	constructor(options: {
		readonly operationNonce: string;
		readonly containment: "process_group" | "job_object";
		readonly identity: ExternalConnectorProcessIdentity;
		readonly exited: Promise<void>;
		readonly activated: boolean;
		readonly activate: () => Promise<void>;
		readonly forceTerminate: (
			request: ExternalConnectorProcessTerminationRequest,
		) => ExternalConnectorProcessTerminationResult;
	}) {
		this.operationNonce = options.operationNonce;
		this.containment = options.containment;
		this.identity = Object.freeze({ ...options.identity });
		this.exited = options.exited;
		this.#activated = options.activated;
		this.#activateOperation = options.activate;
		this.#terminationOperation = options.forceTerminate;
	}

	async activate(): Promise<void> {
		if (this.#activated) return;
		await this.#activateOperation();
		this.#activated = true;
	}

	forceTerminate(request: ExternalConnectorProcessTerminationRequest): ExternalConnectorProcessTerminationResult {
		return this.#terminationOperation(request);
	}
}

/** Concrete fail-closed process controller for Linux process groups and Windows Job Objects. */
export class ProductionExternalConnectorProcessController implements ExternalConnectorProcessController {
	readonly #platform: SupportedExternalConnectorPlatform;
	readonly #shellPath: string | undefined;
	readonly #setsidPath: string | undefined;
	readonly #processSpec: string;

	constructor(options: ProductionExternalConnectorProcessControllerOptions) {
		this.#platform = supportedPlatform(options.platform ?? process.platform);
		this.#processSpec = encodeProcessSpec(options.process);
		if (this.#platform === "win32") {
			this.#shellPath = powershellPath();
			this.#setsidPath = undefined;
		} else {
			this.#shellPath = undefined;
			this.#setsidPath = this.#resolveSetsid();
		}
	}

	async launch(request: ExternalConnectorProcessLaunchRequest): Promise<ExternalConnectorProcessHandle> {
		this.#validateRequest(request);
		const marker = nonceMarker(request.operationNonce);
		const child = this.#spawnGuardian(marker);
		try {
			await waitForProtocolLine(child, `READY ${marker}`);
			const inspection = this.#inspect(child.pid!, request.operationNonce);
			if (inspection.status !== "live" || !inspection.value.nonceMarkerPresent) {
				throw new Error("External Connector containment helper identity was ambiguous");
			}
			const identity = inspection.value.identity;
			return new ProductionExternalConnectorProcessHandle({
				operationNonce: request.operationNonce,
				containment: request.containment,
				identity,
				exited: childExited(child),
				activated: false,
				activate: async () => {
					const active = waitForProtocolLine(child, `ACTIVE ${marker}`);
					child.stdin.end(`ACTIVATE ${marker} ${this.#processSpec}\n`);
					await active;
				},
				forceTerminate: (termination) => this.#forceTerminate(identity, request.operationNonce, termination),
			});
		} catch (error) {
			child.kill("SIGKILL");
			throw error;
		}
	}

	reattach(
		identity: ExternalConnectorProcessIdentity,
		request: ExternalConnectorProcessLaunchRequest,
	): ExternalConnectorProcessReattachResult {
		this.#validateRequest(request);
		const inspection = this.#inspect(identity.pid, request.operationNonce);
		if (inspection.status !== "live") return { status: inspection.status };
		if (!inspection.value.nonceMarkerPresent || !sameIdentity(inspection.value.identity, identity)) {
			return { status: "identity_mismatch" };
		}
		return {
			status: "attached",
			handle: new ProductionExternalConnectorProcessHandle({
				operationNonce: request.operationNonce,
				containment: request.containment,
				identity,
				exited: this.#monitorExit(identity.pid),
				activated: true,
				activate: () => Promise.resolve(),
				forceTerminate: (termination) => this.#forceTerminate(identity, request.operationNonce, termination),
			}),
		};
	}

	#forceTerminate(
		boundIdentity: ExternalConnectorProcessIdentity,
		boundNonce: string,
		request: ExternalConnectorProcessTerminationRequest,
	): ExternalConnectorProcessTerminationResult {
		if (
			request.operationNonce !== boundNonce ||
			!sameIdentity(request.processIdentity, boundIdentity)
		) return "identity_mismatch";
		const inspection = this.#inspect(boundIdentity.pid, boundNonce);
		if (inspection.status !== "live") {
			return inspection.status === "not_found" ? "already_exited" : "ambiguous";
		}
		if (!inspection.value.nonceMarkerPresent || !sameIdentity(inspection.value.identity, boundIdentity)) {
			return "identity_mismatch";
		}
		try {
			if (this.#platform === "linux") process.kill(-boundIdentity.pid, "SIGKILL");
			else process.kill(boundIdentity.pid, "SIGKILL");
			return "termination_requested";
		} catch (error) {
			return isMissingProcessError(error) ? "already_exited" : "ambiguous";
		}
	}

	#spawnGuardian(marker: string): ChildProcessWithoutNullStreams {
		if (this.#platform === "linux") {
			return spawn(this.#setsidPath!, [process.execPath, "-e", POSIX_GUARDIAN_SOURCE, marker], {
				detached: false,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		}
		return spawn(
			this.#shellPath!,
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`& {\n${WINDOWS_JOB_GUARDIAN_SOURCE}\n} '${powerShellLiteral(marker)}'`,
			],
			{ detached: false, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
	}

	#inspect(pid: number, nonce: string): ProcessInspection {
		return this.#platform === "linux"
			? inspectLinuxProcess(pid, nonce)
			: inspectWindowsProcess(pid, nonce, this.#shellPath!);
	}

	#monitorExit(pid: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setInterval(() => {
				try {
					process.kill(pid, 0);
				} catch {
					clearInterval(timer);
					resolve();
				}
			}, 250);
			timer.unref();
		});
	}

	#resolveSetsid(): string {
		for (const path of ["/usr/bin/setsid", "/bin/setsid"]) {
			try {
				statSync(path);
				return path;
			} catch {
				// Continue to the next fixed system path.
			}
		}
		throw new TypeError("Linux External Connector supervision requires setsid");
	}

	#validateRequest(request: ExternalConnectorProcessLaunchRequest): void {
		if (
			request.detached !== false ||
			request.containment !== externalConnectorProcessContainment(this.#platform) ||
			typeof request.supervisorRef !== "string" ||
			request.supervisorRef.length === 0 ||
			typeof request.operationNonce !== "string" ||
			request.operationNonce.length === 0
		) throw new TypeError("External Connector process launch request is invalid");
	}
}

function powerShellLiteral(value: string): string {
	return value.replaceAll("'", "''");
}

function encodeProcessSpec(value: ProductionExternalConnectorProcess): string {
	if (
		typeof value?.executablePath !== "string" ||
		!isAbsolute(value.executablePath) ||
		value.executablePath.includes("\0") ||
		(value.arguments !== undefined && (
			!Array.isArray(value.arguments) ||
			value.arguments.length > 256 ||
			value.arguments.some((argument) =>
				typeof argument !== "string" || argument.includes("\0") || Buffer.byteLength(argument, "utf8") > 64 * 1024
			)
		))
	) throw new TypeError("External Connector companion process is invalid");
	const executablePath = realpathSync(value.executablePath);
	if (!statSync(executablePath).isFile()) {
		throw new TypeError("External Connector companion executable is not a file");
	}
	const serialized = JSON.stringify({
		executablePath,
		arguments: value.arguments === undefined ? [] : [...value.arguments],
	});
	if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
		throw new TypeError("External Connector companion process specification is too large");
	}
	return Buffer.from(serialized, "utf8").toString("base64");
}
