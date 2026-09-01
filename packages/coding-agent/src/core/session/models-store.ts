import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@aos-agent/ai";
import { getAgentDir } from "../../config.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { getFileRevision, normalizePath } from "../../utils/paths.ts";
import { LockedAtomicFileStorage, readControlPlaneStateReadOnly } from "../control-plane-atomic-storage.ts";

type StoredModels = Record<string, ModelsStoreEntry>;

type ModelsFileReload = {
	controller: AbortController;
	promise: Promise<StoredModels>;
	readers: number;
};

type ModelsFileReadState = {
	data: StoredModels;
	revision?: string;
	reload?: ModelsFileReload;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function hasOptionalBooleans(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return keys.every((key) => value[key] === undefined || typeof value[key] === "boolean");
}

function isStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isChatTemplateKwargValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	return isRecord(value) &&
		hasOnlyKeys(value, new Set(["$var", "omitWhenOff"])) &&
		(value.$var === "thinking.enabled" || value.$var === "thinking.effort") &&
		(value.omitWhenOff === undefined || typeof value.omitWhenOff === "boolean");
}

function isChatTemplateKwargs(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every(isChatTemplateKwargValue);
}

const ROUTING_PERCENTILE_KEYS = new Set(["p50", "p75", "p90", "p99"]);

function isRoutingPercentiles(value: unknown): boolean {
	return isRecord(value) &&
		hasOnlyKeys(value, ROUTING_PERCENTILE_KEYS) &&
		Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item));
}

function isOpenRouterRouting(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const keys = new Set([
		"allow_fallbacks",
		"require_parameters",
		"data_collection",
		"zdr",
		"enforce_distillable_text",
		"order",
		"only",
		"ignore",
		"quantizations",
		"sort",
		"max_price",
		"preferred_min_throughput",
		"preferred_max_latency",
	]);
	if (!hasOnlyKeys(value, keys)) return false;
	if (!hasOptionalBooleans(value, ["allow_fallbacks", "require_parameters", "zdr", "enforce_distillable_text"])) {
		return false;
	}
	if (value.data_collection !== undefined && value.data_collection !== "allow" && value.data_collection !== "deny") {
		return false;
	}
	for (const key of ["order", "only", "ignore", "quantizations"]) {
		if (value[key] !== undefined && !isStringArray(value[key])) return false;
	}
	if (
		value.sort !== undefined &&
		typeof value.sort !== "string" &&
		(!isRecord(value.sort) ||
			!hasOnlyKeys(value.sort, new Set(["by", "partition"])) ||
			(value.sort.by !== undefined && typeof value.sort.by !== "string") ||
			(value.sort.partition !== undefined && value.sort.partition !== null && typeof value.sort.partition !== "string"))
	) return false;
	if (value.max_price !== undefined) {
		if (!isRecord(value.max_price) || !hasOnlyKeys(value.max_price, new Set(["prompt", "completion", "image", "audio", "request"]))) {
			return false;
		}
		if (!Object.values(value.max_price).every((item) =>
			typeof item === "string" || typeof item === "number" && Number.isFinite(item)
		)) return false;
	}
	for (const key of ["preferred_min_throughput", "preferred_max_latency"]) {
		const item = value[key];
		if (
			item !== undefined &&
			!(typeof item === "number" && Number.isFinite(item)) &&
			!isRoutingPercentiles(item)
		) return false;
	}
	return true;
}

function isVercelGatewayRouting(value: unknown): boolean {
	return isRecord(value) &&
		hasOnlyKeys(value, new Set(["only", "order"])) &&
		(value.only === undefined || isStringArray(value.only)) &&
		(value.order === undefined || isStringArray(value.order));
}

function isValidModelCompat(api: string, value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (api === "bedrock-converse-stream") {
		return hasOnlyKeys(value, new Set(["supportsStrictMode"])) &&
			hasOptionalBooleans(value, ["supportsStrictMode"]);
	}
	if (api === "anthropic-messages") {
		const keys = [
			"supportsEagerToolInputStreaming",
			"supportsLongCacheRetention",
			"sendSessionAffinityHeaders",
			"supportsCacheControlOnTools",
			"supportsTemperature",
			"forceAdaptiveThinking",
			"allowEmptySignature",
			"supportsStrictTools",
			"supportsToolReferences",
		];
		return hasOnlyKeys(value, new Set(keys)) && hasOptionalBooleans(value, keys);
	}
	if (
		api === "openai-responses" ||
		api === "azure-openai-responses" ||
		api === "openai-codex-responses"
	) {
		const booleanKeys = [
			"supportsDeveloperRole",
			"supportsLongCacheRetention",
			"supportsStrictMode",
			"supportsOpenAIGrammarTools",
			"supportsAdditionalTools",
			"supportsToolSearch",
			"supportsExplicitPromptCacheMode",
		];
		return hasOnlyKeys(value, new Set([...booleanKeys, "sessionAffinityFormat"])) &&
			hasOptionalBooleans(value, booleanKeys) &&
			(value.sessionAffinityFormat === undefined ||
				value.sessionAffinityFormat === "openai" ||
				value.sessionAffinityFormat === "openai-nosession" ||
				value.sessionAffinityFormat === "openrouter");
	}
	if (api !== "openai-completions") return false;
	const booleanKeys = [
		"supportsStore",
		"supportsDeveloperRole",
		"supportsReasoningEffort",
		"supportsUsageInStreaming",
		"supportsFinishReason",
		"requiresToolResultName",
		"requiresAssistantAfterToolResult",
		"requiresThinkingAsText",
		"requiresReasoningContentOnAssistantMessages",
		"zaiToolStream",
		"supportsThinkingTokenBudget",
		"supportsOpenAIGrammarTools",
		"supportsStrictMode",
		"sendSessionAffinityHeaders",
		"supportsLongCacheRetention",
	];
	const keys = new Set([
		...booleanKeys,
		"maxTokensField",
		"thinkingFormat",
		"chatTemplateKwargs",
		"chatTemplateArgs",
		"openRouterRouting",
		"vercelGatewayRouting",
		"cacheControlFormat",
		"deferredToolsMode",
		"sessionAffinityFormat",
	]);
	const thinkingFormats = new Set([
		"openai",
		"openrouter",
		"deepseek",
		"together",
		"baseten",
		"zai",
		"qwen",
		"chat-template",
		"qwen-chat-template",
		"string-thinking",
		"ant-ling",
	]);
	return hasOnlyKeys(value, keys) &&
		hasOptionalBooleans(value, booleanKeys) &&
		(value.maxTokensField === undefined || value.maxTokensField === "max_completion_tokens" || value.maxTokensField === "max_tokens") &&
		(value.thinkingFormat === undefined || typeof value.thinkingFormat === "string" && thinkingFormats.has(value.thinkingFormat)) &&
		(value.chatTemplateKwargs === undefined || isChatTemplateKwargs(value.chatTemplateKwargs)) &&
		(value.chatTemplateArgs === undefined || isChatTemplateKwargs(value.chatTemplateArgs)) &&
		(value.openRouterRouting === undefined || isOpenRouterRouting(value.openRouterRouting)) &&
		(value.vercelGatewayRouting === undefined || isVercelGatewayRouting(value.vercelGatewayRouting)) &&
		(value.cacheControlFormat === undefined || value.cacheControlFormat === "anthropic") &&
		(value.deferredToolsMode === undefined || value.deferredToolsMode === "kimi") &&
		(value.sessionAffinityFormat === undefined ||
			value.sessionAffinityFormat === "openai" ||
			value.sessionAffinityFormat === "openai-nosession" ||
			value.sessionAffinityFormat === "openrouter");
}

const MODEL_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isValidModel(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	if (
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		typeof value.api !== "string" ||
		typeof value.provider !== "string" ||
		typeof value.baseUrl !== "string" ||
		typeof value.reasoning !== "boolean" ||
		!Array.isArray(value.input) ||
		!value.input.every((item) => item === "text" || item === "image") ||
		!isFiniteNonNegative(value.contextWindow) ||
		!isFiniteNonNegative(value.maxTokens) ||
		!isFiniteNonNegative(value.cost.input) ||
		!isFiniteNonNegative(value.cost.output) ||
		!isFiniteNonNegative(value.cost.cacheRead) ||
		!isFiniteNonNegative(value.cost.cacheWrite)
	) return false;
	if (value.headers !== undefined && !isStringRecord(value.headers)) return false;
	if (value.samplingParams !== undefined && !isRecord(value.samplingParams)) return false;
	if (value.compat !== undefined && !isValidModelCompat(value.api, value.compat)) return false;
	if (
		value.thinkingLevelMap !== undefined &&
		(!isRecord(value.thinkingLevelMap) ||
			!Object.entries(value.thinkingLevelMap).every(([level, item]) =>
				MODEL_THINKING_LEVELS.has(level) && (typeof item === "string" || item === null)
			))
	) return false;
	if (value.cost.tiers !== undefined) {
		if (!Array.isArray(value.cost.tiers)) return false;
		for (const tier of value.cost.tiers) {
			if (
				!isRecord(tier) ||
				!isFiniteNonNegative(tier.inputTokensAbove) ||
				!isFiniteNonNegative(tier.input) ||
				!isFiniteNonNegative(tier.output) ||
				!isFiniteNonNegative(tier.cacheRead) ||
				!isFiniteNonNegative(tier.cacheWrite)
			) return false;
		}
	}
	return true;
}

function isValidModelsStoreEntry(value: unknown): value is ModelsStoreEntry {
	return isRecord(value) &&
		Array.isArray(value.models) &&
		value.models.every(isValidModel) &&
		(value.lastModified === undefined || isFiniteNonNegative(value.lastModified)) &&
		(value.checkedAt === undefined || isFiniteNonNegative(value.checkedAt)) &&
		(value.etag === undefined || typeof value.etag === "string");
}

function parseStoredModels(content: string): StoredModels {
	const parsed: unknown = JSON.parse(content);
	if (!isRecord(parsed)) {
		throw new Error("Invalid models store: expected an object");
	}
	const stored: StoredModels = {};
	for (const [providerId, entry] of Object.entries(parsed)) {
		if (!isValidModelsStoreEntry(entry)) {
			throw new Error(`Invalid models store entry for provider ${providerId}`);
		}
		stored[providerId] = entry;
	}
	return stored;
}

const MODELS_STORAGE_OPTIONS = {
	validate: (content: string) => {
		parseStoredModels(content);
	},
	mode: 0o600,
	directoryMode: 0o700,
} as const;

// Every live store for one path must observe the same cache and in-flight read,
// without retaining custom paths after their stores become unreachable.
const modelsFileReadStates = new Map<string, WeakRef<ModelsFileReadState>>();
const modelsFileReadStateFinalizer = new FinalizationRegistry<{ path: string; reference: WeakRef<ModelsFileReadState> }>(
	({ path, reference }) => {
		if (modelsFileReadStates.get(path) === reference) modelsFileReadStates.delete(path);
	},
);

export class InMemoryCodingAgentModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		const entry = this.entries.get(providerId);
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.delete(providerId);
	}
}

/** Read a persisted dynamic catalog without creating locks, backups, or cache files. */
export class ReadOnlyModelsStore implements ModelsStore {
	private readonly path: string;
	private data: StoredModels | undefined;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.path = normalizePath(path);
	}

	private load(): StoredModels {
		if (this.data) return this.data;
		const content = readControlPlaneStateReadOnly(this.path, MODELS_STORAGE_OPTIONS);
		this.data = content === undefined ? {} : parseStoredModels(content);
		return this.data;
	}

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		const entry = this.load()[providerId];
		options?.signal?.throwIfAborted();
		return entry ? structuredClone(entry) : undefined;
	}

	async write(
		_providerId: string,
		_entry: ModelsStoreEntry,
		_options?: ModelsStoreOperationOptions,
	): Promise<void> {
		throw new Error("Read-only model storage cannot modify models-store.json");
	}

	async delete(_providerId: string, _options?: ModelsStoreOperationOptions): Promise<void> {
		throw new Error("Read-only model storage cannot modify models-store.json");
	}
}

/** Locked JSON-backed storage for dynamically refreshed provider catalogs. */
export class FileModelsStore implements ModelsStore {
	private readonly storage: LockedAtomicFileStorage;
	private readonly path: string;
	private readonly readState: ModelsFileReadState;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.path = normalizePath(path);
		this.storage = new LockedAtomicFileStorage(this.path, "{}", MODELS_STORAGE_OPTIONS);
		const existingReadState = modelsFileReadStates.get(this.path)?.deref();
		this.readState = existingReadState ?? { data: {} };
		if (existingReadState === undefined) {
			const reference = new WeakRef(this.readState);
			modelsFileReadStates.set(this.path, reference);
			modelsFileReadStateFinalizer.register(this.readState, { path: this.path, reference });
		}
	}

	private parse(content: string | undefined): StoredModels {
		return content ? parseStoredModels(content) : {};
	}

	private updateReadState(readState: ModelsFileReadState, data: StoredModels, revision?: string): void {
		readState.data = data;
		readState.revision = revision;
	}

	private reloadFromStorage(
		readState: ModelsFileReadState,
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		return this.storage.withLockAsync(async (content) => {
			const data = this.parse(content);
			this.updateReadState(readState, data, getFileRevision(this.path));
			return { result: data };
		}, options);
	}

	private async readLatest(
		readState: ModelsFileReadState,
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		options?.signal?.throwIfAborted();
		const revision = getFileRevision(this.path);
		if (revision !== undefined && revision === readState.revision) return readState.data;
		if (!readState.reload) {
			const controller = new AbortController();
			const reload: ModelsFileReload = {
				controller,
				promise: this.reloadFromStorage(readState, { signal: controller.signal }),
				readers: 0,
			};
			readState.reload = reload;
			void reload.promise.then(
				() => {
					if (readState.reload === reload) readState.reload = undefined;
				},
				() => {
					if (readState.reload === reload) readState.reload = undefined;
				},
			);
		}

		const reload = readState.reload;
		reload.readers++;
		try {
			return await raceWithAbortSignal(reload.promise, options?.signal);
		} finally {
			reload.readers--;
			if (reload.readers === 0 && readState.reload === reload) {
				readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		const entry = (await this.readLatest(this.readState, options))[providerId];
		options?.signal?.throwIfAborted();
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		if (!isValidModelsStoreEntry(entry)) throw new Error(`Invalid models store entry for provider ${providerId}`);
		let latest: StoredModels | undefined;
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			current[providerId] = structuredClone(entry);
			latest = current;
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		}, options);
		if (latest) this.updateReadState(this.readState, latest);
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		let latest: StoredModels | undefined;
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			delete current[providerId];
			latest = current;
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		}, options);
		if (latest) this.updateReadState(this.readState, latest);
	}
}
