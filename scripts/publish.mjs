#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const packages = getPublicWorkspacePackages();

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function spawnCommand(command, args, options = {}) {
	const executable = commandForPlatform(command);
	const file = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : executable;
	const spawnArgs = process.platform === "win32" ? ["/d", "/s", "/c", executable, ...args] : args;

	return spawnSync(file, spawnArgs, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnCommand(command, args, options);

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packResult = JSON.parse(result.stdout);
	const packed = Array.isArray(packResult)
		? packResult[0]
		: packResult && typeof packResult === "object" && "filename" in packResult
			? packResult
			: packResult && typeof packResult === "object"
				? Object.values(packResult)[0]
				: undefined;
	if (!packed || typeof packed !== "object" || !Array.isArray(packed.files)) {
		throw new Error(`Unexpected npm pack output for ${directory}`);
	}
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

function isPublished(name, version) {
	const result = spawnCommand("npm", ["view", `${name}@${version}`, "version", "--json"], { capture: true });

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

const packageVersions = new Map(packages.map((pkg) => [pkg.name, pkg.version]));

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

console.log(`Publishing aos-agent packages at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);

const packageStates = packages.map((pkg) => ({
	...pkg,
	published: false,
	version: packageVersions.get(pkg.name),
}));

for (const pkg of packageStates) {
	assertBuildOutputExists(pkg.directory);
	pkg.published = isPublished(pkg.name, pkg.version);

	if (pkg.published) {
		console.log(`${pkg.name}@${pkg.version} is already published; validating package contents only.`);
	} else {
		console.log(`${pkg.name}@${pkg.version} is not published; validating package contents before publish.`);
	}
	validatePack(pkg.directory);
	console.log();
}

if (dryRun) {
	process.exit(0);
}

console.log("All packages validated; starting publication.\n");

for (const pkg of packageStates) {
	if (pkg.published) {
		console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
		continue;
	}

	run("npm", ["publish", "--access", "public", "--provenance", "--ignore-scripts"], { cwd: pkg.directory });
	console.log();
}
