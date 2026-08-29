import { Result, type ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { fingerprintFoundationValue } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { createModelProfileRevision, ModelProfileSchema, type ModelProfile } from "./role.ts";
import { validateExactShape } from "./schema.ts";

export type SecretFreeModelProfileInput = Omit<ModelProfile, "fingerprint">;

/** Creates a profile revision from routing metadata only; credentials are not part of the input type. */
export function createSecretFreeModelProfile(input: SecretFreeModelProfileInput): ResultValue<ModelProfile, FoundationError> {
	try {
		const profile = createModelProfileRevision(input);
		return validateSecretFreeModelProfile(profile);
	} catch (error) {
		return Result.err(new FoundationError("foundation_schema_invalid_shape", "ModelProfile could not be created", { cause: error }));
	}
}

/** Validates shape, fingerprint integrity, and the absence of secret-bearing fields. */
export function validateSecretFreeModelProfile(value: unknown): ResultValue<ModelProfile, FoundationError> {
	const checked = validateExactShape<ModelProfile>(ModelProfileSchema, value, "model_profile");
	if (!checked.ok) return checked;
	const record = checked.value as unknown as Record<string, unknown>;
	const forbidden = ["credential", "secret", "password", "token", "authorization", "apiKey", "headers"];
	if (Object.keys(record).some((key) => forbidden.some((word) => key.toLowerCase().includes(word.toLowerCase())))) return Result.err(new FoundationError("foundation_schema_invalid_shape", "ModelProfile contains secret-bearing fields"));
	const { fingerprint, ...base } = checked.value;
	const expected = fingerprintFoundationValue(base);
	if (fingerprint.value !== expected.value) return Result.err(new FoundationError("profile_conflict", "ModelProfile fingerprint does not match its immutable fields", { details: { modelProfileId: checked.value.modelProfileId } }));
	return Result.ok(cloneDeepFrozen(checked.value));
}

export const createModelProfile = createSecretFreeModelProfile;
