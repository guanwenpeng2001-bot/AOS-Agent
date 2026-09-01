import { afterAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
	const original = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
	const builtin = process.getBuiltinModule.bind(process);
	Object.defineProperty(process, "getBuiltinModule", {
		configurable: true,
		value: (id: string) => id === "node:sea" ? { isSea: () => true } : builtin(id),
	});
	return {
		original,
		createJiti: vi.fn((_id: unknown, _options: unknown) => ({ import: vi.fn(async () => () => {}) })),
	};
});

vi.mock("jiti/static", () => ({ createJiti: state.createJiti }));

import { loadExtensions } from "../../../src/core/extensions/loader.ts";

afterAll(() => {
	if (state.original) Object.defineProperty(process, "getBuiltinModule", state.original);
});

describe("issue #8237 Node SEA extension loading", () => {
	it("uses bundled virtual modules without native resolution", async () => {
		const result = await loadExtensions(["/extension.ts"], "/");
		expect(result.errors).toEqual([]);
		const options = state.createJiti.mock.calls[0]?.[1] as {
			tryNative?: boolean;
			virtualModules?: Record<string, unknown>;
		};
		expect(options.tryNative).toBe(false);
		expect(options.virtualModules?.["aos-agent"]).toBeDefined();
	});
});
