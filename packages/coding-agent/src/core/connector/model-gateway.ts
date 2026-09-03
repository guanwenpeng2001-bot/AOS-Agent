import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
	AssistantMessage,
	Api,
	Context,
	Credential,
	ImageContent,
	Message,
	Model,
	ModelsApiStreamOptions,
	ModelsSimpleStreamOptions,
	TextContent,
	ThinkingLevel,
	Tool,
	ToolCall,
} from "@aos-agent/ai";
import type { LocalCredentialVault } from "../policy/credential-vault.ts";
import {
	isTaskCredentialTargetRenewRequest,
	serializeTaskCredentialProviderReceipt,
	serializeTaskCredentialTargetCapabilities,
	type TaskCredentialProviderReceipt,
	type TaskCredentialReferenceProjectRequest,
	type TaskCredentialReferenceTarget,
	type TaskCredentialTargetCapabilitiesRequest,
	type TaskCredentialTargetRenewRequest,
	type TaskCredentialTargetRevokeRequest,
} from "../policy/task-credential-provider.ts";
import {
	serializeTaskCredentialDeliveryReceipt,
	TASK_CREDENTIAL_SCHEMA_VERSION,
	type TaskCredentialDeliveryReceipt,
} from "../policy/task-credential-lease.ts";
import type { ModelRuntime } from "../runtime/model-runtime.ts";
import type { ExternalResolvedModelProjection } from "./model-projection.ts";
import { validateOperationWorkerLeaseProjection, type SafeLeaseProjection } from "../worker/protocol.ts";

const MAX_GATEWAY_REQUEST_BYTES = 1024 * 1024;
const MAX_GATEWAY_MESSAGES = 256;
const MAX_GATEWAY_CONTENT_BLOCKS = 512;
const MAX_GATEWAY_TOOLS = 128;
const MAX_GATEWAY_ACTIVE_REQUESTS = 64;
const MAX_GATEWAY_FIELD_BYTES = 256 * 1024;
const MAX_GATEWAY_IDENTITY_BYTES = 512;
const MAX_GATEWAY_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_GATEWAY_BODY_READ_MS = 30_000;

export interface ExternalModelGatewayCapability {
	readonly schemaVersion: 1;
	readonly endpoint: string;
	readonly authorization: string;
	readonly leaseId: string;
	readonly modelBindingDigest: string;
	readonly expiresAt: string;
}

interface ActiveGatewayCapability {
	readonly capability: ExternalModelGatewayCapability;
	readonly projection: ExternalResolvedModelProjection;
	readonly references: Readonly<Record<string, string>>;
	readonly serviceTier?: GatewayServiceTier;
	expiresAtMs: number;
}

interface ActiveGatewayReference {
	readonly grantId: string;
	readonly bindingId: string;
	readonly references: Readonly<Record<string, string>>;
}

interface ActiveGatewayRequest {
	readonly authorization: string;
	readonly leaseId: string;
	readonly cancellation: AbortController;
	readonly settled: Promise<void>;
	readonly settle: () => void;
	expiryTimer?: ReturnType<typeof setTimeout>;
}

interface PendingGatewayRevocation {
	readonly grantId: string;
	readonly bindingId: string;
	readonly targetId?: string;
}

type GatewayServiceTier = NonNullable<ModelsApiStreamOptions<"openai-responses">["serviceTier"]>;

const GATEWAY_SERVICE_TIERS = Object.freeze([
	"auto",
	"default",
	"flex",
	"scale",
	"priority",
] as const satisfies readonly GatewayServiceTier[]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type GatewayProtocol = "anthropic" | "openai";

interface ParsedGatewayRequest {
	readonly protocol: GatewayProtocol;
	readonly context: Context;
	readonly stream: boolean;
	readonly maxTokens?: number;
}

class GatewayRequestError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "GatewayRequestError";
		this.status = status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxBytes = MAX_GATEWAY_FIELD_BYTES): value is string {
	return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function requiredString(value: unknown, name: string): string {
	if (!boundedString(value) || value.length === 0 || value.includes("\u0000")) {
		throw new GatewayRequestError(400, `${name} is invalid`);
	}
	return value;
}

function requiredIdentity(value: unknown, name: string): string {
	if (!boundedString(value, MAX_GATEWAY_IDENTITY_BYTES) || value.length === 0) {
		throw new GatewayRequestError(400, `${name} is invalid`);
	}
	const identity = value;
	if (/[\u0000-\u001f\u007f]/u.test(identity)) throw new GatewayRequestError(400, `${name} is invalid`);
	return identity;
}

function textValue(value: unknown, name: string): string {
	if (!boundedString(value) || value.includes("\u0000")) throw new GatewayRequestError(400, `${name} is invalid`);
	return value;
}

function requestArray(value: unknown, name: string, limit: number): readonly unknown[] {
	if (!Array.isArray(value) || value.length > limit) {
		throw new GatewayRequestError(400, `${name} is invalid`);
	}
	return value;
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
	if (!isRecord(value)) throw new GatewayRequestError(400, `${name} is invalid`);
	return value;
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function modelGatewayServiceTier(model: Model<Api>, serviceTier: string): GatewayServiceTier | null | undefined {
	if (serviceTier === "none") return undefined;
	const supportedApi =
		(model.provider === "openai" && model.api === "openai-responses") ||
		(model.provider === "openai-codex" && model.api === "openai-codex-responses");
	return supportedApi && GATEWAY_SERVICE_TIERS.includes(serviceTier as GatewayServiceTier)
		? serviceTier as GatewayServiceTier
		: null;
}

function assistantHistory(
	content: AssistantMessage["content"],
	model: Model<Api>,
	projection: ExternalResolvedModelProjection,
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: projection.provider,
		model: projection.model,
		usage: zeroUsage(),
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
	};
}

function base64Image(source: unknown): ImageContent {
	const record = jsonObject(source, "image source");
	if (record.type !== "base64") throw new GatewayRequestError(400, "image source is unsupported");
	const mimeType = requiredIdentity(record.media_type, "image media type");
	const data = requiredString(record.data, "image data");
	return { type: "image", mimeType, data };
}

function dataUrlImage(value: unknown): ImageContent {
	const source = requiredString(value, "image URL");
	const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(source);
	if (match === null) throw new GatewayRequestError(400, "only inline base64 images are supported");
	return { type: "image", mimeType: match[1]!, data: match[2]! };
}

function toolDefinition(name: unknown, description: unknown, parameters: unknown): Tool {
	const schema = jsonObject(parameters, "tool parameters");
	return {
		name: requiredIdentity(name, "tool name"),
		description: description === undefined || description === null ? "" : textValue(description, "tool description"),
		parameters: schema as Tool["parameters"],
	};
}

function parseAnthropicTools(value: unknown): Tool[] | undefined {
	if (value === undefined) return undefined;
	return requestArray(value, "tools", MAX_GATEWAY_TOOLS).map((candidate) => {
		const tool = jsonObject(candidate, "tool");
		return toolDefinition(tool.name, tool.description, tool.input_schema);
	});
}

function parseAnthropicSystem(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (boundedString(value)) return value;
	const parts = requestArray(value, "system", MAX_GATEWAY_CONTENT_BLOCKS).map((candidate) => {
		const block = jsonObject(candidate, "system content");
		if (block.type !== "text") throw new GatewayRequestError(400, "system content is unsupported");
		return textValue(block.text, "system text");
	});
	return parts.join("\n");
}

function parseToolResultContent(value: unknown): Array<TextContent | ImageContent> {
	if (boundedString(value)) return [{ type: "text", text: value }];
	return requestArray(value, "tool result content", MAX_GATEWAY_CONTENT_BLOCKS).map((candidate) => {
		const block = jsonObject(candidate, "tool result content block");
		if (block.type === "text") return { type: "text", text: textValue(block.text, "tool result text") };
		if (block.type === "image") return base64Image(block.source);
		throw new GatewayRequestError(400, "tool result content is unsupported");
	});
}

function parseAnthropicRequest(
	value: unknown,
	model: Model<Api>,
	projection: ExternalResolvedModelProjection,
	timestamp: number,
): ParsedGatewayRequest {
	const request = jsonObject(value, "request");
	if (request.model !== projection.model) throw new GatewayRequestError(400, "request model does not match capability");
	if (!Number.isSafeInteger(request.max_tokens) || (request.max_tokens as number) <= 0) {
		throw new GatewayRequestError(400, "max_tokens is invalid");
	}
	if (request.stream !== undefined && typeof request.stream !== "boolean") {
		throw new GatewayRequestError(400, "stream is invalid");
	}
	const outputConfig = request.output_config === undefined ? undefined : jsonObject(request.output_config, "output_config");
	if (outputConfig?.effort !== undefined && outputConfig.effort !== projection.effort) {
		throw new GatewayRequestError(400, "request effort does not match capability");
	}
	if (request.service_tier !== undefined && request.service_tier !== projection.serviceTier) {
		throw new GatewayRequestError(400, "request service tier does not match capability");
	}
	const callNames = new Map<string, string>();
	const messages: Message[] = [];
	for (const candidate of requestArray(request.messages, "messages", MAX_GATEWAY_MESSAGES)) {
		const message = jsonObject(candidate, "message");
		if (message.role !== "user" && message.role !== "assistant") {
			throw new GatewayRequestError(400, "message role is invalid");
		}
		const content = boundedString(message.content)
			? [{ type: "text" as const, text: message.content }]
			: requestArray(message.content, "message content", MAX_GATEWAY_CONTENT_BLOCKS);
		if (message.role === "assistant") {
			const assistantContent: AssistantMessage["content"] = [];
			for (const rawBlock of content) {
				if (typeof rawBlock === "string") {
					assistantContent.push({ type: "text", text: rawBlock });
					continue;
				}
				const block = jsonObject(rawBlock, "assistant content block");
				if (block.type === "text") {
					assistantContent.push({ type: "text", text: textValue(block.text, "assistant text") });
				} else if (block.type === "thinking") {
					if (!boundedString(block.signature) || block.signature.length === 0) {
						throw new GatewayRequestError(400, "assistant thinking signature is required");
					}
					assistantContent.push({
						type: "thinking",
						thinking: requiredString(block.thinking, "assistant thinking"),
						thinkingSignature: block.signature,
					});
				} else if (block.type === "redacted_thinking") {
					assistantContent.push({
						type: "thinking",
						thinking: "",
						thinkingSignature: requiredString(block.data, "assistant redacted thinking"),
						redacted: true,
					});
				} else if (block.type === "tool_use") {
					const id = requiredIdentity(block.id, "tool use id");
					const name = requiredIdentity(block.name, "tool use name");
					if (callNames.has(id)) throw new GatewayRequestError(400, "tool use id is duplicated");
					const toolCall: ToolCall = { type: "toolCall", id, name, arguments: jsonObject(block.input, "tool input") };
					callNames.set(id, name);
					assistantContent.push(toolCall);
				} else {
					throw new GatewayRequestError(400, "assistant content is unsupported");
				}
			}
			messages.push(assistantHistory(assistantContent, model, projection, timestamp));
			continue;
		}
		let userContent: Array<TextContent | ImageContent> = [];
		const flushUser = (): void => {
			if (userContent.length === 0) return;
			messages.push({ role: "user", content: userContent, timestamp });
			userContent = [];
		};
		for (const rawBlock of content) {
			if (typeof rawBlock === "string") {
				userContent.push({ type: "text", text: rawBlock });
				continue;
			}
			const block = jsonObject(rawBlock, "user content block");
			if (block.type === "text") {
				userContent.push({ type: "text", text: textValue(block.text, "user text") });
			} else if (block.type === "image") {
				userContent.push(base64Image(block.source));
			} else if (block.type === "tool_result") {
				flushUser();
				const toolCallId = requiredIdentity(block.tool_use_id, "tool result id");
				const toolName = callNames.get(toolCallId);
				if (toolName === undefined) throw new GatewayRequestError(400, "tool result has no matching tool use");
				messages.push({
					role: "toolResult",
					toolCallId,
					toolName,
					content: parseToolResultContent(block.content ?? ""),
					isError: block.is_error === true,
					timestamp,
				});
			} else {
				throw new GatewayRequestError(400, "user content is unsupported");
			}
		}
		flushUser();
	}
	if (messages.length === 0) throw new GatewayRequestError(400, "messages are empty");
	const tools = parseAnthropicTools(request.tools);
	const systemPrompt = parseAnthropicSystem(request.system);
	return {
		protocol: "anthropic",
		context: {
			...(systemPrompt === undefined ? {} : { systemPrompt }),
			messages,
			...(tools === undefined ? {} : { tools }),
		},
		stream: request.stream === true,
		maxTokens: request.max_tokens as number,
	};
}

function parseOpenAIContent(value: unknown, output: true): TextContent[];
function parseOpenAIContent(value: unknown, output: false): Array<TextContent | ImageContent>;
function parseOpenAIContent(value: unknown, output: boolean): Array<TextContent | ImageContent> {
	if (boundedString(value)) return [{ type: "text", text: value }];
	return requestArray(value, "message content", MAX_GATEWAY_CONTENT_BLOCKS).map((candidate) => {
		const block = jsonObject(candidate, "message content block");
		if (block.type === "input_text" || block.type === "output_text" || block.type === "text") {
			return { type: "text", text: textValue(block.text, "message text") };
		}
		if (!output && block.type === "input_image") return dataUrlImage(block.image_url);
		throw new GatewayRequestError(400, "message content is unsupported");
	});
}

function parseOpenAITools(value: unknown): Tool[] | undefined {
	if (value === undefined) return undefined;
	return requestArray(value, "tools", MAX_GATEWAY_TOOLS).map((candidate) => {
		const tool = jsonObject(candidate, "tool");
		if (tool.type !== "function") throw new GatewayRequestError(400, "only function tools are supported");
		return toolDefinition(tool.name, tool.description, tool.parameters);
	});
}

function parseOpenAIReasoningItem(value: unknown): {
	readonly item: Record<string, unknown>;
	readonly thinking: string;
} {
	const item = jsonObject(value, "reasoning item");
	if (item.type !== "reasoning") throw new GatewayRequestError(400, "reasoning item is invalid");
	requiredIdentity(item.id, "reasoning item id");
	const summary = requestArray(item.summary ?? [], "reasoning summary", MAX_GATEWAY_CONTENT_BLOCKS)
		.map((part) => jsonObject(part, "reasoning summary part"));
	const summaryText = summary.map((part) => textValue(part.text, "reasoning summary text")).join("\n");
	let contentText = "";
	if (item.content !== undefined && item.content !== null) {
		contentText = requestArray(item.content, "reasoning content", MAX_GATEWAY_CONTENT_BLOCKS)
			.map((part) => jsonObject(part, "reasoning content part"))
			.map((part) => textValue(part.text, "reasoning content text"))
			.join("\n");
	}
	if (item.encrypted_content !== undefined && item.encrypted_content !== null && !boundedString(item.encrypted_content)) {
		throw new GatewayRequestError(400, "reasoning encrypted content is invalid");
	}
	const serialized = JSON.stringify(item);
	if (Buffer.byteLength(serialized, "utf8") > MAX_GATEWAY_FIELD_BYTES) {
		throw new GatewayRequestError(400, "reasoning item is too large");
	}
	return { item, thinking: summaryText || contentText };
}

function replayOpenAIReasoningItem(signature: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(signature);
	} catch {
		throw new Error("Model runtime reasoning signature is invalid");
	}
	try {
		return parseOpenAIReasoningItem(value).item;
	} catch {
		throw new Error("Model runtime reasoning signature is invalid");
	}
}

function parseOpenAIRequest(
	value: unknown,
	model: Model<Api>,
	projection: ExternalResolvedModelProjection,
	timestamp: number,
): ParsedGatewayRequest {
	const request = jsonObject(value, "request");
	if (request.model !== projection.model) throw new GatewayRequestError(400, "request model does not match capability");
	if (request.stream !== undefined && typeof request.stream !== "boolean") {
		throw new GatewayRequestError(400, "stream is invalid");
	}
	if (
		request.max_output_tokens !== undefined &&
		request.max_output_tokens !== null &&
		(!Number.isSafeInteger(request.max_output_tokens) || (request.max_output_tokens as number) <= 0)
	) {
		throw new GatewayRequestError(400, "max_output_tokens is invalid");
	}
	const reasoning = request.reasoning === undefined || request.reasoning === null
		? undefined
		: jsonObject(request.reasoning, "reasoning");
	if (reasoning?.effort !== undefined && reasoning.effort !== projection.effort) {
		throw new GatewayRequestError(400, "request effort does not match capability");
	}
	if (request.service_tier !== undefined && request.service_tier !== null && request.service_tier !== projection.serviceTier) {
		throw new GatewayRequestError(400, "request service tier does not match capability");
	}
	const systemParts: string[] = [];
	if (request.instructions !== undefined && request.instructions !== null) {
		systemParts.push(textValue(request.instructions, "instructions"));
	}
	const messages: Message[] = [];
	const callNames = new Map<string, string>();
	const input = boundedString(request.input) ? [request.input] : requestArray(request.input, "input", MAX_GATEWAY_MESSAGES);
	for (const candidate of input) {
		if (typeof candidate === "string") {
			messages.push({ role: "user", content: candidate, timestamp });
			continue;
		}
		const item = jsonObject(candidate, "input item");
		const type = item.type ?? "message";
		if (type === "message") {
			if (item.role === "system" || item.role === "developer") {
				systemParts.push(...parseOpenAIContent(item.content, false).flatMap((block) =>
					block.type === "text" ? [block.text] : []));
				continue;
			}
			if (item.role !== "user" && item.role !== "assistant") {
				throw new GatewayRequestError(400, "message role is invalid");
			}
			messages.push(item.role === "user"
				? { role: "user", content: parseOpenAIContent(item.content, false), timestamp }
				: assistantHistory(parseOpenAIContent(item.content, true), model, projection, timestamp));
		} else if (type === "function_call") {
			const id = requiredIdentity(item.call_id ?? item.id, "function call id");
			const name = requiredIdentity(item.name, "function call name");
			if (callNames.has(id)) throw new GatewayRequestError(400, "function call id is duplicated");
			let argumentsValue: unknown;
			try {
				argumentsValue = JSON.parse(requiredString(item.arguments, "function call arguments"));
			} catch {
				throw new GatewayRequestError(400, "function call arguments are invalid");
			}
			callNames.set(id, name);
			messages.push(assistantHistory(
				[{ type: "toolCall", id, name, arguments: jsonObject(argumentsValue, "function call arguments") }],
				model,
				projection,
				timestamp,
			));
		} else if (type === "function_call_output") {
			const toolCallId = requiredIdentity(item.call_id, "function output id");
			const toolName = callNames.get(toolCallId);
			if (toolName === undefined) throw new GatewayRequestError(400, "function output has no matching call");
			messages.push({
				role: "toolResult",
				toolCallId,
				toolName,
				content: parseOpenAIContent(item.output, false),
				isError: false,
				timestamp,
			});
		} else if (type === "reasoning") {
			const reasoningItem = parseOpenAIReasoningItem(item);
			messages.push(assistantHistory([{
				type: "thinking",
				thinking: reasoningItem.thinking,
				thinkingSignature: JSON.stringify(reasoningItem.item),
			}], model, projection, timestamp));
		} else {
			throw new GatewayRequestError(400, "input item is unsupported");
		}
	}
	if (messages.length === 0) throw new GatewayRequestError(400, "input is empty");
	const tools = parseOpenAITools(request.tools);
	return {
		protocol: "openai",
		context: {
			...(systemParts.length === 0 ? {} : { systemPrompt: systemParts.join("\n") }),
			messages,
			...(tools === undefined ? {} : { tools }),
		},
		stream: request.stream === true,
		...(typeof request.max_output_tokens === "number" ? { maxTokens: request.max_output_tokens } : {}),
	};
}

function assistantText(message: AssistantMessage): string {
	return message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("");
}

function validateAssistantResult(
	result: AssistantMessage,
	projection: ExternalResolvedModelProjection,
): void {
	if (
		result.role !== "assistant" ||
		result.provider !== projection.provider ||
		result.model !== projection.model ||
		(result.responseModel !== undefined && result.responseModel !== projection.model) ||
		(result.stopReason !== "stop" && result.stopReason !== "length" && result.stopReason !== "toolUse") ||
		result.content.length > MAX_GATEWAY_CONTENT_BLOCKS ||
		Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_GATEWAY_RESPONSE_BYTES
	) {
		throw new Error("Model runtime result does not match the gateway capability");
	}
	for (const block of result.content) {
		if (block.type === "text" && !boundedString(block.text)) throw new Error("Model runtime text is invalid");
		if (
			block.type === "thinking" &&
			(!boundedString(block.thinking) ||
				(block.thinkingSignature !== undefined && !boundedString(block.thinkingSignature)) ||
				(block.redacted === true && (block.thinkingSignature === undefined || block.thinkingSignature.length === 0)))
		) throw new Error("Model runtime thinking is invalid");
		if (
			block.type === "toolCall" &&
			(!boundedString(block.id) || block.id.length === 0 ||
				!boundedString(block.name) || block.name.length === 0 || !isRecord(block.arguments))
		) throw new Error("Model runtime tool call is invalid");
	}
}

function anthropicStopReason(result: AssistantMessage): "end_turn" | "max_tokens" | "tool_use" {
	if (result.stopReason === "length") return "max_tokens";
	if (result.stopReason === "toolUse") return "tool_use";
	return "end_turn";
}

function anthropicContent(result: AssistantMessage): ReadonlyArray<Record<string, unknown>> {
	const content: Record<string, unknown>[] = [];
	for (const block of result.content) {
		if (block.type === "text") content.push({ type: "text", text: block.text });
		else if (block.type === "thinking") {
			if (block.thinkingSignature === undefined) throw new Error("Anthropic thinking signature is required");
			content.push(block.redacted === true
				? { type: "redacted_thinking", data: block.thinkingSignature }
				: { type: "thinking", thinking: block.thinking, signature: block.thinkingSignature });
		}
		else if (block.type === "toolCall") {
			content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
		}
	}
	return content;
}

function anthropicResponse(result: AssistantMessage, projection: ExternalResolvedModelProjection) {
	return {
		id: result.responseId ?? `msg_aos_${randomUUID().replaceAll("-", "")}`,
		type: "message",
		role: "assistant",
		model: projection.model,
		content: anthropicContent(result),
		stop_reason: anthropicStopReason(result),
		stop_sequence: null,
		stop_details: null,
		container: null,
		usage: {
			input_tokens: result.usage.input,
			output_tokens: result.usage.output,
			cache_read_input_tokens: result.usage.cacheRead,
			cache_creation_input_tokens: result.usage.cacheWrite,
		},
	};
}

function openAIOutput(result: AssistantMessage): ReadonlyArray<Record<string, unknown>> {
	const output: Record<string, unknown>[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			output.push({
				id: `msg_aos_${randomUUID().replaceAll("-", "")}`,
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: block.text, annotations: [], logprobs: [] }],
			});
		} else if (block.type === "thinking") {
			if (block.redacted === true || block.thinkingSignature === undefined) {
				throw new Error("OpenAI reasoning replay signature is invalid");
			}
			output.push(replayOpenAIReasoningItem(block.thinkingSignature));
		} else if (block.type === "toolCall") {
			output.push({
				id: `fc_aos_${randomUUID().replaceAll("-", "")}`,
				type: "function_call",
				status: "completed",
				call_id: block.id,
				name: block.name,
				arguments: JSON.stringify(block.arguments),
			});
		}
	}
	return output;
}

function openAIResponse(result: AssistantMessage, projection: ExternalResolvedModelProjection) {
	const createdAt = Math.floor(result.timestamp / 1000);
	return {
		id: result.responseId ?? `resp_aos_${randomUUID().replaceAll("-", "")}`,
		object: "response",
		created_at: createdAt,
		completed_at: createdAt,
		status: "completed",
		error: null,
		incomplete_details: null,
		instructions: null,
		metadata: null,
		model: projection.model,
		output: openAIOutput(result),
		output_text: assistantText(result),
		parallel_tool_calls: true,
		temperature: null,
		tool_choice: "auto",
		tools: [],
		top_p: null,
		max_output_tokens: null,
		previous_response_id: null,
		reasoning: { effort: projection.effort, summary: null },
		service_tier: projection.serviceTier === "none" ? null : projection.serviceTier,
		store: false,
		text: { format: { type: "text" } },
		truncation: "disabled",
		usage: {
			input_tokens: result.usage.input,
			input_tokens_details: { cached_tokens: result.usage.cacheRead },
			output_tokens: result.usage.output,
			output_tokens_details: { reasoning_tokens: result.usage.reasoning ?? 0 },
			total_tokens: result.usage.totalTokens,
		},
	};
}

function writeSse(response: ServerResponse, event: string, value: unknown): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function writeAnthropicStream(
	response: ServerResponse,
	result: AssistantMessage,
	projection: ExternalResolvedModelProjection,
): void {
	const message = anthropicResponse(result, projection);
	writeSse(response, "message_start", {
		type: "message_start",
		message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } },
	});
	for (const [index, block] of message.content.entries()) {
		const start = block.type === "text"
			? { type: "text", text: "" }
			: block.type === "tool_use"
				? { ...block, input: {} }
				: block.type === "thinking"
					? { type: "thinking", thinking: "", signature: "" }
					: block;
		writeSse(response, "content_block_start", { type: "content_block_start", index, content_block: start });
		if (block.type === "text") {
			writeSse(response, "content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "text_delta", text: block.text },
			});
		} else if (block.type === "tool_use") {
			writeSse(response, "content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
			});
		} else if (block.type === "thinking") {
			writeSse(response, "content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "thinking_delta", thinking: block.thinking },
			});
			writeSse(response, "content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "signature_delta", signature: block.signature },
			});
		}
		writeSse(response, "content_block_stop", { type: "content_block_stop", index });
	}
	writeSse(response, "message_delta", {
		type: "message_delta",
		delta: { container: null, stop_details: null, stop_reason: message.stop_reason, stop_sequence: null },
		usage: { output_tokens: result.usage.output },
	});
	writeSse(response, "message_stop", { type: "message_stop" });
	response.end();
}

function writeOpenAIStream(
	response: ServerResponse,
	result: AssistantMessage,
	projection: ExternalResolvedModelProjection,
): void {
	const completed = openAIResponse(result, projection);
	let sequence = 0;
	const emit = (type: string, value: Record<string, unknown>): void => {
		writeSse(response, type, { type, sequence_number: sequence, ...value });
		sequence += 1;
	};
	const inProgress = { ...completed, completed_at: null, status: "in_progress", output: [], output_text: "" };
	emit("response.created", { response: inProgress });
	emit("response.in_progress", { response: inProgress });
	for (const [outputIndex, item] of completed.output.entries()) {
		const addedItem = item.type === "message"
			? { ...item, status: "in_progress", content: [] }
			: item.type === "function_call"
				? { ...item, status: "in_progress", arguments: "" }
				: { ...item, status: "in_progress" };
		emit("response.output_item.added", { output_index: outputIndex, item: addedItem });
		if (item.type === "message") {
			const part = (item.content as ReadonlyArray<Record<string, unknown>>)[0]!;
			emit("response.content_part.added", { item_id: item.id, output_index: outputIndex, content_index: 0, part: { ...part, text: "" } });
			emit("response.output_text.delta", { item_id: item.id, output_index: outputIndex, content_index: 0, delta: part.text, logprobs: [] });
			emit("response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text, logprobs: [] });
			emit("response.content_part.done", { item_id: item.id, output_index: outputIndex, content_index: 0, part });
		} else if (item.type === "function_call") {
			emit("response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, delta: item.arguments });
			emit("response.function_call_arguments.done", { item_id: item.id, output_index: outputIndex, arguments: item.arguments });
		}
		emit("response.output_item.done", { output_index: outputIndex, item });
	}
	emit("response.completed", { response: completed });
	response.write("data: [DONE]\n\n");
	response.end();
}

function providerReceipt(
	request: { readonly leaseId: string; readonly grantId: string; readonly bindingId: string },
	status: "renewed" | "revoked" | "revocation_unknown",
): TaskCredentialProviderReceipt {
	return serializeTaskCredentialProviderReceipt({
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		leaseId: request.leaseId,
		grantId: request.grantId,
		bindingId: request.bindingId,
		status,
		recordedAt: new Date().toISOString(),
	});
}

/** Host-owned loopback gateway. Long-lived provider credentials never leave this class. */
export class ExternalConnectorModelGateway implements TaskCredentialReferenceTarget {
	readonly #targetId: string;
	readonly #runtime: ModelRuntime;
	readonly #vault: LocalCredentialVault;
	readonly #now: () => number;
	readonly #references = new Map<string, ActiveGatewayReference>();
	readonly #revocations = new Map<string, PendingGatewayRevocation>();
	readonly #capabilities = new Map<string, ActiveGatewayCapability>();
	readonly #requests = new Set<ActiveGatewayRequest>();
	#server: Server | undefined;
	#endpoint: string | undefined;

	constructor(options: {
		readonly targetId: string;
		readonly runtime: ModelRuntime;
		readonly vault: LocalCredentialVault;
		readonly now?: () => number;
	}) {
		this.#targetId = options.targetId;
		this.#runtime = options.runtime;
		this.#vault = options.vault;
		this.#now = options.now ?? Date.now;
	}

	getCapabilities(request: TaskCredentialTargetCapabilitiesRequest) {
		const exact = request.targetId === this.#targetId && request.targetKind === "external_connector";
		return serializeTaskCredentialTargetCapabilities({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: request.targetId,
			targetKind: request.targetKind,
			bindingId: request.bindingId,
			canReceiveShortLivedCredential: exact,
			canRenewCredential: exact,
			canRevokeCredential: exact,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		});
	}

	project(request: TaskCredentialReferenceProjectRequest): TaskCredentialDeliveryReceipt {
		const existing = this.#references.get(request.leaseId);
		const references = Object.freeze({ ...request.references });
		const succeeded =
			request.targetId === this.#targetId &&
			!this.#revocations.has(request.leaseId) &&
			Object.keys(references).length > 0 &&
			(existing === undefined ||
				(existing.grantId === request.grantId &&
					existing.bindingId === request.bindingId &&
					Object.keys(existing.references).length === Object.keys(references).length &&
					Object.entries(existing.references).every(([name, reference]) => references[name] === reference)));
		if (succeeded && existing === undefined) {
			this.#references.set(request.leaseId, Object.freeze({
				grantId: request.grantId,
				bindingId: request.bindingId,
				references,
			}));
		}
		return serializeTaskCredentialDeliveryReceipt({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: succeeded ? "succeeded" : "failed",
			recordedAt: new Date().toISOString(),
			...(request.targetId === undefined ? {} : { targetId: request.targetId }),
		});
	}

	renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt {
		const reference = this.#references.get(request.leaseId);
		if (
			!isTaskCredentialTargetRenewRequest(request) ||
			request.targetId !== this.#targetId ||
			reference === undefined ||
			this.#revocations.has(request.leaseId) ||
			reference.grantId !== request.grantId ||
			reference.bindingId !== request.bindingId
		) throw new TypeError("External model gateway lease renewal is unknown");
		const requestedAtMs = Date.parse(request.requestedAt);
		const expiresAtMs = requestedAtMs + request.requestedTtlMs;
		const activeCapabilities = [...this.#capabilities.values()]
			.filter((active) => active.capability.leaseId === request.leaseId);
		if (
			!Number.isSafeInteger(expiresAtMs) ||
			activeCapabilities.length === 0 ||
			activeCapabilities.some((active) =>
				active.expiresAtMs <= requestedAtMs || active.expiresAtMs <= this.#now())
		) throw new TypeError("External model gateway lease renewal is expired");
		for (const active of activeCapabilities) active.expiresAtMs = expiresAtMs;
		return providerReceipt(request, "renewed");
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		const reference = this.#references.get(request.leaseId);
		const pending = this.#revocations.get(request.leaseId);
		if (
			request.targetId !== this.#targetId ||
			reference === undefined ||
			reference.grantId !== request.grantId ||
			reference.bindingId !== request.bindingId ||
			(pending !== undefined &&
				(pending.grantId !== request.grantId ||
					pending.bindingId !== request.bindingId ||
					pending.targetId !== request.targetId))
		) throw new TypeError("External model gateway lease revocation is unknown");
		this.#revocations.set(request.leaseId, Object.freeze({
			grantId: request.grantId,
			bindingId: request.bindingId,
			...(request.targetId === undefined ? {} : { targetId: request.targetId }),
		}));
		for (const [authorization, active] of this.#capabilities) {
			if (active.capability.leaseId === request.leaseId) this.#capabilities.delete(authorization);
		}
		this.#abortRequests(
			(candidate) => candidate.leaseId === request.leaseId,
			new DOMException("Model gateway lease revoked", "AbortError"),
		);
		if ([...this.#requests].some((candidate) => candidate.leaseId === request.leaseId)) {
			return providerReceipt(request, "revocation_unknown");
		}
		this.#references.delete(request.leaseId);
		this.#revocations.delete(request.leaseId);
		return providerReceipt(request, "revoked");
	}

	async open(
		lease: SafeLeaseProjection,
		projection: ExternalResolvedModelProjection,
	): Promise<ExternalModelGatewayCapability | undefined> {
		if (!validateOperationWorkerLeaseProjection(lease) || Date.parse(lease.expiresAt) <= this.#now()) return undefined;
		const reference = this.#references.get(lease.leaseId);
		if (
			reference === undefined ||
			this.#revocations.has(lease.leaseId) ||
			reference.grantId !== lease.grantId ||
			reference.bindingId !== lease.bindingId ||
			reference.references[projection.provider] === undefined
		) return undefined;
		const model = this.#runtime.getModel(projection.provider, projection.model);
		if (model === undefined) return undefined;
		const serviceTier = modelGatewayServiceTier(model, projection.serviceTier);
		if (serviceTier === null) return undefined;
		await this.#listen();
		const authorization = `Bearer aos_gateway_${randomUUID().replaceAll("-", "")}`;
		const capability = Object.freeze({
			schemaVersion: 1 as const,
			endpoint: this.#endpoint!,
			authorization,
			leaseId: lease.leaseId,
			modelBindingDigest: projection.bindingDigest.value,
			expiresAt: lease.expiresAt,
		});
		this.#capabilities.set(authorization, {
			capability,
			projection,
			references: reference.references,
			...(serviceTier === undefined ? {} : { serviceTier }),
			expiresAtMs: Date.parse(lease.expiresAt),
		});
		return capability;
	}

	close(capability: ExternalModelGatewayCapability): boolean {
		const active = this.#capabilities.get(capability.authorization);
		if (
			active === undefined ||
			active.capability.endpoint !== capability.endpoint ||
			active.capability.leaseId !== capability.leaseId ||
			active.capability.modelBindingDigest !== capability.modelBindingDigest ||
			active.capability.expiresAt !== capability.expiresAt
		) return false;
		this.#capabilities.delete(capability.authorization);
		this.#abortRequests(
			(candidate) => candidate.authorization === capability.authorization,
			new DOMException("Model gateway capability closed", "AbortError"),
		);
		return true;
	}

	async dispose(): Promise<void> {
		const requests = [...this.#requests];
		this.#capabilities.clear();
		this.#references.clear();
		this.#revocations.clear();
		this.#abortRequests(
			() => true,
			new DOMException("Model gateway disposed", "AbortError"),
		);
		await Promise.all(requests.map((request) => request.settled));
		const server = this.#server;
		this.#server = undefined;
		this.#endpoint = undefined;
		if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	async #listen(): Promise<void> {
		if (this.#server !== undefined) return;
		const server = createServer((request, response) => void this.#handle(request, response));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address() as AddressInfo;
		server.unref();
		this.#server = server;
		this.#endpoint = `http://127.0.0.1:${address.port}/v1`;
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const authorization = request.headers.authorization;
		if (authorization === undefined) {
			response.writeHead(401).end();
			return;
		}
		const active = this.#capabilities.get(authorization);
		if (active === undefined) {
			response.writeHead(401).end();
			return;
		}
		if (active.expiresAtMs <= this.#now()) {
			this.#expireCapability(authorization, active);
			response.writeHead(401).end();
			return;
		}
		if (request.method !== "POST" || (request.url !== "/v1/messages" && request.url !== "/v1/responses")) {
			response.writeHead(404).end();
			return;
		}
		const reference = active.references[active.projection.provider];
		const credential = reference === undefined ? undefined : this.#vault.resolve(reference);
		if (credential === undefined) {
			response.writeHead(401).end();
			return;
		}
		if (this.#requests.size >= MAX_GATEWAY_ACTIVE_REQUESTS) {
			response.writeHead(429).end();
			return;
		}
		const cancellation = new AbortController();
		let settleRequest: () => void = () => undefined;
		const settled = new Promise<void>((resolve) => {
			settleRequest = resolve;
		});
		const trackedRequest: ActiveGatewayRequest = {
			authorization,
			leaseId: active.capability.leaseId,
			cancellation,
			settled,
			settle: settleRequest,
		};
		this.#requests.add(trackedRequest);
		this.#scheduleRequestExpiry(trackedRequest, active);
		const abort = (): void => cancellation.abort(new DOMException("Gateway request was cancelled", "AbortError"));
		const close = (): void => {
			if (!response.writableEnded) abort();
		};
		request.once("aborted", abort);
		response.once("close", close);
		try {
			const body = await this.#readBody(request, response, cancellation.signal);
			let value: unknown;
			try {
				value = JSON.parse(body);
			} catch {
				throw new GatewayRequestError(400, "request JSON is malformed");
			}
			const model = this.#runtime.getModel(active.projection.provider, active.projection.model);
			if (model === undefined) throw new GatewayRequestError(400, "capability model is unavailable");
			const parsed = request.url === "/v1/messages"
				? parseAnthropicRequest(value, model, active.projection, this.#now())
				: parseOpenAIRequest(value, model, active.projection, this.#now());
			const effort = active.projection.effort === "off"
				? undefined
				: active.projection.effort as ThinkingLevel;
			const commonOptions = {
				...this.#authOptions(credential),
				signal: cancellation.signal,
				...(parsed.maxTokens === undefined ? {} : { maxTokens: parsed.maxTokens }),
			};
			let result: AssistantMessage;
			if (active.serviceTier !== undefined && model.api === "openai-responses") {
				result = await this.#runtime.stream(
					model as Model<"openai-responses">,
					parsed.context,
					{
						...commonOptions,
						...(effort === undefined ? {} : { reasoningEffort: effort }),
						serviceTier: active.serviceTier,
					} satisfies ModelsApiStreamOptions<"openai-responses">,
				).result();
			} else if (active.serviceTier !== undefined && model.api === "openai-codex-responses") {
				result = await this.#runtime.stream(
					model as Model<"openai-codex-responses">,
					parsed.context,
					{
						...commonOptions,
						...(effort === undefined ? {} : { reasoningEffort: effort }),
						serviceTier: active.serviceTier,
					} satisfies ModelsApiStreamOptions<"openai-codex-responses">,
				).result();
			} else if (active.serviceTier === undefined) {
				result = await this.#runtime.streamSimple(model, parsed.context, {
					...commonOptions,
					...(effort === undefined ? {} : { reasoning: effort }),
				} satisfies ModelsSimpleStreamOptions).result();
			} else {
				throw new Error("Model runtime service-tier support drifted after capability admission");
			}
			validateAssistantResult(result, active.projection);
			if (parsed.stream) {
				response.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				if (parsed.protocol === "anthropic") writeAnthropicStream(response, result, active.projection);
				else writeOpenAIStream(response, result, active.projection);
			} else {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify(parsed.protocol === "anthropic"
					? anthropicResponse(result, active.projection)
					: openAIResponse(result, active.projection)));
			}
		} catch (error) {
			if (!response.destroyed) {
				if (!response.headersSent) response.writeHead(error instanceof GatewayRequestError ? error.status : 502);
				response.end();
			}
		} finally {
			request.off("aborted", abort);
			response.off("close", close);
			if (trackedRequest.expiryTimer !== undefined) clearTimeout(trackedRequest.expiryTimer);
			this.#requests.delete(trackedRequest);
			trackedRequest.settle();
		}
	}

	#abortRequests(predicate: (request: ActiveGatewayRequest) => boolean, reason: DOMException): void {
		for (const request of this.#requests) {
			if (predicate(request) && !request.cancellation.signal.aborted) request.cancellation.abort(reason);
		}
	}

	#expireCapability(authorization: string, active: ActiveGatewayCapability): void {
		if (this.#capabilities.get(authorization) === active) this.#capabilities.delete(authorization);
		this.#abortRequests(
			(request) => request.authorization === authorization,
			new DOMException("Model gateway capability expired", "AbortError"),
		);
	}

	#scheduleRequestExpiry(request: ActiveGatewayRequest, active: ActiveGatewayCapability): void {
		const schedule = (): void => {
			const remaining = active.expiresAtMs - this.#now();
			if (remaining <= 0) {
				this.#expireCapability(request.authorization, active);
				return;
			}
			request.expiryTimer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
			request.expiryTimer.unref?.();
		};
		schedule();
	}

	#authOptions(credential: Credential): { readonly apiKey?: string; readonly env?: Record<string, string> } {
		const apiKey = "key" in credential && typeof credential.key === "string" ? credential.key : undefined;
		const env = "env" in credential && credential.env !== undefined ? { ...credential.env } : undefined;
		return {
			...(apiKey === undefined ? {} : { apiKey }),
			...(env === undefined ? {} : { env }),
		};
	}

	async #readBody(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<string> {
		const chunks: Buffer[] = [];
		let bytes = 0;
		return await new Promise<string>((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => {
				clearTimeout(deadline);
				signal.removeEventListener("abort", onSignalAbort);
				request.off("data", onData);
				request.off("end", onEnd);
				request.off("error", onError);
			};
			const rejectBody = (error: Error, destroyRequest = false): void => {
				if (settled) return;
				settled = true;
				cleanup();
				if (!request.destroyed) {
					if (destroyRequest) request.destroy();
					else {
						if (!response.destroyed && !response.headersSent) response.setHeader("connection", "close");
						request.once("error", () => undefined);
						request.resume();
					}
				}
				reject(error);
			};
			const onData = (chunk: unknown): void => {
				const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
				bytes += value.byteLength;
				if (bytes > MAX_GATEWAY_REQUEST_BYTES) {
					rejectBody(new GatewayRequestError(413, "request is too large"));
					return;
				}
				chunks.push(value);
			};
			const onEnd = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(Buffer.concat(chunks, bytes).toString("utf8"));
			};
			const onError = (error: Error): void => rejectBody(error);
			const onSignalAbort = (): void => rejectBody(
				signal.reason instanceof Error
					? signal.reason
					: new DOMException("Gateway request was cancelled", "AbortError"),
				true,
			);
			const deadline = setTimeout(
				() => rejectBody(new GatewayRequestError(408, "request body timed out")),
				MAX_GATEWAY_BODY_READ_MS,
			);
			deadline.unref?.();
			request.on("data", onData);
			request.once("end", onEnd);
			request.once("error", onError);
			signal.addEventListener("abort", onSignalAbort, { once: true });
			if (signal.aborted) onSignalAbort();
		});
	}
}
