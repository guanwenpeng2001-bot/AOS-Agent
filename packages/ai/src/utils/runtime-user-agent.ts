import type * as NodeOs from "node:os";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) return null;
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

const nodeOs = loadNodeOs();

export function getRuntimeUserAgent(product: string): string {
	return nodeOs ? `${product} (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : `${product} (browser)`;
}
