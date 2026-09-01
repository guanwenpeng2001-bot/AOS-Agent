import { Buffer } from "node:buffer";
import type { AgentMessage } from "@aos-agent/agent-core";
import type { DlpPolicy } from "./policy/execution.ts";
import { resolveDlpPolicy } from "./policy/execution.ts";

export const DLP_REDACTION_MARKER = "[REDACTED:dlp]";
export const DLP_WARNING_MARKER = "[DLP warning: potential secret detected]";
export const DLP_DENY_MARKER = "[DLP denied: secret-like content omitted]";

const MIN_EXACT_CREDENTIAL_LENGTH = 8;
const OPENAI_KEY_PATTERN = /\bsk-(?:[A-Za-z0-9_-]{20,})\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/gu;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu;
const PRIVATE_KEY_HEADER_PATTERN = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gu;
const JWT_ALGORITHMS = new Set(["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512", "EdDSA"]);
const JWT_CLAIMS = new Set(["aud", "exp", "iat", "iss", "jti", "nbf", "sub"]);

interface MatchRange {
	start: number;
	end: number;
}

interface ProtectedValue<T> {
	value: T;
	detected: boolean;
}

export interface DlpScannerOptions {
	policy: () => DlpPolicy | undefined;
	credentialMaterials?: () => Promise<readonly string[]>;
	initialCredentialMaterials?: readonly string[];
}

export class DlpViolationError extends Error {
	readonly code = "dlp_denied" as const;

	constructor() {
		super("Tool result persistence was denied because DLP detected secret-like content.");
		this.name = "DlpViolationError";
	}
}

function decodeJwtObject(segment: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function isHighConfidenceJwt(candidate: string): boolean {
	const [encodedHeader, encodedPayload] = candidate.split(".");
	if (encodedHeader === undefined || encodedPayload === undefined) return false;
	const header = decodeJwtObject(encodedHeader);
	const payload = decodeJwtObject(encodedPayload);
	return (
		header !== undefined &&
		payload !== undefined &&
		typeof header.alg === "string" &&
		JWT_ALGORITHMS.has(header.alg) &&
		Object.keys(payload).some((claim) => JWT_CLAIMS.has(claim))
	);
}

function addPatternRanges(text: string, pattern: RegExp, ranges: MatchRange[], validate?: (value: string) => boolean): void {
	pattern.lastIndex = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index === undefined || (validate !== undefined && !validate(match[0]))) continue;
		ranges.push({ start: match.index, end: match.index + match[0].length });
	}
}

function mergedRanges(ranges: MatchRange[]): MatchRange[] {
	const ordered = ranges.sort((left, right) => left.start - right.start || right.end - left.end);
	const merged: MatchRange[] = [];
	for (const range of ordered) {
		const previous = merged.at(-1);
		if (previous === undefined || range.start > previous.end) {
			merged.push({ ...range });
		} else if (range.end > previous.end) {
			previous.end = range.end;
		}
	}
	return merged;
}

function findMatches(text: string, exactMaterials: readonly string[]): MatchRange[] {
	const ranges: MatchRange[] = [];
	for (const material of exactMaterials) {
		let start = text.indexOf(material);
		while (start !== -1) {
			ranges.push({ start, end: start + material.length });
			start = text.indexOf(material, start + material.length);
		}
	}
	addPatternRanges(text, PRIVATE_KEY_BLOCK_PATTERN, ranges);
	addPatternRanges(text, PRIVATE_KEY_HEADER_PATTERN, ranges);
	addPatternRanges(text, OPENAI_KEY_PATTERN, ranges);
	addPatternRanges(text, JWT_PATTERN, ranges, isHighConfidenceJwt);
	return mergedRanges(ranges);
}

function redactRanges(text: string, ranges: readonly MatchRange[]): string {
	let result = "";
	let cursor = 0;
	for (const range of ranges) {
		result += text.slice(cursor, range.start) + DLP_REDACTION_MARKER;
		cursor = range.end;
	}
	return result + text.slice(cursor);
}

function normalizeCredentialMaterials(materials: readonly string[]): string[] {
	return [...new Set(materials.filter((value) => value.length >= MIN_EXACT_CREDENTIAL_LENGTH))]
		.sort((left, right) => right.length - left.length);
}

function protectText(text: string, action: DlpPolicy["action"], exactMaterials: readonly string[], projection: boolean): ProtectedValue<string> {
	const ranges = findMatches(text, exactMaterials);
	if (ranges.length === 0) return { value: text, detected: false };
	if (action === "redact") return { value: redactRanges(text, ranges), detected: true };
	if (action === "deny" && projection) return { value: DLP_DENY_MARKER, detected: true };
	if (action === "warn" && projection) return { value: `${DLP_WARNING_MARKER}\n${text}`, detected: true };
	return { value: text, detected: true };
}

function protectStructuredValue<T>(value: T, action: DlpPolicy["action"], exactMaterials: readonly string[], projection: boolean): ProtectedValue<T> {
	if (typeof value === "string") return protectText(value, action, exactMaterials, projection) as ProtectedValue<T>;
	if (Array.isArray(value)) {
		let detected = false;
		let changed = false;
		const projected = value.map((item) => {
			const result = protectStructuredValue(item, action, exactMaterials, projection);
			detected ||= result.detected;
			changed ||= result.value !== item;
			return result.value;
		});
		return { value: (changed ? projected : value) as T, detected };
	}
	if (value === null || typeof value !== "object") return { value, detected: false };
	const source = value as Record<string, unknown>;
	if (source.type === "image" && typeof source.data === "string") return { value, detected: false };
	let detected = false;
	let changed = false;
	const projected: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(source)) {
		const result = protectStructuredValue(item, action, exactMaterials, projection);
		detected ||= result.detected;
		changed ||= result.value !== item;
		projected[key] = result.value;
	}
	return { value: (changed ? projected : value) as T, detected };
}

function protectToolResultMessage<T extends Extract<AgentMessage, { role: "toolResult" }>>(
	message: T,
	action: DlpPolicy["action"],
	exactMaterials: readonly string[],
	projection: boolean,
): ProtectedValue<T> {
	const content = protectStructuredValue(message.content, action, exactMaterials, projection);
	const details = message.details === undefined
		? { value: undefined, detected: false }
		: protectStructuredValue(message.details, action, exactMaterials, projection);
	if (content.value === message.content && details.value === message.details) {
		return { value: message, detected: content.detected || details.detected };
	}
	return {
		value: {
			...message,
			content: content.value,
			...(message.details === undefined ? {} : { details: details.value }),
		},
		detected: content.detected || details.detected,
	};
}

/** DLP scanner shared by the durable-write and display/RPC projection boundaries. */
export class DlpScanner {
	private readonly credentialMaterials?: () => Promise<readonly string[]>;
	private policyProvider: () => DlpPolicy | undefined;
	private exactMaterials: readonly string[];

	constructor(options: DlpScannerOptions) {
		this.policyProvider = options.policy;
		this.credentialMaterials = options.credentialMaterials;
		this.exactMaterials = normalizeCredentialMaterials(options.initialCredentialMaterials ?? []);
	}

	setPolicyProvider(provider: () => DlpPolicy | undefined): void {
		this.policyProvider = provider;
	}

	async refreshCredentialMaterials(): Promise<void> {
		if (this.credentialMaterials === undefined) return;
		try {
			this.exactMaterials = normalizeCredentialMaterials(await this.credentialMaterials());
		} catch {
			// Pattern scanning remains available when credential storage cannot be read.
		}
	}

	async protectToolResultForPersistence<T extends AgentMessage>(message: T): Promise<T> {
		if (message.role !== "toolResult") return message;
		const policy = resolveDlpPolicy(this.policyProvider());
		if (!policy.enabled) return message;
		await this.refreshCredentialMaterials();
		const protectedMessage = protectToolResultMessage(message, policy.action, this.exactMaterials, false);
		if (policy.action === "deny" && protectedMessage.detected) throw new DlpViolationError();
		return protectedMessage.value as T;
	}

	projectToolResult<T extends AgentMessage>(message: T): T {
		if (message.role !== "toolResult") return message;
		const policy = resolveDlpPolicy(this.policyProvider());
		if (!policy.enabled) return message;
		return protectToolResultMessage(message, policy.action, this.exactMaterials, true).value as T;
	}

	projectStructured<T>(value: T): T {
		const policy = resolveDlpPolicy(this.policyProvider());
		if (!policy.enabled) return value;
		return protectStructuredValue(value, policy.action, this.exactMaterials, true).value;
	}
}
