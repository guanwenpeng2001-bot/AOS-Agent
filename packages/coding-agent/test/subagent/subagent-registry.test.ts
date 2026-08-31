import { describe, expect, it } from "vitest";
import { FoundationError } from "../../../agent/src/harness/foundation/errors.ts";
import {
	Result,
	type ChildAgentProvider,
	type TaskExecutorProvider,
} from "../../../agent/src/internal.ts";
import {
	AGENT_RUNTIME_HOST_PROVIDER,
	FORK_PROVIDER,
	IN_PROCESS_PROVIDER,
	type SubagentProviderDescriptor, type SubagentCapabilityRequirements,
	SubagentProviderRegistry,
} from "../../src/core/subagent/registry.ts";

type NativeExecutable = ChildAgentProvider & TaskExecutorProvider;

function nativeExecutable(providerId: string): NativeExecutable {
	return {
		schemaVersion: 1,
		providerId,
		providerClass: "agent",
		capabilities: async () => [],
		spawn: async () => Result.err(new FoundationError("subagent_lost", "not run")),
		lookupSpawn: async () => Result.ok(undefined),
		resume: async () => Result.err(new FoundationError("subagent_lost", "not run")),
		cancel: async () => Result.ok(undefined),
		createAttempt: async () => Result.err(new FoundationError("subagent_lost", "not run")),
		runAttempt: async () => Result.err(new FoundationError("subagent_lost", "not run")),
		cancelAttempt: async () => Result.ok(undefined),
		dispose: async () => {},
	};
}

describe("SubagentProviderRegistry", () => {
	it("binds only the exact trusted executable at the current descriptor revision", () => {
		const registry = new SubagentProviderRegistry();
		registry.register(IN_PROCESS_PROVIDER);
		const current = nativeExecutable(IN_PROCESS_PROVIDER.descriptor.providerId);
		const spoof = nativeExecutable(IN_PROCESS_PROVIDER.descriptor.providerId);
		expect(() => registry.resolveExecutable(current)).toThrowError(
			new FoundationError(
				"subagent_provider_unavailable",
				"Provider native.in_process is not the trusted current Native Subagent runtime.",
			),
		);
		registry.bindExecutable(current);
		expect(registry.resolveExecutable(current)).toBe(current);
		expect(() => registry.resolveExecutable(spoof)).toThrowError(
			new FoundationError(
				"subagent_provider_unavailable",
				"Provider native.in_process is not the trusted current Native Subagent runtime.",
			),
		);

		registry.register({ ...IN_PROCESS_PROVIDER, revision: 2 });
		expect(() => registry.resolveExecutable(current)).toThrowError(
			new FoundationError(
				"subagent_provider_unavailable",
				"Provider native.in_process is not the trusted current Native Subagent runtime.",
			),
		);
		registry.bindExecutable(spoof, 2);
		expect(registry.resolveExecutable(spoof)).toBe(spoof);
	});

	it("registers valid agent providers", () => {
		const registry = new SubagentProviderRegistry();
		registry.register(IN_PROCESS_PROVIDER);
		registry.register(FORK_PROVIDER);

		const inProcess = registry.get("native.in_process");
		expect(inProcess).toBeDefined();
		expect(inProcess.providerKind).toBe("in_process");

		const fork = registry.get("native.fork");
		expect(fork).toBeDefined();
		expect(fork.providerKind).toBe("fork");
	});

	it("rejects non-agent providerClass and invalid shapes (NaN, negative maxDepth)", () => {
		const registry = new SubagentProviderRegistry();

		const invalidProvider = {
			...IN_PROCESS_PROVIDER,
			descriptor: {
				schemaVersion: 1 as const,
				providerId: "test.worker",
				providerClass: "operation_worker" as const,
			},
		};

		expect(() => registry.register(invalidProvider)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor shape with positive revision and maxDepth and providerClass 'agent'.",
			),
		);

		const negativeMaxDepth = {
			...IN_PROCESS_PROVIDER,
			capabilities: { ...IN_PROCESS_PROVIDER.capabilities, maxDepth: -1 },
		};

		expect(() => registry.register(negativeMaxDepth)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor shape with positive revision and maxDepth and providerClass 'agent'.",
			),
		);

		const nanMaxDepth = {
			...IN_PROCESS_PROVIDER,
			capabilities: { ...IN_PROCESS_PROVIDER.capabilities, maxDepth: NaN },
		};

		expect(() => registry.register(nanMaxDepth)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor shape with positive revision and maxDepth and providerClass 'agent'.",
			),
		);

		const nanRevision = {
			...IN_PROCESS_PROVIDER,
			revision: NaN,
		};

		expect(() => registry.register(nanRevision)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor shape with positive revision and maxDepth and providerClass 'agent'.",
			),
		);
	});

	it("rejects extra keys", () => {
		const registry = new SubagentProviderRegistry();

		const extraTopKey = {
			...IN_PROCESS_PROVIDER,
			extra: true,
		};
		expect(() => registry.register(extraTopKey)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor shape with no extra keys.",
			),
		);

		const extraDescKey = {
			...IN_PROCESS_PROVIDER,
			descriptor: { ...IN_PROCESS_PROVIDER.descriptor, extra: true },
		};
		expect(() => registry.register(extraDescKey)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor.descriptor shape with no extra keys.",
			),
		);

		const extraCapKey = {
			...IN_PROCESS_PROVIDER,
			capabilities: { ...IN_PROCESS_PROVIDER.capabilities, extra: true },
		};
		expect(() => registry.register(extraCapKey)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor.capabilities shape with no extra keys.",
			),
		);
	});

	it("maintains immutability (rejects returned mutation)", () => {
		const registry = new SubagentProviderRegistry();

		const provider: SubagentProviderDescriptor = {
			...IN_PROCESS_PROVIDER,
			descriptor: { schemaVersion: 1, providerId: "native.tamper", providerClass: "agent" },
			capabilities: { ...IN_PROCESS_PROVIDER.capabilities },
		};
		registry.register(provider);

		const retrieved = registry.get("native.tamper");
		expect(() => {
			(retrieved.capabilities as unknown as Record<string, boolean>).resumeSupported = false;
		}).toThrowError();
	});

	it("allows revision upgrade and retrieves exact revision without losing old", () => {
		const registry = new SubagentProviderRegistry();
		const providerRevisionOne: SubagentProviderDescriptor = {
			schemaVersion: 1,
			providerKind: "in_process",
			descriptor: { schemaVersion: 1, providerId: "native.in_process", providerClass: "agent" },
			revision: 1,
			capabilities: {
				resumeSupported: false,
				mailboxSupported: false,
				backgroundSupported: false,
				worktreeSupported: false,
				maxDepth: 1,
			},
			implementedInThisLine: true,
		};
		const providerRevisionTwo = { ...providerRevisionOne, revision: 2, capabilities: { ...providerRevisionOne.capabilities, maxDepth: 2 } };

		registry.register(providerRevisionOne);
		registry.register(providerRevisionTwo);

		expect(registry.get("native.in_process").revision).toBe(2);
		expect(registry.get("native.in_process", 1).revision).toBe(1);
		expect(registry.get("native.in_process", 2).revision).toBe(2);

		expect(registry.resolve("native.in_process", {}, 1).capabilities.maxDepth).toBe(1);
		expect(registry.resolve("native.in_process", {}, 2).capabilities.maxDepth).toBe(2);
		expect(registry.resolve("native.in_process").capabilities.maxDepth).toBe(2);

		expect(() => registry.get("native.in_process", 3)).toThrowError(
			new FoundationError("subagent_provider_unavailable", "Provider native.in_process revision 3 not found."),
		);

		expect(() => registry.register({ ...providerRevisionTwo, revision: 2 })).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Provider native.in_process revision 2 must be greater than existing revision 2.",
			),
		);
		expect(() => registry.register({ ...providerRevisionTwo, revision: 1 })).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Provider native.in_process revision 1 must be greater than existing revision 2.",
			),
		);
	});

	it("validates malformed requirements in resolve", () => {
		const registry = new SubagentProviderRegistry();
		registry.register(IN_PROCESS_PROVIDER);

		expect(() =>
			registry.resolve("native.in_process", {
				forkScope: "invalid_scope",
			} as unknown as SubagentCapabilityRequirements),
		).toThrowError(new FoundationError("subagent_spawn_invalid", "Invalid forkScope: invalid_scope"));

		expect(() =>
			registry.resolve("native.in_process", {
				maxDepthRequired: NaN,
			} as unknown as SubagentCapabilityRequirements),
		).toThrowError(new FoundationError("subagent_spawn_invalid", "Invalid maxDepthRequired: NaN"));

		expect(() =>
			registry.resolve("native.in_process", { maxDepthRequired: -5 } as unknown as SubagentCapabilityRequirements),
		).toThrowError(new FoundationError("subagent_spawn_invalid", "Invalid maxDepthRequired: -5"));

		// Array
		expect(() =>
			registry.resolve("native.in_process", [] as unknown as SubagentCapabilityRequirements),
		).toThrowError(new FoundationError("subagent_spawn_invalid", "Requirements must be an object."));

		// Extra keys
		expect(() =>
			registry.resolve("native.in_process", { extra: true } as unknown as SubagentCapabilityRequirements),
		).toThrowError(
			new FoundationError("subagent_spawn_invalid", "Requirements must have exact shape with no extra keys."),
		);

		// Invalid providerKind
		expect(() =>
			registry.resolve("native.in_process", {
				providerKind: "invalid",
			} as unknown as SubagentCapabilityRequirements),
		).toThrowError(new FoundationError("subagent_spawn_invalid", "Invalid providerKind: invalid"));

		// String boolean
		expect(() =>
			registry.resolve("native.in_process", {
				resumeRequired: "true",
			} as unknown as SubagentCapabilityRequirements),
		).toThrowError(new FoundationError("subagent_spawn_invalid", "resumeRequired must be boolean."));

		// Invalid revision
		expect(() => registry.get("native.in_process", NaN)).toThrowError(
			new FoundationError("subagent_spawn_invalid", "Invalid revision: NaN"),
		);
		expect(() => registry.get("native.in_process", 0)).toThrowError(
			new FoundationError("subagent_spawn_invalid", "Invalid revision: 0"),
		);
	});

	it("allows revision upgrade but rejects stale or duplicate revisions", () => {
		const registry = new SubagentProviderRegistry();

		const provider: SubagentProviderDescriptor = {
			...IN_PROCESS_PROVIDER,
			descriptor: { schemaVersion: 1, providerId: "native.updateable", providerClass: "agent" },
			capabilities: { ...IN_PROCESS_PROVIDER.capabilities },
		};
		registry.register(provider);

		const duplicate = {
			...provider,
			revision: 1,
		};
		expect(() => registry.register(duplicate)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Provider native.updateable revision 1 must be greater than existing revision 1.",
			),
		);

		const stale = {
			...provider,
			revision: 0,
		};
		expect(() => registry.register(stale)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Registry entries must have exact descriptor shape with positive revision and maxDepth and providerClass 'agent'.",
			),
		);

		const upgrade = {
			...provider,
			revision: 2,
			capabilities: { ...provider.capabilities, maxDepth: 20 },
		};
		registry.register(upgrade);

		const retrieved = registry.get("native.updateable");
		expect(retrieved.revision).toBe(2);
		expect(retrieved.capabilities.maxDepth).toBe(20);
	});

	it("rejects registering the same providerKind under a different providerId", () => {
		const registry = new SubagentProviderRegistry();
		registry.register(IN_PROCESS_PROVIDER);

		const kindDuplicate: SubagentProviderDescriptor = {
			...IN_PROCESS_PROVIDER,
			descriptor: { schemaVersion: 1, providerId: "native.tamper.2", providerClass: "agent" },
		};

		expect(() => registry.register(kindDuplicate)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Provider kind in_process is already registered under native.in_process. Registry requires unique kind.",
			),
		);
	});

	it("rejects changing the providerKind of an existing providerId", () => {
		const registry = new SubagentProviderRegistry();
		registry.register(IN_PROCESS_PROVIDER);

		const kindChange: SubagentProviderDescriptor = {
			...IN_PROCESS_PROVIDER,
			providerKind: "fork",
			revision: 2,
		};

		expect(() => registry.register(kindChange)).toThrowError(
			new FoundationError(
				"subagent_spawn_invalid",
				"Provider native.in_process exists with different kind in_process.",
			),
		);
	});

	it("negotiates capabilities correctly and rejects historical external kinds", () => {
		const registry = new SubagentProviderRegistry();
		registry.register(IN_PROCESS_PROVIDER);

		for (const providerKind of ["acp", "sdk"] as const) {
			expect(() =>
				registry.resolve("native.in_process", {
					providerKind,
				} as unknown as SubagentCapabilityRequirements),
			).toThrowError(new FoundationError("subagent_spawn_invalid", `Invalid providerKind: ${providerKind}`));
		}

		expect(() => registry.resolve("native.in_process", { maxDepthRequired: 50 })).toThrowError(
			new FoundationError(
				"subagent_capability_unsupported",
				"Provider native.in_process maxDepth is 10, required 50.",
			),
		);
	});

	it("fails closed on unavailability before capability checking (unavailable ordering)", () => {
		const registry = new SubagentProviderRegistry();
		registry.register(AGENT_RUNTIME_HOST_PROVIDER);

		// Should throw unavailable because implementedInThisLine is false, NOT unsupported because of maxDepth
		expect(() => registry.resolve("remote.agent_runtime_host", { maxDepthRequired: 50 })).toThrowError(
			new FoundationError(
				"subagent_provider_unavailable",
				"Provider remote.agent_runtime_host is not implemented in this line.",
			),
		);
	});

	it("rejects historical external provider descriptors as current Native records", () => {
		const registry = new SubagentProviderRegistry();
		for (const providerKind of ["acp", "sdk"] as const) {
			const historical = {
				...IN_PROCESS_PROVIDER,
				providerKind,
				descriptor: {
					...IN_PROCESS_PROVIDER.descriptor,
					providerId: `connector.${providerKind}`,
				},
			};
			expect(() => registry.register(historical as unknown as SubagentProviderDescriptor)).toThrowError(
				new FoundationError(
					"subagent_spawn_invalid",
					"Registry entries must have exact descriptor shape with positive revision and maxDepth and providerClass 'agent'.",
				),
			);
		}
	});

	it("resolves successfully when capabilities match and provider is implemented", () => {
		const registry = new SubagentProviderRegistry();
		registry.register(IN_PROCESS_PROVIDER);

		const resolved = registry.resolve("native.in_process", {
			providerKind: "in_process",
			resumeRequired: true,
			mailboxRequired: true,
			maxDepthRequired: 5,
			backgroundRequired: true,
			forkScope: "all",
		});

		expect(resolved).toBeDefined();
		expect(resolved.providerKind).toBe("in_process");
	});
});
