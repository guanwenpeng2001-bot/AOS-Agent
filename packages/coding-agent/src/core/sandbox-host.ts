import {
	PolicyError,
	authorizePolicyOperation,
	type ExecutionPolicyProfile,
	type PolicyBinding,
	type PolicyDecision,
	type PolicyOperationSource,
	type PolicyResource,
} from "./execution-policy.ts";
import {
	type FilesystemAccessKind,
	type HostFilesystemRoots,
	resolveHostPathForPolicy,
} from "./policy-filesystem.ts";
import {
	assertProcessEnvironmentAllowed,
	assertProcessTimeoutAllowed,
	createExplicitProcessEnvironment,
} from "./policy-process.ts";
import type { SandboxHandle } from "./sandbox.ts";

export interface BuiltinToolPolicyHooks {
	onDecision?: (decision: PolicyDecision) => void;
}

export interface BuiltinToolPolicy {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly roots: HostFilesystemRoots;
	readonly source?: PolicyOperationSource;
	readonly sandbox?: SandboxHandle;
	authorizeFilesystem(input: {
		readonly resource: "filesystem.read" | "filesystem.write" | "filesystem.find" | "filesystem.grep";
		readonly requestedPath: string;
		readonly access: FilesystemAccessKind;
		readonly requestId?: string;
	}): Promise<{ readonly absolutePath: string; readonly realPath: string; readonly sandbox?: SandboxHandle }>;
	authorizeProcess(input: {
		readonly command: string;
		readonly args?: ReadonlyArray<string>;
		readonly cwd: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly timeout?: number;
		readonly requestId?: string;
	}): Promise<{ readonly env: NodeJS.ProcessEnv; readonly sandbox?: SandboxHandle }>;
	authorizeRaw(input: {
		readonly resource: PolicyResource;
		readonly requestId?: string;
		readonly path?: string;
		readonly targetPath?: string;
		readonly command?: string;
		readonly args?: ReadonlyArray<string>;
		readonly cwd?: string;
		readonly environmentNames?: ReadonlyArray<string>;
	}): PolicyDecision;
}

export interface BuiltinToolPolicyOptions {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly roots: HostFilesystemRoots;
	readonly source?: PolicyOperationSource;
	readonly sandbox?: SandboxHandle;
	readonly approvedRequestIds?: ReadonlyArray<string>;
	readonly rejectedRequestIds?: ReadonlyArray<string>;
	readonly hooks?: BuiltinToolPolicyHooks;
}

function assertAllowedDecision(
	decision: PolicyDecision,
	approvedRequestIds: ReadonlySet<string>,
	rejectedRequestIds: ReadonlySet<string>,
): void {
	if (decision.outcome === "allow") return;
	if (decision.outcome === "ask" && decision.requestId !== undefined) {
		if (rejectedRequestIds.has(decision.requestId)) {
			throw new PolicyError("policy_denied", "The operation was rejected by execution policy approval.");
		}
		if (approvedRequestIds.has(decision.requestId)) {
			return;
		}
	}
	throw new PolicyError(decision.reasonCode ?? "policy_denied", decision.reason);
}

function assertSandboxForStrictProcess(policy: {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly sandbox?: SandboxHandle;
}): SandboxHandle | undefined {
	if (policy.profile.enforcement !== "sandbox") return undefined;
	const sandbox = policy.sandbox;
	if (sandbox === undefined || sandbox.id.length === 0) throw new PolicyError("sandbox_required");
	if (sandbox.bindingId !== undefined && sandbox.bindingId !== policy.binding.id) throw new PolicyError("sandbox_unavailable");
	if (sandbox.providerId !== undefined && sandbox.providerId !== policy.binding.sandboxProviderId) throw new PolicyError("sandbox_unavailable");
	if (sandbox.status !== undefined && sandbox.status !== "ready") throw new PolicyError("sandbox_unavailable");
	if (!sandbox.capabilities.process || !sandbox.capabilities.credentialIsolation) {
		throw new PolicyError("sandbox_capability_insufficient");
	}
	if (policy.binding.sandboxStatus !== "ready") throw new PolicyError("sandbox_unavailable");
	return sandbox;
}

function assertSandboxForStrictFilesystem(policy: {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly sandbox?: SandboxHandle;
}): SandboxHandle | undefined {
	if (policy.profile.enforcement !== "sandbox") return undefined;
	const sandbox = policy.sandbox;
	if (sandbox === undefined || sandbox.id.length === 0) throw new PolicyError("sandbox_required");
	if (sandbox.bindingId !== undefined && sandbox.bindingId !== policy.binding.id) throw new PolicyError("sandbox_unavailable");
	if (sandbox.providerId !== undefined && sandbox.providerId !== policy.binding.sandboxProviderId) throw new PolicyError("sandbox_unavailable");
	if (sandbox.status !== undefined && sandbox.status !== "ready") throw new PolicyError("sandbox_unavailable");
	if (!sandbox.capabilities.filesystem) {
		throw new PolicyError("sandbox_capability_insufficient");
	}
	if (policy.binding.sandboxStatus !== "ready") throw new PolicyError("sandbox_unavailable");
	return sandbox;
}

export function createBuiltinToolPolicy(options: BuiltinToolPolicyOptions): BuiltinToolPolicy {
	const source = options.source ?? "builtin";
	const approvedRequestIds = new Set(options.approvedRequestIds ?? []);
	const rejectedRequestIds = new Set(options.rejectedRequestIds ?? []);
	const authorizeRaw = (input: {
		readonly resource: PolicyResource;
		readonly requestId?: string;
		readonly path?: string;
		readonly targetPath?: string;
		readonly command?: string;
		readonly args?: ReadonlyArray<string>;
		readonly cwd?: string;
		readonly environmentNames?: ReadonlyArray<string>;
	}) => {
		const decision = authorizePolicyOperation({
			profile: options.profile,
			binding: options.binding,
			operation: {
				resource: input.resource,
				source,
				...(input.requestId === undefined ? {} : { id: input.requestId }),
				...(input.path === undefined ? {} : { path: input.path }),
				...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
				...(input.command === undefined ? {} : { command: input.command }),
				...(input.args === undefined ? {} : { args: input.args }),
				...(input.cwd === undefined ? {} : { cwd: input.cwd }),
				...(input.environmentNames === undefined ? {} : { environmentNames: input.environmentNames }),
			},
		});
		options.hooks?.onDecision?.(decision);
		assertAllowedDecision(decision, approvedRequestIds, rejectedRequestIds);
		return decision;
	};
	return {
		profile: options.profile,
		binding: options.binding,
		roots: options.roots,
		source,
		...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
		authorizeRaw,
		async authorizeFilesystem(input) {
			const resolved = await resolveHostPathForPolicy({
				cwd: options.roots.workspace,
				targetPath: input.requestedPath,
				roots: options.roots,
				access: input.access,
			});
			const sandbox = assertSandboxForStrictFilesystem(options);
			const decision = authorizePolicyOperation({
				profile: options.profile,
				binding: options.binding,
				operation: {
					resource: input.resource,
					source,
					scope: resolved.scope,
					...(input.requestId === undefined ? {} : { id: input.requestId }),
					path: resolved.realPath,
				},
			});
			options.hooks?.onDecision?.(decision);
			assertAllowedDecision(decision, approvedRequestIds, rejectedRequestIds);
			return { absolutePath: resolved.absolutePath, realPath: resolved.realPath, ...(sandbox === undefined ? {} : { sandbox }) };
		},
		async authorizeProcess(input) {
			const cwdResolution = await resolveHostPathForPolicy({
				cwd: options.roots.workspace,
				targetPath: input.cwd,
				roots: options.roots,
				access: "read",
			});
			const environment = createExplicitProcessEnvironment(options.profile, input.env);
			assertProcessEnvironmentAllowed(options.profile, environment.names);
			assertProcessTimeoutAllowed(options.profile, input.timeout);
			const sandbox = assertSandboxForStrictProcess(options);
			const decision = authorizePolicyOperation({
				profile: options.profile,
				binding: options.binding,
				operation: {
					resource: "process.spawn",
					source: source === "builtin" ? "user_bash" : source,
					...(input.requestId === undefined ? {} : { id: input.requestId }),
					scope: cwdResolution.scope,
					command: input.command,
					...(input.args === undefined ? {} : { args: input.args }),
					cwd: cwdResolution.realPath,
					environmentNames: environment.names,
				},
			});
			options.hooks?.onDecision?.(decision);
			assertAllowedDecision(decision, approvedRequestIds, rejectedRequestIds);
			return { env: environment.env, ...(sandbox === undefined ? {} : { sandbox }) };
		},
	};
}
