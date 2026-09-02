export const PRIVATE_EXTERNAL_CONNECTOR_VENDOR_IDENTITIES = Object.freeze({
	claude: Object.freeze({ version: "0.3.246", protocolName: "claude-agent-sdk", protocolVersion: "0.3.246" }),
	codex: Object.freeze({ version: "0.149.0", protocolName: "codex-app-server", protocolVersion: "0.149.0" }),
	acp: Object.freeze({ version: "1.4.0", protocolName: "acp", protocolVersion: "1" }),
});

export type PrivateExternalConnectorVendorDriver = keyof typeof PRIVATE_EXTERNAL_CONNECTOR_VENDOR_IDENTITIES;
