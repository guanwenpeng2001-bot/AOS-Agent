#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfies, validRange } from "semver";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const rootLockfilePath = join(repoRoot, "package-lock.json");
const shrinkwrapPath = join(codingAgentDir, "npm-shrinkwrap.json");

function isInternalWorkspacePackage(name) {
	return name === "aos-agent" || name.startsWith("@aos-agent/");
}

const allowedInstallScriptPackages = new Map([
	["@google/genai@1.52.0", "preinstall is a no-op in the published package"],
	["protobufjs@7.6.5", "postinstall only warns about protobufjs version scheme mismatches"],
]);

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

for (const arg of args) {
	if (arg !== "--check") {
		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageDependencies(entry) {
	return {
		...(entry.dependencies ?? {}),
		...(entry.optionalDependencies ?? {}),
	};
}

function prioritizedPackageDependencies(entry) {
	return [
		...Object.entries(entry.optionalDependencies ?? {}),
		...Object.entries(entry.dependencies ?? {}),
	];
}

function sortedObject(object) {
	return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function sortedPackageEntry(entry) {
	const fieldOrder = [
		"name",
		"version",
		"resolved",
		"integrity",
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
		"optional",
		"hasInstallScript",
		"deprecated",
		"funding",
	];
	const sorted = {};

	for (const field of fieldOrder) {
		if (entry[field] !== undefined) {
			sorted[field] = entry[field];
		}
	}
	for (const [field, value] of Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) {
		if (sorted[field] === undefined) {
			sorted[field] = value;
		}
	}
	return sorted;
}

function copyLockEntry(entry) {
	const copied = { ...entry };
	delete copied.dev;
	delete copied.devOptional;
	delete copied.extraneous;
	delete copied.link;
	return sortedPackageEntry(copied);
}

function copyPackageJsonEntry(packageJson, options) {
	const entry = options.includeName
		? { name: packageJson.name, version: packageJson.version }
		: { version: packageJson.version };

	for (const field of [
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
	]) {
		if (packageJson[field] !== undefined) {
			entry[field] = packageJson[field];
		}
	}

	return sortedPackageEntry(entry);
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) {
		return undefined;
	}

	const parts = lockPath.slice(index + marker.length).split("/");
	if (parts[0]?.startsWith("@")) {
		return `${parts[0]}/${parts[1]}`;
	}
	return parts[0];
}

function registryTarballUrl(packageName, version) {
	const tarballName = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
	return `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
}

function projectLockPath(lockPath, workspaceOutputPaths) {
	const marker = "/node_modules/";
	const markerIndex = lockPath.indexOf(marker);
	if (markerIndex === -1) {
		return lockPath;
	}

	const workspaceLockPath = lockPath.slice(0, markerIndex);
	const workspaceOutputPath = workspaceOutputPaths.get(workspaceLockPath);
	if (workspaceOutputPath === undefined) {
		return lockPath;
	}

	const dependencyPath = lockPath.slice(markerIndex + marker.length);
	return workspaceOutputPath ? `${workspaceOutputPath}/node_modules/${dependencyPath}` : `node_modules/${dependencyPath}`;
}

function matchesDependencySpec(entry, spec) {
	if (!spec) {
		return true;
	}
	if (!entry || typeof entry.version !== "string") {
		return false;
	}
	if (entry.version === spec) {
		return true;
	}

	try {
		const range = validRange(spec);
		return range !== null && satisfies(entry.version, range, { includePrerelease: true });
	} catch {
		return false;
	}
}

function getInternalWorkspaces(lockPackages) {
	const workspaces = new Map();

	for (const [lockPath, entry] of Object.entries(lockPackages)) {
		if (!lockPath.startsWith("packages/") || lockPath.includes("/node_modules/") || !entry.name || !entry.version) {
			continue;
		}
		if (!isInternalWorkspacePackage(entry.name)) {
			continue;
		}

		workspaces.set(entry.name, {
			lockPath,
			sourceLockPath:
				lockPath === "packages/coding-agent" ? lockPath : `packages/coding-agent/node_modules/${entry.name}`,
			packageJson: readJson(join(repoRoot, lockPath, "package.json")),
		});
	}

	return workspaces;
}

function resolveExternalDependency(lockPackages, packageName, fromLockPath, requestedSpec, allowFallback = true) {
	const candidateDirs = [];
	let current = fromLockPath;

	while (current) {
		candidateDirs.push(current);
		const parent = posix.dirname(current);
		if (parent === "." || parent === current) {
			break;
		}
		current = parent;
	}
	candidateDirs.push("");

	const tried = new Set();
	for (const directory of candidateDirs) {
		const candidate = directory ? `${directory}/node_modules/${packageName}` : `node_modules/${packageName}`;
		if (tried.has(candidate)) {
			continue;
		}
		tried.add(candidate);

		const entry = lockPackages[candidate];
		if (entry && !entry.link && matchesDependencySpec(entry, requestedSpec)) {
			return candidate;
		}
	}
	if (!allowFallback) {
		throw new Error(`Cannot resolve ${packageName} from ${fromLockPath || "root"}. No matching lockfile entry found.`);
	}

	const suffix = `node_modules/${packageName}`;
	const matches = Object.entries(lockPackages)
		.filter(
			([lockPath, entry]) =>
				!entry.link &&
				(lockPath === suffix || lockPath.endsWith(`/${suffix}`)) &&
				matchesDependencySpec(entry, requestedSpec),
		)
		.map(([lockPath]) => lockPath);

	if (matches.length === 1) {
		return matches[0];
	}

	throw new Error(
		`Cannot resolve ${packageName}${requestedSpec ? `@${requestedSpec}` : ""} from ${fromLockPath || "root"}. ` +
			(matches.length > 1 ? `Matches: ${matches.join(", ")}` : "No matching lockfile entry found."),
	);
}

function addInternalWorkspace(shrinkwrapPackages, addedPaths, sourceByOutputPath, queue, name, workspace) {
	const packageJson = workspace.packageJson;
	const outputPath = `node_modules/${name}`;
	const existingSourcePath = sourceByOutputPath.get(outputPath);
	if (existingSourcePath !== undefined && existingSourcePath !== workspace.lockPath) {
		throw new Error(`Cannot project ${workspace.lockPath} to ${outputPath}; already mapped from ${existingSourcePath}.`);
	}
	sourceByOutputPath.set(outputPath, workspace.lockPath);
	const entry = copyPackageJsonEntry(packageJson, { includeName: false });
	entry.resolved = registryTarballUrl(name, packageJson.version);

	shrinkwrapPackages[outputPath] = sortedPackageEntry(entry);
	addedPaths.add(outputPath);

	for (const [dependencyName, dependencySpec] of prioritizedPackageDependencies(packageJson)) {
		queue.push({ name: dependencyName, spec: dependencySpec, from: workspace.sourceLockPath });
	}
}

function addExternalPackage(
	lockPackages,
	shrinkwrapPackages,
	addedPaths,
	sourceByOutputPath,
	workspaceOutputPaths,
	queue,
	name,
	spec,
	from,
) {
	const projectedFrom = projectLockPath(from, workspaceOutputPaths);
	try {
		const existingOutputPath = resolveExternalDependency(shrinkwrapPackages, name, projectedFrom, spec, false);
		if (sourceByOutputPath.has(existingOutputPath)) {
			return;
		}
	} catch {
		// Resolve the dependency from the authoritative workspace lock below.
	}

	const lockPath = resolveExternalDependency(lockPackages, name, from, spec);
	const outputPath = projectLockPath(lockPath, workspaceOutputPaths);
	if (addedPaths.has(outputPath)) {
		const existingSourcePath = sourceByOutputPath.get(outputPath);
		if (existingSourcePath !== undefined && existingSourcePath !== lockPath) {
			throw new Error(`Cannot project ${lockPath} to ${outputPath}; already mapped from ${existingSourcePath}.`);
		}
		return;
	}

	const entry = lockPackages[lockPath];
	shrinkwrapPackages[outputPath] = copyLockEntry(entry);
	addedPaths.add(outputPath);
	sourceByOutputPath.set(outputPath, lockPath);

	for (const [dependencyName, dependencySpec] of Object.entries(packageDependencies(entry))) {
		queue.push({ name: dependencyName, spec: dependencySpec, from: lockPath });
	}
}

function validateShrinkwrap(shrinkwrap, internalNames) {
	const errors = [];
	const includedPaths = new Set(Object.keys(shrinkwrap.packages));
	const includedPackageNames = new Set();
	const seenAllowedInstallScriptPackages = new Set();

	for (const [lockPath, entry] of Object.entries(shrinkwrap.packages)) {
		if (lockPath && !lockPath.startsWith("node_modules/")) {
			errors.push(`${lockPath} is not projected into the package install layout`);
		}
		const packageName = packageNameFromLockPath(lockPath);
		if (packageName) {
			includedPackageNames.add(packageName);
		}
		if (entry.link) {
			errors.push(`${lockPath} is a link entry`);
		}
		if (typeof entry.resolved === "string" && /^(file:|link:|workspace:|\.\.?\/|\/)/.test(entry.resolved)) {
			errors.push(`${lockPath} has a local resolved value: ${entry.resolved}`);
		}
		if (entry.hasInstallScript) {
			if (!packageName || !entry.version) {
				errors.push(`${lockPath || "root"} has install scripts but no package name/version`);
			} else {
				const packageId = `${packageName}@${entry.version}`;
				if (allowedInstallScriptPackages.has(packageId)) {
					seenAllowedInstallScriptPackages.add(packageId);
				} else {
					errors.push(
						`${lockPath} has install scripts (${packageId}). Review it and add it to allowedInstallScriptPackages if intentional.`,
					);
				}
			}
		}
	}

	for (const packageId of allowedInstallScriptPackages.keys()) {
		if (!seenAllowedInstallScriptPackages.has(packageId)) {
			errors.push(`allowed install-script package ${packageId} is no longer present; remove it from the allowlist`);
		}
	}

	for (const name of internalNames) {
		if (!includedPackageNames.has(name)) {
			errors.push(`internal dependency ${name} is missing`);
		}
	}

	for (const [lockPath, entry] of Object.entries(shrinkwrap.packages)) {
		for (const dependencyName of Object.keys(packageDependencies(entry))) {
			const dependencyIncluded = [...includedPaths].some(
				(candidate) => candidate === `node_modules/${dependencyName}` || candidate.endsWith(`/node_modules/${dependencyName}`),
			);
			if (!dependencyIncluded) {
				errors.push(`${lockPath || "root"} dependency ${dependencyName} is missing`);
			}
		}
	}

	const platformPackageCount = Object.values(shrinkwrap.packages).filter((entry) => entry.os || entry.cpu || entry.libc).length;
	if (platformPackageCount === 0) {
		errors.push("no platform-specific optional dependency entries found");
	}

	if (errors.length > 0) {
		throw new Error(`Generated shrinkwrap failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

function generateShrinkwrap() {
	const rootLock = readJson(rootLockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	const internalWorkspaces = getInternalWorkspaces(lockPackages);
	const workspaceOutputPaths = new Map(
		[...internalWorkspaces.values()].map((workspace) => [
			workspace.lockPath,
			workspace.lockPath === "packages/coding-agent" ? "" : `node_modules/${workspace.packageJson.name}`,
		]),
	);
	const shrinkwrapPackages = {
		"": copyPackageJsonEntry(codingAgentPackage, { includeName: true }),
	};
	const addedPaths = new Set([""]);
	const sourceByOutputPath = new Map([["", ""]]);
	const internalNames = new Set();
	const queue = prioritizedPackageDependencies(codingAgentPackage).map(([name, spec]) => ({ name, spec, from: "" }));

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) {
			break;
		}

		const workspace = internalWorkspaces.get(item.name);
		if (workspace) {
			const outputPath = `node_modules/${item.name}`;
			internalNames.add(item.name);
			if (!addedPaths.has(outputPath)) {
				addInternalWorkspace(shrinkwrapPackages, addedPaths, sourceByOutputPath, queue, item.name, workspace);
			}
			continue;
		}

		addExternalPackage(
			lockPackages,
			shrinkwrapPackages,
			addedPaths,
			sourceByOutputPath,
			workspaceOutputPaths,
			queue,
			item.name,
			item.spec,
			item.from,
		);
	}

	const shrinkwrap = {
		name: codingAgentPackage.name,
		version: codingAgentPackage.version,
		lockfileVersion: 3,
		requires: true,
		packages: sortedObject(shrinkwrapPackages),
	};

	validateShrinkwrap(shrinkwrap, internalNames);
	return shrinkwrap;
}

try {
	const shrinkwrap = generateShrinkwrap();
	const content = `${JSON.stringify(shrinkwrap, null, "\t")}\n`;

	if (checkOnly) {
		if (!existsSync(shrinkwrapPath)) {
			console.error("packages/coding-agent/npm-shrinkwrap.json is missing.");
			console.error("Run: npm run shrinkwrap:coding-agent");
			process.exit(1);
		}
		const current = readFileSync(shrinkwrapPath, "utf8");
		if (current !== content) {
			console.error("packages/coding-agent/npm-shrinkwrap.json is out of date.");
			console.error("Run: npm run shrinkwrap:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/npm-shrinkwrap.json is up to date.");
	} else {
		writeFileSync(shrinkwrapPath, content);
		const packageCount = Object.keys(shrinkwrap.packages).length - 1;
		const platformPackageCount = Object.values(shrinkwrap.packages).filter((entry) => entry.os || entry.cpu || entry.libc).length;
		console.log(
			`Wrote packages/coding-agent/npm-shrinkwrap.json (${packageCount} packages, ${platformPackageCount} platform-specific).`,
		);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
