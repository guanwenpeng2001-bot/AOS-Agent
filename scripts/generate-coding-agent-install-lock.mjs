#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfies, validRange } from "semver";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const outputDir = join(codingAgentDir, "install-lock");
const rootLockfilePath = join(repoRoot, "package-lock.json");
const outputPackageJsonPath = join(outputDir, "package.json");
const outputLockfilePath = join(outputDir, "package-lock.json");

function isInternalWorkspacePackage(name) {
	return name === "aos-agent" || name.startsWith("@aos-agent/");
}

const installPackageName = "aos-agent-install";
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

function isExactVersionSpec(spec) {
	return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
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

function addInternalWorkspace(installLockPackages, addedPaths, sourceByOutputPath, queue, name, workspace) {
	const packageJson = workspace.packageJson;
	const outputPath = `node_modules/${name}`;
	const existingSourcePath = sourceByOutputPath.get(outputPath);
	if (existingSourcePath !== undefined && existingSourcePath !== workspace.lockPath) {
		throw new Error(`Cannot project ${workspace.lockPath} to ${outputPath}; already mapped from ${existingSourcePath}.`);
	}
	sourceByOutputPath.set(outputPath, workspace.lockPath);
	const entry = copyPackageJsonEntry(packageJson, { includeName: false });
	entry.resolved = registryTarballUrl(name, packageJson.version);

	installLockPackages[outputPath] = sortedPackageEntry(entry);
	addedPaths.add(outputPath);

	for (const [dependencyName, dependencySpec] of prioritizedPackageDependencies(packageJson)) {
		queue.push({ name: dependencyName, spec: dependencySpec, from: workspace.sourceLockPath });
	}
}

function addExternalPackage(
	lockPackages,
	installLockPackages,
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
		const existingOutputPath = resolveExternalDependency(installLockPackages, name, projectedFrom, spec, false);
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
	installLockPackages[outputPath] = copyLockEntry(entry);
	addedPaths.add(outputPath);
	sourceByOutputPath.set(outputPath, lockPath);

	for (const [dependencyName, dependencySpec] of Object.entries(packageDependencies(entry))) {
		queue.push({ name: dependencyName, spec: dependencySpec, from: lockPath });
	}
}

function createInstallerPackageJson(codingAgentPackage) {
	const packageJson = {
		name: installPackageName,
		version: codingAgentPackage.version,
		private: true,
		description: "Lockfile root used by the aos installer and updater.",
		dependencies: {
			[codingAgentPackage.name]: codingAgentPackage.version,
		},
	};
	if (codingAgentPackage.overrides) {
		packageJson.overrides = codingAgentPackage.overrides;
	}
	if (codingAgentPackage.engines) {
		packageJson.engines = codingAgentPackage.engines;
	}
	return packageJson;
}

function createRootLockEntry(installerPackageJson) {
	const entry = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		dependencies: installerPackageJson.dependencies,
	};
	if (installerPackageJson.engines) {
		entry.engines = installerPackageJson.engines;
	}
	return sortedPackageEntry(entry);
}

function validateGeneratedFiles(installerPackageJson, installLock, internalNames) {
	const errors = [];
	const rootEntry = installLock.packages[""];
	const includedPackageNames = new Set();
	const seenAllowedInstallScriptPackages = new Set();

	if (installLock.lockfileVersion !== 3) {
		errors.push("package-lock.json must use lockfileVersion 3");
	}
	if (installLock.name !== installerPackageJson.name) {
		errors.push(`lockfile name ${installLock.name} does not match package.json name ${installerPackageJson.name}`);
	}
	if (installLock.version !== installerPackageJson.version) {
		errors.push(
			`lockfile version ${installLock.version} does not match package.json version ${installerPackageJson.version}`,
		);
	}
	if (JSON.stringify(rootEntry?.dependencies ?? {}) !== JSON.stringify(installerPackageJson.dependencies)) {
		errors.push("lockfile root dependencies do not match package.json dependencies");
	}

	for (const [lockPath, entry] of Object.entries(installLock.packages)) {
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
		if (entry.dev || entry.devOptional || entry.extraneous) {
			errors.push(`${lockPath || "root"} contains dev/extraneous metadata`);
		}
		if (packageName && isInternalWorkspacePackage(packageName) && entry.version !== installerPackageJson.version) {
			errors.push(`${lockPath} internal package version ${entry.version} does not match ${installerPackageJson.version}`);
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

	for (const [lockPath, entry] of Object.entries(installLock.packages)) {
		for (const [dependencyName, dependencySpec] of Object.entries(packageDependencies(entry))) {
			let dependencyLockPath;
			try {
				dependencyLockPath = resolveExternalDependency(
					installLock.packages,
					dependencyName,
					lockPath,
					dependencySpec,
					false,
				);
			} catch {
				errors.push(`${lockPath || "root"} dependency ${dependencyName} is missing`);
				continue;
			}

			const dependencyEntry = installLock.packages[dependencyLockPath];
			if (isExactVersionSpec(dependencySpec) && dependencyEntry.version !== dependencySpec) {
				errors.push(
					`${lockPath || "root"} dependency ${dependencyName}@${dependencySpec} resolves to ${dependencyEntry.version}`,
				);
			}
		}
	}

	const platformPackageCount = Object.values(installLock.packages).filter((entry) => entry.os || entry.cpu || entry.libc)
		.length;
	if (platformPackageCount === 0) {
		errors.push("no platform-specific optional dependency entries found");
	}

	if (errors.length > 0) {
		throw new Error(`Generated installer lock failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

function generateInstallLock() {
	const rootLock = readJson(rootLockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	const installerPackageJson = createInstallerPackageJson(codingAgentPackage);
	const internalWorkspaces = getInternalWorkspaces(lockPackages);
	const workspaceOutputPaths = new Map(
		[...internalWorkspaces.values()].map((workspace) => [
			workspace.lockPath,
			workspace.lockPath === "packages/coding-agent" ? "" : `node_modules/${workspace.packageJson.name}`,
		]),
	);
	const installLockPackages = {
		"": createRootLockEntry(installerPackageJson),
	};
	const addedPaths = new Set([""]);
	const sourceByOutputPath = new Map([["", ""]]);
	const internalNames = new Set();
	const queue = prioritizedPackageDependencies(installerPackageJson).map(([name, spec]) => ({ name, spec, from: "" }));

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
				addInternalWorkspace(installLockPackages, addedPaths, sourceByOutputPath, queue, item.name, workspace);
			}
			continue;
		}

		addExternalPackage(
			lockPackages,
			installLockPackages,
			addedPaths,
			sourceByOutputPath,
			workspaceOutputPaths,
			queue,
			item.name,
			item.spec,
			item.from,
		);
	}

	const installLock = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		lockfileVersion: 3,
		requires: true,
		packages: sortedObject(installLockPackages),
	};

	validateGeneratedFiles(installerPackageJson, installLock, internalNames);
	return { installerPackageJson, installLock };
}

try {
	const { installerPackageJson, installLock } = generateInstallLock();
	const packageJsonContent = `${JSON.stringify(installerPackageJson, null, "\t")}\n`;
	const lockfileContent = `${JSON.stringify(installLock, null, "\t")}\n`;

	if (checkOnly) {
		if (!existsSync(outputPackageJsonPath) || !existsSync(outputLockfilePath)) {
			console.error("packages/coding-agent/install-lock is missing generated files.");
			console.error("Run: npm run install-lock:coding-agent");
			process.exit(1);
		}
		const currentPackageJson = readFileSync(outputPackageJsonPath, "utf8");
		const currentLockfile = readFileSync(outputLockfilePath, "utf8");
		if (currentPackageJson !== packageJsonContent || currentLockfile !== lockfileContent) {
			console.error("packages/coding-agent/install-lock is out of date.");
			console.error("Run: npm run install-lock:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/install-lock is up to date.");
	} else {
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(outputPackageJsonPath, packageJsonContent);
		writeFileSync(outputLockfilePath, lockfileContent);
		const packageCount = Object.keys(installLock.packages).length - 1;
		const platformPackageCount = Object.values(installLock.packages).filter((entry) => entry.os || entry.cpu || entry.libc)
			.length;
		console.log(
			`Wrote packages/coding-agent/install-lock/package.json and package-lock.json (${packageCount} packages, ${platformPackageCount} platform-specific).`,
		);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
