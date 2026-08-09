#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AOS_MODEL_REGISTRY_FILE,
	AOS_MODEL_REGISTRY_COVERAGE_NOTES,
	AOS_MODEL_REGISTRY_NORMALIZATION_POLICY,
	AOS_MODEL_REGISTRY_OUTPUT_DIR,
	AOS_MODEL_REGISTRY_SCHEMA_VERSION,
	AOS_MODEL_REGISTRY_SOURCE_ALLOWLIST_VERSION,
	AOS_MODEL_REGISTRY_SOURCE_POLICY,
	AOS_MODEL_REGISTRY_SOURCES,
	AOS_MODEL_REGISTRY_UPDATE_POLICY,
} from "./aos-model-registry-config.ts";
import {
	MODEL_DATA_MANIFEST_FILE,
	readModelDataProviderIds,
	validateGeneratedModelData,
	type ModelDataManifest,
} from "./model-data.ts";

const packageRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = join(packageRoot, "src", "providers", "data");
const manifestPath = join(dataDir, MODEL_DATA_MANIFEST_FILE);

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function readManifest(): ModelDataManifest {
	if (!existsSync(manifestPath)) {
		throw new Error(
			`AOS model-registry input is missing at ${dataDir}. Run \"npm run update-aos-model-registry\" to fetch public catalog inputs, or provide an already hydrated upstream-compatible model-data snapshot.`,
		);
	}
	return JSON.parse(readFileSync(manifestPath, "utf8")) as ModelDataManifest;
}

function validateSourceAllowlist(): void {
	const ids = new Set<string>();
	for (const source of AOS_MODEL_REGISTRY_SOURCES) {
		if (ids.has(source.id)) {
			throw new Error(`Duplicate AOS model-registry source id: ${source.id}`);
		}
		ids.add(source.id);
		if (!source.url.startsWith("https://")) {
			throw new Error(`AOS model-registry source must use HTTPS: ${source.id}`);
		}
		if (source.auditEvidenceUrls.length === 0) {
			throw new Error(`AOS model-registry source is missing audit evidence: ${source.id}`);
		}
		if (Number.isNaN(Date.parse(source.auditReviewedAt))) {
			throw new Error(`AOS model-registry source has an invalid audit date: ${source.id}`);
		}
		if (source.requiredConditions.length === 0) {
			throw new Error(`AOS model-registry source is missing conditions: ${source.id}`);
		}
		if (
			source.reviewStatus === "approved-for-distribution" &&
			source.complianceClassification !== "approved-for-redistribution-under-conditions"
		) {
			throw new Error(`AOS model-registry source has an incompatible distribution review: ${source.id}`);
		}
	}
}

function validateCoverageNotes(providerIds: readonly string[]): void {
	const noteIds = new Set<string>();
	const availableProviderIds = new Set(providerIds);
	for (const note of AOS_MODEL_REGISTRY_COVERAGE_NOTES) {
		if (noteIds.has(note.id)) {
			throw new Error(`Duplicate AOS model-registry coverage note id: ${note.id}`);
		}
		noteIds.add(note.id);
		if (note.status === "future-official-adapter" && note.currentProviderIds.length > 0) {
			throw new Error(`Future AOS coverage note must not claim current provider ids: ${note.id}`);
		}
		if (note.status === "reused-existing-generated-input" && note.currentProviderIds.length === 0) {
			throw new Error(`Reused AOS coverage note is missing current provider ids: ${note.id}`);
		}
		for (const providerId of note.currentProviderIds) {
			if (!availableProviderIds.has(providerId)) {
				throw new Error(`AOS coverage note references missing generated provider ${providerId}: ${note.id}`);
			}
		}
	}
}

function buildRegistry(): { registry: unknown; registryText: string } {
	validateSourceAllowlist();
	validateGeneratedModelData(packageRoot);
	const inputManifest = readManifest();
	const providerIds = readModelDataProviderIds(packageRoot);
	validateCoverageNotes(providerIds);
	const providers = Object.fromEntries(
		providerIds.map((providerId) => {
			const path = join(dataDir, `${providerId}.json`);
			return [providerId, JSON.parse(readFileSync(path, "utf8"))];
		}),
	);
	const classificationCounts = Object.fromEntries(
		AOS_MODEL_REGISTRY_SOURCES.reduce(
			(counts, source) => counts.set(source.complianceClassification, (counts.get(source.complianceClassification) ?? 0) + 1),
			new Map<string, number>(),
		),
	);
	const pendingSourceCount = AOS_MODEL_REGISTRY_SOURCES.filter((source) => source.reviewStatus !== "approved-for-distribution").length;
	const registry = {
		schemaVersion: AOS_MODEL_REGISTRY_SCHEMA_VERSION,
		sourceAllowlistVersion: AOS_MODEL_REGISTRY_SOURCE_ALLOWLIST_VERSION,
		generatedAt: inputManifest.generatedAt,
		product: "AOS Agent",
		input: {
			modelDataSchemaVersion: inputManifest.schemaVersion,
			structureHash: inputManifest.structureHash,
			files: inputManifest.files,
		},
		sources: AOS_MODEL_REGISTRY_SOURCES.map((source) => ({
			...source,
			retrievalDate: inputManifest.generatedAt,
		})),
		sourcePolicy: {
			statement: AOS_MODEL_REGISTRY_SOURCE_POLICY,
			localArtifact: {
				path: ".artifacts/aos-model-registry/registry.json",
				generatedFor: "local-build-and-refresh-only",
				trackedByGit: false,
				packagedByAos: false,
				redistribution: "not-a-product-output",
			},
			sourceAudit: {
				classificationCounts,
				pendingReviewCount: pendingSourceCount,
			},
			userExtensions: "opt-in-only",
		},
		coverageNotes: AOS_MODEL_REGISTRY_COVERAGE_NOTES,
		normalizationPolicy: AOS_MODEL_REGISTRY_NORMALIZATION_POLICY,
		updatePolicy: AOS_MODEL_REGISTRY_UPDATE_POLICY,
		providers: providerIds,
		models: providers,
	};
	return { registry, registryText: serialize(registry) };
}

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const unknownArgs = [...args].filter((arg) => arg !== "--check");
if (unknownArgs.length > 0) {
	throw new Error(`Unknown argument: ${unknownArgs.join(", ")}. Supported argument: --check`);
}

const { registryText } = buildRegistry();
if (checkOnly) {
	if (!existsSync(AOS_MODEL_REGISTRY_FILE)) {
		throw new Error(`AOS model registry is missing at ${AOS_MODEL_REGISTRY_FILE}`);
	}
	const current = readFileSync(AOS_MODEL_REGISTRY_FILE, "utf8");
	if (current !== registryText) {
		throw new Error(`AOS model registry is stale at ${AOS_MODEL_REGISTRY_FILE}`);
	}
	console.log(`AOS model registry is valid: ${AOS_MODEL_REGISTRY_FILE}`);
} else {
	mkdirSync(AOS_MODEL_REGISTRY_OUTPUT_DIR, { recursive: true });
	writeFileSync(AOS_MODEL_REGISTRY_FILE, registryText);
	writeFileSync(
		join(AOS_MODEL_REGISTRY_OUTPUT_DIR, "manifest.json"),
		serialize({
			schemaVersion: AOS_MODEL_REGISTRY_SCHEMA_VERSION,
			generatedAt: JSON.parse(registryText).generatedAt,
			registrySha256: sha256(registryText),
		}),
	);
	console.log(`Generated AOS model registry at ${AOS_MODEL_REGISTRY_FILE}`);
}
