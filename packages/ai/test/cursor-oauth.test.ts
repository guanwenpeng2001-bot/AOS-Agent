import { describe, expect, it, vi } from "vitest";
import {
	type CursorPrivateCredentialReader,
	createCursorOAuth,
	expiresFromAccessToken,
} from "../src/auth/oauth/cursor.ts";
import type { CursorCli, CursorCliCaptureResult, CursorCliResult } from "../src/providers/cursor.ts";

const neverAbortedSignal = new AbortController().signal;

function jwtWithExp(expSeconds: number): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ exp: expSeconds, type: "session" })).toString("base64url");
	return `${header}.${payload}.sig`;
}

function completedStatus(stdout: string): CursorCliCaptureResult {
	return { status: "completed", code: 0, stdout, stderr: "" };
}

function createFakeCli(handlers: {
	statusStdout?: string | (() => string);
	statusResult?: CursorCliCaptureResult;
	loginResult?: CursorCliResult;
}): CursorCli {
	return {
		id: "cursor",
		name: "Cursor",
		login: async () => handlers.loginResult ?? { status: "completed", code: 0 },
		logout: async () => ({ status: "completed", code: 0 }),
		status: async () => {
			if (handlers.statusResult) return handlers.statusResult;
			if (handlers.statusStdout === undefined) throw new Error("status fixture is missing");
			const stdout = typeof handlers.statusStdout === "function" ? handlers.statusStdout() : handlers.statusStdout;
			return completedStatus(stdout);
		},
		listModels: async () => completedStatus(""),
		execute: async () => completedStatus(""),
	};
}

describe("Cursor OAuth (private credential import)", () => {
	it("reports missing CLI and status timeout with different actionable guidance", async () => {
		for (const [statusResult, expected] of [
			[
				{ status: "not_installed", message: "missing", stdout: "", stderr: "" } as const,
				/install.*cursor.*cli/i,
			],
			[
				{ status: "timed_out", message: "slow", stdout: "", stderr: "" } as const,
				/timed out.*cursor-agent status/i,
			],
		] as const) {
			const oauth = createCursorOAuth({ cli: createFakeCli({ statusResult }) });
			await expect(
				oauth.login({
					signal: neverAbortedSignal,
					prompt: async () => "unused",
					notify: () => {},
				}),
			).rejects.toThrow(expected);
		}
	});

	it("derives expires from JWT exp claim", () => {
		const exp = 1_800_000_000;
		expect(expiresFromAccessToken(jwtWithExp(exp))).toBe(exp * 1000);
		expect(expiresFromAccessToken("not-a-jwt")).toBeUndefined();
	});

	it("skips login when status already reports authenticated and imports private tokens", async () => {
		const access = jwtWithExp(1_900_000_000);
		const refresh = "refresh-token-value";
		let loginCount = 0;
		const cli = createFakeCli({
			statusStdout: JSON.stringify({
				status: "authenticated",
				isAuthenticated: true,
				hasAccessToken: true,
				hasRefreshToken: true,
				userInfo: { email: "user@example.com", userId: 42 },
			}),
		});
		const originalLogin = cli.login;
		cli.login = async (cwd, signal) => {
			loginCount += 1;
			return originalLogin(cwd, signal);
		};

		const readPrivate: CursorPrivateCredentialReader = async () => ({
			tokens: { accessToken: access, refreshToken: refresh },
			source: { label: "test-auth.json", path: "C:\\test\\auth.json" },
		});

		const oauth = createCursorOAuth({ cli, cwd: "C:\\project", readPrivateCredentials: readPrivate });
		const credential = await oauth.login({
			signal: neverAbortedSignal,
			prompt: async () => {
				throw new Error("unexpected prompt");
			},
			notify: () => {},
		});

		expect(loginCount).toBe(0);
		expect(credential).toEqual({
			type: "oauth",
			access,
			refresh,
			expires: 1_900_000_000 * 1000,
			email: "user@example.com",
			accountId: "42",
		});
		expect(await oauth.toAuth(credential)).toEqual({ apiKey: access });
	});

	it("runs cursor-agent login when status is unauthenticated, then imports tokens", async () => {
		let statusPhase = 0;
		const access = jwtWithExp(1_900_000_000);
		const cli = createFakeCli({
			statusStdout: () => {
				statusPhase += 1;
				if (statusPhase === 1) {
					return JSON.stringify({
						status: "unauthenticated",
						isAuthenticated: false,
						hasAccessToken: false,
						hasRefreshToken: false,
					});
				}
				return JSON.stringify({
					status: "authenticated",
					isAuthenticated: true,
					hasAccessToken: true,
					hasRefreshToken: true,
				});
			},
		});
		let loginCount = 0;
		cli.login = async () => {
			loginCount += 1;
			return { status: "completed", code: 0 };
		};

		const oauth = createCursorOAuth({
			cli,
			cwd: "/tmp/proj",
			readPrivateCredentials: async () => ({
				tokens: { accessToken: access, refreshToken: "r" },
				source: { label: "auth.json" },
			}),
		});

		const messages: string[] = [];
		const credential = await oauth.login({
			signal: neverAbortedSignal,
			prompt: async () => {
				throw new Error("unexpected prompt");
			},
			notify: (event) => {
				if (event.type === "info" || event.type === "progress") messages.push(event.message);
			},
		});

		expect(loginCount).toBe(1);
		expect(credential.access).toBe(access);
		expect(credential.refresh).toBe("r");
		expect(messages.some((m) => m.includes("cursor-agent"))).toBe(true);
	});

	it("refresh re-reads private credentials instead of using the stored refresh string alone", async () => {
		const nextAccess = jwtWithExp(2_000_000_000);
		const readPrivate = vi.fn<CursorPrivateCredentialReader>(async () => ({
			tokens: { accessToken: nextAccess, refreshToken: "new-refresh" },
			source: { label: "auth.json" },
		}));
		const oauth = createCursorOAuth({
			cli: createFakeCli({ statusStdout: "{}" }),
			readPrivateCredentials: readPrivate,
		});

		const refreshed = await oauth.refresh(
			{ type: "oauth", access: "old", refresh: "old-refresh", expires: 0 },
			neverAbortedSignal,
		);
		expect(readPrivate).toHaveBeenCalledOnce();
		expect(refreshed).toEqual({
			type: "oauth",
			access: nextAccess,
			refresh: "new-refresh",
			expires: 2_000_000_000 * 1000,
		});
	});

	it("fails closed when private tokens are missing after authenticated status", async () => {
		const cli = createFakeCli({
			statusStdout: JSON.stringify({
				isAuthenticated: true,
				hasAccessToken: true,
				hasRefreshToken: true,
			}),
		});
		const oauth = createCursorOAuth({
			cli,
			readPrivateCredentials: async () => undefined,
		});
		await expect(
			oauth.login({
				signal: neverAbortedSignal,
				prompt: async () => {
					throw new Error("unexpected prompt");
				},
				notify: () => {},
			}),
		).rejects.toThrow(/credentials are missing.*cursor-agent logout.*cursor-agent login/i);
	});

	it("rejects expired private credentials before they can be committed", async () => {
		const cli = createFakeCli({
			statusStdout: JSON.stringify({
				isAuthenticated: true,
				hasAccessToken: true,
				hasRefreshToken: true,
			}),
		});
		const oauth = createCursorOAuth({
			cli,
			readPrivateCredentials: async () => ({
				tokens: { accessToken: jwtWithExp(1), refreshToken: "expired-refresh" },
				source: { label: "auth.json" },
			}),
		});

		await expect(
			oauth.login({
				signal: neverAbortedSignal,
				prompt: async () => "unused",
				notify: () => {},
			}),
		).rejects.toThrow(/credentials have expired.*cursor-agent logout.*cursor-agent login/i);
	});
});
