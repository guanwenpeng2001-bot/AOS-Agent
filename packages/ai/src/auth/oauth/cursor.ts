/**
 * Cursor OAuth via Method 1: import private Cursor CLI/IDE credentials into
 * the AOS credential store.
 *
 * Public `cursor-agent status --format json` only reports login state and
 * whether tokens exist — not the token strings. Access/refresh tokens are read
 * from Cursor's private store (auth.json / platform keychain).
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CURSOR_COMMAND,
	type CursorCli,
	type CursorCliResult,
	cursorCli,
	isCursorStatusAuthenticated,
	parseCursorStatusJson,
} from "../../providers/cursor.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";

export interface CursorPrivateTokens {
	accessToken: string;
	refreshToken: string;
}

export interface CursorPrivateCredentialSource {
	/** Absolute path of the auth file when tokens came from a file. */
	path?: string;
	/** Human-readable source label for errors and status UI. */
	label: string;
}

export type CursorPrivateCredentialReader = () => Promise<
	{ tokens: CursorPrivateTokens; source: CursorPrivateCredentialSource } | undefined
>;

export interface CursorOAuthOptions {
	cli?: CursorCli;
	/** Working directory for CLI login/status. Defaults to process.cwd(). */
	cwd?: string;
	/** Override private credential discovery (tests). */
	readPrivateCredentials?: CursorPrivateCredentialReader;
	/** When true, login always runs `cursor-agent login` even if already authenticated. */
	forceLogin?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Decode JWT exp (seconds) to ms; returns undefined when the token is not a JWT with exp. */
export function expiresFromAccessToken(accessToken: string): number | undefined {
	const parts = accessToken.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = parts[1] ?? "";
		const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
		const json = Buffer.from(padded.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8");
		const claims = asRecord(JSON.parse(json));
		const exp = claims?.exp;
		if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
			return exp * 1000;
		}
		if (typeof exp === "string" && /^\d+$/u.test(exp)) {
			return Number(exp) * 1000;
		}
	} catch {
		// not a JWT or malformed payload
	}
	return undefined;
}

function tokensFromAuthJson(raw: unknown): CursorPrivateTokens | undefined {
	const record = asRecord(raw);
	if (!record) return undefined;
	const accessToken = nonEmptyString(record.accessToken);
	const refreshToken = nonEmptyString(record.refreshToken);
	if (!accessToken || !refreshToken) return undefined;
	return { accessToken, refreshToken };
}

function candidateAuthJsonPaths(): string[] {
	const home = homedir();
	const paths: string[] = [];
	if (process.platform === "win32") {
		const appData = process.env.APPDATA;
		if (appData) paths.push(join(appData, "Cursor", "auth.json"));
	} else if (process.platform === "darwin") {
		paths.push(join(home, "Library", "Application Support", "Cursor", "auth.json"));
		// Some CLI builds also write a lowercase config path.
		paths.push(join(home, ".config", "cursor", "auth.json"));
	} else {
		const xdg = process.env.XDG_CONFIG_HOME;
		if (xdg) {
			paths.push(join(xdg, "cursor", "auth.json"));
			paths.push(join(xdg, "Cursor", "auth.json"));
		}
		paths.push(join(home, ".config", "cursor", "auth.json"));
		paths.push(join(home, ".config", "Cursor", "auth.json"));
	}
	return paths;
}

async function readAuthJsonFile(path: string): Promise<CursorPrivateTokens | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return undefined;
		throw new Error(
			`Failed to read Cursor private credentials at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Cursor private credential file is not valid JSON: ${path}`);
	}
	return tokensFromAuthJson(parsed);
}

/**
 * Read access/refresh tokens from Cursor's private store.
 * Public CLI status never returns token strings — only this private surface does.
 */
export async function readCursorPrivateCredentials(): Promise<
	{ tokens: CursorPrivateTokens; source: CursorPrivateCredentialSource } | undefined
> {
	if (process.platform === "darwin") {
		const keychain = await readCursorKeychainTokens();
		if (keychain) {
			return {
				tokens: keychain,
				source: { label: "macOS Keychain (cursor-access-token / cursor-refresh-token)" },
			};
		}
	}

	for (const path of candidateAuthJsonPaths()) {
		const tokens = await readAuthJsonFile(path);
		if (tokens) {
			return { tokens, source: { path, label: path } };
		}
	}
	return undefined;
}

async function readCursorKeychainTokens(): Promise<CursorPrivateTokens | undefined> {
	const access = await readKeychainPassword("cursor-access-token");
	const refresh = await readKeychainPassword("cursor-refresh-token");
	if (!access || !refresh) return undefined;
	return { accessToken: access, refreshToken: refresh };
}

async function readKeychainPassword(service: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn("security", ["find-generic-password", "-a", "cursor-user", "-s", service, "-w"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		});
		child.once("error", () => resolve(undefined));
		child.once("close", (code) => {
			if (code !== 0) {
				// Keychain miss or locked is not fatal; file-based fallback may still work.
				void stderr;
				resolve(undefined);
				return;
			}
			const value = stdout.trim();
			resolve(value.length > 0 ? value : undefined);
		});
	});
}

function credentialFromPrivateTokens(
	tokens: CursorPrivateTokens,
	userInfo?: { email?: string; userId?: number | string },
): OAuthCredential {
	const expires = expiresFromAccessToken(tokens.accessToken) ?? Date.now() + 60 * 24 * 60 * 60 * 1000;
	const credential: OAuthCredential = {
		type: "oauth",
		access: tokens.accessToken,
		refresh: tokens.refreshToken,
		expires,
	};
	const email = nonEmptyString(userInfo?.email);
	if (email) credential.email = email;
	if (userInfo?.userId !== undefined && userInfo.userId !== null) {
		credential.accountId = String(userInfo.userId);
	}
	return credential;
}

function cliError(result: CursorCliResult, operation: string): Error {
	if (result.status === "not_installed") {
		return new Error(
			`Cursor CLI is not installed or not available on PATH (expected "${CURSOR_COMMAND}"). Install Cursor CLI separately, then retry /login cursor.`,
		);
	}
	if (result.status === "aborted") {
		return new Error(`Cursor CLI ${operation} was aborted.`);
	}
	if (result.status === "failed") {
		return new Error(`Cursor CLI ${operation} failed: ${result.message}`);
	}
	return new Error(`Cursor CLI ${operation} failed.`);
}

async function ensureCursorAuthenticated(
	cli: CursorCli,
	cwd: string,
	interaction: ProviderAuthInteraction,
	forceLogin: boolean,
): Promise<{ email?: string; userId?: number | string }> {
	interaction.signal.throwIfAborted();

	const readStatus = async () => {
		const result = await cli.status(cwd, interaction.signal);
		if (result.status !== "completed") throw cliError(result, "status");
		return parseCursorStatusJson(result.stdout);
	};

	let status = await readStatus();
	const authenticated = isCursorStatusAuthenticated(status);

	if (!authenticated || forceLogin) {
		interaction.notify({
			type: "info",
			message: authenticated
				? "Re-running Cursor browser login…"
				: "Starting Cursor browser login via cursor-agent…",
		});
		const loginResult = await cli.login(cwd, interaction.signal);
		if (loginResult.status !== "completed") throw cliError(loginResult, "login");
		interaction.signal.throwIfAborted();
		status = await readStatus();
	}

	if (!isCursorStatusAuthenticated(status)) {
		throw new Error("Cursor CLI reports it is not authenticated after login.");
	}
	if (status.hasAccessToken === false) {
		throw new Error("Cursor CLI reports no access token. Complete cursor-agent login and retry.");
	}
	if (status.hasRefreshToken === false) {
		throw new Error("Cursor CLI reports no refresh token. Complete cursor-agent login and retry.");
	}

	return {
		email: nonEmptyString(status.userInfo?.email),
		userId: status.userInfo?.userId,
	};
}

async function importPrivateCredential(
	readPrivate: CursorPrivateCredentialReader,
	userInfo?: { email?: string; userId?: number | string },
): Promise<OAuthCredential> {
	const privateCred = await readPrivate();
	if (!privateCred) {
		throw new Error(
			"Could not read Cursor private credentials. Expected accessToken/refreshToken in Cursor auth.json (or macOS Keychain). Public CLI status does not export token strings.",
		);
	}
	return credentialFromPrivateTokens(privateCred.tokens, userInfo);
}

export function createCursorOAuth(options: CursorOAuthOptions = {}): OAuthAuth {
	const cli = options.cli ?? cursorCli;
	const cwd = options.cwd ?? process.cwd();
	const readPrivate = options.readPrivateCredentials ?? readCursorPrivateCredentials;
	const forceLogin = options.forceLogin ?? false;

	return {
		name: "Cursor",
		isSubscription: true,
		loginLabel: "Sign in with Cursor (import CLI credentials)",

		async login(interaction) {
			const userInfo = await ensureCursorAuthenticated(cli, cwd, interaction, forceLogin);
			interaction.notify({
				type: "progress",
				message: "Importing tokens from Cursor private storage into AOS…",
			});
			return importPrivateCredential(readPrivate, userInfo);
		},

		async refresh(_credential, signal) {
			signal.throwIfAborted();
			// Prefer re-reading Cursor's private store so AOS tracks CLI rotation
			// without requiring a documented public refresh HTTP API.
			const privateCred = await readPrivate();
			signal.throwIfAborted();
			if (!privateCred) {
				throw new Error(
					"Cursor token refresh failed: private credentials are no longer available. Run /login cursor again.",
				);
			}
			return credentialFromPrivateTokens(privateCred.tokens);
		},

		async toAuth(credential) {
			// Access token is stored for AOS auth resolution and future HTTP use.
			// CLI stream/list paths that need a User API key use CURSOR_API_KEY separately;
			// session tokens from browser login stay usable by the CLI via its own store.
			return { apiKey: credential.access };
		},
	};
}

export const cursorOAuth: OAuthAuth = createCursorOAuth();
