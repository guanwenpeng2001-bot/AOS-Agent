import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage, Credential, Message } from "@aos-agent/ai";
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

function textFromRequest(value: unknown): string | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const messages = Array.isArray(record.messages) ? record.messages : undefined;
	if (messages !== undefined) {
		const parts: string[] = [];
		for (const message of messages) {
			if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
			const content = (message as Record<string, unknown>).content;
			if (typeof content === "string") parts.push(content);
			else if (Array.isArray(content)) {
				for (const block of content) {
					if (block !== null && typeof block === "object" && !Array.isArray(block)) {
						const text = (block as Record<string, unknown>).text;
						if (typeof text === "string") parts.push(text);
					}
				}
			}
		}
		if (parts.length > 0) return parts.join("\n");
	}
	if (typeof record.input === "string") return record.input;
	return undefined;
}

function assistantText(message: AssistantMessage): string {
	return message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("");
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
	readonly #references = new Map<string, Readonly<Record<string, string>>>();
	readonly #capabilities = new Map<string, ActiveGatewayCapability>();
	#server: Server | undefined;
	#endpoint: string | undefined;

	constructor(options: { readonly targetId: string; readonly runtime: ModelRuntime; readonly vault: LocalCredentialVault }) {
		this.#targetId = options.targetId;
		this.#runtime = options.runtime;
		this.#vault = options.vault;
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
		const succeeded = request.targetId === this.#targetId && Object.keys(request.references).length > 0;
		if (succeeded) this.#references.set(request.leaseId, Object.freeze({ ...request.references }));
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
		return providerReceipt(request, "renewed");
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
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
		if (!validateOperationWorkerLeaseProjection(lease) || Date.parse(lease.expiresAt) <= Date.now()) return undefined;
		const references = this.#references.get(lease.leaseId);
		if (references === undefined || references[projection.provider] === undefined) return undefined;
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
		this.#capabilities.set(authorization, { capability, projection, references });
		return capability;
	}

	close(capability: ExternalModelGatewayCapability): boolean {
		const active = this.#capabilities.get(capability.authorization);
		if (active === undefined || active.capability.leaseId !== capability.leaseId) return false;
		this.#capabilities.delete(capability.authorization);
		return true;
	}

	async dispose(): Promise<void> {
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
		if (active === undefined || Date.parse(active.capability.expiresAt) <= Date.now()) {
			response.writeHead(401).end();
			return;
		}
		const reference = active.references[active.projection.provider];
		const credential = reference === undefined ? undefined : this.#vault.resolve(reference);
		if (credential === undefined) {
			response.writeHead(401).end();
			return;
		}
		try {
			const body = await this.#readBody(request);
			const prompt = textFromRequest(JSON.parse(body));
			const model = this.#runtime.getModel(active.projection.provider, active.projection.model);
			if (prompt === undefined || model === undefined) {
				response.writeHead(400).end();
				return;
			}
			const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
			const result = await this.#runtime.streamSimple(model, { messages }, this.#authOptions(credential)).result();
			const text = assistantText(result);
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({
				id: result.responseId ?? `aos_${randomUUID()}`,
				object: "response",
				status: "completed",
				model: result.responseModel ?? result.model,
				output_text: text,
				content: [{ type: "text", text }],
			}));
		} catch {
			response.writeHead(502).end();
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
		let body = "";
		for await (const chunk of request) {
			body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
			if (Buffer.byteLength(body, "utf8") > MAX_GATEWAY_REQUEST_BYTES) throw new Error("request too large");
		}
		return body;
	}
}
