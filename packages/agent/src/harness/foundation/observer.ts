import { Type } from "typebox";
import { Result, type Result as ResultValue } from "../result.ts";
import type { FoundationDurableEventV1, FoundationLiveDeltaV1 } from "./event-catalog.ts";
import type { FoundationError } from "./errors.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";
import { newFoundationUuid } from "./identity.ts";

export type ObserverPhaseV1 = "idle" | "attaching" | "buffering" | "live" | "reconnecting" | "gap" | "closed";
export interface ObserverCursorV1 { schemaVersion: 1; sessionId: string; ledgerRevision: number; sequence: number; catalogVersion: number; }
export interface ObserverSnapshotV1 { schemaVersion: 1; sessionId: string; ledgerRevision: number; sequence: number; catalogVersion: number; }
export interface ObserverAttachResultV1 { observerId: string; snapshot: ObserverSnapshotV1; cursor: ObserverCursorV1; }
export interface ObserverStartResultV1 { flushed: number; cursor: ObserverCursorV1; }
export interface ObserverReconnectResultV1 { fromSequence: number; cursor: ObserverCursorV1; }
export interface ObserverCatchUpResultV1 { applied: number; skipped: number; cursor: ObserverCursorV1; }
export interface ObserverIngestResultV1 { buffered: boolean; applied: boolean; duplicate: boolean; cursor: ObserverCursorV1; }
export type ObserverErrorCodeV1 = "observer_not_attached" | "observer_already_attached" | "observer_already_started" | "observer_closed" | "observer_invalid_state" | "observer_catalog_mismatch" | "observer_session_mismatch" | "event_cursor_invalid_sequence" | "event_cursor_gap" | "event_cursor_expired" | "observer_buffer_overflow";
export class ObserverErrorV1 extends Error { readonly _tag = "ObserverErrorV1" as const; readonly code: ObserverErrorCodeV1; constructor(code: ObserverErrorCodeV1, message: string) { super(message.replace(/https?:\/\/[^\s]+/g, "[redacted-url]")); this.name = "ObserverErrorV1"; this.code = code; } }
export interface ObserverEventListenerV1 { durable(event: FoundationDurableEventV1): void; live(delta: FoundationLiveDeltaV1): void; }
export interface FoundationObserverOptionsV1 { maxBufferSize?: number; catalogVersion?: number; retentionFloor?: number; idGenerator?: () => string; }
interface BufferedItemV1 { sequence: number; offset: number; event?: FoundationDurableEventV1; delta?: FoundationLiveDeltaV1; }

export const ObserverCursorV1Schema = Type.Object({ schemaVersion: Type.Literal(1), sessionId: Type.String({ minLength: 1 }), ledgerRevision: Type.Integer({ minimum: 0 }), sequence: Type.Integer({ minimum: 0 }), catalogVersion: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const ObserverSnapshotV1Schema = Type.Object({ schemaVersion: Type.Literal(1), sessionId: Type.String({ minLength: 1 }), ledgerRevision: Type.Integer({ minimum: 0 }), sequence: Type.Integer({ minimum: 0 }), catalogVersion: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export function validateObserverCursorV1(value: unknown): ResultValue<ObserverCursorV1, FoundationError> { return validateExactShape<ObserverCursorV1>(ObserverCursorV1Schema, value, "observer_cursor"); }
export function serializeObserverCursorV1(value: ObserverCursorV1): string { return serializeExactShape(ObserverCursorV1Schema, value, "observer_cursor"); }
export function parseObserverCursorV1(text: string): ResultValue<ObserverCursorV1, FoundationError> { return parseExactShape(ObserverCursorV1Schema, text, "observer_cursor"); }
export function validateObserverSnapshotV1(value: unknown): ResultValue<ObserverSnapshotV1, FoundationError> { return validateExactShape<ObserverSnapshotV1>(ObserverSnapshotV1Schema, value, "observer_snapshot"); }
export function serializeObserverSnapshotV1(value: ObserverSnapshotV1): string { return serializeExactShape(ObserverSnapshotV1Schema, value, "observer_snapshot"); }
export function parseObserverSnapshotV1(text: string): ResultValue<ObserverSnapshotV1, FoundationError> { return parseExactShape(ObserverSnapshotV1Schema, text, "observer_snapshot"); }
export const validateObserverCursor = validateObserverCursorV1;
export const serializeObserverCursor = serializeObserverCursorV1;
export const parseObserverCursor = parseObserverCursorV1;
export const validateObserverSnapshot = validateObserverSnapshotV1;
export const serializeObserverSnapshot = serializeObserverSnapshotV1;
export const parseObserverSnapshot = parseObserverSnapshotV1;

export class FoundationObserverV1 {
	private phase: ObserverPhaseV1 = "idle"; private readonly maxBufferSize: number; private readonly catalogVersion: number; private readonly retentionFloor: number; private readonly idGenerator: () => string;
	private observerId: string | undefined; private sessionId: string | undefined; private snapshot: ObserverSnapshotV1 | undefined; private cursor: ObserverCursorV1 | undefined; private buffered: BufferedItemV1[] = []; private listener: ObserverEventListenerV1 | undefined; private lastAppliedSequence = 0; private lastLiveOffset = -1;
	constructor(options: FoundationObserverOptionsV1 = {}) { this.maxBufferSize = Math.max(1, options.maxBufferSize ?? 1024); this.catalogVersion = options.catalogVersion ?? 1; this.retentionFloor = options.retentionFloor ?? 0; this.idGenerator = options.idGenerator ?? newFoundationUuid; }
	get currentPhase(): ObserverPhaseV1 { return this.phase; }
	get currentObserverId(): string | undefined { return this.observerId; }
	get currentCursor(): ObserverCursorV1 | undefined { return this.cursor && { ...this.cursor }; }
	get currentSnapshot(): ObserverSnapshotV1 | undefined { return this.snapshot && { ...this.snapshot }; }
	get bufferedCount(): number { return this.buffered.length; }
	requiresResnapshot(): boolean { return this.phase === "gap"; }
	attach(sessionId: string, cursor?: ObserverCursorV1): ResultValue<ObserverAttachResultV1, ObserverErrorV1> {
		if (this.phase === "closed") return Result.err(new ObserverErrorV1("observer_closed", "observer is closed")); if (this.phase !== "idle" && this.phase !== "gap") return Result.err(new ObserverErrorV1("observer_already_attached", "observer is already attached"));
		const checked = this.validateCursor(sessionId, cursor); if (!checked.ok) return checked; const sequence = cursor?.sequence ?? this.retentionFloor; const revision = cursor?.ledgerRevision ?? 0;
		this.sessionId = sessionId; this.snapshot = { schemaVersion: 1, sessionId, ledgerRevision: revision, sequence, catalogVersion: this.catalogVersion }; this.cursor = { schemaVersion: 1, sessionId, ledgerRevision: revision, sequence, catalogVersion: this.catalogVersion }; this.lastAppliedSequence = sequence; this.lastLiveOffset = -1; this.observerId = this.idGenerator(); this.buffered = []; this.listener = undefined; this.phase = "buffering";
		return Result.ok({ observerId: this.observerId, snapshot: { ...this.snapshot }, cursor: { ...this.cursor } });
	}
	receiveLive(delta: FoundationLiveDeltaV1): ResultValue<ObserverIngestResultV1, ObserverErrorV1> {
		if (this.phase === "idle" || this.phase === "attaching" || this.phase === "gap" || this.phase === "closed") return Result.err(new ObserverErrorV1("observer_invalid_state", `cannot receive live deltas in phase ${this.phase}`)); if (this.sessionId && delta.correlation.sessionId !== this.sessionId) return Result.err(new ObserverErrorV1("observer_session_mismatch", "live delta belongs to another session"));
		if (this.phase === "live" && this.listener) { if (delta.offset <= this.lastLiveOffset) return Result.ok({ buffered: false, applied: false, duplicate: true, cursor: { ...this.cursor! } }); this.lastLiveOffset = delta.offset; this.listener.live(delta); return Result.ok({ buffered: false, applied: true, duplicate: false, cursor: { ...this.cursor! } }); }
		if (this.buffered.length >= this.maxBufferSize) return this.enterGap(new ObserverErrorV1("observer_buffer_overflow", "observer buffer overflow")); this.buffered.push({ sequence: -1, offset: delta.offset, delta }); return Result.ok({ buffered: true, applied: false, duplicate: false, cursor: { ...this.cursor! } });
	}
	receiveDurable(event: FoundationDurableEventV1): ResultValue<ObserverIngestResultV1, ObserverErrorV1> {
		if (this.phase === "idle" || this.phase === "attaching" || this.phase === "gap" || this.phase === "closed") return Result.err(new ObserverErrorV1("observer_invalid_state", `cannot receive durable events in phase ${this.phase}`)); if (this.sessionId && event.correlation.sessionId !== this.sessionId) return Result.err(new ObserverErrorV1("observer_session_mismatch", "event belongs to another session")); if (this.phase === "reconnecting") return Result.err(new ObserverErrorV1("observer_invalid_state", "deliver reconnect replay through deliverCatchUp"));
		if (this.phase === "live") { if (event.sequence <= this.lastAppliedSequence) return Result.ok({ buffered: false, applied: false, duplicate: true, cursor: { ...this.cursor! } }); if (event.sequence !== this.lastAppliedSequence + 1) return this.enterGap(new ObserverErrorV1("event_cursor_gap", "durable event sequence has a gap")); this.applyDurable(event); return Result.ok({ buffered: false, applied: true, duplicate: false, cursor: { ...this.cursor! } }); }
		if (this.buffered.length >= this.maxBufferSize) return this.enterGap(new ObserverErrorV1("observer_buffer_overflow", "observer buffer overflow")); this.buffered.push({ sequence: event.sequence, offset: -1, event }); return Result.ok({ buffered: true, applied: false, duplicate: false, cursor: { ...this.cursor! } });
	}
	start(listener: ObserverEventListenerV1): ResultValue<ObserverStartResultV1, ObserverErrorV1> {
		if (this.phase === "closed") return Result.err(new ObserverErrorV1("observer_closed", "observer is closed")); if (this.phase === "idle" || this.phase === "attaching") return Result.err(new ObserverErrorV1("observer_not_attached", "attach before start")); if (this.phase === "gap") return Result.err(new ObserverErrorV1("observer_invalid_state", "re-attach after a gap")); if (this.phase === "live" || this.phase === "reconnecting") return Result.err(new ObserverErrorV1("observer_already_started", "observer is already started"));
		const base = this.cursor!.sequence; const durable = this.buffered.filter((item) => item.event && item.sequence > base).sort((a, b) => a.sequence - b.sequence); let expected = base + 1; for (const item of durable) { if (item.sequence !== expected) return this.enterGap(new ObserverErrorV1("event_cursor_gap", "attach buffer is not contiguous")); expected += 1; }
		this.listener = listener; for (const item of durable) if (item.event) this.applyDurable(item.event); this.buffered = []; this.phase = "live"; return Result.ok({ flushed: durable.length, cursor: { ...this.cursor! } });
	}
	reconnect(cursor: ObserverCursorV1): ResultValue<ObserverReconnectResultV1, ObserverErrorV1> {
		if (this.phase === "closed") return Result.err(new ObserverErrorV1("observer_closed", "observer is closed")); if (!this.sessionId) return Result.err(new ObserverErrorV1("observer_not_attached", "attach before reconnect")); const checked = this.validateCursor(this.sessionId, cursor); if (!checked.ok) return checked; this.cursor = { ...cursor }; this.lastAppliedSequence = cursor.sequence; this.buffered = []; this.phase = "reconnecting"; return Result.ok({ fromSequence: cursor.sequence + 1, cursor: { ...cursor } });
	}
	deliverCatchUp(events: readonly FoundationDurableEventV1[]): ResultValue<ObserverCatchUpResultV1, ObserverErrorV1> {
		if (this.phase === "closed") return Result.err(new ObserverErrorV1("observer_closed", "observer is closed")); if (this.phase !== "reconnecting") return Result.err(new ObserverErrorV1("observer_invalid_state", "reconnect before catch-up")); let next = this.cursor!.sequence + 1; let applied = 0; let skipped = 0;
		for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) { if (event.sequence < next) { skipped += 1; continue; } if (event.sequence !== next) return this.enterGap(new ObserverErrorV1("event_cursor_gap", "replay has a sequence gap")); this.applyDurable(event); next += 1; applied += 1; }
		this.phase = "live"; return Result.ok({ applied, skipped, cursor: { ...this.cursor! } });
	}
	close(): void { this.phase = "closed"; this.buffered = []; this.listener = undefined; }
	private validateCursor(sessionId: string, cursor: ObserverCursorV1 | undefined): ResultValue<void, ObserverErrorV1> { if (!cursor) return Result.ok(undefined); if (cursor.sessionId !== sessionId) return Result.err(new ObserverErrorV1("observer_session_mismatch", "cursor belongs to another session")); if (!Number.isInteger(cursor.sequence) || cursor.sequence < 0 || !Number.isInteger(cursor.ledgerRevision) || cursor.ledgerRevision < 0) return Result.err(new ObserverErrorV1("event_cursor_invalid_sequence", "cursor values must be non-negative integers")); if (cursor.catalogVersion !== this.catalogVersion) return Result.err(new ObserverErrorV1("observer_catalog_mismatch", "cursor catalog version differs")); if (cursor.sequence < this.retentionFloor) return Result.err(new ObserverErrorV1("event_cursor_gap", "cursor is outside retained history")); return Result.ok(undefined); }
	private applyDurable(event: FoundationDurableEventV1): void { this.lastAppliedSequence = event.sequence; this.cursor = { ...this.cursor!, sequence: event.sequence, catalogVersion: this.catalogVersion }; this.listener?.durable(event); }
	private enterGap(error: ObserverErrorV1): Result<never, ObserverErrorV1> { this.phase = "gap"; this.buffered = []; return Result.err(error); }
}
export function replayDurableEventsV1(cursor: ObserverCursorV1, events: readonly FoundationDurableEventV1[]): ResultValue<ObserverCatchUpResultV1, ObserverErrorV1> { let next = cursor.sequence + 1; let applied = 0; let skipped = 0; for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) { if (event.sequence < next) { skipped += 1; continue; } if (event.sequence !== next) return Result.err(new ObserverErrorV1("event_cursor_gap", "replay has a sequence gap")); next += 1; applied += 1; } return Result.ok({ applied, skipped, cursor: { ...cursor, sequence: next - 1 } }); }
