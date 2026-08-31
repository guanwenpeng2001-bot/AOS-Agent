import type { ContextSnapshot } from "./context-engine.ts";
import type {
	SessionContext,
	SessionEntry,
	SessionHeader,
	SessionManager,
	SessionTreeNode,
} from "./manager.ts";

/** Deterministic, read-only compatibility projection over a canonical Session. */
export interface AgentSessionReadProjection {
	getCwd(): string;
	getSessionFile(): string | undefined;
	getSessionId(): string;
	getSessionName(): string | undefined;
	getSessionDir(): string;
	usesDefaultSessionDir(): boolean;
	isPersisted(): boolean;
	getEntries(): SessionEntry[];
	getBranch(): SessionEntry[];
	getLeafId(): string | null;
	getLeafEntry(): SessionEntry | undefined;
	getLabel(entryId: string): string | undefined;
	getTree(): SessionTreeNode[];
	getHeader(): SessionHeader | null;
	buildSessionContext(): SessionContext;
	buildContextEntries(): SessionEntry[];
	getContextSnapshots(): ContextSnapshot[];
	getContextSnapshot(snapshotId: string): ContextSnapshot | undefined;
}

/** @internal Construct a read-only projection without exposing the physical store. */
export function createAgentSessionReadProjection(manager: SessionManager): AgentSessionReadProjection {
	return Object.freeze({
		getCwd: () => manager.getCwd(),
		getSessionFile: () => manager.getSessionFile(),
		getSessionId: () => manager.getSessionId(),
		getSessionName: () => manager.getSessionName(),
		getSessionDir: () => manager.getSessionDir(),
		usesDefaultSessionDir: () => manager.usesDefaultSessionDir(),
		isPersisted: () => manager.isPersisted(),
		getEntries: () => structuredClone(manager.getEntries()),
		getBranch: () => structuredClone(manager.getBranch()),
		getLeafId: () => manager.getLeafId(),
		getLeafEntry: () => structuredClone(manager.getLeafEntry()),
		getLabel: (entryId: string) => manager.getLabel(entryId),
		getTree: () => structuredClone(manager.getTree()),
		getHeader: () => structuredClone(manager.getHeader()),
		buildSessionContext: () => structuredClone(manager.buildSessionContext()),
		buildContextEntries: () => structuredClone(manager.buildContextEntries()),
		getContextSnapshots: () => structuredClone(manager.getContextSnapshots()),
		getContextSnapshot: (snapshotId: string) => structuredClone(manager.getContextSnapshot(snapshotId)),
	});
}
