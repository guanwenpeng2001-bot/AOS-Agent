/**
 * Run modes for the coding agent.
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export type {
	CapabilityBindingView,
	CapabilityCatalogView,
	CapabilityDescriptorView,
} from "./interactive/capabilities.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export {
	AutomationRpcError,
	type ModelInfo,
	RpcClient,
	type RpcClientOptions,
	type RpcEventListener,
	type RpcRunEventListener,
	type RpcRunStreamEvent,
} from "./rpc/rpc-client.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export type {
	AutomationError,
	AutomationErrorCode,
	InitializeData,
	RpcAutomationCommandType,
	RpcAutomationResponse,
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
