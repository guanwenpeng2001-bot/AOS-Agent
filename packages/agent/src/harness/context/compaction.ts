import { canonicalFoundationJson, sha256HexValue } from "../foundation/index.ts";
import { estimateTokens } from "../compaction/compaction.ts";
import type { Entry } from "../session/types.ts";
import type { ArtifactReference } from "../artifacts.ts";

export const T5_COMPACTION_SCHEMA_VERSION = 1 as const;
export type T5CompactionReason = "manual" | "threshold" | "overflow" | "recovery";

export interface CompactionRetention {
	readonly policy: "session" | "task" | "project" | "indefinite";
	readonly expiresAt?: number;
}

export interface CompactionResumeBoundary {
	readonly snapshotId: string;
	readonly entryId: string | null;
	readonly transcriptDigest: string;
	readonly retainedEntryIds: readonly string[];
}

export interface CompactionRecord {
	readonly schemaVersion: 1;
	readonly compactionId: string;
	readonly snapshotId: string;
	readonly sourceLeafId: string | null;
	readonly sourceEntryIds: readonly string[];
	readonly retainedEntryIds: readonly string[];
	readonly summaryRef: ArtifactReference;
	readonly summaryDigest: string;
	readonly retention: CompactionRetention;
	readonly resumeBoundary: CompactionResumeBoundary;
	readonly tokensBefore: number;
	readonly tokensAfter: number;
	readonly reason: T5CompactionReason;
	readonly createdAt: number;
}

export interface DeterministicCompactionResult {
	readonly sourceLeafId: string | null;
	readonly sourceEntryIds: readonly string[];
	readonly retainedEntryIds: readonly string[];
	readonly summary: string;
	readonly tokensBefore: number;
	readonly tokensAfter: number;
	readonly summaryDigest: string;
	readonly retention?: CompactionRetention;
	readonly resumeBoundary?: CompactionResumeBoundary;
}

function digest(value: unknown): string {
	return `sha256:${sha256HexValue(canonicalFoundationJson(value))}`;
}

function messageText(entry: Entry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if ("content" in message) {
		if (typeof message.content === "string") return message.content;
		return message.content
			.map((part: unknown) => {
				if (typeof part !== "object" || part === null) return "";
				const record = part as Record<string, unknown>;
				if (typeof record.text === "string") return record.text;
				if (typeof record.thinking === "string") return record.thinking;
				if (typeof record.name === "string") return record.name;
				return "";
			})
			.join("");
	}
	if (message.role === "bashExecution") return `${message.command}\n${message.output}`;
	if ("summary" in message && typeof message.summary === "string") return message.summary;
	return undefined;
}

/** Deterministic local compaction proposal; durable persistence is done by SessionT5Ledger. */
export function compactContext(
	entries: readonly Entry[],
	options: { readonly retainEntries?: number; readonly retention?: CompactionRetention } = {},
): DeterministicCompactionResult {
	const retainCount = options.retainEntries ?? 8;
	if (!Number.isInteger(retainCount) || retainCount < 0) throw new RangeError("retainEntries must be a non-negative integer");
	const retained = entries.slice(Math.max(0, entries.length - retainCount));
	const removed = entries.slice(0, Math.max(0, entries.length - retainCount));
	const lines = removed.map((entry) => messageText(entry)).filter((value): value is string => value !== undefined && value.length > 0);
	const summary = lines.length === 0 ? "No earlier messages." : lines.map((line, index) => `${index + 1}. ${line.slice(0, 500)}`).join("\n");
	const tokensBefore = entries.reduce((sum, entry) => sum + (entry.type === "message" ? estimateTokens(entry.message) : 0), 0);
	const tokensAfter = retained.reduce((sum, entry) => sum + (entry.type === "message" ? estimateTokens(entry.message) : 0), 0);
	return {
		sourceLeafId: entries.at(-1)?.id ?? null,
		sourceEntryIds: entries.map((entry) => entry.id),
		retainedEntryIds: retained.map((entry) => entry.id),
		summary,
		tokensBefore,
		tokensAfter,
		summaryDigest: digest(summary),
		retention: options.retention ?? { policy: "session" },
		resumeBoundary: {
			snapshotId: "transient",
			entryId: retained.at(-1)?.id ?? null,
			transcriptDigest: digest(entries),
			retainedEntryIds: retained.map((entry) => entry.id),
		},
	};
}
