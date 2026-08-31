import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));

/** AOS-owned generated model-registry contract. Do not edit generated output by hand. */
export const AOS_MODEL_REGISTRY_SCHEMA_VERSION = 1;
export const AOS_MODEL_REGISTRY_SOURCE_ALLOWLIST_VERSION = 1;
export const AOS_MODEL_REGISTRY_OUTPUT_DIR = resolve(packageRoot, "../../.artifacts/aos-model-registry");
export const AOS_MODEL_REGISTRY_FILE = join(AOS_MODEL_REGISTRY_OUTPUT_DIR, "registry.json");

export type AOSModelRegistrySourceCategory =
	| "official-provider-catalog"
	| "model-gateway"
	| "open-model-registry"
	| "user-supplied-catalog"
	| "future-adapter";

export type AOSModelRegistrySourceAdapter =
	| "imported-provider-normalizer"
	| "user-supplied-catalog-adapter"
	| "future-provider-neutral-adapter";

export type AOSModelRegistryReviewStatus = "pending-source-review" | "approved-for-distribution";

export type AOSModelRegistryComplianceClassification =
	| "approved-for-local-refresh-only"
	| "approved-for-redistribution-under-conditions"
	| "pending/blocked";

export type AOSModelRegistryCoverageStatus = "reused-existing-generated-input" | "future-official-adapter";

export interface AOSModelRegistryCoverageNote {
	id: string;
	providerFamily: string;
	status: AOSModelRegistryCoverageStatus;
	currentProviderIds: readonly string[];
	localEvidence: string;
	nextSourceBoundary: string;
}

/**
 * Candidate metadata inputs used by the imported provider-normalization engine.
 * Public availability is not permission to redistribute; every source remains
 * subject to the review fields below before a generated registry is shipped.
 */
export interface AOSModelRegistrySourcePolicy {
	id: string;
	category: AOSModelRegistrySourceCategory;
	name: string;
	url: string;
	adapter: AOSModelRegistrySourceAdapter;
	ingestionScope: "local-build-candidate" | "user-opt-in" | "future-extension";
	sourceVersionPolicy: string;
	licenseTermsBoundary: string;
	auditReviewedAt: string;
	auditEvidenceUrls: readonly string[];
	complianceClassification: AOSModelRegistryComplianceClassification;
	requiredConditions: readonly string[];
	retrievalDatePolicy: string;
	reviewStatus: AOSModelRegistryReviewStatus;
}

export const AOS_MODEL_REGISTRY_SOURCES: readonly AOSModelRegistrySourcePolicy[] = [
	{
		id: "models-dev",
		category: "open-model-registry",
		name: "models.dev public model metadata API",
		url: "https://models.dev/api.json",
		adapter: "imported-provider-normalizer",
		ingestionScope: "local-build-candidate",
		sourceVersionPolicy: "Use the retrieved response snapshot and record its manifest generatedAt and file hash.",
		licenseTermsBoundary: "The official models.dev repository is MIT-licensed, but its README describes records containing provider and model metadata without a separate data license. The MIT notice does not by itself clear every third-party record for redistribution.",
		auditReviewedAt: "2026-08-10",
		auditEvidenceUrls: [
			"https://github.com/anomalyco/models.dev",
			"https://raw.githubusercontent.com/anomalyco/models.dev/dev/LICENSE",
			"https://raw.githubusercontent.com/anomalyco/models.dev/dev/README.md",
		],
		complianceClassification: "approved-for-local-refresh-only",
		requiredConditions: [
			"Use the documented HTTPS API or an identified repository snapshot and retain the upstream source URL and MIT notice in the audit record.",
			"Keep generated records local and ignored; do not commit or package them until the record-level data and third-party terms boundary is reviewed.",
		],
		retrievalDatePolicy: "input manifest generatedAt",
		reviewStatus: "pending-source-review",
	},
	{
		id: "openrouter",
		category: "model-gateway",
		name: "OpenRouter public model metadata API",
		url: "https://openrouter.ai/api/v1/models",
		adapter: "imported-provider-normalizer",
		ingestionScope: "local-build-candidate",
		sourceVersionPolicy: "Use the retrieved response snapshot and record its manifest generatedAt and file hash.",
		licenseTermsBoundary: "OpenRouter documents the model-list endpoint, but its Terms prohibit scraping or copying information from the Site or Services and require review of applicable model terms. Public endpoint access is not treated as a metadata redistribution license.",
		auditReviewedAt: "2026-08-10",
		auditEvidenceUrls: [
			"https://openrouter.ai/docs/guides/overview/models",
			"https://openrouter.ai/terms",
		],
		complianceClassification: "pending/blocked",
		requiredConditions: [
			"Do not bulk-fetch, scrape, or copy the model listing unless OpenRouter gives explicit permission applicable to this use.",
			"If permission is obtained, review each model and provider terms boundary and retain required notices before any sharing.",
		],
		retrievalDatePolicy: "input manifest generatedAt",
		reviewStatus: "pending-source-review",
	},
	{
		id: "vercel-ai-gateway",
		category: "model-gateway",
		name: "Vercel AI Gateway public model metadata API",
		url: "https://ai-gateway.vercel.sh/v1/models",
		adapter: "imported-provider-normalizer",
		ingestionScope: "local-build-candidate",
		sourceVersionPolicy: "Use the retrieved response snapshot and record its manifest generatedAt and file hash.",
		licenseTermsBoundary: "Vercel documents an unauthenticated model-list endpoint, while its API Terms limit API Data copying and prohibit export, distribution, and data harvesting; AI Gateway use also incorporates Vercel and provider terms. No redistribution permission is asserted.",
		auditReviewedAt: "2026-08-10",
		auditEvidenceUrls: [
			"https://vercel.com/docs/ai-gateway/models-and-providers",
			"https://vercel.com/legal/api-terms",
			"https://vercel.com/legal/ai-product-terms",
		],
		complianceClassification: "pending/blocked",
		requiredConditions: [
			"Limit any local request to documented API use that is permitted for the applicable internal use; do not treat the public endpoint as permission to harvest or redistribute its listing.",
			"Review the applicable provider and model terms before sharing any record; keep output local and ignored until that review is complete.",
		],
		retrievalDatePolicy: "input manifest generatedAt",
		reviewStatus: "pending-source-review",
	},
	{
		id: "nvidia-nim",
		category: "official-provider-catalog",
		name: "NVIDIA NIM public model metadata API",
		url: "https://integrate.api.nvidia.com/v1/models",
		adapter: "imported-provider-normalizer",
		ingestionScope: "local-build-candidate",
		sourceVersionPolicy: "Use the retrieved response snapshot and record its manifest generatedAt and file hash.",
		licenseTermsBoundary: "NVIDIA documents /v1/models for NIM deployments, but NVIDIA API Trial Terms restrict copying or distributing API Service content and defer to accompanying model and third-party licenses. No general metadata redistribution permission was established.",
		auditReviewedAt: "2026-08-10",
		auditEvidenceUrls: [
			"https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html",
			"https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf",
			"https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-community-models-license/",
		],
		complianceClassification: "pending/blocked",
		requiredConditions: [
			"Use only an authorized NIM/API deployment or subscription and never place API credentials in the repository or generated artifact.",
			"Review each model and third-party component license and preserve notices; do not copy or distribute API Service content unless an applicable license expressly permits it.",
		],
		retrievalDatePolicy: "input manifest generatedAt",
		reviewStatus: "pending-source-review",
	},
] as const;

/**
 * Coverage notes are deliberately about the generated local provider inputs,
 * not runtime integrations. Reuse an accurate existing provider or gateway
 * entry before adding another source; future official sources use the existing
 * provider-neutral allowlist fields above.
 */
export const AOS_MODEL_REGISTRY_COVERAGE_NOTES: readonly AOSModelRegistryCoverageNote[] = [
	{
		id: "alibaba-qwen",
		providerFamily: "Alibaba Cloud / Qwen",
		status: "reused-existing-generated-input",
		currentProviderIds: ["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual", "openrouter", "vercel-ai-gateway"],
		localEvidence: "The strict local generator emits Qwen token-plan shards and gateway records from the existing public metadata inputs; no duplicate Alibaba source is added.",
		nextSourceBoundary: "Add an official Alibaba catalog only if a distinct accurate gap remains and its source terms are reviewed.",
	},
	{
		id: "bytedance-ark-doubao",
		providerFamily: "ByteDance Volcengine Ark / Doubao",
		status: "reused-existing-generated-input",
		currentProviderIds: ["openrouter", "vercel-ai-gateway"],
		localEvidence: "The generated gateway shards contain ByteDance/Seed model IDs; no direct runtime provider or duplicate catalog is added.",
		nextSourceBoundary: "A direct Ark catalog remains a future official adapter only if it is machine-readable, unauthenticated for metadata, and terms-reviewed.",
	},
	{
		id: "deepseek",
		providerFamily: "DeepSeek",
		status: "reused-existing-generated-input",
		currentProviderIds: ["deepseek", "openrouter", "vercel-ai-gateway"],
		localEvidence: "The strict local generator emits a direct DeepSeek shard and gateway records from the existing public metadata inputs.",
		nextSourceBoundary: "Do not add a duplicate official catalog unless it provides a reviewed, non-overlapping metadata gap.",
	},
	{
		id: "tencent-hunyuan",
		providerFamily: "Tencent Hunyuan",
		status: "reused-existing-generated-input",
		currentProviderIds: ["openrouter", "vercel-ai-gateway"],
		localEvidence: "The generated gateway shards contain Tencent/HY model IDs; no direct runtime provider or duplicate catalog is added.",
		nextSourceBoundary: "A direct Tencent catalog remains a future official adapter only if its public metadata terms and machine-readable access are verified.",
	},
	{
		id: "baidu-qianfan-ernie",
		providerFamily: "Baidu Qianfan / ERNIE",
		status: "future-official-adapter",
		currentProviderIds: [],
		localEvidence: "No Baidu or ERNIE provider shard or matching gateway model IDs were present in the verified local generated output.",
		nextSourceBoundary: "Baidu's official Qianfan model-list API requires an API key; do not scrape the documentation table or add credentials. Revisit with a reviewed official adapter or an explicitly redistributable source.",
	},
	{
		id: "zhipu-glm",
		providerFamily: "Zhipu / GLM",
		status: "reused-existing-generated-input",
		currentProviderIds: ["zai", "zai-coding-cn", "openrouter", "vercel-ai-gateway"],
		localEvidence: "The strict local generator emits Z.ai/GLM shards and gateway records from the existing public metadata inputs.",
		nextSourceBoundary: "Do not add a duplicate official catalog unless it provides a reviewed, non-overlapping metadata gap.",
	},
	{
		id: "moonshot-kimi",
		providerFamily: "Moonshot / Kimi",
		status: "reused-existing-generated-input",
		currentProviderIds: ["moonshotai", "moonshotai-cn", "kimi-coding", "openrouter", "vercel-ai-gateway"],
		localEvidence: "The strict local generator emits Moonshot/Kimi shards and gateway records from the existing public metadata inputs.",
		nextSourceBoundary: "Do not add a duplicate official catalog unless it provides a reviewed, non-overlapping metadata gap.",
	},
	{
		id: "minimax",
		providerFamily: "MiniMax",
		status: "reused-existing-generated-input",
		currentProviderIds: ["minimax", "minimax-cn", "openrouter", "vercel-ai-gateway"],
		localEvidence: "The strict local generator emits MiniMax shards and gateway records from the existing public metadata inputs.",
		nextSourceBoundary: "Do not add a duplicate official catalog unless it provides a reviewed, non-overlapping metadata gap.",
	},
] as const;

export const AOS_MODEL_REGISTRY_SOURCE_POLICY =
	"AOS_MODEL_REGISTRY_SOURCES is an explicit provider-neutral source allowlist for local generation. It may cover official provider catalogs, model gateways, open-model registries, compatible user-supplied catalogs, and future adapters. Each source records its version policy, terms boundary, audit evidence, compliance classification, and conditions. Public availability is not redistribution permission; the generated registry is a local ignored build artifact and is not an AOS product data release.";

export const AOS_MODEL_REGISTRY_NORMALIZATION_POLICY =
	"Normalize source metadata into the provider-neutral Model contract only; preserve source attribution, record corrections and conflicts in the adapter decision record, omit unknown facts instead of inferring them, and never copy provider code, proprietary registry content, credentials, or unreviewed catalog dumps. The imported normalizer in this baseline performs no AOS-specific corrections; future adapters must make those decisions explicit.";

export const AOS_MODEL_REGISTRY_UPDATE_POLICY =
	"Default build, CI, and release hydrate ignored wrappers from the tracked test/fixtures snapshot. Run npm run update-aos-model-registry from packages/ai to refresh live public metadata inputs and regenerate the ignored AOS registry; run npm run generate-aos-model-registry to reproduce it from already hydrated input data. If a source's terms prohibit automated copying or leave permission uncertain, do not refresh it until the source-specific condition is satisfied. Do not add live integrations, credentials, or user catalogs to the baseline; user-defined sources require explicit opt-in configuration and the same source review record. Never commit or package .artifacts/aos-model-registry/registry.json or its manifest.";
