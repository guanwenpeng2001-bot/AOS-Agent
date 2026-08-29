import { FoundationError } from "../../../../agent/src/harness/foundation/errors.ts";
import type {
	ChildAgentProvider,
	ExecutionProviderDescriptor,
	TaskExecutorProvider,
} from "../../../../agent/src/harness/foundation/providers.ts";
import { SUBAGENT_PROVIDER_KINDS, type SubagentProviderKind } from "./lifecycle.ts";

export type { SubagentProviderKind } from "./lifecycle.ts";

export interface SubagentProviderDescriptor {
	readonly schemaVersion: 1;
	readonly providerKind: SubagentProviderKind;
	readonly descriptor: Readonly<ExecutionProviderDescriptor>;
	readonly revision: number;
	readonly capabilities: {
		readonly resumeSupported: boolean;
		readonly mailboxSupported: boolean;
		readonly backgroundSupported: boolean;
		readonly worktreeSupported: boolean;
		readonly maxDepth: number;
	};
	readonly implementedInThisLine: boolean;
}

export interface SubagentCapabilityRequirements {
	readonly providerKind?: SubagentProviderKind;
	readonly forkScope?: "none" | "all" | "recent_n" | "task_package";
	readonly mailboxRequired?: boolean;
	readonly resumeRequired?: boolean;
	readonly worktreeRequired?: boolean;
	readonly backgroundRequired?: boolean;
	readonly maxDepthRequired?: number;
}

export type ExecutableSubagentProvider = ChildAgentProvider & TaskExecutorProvider;

interface BoundExecutableSubagentProviderV1 {
	readonly revision: number;
	readonly provider: ExecutableSubagentProvider;
}

export class SubagentProviderRegistry {
	private readonly descriptors = new Map<string, SubagentProviderDescriptor[]>();
	private readonly executableProviders = new Map<string, BoundExecutableSubagentProviderV1>();

	register(descriptor: SubagentProviderDescriptor): void {
		if (
			!descriptor ||
			typeof descriptor !== "object" ||
			descriptor.schemaVersion !== 1 ||
			!SUBAGENT_PROVIDER_KINDS.includes(descriptor.providerKind) ||
			typeof descriptor.revision !== "number" ||
			!Number.isSafeInteger(descriptor.revision) ||
			descriptor.revision <= 0 ||
			!descriptor.descriptor ||
			typeof descriptor.descriptor !== "object" ||
			descriptor.descriptor.schemaVersion !== 1 ||
			descriptor.descriptor.providerClass !== "agent" ||
			typeof descriptor.descriptor.providerId !== "string" ||
			!descriptor.capabilities ||
			typeof descriptor.capabilities !== "object" ||
			typeof descriptor.capabilities.resumeSupported !== "boolean" ||
			typeof descriptor.capabilities.mailboxSupported !== "boolean" ||
			typeof descriptor.capabilities.backgroundSupported !== "boolean" ||
			typeof descriptor.capabilities.worktreeSupported !== "boolean" ||
			typeof descriptor.capabilities.maxDepth !== "number" ||
			!Number.isSafeInteger(descriptor.capabilities.maxDepth) ||
			descriptor.capabilities.maxDepth <= 0 ||
			typeof descriptor.implementedInThisLine !== "boolean"
		) {
			throw new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor shape with positive revision and maxDepth and providerClass 'agent'.",
			);
		}

		if (
			descriptor.implementedInThisLine &&
			descriptor.providerKind !== "in_process" &&
			descriptor.providerKind !== "fork"
		) {
			throw new FoundationError(
				"subagent_spawn_invalid",
				"Only in_process and fork can be implemented in this line.",
			);
		}

		const topKeys = Object.keys(descriptor);
		if (
			topKeys.length !== 6 ||
			!topKeys.every((k) =>
				[
					"schemaVersion",
					"providerKind",
					"descriptor",
					"revision",
					"capabilities",
					"implementedInThisLine",
				].includes(k),
			)
		) {
			throw new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor shape with no extra keys.",
			);
		}

		const descKeys = Object.keys(descriptor.descriptor);
		if (
			descKeys.length !== 3 ||
			!descKeys.every((k) => ["schemaVersion", "providerId", "providerClass"].includes(k))
		) {
			throw new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor.descriptor shape with no extra keys.",
			);
		}

		const capKeys = Object.keys(descriptor.capabilities);
		if (
			capKeys.length !== 5 ||
			!capKeys.every((k) =>
				["resumeSupported", "mailboxSupported", "backgroundSupported", "worktreeSupported", "maxDepth"].includes(k),
			)
		) {
			throw new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor.capabilities shape with no extra keys.",
			);
		}

		const list = this.descriptors.get(descriptor.descriptor.providerId) || [];
		if (list.length > 0) {
			const existing = list[list.length - 1]!;
			if (existing.providerKind !== descriptor.providerKind) {
				throw new FoundationError(
					"subagent_spawn_invalid",
					`Provider ${descriptor.descriptor.providerId} exists with different kind ${existing.providerKind}.`,
				);
			}
			if (descriptor.revision <= existing.revision) {
				throw new FoundationError(
					"subagent_spawn_invalid",
					`Provider ${descriptor.descriptor.providerId} revision ${descriptor.revision} must be greater than existing revision ${existing.revision}.`,
				);
			}
		}

		for (const [id, entries] of this.descriptors.entries()) {
			if (id !== descriptor.descriptor.providerId && entries[0]!.providerKind === descriptor.providerKind) {
				throw new FoundationError(
					"subagent_spawn_invalid",
					`Provider kind ${descriptor.providerKind} is already registered under ${id}. Registry requires unique kind.`,
				);
			}
		}

		list.push(
			Object.freeze({
				...descriptor,
				descriptor: Object.freeze({ ...descriptor.descriptor }),
				capabilities: Object.freeze({ ...descriptor.capabilities }),
			}),
		);
		this.descriptors.set(descriptor.descriptor.providerId, list);
	}

	/** Bind one implemented descriptor revision to its exact trusted runtime object. */
	bindExecutable(provider: ExecutableSubagentProvider, revision?: number): void {
		const descriptor = this.get(provider.providerId, revision);
		if (
			!descriptor.implementedInThisLine ||
			descriptor.descriptor.providerClass !== "agent" ||
			provider.providerClass !== "agent" ||
			provider.providerId !== descriptor.descriptor.providerId ||
			typeof provider.spawn !== "function" ||
			typeof provider.resume !== "function" ||
			typeof provider.cancel !== "function" ||
			typeof provider.createAttempt !== "function" ||
			typeof provider.runAttempt !== "function" ||
			typeof provider.cancelAttempt !== "function"
		) {
			throw new FoundationError(
				"subagent_provider_unavailable",
				`Provider ${provider.providerId} is not an executable Native Subagent runtime.`,
			);
		}
		const existing = this.executableProviders.get(provider.providerId);
		if (
			existing !== undefined &&
			(descriptor.revision < existing.revision ||
				(descriptor.revision === existing.revision && existing.provider !== provider))
		) {
			throw new FoundationError(
				"subagent_conflict",
				`Provider ${provider.providerId} is already bound to a different runtime identity.`,
			);
		}
		this.executableProviders.set(
			provider.providerId,
			Object.freeze({ revision: descriptor.revision, provider }),
		);
	}

	/** Resolve only the exact runtime object bound to the current descriptor revision. */
	resolveExecutable(provider: TaskExecutorProvider): ExecutableSubagentProvider {
		const descriptor = this.resolve(provider.providerId);
		const executable = this.executableProviders.get(provider.providerId);
		if (
			executable === undefined ||
			executable.revision !== descriptor.revision ||
			executable.provider !== provider ||
			provider.providerClass !== "agent"
		) {
			throw new FoundationError(
				"subagent_provider_unavailable",
				`Provider ${provider.providerId} is not the trusted current Native Subagent runtime.`,
			);
		}
		return executable.provider;
	}

	get(providerId: string, revision?: number): SubagentProviderDescriptor {
		if (
			revision !== undefined &&
			(typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0)
		) {
			throw new FoundationError("subagent_spawn_invalid", `Invalid revision: ${revision}`);
		}
		const list = this.descriptors.get(providerId);
		if (!list || list.length === 0) {
			throw new FoundationError("subagent_provider_unavailable", `Provider ${providerId} not found.`);
		}
		if (revision !== undefined) {
			const entry = list.find((d) => d.revision === revision);
			if (!entry) {
				throw new FoundationError(
					"subagent_provider_unavailable",
					`Provider ${providerId} revision ${revision} not found.`,
				);
			}
			return entry;
		}
		return list[list.length - 1]!;
	}

	resolve(
		providerId: string,
		requirements: SubagentCapabilityRequirements = {},
		revision?: number,
	): SubagentProviderDescriptor {
		if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) {
			throw new FoundationError("subagent_spawn_invalid", "Requirements must be an object.");
		}

		const allowedReqKeys = [
			"providerKind",
			"forkScope",
			"mailboxRequired",
			"resumeRequired",
			"worktreeRequired",
			"backgroundRequired",
			"maxDepthRequired",
		];
		const reqKeys = Object.keys(requirements);
		if (!reqKeys.every((k) => allowedReqKeys.includes(k))) {
			throw new FoundationError("subagent_spawn_invalid", "Requirements must have exact shape with no extra keys.");
		}

		if (
			requirements.providerKind !== undefined &&
			!SUBAGENT_PROVIDER_KINDS.includes(requirements.providerKind)
		) {
			throw new FoundationError("subagent_spawn_invalid", `Invalid providerKind: ${requirements.providerKind}`);
		}
		if (
			requirements.forkScope !== undefined &&
			!["none", "all", "recent_n", "task_package"].includes(requirements.forkScope)
		) {
			throw new FoundationError("subagent_spawn_invalid", `Invalid forkScope: ${requirements.forkScope}`);
		}
		if (requirements.mailboxRequired !== undefined && typeof requirements.mailboxRequired !== "boolean") {
			throw new FoundationError("subagent_spawn_invalid", "mailboxRequired must be boolean.");
		}
		if (requirements.resumeRequired !== undefined && typeof requirements.resumeRequired !== "boolean") {
			throw new FoundationError("subagent_spawn_invalid", "resumeRequired must be boolean.");
		}
		if (requirements.worktreeRequired !== undefined && typeof requirements.worktreeRequired !== "boolean") {
			throw new FoundationError("subagent_spawn_invalid", "worktreeRequired must be boolean.");
		}
		if (requirements.backgroundRequired !== undefined && typeof requirements.backgroundRequired !== "boolean") {
			throw new FoundationError("subagent_spawn_invalid", "backgroundRequired must be boolean.");
		}
		if (
			requirements.maxDepthRequired !== undefined &&
			(typeof requirements.maxDepthRequired !== "number" ||
				!Number.isSafeInteger(requirements.maxDepthRequired) ||
				requirements.maxDepthRequired <= 0)
		) {
			throw new FoundationError(
				"subagent_spawn_invalid",
				`Invalid maxDepthRequired: ${requirements.maxDepthRequired}`,
			);
		}

		const entry = this.get(providerId, revision);

		if (!entry.implementedInThisLine) {
			throw new FoundationError(
				"subagent_provider_unavailable",
				`Provider ${providerId} is not implemented in this line.`,
			);
		}

		if (requirements.providerKind !== undefined && entry.providerKind !== requirements.providerKind) {
			throw new FoundationError(
				"subagent_capability_unsupported",
				`Provider ${providerId} is not of kind ${requirements.providerKind}.`,
			);
		}
		if (requirements.resumeRequired && !entry.capabilities.resumeSupported) {
			throw new FoundationError(
				"subagent_capability_unsupported",
				`Provider ${providerId} does not support resume.`,
			);
		}
		if (requirements.mailboxRequired && !entry.capabilities.mailboxSupported) {
			throw new FoundationError(
				"subagent_capability_unsupported",
				`Provider ${providerId} does not support mailbox.`,
			);
		}
		if (requirements.worktreeRequired && !entry.capabilities.worktreeSupported) {
			throw new FoundationError(
				"subagent_capability_unsupported",
				`Provider ${providerId} does not support worktree isolation.`,
			);
		}
		if (requirements.backgroundRequired && !entry.capabilities.backgroundSupported) {
			throw new FoundationError(
				"subagent_capability_unsupported",
				`Provider ${providerId} does not support background.`,
			);
		}
		if (requirements.maxDepthRequired !== undefined && entry.capabilities.maxDepth < requirements.maxDepthRequired) {
			throw new FoundationError(
				"subagent_capability_unsupported",
				`Provider ${providerId} maxDepth is ${entry.capabilities.maxDepth}, required ${requirements.maxDepthRequired}.`,
			);
		}

		return entry;
	}
}

export const IN_PROCESS_PROVIDER: SubagentProviderDescriptor = Object.freeze({
	schemaVersion: 1 as const,
	providerKind: "in_process" as const,
	descriptor: Object.freeze({
		schemaVersion: 1 as const,
		providerId: "native.in_process",
		providerClass: "agent" as const,
	}),
	revision: 1,
	capabilities: Object.freeze({
		resumeSupported: true,
		mailboxSupported: true,
		backgroundSupported: true,
		worktreeSupported: true,
		maxDepth: 10,
	}),
	implementedInThisLine: true,
});

export const FORK_PROVIDER: SubagentProviderDescriptor = Object.freeze({
	schemaVersion: 1 as const,
	providerKind: "fork" as const,
	descriptor: Object.freeze({ schemaVersion: 1 as const, providerId: "native.fork", providerClass: "agent" as const }),
	revision: 1,
	capabilities: Object.freeze({
		resumeSupported: true,
		mailboxSupported: true,
		backgroundSupported: true,
		worktreeSupported: true,
		maxDepth: 10,
	}),
	implementedInThisLine: true,
});

export const AGENT_RUNTIME_HOST_PROVIDER: SubagentProviderDescriptor = Object.freeze({
	schemaVersion: 1 as const,
	providerKind: "agent_runtime_host" as const,
	descriptor: Object.freeze({
		schemaVersion: 1 as const,
		providerId: "remote.agent_runtime_host",
		providerClass: "agent" as const,
	}),
	revision: 1,
	capabilities: Object.freeze({
		resumeSupported: true,
		mailboxSupported: true,
		backgroundSupported: true,
		worktreeSupported: true,
		maxDepth: 10,
	}),
	implementedInThisLine: false,
});
