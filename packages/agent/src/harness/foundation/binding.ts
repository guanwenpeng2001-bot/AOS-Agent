import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { fingerprintFoundationValue } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { createBindingEpoch, validateAgentBindingV1, type AgentBindingV1, type BindingEpochV1, type CreateBindingEpochInput } from "./role.ts";

/** Exact validation plus the immutable fingerprint check for a persisted AgentBinding. */
export function validateImmutableAgentBindingV1(value: unknown): ResultValue<AgentBindingV1, FoundationError> {
	const checked = validateAgentBindingV1(value);
	if (!checked.ok) return checked;
	const { fingerprint, ...base } = checked.value;
	const expected = fingerprintFoundationValue(base);
	return fingerprint.value === expected.value
		? Result.ok(cloneDeepFrozen(checked.value))
		: Result.err(new FoundationError("profile_conflict", "AgentBinding fingerprint does not match its immutable fields", { details: { bindingId: checked.value.bindingId } }));
}

/** Creates a new ordered epoch only when the previous epoch belongs to the same attempt chain. */
export function createOrderedBindingEpochV1(input: CreateBindingEpochInput): ResultValue<BindingEpochV1, FoundationError> {
	if (input.previous !== undefined) {
		if (input.activationReason === "attempt_started") return Result.err(new FoundationError("binding_epoch_invalid_ordinal", "Only the first BindingEpoch may use attempt_started", { details: { bindingEpochId: input.bindingEpochId } }));
		if (input.previous.bindingId !== input.bindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "BindingEpoch cannot change binding identity inside an attempt", { details: { bindingEpochId: input.bindingEpochId } }));
		if (input.previous.agentInstanceId !== input.agentInstanceId) return Result.err(new FoundationError("binding_epoch_mismatch", "BindingEpoch cannot change AgentInstance inside an attempt", { details: { bindingEpochId: input.bindingEpochId } }));
	}
	return createBindingEpoch(input);
}

export const validateImmutableAgentBinding = validateImmutableAgentBindingV1;
export const createOrderedBindingEpoch = createOrderedBindingEpochV1;
