import type { Model, ModelsRefreshResult } from "@aos-agent/ai";
import { describe, expect, it, vi } from "vitest";
import {
	formatCursorCatalogUnavailable,
	formatCursorCredentialSynchronizationFailure,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";

const unknownModel: Model<"unknown"> = {
	id: "unknown",
	name: "Unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
};

describe("Cursor interactive authentication messaging", () => {
	it("states the committed credential state and gives a local refresh retry", () => {
		const login = formatCursorCredentialSynchronizationFailure("login");
		expect(login).toContain("credentials were saved");
		expect(login).toContain("/reload");
		expect(login).toContain("do not need to enter the credentials again");

		const logout = formatCursorCredentialSynchronizationFailure("logout");
		expect(logout).toContain("credentials were removed from AOS Agent");
		expect(logout).toContain("/reload");
		expect(logout).toContain("Cursor CLI login is unchanged");
	});

	it("includes the classified probe failure when login yields no models", async () => {
		const refreshResult: ModelsRefreshResult = {
			aborted: false,
			errors: new Map([
				[
					"cursor",
					new Error(
						'Cursor CLI is not installed. Install it from https://cursor.com/docs/cli/installation.',
					),
				],
			]),
		};
		const showError = vi.fn<(message: string) => void>();
		const context = {
			session: {
				modelRuntime: {
					refresh: vi.fn(async () => refreshResult),
					getAvailableSnapshot: () => [] as Model<"unknown">[],
				},
			},
			updateAvailableProviderCount: vi.fn(),
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError,
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
		};
		const completeProviderAuthentication = Reflect.get(
			InteractiveMode.prototype,
			"completeProviderAuthentication",
		) as (
			this: typeof context,
			providerId: string,
			providerName: string,
			authType: "oauth" | "api_key",
			previousModel: Model<"unknown">,
		) => Promise<void>;

		await completeProviderAuthentication.call(context, "cursor", "Cursor", "oauth", unknownModel);

		expect(showError).toHaveBeenCalledWith(
			formatCursorCatalogUnavailable(refreshResult.errors.get("cursor")?.message),
		);
		expect(showError.mock.calls[0]?.[0]).toContain("https://cursor.com/docs/cli/installation");
		expect(showError.mock.calls[0]?.[0]).toContain("/model");
	});
});
