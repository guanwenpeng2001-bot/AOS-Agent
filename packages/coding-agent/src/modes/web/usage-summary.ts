import type { AuditEvent, AuditEventType, AuditQuery, AuditQueryResult } from "../rpc/rpc-types.ts";

const TERMINAL_EVENT_TYPES = ["run.completed", "run.failed", "run.cancelled"] as const;
const USAGE_EVENT_TYPES = [...TERMINAL_EVENT_TYPES, "model.attempt"] satisfies ReadonlyArray<AuditEventType>;
const AUDIT_PAGE_LIMIT = 200;

type TerminalAuditEvent = Extract<AuditEvent, { readonly type: (typeof TERMINAL_EVENT_TYPES)[number] }>;
type ModelAttemptAuditEvent = Extract<AuditEvent, { readonly type: "model.attempt" }>;

export interface WebUsageTotals {
	readonly runCount: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly costUsd: number;
}

export interface WebSessionUsage extends WebUsageTotals {
	readonly sessionId: string;
}

export interface WebModelUsage extends WebUsageTotals {
	readonly provider: string;
	readonly modelId: string;
}

export interface WebDailyUsage extends WebUsageTotals {
	readonly day: string;
}

export interface WebUsageSummary {
	readonly totals: WebUsageTotals;
	readonly bySession: ReadonlyArray<WebSessionUsage>;
	readonly byModel: ReadonlyArray<WebModelUsage>;
	readonly byDay: ReadonlyArray<WebDailyUsage>;
	readonly warningCount: number;
}

export interface WebUsageAuditClient {
	auditQuery(query: AuditQuery): Promise<AuditQueryResult>;
}

interface MutableUsageTotals {
	runCount: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

interface ModelAccumulator {
	readonly provider: string;
	readonly modelId: string;
	readonly totals: MutableUsageTotals;
	readonly runKeys: Set<string>;
}

interface NumericUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

/** Aggregate durable receipt usage and recorded Model attempt cost for the local Host. */
export async function loadWebUsageSummary(client: WebUsageAuditClient): Promise<WebUsageSummary> {
	const { events, warningCount } = await loadUsageEvents(client);
	const terminalByRun = new Map<string, TerminalAuditEvent>();
	const attemptsByRun = new Map<string, Map<string, ModelAttemptAuditEvent>>();
	for (const event of events) {
		if (isTerminalEvent(event)) {
			const key = runKey(event.sessionId, event.runId);
			const existing = terminalByRun.get(key);
			if (existing === undefined || compareAuditEvents(existing, event) < 0) terminalByRun.set(key, event);
			continue;
		}
		if (event.type !== "model.attempt" || event.runId === undefined) continue;
		const key = runKey(event.sessionId, event.runId);
		const attempts = attemptsByRun.get(key) ?? new Map<string, ModelAttemptAuditEvent>();
		const existing = attempts.get(event.summary.attemptId);
		if (existing === undefined || compareAuditEvents(existing, event) < 0) {
			attempts.set(event.summary.attemptId, event);
		}
		attemptsByRun.set(key, attempts);
	}

	const totals = emptyTotals();
	const sessions = new Map<string, MutableUsageTotals>();
	const days = new Map<string, MutableUsageTotals>();
	const models = new Map<string, ModelAccumulator>();
	for (const [key, terminal] of terminalByRun) {
		const receiptUsage = terminal.summary.usage;
		if (receiptUsage === undefined) continue;
		const attempts = [...(attemptsByRun.get(key)?.values() ?? [])];
		const attemptUsage = attempts
			.map((event) => ({ event, usage: modelAttemptUsage(event) }))
			.filter((item): item is { event: ModelAttemptAuditEvent; usage: NumericUsage } => item.usage !== undefined);
		const recordedAttemptCost = attemptUsage.reduce((sum, item) => sum + item.usage.costUsd, 0);
		const recordedBudgetCost = terminal.summary.modelBudget?.costUsd ?? 0;
		const runCost = Math.max(recordedAttemptCost, recordedBudgetCost);
		const runUsage: NumericUsage = {
			inputTokens: receiptUsage.input,
			outputTokens: receiptUsage.output,
			totalTokens: receiptUsage.total,
			costUsd: runCost,
		};
		addUsage(totals, runUsage, true);
		const session = sessions.get(terminal.sessionId) ?? emptyTotals();
		addUsage(session, runUsage, true);
		sessions.set(terminal.sessionId, session);
		const day = terminal.summary.endedAt?.slice(0, 10) ?? terminal.recordedAt.slice(0, 10);
		const daily = days.get(day) ?? emptyTotals();
		addUsage(daily, runUsage, true);
		days.set(day, daily);

		const attributed = emptyNumericUsage();
		for (const item of attemptUsage) {
			const candidate = item.event.summary.candidate;
			addModelUsage(models, candidate.provider, candidate.modelId, key, item.usage);
			addNumericUsage(attributed, item.usage);
		}
		const remainder: NumericUsage = {
			inputTokens: Math.max(0, runUsage.inputTokens - attributed.inputTokens),
			outputTokens: Math.max(0, runUsage.outputTokens - attributed.outputTokens),
			totalTokens: Math.max(0, runUsage.totalTokens - attributed.totalTokens),
			costUsd: Math.max(0, runUsage.costUsd - attributed.costUsd),
		};
		if (attemptUsage.length === 0 || hasUsage(remainder)) {
			const fallback = terminalModel(terminal);
			addModelUsage(models, fallback.provider, fallback.modelId, key, remainder);
		}
	}

	return {
		totals,
		bySession: [...sessions]
			.map(([sessionId, usage]) => ({ sessionId, ...usage }))
			.sort((left, right) => {
				const usage = compareUsageRows(left, right);
				return usage === 0 ? left.sessionId.localeCompare(right.sessionId) : usage;
			}),
		byModel: [...models.values()]
			.map((item) => ({
				provider: item.provider,
				modelId: item.modelId,
				...item.totals,
				runCount: item.runKeys.size,
			}))
			.sort(compareModelRows),
		byDay: [...days]
			.map(([day, usage]) => ({ day, ...usage }))
			.sort((left, right) => right.day.localeCompare(left.day)),
		warningCount,
	};
}

async function loadUsageEvents(
	client: WebUsageAuditClient,
): Promise<{ readonly events: ReadonlyArray<AuditEvent>; readonly warningCount: number }> {
	const events: AuditEvent[] = [];
	const warnings = new Set<string>();
	const cursors = new Set<string>();
	let cursor: string | undefined;
	do {
		const result = await client.auditQuery({
			scope: "session-directory",
			types: USAGE_EVENT_TYPES,
			limit: AUDIT_PAGE_LIMIT,
			...(cursor === undefined ? {} : { cursor }),
		});
		events.push(...result.events);
		for (const warning of result.warnings) warnings.add(JSON.stringify(warning));
		cursor = result.nextCursor;
		if (cursor !== undefined) {
			if (cursors.has(cursor)) throw new Error("Audit query repeated a pagination cursor");
			cursors.add(cursor);
		}
	} while (cursor !== undefined);
	return { events, warningCount: warnings.size };
}

function isTerminalEvent(event: AuditEvent): event is TerminalAuditEvent {
	return (TERMINAL_EVENT_TYPES as ReadonlyArray<string>).includes(event.type);
}

function compareAuditEvents(left: AuditEvent, right: AuditEvent): number {
	const timestamp = left.recordedAt.localeCompare(right.recordedAt);
	return timestamp === 0 ? left.eventId.localeCompare(right.eventId) : timestamp;
}

function runKey(sessionId: string, runId: string): string {
	return `${sessionId}\u0000${runId}`;
}

function emptyTotals(): MutableUsageTotals {
	return { runCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

function emptyNumericUsage(): NumericUsage {
	return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

function addUsage(target: MutableUsageTotals, usage: NumericUsage, countRun: boolean): void {
	if (countRun) target.runCount++;
	target.inputTokens += usage.inputTokens;
	target.outputTokens += usage.outputTokens;
	target.totalTokens += usage.totalTokens;
	target.costUsd += usage.costUsd;
}

function addNumericUsage(target: NumericUsage, usage: NumericUsage): void {
	target.inputTokens += usage.inputTokens;
	target.outputTokens += usage.outputTokens;
	target.totalTokens += usage.totalTokens;
	target.costUsd += usage.costUsd;
}

function modelAttemptUsage(event: ModelAttemptAuditEvent): NumericUsage | undefined {
	const usage = event.summary.usage;
	if (usage === undefined) return undefined;
	return {
		inputTokens: usage.inputTokens ?? usage.input ?? 0,
		outputTokens: usage.outputTokens ?? usage.output ?? 0,
		totalTokens: usage.totalTokens ?? usage.total ?? 0,
		costUsd: usage.costUsd ?? usage.cost ?? 0,
	};
}

function terminalModel(event: TerminalAuditEvent): { readonly provider: string; readonly modelId: string } {
	const finalModel = event.summary.finalModel;
	if (finalModel !== undefined) {
		return { provider: finalModel.provider, modelId: finalModel.modelId ?? finalModel.id ?? "unknown" };
	}
	const model = event.summary.model;
	return model === undefined
		? { provider: "unknown", modelId: "unknown" }
		: { provider: model.provider, modelId: model.id };
}

function addModelUsage(
	models: Map<string, ModelAccumulator>,
	provider: string,
	modelId: string,
	run: string,
	usage: NumericUsage,
): void {
	const key = `${provider}\u0000${modelId}`;
	const accumulator = models.get(key) ?? {
		provider,
		modelId,
		totals: emptyTotals(),
		runKeys: new Set<string>(),
	};
	addUsage(accumulator.totals, usage, false);
	accumulator.runKeys.add(run);
	models.set(key, accumulator);
}

function hasUsage(usage: NumericUsage): boolean {
	return (
		usage.inputTokens !== 0 || usage.outputTokens !== 0 || usage.totalTokens !== 0 || usage.costUsd !== 0
	);
}

function compareUsageRows(
	left: WebSessionUsage | WebModelUsage,
	right: WebSessionUsage | WebModelUsage,
): number {
	return right.totalTokens - left.totalTokens;
}

function compareModelRows(left: WebModelUsage, right: WebModelUsage): number {
	const usage = compareUsageRows(left, right);
	return usage === 0
		? `${left.provider}/${left.modelId}`.localeCompare(`${right.provider}/${right.modelId}`)
		: usage;
}
