/**
 * Private vendor-driver boundary for ExternalAgentConnector implementations.
 *
 * Drivers translate a canonical Attempt into one vendor protocol. They do not
 * create Foundation Attempts or receipts and are never exported from the
 * coding-agent package entry.
 */

import {
	FoundationError,
	validateArtifactRef,
	validatePublicExecutionError,
	type ArtifactRef,
	type Attempt,
	type ConnectorCapabilitySnapshot,
	type FoundationJsonValue,
	type PublicExecutionError,
	type SideEffectState,
} from "@aos-agent/agent-core";
import {
	isCanonicalExternalMappingTimestamp,
	isExternalMappingIdentifier,
	type CanonicalExternalConnectorMapping,
} from "../external-session-mapping.ts";
import type { CanonicalExternalAgentInput } from "../external-agent-input.ts";
import type {
	ExternalModelSupportMatrix,
	ExternalResolvedModelProjection,
	ExternalTranslatedModelProjection,
} from "../external-model-projection.ts";

export interface ExternalConnectorDriverHandle {
	readonly externalSessionId: string;
	readonly externalTurnId?: string;
	readonly supervisorRef: string;
	readonly operationNonce: string;
}

export interface ExternalConnectorDriverSpawnRequest {
	readonly attempt: Attempt;
	readonly input: CanonicalExternalAgentInput;
	readonly modelProjection?: ExternalResolvedModelProjection;
	readonly modelTranslation?: ExternalTranslatedModelProjection;
	readonly capability: ConnectorCapabilitySnapshot;
	readonly bindingDigest: string;
	readonly bindingRevision: number;
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly signal?: AbortSignal;
}

export interface ExternalConnectorDriverWriteRequest {
	readonly kind: string;
	readonly payload: FoundationJsonValue;
}

export interface ExternalConnectorTerminalEvidence {
	readonly externalSessionId: string;
	readonly externalTurnId?: string;
	readonly operationNonce: string;
	readonly status: "succeeded" | "failed" | "cancelled" | "suspended";
	readonly artifacts?: readonly ArtifactRef[];
	readonly error?: PublicExecutionError;
	readonly sideEffectState: SideEffectState;
	readonly producedAt: string;
}

const EXTERNAL_CONNECTOR_TERMINAL_EVIDENCE_KEYS = new Set([
	"externalSessionId",
	"externalTurnId",
	"operationNonce",
	"status",
	"artifacts",
	"error",
	"sideEffectState",
	"producedAt",
]);
const EXTERNAL_CONNECTOR_TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "suspended"]);
const EXTERNAL_CONNECTOR_SIDE_EFFECT_STATES = new Set(["none", "unknown", "side_effect_unknown"]);

function isTerminalEvidenceRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Exact, secret-free terminal evidence accepted from a private vendor driver. */
export function isExternalConnectorTerminalEvidence(value: unknown): value is ExternalConnectorTerminalEvidence {
	if (
		!isTerminalEvidenceRecord(value) ||
		Reflect.ownKeys(value).some(
			(key) => typeof key !== "string" || !EXTERNAL_CONNECTOR_TERMINAL_EVIDENCE_KEYS.has(key),
		) ||
		!isExternalMappingIdentifier(value.externalSessionId) ||
		(value.externalTurnId !== undefined && !isExternalMappingIdentifier(value.externalTurnId)) ||
		!isExternalMappingIdentifier(value.operationNonce) ||
		typeof value.status !== "string" ||
		!EXTERNAL_CONNECTOR_TERMINAL_STATUSES.has(value.status) ||
		typeof value.sideEffectState !== "string" ||
		!EXTERNAL_CONNECTOR_SIDE_EFFECT_STATES.has(value.sideEffectState) ||
		!isCanonicalExternalMappingTimestamp(value.producedAt)
	) {
		return false;
	}
	if (
		value.artifacts !== undefined &&
		(!Array.isArray(value.artifacts) || value.artifacts.some((artifact) => !validateArtifactRef(artifact).ok))
	) {
		return false;
	}
	return value.error === undefined || validatePublicExecutionError(value.error).ok;
}

export function cloneExternalConnectorTerminalEvidence(value: unknown): ExternalConnectorTerminalEvidence {
	if (!isExternalConnectorTerminalEvidence(value)) {
		throw new FoundationError(
			"foundation_schema_invalid_shape",
			"External connector terminal evidence is invalid",
		);
	}
	return Object.freeze({
		externalSessionId: value.externalSessionId,
		...(value.externalTurnId === undefined ? {} : { externalTurnId: value.externalTurnId }),
		operationNonce: value.operationNonce,
		status: value.status,
		...(value.artifacts === undefined
			? {}
			: { artifacts: Object.freeze(value.artifacts.map((artifact) => Object.freeze({ ...artifact }))) }),
		...(value.error === undefined ? {} : { error: Object.freeze({ ...value.error }) }),
		sideEffectState: value.sideEffectState,
		producedAt: value.producedAt,
	});
}

export type ExternalConnectorDriverLookup =
	| { readonly status: "running"; readonly handle: ExternalConnectorDriverHandle }
	| { readonly status: "terminal"; readonly evidence: ExternalConnectorTerminalEvidence }
	| { readonly status: "missing" }
	| { readonly status: "ambiguous" };

export interface ExternalConnectorVendorDriver {
	/** Host-private exact model translation contract. Read only for aos_gateway. */
	readonly modelSupportMatrix?: ExternalModelSupportMatrix;
	spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle>;
	events(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): AsyncIterable<FoundationJsonValue>;
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
