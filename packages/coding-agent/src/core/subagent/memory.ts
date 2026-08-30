import {
	FoundationError,
	MemoryError,
	type MemoryProvenanceBoundary,
	Result,
	type ResultValue,
	ScopedMemoryStore,
} from "@aos-agent/agent-core";

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function childScopeId(childAgentInstanceId: string): string {
	return `child:${childAgentInstanceId}`;
}

function validIdentity(value: string): boolean {
	return IDENTITY_PATTERN.test(value);
}

export function createChildMemoryScope(
	parentStore: ScopedMemoryStore,
	childAgentInstanceId: string,
	parentAgentInstanceId: string,
	options: { readonly scopeId?: string } = {},
): ScopedMemoryStore {
	const expectedScopeId = childScopeId(childAgentInstanceId);
	if (
		!(parentStore instanceof ScopedMemoryStore) ||
		!validIdentity(childAgentInstanceId) ||
		!validIdentity(parentAgentInstanceId) ||
		childAgentInstanceId === parentAgentInstanceId ||
		parentStore.ownerId !== parentAgentInstanceId ||
		parentStore.scopeId === expectedScopeId ||
		parentStore.ownerId === childAgentInstanceId ||
		(options.scopeId !== undefined && options.scopeId !== expectedScopeId)
	) {
		throw new MemoryError("invalid_entry", "Child memory scope identity is invalid or collides with its parent");
	}
	const provenance: MemoryProvenanceBoundary = {
		ownerId: childAgentInstanceId,
		scopeId: expectedScopeId,
		parentId: parentStore.scopeId,
		createdBy: "system",
	};
	return parentStore.fork({
		scope: "child",
		scopeId: expectedScopeId,
		ownerId: childAgentInstanceId,
		provenance,
	});
}

export async function cleanupChildMemoryScope(
	store: ScopedMemoryStore,
): Promise<ResultValue<number, FoundationError>> {
	if (
		!(store instanceof ScopedMemoryStore) ||
		!validIdentity(store.ownerId) ||
		store.parentId === undefined ||
		store.parentId.length === 0 ||
		store.parentId === store.scopeId ||
		store.ownerId === store.parentId ||
		store.scopeId !== childScopeId(store.ownerId)
	) {
		return Result.err(new FoundationError("subagent_close_unknown", "Child memory cleanup requires an exact owned child scope"));
	}
	try {
		const entries = await store.list(
			{
				scope: "child",
				scopeId: store.scopeId,
				ownerId: store.ownerId,
				parentId: store.parentId,
			},
			"system",
		);
		const ids = new Set<string>();
		for (const entry of entries) {
			if (
				entry.scope !== "child" ||
				entry.scopeId !== store.scopeId ||
				entry.ownerId !== store.ownerId ||
				entry.parentId !== store.parentId ||
				entry.provenance.scopeId !== store.scopeId ||
				entry.provenance.ownerId !== store.ownerId ||
				entry.provenance.parentId !== store.parentId ||
				ids.has(entry.id)
			) {
				return Result.err(new FoundationError("subagent_close_unknown", "Child memory cleanup found colliding or cross-scope provenance"));
			}
			ids.add(entry.id);
		}
		let removed = 0;
		for (const id of ids) {
			if (!await store.delete(id, "system")) {
				return Result.err(new FoundationError("subagent_close_unknown", "Child memory cleanup could not prove deletion", { details: { memoryId: id, removed } }));
			}
			removed += 1;
		}
		const remaining = await store.list(
			{
				scope: "child",
				scopeId: store.scopeId,
				ownerId: store.ownerId,
				parentId: store.parentId,
			},
			"system",
		);
		if (remaining.length !== 0) {
			return Result.err(new FoundationError("subagent_close_unknown", "Child memory cleanup could not prove its scope is empty", { details: { remaining: remaining.length, removed } }));
		}
		return Result.ok(removed);
	} catch (error) {
		return Result.err(new FoundationError("subagent_close_unknown", "Child memory cleanup failed closed", { cause: error }));
	}
}
