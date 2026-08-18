import { describe, expect, it } from "vitest";
import {
	negotiateProtocolV1,
	validateAttemptReceiptForProviderV1,
	validateWorkerReceiptForProviderV1,
} from "../../src/harness/foundation/index.ts";

const capabilities = (min: number, max: number) => ({
	versions: { min, max },
	features: ["observer.attach"] as const,
});

describe("Foundation provider and transport conformance", () => {
	it("negotiates a version present in the feature matrix", () => {
		const result = negotiateProtocolV1(capabilities(1, 1), capabilities(1, 1));

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.version).toBe(1);
	});

	it("fails closed when the common range has no protocol matrix entry", () => {
		const result = negotiateProtocolV1(capabilities(2, 2), capabilities(2, 2));

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("protocol_unsupported_version");
	});

	it("keeps receipt producers bound to their provider class", () => {
		const workerResult = validateWorkerReceiptForProviderV1(undefined, {
			providerId: "worker-1",
			providerClass: "task_executor",
		});
		const attemptResult = validateAttemptReceiptForProviderV1(undefined, {
			providerId: "worker-1",
			providerClass: "operation_worker",
		});

		expect(workerResult.ok).toBe(false);
		expect(attemptResult.ok).toBe(false);
	});
});
