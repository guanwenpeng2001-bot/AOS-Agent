/**
 * Trusted External Agent Adapter registry.
 *
 * The registry is the only place an External Agent Adapter can be
 * registered, and it accepts already-constructed adapter instances only.
 * Adapters are never loaded from project configuration, URLs, commands,
 * module paths, model provider names, or target self-reports; this module
 * exposes no API that would accept any of those as a registration source.
 * Registration fails closed with the stable `external_agent_adapter_invalid`
 * code on non-instance values, duplicate adapter ids, unsafe adapter ids,
 * unsafe descriptor fields, unsafe target ids, and malformed registration
 * options (non-object options, unknown keys, or non-array targets).
 *
 * Selection is explicit: a Run chooses `adapterId + targetId` as a bounded
 * `ExternalAgentSelection`. A selection with unsafe identifiers fails with
 * `external_agent_adapter_invalid`; a well-formed selection that names an
 * unregistered adapter or a target the adapter does not own fails with
 * `external_agent_target_not_found`. Model provider names and model ids
 * never select an adapter.
 *
 * The registry stores only the trusted adapter instance, its safe
 * descriptor (adapterId / displayName / version), and its bounded target
 * ids. It never stores or exposes target endpoints, commands, credentials,
 * protocol names, or raw probe data: `list()` returns safe descriptors and
 * `resolve()` returns the adapter instance plus the opaque target id.
 *
 * The registry is write-once from Host composition and read-only after
 * that: `list()` returns a fresh array of frozen descriptors in
 * registration order, returned values are frozen, and there is no
 * unregister, clear, or in-place mutation API.
 *
 * Erasable TypeScript only (no enums, namespaces, or parameter properties).
 */

import {
	EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH,
	EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH,
	type ExternalAgentAdapter,
	ExternalAgentError,
	type ExternalAgentSelection,
	type ExternalAgentTarget,
	isExternalAgentIdentifier,
	serializeExternalAgentSelection,
} from "./external-agent-adapter.ts";

/** Bounded display text; rejects control characters and secret shapes. */
export const EXTERNAL_AGENT_DISPLAY_NAME_MAX_LENGTH = 128 as const;
/** Bounded descriptor version string. */
export const EXTERNAL_AGENT_DESCRIPTOR_VERSION_MAX_LENGTH = 64 as const;

export interface ExternalAgentAdapterRegistrationOptions {
	/** Safe display name; defaults to the adapter id. */
	readonly displayName?: string;
	/** Safe descriptor version; defaults to "1". */
	readonly version?: string;
	/** Bounded target ids this adapter can reach; empty means none. */
	readonly targets?: ReadonlyArray<string>;
}

/** Safe public summary of a registered adapter; no target or connection data. */
export interface ExternalAgentAdapterDescriptor {
	readonly adapterId: string;
	readonly displayName: string;
	readonly version: string;
}

/** A selection resolved to the trusted adapter instance and its known target. */
export interface ExternalAgentResolvedSelection {
	readonly adapter: ExternalAgentAdapter;
	readonly target: ExternalAgentTarget;
	readonly selection: ExternalAgentSelection;
}

/**
 * Registry contract used by the trusted Host composition. Registration is
 * instance-only and fail-closed; lookups never expose endpoints, commands,
 * credentials, protocol names, or raw probe data.
 */
export interface ExternalAgentAdapterRegistry {
	register(adapter: ExternalAgentAdapter, options?: ExternalAgentAdapterRegistrationOptions): void;
	get(adapterId: string): ExternalAgentAdapter | undefined;
	has(adapterId: string): boolean;
	list(): ReadonlyArray<ExternalAgentAdapterDescriptor>;
	lookupTarget(adapterId: string, targetId: string): ExternalAgentTarget | undefined;
	resolve(selection: ExternalAgentSelection): ExternalAgentResolvedSelection;
}

interface RegisteredAdapter {
	readonly adapter: ExternalAgentAdapter;
	readonly descriptor: ExternalAgentAdapterDescriptor;
	readonly targets: ReadonlySet<string>;
}

const DEFAULT_ADAPTER_DESCRIPTOR_VERSION = "1" as const;
const SECRET_SHAPE_PATTERN = /^(sk-|ghp_|gho_|xox[baprs]-|AKIA|-----BEGIN|bearer\s)/i;
const REGISTRATION_OPTIONS_KEYS = new Set(["displayName", "version", "targets"]);

/** Bounded safe identifier: no URL, path, command, secret shape, or controls. */
function isBoundedSafeIdentifier(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= maxLength &&
		isExternalAgentIdentifier(value) &&
		!SECRET_SHAPE_PATTERN.test(value)
	);
}

/** Bounded display text; rejects control characters, newlines, and secret shapes. */
function isSafeDisplayName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= EXTERNAL_AGENT_DISPLAY_NAME_MAX_LENGTH &&
		!/[\u0000-\u001f\u007f]/.test(value) &&
		!SECRET_SHAPE_PATTERN.test(value)
	);
}

/** A constructed adapter instance: safe id plus the three contract methods. */
function isAdapterInstance(value: unknown): value is ExternalAgentAdapter {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		readonly id?: unknown;
		readonly probe?: unknown;
		readonly prepare?: unknown;
		readonly start?: unknown;
	};
	return (
		isBoundedSafeIdentifier(candidate.id, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH) &&
		typeof candidate.probe === "function" &&
		typeof candidate.prepare === "function" &&
		typeof candidate.start === "function"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Exact runtime shape of the registration options: a plain object with only
 * the known keys, safe optional displayName/version, and an array targets
 * value. A non-object options value, unknown keys, or a non-array targets
 * (which would otherwise be silently iterated, e.g. a string registering its
 * characters) fails closed before any state is written.
 */
function isRegistrationOptions(value: unknown): value is ExternalAgentAdapterRegistrationOptions {
	if (!isRecord(value) || !hasOnlyKeys(value, REGISTRATION_OPTIONS_KEYS)) return false;
	if (value.displayName !== undefined && !isSafeDisplayName(value.displayName)) return false;
	if (
		value.version !== undefined &&
		!isBoundedSafeIdentifier(value.version, EXTERNAL_AGENT_DESCRIPTOR_VERSION_MAX_LENGTH)
	) {
		return false;
	}
	return value.targets === undefined || Array.isArray(value.targets);
}

function isSafeDescriptor(value: unknown): value is ExternalAgentAdapterDescriptor {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		readonly adapterId?: unknown;
		readonly displayName?: unknown;
		readonly version?: unknown;
	};
	return (
		isBoundedSafeIdentifier(candidate.adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH) &&
		isSafeDisplayName(candidate.displayName) &&
		isBoundedSafeIdentifier(candidate.version, EXTERNAL_AGENT_DESCRIPTOR_VERSION_MAX_LENGTH)
	);
}

export class ExternalAgentAdapterRegistryImpl implements ExternalAgentAdapterRegistry {
	readonly #adapters = new Map<string, RegisteredAdapter>();

	register(adapter: ExternalAgentAdapter, options: ExternalAgentAdapterRegistrationOptions = {}): void {
		if (!isAdapterInstance(adapter) || !isRegistrationOptions(options)) {
			throw new ExternalAgentError("external_agent_adapter_invalid");
		}
		const adapterId = adapter.id;
		if (this.#adapters.has(adapterId)) {
			throw new ExternalAgentError("external_agent_adapter_invalid");
		}
		const descriptor: ExternalAgentAdapterDescriptor = Object.freeze({
			adapterId,
			displayName: options.displayName ?? adapterId,
			version: options.version ?? DEFAULT_ADAPTER_DESCRIPTOR_VERSION,
		});
		if (!isSafeDescriptor(descriptor)) {
			throw new ExternalAgentError("external_agent_adapter_invalid");
		}
		const targets = new Set<string>();
		for (const targetId of options.targets ?? []) {
			if (!isBoundedSafeIdentifier(targetId, EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH)) {
				throw new ExternalAgentError("external_agent_adapter_invalid");
			}
			targets.add(targetId);
		}
		this.#adapters.set(adapterId, { adapter, descriptor, targets });
	}

	get(adapterId: string): ExternalAgentAdapter | undefined {
		if (!isBoundedSafeIdentifier(adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH)) return undefined;
		return this.#adapters.get(adapterId)?.adapter;
	}

	has(adapterId: string): boolean {
		return this.get(adapterId) !== undefined;
	}

	list(): ReadonlyArray<ExternalAgentAdapterDescriptor> {
		return [...this.#adapters.values()].map(({ descriptor }) => descriptor);
	}

	lookupTarget(adapterId: string, targetId: string): ExternalAgentTarget | undefined {
		if (
			!isBoundedSafeIdentifier(adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH) ||
			!isBoundedSafeIdentifier(targetId, EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH)
		) {
			return undefined;
		}
		const registered = this.#adapters.get(adapterId);
		if (registered === undefined || !registered.targets.has(targetId)) return undefined;
		return Object.freeze({ targetId });
	}

	resolve(selection: ExternalAgentSelection): ExternalAgentResolvedSelection {
		const safeSelection = serializeExternalAgentSelection(selection);
		if (
			safeSelection === undefined ||
			!isBoundedSafeIdentifier(safeSelection.adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH) ||
			!isBoundedSafeIdentifier(safeSelection.targetId, EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH)
		) {
			throw new ExternalAgentError("external_agent_adapter_invalid");
		}
		const registered = this.#adapters.get(safeSelection.adapterId);
		if (registered === undefined || !registered.targets.has(safeSelection.targetId)) {
			throw new ExternalAgentError("external_agent_target_not_found");
		}
		return Object.freeze({
			adapter: registered.adapter,
			target: Object.freeze({ targetId: safeSelection.targetId }),
			selection: safeSelection,
		});
	}
}

/** Create an empty trusted adapter registry. */
export function createExternalAgentAdapterRegistry(): ExternalAgentAdapterRegistry {
	return new ExternalAgentAdapterRegistryImpl();
}

/** Registry guard used by Host wiring and contract tests. */
export function isExternalAgentAdapterRegistry(value: unknown): value is ExternalAgentAdapterRegistry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ExternalAgentAdapterRegistry>;
	return (
		typeof candidate.register === "function" &&
		typeof candidate.get === "function" &&
		typeof candidate.has === "function" &&
		typeof candidate.list === "function" &&
		typeof candidate.lookupTarget === "function" &&
		typeof candidate.resolve === "function"
	);
}
