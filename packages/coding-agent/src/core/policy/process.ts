import { PolicyError, type ExecutionPolicyProfile } from "./execution.ts";

export interface ProcessPolicyEnvironment {
	readonly env: NodeJS.ProcessEnv;
	readonly names: ReadonlyArray<string>;
}

function ownEnvironmentNames(env: NodeJS.ProcessEnv): string[] {
	return Object.keys(env).filter((name) => env[name] !== undefined).sort();
}

export function createExplicitProcessEnvironment(
	profile: ExecutionPolicyProfile,
	env: NodeJS.ProcessEnv | undefined,
): ProcessPolicyEnvironment {
	const source = env ?? {};
	if (profile.enforcement === "legacy" || profile.process.inheritEnvironment) {
		return { env: { ...source }, names: ownEnvironmentNames(source) };
	}
	const allowed = new Set(profile.process.allowEnvironment);
	const filtered: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (!allowed.has(name)) continue;
		filtered[name] = value;
	}
	return { env: filtered, names: ownEnvironmentNames(filtered) };
}

export function assertProcessEnvironmentAllowed(
	profile: ExecutionPolicyProfile,
	environmentNames: ReadonlyArray<string>,
): void {
	if (profile.enforcement === "legacy" || profile.process.inheritEnvironment) return;
	const allowed = new Set(profile.process.allowEnvironment);
	if (environmentNames.some((name) => !allowed.has(name))) {
		throw new PolicyError("policy_denied", "Process environment is not allowed by execution policy.");
	}
}

export function assertProcessTimeoutAllowed(profile: ExecutionPolicyProfile, timeout: number | undefined): void {
	if (profile.enforcement === "legacy") return;
	if (profile.process.timeoutMs === undefined) return;
	if (timeout === undefined) return;
	if (timeout * 1000 > profile.process.timeoutMs) {
		throw new PolicyError("policy_denied", "Process timeout exceeds execution policy.");
	}
}
