import {
	createContextSnapshot,
	FoundationError,
	Result,
	type ContextSnapshot,
	type Result as ResultValue,
	type ChildSpawnRequestV1,
} from "@aos-agent/agent-core";
import {
	forkChildContextV1,
	type ChildContextForkResultV1,
} from "./subagent-context-fork.ts";

export interface LoadParentContextInputV1 {
	readonly schemaVersion: 1;
	readonly spawnId: string;
	readonly parentAttemptId: string;
	readonly parentAgentInstanceId: string;
}

export type LoadParentContextV1 = (
	input: LoadParentContextInputV1,
) => Promise<ResultValue<ContextSnapshot, FoundationError>>;

export interface ProjectProviderChildContextInputV1 {
	readonly schemaVersion: 1;
	readonly request: ChildSpawnRequestV1;
	readonly childBindingEpochId: string;
	readonly loadParentContext: LoadParentContextV1;
}

function isolatedParentSnapshot(input: ProjectProviderChildContextInputV1): ContextSnapshot {
	const tokenBudget = input.request.taskEnvelope.budget.tokens ?? 1000;
	return createContextSnapshot([], {
		bindingEpochId: input.childBindingEpochId,
		forkMode: "none",
		trust: "builtin",
		budget: { maxTokens: tokenBudget },
	});
}

/**
 * Resolve the provider-visible Child Context projection.
 *
 * `all` and `recent_n` must load a live immutable parent snapshot. The modes
 * that intentionally inherit no parent conversation never call that authority.
 */
export async function projectProviderChildContextV1(
	input: ProjectProviderChildContextInputV1,
): Promise<ResultValue<ChildContextForkResultV1, FoundationError>> {
	const tokenBudget = input.request.taskEnvelope.budget.tokens ?? 1000;
	let parentSnapshot: ContextSnapshot;
	if (input.request.forkScope === "all" || input.request.forkScope === "recent_n") {
		if (input.request.parentAttemptId === undefined || input.request.parentAgentInstanceId === undefined) {
			return Result.err(new FoundationError("subagent_context_fork_invalid", "Parent Context identity is required for inherited context"));
		}
		const loaded = await input.loadParentContext({
			schemaVersion: 1,
			spawnId: input.request.spawnId,
			parentAttemptId: input.request.parentAttemptId,
			parentAgentInstanceId: input.request.parentAgentInstanceId,
		});
		if (!loaded.ok) return loaded;
		if (typeof loaded.value.entries !== "function" || typeof loaded.value.toJSON !== "function") {
			return Result.err(new FoundationError("subagent_context_fork_invalid", "Parent Context authority did not return a live snapshot"));
		}
		parentSnapshot = loaded.value;
	} else {
		parentSnapshot = isolatedParentSnapshot(input);
	}

	return forkChildContextV1({
		schemaVersion: 1,
		spawnId: input.request.spawnId,
		forkScope: input.request.forkScope,
		parentSnapshot,
		childRoleRevision: input.request.roleRevision,
		childTaskEnvelope: input.request.taskEnvelope,
		childBindingEpochId: input.childBindingEpochId,
		childTokenBudget: tokenBudget,
		...(input.request.recentN === undefined ? {} : { recentN: input.request.recentN }),
		...(input.request.taskPackageRef === undefined ? {} : { taskPackageRef: input.request.taskPackageRef }),
	});
}
