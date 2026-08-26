/**
 * Private vendor-driver boundary for ExternalAgentConnector implementations.
 *
 * Drivers translate a canonical Attempt into one vendor protocol. They do not
 * create Foundation Attempts or receipts and are never exported from the
 * coding-agent package entry.
 */

import type {
	ArtifactRef,
	Attempt,
	ConnectorCapabilitySnapshot,
	FoundationJsonValue,
	PublicExecutionError,
	SideEffectState,
} from "@aos-agent/agent-core";
import type { CanonicalExternalConnectorMapping } from "../external-session-mapping.ts";

export interface ExternalConnectorDriverHandle {
	readonly externalSessionId: string;
	readonly externalTurnId?: string;
	readonly supervisorRef: string;
	readonly operationNonce: string;
}

export interface ExternalConnectorDriverSpawnRequest {
	readonly attempt: Attempt;
	readonly capability: ConnectorCapabilitySnapshot;
	readonly bindingDigest: string;
	readonly bindingRevision: number;
	readonly operationNonce: string;
	readonly signal?: AbortSignal;
}

export interface ExternalConnectorDriverWriteRequest {
	readonly kind: string;
	readonly payload: FoundationJsonValue;
}

export interface ExternalConnectorTerminalEvidence {
	readonly status: "succeeded" | "failed" | "cancelled" | "suspended";
	readonly artifacts?: readonly ArtifactRef[];
	readonly error?: PublicExecutionError;
	readonly sideEffectState: SideEffectState;
	readonly producedAt: string;
}

export type ExternalConnectorDriverLookup =
	| { readonly status: "running"; readonly handle: ExternalConnectorDriverHandle }
	| { readonly status: "terminal"; readonly evidence: ExternalConnectorTerminalEvidence }
	| { readonly status: "missing" }
	| { readonly status: "ambiguous" };

export interface ExternalConnectorVendorDriver {
	spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle>;
	connect(
		mapping: CanonicalExternalConnectorMapping,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorDriverHandle>;
	lookup(
		mapping: CanonicalExternalConnectorMapping,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorDriverLookup>;
	read(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorTerminalEvidence>;
	write(
		handle: ExternalConnectorDriverHandle,
		request: ExternalConnectorDriverWriteRequest,
		options?: { readonly signal?: AbortSignal },
	): Promise<void>;
	heartbeat(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<void>;
	cancel(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorTerminalEvidence | undefined>;
	dispose(): Promise<void>;
}
