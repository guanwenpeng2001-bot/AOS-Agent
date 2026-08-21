/**
 * Line 11 Sandbox Operation Worker capability ledger.
 *
 * Line 11 closes exactly capabilities 74-87, 135 and 136. It also consumes
 * Foundation closures 6, 32, 47, 52 and 61 without reopening them. Remote
 * workers/fleet work (88/89), the permission-mode consumer (132), and DLP
 * hardening (137) remain assigned to later lines. Capability 140 is not part
 * of this closure.
 */

import {
	foundationClosureById,
	type FoundationCapabilityClosureV1,
} from "./foundation-v1-capabilities.ts";

export type Line11WorkerCapabilityClosureStatus = "implemented" | "consumed_foundation";
export type Line11WorkerDeferredOwner = "13" | "14";

export interface Line11WorkerCapabilityClosureV1 {
	id: number;
	closure: Line11WorkerCapabilityClosureStatus;
	ownerModule: string;
	publicContract: string;
	tests: readonly string[];
	foundationClosure?: FoundationCapabilityClosureV1;
}

export interface Line11WorkerDeferredCapabilityV1 {
	id: number;
	deferredTo: Line11WorkerDeferredOwner;
	reason: string;
}

export interface Line11WorkerReviewLedgerEntryV1 {
	id: string;
	status: "fixed_sealed_contract_omission" | "nonblocking_follow_up";
	detail: string;
}

function requireFoundationClosure(id: number): FoundationCapabilityClosureV1 {
	const closure = foundationClosureById(id);
	if (!closure) {
		throw new Error(`Foundation capability ${id} is not closed`);
	}
	return closure;
}

const closures = [
	{
		id: 74,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/worker-sandbox-provider.ts",
		publicContract: "Sandbox provider capability validation and fail-closed worker activation",
		tests: ["packages/coding-agent/test/worker-sandbox-provider.test.ts"],
	},
	{
		id: 75,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/worker-protocol.ts",
		publicContract: "Private stdio WorkerProtocolV1 request, response and notification envelopes",
		tests: ["packages/coding-agent/test/worker-protocol.test.ts", "packages/coding-agent/test/worker-runtime.test.ts"],
	},
	{
		id: 76,
		closure: "implemented",
		ownerModule: "packages/coding-agent/examples/extensions/gondolin/provider.ts",
		publicContract: "Optional Gondolin/QEMU local VM adapter for the worker sandbox contract",
		tests: ["packages/coding-agent/test/gondolin-sandbox-provider.test.ts"],
	},
	{
		id: 77,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/worker-runtime.ts",
		publicContract: "Bounded sandbox operation runtime without ModelRuntime, Agent Loop or AgentInstance ownership",
		tests: ["packages/coding-agent/test/worker-runtime.test.ts", "packages/coding-agent/test/worker-contract.test.ts"],
	},
	{
		id: 78,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/worker-supervisor.ts",
		publicContract: "Host supervisor over an authenticated private stdio child-process channel",
		tests: ["packages/coding-agent/test/worker-supervisor.test.ts", "packages/coding-agent/test/worker-protocol.test.ts"],
	},
	{
		id: 79,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/worker.ts",
		publicContract: "Versioned worker profile, identity, correlation and public redaction contract",
		tests: ["packages/coding-agent/test/worker-contract.test.ts"],
	},
	{
		id: 80,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/worker-sandbox-provider.ts",
		publicContract: "Side-effect-free preflight followed by activation only after Host Run acceptance",
		tests: ["packages/coding-agent/test/worker-sandbox-provider.test.ts", "packages/coding-agent/test/run-lifecycle-worker.test.ts"],
	},
	{
		id: 81,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/worker-entry.ts",
		publicContract: "Versioned worker bootstrap and Node/Bun-compatible child-process entry",
		tests: ["packages/coding-agent/test/worker-runtime.test.ts", "packages/coding-agent/test/worker-protocol.test.ts"],
	},
	{
		id: 82,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/worker-supervisor.ts",
		publicContract: "Readiness, heartbeat liveness and deterministic lost-worker detection",
		tests: ["packages/coding-agent/test/worker-supervisor.test.ts"],
	},
	{
		id: 83,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/run-lifecycle.ts",
		publicContract: "Host-driven cancel/finalize hooks with Host-only Run terminal authority",
		tests: ["packages/coding-agent/test/run-lifecycle-worker.test.ts", "packages/coding-agent/test/worker-supervisor.test.ts"],
	},
	{
		id: 84,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/server/create-harness.ts",
		publicContract: "Operation settlement, reclaim and WorkerReceipt provenance joined into ToolExecutionResultV1.toolReceiptRef",
		tests: ["packages/coding-agent/test/product-prompt-ingress.test.ts", "packages/agent/test/harness/t4-tool-gateway.test.ts"],
	},
	{
		id: 85,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/task-credential-service.ts",
		publicContract: "Worker-scoped credential project, renew, revoke and redacted delivery lifecycle",
		tests: ["packages/coding-agent/test/task-credential-worker.test.ts", "packages/coding-agent/test/worker-sandbox-provider.test.ts"],
	},
	{
		id: 86,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/worker-supervisor.ts",
		publicContract: "Operation revision fencing, lost-state settlement and idempotent reclaim",
		tests: ["packages/coding-agent/test/worker-supervisor.test.ts", "packages/coding-agent/test/rpc-worker.test.ts"],
	},
	{
		id: 87,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/worker-protocol.ts",
		publicContract: "Bounded partial operation events and safe terminal result return to the Host",
		tests: ["packages/coding-agent/test/worker-protocol.test.ts", "packages/coding-agent/test/worker-runtime.test.ts"],
	},
	{
		id: 135,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/worker-sandbox-provider.ts",
		publicContract: "Setup/operation phase separation with validated sandbox capability projection",
		tests: ["packages/coding-agent/test/worker-sandbox-provider.test.ts", "packages/coding-agent/test/gondolin-sandbox-provider.test.ts"],
	},
	{
		id: 136,
		closure: "implemented",
		ownerModule: "packages/coding-agent/src/core/task-credential-service.ts",
		publicContract: "Task Credential lease integration for Operation Worker targets",
		tests: ["packages/coding-agent/test/task-credential-worker.test.ts", "packages/coding-agent/test/worker-sandbox-provider.test.ts"],
	},
	...([6, 32, 47, 52, 61] as const).map((id) => ({
		id,
		closure: "consumed_foundation" as const,
		ownerModule: "packages/coding-agent/src/core/worker-sandbox-provider.ts",
		publicContract: `Line 11 consumes the sealed Foundation capability ${id} contract without redefining it`,
		tests: ["packages/coding-agent/test/worker-sandbox-provider.test.ts", "packages/coding-agent/test/run-lifecycle-worker.test.ts"],
		foundationClosure: requireFoundationClosure(id),
	})),
] satisfies readonly Line11WorkerCapabilityClosureV1[];

/** Exact Line 11 closure and consumed-Foundation ledger. */
export const LINE11_WORKER_CAPABILITY_CLOSURES: readonly Line11WorkerCapabilityClosureV1[] = closures;

/** Work deliberately left to later implementation lines. */
export const LINE11_WORKER_DEFERRED_CAPABILITIES: readonly Line11WorkerDeferredCapabilityV1[] = [
	{ id: 88, deferredTo: "14", reason: "Remote workers, cross-host authentication/TLS and network policy are platform hardening." },
	{ id: 89, deferredTo: "14", reason: "Fleet scheduling, metrics and multi-worker operations are platform hardening." },
	{ id: 132, deferredTo: "13", reason: "Permission-mode translation belongs to external connector and Tool Gateway productization." },
	{ id: 137, deferredTo: "14", reason: "Vault integration, rotation and DLP are platform hardening." },
];

/** R4 findings recorded without implying schema redesign or production follow-up work in this line. */
export const LINE11_WORKER_REVIEW_LEDGER: readonly Line11WorkerReviewLedgerEntryV1[] = [
	{
		id: "foundation-canonical-worker-errors",
		status: "fixed_sealed_contract_omission",
		detail: "Foundation canonical errors include sandbox_capability_insufficient and task_credential_target_unavailable; this is additive vocabulary, not schema redesign.",
	},
	{
		id: "tool-gateway-worker-receipt-ref",
		status: "fixed_sealed_contract_omission",
		detail: "Sandbox Operation ToolGateway propagates the validated WorkerReceipt.workerReceiptId into ToolExecutionResultV1.toolReceiptRef.",
	},
	{ id: "cancelled-without-proof-dead-code", status: "nonblocking_follow_up", detail: "Review cancelledWithoutProof dead code." },
	{ id: "credential-target-registry-has-get", status: "nonblocking_follow_up", detail: "Clarify WorkerCredentialTargetRegistry has/get lazy-resolution semantics." },
	{ id: "revocation-unknown-quarantine", status: "nonblocking_follow_up", detail: "Review revocation_unknown quarantine asymmetry." },
	{ id: "credential-reason-propagation", status: "nonblocking_follow_up", detail: "Preserve Worker project/renew/revoke reason propagation." },
	{ id: "vm-qemu-sensitive-key-tests", status: "nonblocking_follow_up", detail: "Extend VM id and QEMU sensitive-key tests." },
	{ id: "receipt-summary-wording", status: "nonblocking_follow_up", detail: "Align receipt summary wording with the intentionally omitted receiptId field." },
	{ id: "session-create-provider-disposal", status: "nonblocking_follow_up", detail: "Dispose the provider if createAgentSessionFromServices fails during session creation." },
	{ id: "registered-hooks-singleton", status: "nonblocking_follow_up", detail: "Review registeredRunWorkerHooks singleton lifecycle and service_conflict diagnostics." },
];
