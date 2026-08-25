import { describe, expect, it } from "vitest";
import {
	EXTERNAL_MAPPING_CUSTOM_TYPE,
	ExternalMappingError,
	ExternalSessionMappingStore,
	foldExternalMappingEntries,
	isExternalExecutionRef,
} from "../src/core/external-session-mapping.ts";
import {
	RUN_LEDGER_CUSTOM_TYPE,
	createRunLifecycleCoordinator,
	serializePublicRunRecord,
} from "../src/core/run-lifecycle.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { observeCanonicalTerminal } from "./support/canonical-run-terminal.ts";

const NOW = "2026-08-13T00:00:00.000Z";
const MODEL = { provider: "test", id: "model", thinkingLevel: "low" as const };

function makeSession(): SessionManager {
	return SessionManager.inMemory("/workspace/external-mapping");
}

function request(aosSessionId: string, aosRunId?: string) {
	return {
		external: {
			namespace: "provider",
			externalSessionId: "external-session",
			externalRunId: "external-run",
		},
		aosSessionId,
		aosRunId,
	};
}

describe("external session mapping", () => {
	it("persists only the validated mapping summary and is absent from LLM context", () => {
		const session = makeSession();
		const store = new ExternalSessionMappingStore(session, { now: () => NOW });

		const result = store.persistMapping(request(session.getSessionId(), "aos-run"));

		expect(result.appended).toBe(true);
		expect(result.idempotent).toBe(false);
		expect(session.getEntries()).toHaveLength(1);
		expect(session.getEntries()[0]).toMatchObject({
			type: "custom",
			customType: EXTERNAL_MAPPING_CUSTOM_TYPE,
			data: {
				schemaVersion: 1,
				mapping: {
					namespace: "provider",
					externalSessionId: "external-session",
					externalRunId: "external-run",
					aosSessionId: session.getSessionId(),
					aosRunId: "aos-run",
					createdAt: NOW,
				},
			},
		});
		expect(JSON.stringify(session.buildSessionContext())).not.toContain("external-session");
		expect(JSON.stringify(session.getEntries())).not.toContain("untrusted-payload");
	});

	it("makes an identical request idempotent without appending a duplicate", () => {
		const session = makeSession();
		const store = new ExternalSessionMappingStore(session, { now: () => NOW });
		const first = store.persistMapping(request(session.getSessionId(), "aos-run"));
		const second = store.persistMapping(request(session.getSessionId(), "aos-run"));

		expect(first.appended).toBe(true);
		expect(second).toMatchObject({ appended: false, idempotent: true, mapping: first.mapping });
		expect(session.getEntries()).toHaveLength(1);
	});

	it("rejects conflicts in both external and AOS directions", () => {
		const session = makeSession();
		const store = new ExternalSessionMappingStore(session, { now: () => NOW });
		store.persistMapping(request(session.getSessionId(), "aos-run"));

		expect(() =>
			store.persistMapping({
				external: { namespace: "provider", externalSessionId: "external-session", externalRunId: "other-run" },
				aosSessionId: session.getSessionId(),
				aosRunId: "aos-run",
			}),
		).toThrowError(new ExternalMappingError("external_mapping_conflict", "AOS execution already maps to a different external target."));

		expect(() =>
			store.persistMapping({
				external: { namespace: "provider", externalSessionId: "other-session", externalRunId: "other-run" },
				aosSessionId: session.getSessionId(),
				aosRunId: "aos-run",
			}),
		).toThrowError(new ExternalMappingError("external_mapping_conflict", "AOS execution already maps to a different external target."));
	});

	it("rejects unsafe refs and never persists their payload", () => {
		const session = makeSession();
		const store = new ExternalSessionMappingStore(session, { now: () => NOW });
		const unsafe = {
			namespace: "provider",
			externalSessionId: "external-session",
			payload: "untrusted-payload",
		};

		expect(isExternalExecutionRef(unsafe)).toBe(false);
		expect(() =>
			store.persistMapping({
				external: unsafe,
				aosSessionId: session.getSessionId(),
			}),
		).toThrowError("External mapping identifiers are invalid.");
		expect(session.getEntries()).toHaveLength(0);
	});

	it("recovers mappings after a restart and warns on contradictory append-only entries", () => {
		const session = makeSession();
		const first = new ExternalSessionMappingStore(session, { now: () => NOW });
		first.persistMapping(request(session.getSessionId(), "aos-run"));
		session.appendCustomEntry(EXTERNAL_MAPPING_CUSTOM_TYPE, {
			schemaVersion: 1,
			mapping: {
				namespace: "provider",
				externalSessionId: "external-session",
				externalRunId: "different-run",
				aosSessionId: session.getSessionId(),
				aosRunId: "aos-run",
				createdAt: NOW,
			},
		});
		const warnings: string[] = [];
		const restarted = new ExternalSessionMappingStore(session, {
			now: () => NOW,
			diagnostics: (warning) => warnings.push(warning.code),
		});

		expect(restarted.getMappings()).toHaveLength(2);
		expect(restarted.getByExternal({ namespace: "provider", externalSessionId: "external-session", externalRunId: "external-run" })).toBeUndefined();
		expect(restarted.getByAos("provider", session.getSessionId(), "aos-run")).toBeUndefined();
		expect(restarted.getWarnings().map((warning) => warning.code)).toEqual(["mapping_conflict"]);
		expect(warnings).toEqual(["mapping_conflict"]);
	});

	it("reports malformed entries without accepting them as mappings", () => {
		const session = makeSession();
		const entryId = session.appendCustomEntry(EXTERNAL_MAPPING_CUSTOM_TYPE, {
			schemaVersion: 1,
			mapping: {
				namespace: "provider",
				externalSessionId: "external-session",
				aosSessionId: session.getSessionId(),
				createdAt: NOW,
				payload: "untrusted-payload",
			},
		});
		const folded = foldExternalMappingEntries(session.getEntries());

		expect(folded.mappings).toEqual([]);
		expect(folded.warnings).toEqual([
			expect.objectContaining({ code: "malformed_mapping", entryId }),
		]);
	});

	it("turns append failures into persistence errors without acknowledging success", () => {
		const inner = makeSession();
		const session = {
			getEntries: () => inner.getEntries(),
			appendCustomEntry: () => {
				throw new Error("disk full");
			},
		};
		const store = new ExternalSessionMappingStore(session, { now: () => NOW });

		try {
			store.persistMapping(request(inner.getSessionId(), "aos-run"));
			throw new Error("expected persistence failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ExternalMappingError);
			expect((error as ExternalMappingError).code).toBe("audit_persistence_failed");
		}
		expect(inner.getEntries()).toHaveLength(0);
	});

	it("persists the mapping after accepting a Run while keeping it out of the canonical receipt", async () => {
		const session = makeSession();
		const coordinator = createRunLifecycleCoordinator(session, { now: () => NOW });
		const reservation = coordinator.reserve();
		const run = reservation.accept({
			runId: "aos-run",
			attempt: 1,
			model: MODEL,
			external: {
				namespace: "provider",
				externalSessionId: "external-session",
				externalRunId: "external-run",
			},
		});
		const started = run.start();
		const { event: terminal } = await observeCanonicalTerminal(session, run, { outcome: "completed" });

		expect(started[0]).toMatchObject({ type: "run.started", runId: "aos-run" });
		expect(terminal).toMatchObject({ type: "run.completed", receipt: { runId: "aos-run" } });
		expect(session.getEntries().map((entry) => entry.type === "custom" ? entry.customType : entry.type).slice(0, 3)).toEqual([
			RUN_LEDGER_CUSTOM_TYPE,
			EXTERNAL_MAPPING_CUSTOM_TYPE,
			RUN_LEDGER_CUSTOM_TYPE,
		]);
		expect(serializePublicRunRecord(run.record).external).toEqual(run.record.external);
		if (terminal === undefined || !("receipt" in terminal)) throw new Error("expected terminal receipt");
		expect("external" in terminal.receipt).toBe(false);

		const restarted = createRunLifecycleCoordinator(session, { now: () => NOW });
		const recovered = restarted.getRun("aos-run");
		expect(recovered?.record.external).toEqual(run.record.external);
		expect("external" in recovered!.receipt!).toBe(false);
	});

	it("fails mapping persistence without acknowledging an accepted Run", () => {
		const inner = makeSession();
		const session = {
			getSessionId: () => inner.getSessionId(),
			getSessionFile: () => inner.getSessionFile(),
			getEntries: () => inner.getEntries(),
			appendCustomEntry: (customType: string, data?: unknown): string => {
				if (customType === EXTERNAL_MAPPING_CUSTOM_TYPE) throw new Error("disk full");
				return inner.appendCustomEntry(customType, data);
			},
		};
		const coordinator = createRunLifecycleCoordinator(session, { now: () => NOW });
		const reservation = coordinator.reserve();

		try {
			reservation.accept({
				runId: "aos-run",
				attempt: 1,
				model: MODEL,
				external: {
					namespace: "provider",
					externalSessionId: "external-session",
					externalRunId: "external-run",
				},
			});
			throw new Error("expected mapping persistence failure");
		} catch (error) {
			expect(error).toMatchObject({ code: "audit_persistence_failed" });
		}
		expect(inner.getEntries()).toHaveLength(1);
		expect(coordinator.getRun("aos-run")?.record.status).toBe("accepted");
	});

	it("does not acknowledge an append that is not visible in durable entries", () => {
		const inner = makeSession();
		const session = {
			getEntries: () => inner.getEntries(),
			appendCustomEntry: () => "entry-not-visible",
		};
		const store = new ExternalSessionMappingStore(session, { now: () => NOW });

		expect(() => store.persistMapping(request(inner.getSessionId(), "aos-run"))).toThrowError(
			"External mapping was not durably persisted.",
		);
		expect(inner.getEntries()).toHaveLength(0);
	});
});
