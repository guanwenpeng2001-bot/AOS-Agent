import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(".");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts;
const localTargetPattern = /(?:^|[\s;&|()])((?:\.\/)?scripts\/[^\s;&|()<>"']+|(?:\.\/)?test\.sh)(?=$|[\s;&|()<>"'])/gu;
const failures = [];

if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
	throw new TypeError("Root package.json scripts must be an object");
}

for (const [scriptName, command] of Object.entries(scripts)) {
	if (typeof command !== "string") continue;
	for (const match of command.matchAll(localTargetPattern)) {
		const target = match[1];
		const relativeTarget = target.startsWith("./") ? target.slice(2) : target;
		const matches = relativeTarget.includes("*") || relativeTarget.includes("?") || relativeTarget.includes("[")
			? globSync(relativeTarget, { cwd: repositoryRoot })
			: existsSync(resolve(repositoryRoot, relativeTarget))
				? [relativeTarget]
				: [];
		if (matches.length === 0) failures.push(`${scriptName}: ${target}`);
	}
}

if (failures.length > 0) {
	console.error("Root package.json scripts reference missing local targets:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

console.log("Checked local targets referenced by root package.json scripts.");
