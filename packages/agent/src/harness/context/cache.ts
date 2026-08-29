import { canonicalFoundationJson, sha256HexValue } from "../foundation/index.ts";
import type { PromptCacheInvalidationOptions, PromptCacheLookup, PromptCacheRecord, PromptCacheWriteOptions, ContextLedger } from "./ledger.ts";

export const CONTEXT_CACHE_SCHEMA_VERSION = 1 as const;

export interface ContextCacheKeyInput {
	readonly prefixDigest: string;
	readonly modelId: string;
	readonly policyDigest: string;
	readonly bindingEpochId: string;
	readonly cacheEpoch: number;
}

export interface ContextCacheKey extends ContextCacheKeyInput {
	readonly key: string;
}

export interface ContextCacheEntry<TValue = unknown> {
	readonly key: ContextCacheKey;
	readonly value: TValue;
	readonly bytes: number;
	readonly createdAt: number;
	readonly lastAccessAt: number;
	readonly hitCount: number;
	readonly snapshotId?: string;
}

export interface ContextCacheStats {
	readonly entries: number;
	readonly bytes: number;
	readonly hits: number;
	readonly misses: number;
	readonly invalidations: number;
	readonly invalidationCost: number;
	readonly lastInvalidationReason?: string;
}

export interface ContextCacheOptions {
	readonly maxEntries?: number;
	readonly maxBytes?: number;
	readonly now?: () => number;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function byteSize(value: unknown): number {
	return new TextEncoder().encode(canonicalFoundationJson(value)).byteLength;
}

export function createContextCacheKey(input: ContextCacheKeyInput): ContextCacheKey {
	if (!Number.isInteger(input.cacheEpoch) || input.cacheEpoch < 0) throw new RangeError("cacheEpoch must be a non-negative integer");
	const normalized = {
		prefixDigest: input.prefixDigest,
		modelId: input.modelId,
		policyDigest: input.policyDigest,
		bindingEpochId: input.bindingEpochId,
		cacheEpoch: input.cacheEpoch,
	};
	return { ...normalized, key: `t5-cache:${sha256HexValue(canonicalFoundationJson(normalized))}` };
}

/**
 * Ephemeral performance cache. It is never an authority: durable cache
 * receipts are written through ContextLedger, while this object may be
 * discarded without changing session state.
 */
export class ContextCache<TValue = unknown> {
	private readonly entries = new Map<string, ContextCacheEntry<TValue>>();
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly now: () => number;
	private totalBytes = 0;
	private hitTotal = 0;
	private missTotal = 0;
	private invalidationTotal = 0;
	private invalidationCostTotal = 0;
	private lastInvalidationReason: string | undefined;

	constructor(options: ContextCacheOptions = {}) {
		this.maxEntries = options.maxEntries ?? 256;
		this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
		this.now = options.now ?? Date.now;
		if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0 || !Number.isInteger(this.maxBytes) || this.maxBytes <= 0) {
			throw new RangeError("Context cache limits must be positive integers");
		}
	}

	get(key: ContextCacheKey | string): TValue | undefined {
		const cacheKey = typeof key === "string" ? key : key.key;
		const entry = this.entries.get(cacheKey);
		if (entry === undefined) {
			this.missTotal += 1;
			return undefined;
		}
		this.hitTotal += 1;
		this.entries.delete(cacheKey);
		const updated: ContextCacheEntry<TValue> = { ...entry, lastAccessAt: this.now(), hitCount: entry.hitCount + 1 };
		this.entries.set(cacheKey, updated);
		return clone(updated.value);
	}

	set(key: ContextCacheKey, value: TValue, options: { readonly snapshotId?: string } = {}): ContextCacheEntry<TValue> {
		const bytes = byteSize(value);
		if (bytes > this.maxBytes) throw new RangeError("Context cache value exceeds maxBytes");
		const previous = this.entries.get(key.key);
		if (previous !== undefined) this.totalBytes -= previous.bytes;
		const now = this.now();
		const entry: ContextCacheEntry<TValue> = {
			key: clone(key),
			value: clone(value),
			bytes,
			createdAt: previous?.createdAt ?? now,
			lastAccessAt: now,
			hitCount: previous?.hitCount ?? 0,
			...(options.snapshotId === undefined ? {} : { snapshotId: options.snapshotId }),
		};
		this.entries.delete(key.key);
		this.entries.set(key.key, entry);
		this.totalBytes += bytes;
		this.evict();
		return clone(entry);
	}

	delete(key: ContextCacheKey | string): boolean {
		const cacheKey = typeof key === "string" ? key : key.key;
		const entry = this.entries.get(cacheKey);
		if (entry === undefined) return false;
		this.entries.delete(cacheKey);
		this.totalBytes -= entry.bytes;
		return true;
	}

	/** Invalidate by snapshot, binding epoch, or an explicit key predicate. */
	invalidate(options: { readonly snapshotId?: string; readonly bindingEpochId?: string; readonly predicate?: (entry: ContextCacheEntry<TValue>) => boolean; readonly reason?: string; readonly cost?: number } = {}): number {
		let removed = 0;
		for (const entry of [...this.entries.values()]) {
			const matches =
				(options.snapshotId !== undefined && entry.snapshotId === options.snapshotId) ||
				(options.bindingEpochId !== undefined && entry.key.bindingEpochId === options.bindingEpochId) ||
				(options.predicate?.(entry) ?? false);
			if (matches && this.delete(entry.key.key)) removed += 1;
		}
		this.invalidationTotal += removed;
		this.invalidationCostTotal += options.cost ?? 0;
		if (removed > 0) this.lastInvalidationReason = options.reason ?? "explicit";
		return removed;
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}

	stats(): ContextCacheStats {
		return { entries: this.entries.size, bytes: this.totalBytes, hits: this.hitTotal, misses: this.missTotal, invalidations: this.invalidationTotal, invalidationCost: this.invalidationCostTotal, ...(this.lastInvalidationReason === undefined ? {} : { lastInvalidationReason: this.lastInvalidationReason }) };
	}

	entriesSnapshot(): readonly ContextCacheEntry<TValue>[] {
		return [...this.entries.values()].reverse().map(clone);
	}

	private evict(): void {
		while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.delete(oldest);
		}
	}
}

/** Durable cache facade. The in-memory ContextCache above is only a speed layer. */
export class SessionPromptCache {
	readonly ledger: ContextLedger;

	constructor(ledger: ContextLedger) {
		this.ledger = ledger;
	}

	put(options: PromptCacheWriteOptions): Promise<PromptCacheRecord> {
		return this.ledger.recordPromptCache(options);
	}

	get(cacheKey: string): Promise<PromptCacheLookup | undefined> {
		return this.ledger.lookupPromptCache(cacheKey);
	}

	invalidate(cacheKey: string, options?: PromptCacheInvalidationOptions): Promise<number> {
		return this.ledger.invalidatePromptCache(cacheKey, options);
	}
}
