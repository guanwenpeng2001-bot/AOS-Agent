import { RealFSProvider, VM } from "@earendil-works/gondolin";
import {
	GONDOLIN_GUEST_WORKSPACE,
	closeGondolinVm,
	probeGondolinVm,
	type GondolinVmFactory,
	type GondolinVmLike,
} from "./vm-types.ts";

export {
	GONDOLIN_GUEST_WORKSPACE,
	closeGondolinVm,
	gondolinExecResult,
	probeGondolinVm,
	type GondolinGuestExecChunk,
	type GondolinGuestExecProcess,
	type GondolinGuestExecResult,
	type GondolinGuestFilesystem,
	type GondolinVmFactory,
	type GondolinVmFactoryOptions,
	type GondolinVmLike,
} from "./vm-types.ts";

const DEFAULT_SESSION_LABEL = "aos-agent-gondolin";

function abortError(): DOMException {
	return new DOMException("Sandbox operation aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError();
}

/**
 * Build the production Gondolin VM factory. VM creation and the guest probe
 * are kept behind this seam so contract tests never need QEMU.
 */
export function createGondolinVmFactory(): GondolinVmFactory {
	return async (options) => {
		throwIfAborted(options.signal);
		let vm: GondolinVmLike | undefined;
		try {
			vm = await VM.create({
				sessionLabel: options.sessionLabel ?? DEFAULT_SESSION_LABEL,
				allowWebSockets: false,
				sandbox: { netEnabled: false, allowWebSockets: false },
				vfs: {
					mounts: {
						[GONDOLIN_GUEST_WORKSPACE]: new RealFSProvider(options.workspaceRoot),
					},
				},
			});
			await probeGondolinVm(vm, options.signal);
			return vm;
		} catch (error) {
			if (vm !== undefined) await closeGondolinVm(vm).catch(() => undefined);
			throw error;
		}
	};
}
