import { Result, type ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { PROVIDER_CLASS, validateConnectorCapabilitySnapshot, type ConnectorCapabilitySnapshot } from "./providers.ts";
import { validateAttemptReceipt, validateWorkerReceipt, type AttemptReceipt, type WorkerReceipt } from "./results.ts";
import type { AttemptProviderClass } from "./task.ts";

export interface ProviderReceiptConformance {
	providerId: string;
	providerClass: "operation_worker" | AttemptProviderClass;
}

/** Capability snapshots are accepted only from the selected external-connector identity. */
export function validateConnectorCapabilitySnapshotForProvider(value: unknown, provider: ProviderReceiptConformance): ResultValue<ConnectorCapabilitySnapshot, FoundationError> {
	if (provider.providerClass !== PROVIDER_CLASS.externalConnector) return Result.err(new FoundationError("task_executor_invalid_provider_class", "Only external connectors may publish ConnectorCapabilitySnapshot", { details: { providerId: provider.providerId } }));
	const checked = validateConnectorCapabilitySnapshot(value);
	if (!checked.ok) return checked;
	return checked.value.providerId === provider.providerId
		? checked
		: Result.err(new FoundationError("task_executor_invalid_provider_class", "ConnectorCapabilitySnapshot provider identity does not match its producer", { details: { providerId: provider.providerId } }));
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
