import { Type } from "typebox";
import { Result, type ResultValue } from "../result.ts";
import type { DurableEventEnvelope, LiveDeltaEnvelope } from "./event-catalog.ts";
import type { FoundationError } from "./errors.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";
import { newFoundationUuid } from "./identity.ts";

export type ObserverPhase = "idle" | "attaching" | "buffering" | "live" | "reconnecting" | "gap" | "closed";
export interface ObserverCursor { schemaVersion: 1; sessionId: string; ledgerRevision: number; sequence: number; catalogVersion: number; }
export interface ObserverSnapshot { schemaVersion: 1; sessionId: string; ledgerRevision: number; sequence: number; catalogVersion: number; }
export interface ObserverAttachResult { observerId: string; snapshot: ObserverSnapshot; cursor: ObserverCursor; }
export interface ObserverStartResult { flushed: number; cursor: ObserverCursor; }
export interface ObserverReconnectResult { fromSequence: number; cursor: ObserverCursor; }
export interface ObserverCatchUpResult { applied: number; skipped: number; cursor: ObserverCursor; }
export interface ObserverIngestResult { buffered: boolean; applied: boolean; duplicate: boolean; cursor: ObserverCursor; }
export type ObserverErrorCode = "observer_not_attached" | "observer_already_attached" | "observer_already_started" | "observer_closed" | "observer_invalid_state" | "observer_catalog_mismatch" | "observer_session_mismatch" | "event_cursor_invalid_sequence" | "event_cursor_gap" | "event_cursor_expired" | "observer_buffer_overflow";
export class ObserverError extends Error { readonly _tag = "ObserverErrorV1" as const; readonly code: ObserverErrorCode; constructor(code: ObserverErrorCode, message: string) { super(message.replace(/https?:\/\/[^\s]+/g, "[redacted-url]")); this.name = "ObserverErrorV1"; this.code = code; } }
export interface ObserverEventListener { durable(event: DurableEventEnvelope): void; live(delta: LiveDeltaEnvelope): void; }
export interface FoundationObserverOptions { maxBufferSize?: number; catalogVersion?: number; retentionFloor?: number; idGenerator?: () => string; }
interface BufferedItemV1 { sequence: number; offset: number; event?: DurableEventEnvelope; delta?: LiveDeltaEnvelope; }

export const ObserverCursorSchema = Type.Object({ schemaVersion: Type.Literal(1), sessionId: Type.String({ minLength: 1 }), ledgerRevision: Type.Integer({ minimum: 0 }), sequence: Type.Integer({ minimum: 0 }), catalogVersion: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const ObserverSnapshotSchema = Type.Object({ schemaVersion: Type.Literal(1), sessionId: Type.String({ minLength: 1 }), ledgerRevision: Type.Integer({ minimum: 0 }), sequence: Type.Integer({ minimum: 0 }), catalogVersion: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export function validateObserverCursor(value: unknown): ResultValue<ObserverCursor, FoundationError> { return validateExactShape<ObserverCursor>(ObserverCursorSchema, value, "observer_cursor"); }
export function serializeObserverCursor(value: ObserverCursor): string { return serializeExactShape(ObserverCursorSchema, value, "observer_cursor"); }
export function parseObserverCursor(text: string): ResultValue<ObserverCursor, FoundationError> { return parseExactShape(ObserverCursorSchema, text, "observer_cursor"); }
export function validateObserverSnapshot(value: unknown): ResultValue<ObserverSnapshot, FoundationError> { return validateExactShape<ObserverSnapshot>(ObserverSnapshotSchema, value, "observer_snapshot"); }
export function serializeObserverSnapshot(value: ObserverSnapshot): string { return serializeExactShape(ObserverSnapshotSchema, value, "observer_snapshot"); }
export function parseObserverSnapshot(text: string): ResultValue<ObserverSnapshot, FoundationError> { return parseExactShape(ObserverSnapshotSchema, text, "observer_snapshot"); }

export class FoundationObserver {
	private phase: ObserverPhase = "idle"; private readonly maxBufferSize: number; private readonly catalogVersion: number; private readonly retentionFloor: number; private readonly idGenerator: () => string;
	private observerId: string | undefined; private sessionId: string | undefined; private snapshot: ObserverSnapshot | undefined; private cursor: ObserverCursor | undefined; private buffered: BufferedItemV1[] = []; private listener: ObserverEventListener | undefined; private lastAppliedSequence = 0; private lastLiveOffset = -1;
	constructor(options: FoundationObserverOptions = {}) { this.maxBufferSize = Math.max(1, options.maxBufferSize ?? 1024); this.catalogVersion = options.catalogVersion ?? 1; this.retentionFloor = options.retentionFloor ?? 0; this.idGenerator = options.idGenerator ?? newFoundationUuid; }
	get currentPhase(): ObserverPhase { return this.phase; }
	get currentObserverId(): string | undefined { return this.observerId; }
	get currentCursor(): ObserverCursor | undefined { return this.cursor && { ...this.cursor }; }
	get currentSnapshot(): ObserverSnapshot | undefined { return this.snapshot && { ...this.snapshot }; }
	get bufferedCount(): number { return this.buffered.length; }
	requiresResnapshot(): boolean { return this.phase === "gap"; }
	attach(sessionId: string, cursor?: ObserverCursor): ResultValue<ObserverAttachResult, ObserverError> {
		if (this.phase === "closed") return Result.err(new ObserverError("observer_closed", "observer is closed")); if (this.phase !== "idle" && this.phase !== "gap") return Result.err(new ObserverError("observer_already_attached", "observer is already attached"));
		const checked = this.validateCursor(sessionId, cursor); if (!checked.ok) return checked; const sequence = cursor?.sequence ?? this.retentionFloor; const revision = cursor?.ledgerRevision ?? 0;
		this.sessionId = sessionId; this.snapshot = { schemaVersion: 1, sessionId, ledgerRevision: revision, sequence, catalogVersion: this.catalogVersion }; this.cursor = { schemaVersion: 1, sessionId, ledgerRevision: revision, sequence, catalogVersion: this.catalogVersion }; this.lastAppliedSequence = sequence; this.lastLiveOffset = -1; this.observerId = this.idGenerator(); this.buffered = []; this.listener = undefined; this.phase = "buffering";
		return Result.ok({ observerId: this.observerId, snapshot: { ...this.snapshot }, cursor: { ...this.cursor } });
	}
	receiveLive(delta: LiveDeltaEnvelope): ResultValue<ObserverIngestResult, ObserverError> {
		if (this.phase === "idle" || this.phase === "attaching" || this.phase === "gap" || this.phase === "closed") return Result.err(new ObserverError("observer_invalid_state", `cannot receive live deltas in phase ${this.phase}`)); if (this.sessionId && delta.correlation.sessionId !== this.sessionId) return Result.err(new ObserverError("observer_session_mismatch", "live delta belongs to another session"));
		if (this.phase === "live" && this.listener) { if (delta.offset <= this.lastLiveOffset) return Result.ok({ buffered: false, applied: false, duplicate: true, cursor: { ...this.cursor! } }); this.lastLiveOffset = delta.offset; this.listener.live(delta); return Result.ok({ buffered: false, applied: true, duplicate: false, cursor: { ...this.cursor! } }); }
		if (this.buffered.length >= this.maxBufferSize) return this.enterGap(new ObserverError("observer_buffer_overflow", "observer buffer overflow")); this.buffered.push({ sequence: -1, offset: delta.offset, delta }); return Result.ok({ buffered: true, applied: false, duplicate: false, cursor: { ...this.cursor! } });
	}
	receiveDurable(event: DurableEventEnvelope): ResultValue<ObserverIngestResult, ObserverError> {
		if (this.phase === "idle" || this.phase === "attaching" || this.phase === "gap" || this.phase === "closed") return Result.err(new ObserverError("observer_invalid_state", `cannot receive durable events in phase ${this.phase}`)); if (this.sessionId && event.correlation.sessionId !== this.sessionId) return Result.err(new ObserverError("observer_session_mismatch", "event belongs to another session")); if (this.phase === "reconnecting") return Result.err(new ObserverError("observer_invalid_state", "deliver reconnect replay through deliverCatchUp"));
		if (this.phase === "live") { if (event.sequence <= this.lastAppliedSequence) return Result.ok({ buffered: false, applied: false, duplicate: true, cursor: { ...this.cursor! } }); if (event.sequence !== this.lastAppliedSequence + 1) return this.enterGap(new ObserverError("event_cursor_gap", "durable event sequence has a gap")); this.applyDurable(event); return Result.ok({ buffered: false, applied: true, duplicate: false, cursor: { ...this.cursor! } }); }
		if (this.buffered.length >= this.maxBufferSize) return this.enterGap(new ObserverError("observer_buffer_overflow", "observer buffer overflow")); this.buffered.push({ sequence: event.sequence, offset: -1, event }); return Result.ok({ buffered: true, applied: false, duplicate: false, cursor: { ...this.cursor! } });
	}
	start(listener: ObserverEventListener): ResultValue<ObserverStartResult, ObserverError> {
		if (this.phase === "closed") return Result.err(new ObserverError("observer_closed", "observer is closed")); if (this.phase === "idle" || this.phase === "attaching") return Result.err(new ObserverError("observer_not_attached", "attach before start")); if (this.phase === "gap") return Result.err(new ObserverError("observer_invalid_state", "re-attach after a gap")); if (this.phase === "live" || this.phase === "reconnecting") return Result.err(new ObserverError("observer_already_started", "observer is already started"));
		const base = this.cursor!.sequence; const durable = this.buffered.filter((item) => item.event && item.sequence > base).sort((a, b) => a.sequence - b.sequence); let expected = base + 1; for (const item of durable) { if (item.sequence !== expected) return this.enterGap(new ObserverError("event_cursor_gap", "attach buffer is not contiguous")); expected += 1; }
		this.listener = listener; for (const item of durable) if (item.event) this.applyDurable(item.event); this.buffered = []; this.phase = "live"; return Result.ok({ flushed: durable.length, cursor: { ...this.cursor! } });
	}
	reconnect(cursor: ObserverCursor): ResultValue<ObserverReconnectResult, ObserverError> {
		if (this.phase === "closed") return Result.err(new ObserverError("observer_closed", "observer is closed")); if (!this.sessionId) return Result.err(new ObserverError("observer_not_attached", "attach before reconnect")); const checked = this.validateCursor(this.sessionId, cursor); if (!checked.ok) return checked; this.cursor = { ...cursor }; this.lastAppliedSequence = cursor.sequence; this.buffered = []; this.phase = "reconnecting"; return Result.ok({ fromSequence: cursor.sequence + 1, cursor: { ...cursor } });
	}
	deliverCatchUp(events: readonly DurableEventEnvelope[]): ResultValue<ObserverCatchUpResult, ObserverError> {
		if (this.phase === "closed") return Result.err(new ObserverError("observer_closed", "observer is closed")); if (this.phase !== "reconnecting") return Result.err(new ObserverError("observer_invalid_state", "reconnect before catch-up")); let next = this.cursor!.sequence + 1; let applied = 0; let skipped = 0;
		for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) { if (event.sequence < next) { skipped += 1; continue; } if (event.sequence !== next) return this.enterGap(new ObserverError("event_cursor_gap", "replay has a sequence gap")); this.applyDurable(event); next += 1; applied += 1; }
		this.phase = "live"; return Result.ok({ applied, skipped, cursor: { ...this.cursor! } });
	}
	close(): void { this.phase = "closed"; this.buffered = []; this.listener = undefined; }
	private validateCursor(sessionId: string, cursor: ObserverCursor | undefined): ResultValue<void, ObserverError> { if (!cursor) return Result.ok(undefined); if (cursor.sessionId !== sessionId) return Result.err(new ObserverError("observer_session_mismatch", "cursor belongs to another session")); if (!Number.isInteger(cursor.sequence) || cursor.sequence < 0 || !Number.isInteger(cursor.ledgerRevision) || cursor.ledgerRevision < 0) return Result.err(new ObserverError("event_cursor_invalid_sequence", "cursor values must be non-negative integers")); if (cursor.catalogVersion !== this.catalogVersion) return Result.err(new ObserverError("observer_catalog_mismatch", "cursor catalog version differs")); if (cursor.sequence < this.retentionFloor) return Result.err(new ObserverError("event_cursor_gap", "cursor is outside retained history")); return Result.ok(undefined); }
	private applyDurable(event: DurableEventEnvelope): void { this.lastAppliedSequence = event.sequence; this.cursor = { ...this.cursor!, sequence: event.sequence, catalogVersion: this.catalogVersion }; this.listener?.durable(event); }
	private enterGap(error: ObserverError): Result<never, ObserverError> { this.phase = "gap"; this.buffered = []; return Result.err(error); }
}
export function replayDurableEvents(cursor: ObserverCursor, events: readonly DurableEventEnvelope[]): ResultValue<ObserverCatchUpResult, ObserverError> { let next = cursor.sequence + 1; let applied = 0; let skipped = 0; for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) { if (event.sequence < next) { skipped += 1; continue; } if (event.sequence !== next) return Result.err(new ObserverError("event_cursor_gap", "replay has a sequence gap")); next += 1; applied += 1; } return Result.ok({ applied, skipped, cursor: { ...cursor, sequence: next - 1 } }); }
