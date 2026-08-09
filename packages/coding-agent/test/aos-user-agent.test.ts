import { describe, expect, it } from "vitest";
import { getAosUserAgent } from "../src/utils/aos-user-agent.ts";

describe("getAosUserAgent", () => {
	it("formats the aos-agent user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getAosUserAgent("1.2.3");

		expect(userAgent).toBe(`aos-agent/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^aos-agent\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
