/**
 * Line 13 T5 capability truth ledger.
 *
 * Each implemented behavior is an independently evidenced claim. The public
 * description is derived from those claims and the exact deferred boundary so
 * prose cannot silently become broader than the evidence or claimed status.
 */

export const LINE13_T5_CAPABILITY_IDS = [23, 69, 111, 113, 114, 132, 133, 135, 136, 138] as const;

export type Line13T5CapabilityId = (typeof LINE13_T5_CAPABILITY_IDS)[number];
export type Line13T5CapabilityStatus = "implemented" | "partial";
export type Line13T5DeferredOwner = "14" | "15" | "T9";

export type Line13T5CapabilityClaim =
	| "session-metadata-persistence"
	| "session-product-organization"
	| "rpc-stdio-jsonl"
	| "rpc-loopback-tcp-jsonl"
	| "rpc-remote-transport-hardening"
	| "native-provider-registry"
	| "native-provider-availability"
	| "internal-continuation"
	| "external-continuation"
	| "internal-task-executor-admission"
	| "external-task-executor-admission"
	| "execution-policy-reference"
	| "seven-resource-child-projection"
	| "canonical-protected-paths"
	| "structured-effects-and-review"
	| "managed-team-review"
	| "durable-review-evidence"
	| "worker-two-phase-execution"
	| "external-two-phase-admission"
	| "production-runner-hardening"
	| "worker-credential-target"
	| "external-credential-target"
	| "exact-mcp-selection"
	| "connector-route-intersection"
	| "child-mcp-no-widen"
	| "durable-mcp-inheritance-approval";

export interface Line13T5CapabilityEvidence {
	readonly claim: Line13T5CapabilityClaim;
	readonly behavior: string;
	readonly ownerModule: string;
	readonly tests: readonly string[];
}

export interface Line13T5DeferredCapability {
	readonly claim: Line13T5CapabilityClaim;
	readonly behavior: string;
	readonly owner: Line13T5DeferredOwner;
}

export interface Line13T5CapabilityTruth {
	readonly id: Line13T5CapabilityId;
	readonly status: Line13T5CapabilityStatus;
	readonly description: string;
	readonly evidence: readonly Line13T5CapabilityEvidence[];
	readonly deferred: readonly Line13T5DeferredCapability[];
}

interface RequiredClaim {
	readonly claim: Line13T5CapabilityClaim;
	readonly requiredTests: readonly string[];
}

interface RequiredDeferredClaim {
	readonly claim: Line13T5CapabilityClaim;
	readonly owner: Line13T5DeferredOwner;
}

interface CapabilityRequirement {
	readonly status: Line13T5CapabilityStatus;
	readonly implemented: readonly RequiredClaim[];
	readonly deferred: readonly RequiredDeferredClaim[];
}

const REQUIREMENTS: Readonly<Record<Line13T5CapabilityId, CapabilityRequirement>> = {
	23: {
		status: "partial",
		implemented: [
			{
				claim: "session-metadata-persistence",
				requiredTests: ["packages/agent/test/harness/session/jsonl.test.ts"],
			},
		],
		deferred: [{ claim: "session-product-organization", owner: "15" }],
	},
	69: {
		status: "partial",
		implemented: [
			{ claim: "rpc-stdio-jsonl", requiredTests: ["packages/coding-agent/test/rpc-stdio-tcp-transcript.test.ts"] },
			{ claim: "rpc-loopback-tcp-jsonl", requiredTests: ["packages/coding-agent/test/rpc-transport.test.ts"] },
		],
		deferred: [{ claim: "rpc-remote-transport-hardening", owner: "14" }],
	},
	111: {
		status: "implemented",
		implemented: [
			{ claim: "native-provider-registry", requiredTests: ["packages/coding-agent/test/subagent-registry.test.ts"] },
			{
				claim: "native-provider-availability",
				requiredTests: ["packages/coding-agent/test/subagent-registry.test.ts"],
			},
		],
		deferred: [],
	},
	113: {
		status: "implemented",
		implemented: [
			{
				claim: "internal-continuation",
				requiredTests: ["packages/coding-agent/test/subagent-fork-provider.test.ts"],
			},
			{
				claim: "external-continuation",
				requiredTests: [
					"packages/coding-agent/test/external-agent-connector-lifecycle.test.ts",
					"packages/coding-agent/test/agent-runtime-composition.test.ts",
				],
			},
		],
		deferred: [],
	},
	114: {
		status: "implemented",
		implemented: [
			{
				claim: "internal-task-executor-admission",
				requiredTests: ["packages/coding-agent/test/subagent-composition.test.ts"],
			},
			{
				claim: "external-task-executor-admission",
				requiredTests: [
					"packages/coding-agent/test/external-agent-integration.test.ts",
					"packages/coding-agent/test/agent-runtime-composition.test.ts",
				],
			},
		],
		deferred: [],
	},
	132: {
		status: "implemented",
		implemented: [
			{
				claim: "execution-policy-reference",
				requiredTests: ["packages/coding-agent/test/execution-policy-contract.test.ts"],
			},
			{
				claim: "seven-resource-child-projection",
				requiredTests: ["packages/coding-agent/test/subagent-binding.test.ts"],
			},
		],
		deferred: [],
	},
	133: {
		status: "implemented",
		implemented: [
			{
				claim: "canonical-protected-paths",
				requiredTests: ["packages/coding-agent/test/protected-path-review.test.ts"],
			},
			{
				claim: "structured-effects-and-review",
				requiredTests: ["packages/coding-agent/test/protected-path-review.test.ts"],
			},
			{ claim: "managed-team-review", requiredTests: ["packages/coding-agent/test/protected-path-review.test.ts"] },
			{
				claim: "durable-review-evidence",
				requiredTests: ["packages/coding-agent/test/protected-path-review.test.ts"],
			},
		],
		deferred: [],
	},
	135: {
		status: "partial",
		implemented: [
			{
				claim: "worker-two-phase-execution",
				requiredTests: ["packages/coding-agent/test/worker-sandbox-provider.test.ts"],
			},
			{
				claim: "external-two-phase-admission",
				requiredTests: [
					"packages/coding-agent/test/external-agent-integration.test.ts",
					"packages/coding-agent/test/external-connector-registry.test.ts",
				],
			},
		],
		deferred: [{ claim: "production-runner-hardening", owner: "14" }],
	},
	136: {
		status: "partial",
		implemented: [
			{
				claim: "worker-credential-target",
				requiredTests: ["packages/coding-agent/test/task-credential-worker.test.ts"],
			},
		],
		deferred: [{ claim: "external-credential-target", owner: "T9" }],
	},
	138: {
		status: "implemented",
		implemented: [
			{ claim: "exact-mcp-selection", requiredTests: ["packages/coding-agent/test/mcp-exact-selection.test.ts"] },
			{
				claim: "connector-route-intersection",
				requiredTests: ["packages/coding-agent/test/external-connector-registry.test.ts"],
			},
			{
				claim: "child-mcp-no-widen",
				requiredTests: [
					"packages/coding-agent/test/mcp-exact-selection.test.ts",
					"packages/coding-agent/test/subagent-binding.test.ts",
				],
			},
			{
				claim: "durable-mcp-inheritance-approval",
				requiredTests: [
					"packages/coding-agent/test/mcp-exact-selection.test.ts",
					"packages/coding-agent/test/subagent-binding.test.ts",
				],
			},
		],
		deferred: [],
	},
};

function renderDescription(
	evidence: readonly Pick<Line13T5CapabilityEvidence, "behavior">[],
	deferred: readonly { readonly behavior: string; readonly owner: string }[],
): string {
	const implemented = `Implemented: ${evidence.map((entry) => entry.behavior).join(" ")}`;
	if (deferred.length === 0) return implemented;
	return `${implemented} Deferred: ${deferred.map((entry) => `${entry.behavior} [${entry.owner}]`).join(" ")}`;
}

function defineTruth(value: Omit<Line13T5CapabilityTruth, "description">): Line13T5CapabilityTruth {
	return {
		...value,
		description: renderDescription(value.evidence, value.deferred),
	};
}

/** Exact post-T4/T5 truth for the ten capability rows repaired by T5. */
export const LINE13_T5_CAPABILITY_TRUTH: readonly Line13T5CapabilityTruth[] = [
	defineTruth({
		id: 23,
		status: "partial",
		evidence: [
			{
				claim: "session-metadata-persistence",
				behavior: "Canonical Session metadata records persist and recover through Session storage.",
				ownerModule: "packages/agent/src/harness/session/index.ts",
				tests: [
					"packages/agent/test/harness/session/jsonl.test.ts",
					"packages/agent/test/harness/agent-harness-runtime.test.ts",
				],
			},
		],
		deferred: [
			{
				claim: "session-product-organization",
				behavior:
					"Session rename, search, archive, ephemeral, from-PR, and product organization remain outside this implementation.",
				owner: "15",
			},
		],
	}),
	defineTruth({
		id: 69,
		status: "partial",
		evidence: [
			{
				claim: "rpc-stdio-jsonl",
				behavior: "RPC supports the stdio JSONL transport.",
				ownerModule: "packages/coding-agent/src/modes/rpc/rpc-transport.ts",
				tests: [
					"packages/coding-agent/test/rpc-stdio-tcp-transcript.test.ts",
					"packages/coding-agent/test/rpc-transport.test.ts",
				],
			},
			{
				claim: "rpc-loopback-tcp-jsonl",
				behavior: "RPC supports loopback-only TCP JSONL transport.",
				ownerModule: "packages/coding-agent/src/modes/rpc/rpc-transport.ts",
				tests: [
					"packages/coding-agent/test/rpc-stdio-tcp-transcript.test.ts",
					"packages/coding-agent/test/rpc-transport.test.ts",
				],
			},
		],
		deferred: [
			{
				claim: "rpc-remote-transport-hardening",
				behavior:
					"WebSocket, authentication, TLS, remote-address policy, and remote production operations are not implemented.",
				owner: "14",
			},
		],
	}),
	defineTruth({
		id: 111,
		status: "implemented",
		evidence: [
			{
				claim: "native-provider-registry",
				behavior:
					"The immutable Native Subagent registry recognizes in_process, fork, and agent_runtime_host without treating External Connectors as Native providers.",
				ownerModule: "packages/coding-agent/src/core/subagent-registry.ts",
				tests: [
					"packages/coding-agent/test/subagent-registry.test.ts",
					"packages/agent/test/harness/foundation-provider-conformance.test.ts",
				],
			},
			{
				claim: "native-provider-availability",
				behavior:
					"Provider availability is explicit: in_process and fork are implemented while agent_runtime_host fails closed as unavailable.",
				ownerModule: "packages/coding-agent/src/core/subagent-registry.ts",
				tests: ["packages/coding-agent/test/subagent-registry.test.ts"],
			},
		],
		deferred: [],
	}),
	defineTruth({
		id: 113,
		status: "implemented",
		evidence: [
			{
				claim: "internal-continuation",
				behavior:
					"Native child continuation uses durable spawn lookup and transcript-backed recovery without reviving stale handles.",
				ownerModule: "packages/coding-agent/src/core/subagent-fork-provider.ts",
				tests: [
					"packages/coding-agent/test/subagent-fork-provider.test.ts",
					"packages/coding-agent/test/subagent-supervisor.test.ts",
				],
			},
			{
				claim: "external-continuation",
				behavior:
					"External continuation resumes or reconciles the durable Attempt identity across restart without repeating the vendor effect.",
				ownerModule: "packages/coding-agent/src/core/external-agent-connector.ts",
				tests: [
					"packages/coding-agent/test/external-agent-connector-lifecycle.test.ts",
					"packages/coding-agent/test/agent-runtime-composition.test.ts",
				],
			},
		],
		deferred: [],
	}),
	defineTruth({
		id: 114,
		status: "implemented",
		evidence: [
			{
				claim: "internal-task-executor-admission",
				behavior:
					"Native child execution uses canonical Task, Dispatch, Attempt, AttemptReceipt, TaskResult, and RunReceipt layers.",
				ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
				tests: [
					"packages/coding-agent/test/subagent-composition.test.ts",
					"packages/coding-agent/test/product-prompt-composition.test.ts",
				],
			},
			{
				claim: "external-task-executor-admission",
				behavior:
					"External Connector admission and settlement use the same canonical Task execution and receipt layers without creating AgentInstance.",
				ownerModule: "packages/coding-agent/src/core/external-connector-product.ts",
				tests: [
					"packages/coding-agent/test/external-agent-integration.test.ts",
					"packages/coding-agent/test/agent-runtime-composition.test.ts",
				],
			},
		],
		deferred: [],
	}),
	defineTruth({
		id: 132,
		status: "implemented",
		evidence: [
			{
				claim: "execution-policy-reference",
				behavior:
					"Role and AgentBinding carry canonical ExecutionPolicy references rather than a second inline permission matrix.",
				ownerModule: "packages/coding-agent/src/core/execution-policy.ts",
				tests: [
					"packages/coding-agent/test/execution-policy-contract.test.ts",
					"packages/coding-agent/test/execution-policy.test.ts",
				],
			},
			{
				claim: "seven-resource-child-projection",
				behavior:
					"Child Binding projects instructions, skills, MCP, model, sandbox, Git, and budget with tighten-only proofs.",
				ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
				tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
			},
		],
		deferred: [],
	}),
	defineTruth({
		id: 133,
		status: "implemented",
		evidence: [
			{
				claim: "canonical-protected-paths",
				behavior:
					"Protected-path matching uses canonical workspace-relative paths and rejects traversal, absolute escape, and symlink escape.",
				ownerModule: "packages/coding-agent/src/core/protected-path-policy.ts",
				tests: ["packages/coding-agent/test/protected-path-review.test.ts"],
			},
			{
				claim: "structured-effects-and-review",
				behavior:
					"Structured effects resolve none, approval, reviewer, and team-enforced review requirements; raw commands require sandbox handling.",
				ownerModule: "packages/coding-agent/src/core/execution-policy.ts",
				tests: ["packages/coding-agent/test/protected-path-review.test.ts"],
			},
			{
				claim: "managed-team-review",
				behavior:
					"Scope-bound safe reviewer identity and managed team identity fail closed, and project or user settings cannot widen managed requirements.",
				ownerModule: "packages/coding-agent/src/core/protected-path-policy.ts",
				tests: ["packages/coding-agent/test/protected-path-review.test.ts"],
			},
			{
				claim: "durable-review-evidence",
				behavior: "Approval and reviewer decisions persist and replay through the canonical Session policy ledger.",
				ownerModule: "packages/coding-agent/src/core/execution-policy-ledger.ts",
				tests: ["packages/coding-agent/test/protected-path-review.test.ts"],
			},
		],
		deferred: [],
	}),
	defineTruth({
		id: 135,
		status: "partial",
		evidence: [
			{
				claim: "worker-two-phase-execution",
				behavior: "Operation Worker separates validated setup from operation activation.",
				ownerModule: "packages/coding-agent/src/core/worker-sandbox-provider.ts",
				tests: [
					"packages/coding-agent/test/worker-sandbox-provider.test.ts",
					"packages/coding-agent/test/gondolin-sandbox-provider.test.ts",
				],
			},
			{
				claim: "external-two-phase-admission",
				behavior:
					"External Connector performs read-only admission and persists accepted execution input before transport or driver start.",
				ownerModule: "packages/coding-agent/src/core/external-connector-product.ts",
				tests: [
					"packages/coding-agent/test/external-agent-integration.test.ts",
					"packages/coding-agent/test/external-connector-registry.test.ts",
				],
			},
		],
		deferred: [
			{
				claim: "production-runner-hardening",
				behavior: "Remote production target orchestration and hardening remain outside this implementation.",
				owner: "14",
			},
		],
	}),
	defineTruth({
		id: 136,
		status: "partial",
		evidence: [
			{
				claim: "worker-credential-target",
				behavior:
					"Task credential scope, lease, renewal, revocation, and redacted delivery integrate with Operation Worker targets.",
				ownerModule: "packages/coding-agent/src/core/task-credential-service.ts",
				tests: [
					"packages/coding-agent/test/task-credential-worker.test.ts",
					"packages/coding-agent/test/worker-sandbox-provider.test.ts",
				],
			},
		],
		deferred: [
			{
				claim: "external-credential-target",
				behavior: "External Agent credential targets are not integrated.",
				owner: "T9",
			},
		],
	}),
	defineTruth({
		id: 138,
		status: "implemented",
		evidence: [
			{
				claim: "exact-mcp-selection",
				behavior: "AgentBinding freezes exact MCP server and tool identities resolved from the Role selector.",
				ownerModule: "packages/agent/src/harness/foundation/mcp-selection.ts",
				tests: ["packages/coding-agent/test/mcp-exact-selection.test.ts"],
			},
			{
				claim: "connector-route-intersection",
				behavior:
					"External Connectors receive only routes present in the exact MCP selection, CapabilityBinding allowlist, policy, and immutable route catalog.",
				ownerModule: "packages/coding-agent/src/core/external-agent-registry.ts",
				tests: [
					"packages/coding-agent/test/external-connector-registry.test.ts",
					"packages/coding-agent/test/mcp-exact-selection.test.ts",
				],
			},
			{
				claim: "child-mcp-no-widen",
				behavior: "Child MCP selection is an exact subset of the parent selection and fails closed on widening.",
				ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
				tests: [
					"packages/coding-agent/test/mcp-exact-selection.test.ts",
					"packages/coding-agent/test/subagent-binding.test.ts",
				],
			},
			{
				claim: "durable-mcp-inheritance-approval",
				behavior:
					"Policy-required MCP inheritance approval is digest-bound and its evidence identifier persists with the durable child Binding projection.",
				ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
				tests: [
					"packages/coding-agent/test/mcp-exact-selection.test.ts",
					"packages/coding-agent/test/subagent-binding.test.ts",
				],
			},
		],
		deferred: [],
	}),
];

function invalidManifest(problem: string): never {
	throw new Error(`Invalid Line 13 T5 capability manifest: ${problem}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return invalidManifest(`${context} must be an object`);
	}
	return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], context: string): void {
	const expected = new Set(keys);
	for (const key of keys) {
		if (!Object.hasOwn(record, key)) invalidManifest(`${context}.${key} is required`);
	}
	for (const key of Object.keys(record)) {
		if (!expected.has(key)) invalidManifest(`${context}.${key} is not allowed`);
	}
}

function nonemptyString(value: unknown, context: string): string {
	if (typeof value !== "string" || value.trim() === "") return invalidManifest(`${context} must be nonempty`);
	return value;
}

function stringArray(value: unknown, context: string): readonly string[] {
	if (!Array.isArray(value) || value.length === 0) return invalidManifest(`${context} must be a nonempty array`);
	return value.map((entry, index) => nonemptyString(entry, `${context}[${index}]`));
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
	return (
		actual.length === expected.length &&
		new Set(actual).size === actual.length &&
		expected.every((value) => actual.includes(value))
	);
}

/**
 * Reject semantic drift in a candidate manifest.
 *
 * The verifier enforces the exact claim set, required test evidence, deferred
 * owner, derived description, and status for every repaired capability.
 */
export function verifyLine13T5CapabilityManifest(value: unknown): void {
	if (!Array.isArray(value)) invalidManifest("manifest must be an array");
	const rows = value.map((entry, index) => asRecord(entry, `manifest[${index}]`));
	const ids = rows.map((row, index) => {
		const id = row.id;
		if (typeof id !== "number" || !LINE13_T5_CAPABILITY_IDS.includes(id as Line13T5CapabilityId)) {
			return invalidManifest(`manifest[${index}].id is outside the T5 repair set`);
		}
		return id as Line13T5CapabilityId;
	});
	if (!sameSet(ids.map(String), LINE13_T5_CAPABILITY_IDS.map(String))) {
		invalidManifest("manifest must contain each T5 repair id exactly once");
	}

	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index]!;
		const id = ids[index]!;
		const context = `capability ${id}`;
		assertExactKeys(row, ["id", "status", "description", "evidence", "deferred"], context);
		const requirement = REQUIREMENTS[id];
		if (row.status !== requirement.status) invalidManifest(`${context} status must be ${requirement.status}`);
		if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
			invalidManifest(`${context} evidence must be a nonempty array`);
		}
		if (!Array.isArray(row.deferred)) invalidManifest(`${context} deferred must be an array`);

		const evidence = row.evidence.map((item, evidenceIndex) => {
			const record = asRecord(item, `${context}.evidence[${evidenceIndex}]`);
			assertExactKeys(
				record,
				["claim", "behavior", "ownerModule", "tests"],
				`${context}.evidence[${evidenceIndex}]`,
			);
			return {
				claim: nonemptyString(record.claim, `${context}.evidence[${evidenceIndex}].claim`),
				behavior: nonemptyString(record.behavior, `${context}.evidence[${evidenceIndex}].behavior`),
				ownerModule: nonemptyString(record.ownerModule, `${context}.evidence[${evidenceIndex}].ownerModule`),
				tests: stringArray(record.tests, `${context}.evidence[${evidenceIndex}].tests`),
			};
		});
		const deferred = row.deferred.map((item, deferredIndex) => {
			const record = asRecord(item, `${context}.deferred[${deferredIndex}]`);
			assertExactKeys(record, ["claim", "behavior", "owner"], `${context}.deferred[${deferredIndex}]`);
			return {
				claim: nonemptyString(record.claim, `${context}.deferred[${deferredIndex}].claim`),
				behavior: nonemptyString(record.behavior, `${context}.deferred[${deferredIndex}].behavior`),
				owner: nonemptyString(record.owner, `${context}.deferred[${deferredIndex}].owner`),
			};
		});

		const requiredClaims = requirement.implemented.map((entry) => entry.claim);
		if (
			!sameSet(
				evidence.map((entry) => entry.claim),
				requiredClaims,
			)
		) {
			invalidManifest(`${context} implemented claim set does not match its status`);
		}
		for (const required of requirement.implemented) {
			const actual = evidence.find((entry) => entry.claim === required.claim);
			if (actual === undefined) invalidManifest(`${context} is missing evidence for ${required.claim}`);
			for (const test of required.requiredTests) {
				if (!actual.tests.includes(test))
					invalidManifest(`${context} claim ${required.claim} is missing required test ${test}`);
			}
		}

		const requiredDeferredClaims = requirement.deferred.map((entry) => entry.claim);
		if (
			!sameSet(
				deferred.map((entry) => entry.claim),
				requiredDeferredClaims,
			)
		) {
			invalidManifest(`${context} deferred claim set does not match its status`);
		}
		for (const required of requirement.deferred) {
			const actual = deferred.find((entry) => entry.claim === required.claim);
			if (actual?.owner !== required.owner) {
				invalidManifest(`${context} deferred claim ${required.claim} must remain with ${required.owner}`);
			}
		}

		const expectedDescription = renderDescription(evidence, deferred);
		if (row.description !== expectedDescription) {
			invalidManifest(`${context} description must be derived from its evidenced and deferred claims`);
		}
	}
}

verifyLine13T5CapabilityManifest(LINE13_T5_CAPABILITY_TRUTH);
