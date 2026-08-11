import { describe, expect, it } from "vitest";
import {
	assertSnapshotMetadataOnly,
	compareContextSources,
	createContextExtensionContributionReceipt,
	createContextExtensionSourceInput,
	digestContextContent,
	estimateContextTextTokens,
	freezeContext,
	resolveContext,
	selectIncludedInstructionBlocks,
	type ContextSourceInput,
} from "../src/core/context-engine.ts";
import { estimateContextTokens } from "../src/core/compaction/compaction.ts";

function source(partial: Partial<ContextSourceInput> & Pick<ContextSourceInput, "sourceId" | "content">): ContextSourceInput {
	return {
		kind: partial.kind ?? "instruction",
		scope: partial.scope ?? "project",
		trust: partial.trust ?? "trusted_project",
		required: partial.required ?? false,
		path: partial.path,
		preDisposition: partial.preDisposition,
		refId: partial.refId,
		sourceId: partial.sourceId,
		content: partial.content,
	};
}

describe("context-engine", () => {
	it("produces deterministic source order, digests, and dispositions for the same input", () => {
		const sources: ContextSourceInput[] = [
			source({
				sourceId: "cap.skills",
				kind: "capability_index",
				scope: "session",
				trust: "builtin",
				content: "skill:foo",
			}),
			source({
				sourceId: "instr.dir",
				kind: "instruction",
				scope: "directory",
				trust: "trusted_project",
				path: "/proj/pkg/AGENTS.md",
				content: "dir rules",
				required: true,
			}),
			source({
				sourceId: "sys.base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: "You are a coding assistant.",
				required: true,
			}),
			source({
				sourceId: "instr.global",
				kind: "instruction",
				scope: "global",
				trust: "user_owned",
				path: "/home/.aos/AGENTS.md",
				content: "global rules",
				required: true,
			}),
			source({
				sourceId: "mem.1",
				kind: "memory",
				scope: "session",
				trust: "user_owned",
				content: "remember prefer tabs",
				refId: "memory-1",
			}),
			source({
				sourceId: "instr.project",
				kind: "instruction",
				scope: "project",
				trust: "trusted_project",
				path: "/proj/AGENTS.md",
				content: "project rules",
				required: true,
			}),
		];

		const input = {
			purpose: "agent_turn" as const,
			sessionId: "sess-1",
			runId: "run-1",
			contextWindow: 100_000,
			reserveTokens: 16_384,
			sources,
			sessionMessages: [],
			turnMessages: [],
		};

		const first = resolveContext(input);
		const second = resolveContext(input);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) {
			return;
		}

		expect(first.plan.sources.map((s) => s.sourceId)).toEqual([
			"sys.base",
			"instr.global",
			"instr.project",
			"instr.dir",
			"mem.1",
			"cap.skills",
		]);
		expect(first.plan.sources.map((s) => s.sourceId)).toEqual(second.plan.sources.map((s) => s.sourceId));
		expect(first.plan.sources.map((s) => s.contentDigest)).toEqual(second.plan.sources.map((s) => s.contentDigest));
		expect(first.plan.sources.map((s) => s.disposition)).toEqual(second.plan.sources.map((s) => s.disposition));
		expect(first.plan.budget).toEqual(second.plan.budget);

		for (const receipt of first.plan.sources) {
			expect(receipt.disposition).toBe("included");
			expect(receipt.reason).toBe("within_budget");
			expect(receipt.contentDigest).toBe(
				digestContextContent(sources.find((s) => s.sourceId === receipt.sourceId)!.content),
			);
			expect(receipt.estimatedTokens).toBe(
				estimateContextTextTokens(sources.find((s) => s.sourceId === receipt.sourceId)!.content),
			);
			expect("content" in receipt).toBe(false);
		}
	});

	it("excludes untrusted project instructions without injecting them into system prompt", () => {
		const sources: ContextSourceInput[] = [
			source({
				sourceId: "sys.base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: "base system",
				required: true,
			}),
			source({
				sourceId: "instr.untrusted",
				kind: "instruction",
				scope: "project",
				trust: "untrusted_project",
				path: "/tmp/untrusted/AGENTS.md",
				content: "SECRET_UNTRUSTED_RULE",
				required: false,
			}),
		];

		const result = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-1",
			contextWindow: 100_000,
			reserveTokens: 1_000,
			sources,
			sessionMessages: [],
			turnMessages: [],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		const untrusted = result.plan.sources.find((s) => s.sourceId === "instr.untrusted");
		expect(untrusted?.disposition).toBe("excluded");
		expect(untrusted?.reason).toBe("untrusted");
		expect(result.plan.systemPrompt).toContain("base system");
		expect(result.plan.systemPrompt).not.toContain("SECRET_UNTRUSTED_RULE");

		const blocks = selectIncludedInstructionBlocks(result.plan, sources);
		expect(blocks.map((b) => b.sourceId)).toEqual([]);
	});

	it("returns context_budget_exceeded when required sources exceed the input limit", () => {
		const huge = "x".repeat(400); // 100 tokens
		const sources: ContextSourceInput[] = [
			source({
				sourceId: "sys.base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: huge,
				required: true,
			}),
			source({
				sourceId: "instr.project",
				kind: "instruction",
				scope: "project",
				trust: "trusted_project",
				content: huge,
				required: true,
			}),
		];

		// inputLimit = 150 - 20 = 130; first required uses 100, second does not fit.
		const result = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-1",
			contextWindow: 150,
			reserveTokens: 20,
			sources,
			sessionMessages: [],
			turnMessages: [],
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.error.code).toBe("context_budget_exceeded");
		expect(result.error.retryable).toBe(false);
		expect(result.error.offendingSourceIds).toContain("instr.project");
		expect(result.error.budget?.inputLimit).toBe(130);
	});

	it("excludes optional sources for budget without failing the plan", () => {
		const huge = "y".repeat(400); // 100 tokens
		const sources: ContextSourceInput[] = [
			source({
				sourceId: "sys.base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: huge,
				required: true,
			}),
			source({
				sourceId: "mem.optional",
				kind: "memory",
				scope: "session",
				trust: "user_owned",
				content: huge,
				required: false,
				refId: "m1",
			}),
			source({
				sourceId: "cap.index",
				kind: "capability_index",
				scope: "session",
				trust: "builtin",
				content: huge,
				required: false,
			}),
		];

		const result = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-1",
			contextWindow: 150,
			reserveTokens: 20,
			sources,
			sessionMessages: [],
			turnMessages: [],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.plan.sources.find((s) => s.sourceId === "sys.base")?.disposition).toBe("included");
		expect(result.plan.sources.find((s) => s.sourceId === "mem.optional")?.disposition).toBe("excluded");
		expect(result.plan.sources.find((s) => s.sourceId === "mem.optional")?.reason).toBe("budget_exhausted");
		expect(result.plan.sources.find((s) => s.sourceId === "cap.index")?.reason).toBe("budget_exhausted");
	});

	it("keeps optional extensions behind memory and the capability index", () => {
		const systemContent = "system";
		const memoryContent = "memory";
		const capabilityContent = "capability";
		const optionalExtensionContent = "extension".repeat(100);
		const inputLimit =
			estimateContextTextTokens(systemContent) + estimateContextTextTokens(optionalExtensionContent);

		const result = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-1",
			contextWindow: inputLimit,
			reserveTokens: 0,
			sources: [
				source({
					sourceId: "extension.optional",
					kind: "extension",
					scope: "turn",
					trust: "user_owned",
					content: optionalExtensionContent,
				}),
				source({
					sourceId: "capability.index",
					kind: "capability_index",
					scope: "session",
					trust: "builtin",
					content: capabilityContent,
				}),
				source({
					sourceId: "memory.session",
					kind: "memory",
					scope: "session",
					trust: "user_owned",
					content: memoryContent,
				}),
				source({
					sourceId: "system.base",
					kind: "system",
					scope: "global",
					trust: "builtin",
					content: systemContent,
					required: true,
				}),
			],
			sessionMessages: [],
			turnMessages: [],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.plan.sources.map((receipt) => receipt.sourceId)).toEqual([
			"system.base",
			"memory.session",
			"capability.index",
			"extension.optional",
		]);
		expect(result.plan.sources.find((receipt) => receipt.sourceId === "memory.session")?.disposition).toBe(
			"included",
		);
		expect(result.plan.sources.find((receipt) => receipt.sourceId === "capability.index")?.disposition).toBe(
			"included",
		);
		expect(result.plan.sources.find((receipt) => receipt.sourceId === "extension.optional")?.disposition).toBe(
			"excluded",
		);
	});

	it("accounts transcript message sources once while retaining their receipt token estimate", () => {
		const message = { role: "user" as const, content: "turn body", timestamp: 0 };
		const sources: ContextSourceInput[] = [
			source({
				sourceId: "sys.base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: "base",
				required: true,
			}),
			{
				sourceId: "session:message:0",
				kind: "session_message",
				scope: "session",
				trust: "builtin",
				content: JSON.stringify(message),
				required: true,
				placement: "message",
				message,
				alreadyIncludedInMessages: true,
			},
		];
		const result = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-1",
			contextWindow: 10_000,
			reserveTokens: 1_000,
			sources,
			sessionMessages: [message],
			turnMessages: [],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const receipt = result.plan.sources.find((entry) => entry.sourceId === "session:message:0");
		expect(receipt?.estimatedTokens).toBe(estimateContextTokens([message]).tokens);
		expect(result.plan.budget.estimatedInputTokens).toBe(
			estimateContextTextTokens("base") + estimateContextTokens([message]).tokens,
		);
		expect(result.plan.messages).toEqual([message]);
	});

	it("honors disabled and revoked pre-dispositions", () => {
		const sources: ContextSourceInput[] = [
			source({
				sourceId: "sys.base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: "base",
				required: true,
			}),
			source({
				sourceId: "mem.disabled",
				kind: "memory",
				scope: "project",
				trust: "user_owned",
				content: "should not inject",
				preDisposition: { disposition: "excluded", reason: "disabled" },
			}),
			source({
				sourceId: "mem.revoked",
				kind: "memory",
				scope: "session",
				trust: "user_owned",
				content: "revoked body",
				preDisposition: { disposition: "excluded", reason: "revoked" },
			}),
		];

		const result = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-1",
			contextWindow: 10_000,
			reserveTokens: 100,
			sources,
			sessionMessages: [],
			turnMessages: [],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.plan.sources.find((s) => s.sourceId === "mem.disabled")?.reason).toBe("disabled");
		expect(result.plan.sources.find((s) => s.sourceId === "mem.revoked")?.reason).toBe("revoked");
		expect(result.plan.systemPrompt).not.toContain("should not inject");
		expect(result.plan.systemPrompt).not.toContain("revoked body");
	});

	it("excludes untrusted sources regardless of their kind", () => {
		const result = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-1",
			contextWindow: 10_000,
			reserveTokens: 100,
			sources: [
				source({
					sourceId: "system.base",
					kind: "system",
					scope: "global",
					trust: "builtin",
					content: "trusted system",
					required: true,
				}),
				source({
					sourceId: "extension.untrusted",
					kind: "extension",
					scope: "turn",
					trust: "untrusted_project",
					content: "UNTRUSTED_EXTENSION_BODY",
				}),
			],
			sessionMessages: [],
			turnMessages: [],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		const receipt = result.plan.sources.find((source) => source.sourceId === "extension.untrusted");
		expect(receipt).toMatchObject({ disposition: "excluded", reason: "untrusted" });
		expect(result.plan.systemPrompt).not.toContain("UNTRUSTED_EXTENSION_BODY");
	});

	it("freezes a metadata-only snapshot without raw content", () => {
		const sources: ContextSourceInput[] = [
			source({
				sourceId: "sys.base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: "SENSITIVE_SYSTEM_BODY",
				required: true,
			}),
		];
		const resolved = resolveContext({
			purpose: "compaction",
			sessionId: "sess-1",
			runId: "run-9",
			contextWindow: 8_000,
			reserveTokens: 1_000,
			sources,
			sessionMessages: [],
			turnMessages: [],
		});
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) {
			return;
		}

		const snapshot = freezeContext(resolved.plan, {
			id: "snap-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			parentSnapshotId: "snap-0",
		});

		expect(snapshot.schemaVersion).toBe(1);
		expect(snapshot.id).toBe("snap-1");
		expect(snapshot.purpose).toBe("compaction");
		expect(snapshot.parentSnapshotId).toBe("snap-0");
		expect(snapshot.runId).toBe("run-9");
		expect(snapshot.sources[0]?.contentDigest).toBe(digestContextContent("SENSITIVE_SYSTEM_BODY"));
		assertSnapshotMetadataOnly(snapshot);

		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain("SENSITIVE_SYSTEM_BODY");
		expect(serialized).not.toContain('"messages"');
		expect(serialized).not.toContain('"systemPrompt"');
	});

	it("detects source_changed and source_unavailable via digest comparison", () => {
		const original: ContextSourceInput[] = [
			source({
				sourceId: "instr.project",
				kind: "instruction",
				scope: "project",
				trust: "trusted_project",
				path: "/proj/AGENTS.md",
				content: "version-one",
				required: true,
			}),
			source({
				sourceId: "sys.base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: "stable",
				required: true,
			}),
		];

		const resolved = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-1",
			contextWindow: 50_000,
			reserveTokens: 1_000,
			sources: original,
			sessionMessages: [],
			turnMessages: [],
		});
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) {
			return;
		}
		const snapshot = freezeContext(resolved.plan, {
			id: "snap-hist",
			createdAt: "2026-01-02T00:00:00.000Z",
		});

		const drifts = compareContextSources(snapshot, [
			{ sourceId: "sys.base", content: "stable" },
			{ sourceId: "instr.project", content: "version-two", path: "/proj/AGENTS.md" },
			// instr.missing intentionally absent from snapshot only side is covered below
		]);

		expect(drifts.find((d) => d.sourceId === "sys.base")?.status).toBe("unchanged");
		expect(drifts.find((d) => d.sourceId === "instr.project")?.status).toBe("source_changed");
		expect(drifts.find((d) => d.sourceId === "instr.project")?.previousDigest).toBe(
			digestContextContent("version-one"),
		);
		expect(drifts.find((d) => d.sourceId === "instr.project")?.currentDigest).toBe(
			digestContextContent("version-two"),
		);

		const unavailable = compareContextSources(snapshot, [{ sourceId: "sys.base", content: "stable" }]);
		expect(unavailable.find((d) => d.sourceId === "instr.project")?.status).toBe("source_unavailable");
		expect(unavailable.find((d) => d.sourceId === "instr.project")?.previousDigest).toBe(
			digestContextContent("version-one"),
		);

		const moved = compareContextSources(snapshot, [
			{ sourceId: "sys.base", content: "stable" },
			{ sourceId: "instr.project", content: "version-one", path: "/proj/renamed-AGENTS.md" },
		]);
		expect(moved.find((d) => d.sourceId === "instr.project")?.status).toBe("source_changed");
	});

	it("selects included instruction blocks in plan order for system-prompt rendering", () => {
		const sources: ContextSourceInput[] = [
			source({
				sourceId: "sys.base",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: "sys",
				required: true,
			}),
			source({
				sourceId: "instr.a",
				kind: "instruction",
				scope: "global",
				trust: "user_owned",
				path: "a.md",
				content: "A",
				required: true,
			}),
			source({
				sourceId: "instr.b",
				kind: "instruction",
				scope: "project",
				trust: "trusted_project",
				path: "b.md",
				content: "B",
				required: true,
			}),
		];
		const resolved = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-1",
			contextWindow: 50_000,
			reserveTokens: 1_000,
			sources,
			sessionMessages: [],
			turnMessages: [],
		});
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) {
			return;
		}
		const blocks = selectIncludedInstructionBlocks(resolved.plan, sources);
		expect(blocks.map((b) => b.sourceId)).toEqual(["instr.a", "instr.b"]);
		expect(blocks.map((b) => b.content)).toEqual(["A", "B"]);
	});

	it("plans labeled extension contributions with exact token receipts and no persisted body", () => {
		const contribution = {
			sourceId: "extension:test-contribution",
			label: "Test contribution",
			visibility: "model_and_snapshot" as const,
			messages: [{ role: "user" as const, content: "CONTRIBUTION_MESSAGE", timestamp: 0 }],
			systemPromptAppend: "CONTRIBUTION_PROMPT",
		};
		const extensionSource = createContextExtensionSourceInput(contribution);
		const contributionReceipt = createContextExtensionContributionReceipt(contribution);
		const resolved = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-extensions",
			contextWindow: 100_000,
			reserveTokens: 1_000,
			sources: [
				source({
					sourceId: "system:base",
					kind: "system",
					scope: "global",
					trust: "builtin",
					content: "BASE_SYSTEM",
					required: true,
				}),
				extensionSource,
			],
			sessionMessages: [],
			turnMessages: [],
		});

		expect(resolved.ok).toBe(true);
		if (!resolved.ok) {
			return;
		}
		const receipt = resolved.plan.sources.find((entry) => entry.sourceId === contribution.sourceId);
		expect(receipt).toMatchObject({
			sourceId: contribution.sourceId,
			label: contribution.label,
			visibility: contribution.visibility,
			contentDigest: contributionReceipt.contentDigest,
			estimatedTokens: contributionReceipt.estimatedTokens,
			disposition: "included",
		});
		expect(resolved.plan.systemPrompt).toContain("CONTRIBUTION_PROMPT");
		expect(resolved.plan.messages).toEqual(contribution.messages);

		const snapshot = freezeContext(resolved.plan, { id: "extension-snapshot", createdAt: "2026-01-01T00:00:00.000Z" });
		expect(JSON.stringify(snapshot)).not.toContain("CONTRIBUTION_MESSAGE");
		expect(JSON.stringify(snapshot)).not.toContain("CONTRIBUTION_PROMPT");
	});

	it("records snapshot_only extension contributions without placing their bodies in model input", () => {
		const contribution = {
			sourceId: "extension:snapshot-only",
			label: "Snapshot-only contribution",
			visibility: "snapshot_only" as const,
			messages: [{ role: "user" as const, content: "SNAPSHOT_ONLY_MESSAGE", timestamp: 0 }],
			systemPromptAppend: "SNAPSHOT_ONLY_PROMPT",
		};
		const result = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-snapshot-only",
			contextWindow: 100_000,
			reserveTokens: 1_000,
			sources: [
				source({
					sourceId: "system:base",
					kind: "system",
					scope: "global",
					trust: "builtin",
					content: "BASE_SYSTEM",
					required: true,
				}),
				createContextExtensionSourceInput(contribution),
			],
			sessionMessages: [],
			turnMessages: [],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.plan.sources.find((entry) => entry.sourceId === contribution.sourceId)).toMatchObject({
			disposition: "excluded",
			reason: "snapshot_only",
			label: contribution.label,
			visibility: contribution.visibility,
		});
		expect(result.plan.systemPrompt).not.toContain("SNAPSHOT_ONLY_PROMPT");
		expect(JSON.stringify(result.plan.messages)).not.toContain("SNAPSHOT_ONLY_MESSAGE");
	});

	it("rejects duplicate source IDs before a plan can overwrite a receipt", () => {
		const result = resolveContext({
			purpose: "agent_turn",
			sessionId: "sess-duplicate",
			contextWindow: 100_000,
			reserveTokens: 1_000,
			sources: [
				source({ sourceId: "duplicate", kind: "system", content: "first", required: true }),
				source({ sourceId: "duplicate", kind: "extension", content: "second" }),
			],
			sessionMessages: [],
			turnMessages: [],
		});

		expect(result).toMatchObject({ ok: false, error: { code: "context_source_unavailable" } });
	});
});
