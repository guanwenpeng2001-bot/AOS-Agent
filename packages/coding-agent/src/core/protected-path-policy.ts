import { createHash } from "node:crypto";

export const POLICY_EFFECTS = Object.freeze([
	"read",
	"write",
	"create",
	"delete",
	"move",
	"command",
	"network",
	"commit",
	"push",
	"merge",
] as const);
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export const POLICY_REVIEW_REQUIREMENTS = Object.freeze([
	"none",
	"approval",
	"reviewer",
	"team_enforced",
] as const);
export type PolicyReviewRequirement = (typeof POLICY_REVIEW_REQUIREMENTS)[number];

export const POLICY_REVIEWER_KINDS = Object.freeze(["user", "team", "system"] as const);
export type PolicyReviewerKind = (typeof POLICY_REVIEWER_KINDS)[number];
export type PolicyReviewDecision = "approved" | "rejected";

export interface PolicyReviewerIdentity {
	readonly kind: PolicyReviewerKind;
	readonly id: string;
}

/** Safe, durable proof that a human or managed team reviewed one exact scope. */
export interface PolicyReviewEvidence {
	readonly requestId: string;
	readonly bindingId: string;
	readonly requirement: Exclude<PolicyReviewRequirement, "none" | "approval">;
	readonly reviewer: PolicyReviewerIdentity;
	readonly decision: PolicyReviewDecision;
	readonly resolvedAt: string;
	readonly scopeDigest: string;
}

export interface ProtectedPathRule {
	readonly id: string;
	/** Canonical workspace-relative glob. `**` is supported only as a whole segment. */
	readonly pattern: string;
	readonly effects: ReadonlyArray<PolicyEffect>;
	readonly requirement: PolicyReviewRequirement;
	/** Eligible safe reviewer identities for `reviewer` requirements. */
	readonly reviewerIds?: ReadonlyArray<string>;
	/** Required safe team identity for `team_enforced` requirements. */
	readonly teamId?: string;
}

export interface ProtectedPathPolicy {
	readonly rules: ReadonlyArray<ProtectedPathRule>;
	/** Rule ids whose requirement cannot be removed or widened by user/project settings. */
	readonly managedLocks?: ReadonlyArray<string>;
}

export interface ProtectedPathClassification {
	readonly protected: boolean;
	readonly reasonCode: "protected_path_match" | "protected_path_not_matched";
	readonly effects: ReadonlyArray<PolicyEffect>;
	readonly pathCount: number;
	readonly matchedRuleIds: ReadonlyArray<string>;
	readonly requirement: PolicyReviewRequirement;
	readonly scopeDigest?: string;
}

export interface PolicyReviewEvidenceResolution {
	readonly status: "approved" | "rejected" | "missing" | "invalid";
	readonly evidence?: ReadonlyArray<PolicyReviewEvidence>;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVIEW_SCOPE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const REQUIREMENT_RANK: Readonly<Record<PolicyReviewRequirement, number>> = {
	none: 0,
	approval: 1,
	reviewer: 2,
	team_enforced: 3,
};
const EFFECT_RANK = new Map<PolicyEffect, number>(POLICY_EFFECTS.map((effect, index) => [effect, index]));

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function stableStringify(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return "undefined";
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

export function isSafeReviewerId(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

export function isPolicyEffect(value: unknown): value is PolicyEffect {
	return typeof value === "string" && (POLICY_EFFECTS as readonly string[]).includes(value);
}

export function isPolicyReviewRequirement(value: unknown): value is PolicyReviewRequirement {
	return typeof value === "string" && (POLICY_REVIEW_REQUIREMENTS as readonly string[]).includes(value);
}

export function isCanonicalReviewScopeDigest(value: unknown): value is string {
	return typeof value === "string" && REVIEW_SCOPE_DIGEST_PATTERN.test(value);
}

export function isCanonicalPolicyTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || CONTROL_CHARACTER_PATTERN.test(value)) return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function isCanonicalWorkspaceRelativePath(value: unknown): value is string {
	if (value === ".") return true;
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		CONTROL_CHARACTER_PATTERN.test(value) ||
		value.includes("\\") ||
		value.startsWith("/") ||
		WINDOWS_DRIVE_PATTERN.test(value) ||
		URI_SCHEME_PATTERN.test(value)
	) {
		return false;
	}
	const segments = value.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isCanonicalProtectedPathPattern(value: unknown): value is string {
	if (!isCanonicalWorkspaceRelativePath(value)) return false;
	if (value === ".") return true;
	return value.split("/").every((segment) => {
		if (segment === "**") return true;
		return !segment.includes("**") && !/[![\]{}]/.test(segment);
	});
}

function normalizeEffects(value: unknown): ReadonlyArray<PolicyEffect> | undefined {
	if (!Array.isArray(value) || value.length === 0 || !value.every(isPolicyEffect)) return undefined;
	return [...new Set(value)].sort((left, right) => (EFFECT_RANK.get(left) ?? 0) - (EFFECT_RANK.get(right) ?? 0));
}

function normalizeReviewerIds(value: unknown): ReadonlyArray<string> | undefined {
	if (!Array.isArray(value) || value.length === 0 || !value.every(isSafeReviewerId)) return undefined;
	return [...new Set(value)].sort();
}

function parseRule(value: unknown): ProtectedPathRule | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.keys(value).some((key) => !["id", "pattern", "effects", "requirement", "reviewerIds", "teamId"].includes(key))) {
		return undefined;
	}
	if (!isSafeIdentifier(value.id) || !isCanonicalProtectedPathPattern(value.pattern) || !isPolicyReviewRequirement(value.requirement)) {
		return undefined;
	}
	const effects = normalizeEffects(value.effects);
	if (effects === undefined) return undefined;
	const reviewerIds = value.reviewerIds === undefined ? undefined : normalizeReviewerIds(value.reviewerIds);
	if (value.reviewerIds !== undefined && reviewerIds === undefined) return undefined;
	if (value.teamId !== undefined && !isSafeReviewerId(value.teamId)) return undefined;
	if (value.requirement === "reviewer" && reviewerIds === undefined) return undefined;
	if (value.requirement === "team_enforced" && value.teamId === undefined) return undefined;
	if (value.requirement !== "reviewer" && reviewerIds !== undefined) return undefined;
	if (value.requirement !== "team_enforced" && value.teamId !== undefined) return undefined;
	return deepFreeze({
		id: value.id,
		pattern: value.pattern,
		effects,
		requirement: value.requirement,
		...(reviewerIds === undefined ? {} : { reviewerIds }),
		...(value.teamId === undefined ? {} : { teamId: value.teamId }),
	});
}

export function parseProtectedPathPolicy(value: unknown): ProtectedPathPolicy | undefined {
	if (!isRecord(value) || Object.keys(value).some((key) => !["rules", "managedLocks"].includes(key))) return undefined;
	if (!Array.isArray(value.rules)) return undefined;
	const rules = value.rules.map(parseRule);
	if (!rules.every((rule): rule is ProtectedPathRule => rule !== undefined)) return undefined;
	const ids = rules.map((rule) => rule.id);
	if (new Set(ids).size !== ids.length) return undefined;
	let managedLocks: ReadonlyArray<string> | undefined;
	if (value.managedLocks !== undefined) {
		if (!Array.isArray(value.managedLocks) || !value.managedLocks.every(isSafeIdentifier)) return undefined;
		managedLocks = [...new Set(value.managedLocks)].sort();
		if (managedLocks.some((id) => !ids.includes(id))) return undefined;
	}
	return deepFreeze({
		rules,
		...(managedLocks === undefined || managedLocks.length === 0 ? {} : { managedLocks }),
	});
}

export function cloneProtectedPathPolicy(policy: ProtectedPathPolicy): ProtectedPathPolicy {
	const parsed = parseProtectedPathPolicy(policy);
	if (parsed === undefined) throw new TypeError("Invalid protected path policy");
	return parsed;
}

export function calculateProtectedPathPolicyDigest(policy: ProtectedPathPolicy): string {
	const parsed = cloneProtectedPathPolicy(policy);
	return `sha256:${createHash("sha256").update(stableStringify(parsed)).digest("hex")}`;
}

function requirementAtLeast(candidate: PolicyReviewRequirement, floor: PolicyReviewRequirement): boolean {
	return REQUIREMENT_RANK[candidate] >= REQUIREMENT_RANK[floor];
}

function sameOrNarrowerRule(base: ProtectedPathRule, candidate: ProtectedPathRule): boolean {
	if (base.id !== candidate.id || base.pattern !== candidate.pattern || !requirementAtLeast(candidate.requirement, base.requirement)) {
		return false;
	}
	const candidateEffects = new Set(candidate.effects);
	if (!base.effects.every((effect) => candidateEffects.has(effect))) return false;
	if (base.requirement === "reviewer" && candidate.requirement === "reviewer") {
		const baseReviewers = new Set(base.reviewerIds);
		if (!candidate.reviewerIds?.every((id) => baseReviewers.has(id))) return false;
	}
	if (base.requirement === "team_enforced") return candidate.teamId === base.teamId;
	return true;
}

/** Merge a project/user tightening. Omitted base rules remain effective. */
export function narrowProtectedPathPolicy(
	base: ProtectedPathPolicy | undefined,
	candidate: ProtectedPathPolicy,
): ProtectedPathPolicy | undefined {
	if (base === undefined) return cloneProtectedPathPolicy(candidate);
	const candidateById = new Map(candidate.rules.map((rule) => [rule.id, rule]));
	for (const rule of base.rules) {
		const replacement = candidateById.get(rule.id);
		if (replacement !== undefined && !sameOrNarrowerRule(rule, replacement)) return undefined;
	}
	const mergedRules = [
		...base.rules.map((rule) => candidateById.get(rule.id) ?? rule),
		...candidate.rules.filter((rule) => !base.rules.some((baseRule) => baseRule.id === rule.id)),
	];
	return parseProtectedPathPolicy({
		rules: mergedRules,
		managedLocks: [...new Set([...(base.managedLocks ?? []), ...(candidate.managedLocks ?? [])])],
	});
}

/** Preserve only system/team-managed rules when a user supplies a full profile override. */
export function preserveManagedProtectedPathRules(
	system: ProtectedPathPolicy | undefined,
	user: ProtectedPathPolicy | undefined,
): ProtectedPathPolicy | undefined {
	const managedIds = new Set(system?.managedLocks ?? []);
	if (managedIds.size === 0) return user === undefined ? undefined : cloneProtectedPathPolicy(user);
	const managed: ProtectedPathPolicy = {
		rules: (system?.rules ?? []).filter((rule) => managedIds.has(rule.id)),
		managedLocks: [...managedIds],
	};
	if (user === undefined) return cloneProtectedPathPolicy(managed);
	const userWithoutClaimedLocks: ProtectedPathPolicy = { rules: user.rules };
	return narrowProtectedPathPolicy(managed, userWithoutClaimedLocks);
}

function matchSegment(pattern: string, value: string): boolean {
	let expression = "^";
	for (const character of pattern) {
		if (character === "*") expression += "[^/]*";
		else if (character === "?") expression += "[^/]";
		else expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	expression += "$";
	return new RegExp(expression, process.platform === "win32" ? "i" : undefined).test(value);
}

function matchesPattern(pattern: string, candidate: string): boolean {
	const patternSegments = pattern.split("/");
	const candidateSegments = candidate.split("/");
	const memo = new Map<string, boolean>();
	const visit = (patternIndex: number, candidateIndex: number): boolean => {
		const key = `${patternIndex}:${candidateIndex}`;
		const known = memo.get(key);
		if (known !== undefined) return known;
		let matched: boolean;
		if (patternIndex === patternSegments.length) matched = candidateIndex === candidateSegments.length;
		else if (patternSegments[patternIndex] === "**") {
			matched = visit(patternIndex + 1, candidateIndex) ||
				(candidateIndex < candidateSegments.length && visit(patternIndex, candidateIndex + 1));
		} else {
			matched = candidateIndex < candidateSegments.length &&
				matchSegment(patternSegments[patternIndex]!, candidateSegments[candidateIndex]!) &&
				visit(patternIndex + 1, candidateIndex + 1);
		}
		memo.set(key, matched);
		return matched;
	};
	return visit(0, 0);
}

export function calculatePolicyReviewScopeDigest(input: {
	readonly bindingId: string;
	readonly resource: string;
	readonly source: string;
	readonly effects: ReadonlyArray<PolicyEffect>;
	readonly paths: ReadonlyArray<string>;
	readonly matchedRuleIds: ReadonlyArray<string>;
	readonly requirement: PolicyReviewRequirement;
}): string {
	if (!isSafeReviewerId(input.bindingId) || input.resource.length === 0 || input.source.length === 0) {
		throw new TypeError("Invalid review scope identity");
	}
	const effects = normalizeEffects(input.effects);
	if (effects === undefined || !input.paths.every(isCanonicalWorkspaceRelativePath) || !input.matchedRuleIds.every(isSafeIdentifier)) {
		throw new TypeError("Invalid review scope");
	}
	const canonical = {
		version: 1,
		bindingId: input.bindingId,
		resource: input.resource,
		source: input.source,
		effects,
		paths: [...new Set(input.paths)].sort(),
		matchedRuleIds: [...new Set(input.matchedRuleIds)].sort(),
		requirement: input.requirement,
	};
	return `sha256:${createHash("sha256").update(stableStringify(canonical)).digest("hex")}`;
}

export function classifyProtectedPathOperation(input: {
	readonly policy?: ProtectedPathPolicy;
	readonly bindingId: string;
	readonly resource: string;
	readonly source: string;
	readonly effects: ReadonlyArray<PolicyEffect>;
	readonly paths: ReadonlyArray<string>;
}): ProtectedPathClassification {
	const effects = normalizeEffects(input.effects);
	if (effects === undefined || !input.paths.every(isCanonicalWorkspaceRelativePath)) {
		throw new TypeError("Invalid protected path operation");
	}
	const paths = [...new Set(input.paths)].sort();
	const matchedRules = (input.policy?.rules ?? []).filter(
		(rule) => rule.effects.some((effect) => effects.includes(effect)) && paths.some((candidate) => matchesPattern(rule.pattern, candidate)),
	);
	let requirement: PolicyReviewRequirement = "none";
	for (const rule of matchedRules) {
		if (REQUIREMENT_RANK[rule.requirement] > REQUIREMENT_RANK[requirement]) requirement = rule.requirement;
	}
	const matchedRuleIds = matchedRules.map((rule) => rule.id).sort();
	const scopeDigest = matchedRules.length === 0
		? undefined
		: calculatePolicyReviewScopeDigest({
				bindingId: input.bindingId,
				resource: input.resource,
				source: input.source,
				effects,
				paths,
				matchedRuleIds,
				requirement,
			});
	return deepFreeze({
		protected: matchedRules.length > 0,
		reasonCode: matchedRules.length > 0 ? "protected_path_match" : "protected_path_not_matched",
		effects,
		pathCount: paths.length,
		matchedRuleIds,
		requirement,
		...(scopeDigest === undefined ? {} : { scopeDigest }),
	});
}

export function isPolicyReviewEvidence(value: unknown): value is PolicyReviewEvidence {
	if (!isRecord(value)) return false;
	if (Object.keys(value).some((key) => !["requestId", "bindingId", "requirement", "reviewer", "decision", "resolvedAt", "scopeDigest"].includes(key))) {
		return false;
	}
	if (
		!isSafeReviewerId(value.requestId) ||
		!isSafeReviewerId(value.bindingId) ||
		(value.requirement !== "reviewer" && value.requirement !== "team_enforced") ||
		(value.decision !== "approved" && value.decision !== "rejected") ||
		!isCanonicalPolicyTimestamp(value.resolvedAt) ||
		!isCanonicalReviewScopeDigest(value.scopeDigest) ||
		!isRecord(value.reviewer) ||
		Object.keys(value.reviewer).some((key) => !["kind", "id"].includes(key)) ||
		!(POLICY_REVIEWER_KINDS as readonly unknown[]).includes(value.reviewer.kind) ||
		!isSafeReviewerId(value.reviewer.id)
	) {
		return false;
	}
	return true;
}

export function createPolicyReviewEvidence(input: PolicyReviewEvidence): PolicyReviewEvidence {
	if (!isPolicyReviewEvidence(input)) throw new TypeError("Invalid policy review evidence");
	return deepFreeze({ ...input, reviewer: { ...input.reviewer } });
}

export function resolvePolicyReviewEvidence(input: {
	readonly policy: ProtectedPathPolicy;
	readonly classification: ProtectedPathClassification;
	readonly bindingId: string;
	readonly requestId: string;
	readonly requestCreatedAt?: string;
	readonly evidence?: PolicyReviewEvidence | ReadonlyArray<PolicyReviewEvidence>;
}): PolicyReviewEvidenceResolution {
	if (input.classification.requirement !== "reviewer" && input.classification.requirement !== "team_enforced") {
		return { status: "missing" };
	}
	const supplied = input.evidence === undefined ? [] : Array.isArray(input.evidence) ? input.evidence : [input.evidence];
	if (supplied.length === 0) return { status: "missing" };
	if (
		input.classification.scopeDigest === undefined ||
		!supplied.every(
			(item) =>
				isPolicyReviewEvidence(item) &&
				item.requestId === input.requestId &&
				item.bindingId === input.bindingId &&
				item.requirement === input.classification.requirement &&
				item.scopeDigest === input.classification.scopeDigest,
		)
	) {
		return { status: "invalid" };
	}
	const requestCreatedAt = input.requestCreatedAt;
	if (
		requestCreatedAt !== undefined &&
		(!isCanonicalPolicyTimestamp(requestCreatedAt) ||
			supplied.some((item) => Date.parse(item.resolvedAt) < Date.parse(requestCreatedAt)))
	) {
		return { status: "invalid" };
	}
	const matched = input.policy.rules.filter((rule) => input.classification.matchedRuleIds.includes(rule.id));
	if (input.classification.requirement === "team_enforced") {
		const requiredTeams = [...new Set(matched.filter((rule) => rule.requirement === "team_enforced").map((rule) => rule.teamId))];
		if (supplied.some((item) => item.reviewer.kind !== "team" || !requiredTeams.includes(item.reviewer.id))) {
			return { status: "invalid" };
		}
		if (requiredTeams.some((teamId) => !supplied.some((item) => item.reviewer.kind === "team" && item.reviewer.id === teamId))) {
			return { status: "missing" };
		}
	} else {
		const reviewerRules = matched.filter((rule) => rule.requirement === "reviewer");
		if (
			supplied.some(
				(item) =>
					(item.reviewer.kind !== "user" && item.reviewer.kind !== "system") ||
					!reviewerRules.some((rule) => rule.reviewerIds?.includes(item.reviewer.id)),
			)
		) {
			return { status: "invalid" };
		}
		if (
			reviewerRules.some(
				(rule) =>
					!supplied.some(
						(item) =>
							(item.reviewer.kind === "user" || item.reviewer.kind === "system") &&
							rule.reviewerIds?.includes(item.reviewer.id),
					),
			)
		) {
			return { status: "missing" };
		}
	}
	if (supplied.some((item) => item.decision === "rejected")) return { status: "rejected", evidence: supplied };
	return { status: "approved", evidence: supplied };
}
