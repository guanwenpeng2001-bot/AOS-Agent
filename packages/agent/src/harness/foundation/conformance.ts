import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { validateAttemptReceipt, validateWorkerReceipt, type AttemptReceipt, type WorkerReceipt } from "./results.ts";
import type { AttemptProviderClass } from "./task.ts";

export interface ProviderReceiptConformance {
	providerId: string;
	providerClass: "operation_worker" | AttemptProviderClass;
}

/** Operation workers may emit only WorkerReceipt; executors emit AttemptReceipt. */
export function validateWorkerReceiptForProvider(value: unknown, provider: ProviderReceiptConformance): ResultValue<WorkerReceipt, FoundationError> {
	if (provider.providerClass !== "operation_worker") return Result.err(new FoundationError("worker_receipt_invalid_producer", "Only operation workers may emit WorkerReceipt", { details: { providerId: provider.providerId } }));
	const checked = validateWorkerReceipt(value);
	if (!checked.ok) return checked;
	return checked.value.sandboxProviderId === provider.providerId && checked.value.provenance.providerId === provider.providerId
		? checked
		: Result.err(new FoundationError("worker_receipt_invalid_producer", "WorkerReceipt provider identity does not match its producer", { details: { providerId: provider.providerId } }));
}

/** Provider class selects the allowed producer and AgentInstance ownership. */
export function validateAttemptReceiptForProvider(value: unknown, provider: ProviderReceiptConformance): ResultValue<AttemptReceipt, FoundationError> {
	if (provider.providerClass === "operation_worker") return Result.err(new FoundationError("task_executor_invalid_provider_class", "Operation workers cannot settle AttemptReceipt", { details: { providerId: provider.providerId } }));
	const checked = validateAttemptReceipt(value, { providerClass: provider.providerClass });
	if (!checked.ok) return checked;
	return checked.value.providerId === provider.providerId && checked.value.provenance.providerId === provider.providerId
		? checked
		: Result.err(new FoundationError("worker_receipt_invalid_producer", "AttemptReceipt provider identity does not match its producer", { details: { providerId: provider.providerId } }));
}
