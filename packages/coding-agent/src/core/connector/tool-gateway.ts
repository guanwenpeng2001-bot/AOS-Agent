import {
	createFoundationToolGatewayAuthority,
	FoundationToolGatewayAuthority,
	Result,
	type ToolGateway,
	type ToolGatewayRequest,
	type ToolGatewayRoute,
} from "../../../../agent/src/internal.ts";

/** Policy authority owned by the canonical AgentSession composition. */
export interface ExternalToolGatewayPolicyAuthority {
	authorizeExternalToolGatewayRequest(request: ToolGatewayRequest, route: ToolGatewayRoute): Promise<void>;
}

/** Build the only Tool Gateway exposed to an External Connector registry. */
export function createCanonicalExternalToolGateway(gateway: ToolGateway): FoundationToolGatewayAuthority {
	return createFoundationToolGatewayAuthority({ gateway });
}

/** Bind the resolver-owned policy authority after the Session control plane exists. */
export function bindCanonicalExternalToolGatewayPolicy(
	gateway: ToolGateway | undefined,
	policy: ExternalToolGatewayPolicyAuthority,
): void {
	if (!(gateway instanceof FoundationToolGatewayAuthority)) return;
	gateway.setAuthorizer({
		authorize: async (request, route) => {
			await policy.authorizeExternalToolGatewayRequest(request, route);
			return Result.ok(true);
		},
	});
}
