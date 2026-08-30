import {
	cloneDeepFrozen,
	type ExternalAgentConnector,
} from "@aos-agent/agent-core";
import type {
	ExternalConnectorToolGatewayConsumer,
	ExternalConnectorToolGatewayScope,
} from "./durable-connector.ts";

export const EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT = "tool_gateway_request" as const;
export const EXTERNAL_CONNECTOR_TOOL_GATEWAY_RESULT_WRITE = "tool_gateway_result" as const;

/** Passive adapter behavior facts captured by the trusted Host after handshake. */
export interface ExternalConnectorVendorBehaviorManifest {
	readonly schemaVersion: 1;
	readonly revision: number;
	readonly events: readonly string[];
	readonly writes: readonly string[];
}

export type ExternalConnectorVendorBehaviorManifestReader = () => unknown;

/** Exact frozen Tool Gateway authority bound to one durable Attempt. */
export interface ExternalConnectorToolGatewayBinding {
	readonly scope: ExternalConnectorToolGatewayScope;
	release(): void;
}

const BEHAVIOR_MANIFEST_KEYS = new Set(["schemaVersion", "revision", "events", "writes"]);
const BEHAVIOR_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/;
const MAX_BEHAVIOR_COUNT = 64;
const behaviorManifestReaders = new WeakMap<ExternalAgentConnector, ExternalConnectorVendorBehaviorManifestReader>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBehaviorList(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_BEHAVIOR_COUNT &&
		value.every((item) => typeof item === "string" && BEHAVIOR_IDENTIFIER_PATTERN.test(item)) &&
		new Set(value).size === value.length
	);
}

function cloneBehaviorManifest(value: unknown): ExternalConnectorVendorBehaviorManifest | undefined {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== BEHAVIOR_MANIFEST_KEYS.size ||
		Object.keys(value).some((key) => !BEHAVIOR_MANIFEST_KEYS.has(key)) ||
		value.schemaVersion !== 1 ||
		!Number.isSafeInteger(value.revision) ||
		(value.revision as number) < 1 ||
		!isBehaviorList(value.events) ||
		!isBehaviorList(value.writes)
	) {
		return undefined;
	}
	return cloneDeepFrozen({
		schemaVersion: 1,
		revision: value.revision as number,
		events: [...value.events],
		writes: [...value.writes],
	});
}

/**
 * Bind the passive manifest reader owned by a provenance-checked adapter.
 * Registration and every selection recheck call the reader again; it must not
 * probe, spawn, or perform another provider effect.
 */
export function bindExternalConnectorVendorBehaviorManifest(
	connector: ExternalAgentConnector,
	read: ExternalConnectorVendorBehaviorManifestReader,
): () => void {
	if (typeof read !== "function" || behaviorManifestReaders.has(connector)) {
		throw new TypeError("External connector vendor behavior manifest authority is invalid");
	}
	const initial = cloneBehaviorManifest(read());
	if (initial === undefined) {
		throw new TypeError("External connector vendor behavior manifest is invalid");
	}
	behaviorManifestReaders.set(connector, read);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (behaviorManifestReaders.get(connector) === read) behaviorManifestReaders.delete(connector);
	};
}

/** Re-read and deep-freeze the current adapter behavior facts. */
export function readExternalConnectorVendorBehaviorManifest(
	connector: ExternalAgentConnector,
): ExternalConnectorVendorBehaviorManifest | undefined {
	const read = behaviorManifestReaders.get(connector);
	if (read === undefined) return undefined;
	try {
		return cloneBehaviorManifest(read());
	} catch {
		return undefined;
	}
}

export function supportsExternalConnectorToolGatewayBehavior(
	manifest: ExternalConnectorVendorBehaviorManifest,
): boolean {
	return (
		manifest.events.includes(EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT) &&
		manifest.writes.includes(EXTERNAL_CONNECTOR_TOOL_GATEWAY_RESULT_WRITE)
	);
}

/** Preserve the exact frozen scope while making release idempotent. */
export function createExternalConnectorToolGatewayBinding(
	consumer: ExternalConnectorToolGatewayConsumer,
	releaseConsumer: () => void,
): ExternalConnectorToolGatewayBinding {
	const scope = cloneDeepFrozen(consumer.scope);
	let released = false;
	return Object.freeze({
		scope,
		release: () => {
			if (released) return;
			released = true;
			releaseConsumer();
		},
	});
}
