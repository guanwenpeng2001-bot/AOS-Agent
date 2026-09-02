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
	TextContent,
	ThinkingLevel,
	Tool,
	ToolCall,
} from "@aos-agent/ai";
import type { LocalCredentialVault } from "../policy/credential-vault.ts";
import {
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
}

interface ActiveGatewayReference {
	readonly grantId: string;
	readonly bindingId: string;
	readonly references: Readonly<Record<string, string>>;
}

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
					assistantContent.push({
						type: "thinking",
						thinking: requiredString(block.thinking, "assistant thinking"),
						...(boundedString(block.signature) ? { thinkingSignature: block.signature } : {}),
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
			const summary = requestArray(item.summary ?? [], "reasoning summary", MAX_GATEWAY_CONTENT_BLOCKS)
				.map((part) => jsonObject(part, "reasoning summary part"))
				.map((part) => textValue(part.text, "reasoning summary text"))
				.join("\n");
			if (summary.length > 0) {
				messages.push(assistantHistory([{
					type: "thinking",
					thinking: summary,
					...(boundedString(item.encrypted_content) ? { thinkingSignature: item.encrypted_content } : {}),
				}], model, projection, timestamp));
			}
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
		service_tier: projection.serviceTier,
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
		const start = block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} };
		writeSse(response, "content_block_start", { type: "content_block_start", index, content_block: start });
		if (block.type === "text") {
			writeSse(response, "content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "text_delta", text: block.text },
			});
		} else {
			writeSse(response, "content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
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
		emit("response.output_item.added", { output_index: outputIndex, item: item.type === "message"
			? { ...item, status: "in_progress", content: [] }
			: { ...item, status: "in_progress", arguments: "" } });
		if (item.type === "message") {
			const part = (item.content as ReadonlyArray<Record<string, unknown>>)[0]!;
			emit("response.content_part.added", { item_id: item.id, output_index: outputIndex, content_index: 0, part: { ...part, text: "" } });
			emit("response.output_text.delta", { item_id: item.id, output_index: outputIndex, content_index: 0, delta: part.text, logprobs: [] });
			emit("response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text, logprobs: [] });
			emit("response.content_part.done", { item_id: item.id, output_index: outputIndex, content_index: 0, part });
		} else {
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
	status: "renewed" | "revoked",
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
	readonly #capabilities = new Map<string, ActiveGatewayCapability>();
	readonly #requests = new Set<AbortController>();
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
			request.targetId !== this.#targetId ||
			reference === undefined ||
			reference.grantId !== request.grantId ||
			reference.bindingId !== request.bindingId
		) throw new TypeError("External model gateway lease renewal is unknown");
		return providerReceipt(request, "renewed");
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		const reference = this.#references.get(request.leaseId);
		if (
			request.targetId !== this.#targetId ||
			reference === undefined ||
			reference.grantId !== request.grantId ||
			reference.bindingId !== request.bindingId
		) throw new TypeError("External model gateway lease revocation is unknown");
		this.#references.delete(request.leaseId);
		for (const [authorization, active] of this.#capabilities) {
			if (active.capability.leaseId === request.leaseId) this.#capabilities.delete(authorization);
		}
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
			reference.grantId !== lease.grantId ||
			reference.bindingId !== lease.bindingId ||
			reference.references[projection.provider] === undefined
		) return undefined;
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
		this.#capabilities.set(authorization, { capability, projection, references: reference.references });
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
		return true;
	}

	async dispose(): Promise<void> {
		for (const request of this.#requests) request.abort(new DOMException("Model gateway disposed", "AbortError"));
		this.#requests.clear();
		this.#capabilities.clear();
		this.#references.clear();
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
		const active = authorization === undefined ? undefined : this.#capabilities.get(authorization);
		if (active === undefined || Date.parse(active.capability.expiresAt) <= this.#now()) {
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
		this.#requests.add(cancellation);
		const abort = (): void => cancellation.abort(new DOMException("Gateway request was cancelled", "AbortError"));
		const close = (): void => {
			if (!response.writableEnded) abort();
		};
		request.once("aborted", abort);
		response.once("close", close);
		try {
			const body = await this.#readBody(request);
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
			const runtimeOptions = {
				...this.#authOptions(credential),
				signal: cancellation.signal,
				...(effort === undefined ? {} : { reasoning: effort }),
				...(parsed.maxTokens === undefined ? {} : { maxTokens: parsed.maxTokens }),
				serviceTier: active.projection.serviceTier,
				// OpenAI-compatible adapters merge samplingParams into the final payload.
				// Other provider adapters retain this safe route fact for their own mapping.
				samplingParams: { service_tier: active.projection.serviceTier },
			};
			const result = await this.#runtime.streamSimple(model, parsed.context, runtimeOptions).result();
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
			if (!response.headersSent) response.writeHead(error instanceof GatewayRequestError ? error.status : 502);
			response.end();
		} finally {
			request.off("aborted", abort);
			response.off("close", close);
			this.#requests.delete(cancellation);
		}
	}

	#authOptions(credential: Credential): { readonly apiKey?: string; readonly env?: Record<string, string> } {
		const apiKey = "key" in credential && typeof credential.key === "string" ? credential.key : undefined;
		const env = "env" in credential && credential.env !== undefined ? { ...credential.env } : undefined;
		return {
			...(apiKey === undefined ? {} : { apiKey }),
			...(env === undefined ? {} : { env }),
		};
	}

	async #readBody(request: IncomingMessage): Promise<string> {
		const chunks: Buffer[] = [];
		let bytes = 0;
		for await (const chunk of request) {
			const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
			bytes += value.byteLength;
			if (bytes > MAX_GATEWAY_REQUEST_BYTES) {
				throw new GatewayRequestError(413, "request is too large");
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks, bytes).toString("utf8");
	}
}
