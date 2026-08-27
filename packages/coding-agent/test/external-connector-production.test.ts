import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnectorCapabilitySnapshot } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import { DurableExternalAgentConnector } from "../src/core/external-agent-connector.ts";
import type { ExternalConnectorDurableStore } from "../src/core/external-agent-operation.ts";
import { ProductionExternalConnectorProcessController } from "../src/core/external-connector-process-controller.ts";
import {
	createProductionExternalAgentConnector,
	createProductionExternalConnectorSupervision,
} from "../src/core/external-connector-production.ts";
import {
	FileExternalConnectorSupervisorPrivateStateStore,
	externalConnectorProcessContainment,
} from "../src/core/external-connector-supervisor.ts";
import type { ExternalConnectorVendorDriver } from "../src/core/vendor-drivers/types.ts";

const processOptions = {
	executablePath: process.execPath,
	arguments: ["-e", "setInterval(function(){},2147483647)"],
} as const;

describe("production External Connector composition", () => {
	it("wires the host controller and File private-state store instead of injectable test supervision", () => {
		const supervision = createProductionExternalConnectorSupervision({
			privateStatePath: join(tmpdir(), `aos-external-production-${process.pid}.json`),
			process: processOptions,
		});
		expect(supervision.containment).toBe(externalConnectorProcessContainment());
		expect(supervision.processController).toBeInstanceOf(ProductionExternalConnectorProcessController);
		expect(supervision.privateStateStore).toBeInstanceOf(FileExternalConnectorSupervisorPrivateStateStore);
	});

	it("creates the production connector through that supervision composition", () => {
		const connector = createProductionExternalAgentConnector({
			providerId: "production-connector",
			capability: createConnectorCapabilitySnapshot({
				schemaVersion: 1,
				providerId: "production-connector",
				revision: 1,
				protocol: { name: "production-protocol", version: "1" },
				modelAccess: "agent_owned",
				resume: true,
				toolGateway: false,
				artifacts: false,
				images: false,
			}),
			store: Object.freeze({}) as ExternalConnectorDurableStore,
			driver: Object.freeze({}) as ExternalConnectorVendorDriver,
			privateStatePath: join(tmpdir(), `aos-external-production-factory-${process.pid}.json`),
			process: processOptions,
		});
		expect(connector).toBeInstanceOf(DurableExternalAgentConnector);
	});
});
