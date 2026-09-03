import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	STANDALONE_EXTERNAL_CONNECTOR_ASSETS,
	assertStandaloneExternalConnectorAssets,
	stageStandaloneExternalConnectorAssets,
	standaloneExternalConnectorAssetsDirectory,
} from "./standalone-archive-assets.mjs";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtAssetsDirectory = join(packageDirectory, "src", "core", "connector", "assets");

function createExecutable(root) {
	const executablePath = join(root, process.platform === "win32" ? "aos.exe" : "aos");
	writeFileSync(executablePath, "compiled executable placeholder");
	return executablePath;
}

test("stages built assets beside the standalone executable and verifies the resolved layout", () => {
	const root = mkdtempSync(join(tmpdir(), "aos-standalone-assets-"));
	try {
		const executablePath = createExecutable(root);
		const result = stageStandaloneExternalConnectorAssets({ sourceDirectory: builtAssetsDirectory, executablePath });
		assert.equal(result.assetsDirectory, join(root, "external-connector-assets"));
		assert.deepEqual(
			result.assetPaths,
			STANDALONE_EXTERNAL_CONNECTOR_ASSETS.map((asset) => join(root, "external-connector-assets", asset)),
		);
		assert.deepEqual(assertStandaloneExternalConnectorAssets(executablePath), result);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reports each missing built asset before creating the executable-relative directory", () => {
	for (const missingAsset of STANDALONE_EXTERNAL_CONNECTOR_ASSETS) {
		const root = mkdtempSync(join(tmpdir(), "aos-standalone-source-failure-"));
		try {
			const executablePath = createExecutable(root);
			const sourceDirectory = join(root, "built-assets");
			mkdirSync(sourceDirectory);
			for (const asset of STANDALONE_EXTERNAL_CONNECTOR_ASSETS) {
				if (asset !== missingAsset) copyFileSync(join(builtAssetsDirectory, asset), join(sourceDirectory, asset));
			}
			assert.throws(
				() => stageStandaloneExternalConnectorAssets({ sourceDirectory, executablePath }),
				new RegExp(`Built External Connector asset ${missingAsset.replaceAll(".", "\\.")} is missing`, "u"),
			);
			assert.throws(
				() => standaloneExternalConnectorAssetsDirectory(join(root, "missing-executable")),
				/Standalone executable is missing/u,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("archive verification reports each missing or unusable executable-relative asset", () => {
	for (const missingAsset of STANDALONE_EXTERNAL_CONNECTOR_ASSETS) {
		const root = mkdtempSync(join(tmpdir(), "aos-standalone-archive-failure-"));
		try {
			const executablePath = createExecutable(root);
			const assetsDirectory = join(root, "external-connector-assets");
			mkdirSync(assetsDirectory);
			for (const asset of STANDALONE_EXTERNAL_CONNECTOR_ASSETS) {
				if (asset !== missingAsset) copyFileSync(join(builtAssetsDirectory, asset), join(assetsDirectory, asset));
			}
			assert.throws(
				() => assertStandaloneExternalConnectorAssets(executablePath),
				new RegExp(`Standalone External Connector asset ${missingAsset.replaceAll(".", "\\.")} is missing`, "u"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	const root = mkdtempSync(join(tmpdir(), "aos-standalone-invalid-fixture-"));
	try {
		const executablePath = createExecutable(root);
		const assetsDirectory = join(root, "external-connector-assets");
		mkdirSync(assetsDirectory);
		for (const asset of STANDALONE_EXTERNAL_CONNECTOR_ASSETS) {
			copyFileSync(join(builtAssetsDirectory, asset), join(assetsDirectory, asset));
		}
		writeFileSync(join(assetsDirectory, "fake-connector.json"), "{}");
		assert.throws(
			() => assertStandaloneExternalConnectorAssets(executablePath),
			/Standalone External Connector fixture identity is invalid/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
