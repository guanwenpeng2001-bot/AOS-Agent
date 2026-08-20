#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { ImagesModel } from "../src/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function readStrictOption(args: string[]): boolean {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--strict") continue;
		if (arg === "--snapshot") {
			index++;
			if (!args[index]) throw new Error("--snapshot requires a file");
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return args.includes("--strict");
}

function readSnapshotPath(args: string[]): string | undefined {
	const index = args.indexOf("--snapshot");
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value) throw new Error("--snapshot requires a file");
	return resolve(value);
}

interface OpenRouterModelRecord {
	id: string;
	name: string;
	context_length?: number;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
}

export function parseOpenRouterImageModels(
	payload: unknown,
	strict: boolean,
): ImagesModel<"openrouter-images">[] {
	const data =
		typeof payload === "object" && payload !== null
			? (payload as { data?: OpenRouterModelRecord[] }).data
			: undefined;
	if (!Array.isArray(data) || data.length === 0) {
		if (strict) throw new Error("OpenRouter API returned a missing or empty image model list");
		return [];
	}

	const models: ImagesModel<"openrouter-images">[] = [];
	for (const model of data) {
		const input = Array.from(
			new Set(
				(model.architecture?.input_modalities ?? []).filter(
					(modality): modality is "text" | "image" => modality === "text" || modality === "image",
				),
			),
		);
		const output = Array.from(
			new Set(
				(model.architecture?.output_modalities ?? []).filter(
					(modality): modality is "text" | "image" => modality === "text" || modality === "image",
				),
			),
		);

		if (!output.includes("image")) continue;
		if (input.length === 0) input.push("text");

		models.push({
			id: model.id,
			name: model.name,
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: OPENROUTER_BASE_URL,
			input,
			output,
			cost: {
				input: parseFloat(model.pricing?.prompt || "0") * 1_000_000,
				output: parseFloat(model.pricing?.completion || "0") * 1_000_000,
				cacheRead: parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000,
				cacheWrite: parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000,
			},
		});
	}

	if (strict && models.length === 0) {
		throw new Error("OpenRouter API returned no usable image models");
	}
	return models;
}

async function fetchOpenRouterImageModels(strict: boolean): Promise<ImagesModel<"openrouter-images">[]> {
	try {
		console.log("Fetching image models from OpenRouter API...");
		const response = await fetch(`${OPENROUTER_BASE_URL}/models?output_modalities=image`);
		if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
		const models = parseOpenRouterImageModels(await response.json(), strict);
		console.log(`Fetched ${models.length} image models from OpenRouter`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenRouter image models:", error);
		if (strict) throw error;
		return [];
	}
}

function isFiniteCost(value: object): boolean {
	const cost = value as Record<string, unknown>;
	return ["input", "output", "cacheRead", "cacheWrite"].every(
		(key) => typeof cost[key] === "number" && Number.isFinite(cost[key]),
	);
}

function loadSnapshotImageModels(snapshotPath: string, strict: boolean): ImagesModel<"openrouter-images">[] {
	if (!existsSync(snapshotPath)) throw new Error(`Image model snapshot does not exist: ${snapshotPath}`);
	const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown;
	if (!Array.isArray(parsed) || parsed.length === 0) {
		if (strict) throw new Error("Image model snapshot must contain a non-empty array");
		return [];
	}
	const models: ImagesModel<"openrouter-images">[] = [];
	for (const value of parsed) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("Image model snapshot contains invalid model metadata");
		}
		const model = value as Record<string, unknown>;
		if (
			typeof model.id !== "string" ||
			typeof model.name !== "string" ||
			model.api !== "openrouter-images" ||
			model.provider !== "openrouter" ||
			typeof model.baseUrl !== "string" ||
			!Array.isArray(model.input) ||
			!model.input.every((entry) => entry === "text" || entry === "image") ||
			!Array.isArray(model.output) ||
			!model.output.every((entry) => entry === "image") ||
			typeof model.cost !== "object" ||
			model.cost === null ||
			Array.isArray(model.cost) ||
			!isFiniteCost(model.cost)
		) {
			throw new Error(`Image model snapshot ${String(model.id ?? "unknown")} has invalid normalized metadata`);
		}
		models.push(model as unknown as ImagesModel<"openrouter-images">);
	}
	return models;
}

function generateImageModelsFile(models: ImagesModel<"openrouter-images">[]): string {
	const imageModelsByProvider = {
		openrouter: Object.fromEntries(
			models
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((model) => [
					model.id,
					`{
			id: ${JSON.stringify(model.id)},
			name: ${JSON.stringify(model.name)},
			api: ${JSON.stringify(model.api)},
			provider: ${JSON.stringify(model.provider)},
			baseUrl: ${JSON.stringify(model.baseUrl)},
			input: ${JSON.stringify(model.input)},
			output: ${JSON.stringify(model.output)},
			cost: ${JSON.stringify(model.cost, null, 2).replace(/^/gm, "\t")}
		} satisfies ImagesModel<${JSON.stringify(model.api)}>`,
				]),
		),
	};

	const providerEntries = Object.entries(imageModelsByProvider)
		.map(([provider, providerModels]) => {
			const modelEntries = Object.entries(providerModels)
				.map(([id, serialized]) => `\t\t${JSON.stringify(id)}: ${serialized},`)
				.join("\n");
			return `\t${JSON.stringify(provider)}: {\n${modelEntries}\n\t},`;
		})
		.join("\n");

	return `// This file is auto-generated by scripts/generate-image-models.ts
// Do not edit manually - run 'npm run generate-image-models' to update

import type { ImagesApi, ImagesModel } from "./types.ts";

export const IMAGE_MODELS = {
${providerEntries}
} as const satisfies Record<string, Record<string, ImagesModel<ImagesApi>>>;
`;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const strict = readStrictOption(args);
	const snapshotPath = readSnapshotPath(args);
	const models = snapshotPath ? loadSnapshotImageModels(snapshotPath, strict) : await fetchOpenRouterImageModels(strict);
	const output = generateImageModelsFile(models);
	const outputPath = join(packageRoot, "src", "image-models.generated.ts");
	writeFileSync(outputPath, output, "utf-8");
	console.log(`Generated ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
