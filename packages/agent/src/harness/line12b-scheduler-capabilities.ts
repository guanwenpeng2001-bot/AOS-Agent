/** Exact Line 12B scheduler closure ledger. */

import {
	foundationClosureById,
	type FoundationCapabilityClosureV1,
} from "./foundation-v1-capabilities.ts";

export type Line12bSchedulerClosureStatus = "implemented" | "consumed_foundation";
export type Line12bSchedulerDeferredOwner = "12A" | "13" | "14" | "15";

export interface Line12bSchedulerCapabilityClosureV1 {
	readonly id: number;
	readonly closure: Line12bSchedulerClosureStatus;
	readonly ownerModule: string;
	readonly publicContract: string;
	readonly tests: readonly string[];
	readonly foundationClosure?: FoundationCapabilityClosureV1;
}

export interface Line12bSchedulerDeferredCapabilityV1 {
	readonly id: number;
	readonly deferredTo: Line12bSchedulerDeferredOwner;
	readonly reason: string;
}

function requireFoundationClosure(id: number): FoundationCapabilityClosureV1 {
	const closure = foundationClosureById(id);
	if (closure === undefined) throw new Error(`Foundation capability ${id} is not closed`);
	return closure;
}

const implemented = [
	{ id: 119, ownerModule: "packages/coding-agent/src/core/scheduler.ts", publicContract: "Default-off bounded Scheduler Host advances durable Task DAG nodes", tests: ["packages/coding-agent/test/scheduler-fan-in.test.ts", "packages/coding-agent/test/scheduler-composition.test.ts"] },
	{ id: 120, ownerModule: "packages/coding-agent/src/core/scheduler-queue.ts", publicContract: "Durable scheduler queue, claim ownership, leases, and fencing", tests: ["packages/coding-agent/test/scheduler-queue.test.ts"] },
	{ id: 121, ownerModule: "packages/coding-agent/src/core/scheduler-executors.ts", publicContract: "Deterministic executor selection with fenced dispatch and Attempt recovery", tests: ["packages/coding-agent/test/scheduler-executors.test.ts", "packages/coding-agent/test/scheduler-dispatch.test.ts"] },
	{ id: 122, ownerModule: "packages/coding-agent/src/core/scheduler-fan-in.ts", publicContract: "Deterministic DAG fan-out, fan-in, join, and layered result settlement", tests: ["packages/coding-agent/test/scheduler-fan-in.test.ts", "packages/coding-agent/test/scheduler-composition.test.ts"] },
	{ id: 123, ownerModule: "packages/coding-agent/src/core/scheduler-workflow.ts", publicContract: "Single-Host cross-Session task orchestration and Workflow progression", tests: ["packages/coding-agent/test/scheduler-messages.test.ts", "packages/coding-agent/test/scheduler-workflow.test.ts"] },
	{ id: 124, ownerModule: "packages/coding-agent/src/core/scheduler-messages.ts", publicContract: "Durable cross-Session scheduler messages with acknowledgement and replay", tests: ["packages/coding-agent/test/scheduler-messages.test.ts"] },
	{ id: 125, ownerModule: "packages/coding-agent/src/core/scheduler-messages.ts", publicContract: "Foundation Ask, Reply, and escalation orchestration across Sessions", tests: ["packages/coding-agent/test/scheduler-messages.test.ts"] },
	{ id: 126, ownerModule: "packages/coding-agent/src/core/scheduler-handoff.ts", publicContract: "Fenced ownership handoff with source cancellation and safe audit lineage", tests: ["packages/coding-agent/test/scheduler-handoff.test.ts"] },
	{ id: 130, ownerModule: "packages/coding-agent/src/core/scheduler-deadlock.ts", publicContract: "Bounded wait-for deadlock resolution, fairness, and backpressure", tests: ["packages/coding-agent/test/scheduler-deadlock.test.ts"] },
	{ id: 131, ownerModule: "packages/coding-agent/src/core/foundation-control-plane.ts", publicContract: "Single coalescing driver for event wakes and bounded retained-work recovery", tests: ["packages/coding-agent/test/scheduler-composition.test.ts", "packages/coding-agent/test/scheduler-workflow.test.ts", "packages/coding-agent/test/scheduler-deadlock.test.ts"] },
] as const;

const consumedIds = [3, 5, 6, 10, 16, 26, 47, 51, 53, 55, 56, 57, 58, 61, 98, 127, 128, 129] as const;

export const LINE12B_SCHEDULER_CAPABILITY_CLOSURES: readonly Line12bSchedulerCapabilityClosureV1[] = [
	...implemented.map((entry) => ({ ...entry, closure: "implemented" as const })),
	...consumedIds.map((id) => ({
		id,
		closure: "consumed_foundation" as const,
		ownerModule: "packages/coding-agent/src/core/scheduler.ts",
		publicContract: `Line 12B consumes sealed Foundation capability ${id} without redefining it`,
		tests: ["packages/coding-agent/test/scheduler-queue.test.ts"],
		foundationClosure: requireFoundationClosure(id),
	})),
];

export const LINE12B_SCHEDULER_DEFERRED_CAPABILITIES: readonly Line12bSchedulerDeferredCapabilityV1[] = [
	...[90, 91, 92, 93, 94, 95, 96, 97, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118].map((id) => ({ id, deferredTo: "12A" as const, reason: "Native Subagent closure remains owned by Line 12A." })),
	...[132, 133, 138].map((id) => ({ id, deferredTo: "13" as const, reason: "External connector productization remains owned by Line 13." })),
	...[134, 137, 139, 141, 142, 143, 144, 149, 150].map((id) => ({ id, deferredTo: "14" as const, reason: "Platform hardening remains owned by Line 14." })),
	...[147, 148].map((id) => ({ id, deferredTo: "15" as const, reason: "Product UI remains owned by Line 15." })),
];
