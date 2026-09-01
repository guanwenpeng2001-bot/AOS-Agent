import type {
	RunGetData,
	SubagentListData,
	TaskGraphListData,
	WorkerListData,
} from "../rpc/rpc-types.ts";
import type { WebReadOnlyRpcClient } from "./read-only-rpc.ts";

export interface TaskGraphBoardData {
	readonly graphs: TaskGraphListData["graphs"];
	readonly runs: RunGetData[];
	readonly workers: WorkerListData["workers"];
	readonly subagents: SubagentListData["subagents"];
	readonly warnings: ReadonlyArray<"run_unavailable" | "workers_unavailable" | "subagents_unavailable">;
}

/** Assemble the read-only Task Graph board from public-safe Automation Host projections. */
export async function loadTaskGraphBoard(client: WebReadOnlyRpcClient): Promise<TaskGraphBoardData> {
	const graphData = await client.listTaskGraphs({ limit: 100 });
	const runIds = [
		...new Set(
			graphData.graphs.flatMap((graph) =>
				graph.nodes.flatMap((node) => (node.runRef === undefined ? [] : [node.runRef.runId])),
			),
		),
	];
	const warnings: Array<TaskGraphBoardData["warnings"][number]> = [];
	const runResults = await Promise.all(
		runIds.map(async (runId) => {
			try {
				return await client.getRun(runId);
			} catch {
				warnings.push("run_unavailable");
				return undefined;
			}
		}),
	);
	let workers: WorkerListData["workers"] = [];
	try {
		workers = (await client.listWorkers({ limit: 100 })).workers;
	} catch {
		warnings.push("workers_unavailable");
	}
	const subagentResults = await Promise.all(
		runIds.map(async (runId) => {
			try {
				return (await client.listSubagents(runId, { limit: 100 })).subagents;
			} catch {
				warnings.push("subagents_unavailable");
				return [];
			}
		}),
	);
	return {
		graphs: graphData.graphs,
		runs: runResults.filter((run): run is RunGetData => run !== undefined),
		workers,
		subagents: subagentResults.flat(),
		warnings: [...new Set(warnings)],
	};
}
