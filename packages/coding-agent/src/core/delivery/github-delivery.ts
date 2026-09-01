import { spawn } from "node:child_process";
import {
	canonicalFoundationJson,
	FoundationError,
	SessionLedgerWriter,
	type FoundationJsonValue,
	type Session,
} from "@aos-agent/agent-core";

const DELIVERY_OBJECT_TYPE = "delivery.ref";
const MAX_GH_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_GH_TIMEOUT_MS = 30_000;

export interface DeliveryCheck {
	readonly name: string;
	readonly status: string;
	readonly conclusion?: string;
}

export type DeliveryConclusion = "success" | "failure" | "neutral" | "pending" | "unknown";

/** Durable GitHub PR and CI status associated with one canonical TaskResult. */
export interface DeliveryRef {
	readonly schemaVersion: 1;
	readonly taskResultId: string;
	readonly provider: "github";
	readonly repo: string;
	readonly number: number;
	readonly url: string;
	readonly branch: string;
	readonly checks: readonly DeliveryCheck[];
	readonly conclusion: DeliveryConclusion;
	readonly concludedAt?: string;
	readonly updatedAt: string;
}

export type GithubDeliveryErrorCode =
	| "delivery_invalid"
	| "delivery_not_found"
	| "gh_missing"
	| "gh_timeout"
	| "gh_failed"
	| "gh_output_invalid";

export class GithubDeliveryError extends Error {
	readonly code: GithubDeliveryErrorCode;
	readonly retryable: boolean;

	constructor(code: GithubDeliveryErrorCode, message: string, retryable = false) {
		super(message);
		this.name = "GithubDeliveryError";
		this.code = code;
		this.retryable = retryable;
	}
}

export interface GhCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly missing?: boolean;
	readonly timedOut?: boolean;
	readonly outputExceeded?: boolean;
}

export interface GhCommandRunner {
	run(args: readonly string[], options: { readonly cwd: string; readonly timeoutMs: number }): Promise<GhCommandResult>;
}

export class NodeGhCommandRunner implements GhCommandRunner {
	async run(
		args: readonly string[],
		options: { readonly cwd: string; readonly timeoutMs: number },
	): Promise<GhCommandResult> {
		return new Promise((resolve) => {
			const child = spawn("gh", [...args], {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			let outputExceeded = false;
			const finish = (result: GhCommandResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(result);
			};
			const append = (current: string, chunk: Buffer): string => {
				const next = current + chunk.toString("utf8");
				if (Buffer.byteLength(next, "utf8") <= MAX_GH_OUTPUT_BYTES) return next;
				outputExceeded = true;
				child.kill("SIGTERM");
				return next.slice(0, MAX_GH_OUTPUT_BYTES);
			};
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = append(stdout, chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = append(stderr, chunk);
			});
			child.once("error", (error: NodeJS.ErrnoException) => {
				finish({ stdout, stderr, exitCode: 1, ...(error.code === "ENOENT" ? { missing: true } : {}) });
			});
			child.once("close", (code) => {
				finish({ stdout, stderr, exitCode: code ?? 1, timedOut, outputExceeded });
			});
			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
			}, options.timeoutMs);
		});
	}
}

export interface GithubDeliveryServiceOptions {
	readonly runner?: GhCommandRunner;
	readonly timeoutMs?: number;
	readonly now?: () => number;
	readonly writer?: SessionLedgerWriter;
}

export interface CreateGithubPullRequestOptions {
	readonly taskResultId: string;
	readonly cwd: string;
	readonly branch: string;
	readonly title: string;
	readonly body: string;
	readonly base?: string;
	readonly clientRequestId: string;
}

export class GithubDeliveryService {
	readonly writer: SessionLedgerWriter;
	private readonly runner: GhCommandRunner;
	private readonly timeoutMs: number;
	private readonly now: () => number;

	constructor(session: Session, options: GithubDeliveryServiceOptions = {}) {
		if (options.writer !== undefined && options.writer.session !== session) {
			throw new TypeError("GitHub delivery writer is bound to another Session");
		}
		this.writer = options.writer ?? new SessionLedgerWriter(session, { ownerId: "foundation-store" });
		this.runner = options.runner ?? new NodeGhCommandRunner();
		this.timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
	}

	async get(taskResultId: string): Promise<DeliveryRef | undefined> {
		const id = requireIdentifier(taskResultId, "taskResultId");
		const fact = await this.writer.readFact<FoundationJsonValue>(DELIVERY_OBJECT_TYPE, id);
		return fact === undefined ? undefined : validateDeliveryRef(fact.payload);
	}

	async list(): Promise<readonly DeliveryRef[]> {
		const facts = await this.writer.listFacts({ objectType: DELIVERY_OBJECT_TYPE, order: "oldestFirst" });
		return facts.map((fact) => validateDeliveryRef(fact.payload));
	}

	async createPullRequest(options: CreateGithubPullRequestOptions): Promise<DeliveryRef> {
		const taskResultId = requireIdentifier(options.taskResultId, "taskResultId");
		const existing = await this.get(taskResultId);
		if (existing !== undefined) return existing;
		requireIdentifier(options.clientRequestId, "clientRequestId");
		requireText(options.branch, "branch", 255);
		requireText(options.title, "title", 1024);
		requireText(options.body, "body", 64 * 1024);
		const args = ["pr", "create", "--title", options.title, "--body", options.body, "--head", options.branch];
		if (options.base !== undefined) args.push("--base", requireText(options.base, "base", 255));
		const created = await this.run(args, options.cwd);
		const identity = parsePullRequestUrl(created.stdout);
		const delivery = await this.readStatus(identity.url, options.cwd, taskResultId, options.branch);
		return this.persist(delivery, options.clientRequestId);
	}

	async refresh(taskResultId: string, cwd: string, clientRequestId: string): Promise<DeliveryRef> {
		const current = await this.get(taskResultId);
		if (current === undefined) {
			throw new GithubDeliveryError("delivery_not_found", `No GitHub delivery is associated with TaskResult ${taskResultId}.`);
		}
		requireIdentifier(clientRequestId, "clientRequestId");
		const updated = await this.readStatus(current.url, cwd, current.taskResultId, current.branch);
		return this.persist(updated, clientRequestId);
	}

	private async readStatus(url: string, cwd: string, taskResultId: string, fallbackBranch: string): Promise<DeliveryRef> {
		const result = await this.run(
			["pr", "view", url, "--json", "number,url,headRefName,statusCheckRollup"],
			cwd,
		);
		if (Buffer.byteLength(result.stdout, "utf8") > MAX_GH_OUTPUT_BYTES) {
			throw new GithubDeliveryError("gh_output_invalid", "GitHub CLI returned an oversized PR status response.");
		}
		let value: unknown;
		try {
			value = JSON.parse(result.stdout);
		} catch {
			throw new GithubDeliveryError("gh_output_invalid", "GitHub CLI returned malformed PR status JSON.");
		}
		return deliveryFromGh(value, taskResultId, fallbackBranch, this.now());
	}

	private async persist(delivery: DeliveryRef, clientRequestId: string): Promise<DeliveryRef> {
		const current = await this.writer.readFact<FoundationJsonValue>(DELIVERY_OBJECT_TYPE, delivery.taskResultId);
		const expectedRevision = current?.record.revision ?? 0;
		const accepted = await this.writer.writeFact({
			objectType: DELIVERY_OBJECT_TYPE,
			objectId: delivery.taskResultId,
			clientRequestId,
			expectedRevision,
			payload: delivery as unknown as FoundationJsonValue,
		});
		return validateDeliveryRef(accepted.payload);
	}

	private async run(args: readonly string[], cwd: string): Promise<GhCommandResult> {
		const result = await this.runner.run(args, { cwd, timeoutMs: this.timeoutMs });
		if (result.missing === true) {
			throw new GithubDeliveryError(
				"gh_missing",
				"GitHub CLI (gh) is required. Install it from https://cli.github.com/ and run 'gh auth login'.",
			);
		}
		if (result.timedOut === true) {
			throw new GithubDeliveryError("gh_timeout", "GitHub CLI timed out while reading or creating the pull request.", true);
		}
		if (result.outputExceeded === true) {
			throw new GithubDeliveryError("gh_output_invalid", "GitHub CLI output exceeded the 1 MiB safety limit.");
		}
		if (result.exitCode !== 0) {
			throw new GithubDeliveryError("gh_failed", safeGhFailure(result.stderr), true);
		}
		return result;
	}
}

function safeGhFailure(stderr: string): string {
	const summary = stderr.trim().replace(/[\r\n]+/g, " ").slice(0, 500);
	return summary.length === 0 ? "GitHub CLI command failed." : `GitHub CLI command failed: ${summary}`;
}

function requireIdentifier(value: string, field: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(value)) {
		throw new GithubDeliveryError("delivery_invalid", `${field} is invalid.`);
	}
	return value;
}

function requireText(value: string, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || value.includes("\0")) {
		throw new GithubDeliveryError("delivery_invalid", `${field} is invalid.`);
	}
	return value;
}

function parsePullRequestUrl(stdout: string): { readonly repo: string; readonly number: number; readonly url: string } {
	const match = stdout.match(/https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/pull\/(\d+)/u);
	if (match === null) throw new GithubDeliveryError("gh_output_invalid", "GitHub CLI did not return a GitHub pull request URL.");
	const number = Number(match[3]);
	if (!Number.isSafeInteger(number) || number <= 0) throw new GithubDeliveryError("gh_output_invalid", "GitHub CLI returned an invalid pull request number.");
	return { repo: `${match[1]}/${match[2]}`, number, url: match[0] };
}

function deliveryFromGh(value: unknown, taskResultId: string, fallbackBranch: string, now: number): DeliveryRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new GithubDeliveryError("gh_output_invalid", "GitHub CLI PR status must be a JSON object.");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.url !== "string") throw new GithubDeliveryError("gh_output_invalid", "GitHub CLI PR status is missing url.");
	const identity = parsePullRequestUrl(record.url);
	if (record.number !== identity.number) throw new GithubDeliveryError("gh_output_invalid", "GitHub CLI PR identity is inconsistent.");
	const rawChecks = record.statusCheckRollup;
	if (!Array.isArray(rawChecks) || rawChecks.length > 10_000) {
		throw new GithubDeliveryError("gh_output_invalid", "GitHub CLI PR checks are invalid or exceed the safety limit.");
	}
	const checks = rawChecks.map((item, index) => parseCheck(item, index));
	const conclusion = concludeChecks(checks);
	const updatedAt = new Date(now).toISOString();
	const branch = typeof record.headRefName === "string" && record.headRefName.length > 0
		? record.headRefName
		: fallbackBranch;
	return validateDeliveryRef({
		schemaVersion: 1,
		taskResultId,
		provider: "github",
		repo: identity.repo,
		number: identity.number,
		url: identity.url,
		branch,
		checks,
		conclusion,
		...(conclusion === "pending" ? {} : { concludedAt: updatedAt }),
		updatedAt,
	});
}

function parseCheck(value: unknown, index: number): DeliveryCheck {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new GithubDeliveryError("gh_output_invalid", `GitHub check ${index} is invalid.`);
	}
	const record = value as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name : record.context;
	const status = typeof record.status === "string" ? record.status : record.state;
	if (typeof name !== "string" || name.length === 0 || name.length > 512 || typeof status !== "string" || status.length === 0 || status.length > 64) {
		throw new GithubDeliveryError("gh_output_invalid", `GitHub check ${index} is missing a bounded name or status.`);
	}
	const conclusion = record.conclusion;
	if (conclusion !== undefined && (typeof conclusion !== "string" || conclusion.length > 64)) {
		throw new GithubDeliveryError("gh_output_invalid", `GitHub check ${index} has an invalid conclusion.`);
	}
	return {
		name,
		status: status.toLowerCase(),
		...(typeof conclusion === "string" && conclusion.length > 0 ? { conclusion: conclusion.toLowerCase() } : {}),
	};
}

function concludeChecks(checks: readonly DeliveryCheck[]): DeliveryConclusion {
	if (checks.length === 0) return "unknown";
	if (checks.some((check) => check.status !== "completed" && check.status !== "success" && check.status !== "failure")) {
		return "pending";
	}
	const conclusions = checks.map((check) => check.conclusion ?? check.status);
	if (conclusions.some((value) => ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(value))) return "failure";
	if (conclusions.every((value) => ["success", "neutral", "skipped"].includes(value))) {
		return conclusions.every((value) => value === "success") ? "success" : "neutral";
	}
	return "unknown";
}

export function validateDeliveryRef(value: unknown): DeliveryRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new GithubDeliveryError("delivery_invalid", "DeliveryRef must be an object.");
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set(["schemaVersion", "taskResultId", "provider", "repo", "number", "url", "branch", "checks", "conclusion", "concludedAt", "updatedAt"]);
	if (Object.keys(record).some((key) => !allowed.has(key)) || record.schemaVersion !== 1 || record.provider !== "github") {
		throw new GithubDeliveryError("delivery_invalid", "DeliveryRef has an invalid exact shape.");
	}
	const taskResultId = requireIdentifier(String(record.taskResultId ?? ""), "taskResultId");
	if (typeof record.url !== "string") throw new GithubDeliveryError("delivery_invalid", "DeliveryRef url is invalid.");
	const identity = parsePullRequestUrl(record.url);
	if (record.repo !== identity.repo || record.number !== identity.number) {
		throw new GithubDeliveryError("delivery_invalid", "DeliveryRef GitHub identity is inconsistent.");
	}
	const branch = requireText(String(record.branch ?? ""), "branch", 255);
	if (!Array.isArray(record.checks) || record.checks.length > 10_000) throw new GithubDeliveryError("delivery_invalid", "DeliveryRef checks are invalid.");
	const checks = record.checks.map((check, index) => parseCheck(check, index));
	const conclusion = record.conclusion;
	if (!["success", "failure", "neutral", "pending", "unknown"].includes(String(conclusion))) {
		throw new GithubDeliveryError("delivery_invalid", "DeliveryRef conclusion is invalid.");
	}
	const updatedAt = requireTimestamp(record.updatedAt, "updatedAt");
	const concludedAt = record.concludedAt === undefined ? undefined : requireTimestamp(record.concludedAt, "concludedAt");
	if ((conclusion === "pending") !== (concludedAt === undefined)) {
		throw new GithubDeliveryError("delivery_invalid", "Pending DeliveryRef must omit concludedAt and terminal DeliveryRef must include it.");
	}
	const delivery: DeliveryRef = {
		schemaVersion: 1,
		taskResultId,
		provider: "github",
		repo: identity.repo,
		number: identity.number,
		url: identity.url,
		branch,
		checks,
		conclusion: conclusion as DeliveryConclusion,
		...(concludedAt === undefined ? {} : { concludedAt }),
		updatedAt,
	};
	try {
		canonicalFoundationJson(delivery as unknown as FoundationJsonValue);
	} catch (error) {
		throw new FoundationError("foundation_schema_invalid_shape", "DeliveryRef is not canonical JSON", { cause: error });
	}
	return delivery;
}

function requireTimestamp(value: unknown, field: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new GithubDeliveryError("delivery_invalid", `DeliveryRef ${field} is invalid.`);
	}
	return value;
}
