import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@aos-agent/ai";

/**
 * MCP OAuth records share the CredentialStore file but must never appear in
 * ModelRuntime provider enumeration. Keys use `mcp__` (this Host) or the
 * PR-example `mcp:` prefix.
 */
function isMcpCredentialProviderId(providerId: string): boolean {
	return providerId.startsWith("mcp__") || providerId.startsWith("mcp:");
}

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.store.read(providerId, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map(
			(await this.store.list(options))
				.filter((entry) => !isMcpCredentialProviderId(entry.providerId))
				.map((entry) => [entry.providerId, entry]),
		);
		options?.signal?.throwIfAborted();
		for (const providerId of this.overrides.keys()) {
			if (isMcpCredentialProviderId(providerId)) continue;
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	/** @internal Read current secret material for exact-match DLP scanning. */
	async getDlpCredentialMaterials(options?: AuthOperationOptions): Promise<readonly string[]> {
		const providerIds = new Set((await this.store.list(options)).map((entry) => entry.providerId));
		for (const providerId of this.overrides.keys()) providerIds.add(providerId);
		const credentials = await Promise.all([...providerIds].map((providerId) => this.read(providerId, options)));
		const materials: string[] = [];
		for (const credential of credentials) {
			if (credential?.type === "api_key") {
				if (credential.key !== undefined) materials.push(credential.key);
				continue;
			}
			if (credential?.type === "oauth") materials.push(credential.access, credential.refresh);
		}
		return materials;
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.store.modify(providerId, fn, options);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.store.delete(providerId, options);
		this.overrides.delete(providerId);
	}
}
