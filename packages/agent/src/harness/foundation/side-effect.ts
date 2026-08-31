import { Type } from "typebox";

/** Whether an operation is known to have produced a side effect. */
export const SIDE_EFFECT_STATES = ["none", "unknown", "side_effect_unknown"] as const;
export type SideEffectState = (typeof SIDE_EFFECT_STATES)[number];
export const SideEffectStateSchema = Type.Union([
	Type.Literal("none"),
	Type.Literal("unknown"),
	Type.Literal("side_effect_unknown"),
]);

/** Idempotency is a retry policy input, not a side-effect state. */
export const IDEMPOTENCY_STATES = ["idempotent", "non_idempotent"] as const;
export type Idempotency = (typeof IDEMPOTENCY_STATES)[number];
export const IdempotencySchema = Type.Union([Type.Literal("idempotent"), Type.Literal("non_idempotent")]);

export interface SideEffectPolicy {
	sideEffectState: SideEffectState;
	idempotency: Idempotency;
}
/**
 * Unknown outcomes are retryable only when repeating the operation is explicitly idempotent.
 * `side_effect_unknown` is always terminal for automatic retry because a side effect may already
 * have happened and cannot be safely replayed from this contract alone.
 */
export function isSideEffectRetryable(state: SideEffectState, idempotency: Idempotency = "non_idempotent"): boolean {
	if (state === "none") return true;
	if (state === "side_effect_unknown") return false;
	return idempotency === "idempotent";
}
