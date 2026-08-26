import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
	EXTERNAL_MAPPING_CUSTOM_TYPE,
	ExternalMappingError,
	ExternalSessionMappingStore,
	externalAdapterExecutionKey,
	foldExternalMappingEntries,
	isExternalAdapterExecutionRef,
	isExternalAdapterIdentity,
	isExternalAdapterProtocolRef,
	isExternalAdapterSelectionRef,
	sameExternalAdapterIdentity,
	sameExternalAdapterExecutionRef,
	serializeExternalAdapterIdentity,
	type ExternalAdapterIdentity,
} from "../src/core/external-session-mapping.ts";
import {
	createSessionRemoteOperationLedger,
	isRemoteArtifactReference,
	isRemoteOperationReceipt,
	isRemoteOperationReceiptInput,
	REMOTE_OPERATION_CUSTOM_TYPE,
	toRemoteOperationReceipt,
} from "../src/core/remote-operation.ts";
import { ExecutionAuditAdapter, ExecutionAuditError } from "../src/core/execution-audit.ts";
import { ExecutionAuditQuery } from "../src/core/execution-audit-query.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { FileEntry, SessionEntry } from "../src/core/session-manager.ts";
import { canonicalAuditRunEntries } from "./support/canonical-audit-run.ts";

const NOW = "2026-08-16T00:00:00.000Z";
const SESSION_ID = "session-facts-1";
const RUN_ID = "run-facts-1";

const ADAPTER_A: ExternalAdapterIdentity = {
	adapterId: "adapter-gondolin",
	targetId: "target-1",
	protocol: { name: "gondolin", version: "1.2.0" },
};

const ADAPTER_B: ExternalAdapterIdentity = {
	adapterId: "adapter-gondolin",
	targetId: "target-2",
	protocol: { name: "gondolin", version: "1.2.0" },
};

const EXTERNAL = {
	namespace: "trusted-adapter",
	externalSessionId: "external-session",
	externalRunId: "external-run",
} as const;

function makeSession(): SessionManager {
	return SessionManager.inMemory("/workspace/external-agent-facts");
}

function mappingRequest(sessionId: string, adapter?: ExternalAdapterIdentity) {
	return {
		external: EXTERNAL,
		aosSessionId: sessionId,
		aosRunId: RUN_ID,
		...(adapter === undefined ? {} : { adapter }),
	};
}

function customEntry(id: string, timestamp: string, customType: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp, customType, data };
}

function runEntries(sessionId = SESSION_ID): SessionEntry[] {
	return canonicalAuditRunEntries({
		sessionId,
		runId: RUN_ID,
		acceptedAt: NOW,
		completedAt: "2026-08-16T00:00:01.000Z",
		fixtureId: `external-facts-${sessionId}`,
	});
}

function mappingEntry(sessionId: string, adapter?: ExternalAdapterIdentity): SessionEntry {
	return customEntry("external-mapping", "2026-08-16T00:00:02.000Z", EXTERNAL_MAPPING_CUSTOM_TYPE, {
		schemaVersion: 1,
		mapping: {
			namespace: EXTERNAL.namespace,
			externalSessionId: EXTERNAL.externalSessionId,
			externalRunId: EXTERNAL.externalRunId,
			aosSessionId: sessionId,
			aosRunId: RUN_ID,
			createdAt: "2026-08-16T00:00:02.000Z",
			...(adapter === undefined ? {} : { adapter }),
		},
	});
}

function operationEntry(adapter?: ExternalAdapterIdentity): SessionEntry {
	const receipt: Record<string, unknown> = {
		schemaVersion: 1,
		operationId: "operation-1",
		runId: RUN_ID,
		sessionId: SESSION_ID,
		status: "completed",
		endedAt: "2026-08-16T00:00:03.000Z",
		artifactRefs: [{ id: "artifact-1", kind: "output", digest: "sha256:artifact-1", sizeBytes: 4 }],
		sideEffects: "associated",
		...(adapter === undefined ? {} : { adapter }),
	};
	return customEntry("remote-operation", "2026-08-16T00:00:03.000Z", REMOTE_OPERATION_CUSTOM_TYPE, {
		schemaVersion: 1,
		receipt,
	});
}

function receiptInput(overrides: Record<string, unknown> = {}): unknown {
	return {
		operationId: "operation-external",
		status: "completed",
		endedAt: NOW,
		artifactRefs: [{ id: "artifact-1", kind: "output", digest: "sha256:artifact-1", sizeBytes: 4 }],
		sideEffects: "none",
		runId: RUN_ID,
		sessionId: SESSION_ID,
		capabilityBindingId: "capability-binding-1",
		modelBindingId: "model-binding-1",
		policyBindingId: "policy-binding-1",
		adapter: ADAPTER_A,
		...overrides,
	};
}

describe("adapter identity validation and drift", () => {
	it("accepts only exact-shape adapter identity refs and rejects raw data", () => {
		expect(isExternalAdapterSelectionRef({ adapterId: "adapter-gondolin", targetId: "target-1" })).toBe(true);
		expect(isExternalAdapterProtocolRef({ name: "gondolin", version: "1.2.0" })).toBe(true);
		expect(isExternalAdapterIdentity(ADAPTER_A)).toBe(true);

		expect(isExternalAdapterIdentity({ ...ADAPTER_A, adapterId: "C:\\adapters\\gondolin" })).toBe(false);
		expect(isExternalAdapterIdentity({ ...ADAPTER_A, targetId: "https://target.example/exec" })).toBe(false);
		expect(
			isExternalAdapterIdentity({
				...ADAPTER_A,
				protocol: { name: "gondolin", version: "1.2.0", headers: { authorization: "Bearer x" } },
			}),
		).toBe(false);
		expect(isExternalAdapterIdentity({ ...ADAPTER_A, prompt: "do the thing" })).toBe(false);
		expect(isExternalAdapterIdentity({ ...ADAPTER_A, credential: "secret" })).toBe(false);
		expect(
			isExternalAdapterIdentity({ ...ADAPTER_A, protocol: { name: "ssh", version: "2.0", rawProtocol: { ok: true } } }),
		).toBe(false);
		expect(isExternalAdapterIdentity({ adapterId: "adapter-1", targetId: "target-1" })).toBe(false);
		expect(isExternalAdapterIdentity({ ...ADAPTER_A, protocol: { name: "gondolin" } })).toBe(false);
	});

	it("validates binding, operation, and external refs of the association ref", () => {
		const ref = {
			...ADAPTER_A,
			bindingFingerprint: `ext-binding:${"A".repeat(43)}`,
			operationId: "operation-1",
			external: EXTERNAL,
		};
		expect(isExternalAdapterExecutionRef(ref)).toBe(true);
		expect(isExternalAdapterExecutionRef({ ...ref, bindingFingerprint: "C:\\secrets\\fingerprint" })).toBe(false);
		expect(isExternalAdapterExecutionRef({ ...ref, operationId: "operation 1" })).toBe(false);
		expect(
			isExternalAdapterExecutionRef({ ...ref, external: { ...EXTERNAL, externalRunId: "C:/secret" } }),
		).toBe(false);
		expect(isExternalAdapterExecutionRef({ ...ref, external: { ...EXTERNAL, path: "C:\\secret" } })).toBe(false);
	});

	it("rejects identity drift across selection and protocol and serializes safely", () => {
		expect(sameExternalAdapterIdentity(ADAPTER_A, { ...ADAPTER_A })).toBe(true);
		expect(sameExternalAdapterIdentity(ADAPTER_A, { ...ADAPTER_A, adapterId: "adapter-other" })).toBe(false);
		expect(sameExternalAdapterIdentity(ADAPTER_A, { ...ADAPTER_A, targetId: "target-2" })).toBe(false);
		expect(
			sameExternalAdapterIdentity(ADAPTER_A, { ...ADAPTER_A, protocol: { name: "gondolin", version: "2.0.0" } }),
		).toBe(false);

		const ref = {
			...ADAPTER_A,
			bindingFingerprint: `ext-binding:${"A".repeat(43)}`,
			operationId: "operation-1",
			external: EXTERNAL,
		};
		expect(sameExternalAdapterExecutionRef(ref, { ...ref })).toBe(true);
		expect(sameExternalAdapterExecutionRef(ref, { ...ref, operationId: "operation-2" })).toBe(false);
		expect(sameExternalAdapterExecutionRef(ref, { ...ref, external: { ...EXTERNAL, externalRunId: "other-run" } })).toBe(false);

		const serialized = serializeExternalAdapterIdentity(ADAPTER_A);
		expect(serialized).toEqual(ADAPTER_A);
		expect(serialized?.protocol).not.toBe(ADAPTER_A.protocol);
		expect(serializeExternalAdapterIdentity({ ...ADAPTER_A, prompt: "secret" } as never)).toBeUndefined();

		expect(
			externalAdapterExecutionKey({
				...ADAPTER_A,
				bindingFingerprint: `ext-binding:${"A".repeat(43)}`,
				operationId: "operation-1",
				external: EXTERNAL,
			}),
		).toBe("adapter-gondolin\u0000target-1\u0000gondolin\u00001.2.0\u0000trusted-adapter\u0000external-session\u0000external-run");
	});
});

describe("adapter identity mapping persistence, fold, and restart", () => {
	it("persists the adapter identity with the mapping and stays idempotent", () => {
		const session = makeSession();
		const store = new ExternalSessionMappingStore(session, { now: () => NOW });

		const result = store.persistMapping(mappingRequest(session.getSessionId(), ADAPTER_A));

		expect(result.appended).toBe(true);
		expect(session.getEntries()[0]).toMatchObject({
			data: { mapping: { adapter: ADAPTER_A, namespace: "trusted-adapter" } },
		});
		const second = store.persistMapping(mappingRequest(session.getSessionId(), ADAPTER_A));
		expect(second).toMatchObject({ appended: false, idempotent: true, mapping: result.mapping });
		expect(session.getEntries()).toHaveLength(1);
	});

	it("rejects adapter identity drift and unsafe identities without appending", () => {
		const session = makeSession();
		const store = new ExternalSessionMappingStore(session, { now: () => NOW });
		store.persistMapping(mappingRequest(session.getSessionId(), ADAPTER_A));

		expect(() => store.persistMapping(mappingRequest(session.getSessionId(), ADAPTER_B))).toThrowError(
			new ExternalMappingError(
				"external_mapping_conflict",
				"External mapping adapter identity drifted from append-only mapping history.",
			),
		);
		expect(() => store.validateMapping(mappingRequest(session.getSessionId(), ADAPTER_B))).toThrowError(
			"External mapping adapter identity drifted",
		);
		expect(() =>
			store.persistMapping({
				...mappingRequest(session.getSessionId()),
				adapter: { ...ADAPTER_A, protocol: { name: "gondolin", version: "1.2.0", prompt: "secret" } } as never,
			}),
		).toThrowError("External mapping adapter identity is invalid.");
		expect(session.getEntries()).toHaveLength(1);
	});

	it("recovers the adapter identity after restart and flags drift in append-only history", () => {
		const session = makeSession();
		const first = new ExternalSessionMappingStore(session, { now: () => NOW });
		first.persistMapping(mappingRequest(session.getSessionId(), ADAPTER_A));

		const restarted = new ExternalSessionMappingStore(session, { now: () => NOW });
		expect(restarted.getByExternal(EXTERNAL)?.adapter).toEqual(ADAPTER_A);

		session.appendCustomEntry(EXTERNAL_MAPPING_CUSTOM_TYPE, {
			schemaVersion: 1,
			mapping: {
				namespace: EXTERNAL.namespace,
				externalSessionId: EXTERNAL.externalSessionId,
				externalRunId: EXTERNAL.externalRunId,
				aosSessionId: session.getSessionId(),
				aosRunId: RUN_ID,
				createdAt: NOW,
				adapter: ADAPTER_B,
			},
		});
		const folded = foldExternalMappingEntries(session.getEntries());
		expect(folded.mappings).toHaveLength(2);
		expect(folded.warnings.map((warning) => warning.code)).toEqual(["mapping_conflict"]);
		expect(folded.byExternal.get(`${EXTERNAL.namespace}\u0000${EXTERNAL.externalSessionId}\u0000${EXTERNAL.externalRunId}`)).toBeUndefined();

		const afterDrift = new ExternalSessionMappingStore(session, { now: () => NOW });
		expect(afterDrift.getByExternal(EXTERNAL)).toBeUndefined();
		expect(afterDrift.getWarnings().map((warning) => warning.code)).toEqual(["mapping_conflict"]);
	});
});

describe("remote terminal receipt mapping", () => {
	it("guards bounded receipt inputs and rejects raw payloads", () => {
		expect(isRemoteOperationReceiptInput(receiptInput())).toBe(true);
		expect(isRemoteOperationReceiptInput(receiptInput({ prompt: "secret prompt" }))).toBe(false);
		expect(isRemoteOperationReceiptInput(receiptInput({ headers: { authorization: "Bearer x" } }))).toBe(false);
		expect(isRemoteOperationReceiptInput(receiptInput({ credential: "secret" }))).toBe(false);
		expect(isRemoteOperationReceiptInput(receiptInput({ operationId: "C:\\secret\\operation" }))).toBe(false);
		expect(isRemoteOperationReceiptInput(receiptInput({ endedAt: "2026-08-16" }))).toBe(false);
		expect(isRemoteOperationReceiptInput(receiptInput({ status: "running" }))).toBe(false);
		expect(isRemoteOperationReceiptInput(receiptInput({ sideEffects: "maybe" }))).toBe(false);
		expect(
			isRemoteOperationReceiptInput(receiptInput({ artifactRefs: [{ id: "https://secret.example", kind: "output" }] })),
		).toBe(false);
		expect(
			isRemoteOperationReceiptInput(
				receiptInput({ error: { code: "external_agent_start_failed", retryable: false, sideEffects: "none" } }),
			),
		).toBe(true);
		expect(
			isRemoteOperationReceiptInput(receiptInput({ error: { code: "raw provider error", retryable: false, sideEffects: "none" } })),
		).toBe(false);
		expect(isRemoteOperationReceiptInput(receiptInput({ adapter: { ...ADAPTER_A, prompt: "secret" } }))).toBe(false);
	});

	it("maps completed and failed external receipts to safe Remote Operation receipts", () => {
		const completed = toRemoteOperationReceipt(receiptInput());
		expect(completed).toMatchObject({
			schemaVersion: 1,
			operationId: "operation-external",
			status: "completed",
			endedAt: NOW,
			sideEffects: "none",
			runId: RUN_ID,
			sessionId: SESSION_ID,
			adapter: ADAPTER_A,
		});
		expect(completed?.error).toBeUndefined();
		expect(isRemoteOperationReceipt(completed)).toBe(true);

		const failed = toRemoteOperationReceipt(
			receiptInput({
				status: "failed",
				error: { code: "external_agent_start_failed", retryable: false, sideEffects: "associated" },
			}),
		);
		expect(failed?.status).toBe("failed");
		expect(failed?.error).toEqual({ category: "invalid", code: "invalid", retryable: false, sideEffects: "associated" });
		expect(failed?.sideEffects).toBe("associated");

		const completedWithError = toRemoteOperationReceipt(
			receiptInput({ error: { code: "external_agent_start_failed", retryable: false, sideEffects: "none" } }),
		);
		expect(completedWithError?.status).toBe("completed");
		expect(completedWithError?.error).toBeUndefined();
	});

	it("fails closed to side-effect-unknown and never retries", () => {
		const unknown = toRemoteOperationReceipt(receiptInput({ sideEffects: "unknown" }));
		expect(unknown?.status).toBe("failed");
		expect(unknown?.error).toEqual({
			category: "side-effect-unknown",
			code: "side-effect-unknown",
			retryable: false,
			sideEffects: "unknown",
		});
		expect(unknown?.sideEffects).toBe("unknown");

		const cancelledWithEffects = toRemoteOperationReceipt(receiptInput({ status: "cancelled", sideEffects: "associated" }));
		expect(cancelledWithEffects?.status).toBe("failed");
		expect(cancelledWithEffects?.error?.category).toBe("side-effect-unknown");

		const cleanCancel = toRemoteOperationReceipt(receiptInput({ status: "cancelled", sideEffects: "none" }));
		expect(cleanCancel?.status).toBe("cancelled");
		expect(cleanCancel?.error).toBeUndefined();
	});

	it("returns undefined for malformed input and validates artifact refs", () => {
		expect(toRemoteOperationReceipt(receiptInput({ credential: "secret" }))).toBeUndefined();
		expect(toRemoteOperationReceipt(receiptInput({ operationId: "bad operation" }))).toBeUndefined();
		expect(toRemoteOperationReceipt({ status: "completed" })).toBeUndefined();
		expect(toRemoteOperationReceipt("not-an-object")).toBeUndefined();

		expect(isRemoteArtifactReference({ id: "artifact-1", kind: "output", digest: "sha256:artifact-1" })).toBe(true);
		expect(isRemoteArtifactReference({ id: "C:\\secret", kind: "output" })).toBe(false);
		expect(isRemoteArtifactReference({ id: "artifact-1", kind: "output", path: "C:\\secret" })).toBe(false);
	});

	it("records the mapped receipt through the Session ledger with the adapter identity", () => {
		const session = makeSession();
		const ledger = createSessionRemoteOperationLedger(session);
		const mapped = toRemoteOperationReceipt(receiptInput({ sessionId: session.getSessionId() }));
		expect(mapped).toBeDefined();
		ledger.record(mapped!);

		expect(session.getEntries()).toHaveLength(1);
		expect(session.getEntries()[0]).toMatchObject({
			customType: REMOTE_OPERATION_CUSTOM_TYPE,
			data: { receipt: { operationId: "operation-external", adapter: ADAPTER_A } },
		});
		const audit = new ExecutionAuditQuery(session).query({ scope: "current-session", types: ["remote.operation"] });
		expect(audit.events).toHaveLength(1);
		expect(audit.events[0]).toMatchObject({ type: "remote.operation", adapter: ADAPTER_A });
		expect(JSON.stringify(session.getEntries())).not.toContain("secret");
	});
});

describe("audit query and replay adapter filtering", () => {
	it("projects the adapter identity onto mapping and operation events", () => {
		const adapter = new ExecutionAuditAdapter({
			getSessionId: () => SESSION_ID,
			getEntries: () => [...runEntries(), mappingEntry(SESSION_ID, ADAPTER_A), operationEntry(ADAPTER_A)],
		});
		const result = adapter.query({ scope: "current-session", types: ["external.mapping", "remote.operation"] });

		expect(result.events).toHaveLength(2);
		expect(result.events.find((event) => event.type === "external.mapping")).toMatchObject({
			adapter: ADAPTER_A,
			external: EXTERNAL,
		});
		expect(result.events.find((event) => event.type === "remote.operation")).toMatchObject({
			adapter: ADAPTER_A,
			runId: RUN_ID,
		});
	});

	it("filters events by adapter identity in both scopes", () => {
		const entries = [
			...runEntries(),
			mappingEntry(SESSION_ID, ADAPTER_A),
			operationEntry(ADAPTER_A),
			mappingEntry(SESSION_ID, ADAPTER_B),
		];
		const adapter = new ExecutionAuditAdapter({
			getSessionId: () => SESSION_ID,
			getEntries: () => entries,
		});

		const matching = adapter.query({ scope: "current-session", adapter: ADAPTER_A });
		expect(matching.events).toHaveLength(2);
		expect(matching.events.every((event) => event.adapter !== undefined)).toBe(true);

		const other = adapter.query({ scope: "current-session", adapter: { ...ADAPTER_A, targetId: "target-9" } });
		expect(other.events).toEqual([]);

		expect(() =>
			adapter.query({ scope: "current-session", adapter: { ...ADAPTER_A, prompt: "secret" } as never }),
		).toThrowError(new ExecutionAuditError("audit_query_invalid"));
	});

	it("filters replay events by adapter identity without changing replay status", () => {
		const adapter = new ExecutionAuditAdapter({
			getSessionId: () => SESSION_ID,
			getEntries: () => [...runEntries(), mappingEntry(SESSION_ID, ADAPTER_A), operationEntry(ADAPTER_A)],
		});
		const replay = adapter.replay(RUN_ID, { adapter: ADAPTER_A });

		expect(replay.status).toBe("complete");
		expect(replay.events.map((event) => event.type)).toEqual(["external.mapping", "remote.operation"]);
		expect(replay.events.every((event) => event.adapter !== undefined)).toBe(true);
	});

	it("filters cross-session directory queries by adapter identity", () => {
		const dir = mkdtempSync(join(tmpdir(), "aos-adapter-facts-"));
		try {
			const pathA = join(dir, "session-a.jsonl");
			const pathB = join(dir, "session-b.jsonl");
			writeFileSync(
				pathA,
				`${JSON.stringify({ type: "session", version: 3, id: "session-a", timestamp: NOW, cwd: dir } satisfies FileEntry)}\n` +
					[...runEntries("session-a"), mappingEntry("session-a", ADAPTER_A)].map((entry) => JSON.stringify(entry)).join("\n") +
					"\n",
			);
			const otherSession: SessionEntry = {
				...mappingEntry("session-b", ADAPTER_B),
				id: "external-mapping-b",
				timestamp: "2026-08-16T00:00:04.000Z",
			};
			writeFileSync(
				pathB,
				`${JSON.stringify({ type: "session", version: 3, id: "session-b", timestamp: NOW, cwd: dir } satisfies FileEntry)}\n` +
					[...runEntries("session-b"), otherSession].map((entry) => JSON.stringify(entry)).join("\n") +
					"\n",
			);
			const query = new ExecutionAuditQuery({
				getSessionId: () => SESSION_ID,
				getEntries: () => [],
				getSessionDir: () => dir,
			});

			const byAdapterA = query.query({ scope: "session-directory", adapter: ADAPTER_A });
			expect(byAdapterA.events.every((event) => event.adapter !== undefined)).toBe(true);
			expect(byAdapterA.events.map((event) => event.sessionId)).toEqual(["session-a"]);

			const byAdapterB = query.query({ scope: "session-directory", adapter: ADAPTER_B });
			expect(byAdapterB.events.map((event) => event.sessionId)).toEqual(["session-b"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
