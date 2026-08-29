import { readFileSync } from "node:fs";

export const LINE13_CONNECTORS = Object.freeze(["acp", "codex_app_server", "claude_agent_sdk"]);
export {
	PLATFORMS as LINE13_PLATFORMS,
	RUNTIME_KINDS as LINE13_RUNTIME_KINDS,
	assertChoice,
	assertExactKeys,
	assertFullSha,
	assertPlainObject,
	assertSanitized,
	assertSha256,
	digestJson,
	isMain,
	parseFlagArguments,
	writeJsonAtomic,
} from "./pack-smoke-common.mjs";
export const LINE13_REQUIRED_CHECKS = Object.freeze([
	"q10.scheduler-host-credential-recovery",
	"q13.activation-readiness-status",
	"q14.control-state-session-scope",
	"q15.shutdown-supervision-protocol",
	"q16.gateway-provenance",
	"q17.packaged-cross-platform-upgrade",
	"q18.runtime-limits-retry-soak",
	"repository.npm-run-check",
]);
export const LINE13_ACCEPTANCE_CRITERIA = Object.freeze(
	Array.from({ length: 24 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`),
);
export const LINE13_QUALITY_GATES = Object.freeze(Array.from({ length: 19 }, (_, index) => `Q${index}`));

export function assertSafeReasonCode(value, context = "reasonCode") {
	if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value) || value.length > 80) {
		throw new TypeError(`${context} must be a stable lowercase reason code`);
	}
	return value;
}

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}
