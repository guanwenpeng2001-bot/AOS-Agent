#!/usr/bin/env node

import { copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMain, parseFlagArguments } from "./pack-smoke-common.mjs";

export const STANDALONE_EXTERNAL_CONNECTOR_ASSETS = Object.freeze([
	"fake-connector.json",
	"fake-connector-process.mjs",
	"claude-process-bridge.mjs",
]);

function assertRegularFile(path, description) {
	let stats;
	try {
		stats = lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") throw new Error(`${description} is missing: ${path}`);
		throw error;
	}
	if (!stats.isFile()) throw new Error(`${description} is not a regular file: ${path}`);
}

export function standaloneExternalConnectorAssetsDirectory(executablePath) {
	const resolvedExecutable = resolve(executablePath);
	assertRegularFile(resolvedExecutable, "Standalone executable");
	return join(dirname(resolvedExecutable), "external-connector-assets");
}

export function assertStandaloneExternalConnectorAssets(executablePath) {
	const assetsDirectory = standaloneExternalConnectorAssetsDirectory(executablePath);
	const assetPaths = STANDALONE_EXTERNAL_CONNECTOR_ASSETS.map((asset) => {
		const assetPath = join(assetsDirectory, asset);
		assertRegularFile(assetPath, `Standalone External Connector asset ${asset}`);
		if (readFileSync(assetPath).byteLength === 0) {
			throw new Error(`Standalone External Connector asset ${asset} is empty: ${assetPath}`);
		}
		return assetPath;
	});

	const fixturePath = assetPaths[0];
	let fixture;
	try {
		fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
	} catch {
		throw new Error(`Standalone External Connector fixture is not valid JSON: ${fixturePath}`);
	}
	if (
		fixture?.fixtureId !== "aos.fake-connector" ||
		fixture?.providerId !== "aos.fake-connector" ||
		fixture?.networkMode !== "disabled"
	) {
		throw new Error(`Standalone External Connector fixture identity is invalid: ${fixturePath}`);
	}

	return Object.freeze({
		executablePath: resolve(executablePath),
		assetsDirectory,
		assetPaths: Object.freeze(assetPaths),
	});
}

export function stageStandaloneExternalConnectorAssets({ sourceDirectory, executablePath }) {
	const resolvedSourceDirectory = resolve(sourceDirectory);
	const sourcePaths = STANDALONE_EXTERNAL_CONNECTOR_ASSETS.map((asset) => {
		const sourcePath = join(resolvedSourceDirectory, asset);
		assertRegularFile(sourcePath, `Built External Connector asset ${asset}`);
		return sourcePath;
	});
	const assetsDirectory = standaloneExternalConnectorAssetsDirectory(executablePath);
	mkdirSync(assetsDirectory, { recursive: true });
	for (const [index, sourcePath] of sourcePaths.entries()) {
		copyFileSync(sourcePath, join(assetsDirectory, STANDALONE_EXTERNAL_CONNECTOR_ASSETS[index]));
	}
	return assertStandaloneExternalConnectorAssets(executablePath);
}

function required(args, flag) {
	if (args[flag] === undefined) throw new Error(`${flag} is required`);
	return args[flag];
}

function printUsage() {
	console.log(`Usage:
  node packages/coding-agent/scripts/standalone-archive-assets.mjs stage --source <dir> --executable <path>
  node packages/coding-agent/scripts/standalone-archive-assets.mjs verify --executable <path>
`);
}

function main() {
	const [command, ...rawArgs] = process.argv.slice(2);
	if (command === undefined || command === "--help") {
		printUsage();
		return;
	}
	const args = parseFlagArguments(rawArgs, {
		"--source": "value",
		"--executable": "value",
	});
	const executablePath = required(args, "--executable");
	if (command === "stage") {
		stageStandaloneExternalConnectorAssets({
			sourceDirectory: required(args, "--source"),
			executablePath,
		});
	} else if (command === "verify") {
		if (args["--source"] !== undefined) throw new Error("--source is not allowed with verify");
		assertStandaloneExternalConnectorAssets(executablePath);
	} else {
		throw new Error(`Unknown command: ${command}`);
	}
	console.log(`Standalone External Connector assets ${command === "stage" ? "staged" : "verified"}: ${resolve(executablePath)}`);
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
