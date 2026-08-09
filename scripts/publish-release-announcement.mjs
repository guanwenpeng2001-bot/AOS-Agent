#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const MAX_POINTER_UPDATE_ATTEMPTS = 5;
const STABLE_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function compareReleaseVersions(left, right) {
	const leftMatch = STABLE_SEMVER_RE.exec(left);
	const rightMatch = STABLE_SEMVER_RE.exec(right);
	if (!leftMatch || !rightMatch) throw new Error("Release versions must be stable semver versions.");

	for (const index of [1, 2, 3]) {
		const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
		if (difference !== 0) return difference;
	}
	return 0;
}

export async function advanceLatestRelease(version, readLatest, writeLatest) {
	for (let attempt = 0; attempt < MAX_POINTER_UPDATE_ATTEMPTS; attempt++) {
		const current = await readLatest();
		if (current && compareReleaseVersions(version, current.version) <= 0) {
			return { advanced: false, version: current.version };
		}

		const updated = await writeLatest(current ? { etag: current.etag } : { missing: true });
		if (updated) {
			return { advanced: true, version };
		}
	}
	throw new Error(
		`Could not advance the AOS Agent release marker to ${version} after ${MAX_POINTER_UPDATE_ATTEMPTS} attempts.`,
	);
}

async function main() {
	// Upstream aos-agent.example.invalid announcement path is neutralized for AOS Agent product identity.
	// Keep the module importable for unit tests (compareReleaseVersions / advanceLatestRelease).
	// Host CI owns release publication; do not announce to the upstream channel.
	throw new Error(
		"publish-release-announcement.mjs is disabled for AOS Agent (no aos-agent.example.invalid announce). Host CI owns release publication.",
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
