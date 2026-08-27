import {
	FoundationError,
	Result,
	createConnectorCapabilitySnapshot,
	fingerprintFoundationValue,
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";
import { createDurableExternalAgentConnector } from "../src/core/external-agent-connector.ts";
import {
	createExternalConnectorRegistry,
	settleExternalConnectorRecoveryFailure,
} from "../src/core/external-agent-registry.ts";
import type {
	ExternalConnectorDurableStore,
	ExternalConnectorExecutionInput,
	ExternalConnectorOperation,
	ExternalConnectorToolGatewayExecution,
	ExternalConnectorToolGatewayIntent,
	ExternalConnectorToolGatewayIntentWrite,
	ExternalConnectorToolGatewayTerminal,
} from "../src/core/external-agent-operation.ts";
import type { CanonicalExternalConnectorMapping } from "../src/core/external-session-mapping.ts";
import type { ExternalConnectorVendorDriver } from "../src/core/vendor-drivers/types.ts";
import { createExternalConnectorTestSupervision } from "./external-connector-test-supervision.ts";

const NOW = "2026-08-28T00:00:00.000Z";
const PROVIDER_ID = "receipt-authority-connector";
const ATTEMPT: Attempt = {
	schemaVersion: 1,
	attemptId: "attempt-receipt-authority",
	dispatchId: "dispatch-receipt-authority",
	taskId: "task-receipt-authority",
	providerId: PROVIDER_ID,
	bindingId: "binding-receipt-authority",
	bindingEpochIds: ["epoch-receipt-authority"],
	status: "running",
	startedAt: NOW,
};

class ReceiptAuthorityStore implements ExternalConnectorDurableStore {
	operation: ExternalConnectorOperation = {
		schemaVersion: 1,
		providerId: PROVIDER_ID,
		attemptId: ATTEMPT.attemptId,
		bindingId: ATTEMPT.bindingId,
		bindingEpochId: ATTEMPT.bindingEpochIds[0]!,
		bindingDigest: fingerprintFoundationValue("receipt-authority-binding"),
		bindingRevision: 1,
		capabilityDigest: fingerprintFoundationValue("receipt-authority-capability"),
		capabilityRevision: 1,
		operationNonce: "receipt-authority-nonce",
		correlation: {
			sessionId: "session-receipt-authority",
			laneId: "main",
			revision: 1,
			taskId: ATTEMPT.taskId,
			dispatchId: ATTEMPT.dispatchId,
			attemptId: ATTEMPT.attemptId,
			bindingId: ATTEMPT.bindingId,
			bindingEpochId: ATTEMPT.bindingEpochIds[0],
			providerId: PROVIDER_ID,
		},
		status: "reconcile_required",
		revision: 4,
		updatedAt: NOW,
		reconcileReason: "driver_state_ambiguous",
	};
	receipt: AttemptReceipt | undefined;
	receiptWrites = 0;
	operationWrites = 0;

	async readAttempt(attemptId: string): Promise<Attempt | undefined> {
		return attemptId === ATTEMPT.attemptId ? ATTEMPT : undefined;
	}
	async readBinding(_bindingId: string): Promise<AgentBinding | undefined> {
		return undefined;
	}
	async readExecutionInput(_taskId: string): Promise<ExternalConnectorExecutionInput | undefined> {
		return undefined;
	}
	async readOperation(attemptId: string): Promise<ExternalConnectorOperation | undefined> {
		return attemptId === ATTEMPT.attemptId ? this.operation : undefined;
	}
	async writeOperation(operation: ExternalConnectorOperation): Promise<ExternalConnectorOperation> {
		this.operationWrites += 1;
		this.operation = operation;
		return operation;
	}
	async readMapping(_attemptId: string): Promise<CanonicalExternalConnectorMapping | undefined> {
		return undefined;
	}
	async writeMapping(
		_mapping: CanonicalExternalConnectorMapping,
	): Promise<CanonicalExternalConnectorMapping> {
		throw new Error("mapping write is outside this regression");
	}
	async readReceipt(attemptId: string): Promise<AttemptReceipt | undefined> {
		return attemptId === ATTEMPT.attemptId ? this.receipt : undefined;
	}
	async writeReceipt(receipt: AttemptReceipt): Promise<AttemptReceipt> {
		this.receiptWrites += 1;
		this.receipt = receipt;
		return receipt;
	}
	async readToolGatewayExecution(
		_attemptId: string,
		_toolCallId: string,
	): Promise<ExternalConnectorToolGatewayExecution | undefined> {
		return undefined;
	}
	async listToolGatewayExecutions(_attemptId: string): Promise<readonly ExternalConnectorToolGatewayExecution[]> {
		return [];
	}
	async writeToolGatewayIntent(
		_intent: ExternalConnectorToolGatewayIntent,
	): Promise<ExternalConnectorToolGatewayIntentWrite> {
		throw new Error("Tool Gateway intent is outside this regression");
	}
	async writeToolGatewayTerminal(
		_terminal: ExternalConnectorToolGatewayTerminal,
	): Promise<ExternalConnectorToolGatewayTerminal> {
		throw new Error("Tool Gateway terminal is outside this regression");
	}
}

describe("External Connector recovery receipt authority", () => {
	it("lets only the selected Connector persist recovery failure and its terminal operation transition", async () => {
		const capability = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: PROVIDER_ID,
			revision: 1,
			protocol: { name: "receipt-authority", version: "1" },
			modelAccess: "none",
			resume: true,
			toolGateway: false,
			artifacts: false,
			images: false,
		});
		const store = new ReceiptAuthorityStore();
		store.operation = { ...store.operation, capabilityDigest: capability.digest };
		const supervision = createExternalConnectorTestSupervision();
		const connector = createDurableExternalAgentConnector({
			providerId: PROVIDER_ID,
			capability,
			capabilityProbe: async () => Result.ok(capability),
			store,
			driver: Object.freeze({ dispose: async () => undefined }) as unknown as ExternalConnectorVendorDriver,
			supervision: supervision.options,
			now: () => NOW,
		});
		const registry = createExternalConnectorRegistry();
		try {
			expect(registry.registerPrepared({
				descriptor: {
					schemaVersion: 1,
					providerId: PROVIDER_ID,
					providerClass: "external_connector",
					revision: capability.revision,
					capabilitySnapshotDigest: capability.digest,
				},
				connector,
			}, capability)).toMatchObject({ ok: true });
			const selected = await registry.select({
				providerId: PROVIDER_ID,
				revision: capability.revision,
				capabilitySnapshotDigest: capability.digest,
			});
			if (!selected.ok) throw selected.error;

			const settlement = settleExternalConnectorRecoveryFailure(
				selected.value,
				ATTEMPT,
				new FoundationError(
					"external_terminal_ambiguous",
					"Private vendor ambiguity must not escape.",
				),
			);
			if (settlement === undefined) throw new Error("Connector recovery authority was not composed");
			const settled = await settlement;
			if (!settled.ok) throw settled.error;

			expect(settled).toMatchObject({
				ok: true,
				value: {
					status: "failed",
					error: { code: "external_terminal_ambiguous" },
					provenance: { producerKind: "external_connector", providerId: PROVIDER_ID },
					sideEffectState: "unknown",
				},
			});
			expect(store.receiptWrites).toBe(1);
			expect(store.operationWrites).toBe(1);
			expect(store.operation).toMatchObject({
				status: "terminal",
				receiptId: `attempt_receipt_${ATTEMPT.attemptId}`,
			});
			expect(store.receipt?.attemptReceiptId).toBe(store.operation.receiptId);
			expect(JSON.stringify(store.receipt)).not.toContain("Private vendor ambiguity");
			expect("settleExternalConnectorRecoveryFailure" in publicApi).toBe(false);
		} finally {
			await registry.dispose();
		}
	});
});
