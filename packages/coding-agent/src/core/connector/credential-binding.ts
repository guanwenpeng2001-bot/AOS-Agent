import { fingerprintFoundationValue, type AgentBinding, type Attempt } from "@aos-agent/agent-core";
import type { ExternalConnectorRegistry } from "./registry.ts";
import type { ExternalConnectorResolvedTarget } from "./target-config.ts";
import type {
	ExternalConnectorCredentialRuntime,
	ExternalConnectorCredentialService,
} from "./durable-connector.ts";
import type {
	TaskCredentialDeliveredLeaseReference,
	TaskCredentialDeliveredLeaseReleaseInput,
	TaskCredentialRunIssueContext,
	TaskCredentialService,
} from "../policy/task-credential-service.ts";

export type ExternalConnectorCredentialIssueContextResolver = (
	attempt: Attempt,
	binding: AgentBinding,
) => TaskCredentialRunIssueContext | undefined;

export interface ExternalConnectorCredentialBinding {
	readonly runtime: ExternalConnectorCredentialRuntime;
	bindService(service: TaskCredentialService): () => void;
}

const REGISTRY_CREDENTIAL_BINDINGS = new WeakMap<ExternalConnectorRegistry, ExternalConnectorCredentialBinding>();

function unavailableService(): ExternalConnectorCredentialService {
	const unavailable: ExternalConnectorCredentialService = {
		issueForTaskRun: (_context: TaskCredentialRunIssueContext) => ({
			ok: false,
			code: "task_credential_target_unavailable",
		}),
		lookupDeliveredLease: (_input: TaskCredentialDeliveredLeaseReference) => ({
			ok: false,
			code: "task_credential_target_unavailable",
		}),
		releaseDeliveredLease: (_input: TaskCredentialDeliveredLeaseReleaseInput) => ({
			ok: false,
			code: "task_credential_target_unavailable",
		}),
	};
	return Object.freeze(unavailable);
}

export function createExternalConnectorCredentialBinding(options: {
	readonly target: ExternalConnectorResolvedTarget;
	readonly resolveIssueContext: ExternalConnectorCredentialIssueContextResolver;
}): ExternalConnectorCredentialBinding {
	let service: ExternalConnectorCredentialService = unavailableService();
	let boundService: TaskCredentialService | undefined;
	const target = options.target;
	const sandboxBindingId = `external_credential_target_${fingerprintFoundationValue({
		targetId: target.targetId,
		providerId: target.providerId,
		selectionRevision: target.selectionRevision,
	}).value.slice(0, 48)}`;
	const runtimeService: ExternalConnectorCredentialService = {
		issueForTaskRun: (context: TaskCredentialRunIssueContext) => service.issueForTaskRun(context),
		lookupDeliveredLease: (input: TaskCredentialDeliveredLeaseReference) => service.lookupDeliveredLease(input),
		releaseDeliveredLease: (input: TaskCredentialDeliveredLeaseReleaseInput) =>
			service.releaseDeliveredLease(input),
	};
	const runtime: ExternalConnectorCredentialRuntime = Object.freeze({
		service: Object.freeze(runtimeService),
		resolveIssueContext: (attempt: Attempt, binding: AgentBinding) => {
			const context = options.resolveIssueContext(attempt, binding);
			if (context === undefined) return undefined;
			return Object.freeze({
				...context,
				targetId: target.targetId,
				targetKind: "external_connector",
				targetLifecycle: "external_connector",
				sandboxBindingId,
			});
		},
	});
	const credentialBinding: ExternalConnectorCredentialBinding = {
		runtime,
		bindService: (candidate: TaskCredentialService) => {
			if (boundService !== undefined && boundService !== candidate) {
				throw new TypeError("External Connector credential binding already belongs to another Session service");
			}
			boundService = candidate;
			service = candidate;
			let released = false;
			return () => {
				if (released || boundService !== candidate) return;
				released = true;
				boundService = undefined;
				service = unavailableService();
			};
		},
	};
	return Object.freeze(credentialBinding);
}

export function bindExternalConnectorCredentialRegistry(
	registry: ExternalConnectorRegistry,
	binding: ExternalConnectorCredentialBinding,
): void {
	const existing = REGISTRY_CREDENTIAL_BINDINGS.get(registry);
	if (existing !== undefined && existing !== binding) {
		throw new TypeError("External Connector registry already has another credential authority");
	}
	REGISTRY_CREDENTIAL_BINDINGS.set(registry, binding);
}

export function getExternalConnectorCredentialBinding(
	registry: ExternalConnectorRegistry | undefined,
): ExternalConnectorCredentialBinding | undefined {
	return registry === undefined ? undefined : REGISTRY_CREDENTIAL_BINDINGS.get(registry);
}
