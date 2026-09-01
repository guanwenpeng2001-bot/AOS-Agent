import type { ContextSnapshot } from "./context-engine.ts";
import type {
	SessionContext,
	SessionEntry,
	SessionHeader,
	SessionManager,
	SessionTreeNode,
} from "./manager.ts";
import type { DlpScanner } from "../dlp.ts";

function projectEntry(entry: SessionEntry, scanner: DlpScanner | undefined): SessionEntry {
	if (scanner === undefined || entry.type !== "message" || entry.message.role !== "toolResult") return structuredClone(entry);
	return { ...structuredClone(entry), message: scanner.projectToolResult(entry.message) };
}

function projectTree(node: SessionTreeNode, scanner: DlpScanner | undefined): SessionTreeNode {
	return {
		...structuredClone(node),
		entry: projectEntry(node.entry, scanner),
		children: node.children.map((child) => projectTree(child, scanner)),
	};
}

function projectContext(context: SessionContext, scanner: DlpScanner | undefined): SessionContext {
	const copy = structuredClone(context);
	if (scanner === undefined) return copy;
	return { ...copy, messages: copy.messages.map((message) => scanner.projectToolResult(message)) };
}

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
export function createAgentSessionReadProjection(
	manager: SessionManager,
	scanner?: DlpScanner,
): AgentSessionReadProjection {
	return Object.freeze({
		getCwd: () => manager.getCwd(),
		getSessionFile: () => manager.getSessionFile(),
		getSessionId: () => manager.getSessionId(),
		getSessionName: () => manager.getSessionName(),
		getSessionDir: () => manager.getSessionDir(),
		usesDefaultSessionDir: () => manager.usesDefaultSessionDir(),
		isPersisted: () => manager.isPersisted(),
		getEntries: () => manager.getEntries().map((entry) => projectEntry(entry, scanner)),
		getBranch: () => manager.getBranch().map((entry) => projectEntry(entry, scanner)),
		getLeafId: () => manager.getLeafId(),
		getLeafEntry: () => {
			const entry = manager.getLeafEntry();
			return entry === undefined ? undefined : projectEntry(entry, scanner);
		},
		getLabel: (entryId: string) => manager.getLabel(entryId),
		getTree: () => manager.getTree().map((node) => projectTree(node, scanner)),
		getHeader: () => structuredClone(manager.getHeader()),
		buildSessionContext: () => projectContext(manager.buildSessionContext(), scanner),
		buildContextEntries: () => manager.buildContextEntries().map((entry) => projectEntry(entry, scanner)),
		getContextSnapshots: () => structuredClone(manager.getContextSnapshots()),
		getContextSnapshot: (snapshotId: string) => structuredClone(manager.getContextSnapshot(snapshotId)),
	});
}
