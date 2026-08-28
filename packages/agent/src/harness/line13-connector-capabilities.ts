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
	| "native-provider-local-availability"
	| "remote-native-provider-availability"
	| "internal-continuation"
	| "external-continuation"
	| "cross-host-continuation"
	| "internal-task-executor-admission"
	| "external-task-executor-admission"
	| "cross-host-task-executor-fleet"
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
	| "production-credential-target"
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

export type Line13T5EvidenceReader = (path: string) => string | undefined;

interface RequiredEvidenceFile {
	readonly path: string;
	readonly markers: readonly string[];
}

interface RequiredClaim {
	readonly claim: Line13T5CapabilityClaim;
	readonly behavior: string;
	readonly ownerModule: string;
	readonly sourceEvidence: readonly RequiredEvidenceFile[];
	readonly testEvidence: readonly RequiredEvidenceFile[];
}

interface RequiredDeferredClaim {
	readonly claim: Line13T5CapabilityClaim;
	readonly behavior: string;
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
				behavior: "Canonical Session metadata records persist and recover through Session storage.",
				ownerModule: "packages/agent/src/harness/session/jsonl/repo.ts",
				sourceEvidence: [
					{
						path: "packages/agent/src/harness/session/jsonl/repo.ts",
						markers: ["export class JsonlSessionRepo", "metadata: options.metadata"],
					},
				],
				testEvidence: [
					{
						path: "packages/agent/test/harness/session/jsonl.test.ts",
						markers: [
							`it("exposes the complete metadata contract"`,
							"expect(await repository.list({ cwd })).toEqual([metadata]);",
						],
					},
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
	},
	69: {
		status: "partial",
		implemented: [
			{
				claim: "rpc-stdio-jsonl",
				behavior: "RPC supports the stdio JSONL transport.",
				ownerModule: "packages/coding-agent/src/modes/rpc/rpc-mode.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/modes/rpc/rpc-mode.ts",
						markers: [
							"export async function runRpcMode",
							"if (options?.listen === undefined) return runStdioRpcMode(runtimeHost);",
						],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/rpc-stdio-tcp-transcript.test.ts",
						markers: [
							`describe("RPC stdio/TCP public transcript parity"`,
							"const stdio = await startStdioRpcMode();",
						],
					},
				],
			},
			{
				claim: "rpc-loopback-tcp-jsonl",
				behavior: "RPC supports loopback-only TCP JSONL transport.",
				ownerModule: "packages/coding-agent/src/modes/rpc/rpc-transport.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/modes/rpc/rpc-transport.ts",
						markers: [
							"export function createRpcTransport",
							`this.boundAddress = { transport: "tcp", host: RPC_TRANSPORT_LOOPBACK_HOST`,
						],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/rpc-transport.test.ts",
						markers: [
							`describe("RPC TCP transport"`,
							`address: { transport: "tcp", host: "127.0.0.1", port }`,
						],
					},
					{
						path: "packages/coding-agent/test/rpc-stdio-tcp-transcript.test.ts",
						markers: [
							`describe("RPC stdio/TCP public transcript parity"`,
							"const tcp = await startTcpRpcMode();",
						],
					},
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
	},
	111: {
		status: "partial",
		implemented: [
			{
				claim: "native-provider-registry",
				behavior:
					"The immutable Native Subagent registry recognizes in_process, fork, and agent_runtime_host without treating External Connectors as Native providers.",
				ownerModule: "packages/coding-agent/src/core/subagent-registry.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/subagent-registry.ts",
						markers: [
							"export class SubagentProviderRegistryV1",
							"export const AGENT_RUNTIME_HOST_PROVIDER",
						],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/subagent-registry.test.ts",
						markers: [
							`it("registers valid agent providers"`,
							`it("rejects historical external provider descriptors as current Native records"`,
						],
					},
				],
			},
			{
				claim: "native-provider-local-availability",
				behavior: "The in_process and fork Native providers are executable through the canonical product composition.",
				ownerModule: "packages/coding-agent/src/core/subagent-registry.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/subagent-registry.ts",
						markers: ["export const IN_PROCESS_PROVIDER", "export const FORK_PROVIDER", "implementedInThisLine: true"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/subagent-registry.test.ts",
						markers: [
							`it("resolves successfully when capabilities match and provider is implemented"`,
							`expect(resolved.providerKind).toBe("in_process");`,
						],
					},
					{
						path: "packages/coding-agent/test/agent-runtime-composition.test.ts",
						markers: [
							`it("constructs every trusted authority from one canonical public root"`,
							"expect(created.session.getSubagentRegistry()).toBeDefined();",
						],
					},
				],
			},
		],
		deferred: [
			{
				claim: "remote-native-provider-availability",
				behavior: "The remote agent_runtime_host Native provider remains fail-closed unavailable.",
				owner: "14",
			},
		],
	},
	113: {
		status: "partial",
		implemented: [
			{
				claim: "internal-continuation",
				behavior:
					"Native child continuation uses durable spawn lookup and transcript-backed recovery without reviving stale handles.",
				ownerModule: "packages/coding-agent/src/core/subagent-fork-provider.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/subagent-fork-provider.ts",
						markers: ["export class ForkChildAgentProviderV1", "async lookupSpawn(", "async resume("],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/subagent-fork-provider.test.ts",
						markers: [
							`it("resumes by starting a new process from the transcript reference and does not reuse the old handle"`,
							"expect(children[0]).not.toBe(children[1]);",
						],
					},
				],
			},
			{
				claim: "external-continuation",
				behavior:
					"External continuation resumes or reconciles the durable Attempt identity across restart without repeating the vendor effect.",
				ownerModule: "packages/coding-agent/src/core/external-agent-connector.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/external-agent-connector.ts",
						markers: ["export class DurableExternalAgentConnector", "resumeAttempt(", "reconcileAttempt("],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/external-agent-connector-lifecycle.test.ts",
						markers: [
							`it("resumes only an existing mapped Attempt when capability is supported"`,
							"expect(value.driver.calls.spawn).toBe(0);",
						],
					},
					{
						path: "packages/coding-agent/test/agent-runtime-composition.test.ts",
						markers: [
							`it("runs and resumes an External Connector through package-root main after a crash"`,
							"expect(resumed).toMatchObject({ success: true, data: { runId: data.runId } });",
						],
					},
				],
			},
		],
		deferred: [
			{
				claim: "cross-host-continuation",
				behavior: "Cross-host continuation, recovery, and high availability remain outside the single-Host implementation.",
				owner: "14",
			},
		],
	},
	114: {
		status: "partial",
		implemented: [
			{
				claim: "internal-task-executor-admission",
				behavior:
					"Native child execution uses canonical Task, Dispatch, Attempt, AttemptReceipt, TaskResult, and RunReceipt layers.",
				ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/subagent-composition.ts",
						markers: ["export class TrustedSubagentCompositionV1", "executeComposition("],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/subagent-composition.test.ts",
						markers: [
							`it("runs a production chain with ephemeral worktrees, Host settlement, and result_ref delivery"`,
							`taskResult: { status: "succeeded", sourceAttemptReceiptIds:`,
						],
					},
				],
			},
			{
				claim: "external-task-executor-admission",
				behavior:
					"External Connector admission and settlement use the same canonical Task execution and receipt layers without creating AgentInstance.",
				ownerModule: "packages/coding-agent/src/core/external-connector-product.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/external-connector-product.ts",
						markers: ["prepareExternalConnectorProductRun", "executePreparedExternalConnectorProductRun"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/external-agent-integration.test.ts",
						markers: [
							`it("runs Task -> Dispatch -> Attempt -> AttemptReceipt -> TaskResult -> RunReceipt without AgentInstance"`,
							"expect(execution.initialBindingEpoch.agentInstanceId).toBeUndefined();",
						],
					},
					{
						path: "packages/coding-agent/test/agent-runtime-composition.test.ts",
						markers: [
							`it("constructs every trusted authority from one canonical public root"`,
							"expect(created.session.getExternalConnectorRegistry()).toBe(composition.externalConnectorRegistry);",
						],
					},
				],
			},
		],
		deferred: [
			{
				claim: "cross-host-task-executor-fleet",
				behavior: "Cross-host Task Executor admission, fleet operations, and fencing remain outside the single-Host pool.",
				owner: "14",
			},
		],
	},
	132: {
		status: "implemented",
		implemented: [
			{
				claim: "execution-policy-reference",
				behavior:
					"Role and AgentBinding carry canonical ExecutionPolicy references rather than a second inline permission matrix.",
				ownerModule: "packages/agent/src/harness/foundation/role.ts",
				sourceEvidence: [
					{
						path: "packages/agent/src/harness/foundation/role.ts",
						markers: [
							"executionPolicyRef?: VersionedReference",
							"policyRevision: RevisionReference",
							"export const AgentBindingSchema = Type.Object",
							"{ additionalProperties: false }",
						],
					},
				],
				testEvidence: [
					{
						path: "packages/agent/test/harness/foundation-contracts.test.ts",
						markers: [
							`describe("provider-neutral compilation contracts"`,
							`"modelBrokerBindingRevision", "policyRevision", "capabilitySelector"`,
						],
					},
				],
			},
			{
				claim: "seven-resource-child-projection",
				behavior:
					"Child Binding projects instructions, skills, MCP, model, sandbox, Git, and budget with tighten-only proofs.",
				ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/subagent-binding.ts",
						markers: ["export const CHILD_BINDING_PROJECTION_FIELDS", "export function projectChildBindingV1"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/subagent-binding.test.ts",
						markers: [
							`it("projects all seven resources with equal proofs when the child inherits the parent"`,
							"expect(projection.fields.map((field) => field.field)).toEqual([...CHILD_BINDING_PROJECTION_FIELDS]);",
						],
					},
				],
			},
		],
		deferred: [],
	},
	133: {
		status: "implemented",
		implemented: [
			{
				claim: "canonical-protected-paths",
				behavior:
					"Protected-path matching uses canonical workspace-relative paths and rejects traversal, absolute escape, and symlink escape.",
				ownerModule: "packages/coding-agent/src/core/protected-path-policy.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/protected-path-policy.ts",
						markers: ["isCanonicalWorkspaceRelativePath", "classifyProtectedPathOperation"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/protected-path-review.test.ts",
						markers: [
							`it("rejects traversal and outside absolute paths while accepting contained absolute paths"`,
							`it("canonicalizes in-workspace symlink aliases and rejects symlink escapes"`,
						],
					},
				],
			},
			{
				claim: "structured-effects-and-review",
				behavior:
					"Structured effects resolve none, approval, reviewer, and team-enforced review requirements; raw commands require sandbox handling.",
				ownerModule: "packages/coding-agent/src/core/execution-policy.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/execution-policy.ts",
						markers: ["export function authorizePolicyOperation", "resolvePolicyReviewEvidence"],
					},
					{
						path: "packages/coding-agent/src/core/protected-path-policy.ts",
						markers: ["export const POLICY_EFFECTS", "export const POLICY_REVIEW_REQUIREMENTS"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/protected-path-review.test.ts",
						markers: [
							`it("uses exact structured effect categories and scope-bound approval ids"`,
							`it("classifies every raw command as potentially mutating and requires the exact ready sandbox"`,
						],
					},
				],
			},
			{
				claim: "managed-team-review",
				behavior:
					"Scope-bound safe reviewer identity and managed team identity fail closed, and project or user settings cannot widen managed requirements.",
				ownerModule: "packages/coding-agent/src/core/protected-path-policy.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/protected-path-policy.ts",
						markers: ["isSafeReviewerId", "preserveManagedProtectedPathRules", "resolvePolicyReviewEvidence"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/protected-path-review.test.ts",
						markers: [
							`it("requires the managed team identity for team-enforced paths"`,
							`it("rejects project and user attempts to widen managed requirements"`,
						],
					},
				],
			},
			{
				claim: "durable-review-evidence",
				behavior: "Approval and reviewer decisions persist and replay through the canonical Session policy ledger.",
				ownerModule: "packages/coding-agent/src/core/execution-policy-ledger.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/execution-policy-ledger.ts",
						markers: ["export function createPolicyApprovalLedgerRecord", "export class InMemoryExecutionPolicyLedger"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/protected-path-review.test.ts",
						markers: [
							`it("persists and replays review evidence through the existing Session ledger"`,
							`it("durably replays reviewer and team evidence through the production Session composition"`,
						],
					},
				],
			},
		],
		deferred: [],
	},
	135: {
		status: "partial",
		implemented: [
			{
				claim: "worker-two-phase-execution",
				behavior: "Operation Worker separates validated setup from operation activation.",
				ownerModule: "packages/coding-agent/src/core/worker-sandbox-provider.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/worker-sandbox-provider.ts",
						markers: ["const planned = supervisor.preflight", "const activated = await supervisor.activate"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/worker-sandbox-provider.test.ts",
						markers: [
							`it("reserves operation identity before async preflight and spawns only once"`,
							"expect(created).toBe(1);",
						],
					},
				],
			},
			{
				claim: "external-two-phase-admission",
				behavior:
					"External Connector performs read-only admission and persists accepted execution input before transport or driver start.",
				ownerModule: "packages/coding-agent/src/core/external-connector-product.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/external-connector-product.ts",
						markers: [
							"export async function prepareExternalConnectorProductRun",
							"export async function persistExternalConnectorProductAdmissionBeforeAcceptance",
							"export async function persistExternalConnectorProductRunAfterAcceptance",
						],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/external-agent-integration.test.ts",
						markers: [
							`it("rejects unsafe product resources before Goal, Task, Attempt, process, or driver side effects"`,
							"expect(current.supervision.processController.launchCalls).toBe(0);",
						],
					},
					{
						path: "packages/coding-agent/test/external-agent-connector-lifecycle.test.ts",
						markers: [
							`it("keeps createAttempt pure and enforces persist-before-start"`,
							`expect(value.driver.spawnStates).toEqual(["start_intent"]);`,
						],
					},
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
	},
	136: {
		status: "partial",
		implemented: [
			{
				claim: "worker-credential-target",
				behavior:
					"Task credential scope, lease, renewal, revocation, and redacted delivery integrate with Operation Worker targets.",
				ownerModule: "packages/coding-agent/src/core/task-credential-service.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/task-credential-service.ts",
						markers: ["export interface TaskCredentialWorkerTarget", "export class TaskCredentialService"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/task-credential-worker.test.ts",
						markers: [
							`it("projects only safe refs and never sends material to the Worker"`,
							`it("renews with the next lease sequence and revokes idempotently"`,
							"expect(JSON.stringify(worker.projections[0])).not.toContain(SECRET);",
						],
					},
				],
			},
		],
		deferred: [
			{
				claim: "external-credential-target",
				behavior: "External Agent credential targets are not integrated.",
				owner: "T9",
			},
			{
				claim: "production-credential-target",
				behavior: "Production credential target orchestration, vault projection, and DLP remain outside this implementation.",
				owner: "14",
			},
		],
	},
	138: {
		status: "implemented",
		implemented: [
			{
				claim: "exact-mcp-selection",
				behavior: "AgentBinding freezes exact MCP server and tool identities resolved from the Role selector.",
				ownerModule: "packages/agent/src/harness/foundation/mcp-selection.ts",
				sourceEvidence: [
					{
						path: "packages/agent/src/harness/foundation/mcp-selection.ts",
						markers: ["export function resolveMcpSelection", "export function validateMcpSelectionForBinding"],
					},
					{
						path: "packages/coding-agent/src/core/agent-session-facade.ts",
						markers: ["mcpSelectionSource: () => {", "routeCatalog = this.controlPlane.getMcpToolRoutes();"],
					},
					{
						path: "packages/coding-agent/src/core/foundation-control-plane.ts",
						markers: ["getMcpToolRoutes(): readonly McpToolRoute[]", "sourceIdentity"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/mcp-exact-selection.test.ts",
						markers: [
							`it("trims every MCP tool not present in the CapabilityBinding tool allowlist"`,
							`expect(selection.servers[0]?.tools.map((tool) => tool.toolId)).toEqual(["read"]);`,
						],
					},
					{
						path: "packages/coding-agent/test/agent-session-capabilities.test.ts",
						markers: [
							`it("starts MCP discovery lazily and gates the first prompt on readiness"`,
							`expect(session.getActiveCapabilityBinding()?.toolAllowlist).toContain("mcp__docs__list");`,
							`expect(session.getActiveToolNames()).toContain("mcp__docs__list");`,
						],
					},
				],
			},
			{
				claim: "connector-route-intersection",
				behavior:
					"External Connectors receive only routes present in the exact MCP selection, CapabilityBinding allowlist, policy, and immutable route catalog.",
				ownerModule: "packages/coding-agent/src/core/external-agent-registry.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/external-agent-registry.ts",
						markers: [
							"export function bindExternalConnectorToolGatewayConsumer",
							"function routeSelectedByBinding",
							"binding.mcpSelection.servers.find",
						],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/external-connector-registry.test.ts",
						markers: [
							`it("trims MCP routes to the exact server and tool revision selected by the durable binding"`,
							`terminalError: { code: "external_tool_route_denied" }`,
						],
					},
				],
			},
			{
				claim: "child-mcp-no-widen",
				behavior: "Child MCP selection is an exact subset of the parent selection and fails closed on widening.",
				ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/subagent-binding.ts",
						markers: ["export function projectChildBindingV1", "validateChildMcpSelection"],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/mcp-exact-selection.test.ts",
						markers: [
							`it("rejects a child exact set that adds a parent-trimmed tool"`,
							`error: { code: "subagent_binding_projection_invalid" }`,
						],
					},
					{
						path: "packages/coding-agent/test/subagent-binding.test.ts",
						markers: [
							`it("accepts every selectorsNarrow-true MCP combination and rejects widening"`,
							"expect(result.ok).toBe(selectorsNarrow(parentSelector, childSelector));",
						],
					},
				],
			},
			{
				claim: "durable-mcp-inheritance-approval",
				behavior:
					"Policy-required MCP inheritance approval is digest-bound and its evidence identifier persists with the durable child Binding projection.",
				ownerModule: "packages/coding-agent/src/core/subagent-binding.ts",
				sourceEvidence: [
					{
						path: "packages/coding-agent/src/core/subagent-binding.ts",
						markers: [
							"export function createTrustedMcpInheritanceApprovalAuthorityV1",
							"mcpApprovalEvidenceId",
						],
					},
				],
				testEvidence: [
					{
						path: "packages/coding-agent/test/subagent-binding.test.ts",
						markers: [
							`it("replays valid approved MCP inheritance from the durable Policy ledger after restart"`,
							`it("persists the projection and inherited MCP approval evidence reference as a durable Session fact"`,
							`expect(projection.mcpApprovalEvidenceId).toBe("policy-entry-2");`,
						],
					},
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
				ownerModule: "packages/agent/src/harness/session/jsonl/repo.ts",
				tests: ["packages/agent/test/harness/session/jsonl.test.ts"],
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
				ownerModule: "packages/coding-agent/src/modes/rpc/rpc-mode.ts",
				tests: ["packages/coding-agent/test/rpc-stdio-tcp-transcript.test.ts"],
			},
			{
				claim: "rpc-loopback-tcp-jsonl",
				behavior: "RPC supports loopback-only TCP JSONL transport.",
				ownerModule: "packages/coding-agent/src/modes/rpc/rpc-transport.ts",
				tests: [
					"packages/coding-agent/test/rpc-transport.test.ts",
					"packages/coding-agent/test/rpc-stdio-tcp-transcript.test.ts",
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
		status: "partial",
		evidence: [
			{
				claim: "native-provider-registry",
				behavior:
					"The immutable Native Subagent registry recognizes in_process, fork, and agent_runtime_host without treating External Connectors as Native providers.",
				ownerModule: "packages/coding-agent/src/core/subagent-registry.ts",
				tests: ["packages/coding-agent/test/subagent-registry.test.ts"],
			},
			{
				claim: "native-provider-local-availability",
				behavior: "The in_process and fork Native providers are executable through the canonical product composition.",
				ownerModule: "packages/coding-agent/src/core/subagent-registry.ts",
				tests: [
					"packages/coding-agent/test/subagent-registry.test.ts",
					"packages/coding-agent/test/agent-runtime-composition.test.ts",
				],
			},
		],
		deferred: [
			{
				claim: "remote-native-provider-availability",
				behavior: "The remote agent_runtime_host Native provider remains fail-closed unavailable.",
				owner: "14",
			},
		],
	}),
	defineTruth({
		id: 113,
		status: "partial",
		evidence: [
			{
				claim: "internal-continuation",
				behavior:
					"Native child continuation uses durable spawn lookup and transcript-backed recovery without reviving stale handles.",
				ownerModule: "packages/coding-agent/src/core/subagent-fork-provider.ts",
				tests: ["packages/coding-agent/test/subagent-fork-provider.test.ts"],
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
		deferred: [
			{
				claim: "cross-host-continuation",
				behavior: "Cross-host continuation, recovery, and high availability remain outside the single-Host implementation.",
				owner: "14",
			},
		],
	}),
	defineTruth({
		id: 114,
		status: "partial",
		evidence: [
			{
				claim: "internal-task-executor-admission",
				behavior:
					"Native child execution uses canonical Task, Dispatch, Attempt, AttemptReceipt, TaskResult, and RunReceipt layers.",
				ownerModule: "packages/coding-agent/src/core/subagent-composition.ts",
				tests: [
					"packages/coding-agent/test/subagent-composition.test.ts",
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
		deferred: [
			{
				claim: "cross-host-task-executor-fleet",
				behavior: "Cross-host Task Executor admission, fleet operations, and fencing remain outside the single-Host pool.",
				owner: "14",
			},
		],
	}),
	defineTruth({
		id: 132,
		status: "implemented",
		evidence: [
			{
				claim: "execution-policy-reference",
				behavior:
					"Role and AgentBinding carry canonical ExecutionPolicy references rather than a second inline permission matrix.",
				ownerModule: "packages/agent/src/harness/foundation/role.ts",
				tests: ["packages/agent/test/harness/foundation-contracts.test.ts"],
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
				tests: ["packages/coding-agent/test/worker-sandbox-provider.test.ts"],
			},
			{
				claim: "external-two-phase-admission",
				behavior:
					"External Connector performs read-only admission and persists accepted execution input before transport or driver start.",
				ownerModule: "packages/coding-agent/src/core/external-connector-product.ts",
				tests: [
					"packages/coding-agent/test/external-agent-integration.test.ts",
					"packages/coding-agent/test/external-agent-connector-lifecycle.test.ts",
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
				tests: ["packages/coding-agent/test/task-credential-worker.test.ts"],
			},
		],
		deferred: [
			{
				claim: "external-credential-target",
				behavior: "External Agent credential targets are not integrated.",
				owner: "T9",
			},
			{
				claim: "production-credential-target",
				behavior: "Production credential target orchestration, vault projection, and DLP remain outside this implementation.",
				owner: "14",
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
				tests: [
					"packages/coding-agent/test/mcp-exact-selection.test.ts",
					"packages/coding-agent/test/agent-session-capabilities.test.ts",
				],
			},
			{
				claim: "connector-route-intersection",
				behavior:
					"External Connectors receive only routes present in the exact MCP selection, CapabilityBinding allowlist, policy, and immutable route catalog.",
				ownerModule: "packages/coding-agent/src/core/external-agent-registry.ts",
				tests: ["packages/coding-agent/test/external-connector-registry.test.ts"],
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
				tests: ["packages/coding-agent/test/subagent-binding.test.ts"],
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

const UNAVAILABLE_BEHAVIOR = /\b(?:unavailable|not implemented|not integrated|remains? outside)\b/i;

/**
 * Reject semantic drift in a candidate manifest.
 *
 * The verifier enforces exact behavior, owners, executable source/test markers,
 * deferred boundaries, derived descriptions, and status for every repaired
 * capability. A path that merely exists is not semantic evidence.
 */
export function verifyLine13T5CapabilityManifest(value: unknown, readEvidence: Line13T5EvidenceReader): void {
	if (typeof readEvidence !== "function") invalidManifest("an executable evidence reader is required");
	if (!Array.isArray(value)) invalidManifest("manifest must be an array");
	const evidenceCache = new Map<string, string>();
	const requireEvidenceFile = (
		required: RequiredEvidenceFile,
		context: string,
	): void => {
		let content = evidenceCache.get(required.path);
		if (content === undefined) {
			content = readEvidence(required.path);
			if (content === undefined) invalidManifest(`${context} evidence file ${required.path} is unavailable`);
			evidenceCache.set(required.path, content);
		}
		for (const marker of required.markers) {
			if (!content.includes(marker)) {
				invalidManifest(`${context} evidence file ${required.path} is missing semantic marker ${marker}`);
			}
		}
	};
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
		if (row.status === "implemented" && requirement.deferred.length !== 0) {
			invalidManifest(`${context} cannot be implemented while behavior is deferred`);
		}
		if (row.status === "partial" && requirement.deferred.length === 0) {
			invalidManifest(`${context} must identify its deferred behavior`);
		}
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
			if (UNAVAILABLE_BEHAVIOR.test(actual.behavior)) {
				invalidManifest(`${context} claim ${required.claim} describes unavailable behavior as implemented`);
			}
			if (actual.behavior !== required.behavior) {
				invalidManifest(`${context} claim ${required.claim} behavior does not match executable semantics`);
			}
			if (actual.ownerModule !== required.ownerModule) {
				invalidManifest(`${context} claim ${required.claim} owner does not implement the claimed behavior`);
			}
			const requiredTests = required.testEvidence.map((entry) => entry.path);
			if (!sameSet(actual.tests, requiredTests)) {
				invalidManifest(`${context} claim ${required.claim} tests do not match executable evidence`);
			}
			for (const source of required.sourceEvidence) requireEvidenceFile(source, `${context} claim ${required.claim}`);
			for (const test of required.testEvidence) requireEvidenceFile(test, `${context} claim ${required.claim}`);
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
			if (actual.behavior !== required.behavior) {
				invalidManifest(`${context} deferred claim ${required.claim} behavior does not match its boundary`);
			}
		}

		const expectedDescription = renderDescription(evidence, deferred);
		if (row.description !== expectedDescription) {
			invalidManifest(`${context} description must be derived from its evidenced and deferred claims`);
		}
	}
}
