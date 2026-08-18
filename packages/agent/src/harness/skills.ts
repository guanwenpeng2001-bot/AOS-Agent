import ignore from "ignore";
import { parse } from "yaml";
import { type ExecutionEnv, type FileInfo, type Result, type Skill, toError } from "./types.ts";
import type { SkillMetadataV1 } from "./profile.ts";
import { ResourceSelectorV1Schema } from "./foundation/reference.ts";
import { FOUNDATION_SCHEMA_VERSION } from "./foundation/identity.ts";
import { validateExactShape } from "./foundation/schema.ts";
import type { FoundationJsonValue } from "./foundation/event-catalog.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

export type SkillDiagnosticCode =
	| "file_info_failed"
	| "list_failed"
	| "read_failed"
	| "parse_failed"
	| "invalid_metadata";

/** Warning produced while loading skills. */
export interface SkillDiagnostic {
	/** Diagnostic severity. Currently only warnings are emitted. */
	type: "warning";
	/** Stable diagnostic code. */
	code: SkillDiagnosticCode;
	/** Human-readable diagnostic message. */
	message: string;
	/** Path associated with the diagnostic. */
	path: string;
}

interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	"skill-id"?: string;
	version?: string;
	capabilities?: unknown;
	"capability-refs"?: unknown;
	"mcp-selector"?: unknown;
	mcpSelector?: unknown;
	metadata?: unknown;
	parameters?: unknown;
	model?: unknown;
	effort?: unknown;
	fork?: unknown;
	"tool-policy"?: unknown;
	toolPolicy?: unknown;
	external?: unknown;
	"external-projection"?: unknown;
	externalProjection?: unknown;
	[key: string]: unknown;
}

export interface SkillExternalProjectionV1 {
	schemaVersion: 1;
	name: string;
	description: string;
	skillId?: string;
	version?: string;
	parameters?: FoundationJsonValue;
	model?: string;
	effort?: string;
	fork?: FoundationJsonValue;
	toolPolicy?: FoundationJsonValue;
	mcpSelector?: SkillMetadataV1["mcpSelector"];
	capabilityRefs?: readonly string[];
	externalProjection?: FoundationJsonValue;
}

export function projectSkillExternalV1(skill: Skill): SkillExternalProjectionV1 {
	const metadata = skill.metadata;
	return {
		schemaVersion: 1,
		name: skill.name,
		description: skill.description,
		...(metadata?.skillId === undefined ? {} : { skillId: metadata.skillId }),
		...(metadata?.version === undefined ? {} : { version: metadata.version }),
		...(metadata?.parameters === undefined ? {} : { parameters: structuredClone(metadata.parameters) }),
		...(metadata?.model === undefined ? {} : { model: metadata.model }),
		...(metadata?.effort === undefined ? {} : { effort: metadata.effort }),
		...(metadata?.fork === undefined ? {} : { fork: structuredClone(metadata.fork) }),
		...(metadata?.toolPolicy === undefined ? {} : { toolPolicy: structuredClone(metadata.toolPolicy) }),
		...(metadata?.mcpSelector === undefined ? {} : { mcpSelector: structuredClone(metadata.mcpSelector) }),
		...(metadata?.capabilityRefs === undefined ? {} : { capabilityRefs: [...metadata.capabilityRefs] }),
		...(metadata?.externalProjection === undefined ? {} : { externalProjection: structuredClone(metadata.externalProjection) }),
	};
}

export const skillExternalProjectionV1 = projectSkillExternalV1;
export const projectSkillForExternalV1 = projectSkillExternalV1;
export type SkillExternalProjection = SkillExternalProjectionV1;

/** Format a skill invocation prompt, optionally appending additional user instructions. */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
	return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}

/**
 * Load skills from one or more directories.
 *
 * Traverses directories recursively, loads `SKILL.md` files, loads direct root `.md` files as skills, honors ignore files,
 * and returns diagnostics for invalid skill files. Missing input directories are skipped.
 */
export async function loadSkills(
	env: ExecutionEnv,
	dirs: string | string[],
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
		const rootInfoResult = await env.fileInfo(dir);
		if (!rootInfoResult.ok) {
			if (rootInfoResult.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: rootInfoResult.error.message,
					path: dir,
				});
			}
			continue;
		}
		const rootInfo = rootInfoResult.value;
		if ((await resolveKind(env, rootInfo, diagnostics)) !== "directory") continue;
		const result = await loadSkillsFromDirInternal(env, rootInfo.path, true, ignore(), rootInfo.path);
		skills.push(...result.skills);
		diagnostics.push(...result.diagnostics);
	}
	return { skills, diagnostics };
}

/**
 * Load skills from source-tagged directories.
 *
 * Source values are preserved exactly and attached to every loaded skill and diagnostic. The agent package does not
 * interpret source values; applications define their own provenance shape.
 */
export async function loadSourcedSkills<TSource, TSkill extends Skill = Skill>(
	env: ExecutionEnv,
	inputs: Array<{ path: string; source: TSource }>,
	mapSkill?: (skill: Skill, source: TSource) => TSkill,
): Promise<{
	skills: Array<{ skill: TSkill; source: TSource }>;
	diagnostics: Array<SkillDiagnostic & { source: TSource }>;
}> {
	const skills: Array<{ skill: TSkill; source: TSource }> = [];
	const diagnostics: Array<SkillDiagnostic & { source: TSource }> = [];
	for (const input of inputs) {
		const result = await loadSkills(env, input.path);
		for (const skill of result.skills) {
			skills.push({ skill: mapSkill ? mapSkill(skill, input.source) : (skill as TSkill), source: input.source });
		}
		for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, source: input.source });
	}
	return { skills, diagnostics };
}

async function loadSkillsFromDirInternal(
	env: ExecutionEnv,
	dir: string,
	includeRootFiles: boolean,
	ignoreMatcher: IgnoreMatcher,
	rootDir: string,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];

	const dirInfoResult = await env.fileInfo(dir);
	if (!dirInfoResult.ok) {
		if (dirInfoResult.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: dirInfoResult.error.message,
				path: dir,
			});
		}
		return { skills, diagnostics };
	}
	const dirInfo = dirInfoResult.value;
	if ((await resolveKind(env, dirInfo, diagnostics)) !== "directory") return { skills, diagnostics };

	await addIgnoreRules(env, ignoreMatcher, dir, rootDir, diagnostics);

	const entriesResult = await env.listDir(dir);
	if (!entriesResult.ok) {
		diagnostics.push({ type: "warning", code: "list_failed", message: entriesResult.error.message, path: dir });
		return { skills, diagnostics };
	}
	const entries = entriesResult.value;

	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;
		const fullPath = entry.path;
		const kind = await resolveKind(env, entry, diagnostics);
		if (kind !== "file") continue;
		const relPath = relativeEnvPath(rootDir, fullPath);
		if (ignoreMatcher.ignores(relPath)) continue;

		const result = await loadSkillFromFile(env, fullPath, dirInfo.name);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		return { skills, diagnostics };
	}

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = entry.path;
		const kind = await resolveKind(env, entry, diagnostics);
		if (!kind) continue;

		const relPath = relativeEnvPath(rootDir, fullPath);
		const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
		if (ignoreMatcher.ignores(ignorePath)) continue;

		if (kind === "directory") {
			const result = await loadSkillsFromDirInternal(env, fullPath, false, ignoreMatcher, rootDir);
			skills.push(...result.skills);
			diagnostics.push(...result.diagnostics);
			continue;
		}

		if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) continue;
		const result = await loadSkillFromFile(env, fullPath, dirInfo.name);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
	}

	return { skills, diagnostics };
}

async function addIgnoreRules(
	env: ExecutionEnv,
	ig: IgnoreMatcher,
	dir: string,
	rootDir: string,
	diagnostics: SkillDiagnostic[],
): Promise<void> {
	const relativeDir = relativeEnvPath(rootDir, dir);
	const prefix = relativeDir ? `${relativeDir}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePathResult = await env.joinPath([dir, filename]);
		if (!ignorePathResult.ok) {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: ignorePathResult.error.message,
				path: dir,
			});
			continue;
		}
		const ignorePath = ignorePathResult.value;
		const info = await env.fileInfo(ignorePath);
		if (!info.ok) {
			if (info.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: info.error.message,
					path: ignorePath,
				});
			}
			continue;
		}
		if (info.value.kind !== "file") continue;
		const content = await env.readTextFile(ignorePath);
		if (!content.ok) {
			diagnostics.push({ type: "warning", code: "read_failed", message: content.error.message, path: ignorePath });
			continue;
		}
		const patterns = content.value
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line): line is string => Boolean(line));
		if (patterns.length > 0) ig.add(patterns);
	}
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

async function loadSkillFromFile(
	env: ExecutionEnv,
	filePath: string,
	parentDirName: string,
): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
	const diagnostics: SkillDiagnostic[] = [];
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({ type: "warning", code: "read_failed", message: rawContent.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	const parsed = parseFrontmatter<SkillFrontmatter>(rawContent.value);
	if (!parsed.ok) {
		diagnostics.push({ type: "warning", code: "parse_failed", message: parsed.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	const { frontmatter, body } = parsed.value;
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;

	for (const error of validateDescription(description)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;
	for (const error of validateName(name, parentDirName)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	if (!description || description.trim() === "") {
		return { skill: null, diagnostics };
	}

	const metadata = parseSkillMetadata(frontmatter, filePath, diagnostics);

	return {
		skill: {
			name,
			description,
			content: body,
			filePath,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			...(metadata === undefined ? {} : { metadata }),
		},
		diagnostics,
	};
}

/** Parse optional Foundation profile metadata without changing legacy skill behavior. */
function parseSkillMetadata(frontmatter: SkillFrontmatter, path: string, diagnostics: SkillDiagnostic[]): SkillMetadataV1 | undefined {
	const nested = isRecord(frontmatter.metadata) ? frontmatter.metadata : {};
	const rawSelector = frontmatter["mcp-selector"] ?? frontmatter.mcpSelector ?? nested.mcpSelector ?? nested["mcp-selector"];
	const rawCapabilities = frontmatter["capability-refs"] ?? frontmatter.capabilities ?? nested.capabilityRefs ?? nested["capability-refs"] ?? nested.capabilities;
	const rawTags = nested.tags;
	const rawSkillId = frontmatter["skill-id"] ?? nested.skillId;
	const rawVersion = frontmatter.version ?? nested.version;
	const rawSource = nested.source;
	const rawDigest = nested.digest;
	const rawParameters = frontmatter.parameters ?? nested.parameters;
	const rawModel = frontmatter.model ?? nested.model;
	const rawEffort = frontmatter.effort ?? nested.effort;
	const rawFork = frontmatter.fork ?? nested.fork;
	const rawToolPolicy = frontmatter["tool-policy"] ?? frontmatter.toolPolicy ?? nested.toolPolicy ?? nested["tool-policy"];
	const rawExternalProjection = frontmatter.external ?? frontmatter["external-projection"] ?? frontmatter.externalProjection ?? nested.externalProjection ?? nested.external;
	const hasMetadata = rawSelector !== undefined || rawCapabilities !== undefined || rawTags !== undefined || rawSkillId !== undefined || rawVersion !== undefined || rawSource !== undefined || rawDigest !== undefined || rawParameters !== undefined || rawModel !== undefined || rawEffort !== undefined || rawFork !== undefined || rawToolPolicy !== undefined || rawExternalProjection !== undefined || frontmatter.metadata !== undefined;
	if (!hasMetadata) return undefined;

	const metadata: SkillMetadataV1 = { schemaVersion: FOUNDATION_SCHEMA_VERSION };
	if (rawSkillId !== undefined) {
		if (typeof rawSkillId !== "string" || rawSkillId.length === 0) addMetadataDiagnostic("skillId must be a non-empty string", path, diagnostics);
		else metadata.skillId = rawSkillId;
	}
	if (rawVersion !== undefined) {
		if (typeof rawVersion !== "string" || rawVersion.length === 0) addMetadataDiagnostic("version must be a non-empty string", path, diagnostics);
		else metadata.version = rawVersion;
	}
	const capabilityRefs = parseStringArray(rawCapabilities, "capabilityRefs", path, diagnostics);
	if (capabilityRefs !== undefined) metadata.capabilityRefs = capabilityRefs;
	const tags = parseStringArray(rawTags, "tags", path, diagnostics);
	if (tags !== undefined) metadata.tags = tags;
	if (rawSource !== undefined) {
		if (typeof rawSource !== "string" || rawSource.length === 0) addMetadataDiagnostic("source must be a non-empty string", path, diagnostics);
		else metadata.source = rawSource;
	}
	if (rawDigest !== undefined) {
		if (!isRecord(rawDigest) || rawDigest.algorithm !== "sha256" || typeof rawDigest.value !== "string" || rawDigest.value.length === 0) addMetadataDiagnostic("digest must contain a sha256 algorithm and value", path, diagnostics);
		else metadata.digest = { algorithm: "sha256", value: rawDigest.value };
	}
	if (rawSelector !== undefined) {
		const selector = validateExactShape<NonNullable<SkillMetadataV1["mcpSelector"]>>(ResourceSelectorV1Schema, rawSelector, "skill_mcp_selector");
		if (!selector.ok) addMetadataDiagnostic("mcpSelector is invalid", path, diagnostics);
		else metadata.mcpSelector = selector.value;
	}
	const parameters = parseFoundationMetadataValue(rawParameters, "parameters", path, diagnostics);
	if (parameters !== undefined) metadata.parameters = parameters;
	if (rawModel !== undefined) {
		if (typeof rawModel !== "string" || rawModel.length === 0) addMetadataDiagnostic("model must be a non-empty string", path, diagnostics);
		else metadata.model = rawModel;
	}
	if (rawEffort !== undefined) {
		if (typeof rawEffort !== "string" || rawEffort.length === 0) addMetadataDiagnostic("effort must be a non-empty string", path, diagnostics);
		else metadata.effort = rawEffort;
	}
	const fork = parseFoundationMetadataValue(rawFork, "fork", path, diagnostics);
	if (fork !== undefined) metadata.fork = fork;
	const toolPolicy = parseFoundationMetadataValue(rawToolPolicy, "toolPolicy", path, diagnostics);
	if (toolPolicy !== undefined) metadata.toolPolicy = toolPolicy;
	const externalProjection = parseFoundationMetadataValue(rawExternalProjection, "externalProjection", path, diagnostics);
	if (externalProjection !== undefined) metadata.externalProjection = externalProjection;
	return Object.keys(metadata).length === 1 ? undefined : metadata;
}

function parseFoundationMetadataValue(value: unknown, field: string, path: string, diagnostics: SkillDiagnostic[]): FoundationJsonValue | undefined {
	if (value === undefined) return undefined;
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new TypeError("value is not JSON serializable");
		return JSON.parse(encoded) as FoundationJsonValue;
	} catch {
		addMetadataDiagnostic(`${field} must be JSON-compatible`, path, diagnostics);
		return undefined;
	}
}

function parseStringArray(value: unknown, field: string, path: string, diagnostics: SkillDiagnostic[]): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		addMetadataDiagnostic(`${field} must be an array of non-empty strings`, path, diagnostics);
		return undefined;
	}
	return [...new Set(value)];
}

function addMetadataDiagnostic(message: string, path: string, diagnostics: SkillDiagnostic[]): void {
	diagnostics.push({ type: "warning", code: "invalid_metadata", message, path });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];
	if (name !== parentDirName) errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];
	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}
	return errors;
}

function parseFrontmatter<T extends Record<string, unknown>>(
	content: string,
): Result<{ frontmatter: T; body: string }, Error> {
	try {
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (!normalized.startsWith("---")) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const endIndex = normalized.indexOf("\n---", 3);
		if (endIndex === -1) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const yamlString = normalized.slice(4, endIndex);
		const body = normalized.slice(endIndex + 4).trim();
		return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
	} catch (error) {
		return { ok: false, error: toError(error) };
	}
}

async function resolveKind(
	env: ExecutionEnv,
	info: FileInfo,
	diagnostics: SkillDiagnostic[],
): Promise<"file" | "directory" | undefined> {
	if (info.kind === "file" || info.kind === "directory") return info.kind;
	const canonicalPath = await env.canonicalPath(info.path);
	if (!canonicalPath.ok) {
		if (canonicalPath.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: canonicalPath.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	const target = await env.fileInfo(canonicalPath.value);
	if (!target.ok) {
		if (target.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: target.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
}

function dirnameEnvPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (separatorIndex === 2 && normalized[1] === ":") return normalized.slice(0, 3);
	return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
}

function relativeEnvPath(root: string, path: string): string {
	const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
	if (normalizedPath === normalizedRoot) return "";
	return normalizedPath.startsWith(`${normalizedRoot}/`)
		? normalizedPath.slice(normalizedRoot.length + 1)
		: normalizedPath.replace(/^\/+/, "");
}
