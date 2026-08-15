/**
 * Run modes for the coding agent.
 */

export type {
	CapabilityBindingView,
	CapabilityCatalogView,
	CapabilityDescriptorView,
} from "./interactive/capabilities.ts";
export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export {
	AutomationRpcError,
	type ModelInfo,
	RpcClient,
	type RpcClientOptions,
	type RpcClientTcpOptions,
	type RpcClientTransportOptions,
	type RpcEventListener,
	type RpcRunEventListener,
	type RpcRunStreamEvent,
} from "./rpc/rpc-client.ts";
export {
	RPC_TRANSPORT_LOOPBACK_HOST,
	RPC_TRANSPORT_PORT_MAX,
	RPC_TRANSPORT_PORT_MIN,
	RpcTransportAddressError,
	formatRpcTransportAddress,
	parseRpcTransportAddress,
	validateRpcTransportAddress,
	type RpcTransportAddress,
	type RpcTransportAddressErrorCode,
	type RpcTransportAddressParseResult,
	type TcpRpcAddress,
} from "./rpc/rpc-transport-address.ts";
export {
	RpcTransport,
	RpcTransportError,
	createRpcTransport,
	createTcpRpcTransport,
	type RpcTransportConnection,
	type RpcTransportDispatcher,
	type RpcTransportErrorCode,
	type RpcTransportErrorRecord,
	type RpcTransportOptions,
	type RpcTransportSink,
} from "./rpc/rpc-transport.ts";
export { runRpcMode, type RpcModeOptions } from "./rpc/rpc-mode.ts";
export {
	createRpcHostController,
	RpcHostController,
	type RpcHostControllerOptions,
	type RpcOutputSink,
	type RpcWireRecord,
	type RpcHostOutputRecord,
	type RpcHostOutputSink,
} from "./rpc/rpc-host.ts";
export type {
	AuditEvent,
	AuditEventType,
	AuditQuery,
	AuditQueryData,
	AuditQueryResult,
	AuditReplayData,
	AuditReplayQuery,
	AuditReplayResult,
	AuditWarning,
	AutomationError,
	AutomationErrorCode,
	ExternalExecutionMapping,
	ExternalExecutionRef,
	ExternalMapData,
	ExternalMappingSummary,
	ExternalMappingPersistenceResult,
	ExternalMappingRequest,
	GetExecutionPolicyData,
	GetModelRoutesData,
	InitializeData,
	RpcAutomationCommandType,
	RpcAutomationResponse,
	RpcAuditCommandType,
	RpcAuditQueryCommand,
	RpcAuditReplayCommand,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcRunCommandType,
	RpcSessionState,
	RunAcceptedData,
	RunCancelData,
	RunGetData,
	RunReceipt,
	RunRecord,
	RunRecoveryState,
	RunStatus,
	RunStreamEvent,
	RunTerminalStatus,
} from "./rpc/rpc-types.ts";
