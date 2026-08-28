import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LINE13_CONNECTORS = Object.freeze(["acp", "codex_app_server", "claude_agent_sdk"]);
export const LINE13_PLATFORMS = Object.freeze(["windows", "linux", "macos"]);
export const LINE13_RUNTIME_KINDS = Object.freeze(["node", "bun", "compiled"]);
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

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SENSITIVE_KEY_PATTERN = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie|credential[_-]?(?:material|value))$/iu;
const SENSITIVE_VALUE_PATTERN = /(?:-----BEGIN [A-Z ]+ PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+|(?:token|password|secret)=\S+)/iu;

export function assertPlainObject(value, context) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${context} must be an object`);
	}
	return value;
}

export function assertExactKeys(record, required, optional, context) {
	for (const key of required) {
		if (!Object.hasOwn(record, key)) throw new TypeError(`${context}.${key} is required`);
	}
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new TypeError(`${context}.${key} is not allowed`);
	}
}

export function assertFullSha(value, context = "headSha") {
	if (typeof value !== "string" || !FULL_SHA_PATTERN.test(value)) {
		throw new TypeError(`${context} must be one full lowercase commit SHA`);
	}
	return value;
}

export function assertSha256(value, context = "digest") {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new TypeError(`${context} must be a lowercase SHA-256 digest`);
	}
	return value;
}

export function assertChoice(value, choices, context) {
	if (typeof value !== "string" || !choices.includes(value)) {
		throw new TypeError(`${context} must be one of ${choices.join(", ")}`);
	}
	return value;
}

export function assertSafeReasonCode(value, context = "reasonCode") {
	if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value) || value.length > 80) {
		throw new TypeError(`${context} must be a stable lowercase reason code`);
	}
	return value;
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
	}
	return value;
}

export function digestJson(value) {
	return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporaryPath, path);
}

export function assertSanitized(value, context = "evidence") {
	const visit = (candidate, path) => {
		if (Array.isArray(candidate)) {
			candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
			return;
		}
		if (candidate !== null && typeof candidate === "object") {
			for (const [key, item] of Object.entries(candidate)) {
				if (SENSITIVE_KEY_PATTERN.test(key)) throw new Error(`${path}.${key} contains a forbidden secret field`);
				visit(item, `${path}.${key}`);
			}
			return;
		}
		if (typeof candidate === "string" && SENSITIVE_VALUE_PATTERN.test(candidate)) {
			throw new Error(`${path} contains credential-like material`);
		}
	};
	visit(value, context);
	return value;
}

export function parseFlagArguments(args, definitions) {
	const parsed = {};
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		const definition = definitions[flag];
		if (definition === undefined) throw new Error(`Unknown option: ${flag}`);
		if (definition === "boolean") {
			parsed[flag] = true;
			continue;
		}
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
		index += 1;
		if (definition === "repeatable") {
			const values = parsed[flag] ?? [];
			values.push(value);
			parsed[flag] = values;
		} else {
			if (parsed[flag] !== undefined) throw new Error(`${flag} may be provided only once`);
			parsed[flag] = value;
		}
	}
	return parsed;
}

export function isMain(importMetaUrl) {
	return process.argv[1] !== undefined && fileURLToPath(importMetaUrl) === resolve(process.argv[1]);
}
