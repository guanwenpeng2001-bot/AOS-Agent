import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTypedSpanStarter, NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@aos-agent/telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderAgentTelemetrySchemaMarkdown } from "../../scripts/generate-telemetry-docs.ts";
import {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startAiSpan,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("agent telemetry schemas", () => {
	it("serializes both schemas and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		expect(AGENT_TELEMETRY_SCHEMAS).toEqual([AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]);
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"aos.harness.run",
			"aos.harness.compaction",
			"aos.harness.navigation",
			"aos.harness.checkpoint",
			"aos.harness.turn",
			"aos.harness.step",
			"aos.harness.tool",
			"aos.harness.hook",
			"aos.harness.sleep",
			"aos.harness.event_handler",
			"aos.session.write",
		]);
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(renderAgentTelemetrySchemaMarkdown());
	});

	it("starts AI-request and harness spans through one composed typed starter", async () => {
		const startSpan = createTypedSpanStarter(NOOP_TELEMETRY_CONTEXT, AGENT_TELEMETRY_SCHEMAS);
		await startSpan(
			"aos.harness.step",
			{
				"pi.lane.name": "main",
				"pi.operation.id": "operation",
				"aos.step.kind": "assistant",
				"aos.step.attempt": 1,
			},
			async (stepSpan, startChildSpan) => {
				stepSpan.setAttributes({ "aos.step.outcome": "succeeded" });
				await startChildSpan(
					"aos.ai.request",
					{
						"aos.ai.operation": "stream",
						"aos.ai.provider": "provider",
						"aos.ai.model": "model",
						"aos.ai.api": "api",
						"aos.ai.streaming": true,
					},
					(requestSpan) => {
						requestSpan.setAttributes({ "aos.ai.response.stop_reason": "stop" });
					},
				);
			},
		);
	});

	it("infers exact AI start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"aos.ai.request">;
		type End = AiSpanEndAttributes<"aos.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"aos.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"aos.ai.provider": string;
			"aos.ai.model": string;
			"aos.ai.api": string;
			"aos.ai.streaming": boolean;
			"aos.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["aos.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startAiSpan(
			telemetryContext,
			"aos.ai.request",
			{
				"aos.ai.operation": "stream",
				"aos.ai.provider": "provider",
				"aos.ai.model": "model",
				"aos.ai.api": "api",
				"aos.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "aos.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error aos.ai.request declares no span events
				span.addEvent("chunk");
			},
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"aos.ai.operation": "stream",
				"aos.ai.provider": "provider",
				"aos.ai.model": "model",
				"aos.ai.api": "api",
				"aos.ai.streaming": true,
				"aos.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan(telemetryContext, "aos.ai.request", extraAttributes, () => {});
			// @ts-expect-error missing required start attributes
			void startAiSpan(telemetryContext, "aos.ai.request", { "aos.ai.operation": "stream" }, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers per-span harness literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"aos.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"aos.harness.run">;
		expectTypeOf<RunStart["pi.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["pi.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startHarnessSpan(
			telemetryContext,
			"aos.harness.run",
			{
				"aos.session.id": "session",
				"pi.lane.name": "main",
				"pi.operation.id": "operation",
				"pi.operation.kind": "run",
				"pi.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "pi.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"aos.session.id": "session",
				"pi.lane.name": "main",
				"pi.operation.id": "operation",
				"pi.operation.kind": "run",
				"pi.operation.recovery": false,
				"pi.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan(telemetryContext, "aos.harness.run", extraRunAttributes, () => {});
			void startHarnessSpan(
				telemetryContext,
				"aos.harness.checkpoint",
				{
					"pi.lane.name": "main",
					"pi.operation.id": "operation",
					"pi.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "pi.unknown": true });
				},
			);
			void startHarnessSpan(
				telemetryContext,
				"aos.harness.run",
				{
					"aos.session.id": "session",
					"pi.lane.name": "main",
					"pi.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"pi.operation.kind": "navigation",
					"pi.operation.recovery": false,
				},
				() => {},
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan(telemetryContext, "aos.harness.run", {}, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
