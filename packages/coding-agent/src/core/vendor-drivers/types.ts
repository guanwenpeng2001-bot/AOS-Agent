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
	validateToolGatewayRequest,
	type ArtifactRef,
	type Attempt,
	type ConnectorCapabilitySnapshot,
	type ExecutionCorrelation,
	type FoundationJsonValue,
	type PublicExecutionError,
	type SideEffectState,
	type ToolExecutionResult,
	type ToolGatewayRequest,
} from "@aos-agent/agent-core";
import {
	isCanonicalExternalConnectorMappingTimestamp,
	isExternalConnectorMappingIdentifier,
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

const EXTERNAL_CONNECTOR_DRIVER_HANDLE_KEYS = new Set([
	"externalSessionId",
	"externalTurnId",
	"supervisorRef",
	"operationNonce",
]);

export interface ExternalConnectorDriverSpawnRequest {
	readonly attempt: Attempt;
	readonly correlation: ExecutionCorrelation;
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
	readonly schemaVersion: 1;
	readonly kind: "tool_gateway_result";
	readonly operationNonce: string;
	readonly result: ToolExecutionResult;
}

/** Exact, private observation protocol emitted by a current vendor driver. */
export type ExternalConnectorDriverEvent =
	| {
			readonly schemaVersion: 1;
			readonly type: "started";
			readonly externalSessionId: string;
			readonly externalTurnId?: string;
			readonly producedAt: string;
	  }
	| {
			readonly schemaVersion: 1;
			readonly type: "progress";
			readonly externalSessionId: string;
			readonly externalTurnId?: string;
			readonly sequence: number;
			readonly phase?: string;
			readonly producedAt: string;
	  }
	| {
			readonly schemaVersion: 1;
			readonly type: "heartbeat";
			readonly externalSessionId: string;
			readonly externalTurnId?: string;
			readonly sequence: number;
			readonly producedAt: string;
	  }
	| {
			readonly schemaVersion: 1;
			readonly type: "artifact";
			readonly externalSessionId: string;
			readonly externalTurnId?: string;
			readonly artifact: ArtifactRef;
			readonly producedAt: string;
	  }
	| {
			readonly schemaVersion: 1;
			readonly type: "tool_gateway_request";
			readonly externalSessionId: string;
			readonly externalTurnId?: string;
			readonly operationNonce: string;
			readonly request: ToolGatewayRequest;
			readonly producedAt: string;
	  };

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
const EXTERNAL_CONNECTOR_STARTED_EVENT_KEYS = new Set([
	"schemaVersion",
	"type",
	"externalSessionId",
	"externalTurnId",
	"producedAt",
]);
const EXTERNAL_CONNECTOR_PROGRESS_EVENT_KEYS = new Set([...EXTERNAL_CONNECTOR_STARTED_EVENT_KEYS, "sequence", "phase"]);
const EXTERNAL_CONNECTOR_HEARTBEAT_EVENT_KEYS = new Set([...EXTERNAL_CONNECTOR_STARTED_EVENT_KEYS, "sequence"]);
const EXTERNAL_CONNECTOR_ARTIFACT_EVENT_KEYS = new Set([...EXTERNAL_CONNECTOR_STARTED_EVENT_KEYS, "artifact"]);
const EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT_KEYS = new Set([
	...EXTERNAL_CONNECTOR_STARTED_EVENT_KEYS,
	"operationNonce",
	"request",
]);
const EXTERNAL_CONNECTOR_EVENT_PHASE_PATTERN = /^[^\u0000-\u001f\u007f]{1,128}$/;
const EXTERNAL_CONNECTOR_SHA256_DIGEST_PATTERN = /^sha256:[A-Fa-f0-9]{64}$/;
const EXTERNAL_CONNECTOR_ARTIFACT_MEDIA_TYPES = new Set([
	"application/json",
	"application/octet-stream",
	"application/pdf",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
	"text/csv",
	"text/html",
	"text/markdown",
	"text/plain",
]);

const EXTERNAL_CONNECTOR_TERMINAL_ERRORS = Object.freeze({
	agent_run_failed: {
		message: "Run failed.",
		category: "unknown",
	},
	external_event_invalid: {
		message: "External connector emitted invalid supervised output.",
		category: "side_effect_unknown",
	},
	external_protocol_unsupported: {
		message: "External connector protocol is unsupported.",
		category: "parameter",
	},
	external_resource_limit_exceeded: {
		message: "External connector exceeded a supervised resource limit.",
		category: "side_effect_unknown",
	},
	external_tool_route_denied: {
		message: "External connector Tool Gateway policy or route denied the request.",
		category: "permission",
	},
	run_deadline_exceeded: {
		message: "External connector run deadline was exceeded.",
		category: "deadline",
	},
	side_effect_unknown: {
		message: "External connector terminal outcome could not be proven.",
		category: "side_effect_unknown",
	},
} as const satisfies Record<
	string,
	{
		readonly message: string;
		readonly category: NonNullable<PublicExecutionError["category"]>;
	}
>);

type ExternalConnectorTerminalErrorCode = keyof typeof EXTERNAL_CONNECTOR_TERMINAL_ERRORS;

function isTerminalEvidenceRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/** Retain only content-addressed identity and bounded metadata from a vendor Artifact reference. */
function canonicalExternalConnectorArtifactRef(value: unknown): ArtifactRef | undefined {
	if (
		!isTerminalEvidenceRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.artifactId !== "string" ||
		typeof value.mediaType !== "string" ||
		typeof value.digest !== "string" ||
		!EXTERNAL_CONNECTOR_SHA256_DIGEST_PATTERN.test(value.digest)
	) {
		return undefined;
	}
	const digestValue = value.digest.slice("sha256:".length).toLowerCase();
	const requestedMediaType = value.mediaType.toLowerCase();
	const mediaType = EXTERNAL_CONNECTOR_ARTIFACT_MEDIA_TYPES.has(requestedMediaType)
		? requestedMediaType
		: "application/octet-stream";
	const sizeBytes =
		typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0
			? value.sizeBytes
			: undefined;
	const canonical: ArtifactRef = {
		schemaVersion: 1,
		artifactId: digestValue,
		mediaType,
		digest: `sha256:${digestValue}`,
		...(sizeBytes === undefined ? {} : { sizeBytes }),
	};
	return validateArtifactRef(canonical).ok ? canonical : undefined;
}

function canonicalExternalConnectorTerminalError(
	status: ExternalConnectorTerminalEvidence["status"],
	sideEffectState: SideEffectState,
	error: PublicExecutionError | undefined,
): PublicExecutionError | undefined {
	if (status === "succeeded" || status === "cancelled") return undefined;
	let code: ExternalConnectorTerminalErrorCode;
	if (status === "suspended") {
		code = "side_effect_unknown";
	} else if (error !== undefined && Object.hasOwn(EXTERNAL_CONNECTOR_TERMINAL_ERRORS, error.code)) {
		code = error.code as ExternalConnectorTerminalErrorCode;
	} else if (sideEffectState !== "none") {
		code = "side_effect_unknown";
	} else {
		code = "agent_run_failed";
	}
	const projection = EXTERNAL_CONNECTOR_TERMINAL_ERRORS[code];
	return {
		code,
		message: projection.message,
		category: projection.category,
		retryable: false,
	};
}

/** Exact runtime shape for an untrusted driver authority handle. */
export function isExternalConnectorDriverHandle(value: unknown): value is ExternalConnectorDriverHandle {
	return (
		isTerminalEvidenceRecord(value) &&
		Reflect.ownKeys(value).every(
			(key) => typeof key === "string" && EXTERNAL_CONNECTOR_DRIVER_HANDLE_KEYS.has(key),
		) &&
		isExternalConnectorMappingIdentifier(value.externalSessionId) &&
		(value.externalTurnId === undefined || isExternalConnectorMappingIdentifier(value.externalTurnId)) &&
		isExternalConnectorMappingIdentifier(value.supervisorRef) &&
		isExternalConnectorMappingIdentifier(value.operationNonce)
	);
}

/** Reject unknown fields and malformed identity, ordering, or artifact facts before observation. */
export function isExternalConnectorDriverEvent(value: unknown): value is ExternalConnectorDriverEvent {
	if (
		!isTerminalEvidenceRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.type !== "string" ||
		!isExternalConnectorMappingIdentifier(value.externalSessionId) ||
		(value.externalTurnId !== undefined && !isExternalConnectorMappingIdentifier(value.externalTurnId)) ||
		!isCanonicalExternalConnectorMappingTimestamp(value.producedAt)
	) {
		return false;
	}
	const keys =
		value.type === "started"
			? EXTERNAL_CONNECTOR_STARTED_EVENT_KEYS
			: value.type === "progress"
				? EXTERNAL_CONNECTOR_PROGRESS_EVENT_KEYS
				: value.type === "heartbeat"
					? EXTERNAL_CONNECTOR_HEARTBEAT_EVENT_KEYS
					: value.type === "artifact"
						? EXTERNAL_CONNECTOR_ARTIFACT_EVENT_KEYS
						: value.type === "tool_gateway_request"
							? EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT_KEYS
							: undefined;
	if (keys === undefined || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.has(key))) {
		return false;
	}
	if (value.type === "progress" || value.type === "heartbeat") {
		return (
			typeof value.sequence === "number" &&
			Number.isSafeInteger(value.sequence) &&
			value.sequence > 0 &&
			(value.type === "heartbeat" ||
				value.phase === undefined ||
				(typeof value.phase === "string" && EXTERNAL_CONNECTOR_EVENT_PHASE_PATTERN.test(value.phase)))
		);
	}
	if (value.type === "tool_gateway_request") {
		return isExternalConnectorMappingIdentifier(value.operationNonce) && validateToolGatewayRequest(value.request).ok;
	}
	return value.type !== "artifact" || canonicalExternalConnectorArtifactRef(value.artifact) !== undefined;
}

/** Exact terminal evidence accepted from an untrusted private vendor driver. */
export function isExternalConnectorTerminalEvidence(value: unknown): value is ExternalConnectorTerminalEvidence {
	if (
		!isTerminalEvidenceRecord(value) ||
		Reflect.ownKeys(value).some(
			(key) => typeof key !== "string" || !EXTERNAL_CONNECTOR_TERMINAL_EVIDENCE_KEYS.has(key),
		) ||
		!isExternalConnectorMappingIdentifier(value.externalSessionId) ||
		(value.externalTurnId !== undefined && !isExternalConnectorMappingIdentifier(value.externalTurnId)) ||
		!isExternalConnectorMappingIdentifier(value.operationNonce) ||
		typeof value.status !== "string" ||
		!EXTERNAL_CONNECTOR_TERMINAL_STATUSES.has(value.status) ||
		typeof value.sideEffectState !== "string" ||
		!EXTERNAL_CONNECTOR_SIDE_EFFECT_STATES.has(value.sideEffectState) ||
		!isCanonicalExternalConnectorMappingTimestamp(value.producedAt)
	) {
		return false;
	}
	if (
		value.artifacts !== undefined &&
		(!Array.isArray(value.artifacts) ||
			value.artifacts.some((artifact) => canonicalExternalConnectorArtifactRef(artifact) === undefined))
	) {
		return false;
	}
	return value.error === undefined || validatePublicExecutionError(value.error).ok;
}

export function cloneExternalConnectorTerminalEvidence(value: unknown): ExternalConnectorTerminalEvidence {
	if (!isExternalConnectorTerminalEvidence(value)) {
		throw new FoundationError("foundation_schema_invalid_shape", "External connector terminal evidence is invalid");
	}
	const artifacts = value.artifacts?.map((artifact) => {
		const canonical = canonicalExternalConnectorArtifactRef(artifact);
		if (canonical === undefined) {
			throw new FoundationError(
				"foundation_schema_invalid_shape",
				"External connector terminal artifact evidence is invalid",
			);
		}
		return Object.freeze(canonical);
	});
	const error = canonicalExternalConnectorTerminalError(value.status, value.sideEffectState, value.error);
	return Object.freeze({
		externalSessionId: value.externalSessionId,
		...(value.externalTurnId === undefined ? {} : { externalTurnId: value.externalTurnId }),
		operationNonce: value.operationNonce,
		status: value.status,
		...(artifacts === undefined ? {} : { artifacts: Object.freeze(artifacts) }),
		...(error === undefined ? {} : { error: Object.freeze(error) }),
		sideEffectState: value.sideEffectState,
		producedAt: value.producedAt,
	});
}

export type ExternalConnectorDriverLookup =
	| { readonly status: "running"; readonly handle: ExternalConnectorDriverHandle }
	| { readonly status: "terminal"; readonly evidence: ExternalConnectorTerminalEvidence }
	| { readonly status: "missing" }
	| { readonly status: "ambiguous" };

const EXTERNAL_CONNECTOR_DRIVER_LOOKUP_RUNNING_KEYS = new Set(["status", "handle"]);
const EXTERNAL_CONNECTOR_DRIVER_LOOKUP_TERMINAL_KEYS = new Set(["status", "evidence"]);
const EXTERNAL_CONNECTOR_DRIVER_LOOKUP_EMPTY_KEYS = new Set(["status"]);

/** Exact runtime shape for every lookup branch returned by an untrusted driver. */
export function isExternalConnectorDriverLookup(value: unknown): value is ExternalConnectorDriverLookup {
	if (!isTerminalEvidenceRecord(value) || typeof value.status !== "string") return false;
	const allowedKeys =
		value.status === "running"
			? EXTERNAL_CONNECTOR_DRIVER_LOOKUP_RUNNING_KEYS
			: value.status === "terminal"
				? EXTERNAL_CONNECTOR_DRIVER_LOOKUP_TERMINAL_KEYS
				: value.status === "missing" || value.status === "ambiguous"
					? EXTERNAL_CONNECTOR_DRIVER_LOOKUP_EMPTY_KEYS
					: undefined;
	if (
		allowedKeys === undefined ||
		Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedKeys.has(key))
	) {
		return false;
	}
	if (value.status === "running") return isExternalConnectorDriverHandle(value.handle);
	if (value.status === "terminal") return isExternalConnectorTerminalEvidence(value.evidence);
	return true;
}

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
	heartbeat(handle: ExternalConnectorDriverHandle, options?: { readonly signal?: AbortSignal }): Promise<void>;
	cancel(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorTerminalEvidence | undefined>;
	dispose(options?: { readonly signal?: AbortSignal }): Promise<void>;
}
