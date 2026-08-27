import type {
	ExternalConnectorProcessController,
	ExternalConnectorProcessHandle,
	ExternalConnectorProcessIdentity,
	ExternalConnectorProcessLaunchRequest,
	ExternalConnectorProcessReattachResult,
	ExternalConnectorProcessTerminationRequest,
	ExternalConnectorProcessTerminationResult,
	ExternalConnectorSupervisorPrivateState,
} from "../src/core/external-connector-supervisor.ts";
import {
	externalConnectorProcessContainment,
	InMemoryExternalConnectorSupervisorPrivateStateStore,
} from "../src/core/external-connector-supervisor.ts";

class TestProcessHandle implements ExternalConnectorProcessHandle {
	readonly operationNonce: string;
	readonly detached = false as const;
	readonly containment: "process_group" | "job_object";
	readonly identity: ExternalConnectorProcessIdentity;
	readonly exited: Promise<void>;
	readonly #onForce: () => boolean;
	#resolveExit: (() => void) | undefined;

	constructor(
		request: ExternalConnectorProcessLaunchRequest,
		identity: ExternalConnectorProcessIdentity,
		onForce: () => boolean,
	) {
		this.operationNonce = request.operationNonce;
		this.containment = request.containment;
		this.identity = identity;
		this.#onForce = onForce;
		this.exited = new Promise<void>((resolve) => {
			this.#resolveExit = resolve;
		});
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
}

export class TestExternalConnectorPrivateStateStore extends InMemoryExternalConnectorSupervisorPrivateStateStore {
	failWrites = 0;

	override async write(attemptId: string, state: ExternalConnectorSupervisorPrivateState): Promise<void> {
		if (this.failWrites > 0) {
			this.failWrites -= 1;
			throw new Error("injected private identity persistence failure");
		}
		await super.write(attemptId, state);
	}
}

export class TestExternalConnectorProcessController implements ExternalConnectorProcessController {
	readonly handles = new Map<number, TestProcessHandle>();
	launchCalls = 0;
	forceCalls = 0;
	forceExits = true;
	#nextPid = 20_000;

	launch(request: ExternalConnectorProcessLaunchRequest): ExternalConnectorProcessHandle {
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
				this.forceCalls += 1;
				return this.forceExits;
			},
		);
		this.handles.set(pid, handle);
		return handle;
	}

	reattach(
		identity: ExternalConnectorProcessIdentity,
		request: ExternalConnectorProcessLaunchRequest,
	): ExternalConnectorProcessReattachResult {
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
}

export function createExternalConnectorTestSupervision() {
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
				start: { hardMs: 1_000, idleMs: 1_000 },
				event: { hardMs: 1_000, idleMs: 1_000 },
				receipt: { hardMs: 1_000, idleMs: 1_000 },
				cancel: { hardMs: 1_000, idleMs: 1_000 },
				dispose: { hardMs: 10, idleMs: 10 },
			},
		},
	};
}
