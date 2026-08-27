/**
 * Line 12A Native Subagent Runtime capability ledger.
 *
 * Line 12A closes exactly capabilities 90-97 and 99-118. It consumes 16
 * sealed Foundation closures by reference and preserves the later owners for
 * scheduler, connector, hardening, and product-delivery work. Capability 140
 * remains on the Line 11 extension track and is not part of this ledger.
 */

import { type FoundationCapabilityClosure, foundationClosureById } from "./foundation-capabilities.ts";

export type Line12aSubagentCapabilityClosureStatus = "implemented" | "consumed_foundation";
export type Line12aSubagentDeferredOwner = "12B" | "13" | "14" | "15";

export interface Line12aSubagentCapabilityClosureV1 {
	id: number;
	closure: Line12aSubagentCapabilityClosureStatus;
	ownerModule: string;
	publicContract?: string;
	tests: readonly string[];
	foundationClosure?: FoundationCapabilityClosure;
}

export interface Line12aSubagentDeferredCapabilityV1 {
	id: number;
	deferredTo: Line12aSubagentDeferredOwner;
	reason: string;
}

function requireFoundationClosure(id: number): FoundationCapabilityClosure {
	const closure = foundationClosureById(id);
	if (!closure) throw new Error(`Foundation capability ${id} is not closed`);
	return closure;
}

const implemented = [
	{
		id: 90,
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		publicContract: "Trusted Host composition for native in-process and fork child Agent runtimes",
		tests: [
			"packages/coding-agent/test/subagent-composition.test.ts",
			"packages/coding-agent/test/subagent-inprocess-provider.test.ts",
			"packages/coding-agent/test/subagent-fork-provider.test.ts",
		],
	},
	{
		id: 91,
		ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
		publicContract: "Child Role and immutable Binding projection",
		tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
	},
	{
		id: 92,
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		publicContract: "Trusted explicit child execution planning and provider selection",
		tests: ["packages/coding-agent/test/subagent-composition.test.ts"],
	},
	{
		id: 93,
		ownerModule: "packages/coding-agent/src/core/subagent-supervisor.ts",
		publicContract: "Durable child identity, lineage, and lifecycle supervision",
		tests: ["packages/coding-agent/test/subagent-supervisor.test.ts"],
	},
	{
		id: 94,
		ownerModule: "packages/coding-agent/src/core/subagent-fork-provider.ts",
		publicContract: "Child transcript recovery and provider resume",
		tests: ["packages/coding-agent/test/subagent-fork-provider.test.ts"],
	},
	{
		id: 95,
		ownerModule: "packages/coding-agent/src/core/subagent-context-fork.ts",
		publicContract: "Digest-bound none, all, recent_n, and task_package Context forks",
		tests: ["packages/coding-agent/test/subagent-context-fork.test.ts"],
	},
	{
		id: 96,
		ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
		publicContract: "Seven-resource tighten-only child inheritance proof",
		tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
	},
	{
		id: 97,
		ownerModule: "packages/coding-agent/src/core/subagent-memory.ts",
		publicContract: "Independent child memory scope and provenance",
		tests: ["packages/coding-agent/test/subagent-memory.test.ts"],
	},
	{
		id: 99,
		ownerModule: "packages/coding-agent/src/core/subagent-result.ts",
		publicContract: "Digest-validated child input and output Artifact references",
		tests: ["packages/coding-agent/test/subagent-result.test.ts"],
	},
	{
		id: 100,
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		publicContract: "Child AttemptReceipt to Host-owned TaskResult and RunReceipt settlement",
		tests: [
			"packages/coding-agent/test/subagent-composition.test.ts",
			"packages/coding-agent/test/product-prompt-composition.test.ts",
			"packages/coding-agent/test/run-lifecycle-subagent.test.ts",
		],
	},
	{
		id: 101,
		ownerModule: "packages/coding-agent/src/core/subagent-context-ingress.ts",
		publicContract: "Untrusted child-result projection as the only parent Context ingress",
		tests: [
			"packages/coding-agent/test/subagent-context-ingress.test.ts",
			"packages/coding-agent/test/subagent-result.test.ts",
		],
	},
	{
		id: 102,
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		publicContract: "Child spawn through a distinct Task, Dispatch, Attempt, and AgentInstance",
		tests: ["packages/coding-agent/test/subagent-composition.test.ts"],
	},
	{
		id: 103,
		ownerModule: "packages/coding-agent/src/core/subagent-mailbox.ts",
		publicContract: "Durable bounded child mailbox send and acknowledgement",
		tests: ["packages/coding-agent/test/subagent-mailbox.test.ts"],
	},
	{
		id: 104,
		ownerModule: "packages/coding-agent/src/core/subagent-mailbox.ts",
		publicContract: "Bounded wait_any, wait_all, query, and timeout semantics",
		tests: ["packages/coding-agent/test/subagent-mailbox.test.ts"],
	},
	{
		id: 105,
		ownerModule: "packages/coding-agent/src/core/subagent-supervisor.ts",
		publicContract: "Idempotent child cancel, kill, terminal, and close lifecycle",
		tests: [
			"packages/coding-agent/test/subagent-supervisor.test.ts",
			"packages/coding-agent/test/subagent-fork-provider.test.ts",
		],
	},
	{
		id: 106,
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		publicContract: "Background child lifecycle and safe observer reattachment",
		tests: [
			"packages/coding-agent/test/subagent-composition.test.ts",
			"packages/coding-agent/test/run-lifecycle-subagent.test.ts",
		],
	},
	{
		id: 107,
		ownerModule: "packages/coding-agent/src/core/subagent-supervisor.ts",
		publicContract: "Depth, concurrency, maximum-turn, and bounded queue-or-fail gates",
		tests: ["packages/coding-agent/test/subagent-supervisor.test.ts"],
	},
	{
		id: 108,
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		publicContract: "Trusted optional in-process child worktree negotiation, ephemeral Harness routing, apply, cleanup, and quarantine lifecycle",
		tests: [
			"packages/coding-agent/test/subagent-composition.test.ts",
			"packages/coding-agent/test/subagent-worktree.test.ts",
		],
	},
	{
		id: 109,
		ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
		publicContract: "Policy, Gate, and Budget inheritance that cannot widen the parent Binding",
		tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
	},
	{
		id: 110,
		ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
		publicContract: "Per-child ModelProfile, effort, service tier, fallback, and budget freeze",
		tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
	},
	{
		id: 111,
		ownerModule: "packages/coding-agent/src/core/subagent-registry.ts",
		publicContract: "Immutable three-kind Native Agent provider registry: in-process and fork available, Agent Runtime Host unavailable",
		tests: [
			"packages/coding-agent/test/subagent-registry.test.ts",
			"packages/agent/test/harness/foundation-provider-conformance.test.ts",
		],
	},
	{
		id: 112,
		ownerModule: "packages/coding-agent/src/core/subagent-registry.ts",
		publicContract: "Fail-closed child provider capability negotiation",
		tests: ["packages/coding-agent/test/subagent-registry.test.ts"],
	},
	{
		id: 113,
		ownerModule: "packages/coding-agent/src/core/subagent-fork-provider.ts",
		publicContract: "Spawn lookup and transcript-backed continuation without reviving old handles",
		tests: [
			"packages/coding-agent/test/subagent-fork-provider.test.ts",
			"packages/coding-agent/test/subagent-supervisor.test.ts",
		],
	},
	{
		id: 114,
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		publicContract: "Agent-class child execution through the common Task executor and receipt layers",
		tests: [
			"packages/coding-agent/test/subagent-composition.test.ts",
			"packages/coding-agent/test/subagent-inprocess-provider.test.ts",
		],
	},
	{
		id: 115,
		ownerModule: "packages/coding-agent/src/core/subagent-supervisor.ts",
		publicContract: "Read-only sibling state, capability, task, and mailbox roster",
		tests: [
			"packages/coding-agent/test/subagent-supervisor.test.ts",
			"packages/coding-agent/test/subagent-mailbox.test.ts",
		],
	},
	{
		id: 116,
		ownerModule: "packages/coding-agent/src/core/subagent-supervisor.ts",
		publicContract: "Nested spawn lineage, reparent, and ancestor constraints",
		tests: ["packages/coding-agent/test/subagent-supervisor.test.ts"],
	},
	{
		id: 117,
		ownerModule: "packages/coding-agent/src/core/subagent-result.ts",
		publicContract: "Host-owned multi-attempt comparison and TaskResult settlement inputs",
		tests: ["packages/coding-agent/test/subagent-result.test.ts"],
	},
	{
		id: 118,
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		publicContract: "Single-Host real child chain and parallel execution with all-succeed, partial, and quorum Host joins",
		tests: [
			"packages/coding-agent/test/subagent-result.test.ts",
			"packages/coding-agent/test/subagent-composition.test.ts",
			"packages/coding-agent/test/product-prompt-composition.test.ts",
		],
	},
] satisfies readonly Omit<Line12aSubagentCapabilityClosureV1, "closure">[];

const consumedFoundationEvidence = {
	2: {
		ownerModule: "packages/coding-agent/src/core/subagent-inprocess-provider.ts",
		tests: ["packages/coding-agent/test/subagent-inprocess-provider.test.ts"],
	},
	6: {
		ownerModule: "packages/coding-agent/src/core/subagent-supervisor.ts",
		tests: [
			"packages/coding-agent/test/subagent-supervisor.test.ts",
			"packages/coding-agent/test/run-lifecycle-subagent.test.ts",
		],
	},
	8: {
		ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
		tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
	},
	9: {
		ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
		tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
	},
	17: {
		ownerModule: "packages/coding-agent/src/core/subagent-context-fork.ts",
		tests: ["packages/coding-agent/test/subagent-context-fork.test.ts"],
	},
	18: {
		ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
		tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
	},
	19: {
		ownerModule: "packages/coding-agent/src/core/subagent-fork-provider.ts",
		tests: ["packages/coding-agent/test/subagent-fork-provider.test.ts"],
	},
	20: {
		ownerModule: "packages/coding-agent/src/core/subagent-memory.ts",
		tests: ["packages/coding-agent/test/subagent-memory.test.ts"],
	},
	26: {
		ownerModule: "packages/coding-agent/src/core/subagent-mailbox.ts",
		tests: ["packages/coding-agent/test/subagent-mailbox.test.ts"],
	},
	29: {
		ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
		tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
	},
	30: {
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		tests: ["packages/coding-agent/test/subagent-composition.test.ts"],
	},
	31: {
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		tests: ["packages/coding-agent/test/subagent-composition.test.ts"],
	},
	32: {
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		tests: ["packages/coding-agent/test/subagent-composition.test.ts"],
	},
	33: {
		ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
		tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
	},
	34: {
		ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
		tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
	},
	98: {
		ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
		tests: ["packages/coding-agent/test/subagent-composition.test.ts"],
	},
} satisfies Readonly<Record<number, { readonly ownerModule: string; readonly tests: readonly string[] }>>;

const consumedFoundationIds = [2, 6, 8, 9, 17, 18, 19, 20, 26, 29, 30, 31, 32, 33, 34, 98] as const;

/** Exact Line 12A closure and consumed-Foundation ledger. */
export const LINE12A_SUBAGENT_CAPABILITY_CLOSURES: readonly Line12aSubagentCapabilityClosureV1[] = [
	...implemented.map((entry) => ({ ...entry, closure: "implemented" as const })),
	...consumedFoundationIds.map((id) => ({
		id,
		closure: "consumed_foundation" as const,
		ownerModule: consumedFoundationEvidence[id].ownerModule,
		tests: consumedFoundationEvidence[id].tests,
		foundationClosure: requireFoundationClosure(id),
	})),
];

/** Work deliberately left to its exact later implementation line. */
export const LINE12A_SUBAGENT_DEFERRED_CAPABILITIES: readonly Line12aSubagentDeferredCapabilityV1[] = [
	...[119, 120, 121, 122, 123, 124, 125, 126, 130, 131].map((id) => ({
		id,
		deferredTo: "12B" as const,
		reason: "Task scheduling, queues, ownership, cross-Session coordination, and handoff belong to Line 12B.",
	})),
	...[132, 133, 138].map((id) => ({
		id,
		deferredTo: "13" as const,
		reason:
			"External connector capability, protected-path review, and MCP security productization belong to Line 13.",
	})),
	...[134, 137, 139, 141, 142, 143, 144, 149, 150].map((id) => ({
		id,
		deferredTo: "14" as const,
		reason:
			"Managed requirements, DLP, audit integrity, CI, metrics, HA, retention, and platform consistency belong to Line 14.",
	})),
	...[147, 148].map((id) => ({
		id,
		deferredTo: "15" as const,
		reason: "Role/resource-pool configuration and product usage/audit surfaces belong to Line 15.",
	})),
];
