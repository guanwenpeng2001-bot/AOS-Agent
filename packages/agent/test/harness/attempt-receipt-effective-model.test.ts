import { describe, expect, it } from "vitest";
import {
	parseAttemptReceipt,
	serializeAttemptReceipt,
	validateAttemptReceipt,
	type AttemptReceipt,
} from "../../src/harness/foundation/index.ts";

function receipt(): AttemptReceipt {
	return {
		schemaVersion: 1,
		attemptReceiptId: "receipt-effective-model",
		taskId: "task-effective-model",
		dispatchId: "dispatch-effective-model",
		attemptId: "attempt-effective-model",
		providerId: "connector-effective-model",
		bindingId: "binding-effective-model",
		bindingEpochIds: ["epoch-effective-model"],
		status: "succeeded",
		workerReceiptRefs: [],
		artifacts: [],
		effectiveModel: {
			provider: "bedrock",
			model: "anthropic.claude-model",
			bindingDigest: { algorithm: "sha256", value: "a".repeat(64) },
			observedAt: "2026-09-02T00:00:00.000Z",
			source: "codex_thread_start",
		},
		provenance: {
			producerKind: "external_connector",
			providerId: "connector-effective-model",
			producedAt: "2026-09-02T00:00:00.000Z",
			correlation: {
				sessionId: "session-effective-model",
				laneId: "main",
				taskId: "task-effective-model",
				dispatchId: "dispatch-effective-model",
				attemptId: "attempt-effective-model",
				bindingId: "binding-effective-model",
				bindingEpochId: "epoch-effective-model",
				attemptReceiptId: "receipt-effective-model",
				revision: 1,
			},
		},
		sideEffectState: "none",
	};
}

describe("AttemptReceipt effective model", () => {
	it("round-trips additive external model evidence while accepting historical receipts", () => {
		const current = receipt();
		expect(validateAttemptReceipt(current)).toMatchObject({ ok: true });
		expect(parseAttemptReceipt(serializeAttemptReceipt(current))).toMatchObject({
			ok: true,
			value: { effectiveModel: current.effectiveModel },
		});
		const { effectiveModel: _effectiveModel, ...historical } = current;
		expect(validateAttemptReceipt(historical)).toMatchObject({ ok: true });
	});

	it("rejects model evidence from failed or non-external receipts", () => {
		expect(validateAttemptReceipt({ ...receipt(), status: "failed" })).toMatchObject({ ok: false });
		expect(validateAttemptReceipt({
			...receipt(),
			provenance: { ...receipt().provenance, producerKind: "scheduler" },
		})).toMatchObject({ ok: false });
	});
});
