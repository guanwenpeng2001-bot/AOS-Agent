/** Production OS process containment for the current External Connector path. */

import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	externalConnectorProcessContainment,
	type ExternalConnectorProcessChannel,
	type ExternalConnectorProcessController,
	type ExternalConnectorProcessHandle,
	type ExternalConnectorProcessIdentity,
	type ExternalConnectorProcessLaunchRequest,
	type ExternalConnectorProcessReattachResult,
	type ExternalConnectorProcessTerminationRequest,
	type ExternalConnectorProcessTerminationResult,
	type ExternalConnectorProcessTerminationOptions,
	type ExternalConnectorSupervisorReference,
} from "./supervisor.ts";
import { SYSTEM_RUNTIME_CLOCK, type RuntimeClock } from "../runtime/clock.ts";

const ACTIVATION_TIMEOUT_MS = 10_000;
const PROTOCOL_LIMIT_BYTES = 4_096;
const PROCESS_CHANNEL_MAX_LINE_BYTES = 256 * 1024;
const NONCE_MARKER_PREFIX = "AOS_EXTERNAL_CONNECTOR_NONCE=";
const PROVENANCE_DIGEST_CACHE = new Map<string, string>();
const GATEWAY_ENVIRONMENT_KEYS = new Set([
	"AOS_MODEL_GATEWAY_ENDPOINT",
	"AOS_MODEL_GATEWAY_AUTHORIZATION",
	"AOS_MODEL_GATEWAY_BINDING_DIGEST",
	"OPENAI_BASE_URL",
	"OPENAI_API_KEY",
]);

const POSIX_GUARDIAN_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const marker = process.argv[1];
let active = false;
let input = "";
let child;
const terminateGroup = () => {
	try {
		process.kill(-process.pid, "SIGKILL");
	} catch {
		process.exit(76);
	}
};
process.stdout.write("READY " + marker + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	if (active) {
		if (child?.stdin?.writable !== true || !child.stdin.write(chunk)) terminateGroup();
		return;
	}
	if (child !== undefined) {
		input += chunk;
		return;
	}
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
	input = input.slice(newline + 1);
	child = spawn(processSpec.executablePath, processSpec.arguments, {
		cwd: processSpec.cwd,
		detached: false,
		env: processSpec.environment,
		shell: false,
		stdio: ["pipe", "pipe", "ignore"],
		windowsHide: true,
	});
	child.once("spawn", () => {
		active = true;
		process.stdout.write("ACTIVE " + marker + "\n");
		child.stdout.on("data", (output) => process.stdout.write(output));
		child.stdin.once("error", terminateGroup);
		const remainder = input;
		input = "";
		if (remainder.length > 0 && child.stdin.writable === true) child.stdin.write(remainder);
	});
	child.once("error", terminateGroup);
	child.once("exit", terminateGroup);
});
process.stdin.on("end", () => {
	if (!active) process.exit(73);
	if (child?.stdin?.writable === true) child.stdin.end();
});
`;

const WINDOWS_JOB_GUARDIAN_SOURCE = `
$ErrorActionPreference = "Stop"
$marker = $args[0]
$source = @'
using System;
using System.ComponentModel;
using Microsoft.Win32.SafeHandles;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class AosExternalConnectorJobHandle {
    public IntPtr Job { get; private set; }
    public IntPtr Process { get; private set; }
    public IntPtr StandardInput { get; private set; }
    public IntPtr StandardOutput { get; private set; }
    public IntPtr StandardError { get; private set; }

    public AosExternalConnectorJobHandle(IntPtr job, IntPtr process, IntPtr standardInput, IntPtr standardOutput, IntPtr standardError) {
        Job = job;
        Process = process;
        StandardInput = standardInput;
        StandardOutput = standardOutput;
        StandardError = standardError;
    }
}

public static class AosExternalConnectorJob {
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

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

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES {
        public int Length;
        public IntPtr SecurityDescriptor;
        public int InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public uint Cb;
        public string Reserved;
        public string Desktop;
        public string Title;
        public uint X;
        public uint Y;
        public uint XSize;
        public uint YSize;
        public uint XCountChars;
        public uint YCountChars;
        public uint FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort Reserved2;
        public IntPtr Reserved2Pointer;
        public IntPtr StandardInput;
        public IntPtr StandardOutput;
        public IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out IntPtr readPipe,
        out IntPtr writePipe,
        ref SECURITY_ATTRIBUTES attributes,
        uint size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

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
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    public static void StartRelay(AosExternalConnectorJobHandle handle) {
        var output = new Thread(() => {
            try {
                using (var source = new FileStream(new SafeFileHandle(handle.StandardOutput, true), FileAccess.Read)) {
                    source.CopyTo(Console.OpenStandardOutput());
                }
            }
            catch { }
        });
        output.IsBackground = true;
        output.Start();
        var input = new Thread(() => {
            try {
                using (var destination = new FileStream(new SafeFileHandle(handle.StandardInput, true), FileAccess.Write)) {
                    string line;
                    while ((line = Console.ReadLine()) != null) {
                        byte[] bytes = Encoding.UTF8.GetBytes(line + "\\n");
                        destination.Write(bytes, 0, bytes.Length);
                        destination.Flush();
                    }
                }
            } catch { }
        });
        input.IsBackground = true;
        input.Start();
        var error = new Thread(() => {
            try {
                using (var source = new FileStream(new SafeFileHandle(handle.StandardError, true), FileAccess.Read)) {
                    source.CopyTo(Stream.Null);
                }
            } catch { }
        });
        error.IsBackground = true;
        error.Start();
    }

    private static string QuoteArgument(string argument) {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\\t', '\\n', '\\v', '"' }) < 0) {
            return argument;
        }
        var quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in argument) {
            if (character == '\\\\') {
                backslashes++;
                continue;
            }
            if (character == '"') {
                quoted.Append('\\\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    public static AosExternalConnectorJobHandle Start(string executablePath, string[] arguments, string[] environment, string cwd) {
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

        var attributes = new SECURITY_ATTRIBUTES {
            Length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
            SecurityDescriptor = IntPtr.Zero,
            InheritHandle = 1,
        };
        var commandLine = new StringBuilder();
        commandLine.Append(QuoteArgument(executablePath));
        foreach (string argument in arguments) {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        IntPtr childInput = IntPtr.Zero;
        IntPtr parentInput = IntPtr.Zero;
        IntPtr parentOutput = IntPtr.Zero;
        IntPtr childOutput = IntPtr.Zero;
        IntPtr parentError = IntPtr.Zero;
        IntPtr childError = IntPtr.Zero;
        if (!CreatePipe(out childInput, out parentInput, ref attributes, 0) ||
            !CreatePipe(out parentOutput, out childOutput, ref attributes, 0) ||
            !CreatePipe(out parentError, out childError, ref attributes, 0) ||
            !SetHandleInformation(parentInput, HANDLE_FLAG_INHERIT, 0) ||
            !SetHandleInformation(parentOutput, HANDLE_FLAG_INHERIT, 0) ||
            !SetHandleInformation(parentError, HANDLE_FLAG_INHERIT, 0)) {
            CloseHandle(childInput);
            CloseHandle(parentInput);
            CloseHandle(parentOutput);
            CloseHandle(childOutput);
            CloseHandle(parentError);
            CloseHandle(childError);
            CloseHandle(job);
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        var startup = new STARTUPINFO();
        startup.Cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startup.Flags = STARTF_USESTDHANDLES;
        startup.StandardInput = childInput;
        startup.StandardOutput = childOutput;
        startup.StandardError = childError;
        var environmentBlock = String.Join("\\0", environment) + "\\0\\0";
        IntPtr environmentPointer = Marshal.StringToHGlobalUni(environmentBlock);
        PROCESS_INFORMATION process;
        try {
            if (!CreateProcess(
                executablePath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environmentPointer,
                cwd,
                ref startup,
                out process
            )) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        } catch {
            CloseHandle(childInput);
            CloseHandle(parentInput);
            CloseHandle(parentOutput);
            CloseHandle(childOutput);
            CloseHandle(parentError);
            CloseHandle(childError);
            CloseHandle(job);
            throw;
        } finally {
            Marshal.FreeHGlobal(environmentPointer);
        }

        try {
            CloseHandle(childInput);
            CloseHandle(childOutput);
            CloseHandle(childError);
            if (!AssignProcessToJobObject(job, process.Process)) {
                TerminateProcess(process.Process, 74);
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (ResumeThread(process.Thread) == 0xffffffff) {
                TerminateProcess(process.Process, 75);
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        } catch {
            CloseHandle(process.Process);
            CloseHandle(job);
            CloseHandle(parentInput);
            CloseHandle(parentOutput);
            CloseHandle(parentError);
            throw;
        } finally {
            CloseHandle(process.Thread);
        }
        return new AosExternalConnectorJobHandle(job, process.Process, parentInput, parentOutput, parentError);
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
$environment = @($processSpec.environment.PSObject.Properties | ForEach-Object { $_.Name + "=" + [string]$_.Value })
$contained = [AosExternalConnectorJob]::Start([string]$processSpec.executablePath, [string[]]@($processSpec.arguments), [string[]]$environment, [string]$processSpec.cwd)
[Console]::Out.WriteLine("ACTIVE " + $marker)
[AosExternalConnectorJob]::StartRelay($contained)
try {
	while ([AosExternalConnectorJob]::WaitForSingleObject($contained.Process, 3600000) -eq 258) {}
	exit 76
} finally {
	if ($contained.Process -ne [IntPtr]::Zero) { [AosExternalConnectorJob]::CloseHandle($contained.Process) | Out-Null }
	if ($contained.Job -ne [IntPtr]::Zero) { [AosExternalConnectorJob]::CloseHandle($contained.Job) | Out-Null }
}
`;

type SupportedExternalConnectorPlatform = "darwin" | "linux" | "win32";

export type ExternalConnectorGuardianLaunchKind = "direct_process_group" | "setsid_process_group" | "windows_job";

export interface ExternalConnectorGuardianLaunchStrategy {
	readonly kind: ExternalConnectorGuardianLaunchKind;
	readonly guardianDetached: boolean;
	readonly companionDetached: false;
}

export function externalConnectorGuardianLaunchStrategy(platform: string): ExternalConnectorGuardianLaunchStrategy {
	if (platform === "darwin") {
		return Object.freeze({ kind: "direct_process_group", guardianDetached: true, companionDetached: false });
	}
	if (platform === "linux") {
		return Object.freeze({ kind: "setsid_process_group", guardianDetached: false, companionDetached: false });
	}
	if (platform === "win32") {
		return Object.freeze({ kind: "windows_job", guardianDetached: false, companionDetached: false });
	}
	throw new TypeError(`External Connector process supervision is unsupported on ${platform}`);
}

const MINIMAL_ENVIRONMENT_KEYS = Object.freeze({
	darwin: Object.freeze(["TMPDIR"]),
	linux: Object.freeze([]),
	win32: Object.freeze(["SystemRoot", "TEMP", "TMP", "WINDIR"]),
} satisfies Readonly<Record<SupportedExternalConnectorPlatform, readonly string[]>>);

/** Allow only variables required to start the platform containment helper and its companion. */
export function externalConnectorMinimalEnvironment(
	platform: string,
	source: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
	const supported = supportedPlatform(platform);
	const environment: Record<string, string> = {};
	for (const allowedKey of MINIMAL_ENVIRONMENT_KEYS[supported]) {
		const sourceKey = Object.keys(source).find((key) =>
			supported === "win32" ? key.toLowerCase() === allowedKey.toLowerCase() : key === allowedKey,
		);
		if (sourceKey === undefined) continue;
		const value = source[sourceKey];
		if (value !== undefined && !value.includes("\0")) environment[allowedKey] = value;
	}
	return Object.freeze(environment);
}

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
	readonly clock?: RuntimeClock;
}

export interface ProductionExternalConnectorProcess {
	readonly executablePath: string;
	readonly arguments?: readonly string[];
	readonly trustedProvenance?: ProductionExternalConnectorTrustedProvenance;
}

/** Production process configuration whose provenance was established by trusted Host composition. */
export type ProductionExternalConnectorProcessWithProvenance = ProductionExternalConnectorProcess & {
	readonly trustedProvenance: ProductionExternalConnectorTrustedProvenance;
};

export interface ProductionExternalConnectorTrustedProvenance {
	readonly modulePath: string;
	readonly cwd: string;
	readonly version: string;
	readonly executableIdentity: string;
	readonly moduleIdentity: string;
}

export interface ProductionExternalConnectorDriverProvenance {
	readonly executablePath: string;
	readonly modulePath: string;
	readonly cwd: string;
	readonly version: string;
	readonly executableIdentity: string;
	readonly executableFileIdentity: string;
	readonly moduleIdentity: string;
	readonly moduleFileIdentity: string;
	readonly shell: false;
	readonly environmentKeys: readonly string[];
}

function supportedPlatform(platform: string): SupportedExternalConnectorPlatform {
	if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
	throw new TypeError(`External Connector process supervision is unsupported on ${platform}`);
}

function nonceMarker(nonce: string): string {
	return `${NONCE_MARKER_PREFIX}${nonce}`;
}

function processChannelKey(supervisorRef: string, operationNonce: string): string {
	return `${supervisorRef}\0${operationNonce}`;
}

function sameIdentity(left: ExternalConnectorProcessIdentity, right: ExternalConnectorProcessIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.startToken === right.startToken &&
		left.executableIdentity === right.executableIdentity &&
		left.fileIdentity === right.fileIdentity
	);
}

function executableIdentity(
	path: string,
	persistedExecutableIdentity?: string,
): Pick<ExternalConnectorProcessIdentity, "executableIdentity" | "fileIdentity"> {
	const resolved = realpathSync(path);
	const stat = statSync(resolved, { bigint: true });
	return {
		executableIdentity:
			persistedExecutableIdentity ?? `sha256:${createHash("sha256").update(readFileSync(resolved)).digest("hex")}`,
		fileIdentity: `file:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`,
	};
}

function fileProvenance(path: string): { readonly path: string; readonly digest: string; readonly fileIdentity: string } {
	const resolved = realpathSync(path);
	const stat = statSync(resolved, { bigint: true });
	const fileIdentity = `file:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
	const cacheKey = `${resolved}\0${fileIdentity}`;
	let digest = PROVENANCE_DIGEST_CACHE.get(cacheKey);
	if (digest === undefined) {
		digest = `sha256:${createHash("sha256").update(readFileSync(resolved)).digest("hex")}`;
		if (PROVENANCE_DIGEST_CACHE.size >= 64) PROVENANCE_DIGEST_CACHE.clear();
		PROVENANCE_DIGEST_CACHE.set(cacheKey, digest);
	}
	return { path: resolved, digest, fileIdentity };
}

/** Resolve and validate private Host-owned driver provenance before activation. */
export function resolveProductionExternalConnectorDriverProvenance(
	value: ProductionExternalConnectorProcess,
	platform = process.platform,
): ProductionExternalConnectorDriverProvenance | undefined {
	const trusted = value.trustedProvenance;
	if (trusted === undefined) return undefined;
	if (
		!isAbsolute(trusted.modulePath) ||
		!isAbsolute(trusted.cwd) ||
		trusted.version.length === 0 ||
		trusted.executableIdentity.length === 0 ||
		trusted.moduleIdentity.length === 0
	) throw new TypeError("External Connector trusted driver provenance is invalid");
	const executable = fileProvenance(value.executablePath);
	const module = fileProvenance(trusted.modulePath);
	if (
		module.path !== executable.path &&
		value.arguments?.some((argument) => isAbsolute(argument) && realpathSync(argument) === module.path) !== true
	) {
		throw new TypeError("External Connector trusted module is not the configured process target");
	}
	const cwd = realpathSync(trusted.cwd);
	if (!statSync(cwd).isDirectory()) throw new TypeError("External Connector trusted driver cwd is invalid");
	if (executable.digest !== trusted.executableIdentity || module.digest !== trusted.moduleIdentity) {
		throw new TypeError("External Connector trusted driver file identity does not match");
	}
	return Object.freeze({
		executablePath: executable.path,
		modulePath: module.path,
		cwd,
		version: trusted.version,
		executableIdentity: executable.digest,
		executableFileIdentity: executable.fileIdentity,
		moduleIdentity: module.digest,
		moduleFileIdentity: module.fileIdentity,
		shell: false,
		environmentKeys: Object.freeze(Object.keys(externalConnectorMinimalEnvironment(platform)).sort()),
	});
}

function inspectLinuxProcess(
	pid: number,
	expectedNonce: string,
	canContinue: () => boolean = () => true,
	persistedExecutableIdentity?: string,
): ProcessInspection {
	try {
		if (!canContinue()) return { status: "ambiguous" };
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		if (!canContinue()) return { status: "ambiguous" };
		const close = stat.lastIndexOf(")");
		if (close < 0) return { status: "ambiguous" };
		const fields = stat
			.slice(close + 2)
			.trim()
			.split(/\s+/u);
		const startToken = fields[19];
		if (startToken === undefined || !/^\d+$/u.test(startToken)) return { status: "ambiguous" };
		const command = readFileSync(`/proc/${pid}/cmdline`)
			.toString("utf8")
			.split("\0")
			.filter((part) => part.length > 0);
		if (!canContinue()) return { status: "ambiguous" };
		const executablePath = realpathSync(`/proc/${pid}/exe`);
		if (!canContinue()) return { status: "ambiguous" };
		return {
			status: "live",
			value: {
				identity: { pid, startToken, ...executableIdentity(executablePath, persistedExecutableIdentity) },
				nonceMarkerPresent: command.includes(nonceMarker(expectedNonce)),
			},
		};
	} catch (error) {
		return isMissingProcessError(error) ? { status: "not_found" } : { status: "ambiguous" };
	}
}

function inspectDarwinProcess(
	pid: number,
	expectedNonce: string,
	remainingTimeoutMs: () => number = () => ACTIVATION_TIMEOUT_MS,
	persistedExecutableIdentity?: string,
): ProcessInspection {
	const start = inspectDarwinField(pid, "lstart", remainingTimeoutMs);
	if (start.status !== "value") return { status: start.status };
	const command = inspectDarwinField(pid, "command", remainingTimeoutMs);
	if (command.status !== "value") return { status: command.status };
	const secondStart = inspectDarwinField(pid, "lstart", remainingTimeoutMs);
	if (secondStart.status !== "value" || secondStart.value !== start.value) {
		return { status: secondStart.status === "not_found" ? "not_found" : "ambiguous" };
	}
	if (remainingTimeoutMs() <= 0) return { status: "ambiguous" };
	const executablePath = inspectDarwinExecutable(pid, remainingTimeoutMs);
	if (executablePath === undefined) return { status: "ambiguous" };
	try {
		const marker = nonceMarker(expectedNonce);
		const markerPattern = new RegExp(`(?:^|[\\s"'])${escapeRegExp(marker)}(?:$|[\\s"'])`, "u");
		return {
			status: "live",
			value: {
				identity: {
					pid,
					startToken: `darwin:${createHash("sha256").update(start.value).digest("hex")}`,
					...executableIdentity(executablePath, persistedExecutableIdentity),
				},
				nonceMarkerPresent: markerPattern.test(command.value),
			},
		};
	} catch {
		return { status: "ambiguous" };
	}
}

type DarwinFieldInspection =
	| { readonly status: "value"; readonly value: string }
	| { readonly status: "not_found" | "ambiguous" };

function inspectDarwinField(
	pid: number,
	field: "command" | "lstart",
	remainingTimeoutMs: () => number = () => ACTIVATION_TIMEOUT_MS,
): DarwinFieldInspection {
	const timeout = remainingTimeoutMs();
	if (timeout <= 0) return { status: "ambiguous" };
	const inspected = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", `${field}=`], {
		encoding: "utf8",
		env: externalConnectorMinimalEnvironment("darwin"),
		timeout,
		maxBuffer: 1024 * 1024,
	});
	if (inspected.status === 1 && inspected.stdout.trim().length === 0) return { status: "not_found" };
	if (inspected.status !== 0 || inspected.error !== undefined) return { status: "ambiguous" };
	const value = inspected.stdout.trim();
	return value.length === 0 ? { status: "ambiguous" } : { status: "value", value };
}

function inspectDarwinExecutable(pid: number, remainingTimeoutMs: () => number = () => ACTIVATION_TIMEOUT_MS): string | undefined {
	const timeout = remainingTimeoutMs();
	if (timeout <= 0) return undefined;
	const inspected = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
		encoding: "utf8",
		env: externalConnectorMinimalEnvironment("darwin"),
		timeout,
		maxBuffer: 1024 * 1024,
	});
	if (inspected.status !== 0 || inspected.error !== undefined) return undefined;
	for (const line of inspected.stdout.split(/\r?\n/u)) {
		if (!line.startsWith("n/")) continue;
		try {
			const path = realpathSync(line.slice(1));
			if (statSync(path).isFile()) return path;
		} catch {
			// A deleted or racing text mapping is not sufficient identity evidence.
		}
	}
	return undefined;
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

function inspectWindowsProcess(
	pid: number,
	expectedNonce: string,
	shellPath: string,
	remainingTimeoutMs: () => number = () => ACTIVATION_TIMEOUT_MS,
	persistedExecutableIdentity?: string,
): ProcessInspection {
	const timeout = remainingTimeoutMs();
	if (timeout <= 0) return { status: "ambiguous" };
	const inspected = spawnSync(
		shellPath,
		["-NoProfile", "-NonInteractive", "-Command", `& {\n${WINDOWS_PROCESS_INSPECTION_SOURCE}\n} '${pid}'`],
		{
			encoding: "utf8",
			env: externalConnectorMinimalEnvironment("win32"),
			timeout,
			windowsHide: true,
			maxBuffer: 1024 * 1024,
		},
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
		)
			return { status: "ambiguous" };
		const marker = nonceMarker(expectedNonce);
		const markerPattern = new RegExp(`(?:^|[\\s"'])${escapeRegExp(marker)}(?:$|[\\s"'])`, "u");
		return {
			status: "live",
			value: {
				identity: {
					pid,
					startToken: value.startToken,
					...executableIdentity(value.path, persistedExecutableIdentity),
				},
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

interface ProcessChannelLineWaiter {
	readonly resolve: (line: string | undefined) => void;
	readonly reject: (error: unknown) => void;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
}

/**
 * A lossless line reader over the guardian's stdout. Activation and driver
 * frames share this stream, so consuming only the first control line would
 * otherwise drop a frame emitted in the same stdout chunk.
 */
class ProductionExternalConnectorProcessChannel implements ExternalConnectorProcessChannel {
	readonly #input: ChildProcessWithoutNullStreams["stdin"];
	readonly #decoder = new StringDecoder("utf8");
	readonly #lines: string[] = [];
	#partial = "";
	#waiter: ProcessChannelLineWaiter | undefined;
	#closed = false;
	#error: Error | undefined;
	#stderrOutput = "";

	constructor(child: ChildProcessWithoutNullStreams) {
		this.#input = child.stdin;
		child.stdout.on("data", (chunk: Buffer | string) => this.#onData(chunk));
		child.stdout.once("end", () => {
			const trailing = this.#decoder.end();
			if (trailing.length > 0) this.#fail(new Error("External Connector process channel ended with a partial frame"));
			else this.#close();
		});
		child.stdout.once("error", (error) => this.#fail(error));
		child.stderr.on("data", (chunk: Buffer | string) => {
			const output = String(chunk);
			this.#stderrOutput += output;
			if (Buffer.byteLength(this.#stderrOutput, "utf8") > PROTOCOL_LIMIT_BYTES) {
				this.#fail(new Error("External Connector containment helper error output exceeded its limit"));
			}
		});
		child.stdin.once("error", (error) => this.#fail(error));
		child.once("error", (error) => this.#fail(error));
		child.once("exit", () => this.#close());
	}

	writeLine(line: string): void {
		if (this.#closed || this.#error !== undefined) throw this.#error ?? new Error("External Connector process channel is closed");
		if (
			line.includes("\r") ||
			line.includes("\n") ||
			Buffer.byteLength(line, "utf8") > PROCESS_CHANNEL_MAX_LINE_BYTES
		) {
			throw new Error("External Connector process frame is invalid or oversized");
		}
		this.#input.write(`${line}\n`);
	}

	readLine(options?: { readonly signal?: AbortSignal }): Promise<string | undefined> {
		if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift());
		if (this.#error !== undefined) return Promise.reject(this.#error);
		if (this.#closed) return Promise.resolve(undefined);
		if (this.#waiter !== undefined) throw new Error("External Connector process channel has concurrent readers");
		return new Promise<string | undefined>((resolve, reject) => {
			const onAbort = (): void => {
				if (this.#waiter?.resolve !== resolve) return;
				this.#waiter = undefined;
				reject(new Error("External Connector process channel read was aborted"));
			};
			this.#waiter = { resolve, reject, signal: options?.signal, onAbort };
			if (options?.signal?.aborted === true) onAbort();
			else options?.signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	#onData(chunk: Buffer | string): void {
		if (this.#closed || this.#error !== undefined) return;
		this.#partial += this.#decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		for (;;) {
			const newline = this.#partial.indexOf("\n");
			if (newline < 0) {
				if (Buffer.byteLength(this.#partial, "utf8") > PROCESS_CHANNEL_MAX_LINE_BYTES) {
					this.#fail(new Error("External Connector process frame exceeded its limit"));
				}
				return;
			}
			const line = this.#partial.slice(0, newline);
			this.#partial = this.#partial.slice(newline + 1);
			if (Buffer.byteLength(line, "utf8") > PROCESS_CHANNEL_MAX_LINE_BYTES) {
				this.#fail(new Error("External Connector process frame exceeded its limit"));
				return;
			}
			this.#deliver(line);
		}
	}

	#deliver(line: string): void {
		const waiter = this.#waiter;
		if (waiter === undefined) {
			this.#lines.push(line);
			return;
		}
		this.#waiter = undefined;
		if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
		}
		waiter.resolve(line);
	}

	#close(): void {
		if (this.#closed) return;
		if (this.#error === undefined && this.#stderrOutput.length > 0) {
			this.#fail(new Error("External Connector containment helper exited with an error"));
		}
		this.#closed = true;
		const waiter = this.#waiter;
		this.#waiter = undefined;
		if (waiter === undefined) return;
		if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
		}
		waiter.resolve(undefined);
	}

	#fail(error: unknown): void {
		this.#error = error instanceof Error ? error : new Error(String(error));
		const waiter = this.#waiter;
		this.#waiter = undefined;
		if (waiter === undefined) return;
		if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
		}
		waiter.reject(this.#error);
	}
}

async function waitForProtocolLine(
	channel: ExternalConnectorProcessChannel,
	expected: string,
	signal?: AbortSignal,
): Promise<void> {
	const line = await channel.readLine({ signal });
	if (line === undefined || Buffer.byteLength(line, "utf8") > PROTOCOL_LIMIT_BYTES || line.trimEnd() !== expected) {
		throw new Error("External Connector containment helper protocol was invalid");
	}
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
	readonly #boundedTerminationOperation: (
		request: ExternalConnectorProcessTerminationRequest,
		options: ExternalConnectorProcessTerminationOptions,
	) => Promise<ExternalConnectorProcessTerminationResult>;
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
		readonly forceTerminateBounded: (
			request: ExternalConnectorProcessTerminationRequest,
			options: ExternalConnectorProcessTerminationOptions,
		) => Promise<ExternalConnectorProcessTerminationResult>;
	}) {
		this.operationNonce = options.operationNonce;
		this.containment = options.containment;
		this.identity = Object.freeze({ ...options.identity });
		this.exited = options.exited;
		this.#activated = options.activated;
		this.#activateOperation = options.activate;
		this.#terminationOperation = options.forceTerminate;
		this.#boundedTerminationOperation = options.forceTerminateBounded;
	}

	async activate(options?: { readonly signal?: AbortSignal }): Promise<void> {
		if (this.#activated) return;
		if (options?.signal?.aborted === true) throw new Error("External Connector process activation was aborted");
		await this.#activateOperation();
		this.#activated = true;
	}

	forceTerminate(request: ExternalConnectorProcessTerminationRequest): ExternalConnectorProcessTerminationResult {
		return this.#terminationOperation(request);
	}

	forceTerminateBounded(
		request: ExternalConnectorProcessTerminationRequest,
		options: ExternalConnectorProcessTerminationOptions,
	): Promise<ExternalConnectorProcessTerminationResult> {
		return this.#boundedTerminationOperation(request, options);
	}
}

/** Concrete fail-closed process controller for POSIX process groups and Windows Job Objects. */
export class ProductionExternalConnectorProcessController implements ExternalConnectorProcessController {
	readonly #platform: SupportedExternalConnectorPlatform;
	readonly #environment: Readonly<Record<string, string>>;
	readonly #launchStrategy: ExternalConnectorGuardianLaunchStrategy;
	readonly #shellPath: string | undefined;
	readonly #setsidPath: string | undefined;
	readonly #process: ProductionExternalConnectorProcess;
	readonly #clock: RuntimeClock;
	readonly #channels = new Map<string, ExternalConnectorProcessChannel>();

	constructor(options: ProductionExternalConnectorProcessControllerOptions) {
		this.#platform = supportedPlatform(options.platform ?? process.platform);
		this.#clock = options.clock ?? SYSTEM_RUNTIME_CLOCK;
		this.#environment = externalConnectorMinimalEnvironment(this.#platform);
		this.#launchStrategy = externalConnectorGuardianLaunchStrategy(this.#platform);
		this.#process = options.process;
		if (this.#platform === "win32") {
			this.#shellPath = powershellPath();
			this.#setsidPath = undefined;
		} else if (this.#platform === "linux") {
			this.#shellPath = undefined;
			this.#setsidPath = this.#resolveSetsid();
		} else {
			this.#shellPath = undefined;
			this.#setsidPath = undefined;
		}
	}

	channelFor(
		reference: Pick<ExternalConnectorSupervisorReference, "supervisorRef" | "operationNonce">,
	): ExternalConnectorProcessChannel | undefined {
		return this.#channels.get(processChannelKey(reference.supervisorRef, reference.operationNonce));
	}

	async launch(
		request: ExternalConnectorProcessLaunchRequest,
		options?: { readonly signal?: AbortSignal; readonly environment?: Readonly<Record<string, string>> },
	): Promise<ExternalConnectorProcessHandle> {
		this.#validateRequest(request);
		const gatewayEnvironment = options?.environment ?? {};
		if (Object.entries(gatewayEnvironment).some(([key, value]) =>
			!GATEWAY_ENVIRONMENT_KEYS.has(key) || value.length === 0 || value.length > 4096 || value.includes("\0"))) {
			throw new Error("External Connector gateway process environment is invalid");
		}
		const processSpec = encodeProcessSpec(this.#process, { ...this.#environment, ...gatewayEnvironment });
		if (options?.signal?.aborted === true) throw new Error("External Connector process launch was aborted");
		const marker = nonceMarker(request.operationNonce);
		const child = this.#spawnGuardian(marker);
		const channel = new ProductionExternalConnectorProcessChannel(child);
		const channelKey = processChannelKey(request.supervisorRef, request.operationNonce);
		this.#channels.set(channelKey, channel);
		try {
			await waitForProtocolLine(channel, `READY ${marker}`, options?.signal);
			const inspection = this.#inspect(child.pid!, request.operationNonce);
			if (inspection.status !== "live" || !inspection.value.nonceMarkerPresent) {
				throw new Error("External Connector containment helper identity was ambiguous");
			}
			const identity = inspection.value.identity;
			const exited = this.#monitorContainmentExit(identity.pid);
			void exited.finally(() => {
				if (this.#channels.get(channelKey) === channel) this.#channels.delete(channelKey);
			});
			return new ProductionExternalConnectorProcessHandle({
				operationNonce: request.operationNonce,
				containment: request.containment,
				identity,
				exited,
				activated: false,
				activate: async () => {
					const active = waitForProtocolLine(channel, `ACTIVE ${marker}`, options?.signal);
					channel.writeLine(`ACTIVATE ${marker} ${processSpec}`);
					await active;
				},
				forceTerminate: (termination) => this.#forceTerminate(identity, request.operationNonce, termination),
				forceTerminateBounded: (termination, terminationOptions) =>
					this.#forceTerminateBounded(identity, request.operationNonce, termination, terminationOptions),
			});
		} catch (error) {
			this.#channels.delete(channelKey);
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
		if (inspection.status === "not_found" && this.#platform !== "win32") {
			const groupStatus = this.#inspectProcessGroup(identity.pid);
			return { status: groupStatus === "not_found" ? "not_found" : "ambiguous" };
		} else if (inspection.status !== "live") {
			return { status: inspection.status };
		} else if (!inspection.value.nonceMarkerPresent || !sameIdentity(inspection.value.identity, identity)) {
			return { status: "identity_mismatch" };
		}
		return {
			status: "attached",
			handle: new ProductionExternalConnectorProcessHandle({
				operationNonce: request.operationNonce,
				containment: request.containment,
				identity,
				exited: this.#monitorContainmentExit(identity.pid),
				activated: true,
				activate: () => Promise.resolve(),
				forceTerminate: (termination) => this.#forceTerminate(identity, request.operationNonce, termination),
				forceTerminateBounded: (termination, terminationOptions) =>
					this.#forceTerminateBounded(identity, request.operationNonce, termination, terminationOptions),
			}),
		};
	}

	async #forceTerminateBounded(
		boundIdentity: ExternalConnectorProcessIdentity,
		boundNonce: string,
		request: ExternalConnectorProcessTerminationRequest,
		options: ExternalConnectorProcessTerminationOptions,
	): Promise<ExternalConnectorProcessTerminationResult> {
		if (
			typeof options.deadlineMs !== "number" ||
			!Number.isSafeInteger(options.deadlineMs) ||
			options.deadlineMs <= 0 ||
			options.signal?.aborted === true
		) {
			return "ambiguous";
		}
		const deadlineAt = this.#clock.monotonicNow() + options.deadlineMs;
		const result = this.#forceTerminate(boundIdentity, boundNonce, request, deadlineAt);
		return Boolean(options.signal?.aborted) || this.#clock.monotonicNow() >= deadlineAt ? "ambiguous" : result;
	}

	#forceTerminate(
		boundIdentity: ExternalConnectorProcessIdentity,
		boundNonce: string,
		request: ExternalConnectorProcessTerminationRequest,
		deadlineAt?: number,
	): ExternalConnectorProcessTerminationResult {
		if (request.operationNonce !== boundNonce || !sameIdentity(request.processIdentity, boundIdentity))
			return "identity_mismatch";
		if (deadlineAt !== undefined && this.#remainingHelperMs(deadlineAt) <= 0) return "ambiguous";
		const inspection = this.#inspect(boundIdentity.pid, boundNonce, deadlineAt, boundIdentity.executableIdentity);
		if (inspection.status === "not_found" && this.#platform !== "win32") {
			if (deadlineAt !== undefined && this.#remainingHelperMs(deadlineAt) <= 0) return "ambiguous";
			const groupStatus = this.#inspectProcessGroup(boundIdentity.pid);
			if (deadlineAt !== undefined && this.#remainingHelperMs(deadlineAt) <= 0) return "ambiguous";
			if (groupStatus === "not_found") return "already_exited";
			if (groupStatus === "ambiguous" || groupStatus === "live") return "ambiguous";
		} else if (inspection.status !== "live") {
			if (inspection.status === "not_found") return "already_exited";
			return "ambiguous";
		}
		if (
			inspection.status === "live" &&
			(!inspection.value.nonceMarkerPresent || !sameIdentity(inspection.value.identity, boundIdentity))
		) {
			return "identity_mismatch";
		}
		try {
			if (deadlineAt !== undefined && this.#remainingHelperMs(deadlineAt) <= 0) return "ambiguous";
			if (this.#platform === "linux" || this.#platform === "darwin") process.kill(-boundIdentity.pid, "SIGKILL");
			else process.kill(boundIdentity.pid, "SIGKILL");
			return deadlineAt !== undefined && this.#remainingHelperMs(deadlineAt) <= 0
				? "ambiguous"
				: "termination_requested";
		} catch (error) {
			return isMissingProcessError(error) ? "already_exited" : "ambiguous";
		}
	}

	#spawnGuardian(marker: string): ChildProcessWithoutNullStreams {
		if (this.#platform === "linux") {
			return spawn(this.#setsidPath!, [process.execPath, "-e", POSIX_GUARDIAN_SOURCE, marker], {
				detached: this.#launchStrategy.guardianDetached,
				env: this.#environment,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		}
		if (this.#platform === "darwin") {
			return spawn(process.execPath, ["-e", POSIX_GUARDIAN_SOURCE, marker], {
				detached: this.#launchStrategy.guardianDetached,
				env: this.#environment,
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
			{
				detached: this.#launchStrategy.guardianDetached,
				env: this.#environment,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			},
		);
	}

	#inspect(
		pid: number,
		nonce: string,
		deadlineAt?: number,
		persistedExecutableIdentity?: string,
	): ProcessInspection {
		if (this.#platform === "linux") {
			return inspectLinuxProcess(
				pid,
				nonce,
				deadlineAt === undefined ? undefined : () => this.#remainingHelperMs(deadlineAt) > 0,
				persistedExecutableIdentity,
			);
		}
		const timeoutMs = deadlineAt === undefined ? ACTIVATION_TIMEOUT_MS : this.#remainingHelperMs(deadlineAt);
		if (timeoutMs <= 0) return { status: "ambiguous" };
		const remainingTimeoutMs =
			deadlineAt === undefined ? () => ACTIVATION_TIMEOUT_MS : () => this.#remainingHelperMs(deadlineAt);
		if (this.#platform === "darwin") {
			return inspectDarwinProcess(pid, nonce, remainingTimeoutMs, persistedExecutableIdentity);
		}
		return inspectWindowsProcess(pid, nonce, this.#shellPath!, remainingTimeoutMs, persistedExecutableIdentity);
	}

	#remainingHelperMs(deadlineAt: number): number {
		const remaining = deadlineAt - this.#clock.monotonicNow();
		return remaining < 1 ? 0 : Math.min(ACTIVATION_TIMEOUT_MS, Math.floor(remaining));
	}

	#monitorContainmentExit(pid: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setInterval(() => {
				const status = this.#platform === "win32" ? this.#inspectProcessPresence(pid) : this.#inspectProcessGroup(pid);
				if (status === "not_found") {
					clearInterval(timer);
					resolve();
				}
			}, 250);
			timer.unref();
		});
	}

	#inspectProcessPresence(pid: number): "live" | "not_found" | "ambiguous" {
		try {
			process.kill(pid, 0);
			return "live";
		} catch (error) {
			if (isMissingProcessError(error)) return "not_found";
			return "ambiguous";
		}
	}

	#inspectProcessGroup(processGroupId: number): "live" | "not_found" | "ambiguous" {
		try {
			process.kill(-processGroupId, 0);
			return "live";
		} catch (error) {
			if (isMissingProcessError(error)) return "not_found";
			if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") return "live";
			return "ambiguous";
		}
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
		)
			throw new TypeError("External Connector process launch request is invalid");
	}
}

function powerShellLiteral(value: string): string {
	return value.replaceAll("'", "''");
}

function encodeProcessSpec(
	value: ProductionExternalConnectorProcess,
	environment: Readonly<Record<string, string>>,
): string {
	if (
		typeof value?.executablePath !== "string" ||
		!isAbsolute(value.executablePath) ||
		value.executablePath.includes("\0") ||
		(value.arguments !== undefined &&
			(!Array.isArray(value.arguments) ||
				value.arguments.length > 256 ||
				value.arguments.some(
					(argument) =>
						typeof argument !== "string" ||
						argument.includes("\0") ||
						Buffer.byteLength(argument, "utf8") > 64 * 1024,
				)))
	)
		throw new TypeError("External Connector companion process is invalid");
	const executablePath = realpathSync(value.executablePath);
	if (!statSync(executablePath).isFile()) {
		throw new TypeError("External Connector companion executable is not a file");
	}
	const provenance = resolveProductionExternalConnectorDriverProvenance(value);
	const serialized = JSON.stringify({
		executablePath,
		arguments: value.arguments === undefined ? [] : [...value.arguments],
		cwd: provenance?.cwd ?? process.cwd(),
		environment,
	});
	if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
		throw new TypeError("External Connector companion process specification is too large");
	}
	return Buffer.from(serialized, "utf8").toString("base64");
}
