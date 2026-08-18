/** The version carried by every Foundation document. */
export const FOUNDATION_SCHEMA_VERSION = 1 as const;
export type FoundationSchemaVersion = typeof FOUNDATION_SCHEMA_VERSION;

/** Explicit execution relationships shared by durable records and transports. */
export interface ExecutionCorrelationV1 {
	sessionId: string;
	laneId: string;
	roleId?: string;
	roleRevisionId?: string;
	modelProfileId?: string;
	modelProfileRevisionId?: string;
	bindingId?: string;
	bindingEpochId?: string;
	agentInstanceId?: string;
	goalId?: string;
	planId?: string;
	stageId?: string;
	taskId?: string;
	dispatchId?: string;
	attemptId?: string;
	attemptReceiptId?: string;
	taskResultId?: string;
	runReceiptId?: string;
	runId?: string;
	turnId?: string;
	stepId?: string;
	parentId?: string;
	ancestorIds?: readonly string[];
	revision: number;
	fencingToken?: string;
}

export type ExecutionCorrelation = ExecutionCorrelationV1;

export function createExecutionCorrelation(
	sessionId: string,
	laneId: string,
	options: Omit<ExecutionCorrelationV1, "sessionId" | "laneId" | "revision"> & { revision?: number } = {},
): ExecutionCorrelationV1 {
	return { sessionId, laneId, revision: options.revision ?? 0, ...options };
}

export function withCorrelationField<K extends Exclude<keyof ExecutionCorrelationV1, "sessionId" | "laneId" | "revision">>(
	correlation: ExecutionCorrelationV1,
	key: K,
	value: NonNullable<ExecutionCorrelationV1[K]>,
): ExecutionCorrelationV1 {
	return { ...correlation, [key]: value };
}

/** Immutable parent/ancestor relationship for Foundation entities. */
export interface FoundationLineageV1 {
	schemaVersion: 1;
	entityType: string;
	entityId: string;
	parentId?: string;
	ancestorIds?: readonly string[];
	depth: number;
}

export type LineageV1 = FoundationLineageV1;

export function rootFoundationLineage(entityType: string, entityId: string): FoundationLineageV1 {
	return { schemaVersion: 1, entityType, entityId, depth: 0 };
}

export function extendFoundationLineage(
	parent: FoundationLineageV1,
	child: { entityType?: string; entityId: string },
): FoundationLineageV1 {
	return {
		schemaVersion: 1,
		entityType: child.entityType ?? parent.entityType,
		entityId: child.entityId,
		parentId: parent.entityId,
		ancestorIds: [...(parent.ancestorIds ?? []), parent.entityId],
		depth: parent.depth + 1,
	};
}

/** Deterministic content fingerprint. */
export interface FingerprintV1 {
	algorithm: "sha256";
	value: string;
}

export type Fingerprint = FingerprintV1;

export function canonicalFoundationJson(value: unknown): string {
	const active = new Set<object>();
	const visit = (current: unknown): string => {
		if (current === null) return "null";
		if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
		if (typeof current === "number") {
			if (!Number.isFinite(current)) throw new TypeError("Foundation fingerprint input contains a non-finite number");
			return JSON.stringify(current);
		}
		if (current === undefined) throw new TypeError("Foundation fingerprint input must not contain undefined");
		if (typeof current !== "object") throw new TypeError(`Foundation fingerprint input must be JSON-like, got ${typeof current}`);
		if (active.has(current)) throw new TypeError("Foundation fingerprint input contains a cycle");
		active.add(current);
		try {
			if (Array.isArray(current)) {
				const ownKeys = Reflect.ownKeys(current);
				if (ownKeys.length !== current.length + 1 || ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^0$|^[1-9][0-9]*$/.test(key) || Number(key) >= current.length))) throw new TypeError("Foundation fingerprint input contains a sparse or extended array");
				return `[${current.map((item) => visit(item)).join(",")}]`;
			}
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Foundation fingerprint input contains a non-JSON object");
			if (Reflect.ownKeys(current).some((key) => typeof key !== "string")) throw new TypeError("Foundation fingerprint input contains a symbol key");
			const record = current as Record<string, unknown>;
			return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${visit(record[key])}`).join(",")}}`;
		} finally {
			active.delete(current);
		}
	};
	return visit(value);
}

export function canonicalJson(value: unknown): string {
	return canonicalFoundationJson(value);
}

export function fingerprintFoundationValue(value: unknown): FingerprintV1 {
	return { algorithm: "sha256", value: sha256HexValue(canonicalFoundationJson(value)) };
}

const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
/** Browser-neutral SHA-256 for canonical records and content-addressed bytes. */
export function sha256HexValue(input: string | Uint8Array): string {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
	const padded = new Uint8Array(paddedLength); padded.set(bytes); padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer); const bitLength = bytes.length * 8;
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000)); view.setUint32(paddedLength - 4, bitLength >>> 0);
	let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
	let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
	const words = new Uint32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i++) { const x = words[i - 15]!; const y = words[i - 2]!; const sigma0 = (x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3; const sigma1 = (y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10; words[i] = (words[i - 16]! + sigma0 + words[i - 7]! + sigma1) >>> 0; }
		let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
		for (let i = 0; i < 64; i++) { const sigma1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7); const choose = (e & f) ^ (~e & g); const temp1 = (h + sigma1 + choose + SHA256_K[i]! + words[i]!) >>> 0; const sigma0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10); const majority = (a & b) ^ (a & c) ^ (b & c); const temp2 = (sigma0 + majority) >>> 0; h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0; }
		h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
	}
	return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function newFoundationUuid(): string {
	const cryptoApi = globalThis.crypto;
	if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
	if (!cryptoApi?.getRandomValues) throw new Error("Foundation UUID generation requires a secure random source");
	const bytes = new Uint8Array(16);
	cryptoApi.getRandomValues(bytes);
	bytes[6] = bytes[6]! & 0x0f | 0x40; bytes[8] = bytes[8]! & 0x3f | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newFoundationId(prefix: string): string {
	if (prefix.length === 0 || /[^a-z0-9-]/.test(prefix)) throw new TypeError(`Invalid foundation id prefix: ${JSON.stringify(prefix)}`);
	return `${prefix}_${newFoundationUuid()}`;
}

export const FOUNDATION_ID_PREFIXES = {
	role: "role",
	roleRevision: "role_revision",
	modelProfile: "model_profile",
	modelProfileRevision: "model_profile_revision",
	binding: "binding",
	bindingEpoch: "binding_epoch",
	agentInstance: "agent_instance",
	task: "task",
	dispatch: "dispatch",
	attempt: "attempt",
	attemptReceipt: "attempt_receipt",
	workerReceipt: "worker_receipt",
	taskResult: "task_result",
	runReceipt: "run_receipt",
	artifact: "artifact",
} as const;
