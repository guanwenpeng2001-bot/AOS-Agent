import { describe, expect, test } from "vitest";
import { type ChangelogEntry, normalizeChangelogLinks } from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	content: "",
};

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/guanwenpeng2001-bot/AOS-Agent/blob/v0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/guanwenpeng2001-bot/AOS-Agent/blob/v0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/guanwenpeng2001-bot/AOS-Agent/tree/v0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/guanwenpeng2001-bot/AOS-Agent/blob/v0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("canonicalizes old repository URLs without changing external links", () => {
		const markdown = [
			"[#5167](https://example.com/aos-agent)",
			"[#4163](https://example.com/aos-agent)",
			"[Agent README](https://example.com/aos-agent)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				"[#5167](https://example.com/aos-agent)",
				"[#4163](https://example.com/aos-agent)",
				"[Agent README](https://example.com/aos-agent)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});
