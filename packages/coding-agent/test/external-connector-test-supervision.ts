import {
	InMemorySessionStorage,
	Result,
	Session,
	SessionLedger,
	ContextLedger,
	type ConnectorCapabilitySnapshot,
	type ExternalAgentConnector,
} from "@aos-agent/agent-core";
import { createDurableExternalAgentConnector } from "../src/core/external-agent-connector.ts";
import { SessionExternalConnectorDurableStore } from "../src/core/external-agent-operation.ts";
import type {
	ExternalConnectorProcessController,
	ExternalConnectorProcessHandle,
	ExternalConnectorProcessIdentity,
	ExternalConnectorProcessLaunchRequest,
	ExternalConnectorProcessReattachResult,
	ExternalConnectorProcessTerminationRequest,
	ExternalConnectorProcessTerminationResult,
	ExternalConnectorProcessTerminationOptions,
	ExternalConnectorSupervisorDeadlineOverrides,
	ExternalConnectorSupervisorPrivateState,
} from "../src/core/external-connector-supervisor.ts";
import {
	externalConnectorProcessContainment,
	InMemoryExternalConnectorSupervisorPrivateStateStore,
} from "../src/core/external-connector-supervisor.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../src/core/vendor-drivers/types.ts";

let registrationRuntimeId = 0;

class RegistrationOnlyDriver implements ExternalConnectorVendorDriver {
	async spawn(): Promise<ExternalConnectorDriverHandle> {
		throw new Error("registration-only driver");
	}
	async *events(): AsyncIterable<never> {}
	async connect(): Promise<ExternalConnectorDriverHandle> {
		throw new Error("registration-only driver");
	}
	async lookup(): Promise<ExternalConnectorDriverLookup> {
		return { status: "missing" };
	}
	async read(): Promise<ExternalConnectorTerminalEvidence> {
		throw new Error("registration-only driver");
	}
	async write(): Promise<void> {}
	async heartbeat(): Promise<void> {}
	async cancel(): Promise<undefined> {
		return undefined;
	}
	async dispose(): Promise<void> {}
}

class TestProcessHandle implements ExternalConnectorProcessHandle {
	readonly operationNonce: string;
	readonly detached = false as const;
	readonly containment: "process_group" | "job_object";
	readonly identity: ExternalConnectorProcessIdentity;
	readonly exited: Promise<void>;
	readonly #onActivate: () => void;
	readonly #onForce: () => boolean;
	#activated = false;
	#resolveExit: (() => void) | undefined;

	constructor(
		request: ExternalConnectorProcessLaunchRequest,
		identity: ExternalConnectorProcessIdentity,
		onActivate: () => void,
		onForce: () => boolean,
	) {
		this.operationNonce = request.operationNonce;
		this.containment = request.containment;
		this.identity = identity;
		this.#onActivate = onActivate;
		this.#onForce = onForce;
		this.exited = new Promise<void>((resolve) => {
			this.#resolveExit = resolve;
		});
	}

	async activate(): Promise<void> {
		if (this.#activated) return;
		this.#activated = true;
		this.#onActivate();
	}

	forceTerminate(request: ExternalConnectorProcessTerminationRequest): ExternalConnectorProcessTerminationResult {
		if (
			request.operationNonce !== this.operationNonce ||
			request.processIdentity.pid !== this.identity.pid ||
			request.processIdentity.startToken !== this.identity.startToken ||
			request.processIdentity.executableIdentity !== this.identity.executableIdentity ||
			request.processIdentity.fileIdentity !== this.identity.fileIdentity
		) {
			return "identity_mismatch";
		}
		if (this.#onForce()) {
			this.#resolveExit?.();
			this.#resolveExit = undefined;
		}
		return "termination_requested";
	}

	forceTerminateBounded(
		request: ExternalConnectorProcessTerminationRequest,
		options: ExternalConnectorProcessTerminationOptions,
	): Promise<ExternalConnectorProcessTerminationResult> {
		if (options.signal?.aborted === true) return Promise.resolve("ambiguous");
		return Promise.resolve(this.forceTerminate(request));
	}

	resolveExit(): void {
		this.#resolveExit?.();
		this.#resolveExit = undefined;
	}
}

export class TestExternalConnectorPrivateStateStore extends InMemoryExternalConnectorSupervisorPrivateStateStore {
	failDeletes = 0;
	failLists = 0;
	failReads = 0;
	failWrites = 0;
	writeGate: Promise<void> | undefined;
	onWrite: (() => void) | undefined;

	override async list() {
		if (this.failLists > 0) {
			this.failLists -= 1;
			throw new Error("injected private identity list failure");
		}
		return super.list();
	}

	override async read(attemptId: string): Promise<ExternalConnectorSupervisorPrivateState | undefined> {
		if (this.failReads > 0) {
			this.failReads -= 1;
			throw new Error("injected private identity read failure");
		}
		return super.read(attemptId);
	}

	override async write(attemptId: string, state: ExternalConnectorSupervisorPrivateState): Promise<void> {
		this.onWrite?.();
		if (this.writeGate !== undefined) await this.writeGate;
		if (this.failWrites > 0) {
			this.failWrites -= 1;
			throw new Error("injected private identity persistence failure");
		}
		await super.write(attemptId, state);
	}

	override async delete(attemptId: string): Promise<void> {
		if (this.failDeletes > 0) {
			this.failDeletes -= 1;
			throw new Error("injected private identity delete failure");
		}
		await super.delete(attemptId);
	}
}

export class TestExternalConnectorProcessController implements ExternalConnectorProcessController {
	readonly handles = new Map<number, TestProcessHandle>();
	launchCalls = 0;
	activationCalls = 0;
	forceCalls = 0;
	forceExits = true;
	launchGate: Promise<void> | undefined;
	onLaunch: (() => void) | undefined;
	reattachResult: ExternalConnectorProcessReattachResult | undefined;
	#nextPid = 20_000;

	async launch(request: ExternalConnectorProcessLaunchRequest): Promise<ExternalConnectorProcessHandle> {
		this.launchCalls += 1;
		const pid = this.#nextPid++;
		const handle = new TestProcessHandle(
			request,
			{
				pid,
				startToken: `start-${pid}`,
				executableIdentity: "fixture-executable",
				fileIdentity: "fixture-file",
			},
			() => {
				this.activationCalls += 1;
			},
			() => {
				this.forceCalls += 1;
				return this.forceExits;
			},
		);
		this.handles.set(pid, handle);
		this.onLaunch?.();
		if (this.launchGate !== undefined) await this.launchGate;
		return handle;
	}

	reattach(
		identity: ExternalConnectorProcessIdentity,
		request: ExternalConnectorProcessLaunchRequest,
	): ExternalConnectorProcessReattachResult {
		if (this.reattachResult !== undefined) return this.reattachResult;
		const handle = this.handles.get(identity.pid);
		if (handle === undefined) return { status: "not_found" };
		if (
			handle.operationNonce !== request.operationNonce ||
			handle.identity.startToken !== identity.startToken ||
			handle.identity.executableIdentity !== identity.executableIdentity ||
			handle.identity.fileIdentity !== identity.fileIdentity
		) {
			return { status: "identity_mismatch" };
		}
		return { status: "attached", handle };
	}

	resolveExits(): void {
		for (const handle of this.handles.values()) handle.resolveExit();
	}
}

export function createExternalConnectorTestSupervision(
	deadlines: ExternalConnectorSupervisorDeadlineOverrides = {},
) {
	const processController = new TestExternalConnectorProcessController();
	const privateStateStore = new TestExternalConnectorPrivateStateStore();
	const containment = externalConnectorProcessContainment();
	return {
		processController,
		privateStateStore,
		options: {
			containment,
			processController,
			privateStateStore,
			deadlines: {
				start: { hardMs: 1_000, idleMs: 1_000, ...deadlines.start },
				event: { hardMs: 1_000, idleMs: 1_000, ...deadlines.event },
				receipt: { hardMs: 1_000, idleMs: 1_000, ...deadlines.receipt },
				cancel: { hardMs: 1_000, idleMs: 1_000, ...deadlines.cancel },
				dispose: { hardMs: 10, idleMs: 10, ...deadlines.dispose },
			},
		},
	};
}

/** Host-supervised runtime for composition fixtures that only exercise registration and discovery. */
export function createExternalConnectorTestRuntime(snapshot: ConnectorCapabilitySnapshot): ExternalAgentConnector {
	registrationRuntimeId += 1;
	const fixtureId = registrationRuntimeId;
	const session = new Session(
		new InMemorySessionStorage({ id: `connector-registry-${fixtureId}`, createdAt: fixtureId }),
	);
	const ledger = new ContextLedger(session, { ownerId: `connector-registry-${fixtureId}` });
	return createDurableExternalAgentConnector({
		providerId: snapshot.providerId,
		capability: snapshot,
		capabilityProbe: async () => Result.ok(snapshot),
		store: new SessionExternalConnectorDurableStore(new SessionLedger(session, { writer: ledger.writer })),
		driver: new RegistrationOnlyDriver(),
		supervision: createExternalConnectorTestSupervision().options,
		operationNonce: () => `connector-registry-nonce-${fixtureId}`,
	});
}
