import type { FileError, Result } from "../../types.ts";
import { DurableLedgerError } from "../durable/errors.ts";
import { fileResult } from "./errors.ts";
import { encodeV5Header } from "./codec.ts";
import type { JsonlSessionRepoFileSystem, JsonlV4Header, JsonlV5Header } from "./types.ts";

export interface DurableJsonlFileSystem extends JsonlSessionRepoFileSystem {
	/** Optional durability barrier for a staged or appended file. */
	syncFile?(path: string): Promise<Result<void, FileError> | void>;
	/** Optional close barrier for backends that expose handles. */
	closeFile?(path: string): Promise<Result<void, FileError> | void>;
	/** Exclusive create used for the cross-process writer transaction guard. */
	createExclusive?(path: string, content: string): Promise<Result<void, FileError>>;
	/** Directory durability barrier after an atomic rename/unlink. */
	syncDirectory?(path: string): Promise<Result<void, FileError> | void>;
}

export interface SessionMigrationPlan {
	sourceVersion: 4;
	targetVersion: 5;
	sourcePath: string;
	temporaryPath: string;
	rollbackPath: string;
	targetHeader: JsonlV5Header;
	legacyLines: readonly string[];
}

function checkOptionalResult(result: Result<void, FileError> | void, message: string): void {
	if (result !== undefined) fileResult(result, message);
}

async function syncAndClose(fs: DurableJsonlFileSystem, path: string): Promise<void> {
	if (fs.syncFile !== undefined) checkOptionalResult(await fs.syncFile(path), `Failed to sync ${path}`);
	if (fs.closeFile !== undefined) checkOptionalResult(await fs.closeFile(path), `Failed to close ${path}`);
}

async function syncParentDirectory(fs: DurableJsonlFileSystem, path: string): Promise<void> {
	if (fs.syncDirectory === undefined) return;
	const parent = path.replace(/[\\/][^\\/]*$/, "") || ".";
	checkOptionalResult(await fs.syncDirectory(parent), `Failed to sync parent directory ${parent}`);
}

export function createV5Header(header: JsonlV4Header, migratedAt = Date.now()): JsonlV5Header {
	return {
		kind: "header",
		version: 5,
		schemaVersion: 1,
		id: header.id,
		createdAt: header.createdAt,
		cwd: header.cwd,
		...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
		...(header.legacyParentSessionPath === undefined ? {} : { legacyParentSessionPath: header.legacyParentSessionPath }),
		...(header.metadata === undefined ? {} : { metadata: structuredClone(header.metadata) }),
		migratedFromVersion: 4,
		migratedAt,
	};
}

export function planSessionMigration(
	sourcePath: string,
	header: JsonlV4Header,
	legacyLines: readonly string[],
	migratedAt = Date.now(),
): SessionMigrationPlan {
	if (legacyLines.some((line) => line.length === 0)) throw new DurableLedgerError("session_ledger_corrupt", "Cannot migrate an empty JSONL mutation line");
	return {
		sourceVersion: 4,
		targetVersion: 5,
		sourcePath,
		temporaryPath: `${sourcePath}.v5.tmp`,
		rollbackPath: `${sourcePath}.v4.bak`,
		targetHeader: createV5Header(header, migratedAt),
		legacyLines: [...legacyLines],
	};
}

export async function migrateSessionFile(fs: DurableJsonlFileSystem, plan: SessionMigrationPlan): Promise<void> {
	if (plan.sourceVersion !== 4 || plan.targetVersion !== 5) {
		throw new DurableLedgerError("session_ledger_unknown_format", "No migration is registered for this session format");
	}
	const content = `${encodeV5Header(plan.targetHeader)}${plan.legacyLines.length === 0 ? "" : `${plan.legacyLines.join("\n")}\n`}`;
	try {
		const original = fileResult(await fs.readTextFile(plan.sourcePath), `Failed to read migration source ${plan.sourcePath}`);
		fileResult(await fs.writeFile(plan.rollbackPath, original), `Failed to create rollback point ${plan.rollbackPath}`);
		await syncAndClose(fs, plan.rollbackPath);
		fileResult(await fs.writeFile(plan.temporaryPath, content), `Failed to stage migration ${plan.sourcePath}`);
		await syncAndClose(fs, plan.temporaryPath);
		fileResult(await fs.renameFile(plan.temporaryPath, plan.sourcePath), `Failed to atomically publish migration ${plan.sourcePath}`);
		await syncParentDirectory(fs, plan.sourcePath);
	} catch (error) {
		await fs.remove(plan.temporaryPath, { force: true });
		throw error instanceof DurableLedgerError
			? error
			: new DurableLedgerError("session_ledger_migrating", `Session migration failed for ${plan.sourcePath}`, {
					cause: error instanceof Error ? error : undefined,
				});
	}
}
