import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { validateAttemptReceipt, validateWorkerReceipt, type AttemptReceiptV1, type WorkerReceiptV1 } from "./results.ts";
import type { AttemptProviderClassV1 } from "./task.ts";

export interface ProviderReceiptConformanceV1 {
	providerId: string;
	providerClass: "operation_worker" | AttemptProviderClassV1;
}

/** Operation workers may emit only WorkerReceipt; executors emit AttemptReceipt. */
export function validateWorkerReceiptForProviderV1(value: unknown, provider: ProviderReceiptConformanceV1): ResultValue<WorkerReceiptV1, FoundationError> {
	if (provider.providerClass !== "operation_worker") return Result.err(new FoundationError("worker_receipt_invalid_producer", "Only operation workers may emit WorkerReceipt", { details: { providerId: provider.providerId } }));
	const checked = validateWorkerReceipt(value);
	if (!checked.ok) return checked;
	return checked.value.sandboxProviderId === provider.providerId && checked.value.provenance.providerId === provider.providerId
		? checked
		: Result.err(new FoundationError("worker_receipt_invalid_producer", "WorkerReceipt provider identity does not match its producer", { details: { providerId: provider.providerId } }));
}

/** Provider class selects the allowed producer and AgentInstance ownership. */
export function validateAttemptReceiptForProviderV1(value: unknown, provider: ProviderReceiptConformanceV1): ResultValue<AttemptReceiptV1, FoundationError> {
	if (provider.providerClass === "operation_worker") return Result.err(new FoundationError("task_executor_invalid_provider_class", "Operation workers cannot settle AttemptReceipt", { details: { providerId: provider.providerId } }));
	const checked = validateAttemptReceipt(value, { providerClass: provider.providerClass });
	if (!checked.ok) return checked;
	return checked.value.providerId === provider.providerId && checked.value.provenance.providerId === provider.providerId
		? checked
		: Result.err(new FoundationError("worker_receipt_invalid_producer", "AttemptReceipt provider identity does not match its producer", { details: { providerId: provider.providerId } }));
}

export const validateWorkerReceiptForProvider = validateWorkerReceiptForProviderV1;
export const validateAttemptReceiptForProvider = validateAttemptReceiptForProviderV1;
