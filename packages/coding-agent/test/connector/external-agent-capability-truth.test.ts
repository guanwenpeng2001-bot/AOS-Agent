import { describe, expect, it } from "vitest";
import {
	createExternalCapabilityTruthSnapshot,
	decideExternalCapabilitySnapshot,
	validateExternalCapabilityTruthSnapshot,
	type ExternalCapabilityBehavior,
	type ExternalCapabilityBehaviorEvidenceInput,
	type ExternalCapabilityEvidenceInput,
	type ExternalCapabilityTruthFlags,
} from "../../src/core/connector/model-projection.ts";

function behaviorEvidence(id: string): ExternalCapabilityBehaviorEvidenceInput {
	return {
		declaration: { id: `declaration-${id}`, revision: 1, reachable: true },
		handler: { id: `handler-${id}`, invoke: () => undefined },
	};
}

function flags(overrides: Partial<ExternalCapabilityTruthFlags> = {}): ExternalCapabilityTruthFlags {
	return {
		resume: false,
		toolGateway: false,
		artifacts: false,
		images: false,
		modelAccess: "agent_owned",
		...overrides,
	};
}

function truthInput(
	capabilities: ExternalCapabilityTruthFlags,
	evidence?: ExternalCapabilityEvidenceInput,
) {
	return {
		connectorId: "third-party-connector",
		protocol: "third-party-protocol",
		capabilityVersion: 1,
		capabilities,
		...(evidence === undefined ? {} : { evidence }),
	};
}

describe("external capability truth", () => {
	it("binds every true capability to reachable declaration and handler evidence", () => {
		let invoked = false;
		const evidence: ExternalCapabilityEvidenceInput = {
			resume: behaviorEvidence("resume"),
			toolGateway: behaviorEvidence("tool-gateway"),
			artifacts: behaviorEvidence("artifacts"),
			images: behaviorEvidence("images"),
			aosGateway: {
				declaration: { id: "declaration-model-gateway", revision: 3, reachable: true },
				handler: {
					id: "handler-model-gateway",
					invoke: () => {
						invoked = true;
					},
				},
			},
		};
		const result = createExternalCapabilityTruthSnapshot(
			truthInput(
				flags({ resume: true, toolGateway: true, artifacts: true, images: true, modelAccess: "aos_gateway" }),
				evidence,
			),
		);

		expect(result.ok).toBe(true);
		expect(invoked).toBe(false);
		if (result.ok) {
			expect(validateExternalCapabilityTruthSnapshot(result.snapshot)).toBe(true);
			expect(result.snapshot.evidence).toEqual({
				resume: { declarationId: "declaration-resume", declarationRevision: 1, handlerId: "handler-resume" },
				toolGateway: {
					declarationId: "declaration-tool-gateway",
					declarationRevision: 1,
					handlerId: "handler-tool-gateway",
				},
				artifacts: {
					declarationId: "declaration-artifacts",
					declarationRevision: 1,
					handlerId: "handler-artifacts",
				},
				images: { declarationId: "declaration-images", declarationRevision: 1, handlerId: "handler-images" },
				aosGateway: {
					declarationId: "declaration-model-gateway",
					declarationRevision: 3,
					handlerId: "handler-model-gateway",
				},
			});
			expect(Object.isFrozen(result.snapshot)).toBe(true);
			expect(Object.isFrozen(result.snapshot.evidence)).toBe(true);
		}
	});

	it("fails closed when any true behavior lacks evidence", () => {
		const cases: ReadonlyArray<{
			readonly behavior: ExternalCapabilityBehavior;
			readonly capabilities: ExternalCapabilityTruthFlags;
		}> = [
			{ behavior: "resume", capabilities: flags({ resume: true }) },
			{ behavior: "toolGateway", capabilities: flags({ toolGateway: true }) },
			{ behavior: "artifacts", capabilities: flags({ artifacts: true }) },
			{ behavior: "images", capabilities: flags({ images: true }) },
			{ behavior: "aosGateway", capabilities: flags({ modelAccess: "aos_gateway" }) },
		];
		for (const testCase of cases) {
			expect(createExternalCapabilityTruthSnapshot(truthInput(testCase.capabilities))).toMatchObject({
				ok: false,
				error: {
					code: "external_capability_mismatch",
					reasonCode: "capability_evidence_missing",
					field: testCase.behavior,
				},
			});
		}
	});

	it("does not require model-gateway evidence for none or agent_owned", () => {
		for (const modelAccess of ["none", "agent_owned"] as const) {
			const result = createExternalCapabilityTruthSnapshot(truthInput(flags({ modelAccess })));
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.snapshot.evidence).toEqual({});
		}
	});

	it("rejects evidence for a capability declared false", () => {
		expect(
			createExternalCapabilityTruthSnapshot(
				truthInput(flags(), { resume: behaviorEvidence("resume") }),
			),
		).toMatchObject({
			ok: false,
			error: { reasonCode: "capability_evidence_unbound", field: "resume" },
		});
	});

	it("rejects non-reachable declarations, missing handlers, unknown access, and unknown keys", () => {
		expect(
			createExternalCapabilityTruthSnapshot(
				truthInput(flags({ resume: true }), {
					resume: {
						declaration: { id: "resume-declaration", revision: 1, reachable: false },
						handler: { id: "resume-handler", invoke: () => undefined },
					} as unknown as ExternalCapabilityBehaviorEvidenceInput,
				}),
			),
		).toMatchObject({ ok: false, error: { reasonCode: "capability_snapshot_invalid" } });
		expect(
			createExternalCapabilityTruthSnapshot({
				...truthInput(flags()),
				capabilities: { ...flags(), modelAccess: "unknown" },
			}),
		).toMatchObject({ ok: false, error: { reasonCode: "capability_snapshot_invalid" } });
		expect(
			createExternalCapabilityTruthSnapshot({ ...truthInput(flags()), vendorCapabilities: { magic: true } }),
		).toMatchObject({ ok: false, error: { reasonCode: "capability_snapshot_invalid" } });
	});
});

describe("capability snapshot digest and drift", () => {
	it("produces the same stable digest regardless of evidence input order", () => {
		const capabilities = flags({ resume: true, images: true });
		const first = createExternalCapabilityTruthSnapshot(
			truthInput(capabilities, { resume: behaviorEvidence("resume"), images: behaviorEvidence("images") }),
		);
		const second = createExternalCapabilityTruthSnapshot(
			truthInput(capabilities, { images: behaviorEvidence("images"), resume: behaviorEvidence("resume") }),
		);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (first.ok && second.ok) expect(first.snapshot.snapshotDigest).toEqual(second.snapshot.snapshotDigest);
	});

	it("changes the digest when capability or handler evidence drifts", () => {
		const initial = createExternalCapabilityTruthSnapshot(
			truthInput(flags({ resume: true }), { resume: behaviorEvidence("resume") }),
		);
		const handlerDrift = createExternalCapabilityTruthSnapshot(
			truthInput(flags({ resume: true }), {
				resume: {
					declaration: { id: "declaration-resume", revision: 1, reachable: true },
					handler: { id: "handler-resume-v2", invoke: () => undefined },
				},
			}),
		);
		const capabilityDrift = createExternalCapabilityTruthSnapshot(truthInput(flags()));
		if (!initial.ok || !handlerDrift.ok || !capabilityDrift.ok) throw new Error("expected snapshots");
		expect(handlerDrift.snapshot.snapshotDigest).not.toEqual(initial.snapshot.snapshotDigest);
		expect(capabilityDrift.snapshot.snapshotDigest).not.toEqual(initial.snapshot.snapshotDigest);
	});

	it("accepts a pinned digest and returns a detached frozen snapshot", () => {
		const created = createExternalCapabilityTruthSnapshot(truthInput(flags()));
		if (!created.ok) throw new Error("expected snapshot");
		const decision = decideExternalCapabilitySnapshot(created.snapshot.snapshotDigest, created.snapshot);
		expect(decision).toMatchObject({ ok: true, status: "accepted" });
		if (decision.ok) {
			expect(decision.snapshot).not.toBe(created.snapshot);
			expect(Object.isFrozen(decision.snapshot)).toBe(true);
		}
	});

	it("turns digest drift into reconcile_required or a stable failed decision", () => {
		const initial = createExternalCapabilityTruthSnapshot(truthInput(flags()));
		const observed = createExternalCapabilityTruthSnapshot(
			truthInput(flags({ images: true }), { images: behaviorEvidence("images") }),
		);
		if (!initial.ok || !observed.ok) throw new Error("expected snapshots");
		expect(decideExternalCapabilitySnapshot(initial.snapshot.snapshotDigest, observed.snapshot)).toEqual({
			ok: false,
			status: "reconcile_required",
			error: {
				code: "external_capability_mismatch",
				reasonCode: "capability_snapshot_drift",
				retryable: false,
			},
		});
		expect(
			decideExternalCapabilitySnapshot(initial.snapshot.snapshotDigest, observed.snapshot, "fail_closed"),
		).toMatchObject({
			ok: false,
			status: "failed",
			error: { code: "external_capability_mismatch", reasonCode: "capability_snapshot_drift", retryable: false },
		});
	});

	it("rejects malformed or digest-tampered snapshots", () => {
		const created = createExternalCapabilityTruthSnapshot(truthInput(flags()));
		if (!created.ok) throw new Error("expected snapshot");
		const tampered = {
			...created.snapshot,
			capabilities: { ...created.snapshot.capabilities, resume: true },
		};
		expect(validateExternalCapabilityTruthSnapshot(tampered)).toBe(false);
		expect(decideExternalCapabilitySnapshot(created.snapshot.snapshotDigest, tampered)).toMatchObject({
			ok: false,
			status: "failed",
			error: { reasonCode: "capability_snapshot_invalid" },
		});
	});
});
