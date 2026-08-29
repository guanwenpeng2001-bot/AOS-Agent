import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { ProductionExternalConnectorProcessController } from "../../src/core/connector/process-controller.ts";
import {
	ExternalConnectorBoundedSupervisor,
	FileExternalConnectorSupervisorPrivateStateStore,
	externalConnectorProcessContainment,
} from "../../src/core/connector/supervisor.ts";

const [privateStatePath, targetPidPath, readyPath] = process.argv.slice(2);
if (privateStatePath === undefined || targetPidPath === undefined || readyPath === undefined) {
	throw new TypeError("hard-crash fixture paths are required");
}

const operationNonce = "hard-crash-operation-nonce";
const controller = new ProductionExternalConnectorProcessController({
	process: {
		executablePath: process.execPath,
		arguments: [
			"-e",
			"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(function(){},2147483647)",
			targetPidPath,
		],
	},
});
const supervisor = new ExternalConnectorBoundedSupervisor({
	reference: {
		schemaVersion: 1,
		supervisorRef: "hard-crash-supervisor",
		operationNonce,
	},
	containment: externalConnectorProcessContainment(),
	processController: controller,
	artifactsAllowed: false,
	deadlines: { dispose: { hardMs: 10_000, idleMs: 10_000 } },
});
const privateStateStore = new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath);
const state = await supervisor.launch((value) => privateStateStore.write("hard-crash-attempt", value));
for (let index = 0; index < 100 && !existsSync(targetPidPath); index++) await delay(50);
if (!existsSync(targetPidPath)) throw new Error("contained companion did not start");
writeFileSync(
	readyPath,
	JSON.stringify({ guardianPid: state.processIdentity.pid, targetPid: Number(readFileSync(targetPidPath, "utf8")) }),
);
process.kill(process.pid, "SIGKILL");
