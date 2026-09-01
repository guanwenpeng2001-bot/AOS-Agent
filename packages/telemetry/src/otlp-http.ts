import type {
	AttributeValue,
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryContext,
	TelemetrySpan,
} from "./index.ts";
import { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_MAX_QUEUE_SIZE = 512;
const DEFAULT_SCHEDULED_DELAY_MS = 5_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;
const HISTOGRAM_BOUNDS_MS = [10, 50, 100, 250, 500, 1_000, 5_000, 10_000, 30_000, 60_000] as const;

export type OtlpHttpTelemetryDiagnostic =
	| { readonly type: "queue_overflow"; readonly droppedSpans: number }
	| { readonly type: "export_failure"; readonly signal: "traces" | "metrics"; readonly failures: number };

export interface OtlpHttpTelemetryOptions {
	readonly endpoint: string;
	readonly sampleRate?: number;
	readonly serviceName?: string;
	readonly batchSize?: number;
	readonly maxQueueSize?: number;
	readonly scheduledDelayMs?: number;
	readonly exportTimeoutMs?: number;
	readonly request?: typeof fetch;
	readonly onDiagnostic?: (diagnostic: OtlpHttpTelemetryDiagnostic) => void;
}

export interface OtlpHttpTelemetryStats {
	readonly queuedSpans: number;
	readonly droppedSpans: number;
	readonly exportFailures: number;
	readonly exportedSpans: number;
}

interface MutableTelemetryEvent {
	name: string;
	timeUnixNano: string;
	attributes: SpanAttributes;
}

interface MutableOtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano?: string;
	attributes: SpanAttributes;
	events: MutableTelemetryEvent[];
	status: SpanStatus;
	explicitStatus: boolean;
	settled: boolean;
}

interface HistogramAggregate {
	count: number;
	sum: number;
	min: number;
	max: number;
	bucketCounts: number[];
	startTimeUnixNano: string;
	timeUnixNano: string;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
	return value;
}

function sampleRateValue(value: number | undefined): number {
	if (value === undefined) return 1;
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new TypeError("sampleRate must be between 0 and 1");
	}
	return value;
}

function endpointUrls(endpoint: string): { traces: string; metrics: string } {
	const base = new URL(endpoint);
	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new TypeError("OTLP endpoint must use http or https");
	}
	if (base.username !== "" || base.password !== "") {
		throw new TypeError("OTLP endpoint must not contain credentials");
	}
	const traces = new URL(base);
	const metrics = new URL(base);
	const path = base.pathname.replace(/\/$/, "");
	if (path.endsWith("/v1/traces")) {
		traces.pathname = path;
		metrics.pathname = `${path.slice(0, -"/v1/traces".length)}/v1/metrics`;
	} else if (path.endsWith("/v1/metrics")) {
		metrics.pathname = path;
		traces.pathname = `${path.slice(0, -"/v1/metrics".length)}/v1/traces`;
	} else {
		traces.pathname = `${path}/v1/traces`;
		metrics.pathname = `${path}/v1/metrics`;
	}
	return { traces: traces.toString(), metrics: metrics.toString() };
}

function nowUnixNano(): string {
	return (BigInt(Date.now()) * 1_000_000n).toString();
}

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function copyAttributeValue(value: AttributeValue): AttributeValue {
	return Array.isArray(value) ? ([...value] as AttributeValue) : value;
}

function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	const copy: SpanAttributes = {};
	if (!attributes) return copy;
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) copy[name] = copyAttributeValue(value);
	}
	return copy;
}

function mergeAttributes(current: SpanAttributes, attributes: SpanAttributes): SpanAttributes {
	const merged = copyAttributes(current);
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) merged[name] = copyAttributeValue(value);
	}
	return merged;
}

function copyStatus(status: SpanStatus): SpanStatus {
	if (status.status === "ok") return { status: "ok" };
	return status.error
		? { status: "error", error: { name: status.error.name, message: status.error.message } }
		: { status: "error" };
}

function automaticErrorStatus(error: unknown): SpanStatus {
	try {
		if (error instanceof Error) {
			return { status: "error", error: { name: error.name, message: error.message } };
		}
	} catch {
		// Error inspection is passive. Fall through to an error status without details.
	}
	return { status: "error" };
}

function scalarAnyValue(value: string | number | boolean): Record<string, unknown> {
	if (typeof value === "string") return { stringValue: value };
	if (typeof value === "boolean") return { boolValue: value };
	if (Number.isSafeInteger(value)) return { intValue: String(value) };
	return { doubleValue: value };
}

function anyValue(value: AttributeValue): Record<string, unknown> {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return scalarAnyValue(value);
	}
	const values: readonly (string | number | boolean)[] = value;
	return { arrayValue: { values: values.map((item) => scalarAnyValue(item)) } };
}

function otlpAttributes(attributes: SpanAttributes): Array<Record<string, unknown>> {
	return Object.entries(attributes).flatMap(([key, value]) =>
		value === undefined ? [] : [{ key, value: anyValue(value) }],
	);
}

function otlpSpan(span: MutableOtlpSpan): Record<string, unknown> {
	return {
		traceId: span.traceId,
		spanId: span.spanId,
		...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
		name: span.name,
		kind: 1,
		startTimeUnixNano: span.startTimeUnixNano,
		endTimeUnixNano: span.endTimeUnixNano,
		attributes: otlpAttributes(span.attributes),
		events: span.events.map((event) => ({
			name: event.name,
			timeUnixNano: event.timeUnixNano,
			attributes: otlpAttributes(event.attributes),
		})),
		status: span.status.status === "ok"
			? { code: 1 }
			: { code: 2, ...(span.status.error === undefined ? {} : { message: span.status.error.message }) },
	};
}

function durationMs(span: MutableOtlpSpan): number {
	if (span.endTimeUnixNano === undefined) return 0;
	return Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000;
}

function addHistogramValue(
	aggregate: HistogramAggregate | undefined,
	value: number,
	span: MutableOtlpSpan,
): HistogramAggregate {
	const next = aggregate ?? {
		count: 0,
		sum: 0,
		min: value,
		max: value,
		bucketCounts: Array.from({ length: HISTOGRAM_BOUNDS_MS.length + 1 }, () => 0),
		startTimeUnixNano: span.startTimeUnixNano,
		timeUnixNano: span.endTimeUnixNano ?? span.startTimeUnixNano,
	};
	next.count++;
	next.sum += value;
	next.min = Math.min(next.min, value);
	next.max = Math.max(next.max, value);
	if (BigInt(span.startTimeUnixNano) < BigInt(next.startTimeUnixNano)) next.startTimeUnixNano = span.startTimeUnixNano;
	const endTime = span.endTimeUnixNano ?? span.startTimeUnixNano;
	if (BigInt(endTime) > BigInt(next.timeUnixNano)) next.timeUnixNano = endTime;
	const bucketIndex = HISTOGRAM_BOUNDS_MS.findIndex((bound) => value <= bound);
	next.bucketCounts[bucketIndex === -1 ? HISTOGRAM_BOUNDS_MS.length : bucketIndex]++;
	return next;
}

function counterMetric(
	name: string,
	count: number,
	startTimeUnixNano: string,
	timeUnixNano: string,
): Record<string, unknown> {
	return {
		name,
		unit: "1",
		sum: {
			aggregationTemporality: 1,
			isMonotonic: true,
			dataPoints: [{ startTimeUnixNano, timeUnixNano, asInt: String(count) }],
		},
	};
}

function histogramMetric(name: string, aggregate: HistogramAggregate): Record<string, unknown> {
	return {
		name,
		unit: "ms",
		histogram: {
			aggregationTemporality: 1,
			dataPoints: [{
				startTimeUnixNano: aggregate.startTimeUnixNano,
				timeUnixNano: aggregate.timeUnixNano,
				count: String(aggregate.count),
				sum: aggregate.sum,
				min: aggregate.min,
				max: aggregate.max,
				bucketCounts: aggregate.bucketCounts.map(String),
				explicitBounds: [...HISTOGRAM_BOUNDS_MS],
			}],
		},
	};
}

function metricsForSpans(spans: readonly MutableOtlpSpan[]): Array<Record<string, unknown>> {
	const counters = new Map<string, number>();
	const counterRanges = new Map<string, { start: string; end: string }>();
	const histograms = new Map<string, HistogramAggregate>();
	const count = (name: string, span: MutableOtlpSpan): void => {
		counters.set(name, (counters.get(name) ?? 0) + 1);
		const end = span.endTimeUnixNano ?? span.startTimeUnixNano;
		const range = counterRanges.get(name);
		counterRanges.set(name, {
			start: range === undefined || BigInt(span.startTimeUnixNano) < BigInt(range.start)
				? span.startTimeUnixNano
				: range.start,
			end: range === undefined || BigInt(end) > BigInt(range.end) ? end : range.end,
		});
	};
	for (const span of spans) {
		if (span.name === "aos.harness.run") {
			count("aos.harness.run.started", span);
			count("aos.harness.run.finished", span);
		} else if (span.name === "aos.ai.request") {
			count("aos.ai.request.count", span);
			histograms.set(
				"aos.ai.request.duration",
				addHistogramValue(histograms.get("aos.ai.request.duration"), durationMs(span), span),
			);
		} else if (span.name === "aos.harness.tool") {
			count("aos.harness.tool.count", span);
			histograms.set(
				"aos.harness.tool.duration",
				addHistogramValue(histograms.get("aos.harness.tool.duration"), durationMs(span), span),
			);
		}
	}
	return [
		...Array.from(counters, ([name, value]) => {
			const range = counterRanges.get(name);
			if (range === undefined) throw new Error(`Missing counter range for ${name}`);
			return counterMetric(name, value, range.start, range.end);
		}),
		...Array.from(histograms, ([name, aggregate]) => histogramMetric(name, aggregate)),
	];
}

function resource(serviceName: string): Record<string, unknown> {
	return { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] };
}

function tracesPayload(serviceName: string, spans: readonly MutableOtlpSpan[]): Record<string, unknown> {
	return {
		resourceSpans: [{
			resource: resource(serviceName),
			scopeSpans: [{ scope: { name: "@aos-agent/telemetry" }, spans: spans.map(otlpSpan) }],
		}],
	};
}

function metricsPayload(serviceName: string, metrics: readonly Record<string, unknown>[]): Record<string, unknown> {
	return {
		resourceMetrics: [{
			resource: resource(serviceName),
			scopeMetrics: [{ scope: { name: "@aos-agent/telemetry" }, metrics }],
		}],
	};
}

/**
 * Dependency-free OTLP/HTTP JSON telemetry context with bounded passive batching.
 * Export failures are retained as diagnostics and never escape into product work.
 */
export class OtlpHttpTelemetryContext implements TelemetryContext {
	private readonly urls: { traces: string; metrics: string };
	private readonly sampleRate: number;
	private readonly serviceName: string;
	private readonly batchSize: number;
	private readonly maxQueueSize: number;
	private readonly exportTimeoutMs: number;
	private readonly request: typeof fetch;
	private readonly onDiagnostic: ((diagnostic: OtlpHttpTelemetryDiagnostic) => void) | undefined;
	private readonly queue: MutableOtlpSpan[] = [];
	private readonly timer: ReturnType<typeof setInterval>;
	private activeFlush: Promise<void> | undefined;
	private closed = false;
	private droppedSpans = 0;
	private exportFailures = 0;
	private exportedSpans = 0;

	constructor(options: OtlpHttpTelemetryOptions) {
		this.urls = endpointUrls(options.endpoint);
		this.sampleRate = sampleRateValue(options.sampleRate);
		this.serviceName = options.serviceName?.trim() || "aos-agent";
		this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, "batchSize");
		this.maxQueueSize = positiveInteger(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, "maxQueueSize");
		this.exportTimeoutMs = positiveInteger(options.exportTimeoutMs, DEFAULT_EXPORT_TIMEOUT_MS, "exportTimeoutMs");
		this.request = options.request ?? fetch;
		this.onDiagnostic = options.onDiagnostic;
		const scheduledDelayMs = positiveInteger(
			options.scheduledDelayMs,
			DEFAULT_SCHEDULED_DELAY_MS,
			"scheduledDelayMs",
		);
		this.timer = setInterval(() => {
			void this.flushNextBatch();
		}, scheduledDelayMs);
		const timerWithUnref = this.timer as ReturnType<typeof setInterval> & { unref?: () => void };
		timerWithUnref.unref?.();
	}

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		if (this.closed || this.sampleRate === 0 || (this.sampleRate < 1 && Math.random() >= this.sampleRate)) {
			return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
		}
		return this.startSampledSpan(undefined, options, callback);
	}

	private startSampledSpan<T>(
		parent: MutableOtlpSpan | undefined,
		options: SpanOptions,
		callback: (span: TelemetrySpan) => T | Promise<T>,
	): Promise<T> {
		if (this.closed || parent?.settled) return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
		let recordedSpan: MutableOtlpSpan;
		try {
			recordedSpan = {
				traceId: parent?.traceId ?? randomHex(16),
				spanId: randomHex(8),
				...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
				name: options.name,
				startTimeUnixNano: nowUnixNano(),
				attributes: copyAttributes(options.attributes),
				events: [],
				status: { status: "ok" },
				explicitStatus: false,
				settled: false,
			};
		} catch {
			return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
		}

		const span: TelemetrySpan = {
			startSpan: <Result>(
				childOptions: SpanOptions,
				childCallback: (child: TelemetrySpan) => Result | Promise<Result>,
			) => this.startSampledSpan(recordedSpan, childOptions, childCallback),
			addEvent: (name, attributes) => {
				if (recordedSpan.settled) return;
				try {
					recordedSpan.events.push({ name, timeUnixNano: nowUnixNano(), attributes: copyAttributes(attributes) });
				} catch {
					// Telemetry recording is passive.
				}
			},
			setAttributes: (attributes) => {
				if (recordedSpan.settled) return;
				try {
					recordedSpan.attributes = mergeAttributes(recordedSpan.attributes, attributes);
				} catch {
					// Telemetry recording is passive.
				}
			},
			setStatus: (status) => {
				if (recordedSpan.settled) return;
				try {
					recordedSpan.status = copyStatus(status);
					recordedSpan.explicitStatus = true;
				} catch {
					// Telemetry recording is passive.
				}
			},
		};

		let result: T | Promise<T>;
		try {
			result = callback(span);
		} catch (error) {
			this.settle(recordedSpan, true, error);
			return Promise.reject(error);
		}
		return Promise.resolve(result).then(
			(value) => {
				this.settle(recordedSpan, false);
				return value;
			},
			(error: unknown) => {
				this.settle(recordedSpan, true, error);
				throw error;
			},
		);
	}

	private settle(span: MutableOtlpSpan, failed: boolean, error?: unknown): void {
		if (span.settled) return;
		try {
			if (failed && !span.explicitStatus) span.status = automaticErrorStatus(error);
			span.endTimeUnixNano = nowUnixNano();
			span.settled = true;
			if (this.closed) return;
			if (this.queue.length >= this.maxQueueSize) {
				this.queue.shift();
				this.droppedSpans++;
				this.diagnostic({ type: "queue_overflow", droppedSpans: this.droppedSpans });
			}
			this.queue.push(span);
			if (this.queue.length >= this.batchSize) void this.flushNextBatch();
		} catch {
			// Telemetry settlement is passive.
		}
	}

	private diagnostic(diagnostic: OtlpHttpTelemetryDiagnostic): void {
		try {
			this.onDiagnostic?.(diagnostic);
		} catch {
			// Diagnostics must not change exporter or product behavior.
		}
	}

	private async post(signal: "traces" | "metrics", payload: Record<string, unknown>): Promise<boolean> {
		try {
			const response = await this.request(this.urls[signal], {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(this.exportTimeoutMs),
			});
			try {
				await response.arrayBuffer();
			} catch {
				// Response bodies are diagnostic-only.
			}
			if (!response.ok) throw new Error(`OTLP ${signal} export returned HTTP ${response.status}`);
			return true;
		} catch {
			this.exportFailures++;
			this.diagnostic({ type: "export_failure", signal, failures: this.exportFailures });
			return false;
		}
	}

	private flushNextBatch(): Promise<void> {
		if (this.activeFlush !== undefined) return this.activeFlush;
		if (this.queue.length === 0) return Promise.resolve();
		const batch = this.queue.splice(0, this.batchSize);
		this.activeFlush = (async () => {
			const metrics = metricsForSpans(batch);
			const [tracesExported] = await Promise.all([
				this.post("traces", tracesPayload(this.serviceName, batch)),
				...(metrics.length === 0
					? []
					: [this.post("metrics", metricsPayload(this.serviceName, metrics))]),
			]);
			if (tracesExported) this.exportedSpans += batch.length;
		})().catch(() => {
			this.exportFailures++;
			this.diagnostic({ type: "export_failure", signal: "traces", failures: this.exportFailures });
		}).finally(() => {
			this.activeFlush = undefined;
		});
		return this.activeFlush;
	}

	/** Flush all spans that were queued when or during this call. */
	async forceFlush(): Promise<void> {
		do {
			await (this.activeFlush ?? this.flushNextBatch());
		} while (this.queue.length > 0);
	}

	/** Stop the timer and passively flush remaining telemetry. */
	async shutdown(): Promise<void> {
		if (this.closed) {
			await (this.activeFlush ?? Promise.resolve());
			return;
		}
		this.closed = true;
		clearInterval(this.timer);
		await this.forceFlush();
	}

	getStats(): OtlpHttpTelemetryStats {
		return {
			queuedSpans: this.queue.length,
			droppedSpans: this.droppedSpans,
			exportFailures: this.exportFailures,
			exportedSpans: this.exportedSpans,
		};
	}
}
