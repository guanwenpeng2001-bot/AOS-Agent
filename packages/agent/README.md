# @aos-agent/agent-core

Stateful agent with tool execution and event streaming. Built on `@aos-agent/ai`.

## Installation

```bash
npm install @aos-agent/agent-core
```

### SQLite session backends

The SQLite session backend and the `node:sqlite` adapter live in a separate package, `@aos-agent/session-backend-sqlite-node`, so the core package does not pull in runtime builtins or native SQLite dependencies by default. The backend accepts a runtime-specific SQLite factory, allowing other session backends to ship as their own packages in the future.

## Quick Start

```typescript
import { Agent } from "@aos-agent/agent-core";
import { createModels } from "@aos-agent/ai";
import { anthropicProvider } from "@aos-agent/ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model,
  },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // Stream just the new text chunk
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```

## Core Concepts

### AgentMessage vs LLM Message

The agent works with `AgentMessage`, a flexible type that can include:
- Standard LLM messages (`user`, `assistant`, `toolResult`)
- Custom app-specific message types via declaration merging

LLMs only understand `user`, `assistant`, and `toolResult`. The `convertToLlm` function bridges this gap by filtering and transforming messages before each LLM call.

### Message Flow

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (optional)                           (required)
```

1. **transformContext**: Prune old messages, inject external context
2. **convertToLlm**: Filter out UI-only messages, convert custom types to LLM format

## Event Flow

The agent emits events for UI updates. Understanding the event sequence helps build responsive interfaces.

### prompt() Event Sequence

When you call `prompt("Hello")`:

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // Your prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM starts responding
├─ message_update  { message: partial... }       // Streaming chunks
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // Complete response
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### With Tool Calls

If the assistant calls tools, the loop continues:

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // If tool streams
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // Next turn
├─ message_start      { assistantMessage }           // LLM responds to tool result
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

Tool execution mode is configurable:

- `parallel` (default): preflight tool calls sequentially, execute allowed tools concurrently, emit `tool_execution_end` as soon as each tool is finalized, then emit toolResult messages and `turn_end.toolResults` in assistant source order
- `sequential`: execute tool calls one by one, matching the historical behavior

In parallel mode, tool completion events follow tool completion order, but persisted toolResult messages still follow assistant source order.

The mode can be set globally via `toolExecution` in the agent config, or per-tool via `executionMode` on `AgentTool`. If any tool call in a batch targets a tool with `executionMode: "sequential"`, the entire batch executes sequentially regardless of the global setting.

The `beforeToolCall` hook runs after `tool_execution_start` and validated argument parsing. It can block execution and attach `terminate: true` to the blocked result. The `afterToolCall` hook runs after tool execution finishes and before `tool_execution_end` and final tool result message events are emitted.

Tools, blocked `beforeToolCall` results, and `afterToolCall` overrides can return `terminate: true` to hint that the automatic follow-up LLM call should be skipped. The loop only stops early when every finalized tool result in that batch sets `terminate: true`. Mixed batches continue normally.

The `Agent` class accepts `shouldStopAfterTurn` in `AgentOptions`. Low-level loop callers can set the same hook in `AgentLoopConfig`:

```typescript
const stream = agentLoop(
  prompts,
  context,
  {
    model,
    convertToLlm,
    shouldStopAfterTurn: async ({ message, toolResults, context, newMessages }) => {
      return shouldCompactBeforeNextTurn(context.messages);
    },
  },
  undefined,
  models.streamSimple.bind(models),
);
```

`shouldStopAfterTurn` runs after `turn_end` is emitted and after the assistant response and any tool executions have completed normally. If it returns `true`, the loop emits `agent_end` and exits before polling steering or follow-up queues, and before starting another LLM call. It does not abort the provider stream, does not cancel running tools, and does not alter the assistant message stop reason. The `AgentOptions` callback also receives the active run's `AbortSignal` as its second argument.

When you use the `Agent` class, assistant `message_end` processing is treated as a barrier before tool preflight begins. That means `beforeToolCall` sees agent state that already includes the assistant message that requested the tool call.

### continue() Event Sequence

`continue()` resumes from existing context without adding a new message. Use it for retries after errors.

```typescript
// After an error, retry from current state
await agent.continue();
```

The last message in context must be `user` or `toolResult` (not `assistant`).

### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent begins processing |
| `agent_end` | Final event for the run. Awaited subscribers for this event still count toward settlement |
| `turn_start` | New turn begins (one LLM call + tool executions) |
| `turn_end` | Turn completes with assistant message and tool results |
| `message_start` | Any message begins (user, assistant, toolResult) |
| `message_update` | **Assistant only.** Includes `assistantMessageEvent` with delta |
| `message_end` | Message completes |
| `tool_execution_start` | Tool begins |
| `tool_execution_update` | Tool streams progress |
| `tool_execution_end` | Tool completes |

`Agent.subscribe()` listeners are awaited in registration order. `agent_end` means no more loop events will be emitted, but `await agent.waitForIdle()` and `await agent.prompt(...)` only settle after awaited `agent_end` listeners finish.

The loop is bounded by default. `maxIterations` protects against unbounded provider turns, repeated tool-call fingerprints stop duplicate calls, and unchanged progress tokens stop dead loops. When a convergence bound stops a run, `agent_end.terminationReason` is `max_iterations`, `duplicate_tool_call`, or `dead_loop`.

### Production error categories and retry safety

The production loop classifies failures into stable categories:

- `transient_provider`: a provider or transport failure that may be retried when the outcome is known to be safe.
- `permission_or_parameter`: permission, schema, or parameter validation rejected the operation; do not retry unchanged input.
- `side_effect_unknown`: the operation may have reached a tool, MCP server, sandbox, or provider before failing; the outcome must be reconciled before another attempt.
- `cancelled`: the caller aborted the operation.
- `deadline`: the operation exceeded its deadline.
- `unknown`: a failure that does not match a stable category.

Classifications also expose a stable operation (`model`, `tool`, `mcp`, or `sandbox`), phase, side-effect state, and `safeToRetry`/`retryable` flags. The exported error codes are `provider_unavailable`, `permission_denied`, `invalid_request`, `side_effect_unknown`, `cancelled`, `deadline_exceeded`, and `lease_expired`; an unclassified failure may have no stable code.

Retries are bounded and apply only when a retry policy is enabled. A transient provider failure is retryable only before visible output and when no side effect is possible. Model retries use that rule directly; tool, MCP, and sandbox retries additionally require an explicit safe replay decision. Permission/parameter failures, cancellation, deadlines, unknown failures, and any `side_effect_unknown` result are terminal for automatic retry. Never blindly retry after `side_effect_unknown`; inspect or reconcile the external operation first because repeating it may duplicate a side effect.

Higher-level connector retry circuits must preserve this boundary: even an
otherwise idempotent or resumable operation records a terminal stop decision
when its durable side-effect state is `side_effect_unknown`.

## Agent Options

```typescript
const agent = new Agent({
  // Initial state
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // Convert AgentMessage[] to LLM Message[] (required for custom message types)
  convertToLlm: (messages) => messages.filter(...),

  // Transform context before convertToLlm (for pruning, compaction)
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // Steering mode: "one-at-a-time" (default) or "all"
  steeringMode: "one-at-a-time",

  // Follow-up mode: "one-at-a-time" (default) or "all"
  followUpMode: "one-at-a-time",

  // Required stream function
  streamFn: models.streamSimple.bind(models),

  // Session ID for provider caching
  sessionId: "session-123",

  // Dynamic API key resolution (for expiring OAuth tokens)
  getApiKey: async (provider) => refreshToken(),

  // Tool execution mode: "parallel" (default) or "sequential"
  toolExecution: "parallel",

  // Bound provider/tool turns and stop repeated or dead loops.
  loopConvergence: {
    maxIterations: 100,
    maxDuplicateToolCalls: 3,
    maxNoProgressIterations: 5,
  },

  // Optional operation deadline. Use one form; deadlineAt takes precedence.
  deadlineMs: 60_000,
  // deadlineAt: Date.now() + 60_000,

  // Preflight each tool call after args are validated. Can block execution.
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash is disabled", terminate: true };
    }
  },

  // Postprocess each tool result before final tool events are emitted.
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },

  // Stop gracefully after a completed turn, before queued messages are polled.
  shouldStopAfterTurn: async ({ context }, signal) => {
    return shouldCompactBeforeNextTurn(context.messages, signal);
  },

  // Custom thinking budgets for token-based providers
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

## Agent State

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

Access state via `agent.state`.

Assigning `agent.state.tools = [...]` or `agent.state.messages = [...]` copies the top-level array before storing it. Mutating the returned array mutates the current agent state.

During streaming, `agent.state.streamingMessage` contains the current partial assistant message.

`agent.state.isStreaming` remains `true` until the run fully settles, including awaited `agent_end` subscribers.

## Methods

### Prompting

```typescript
// Text prompt
await agent.prompt("Hello");

// With images
await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// AgentMessage directly
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// Continue from current context (last message must be user or toolResult)
await agent.continue();
```

### State Management

```typescript
agent.state.systemPrompt = "New prompt";
agent.state.model = getModel("openai", "gpt-4o");
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.loopConvergence = { maxIterations: 100, maxDuplicateToolCalls: 3 };
agent.deadlineMs = 60_000;
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.shouldStopAfterTurn = async ({ context }) => shouldCompactBeforeNextTurn(context.messages);
agent.state.messages = newMessages; // top-level array is copied
agent.state.messages.push(message);
agent.reset();
```

### Session and Thinking Budgets

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### Control

```typescript
agent.abort();           // Cancel current operation
await agent.waitForIdle(); // Wait for completion
```

### Events

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    // Final barrier work for the run
    await flushSessionState(signal);
  }
});
unsubscribe();
```

## Steering and Follow-up

Steering messages let you interrupt the agent while tools are running. Follow-up messages let you queue work after the agent would otherwise stop.

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// While agent is running tools
agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

// After the agent finishes its current work
agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

Use clearSteeringQueue, clearFollowUpQueue, or clearAllQueues to drop queued messages.

When steering messages are detected after a turn completes:
1. All tool calls from the current assistant message have already finished
2. Steering messages are injected
3. The LLM responds on the next turn

Follow-up messages are checked only when there are no more tool calls and no steering messages. If any are queued, they are injected and another turn runs.

## Custom Message Types

Extend `AgentMessage` via declaration merging:

```typescript
declare module "@aos-agent/agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// Now valid
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

Handle custom types in `convertToLlm`:

```typescript
const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // Filter out
    return [m];
  }),
});
```

## Tools

Define tools using `AgentTool`:

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",  // For UI display
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  // Override execution mode for this tool (optional).
  // "sequential" forces the entire batch to run one at a time.
  // "parallel" allows concurrent execution with other tool calls.
  // If omitted, the global toolExecution config applies.
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // Optional: stream progress
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    // Optional: add `terminate: true` here to skip the automatic follow-up LLM call
    // when every finalized tool result in the batch does the same.
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```

### Error Handling

**Throw an error** when a tool fails. Do not return error messages as content.

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  // Return content only on success
  return { content: [{ type: "text", text: "..." }] };
}
```

Thrown errors are caught by the agent and reported to the LLM as tool errors with `isError: true`.

Return `terminate: true` from `execute()`, a blocked `beforeToolCall`, or `afterToolCall` to hint that the agent should stop after the current tool batch. This only takes effect when every finalized tool result in the batch is terminating. The hint is runtime-only; emitted `toolResult` transcript messages remain standard LLM tool results.

## Proxy Usage

For browser apps that proxy through a backend:

```typescript
import { Agent, streamProxy } from "@aos-agent/agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

## Low-Level API

For direct control without the Agent class:

```typescript
import { agentLoop, agentLoopContinue } from "@aos-agent/agent-core";

const context: AgentContext = {
  systemPrompt: "You are helpful.",
  messages: [],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",  // overridden by per-tool executionMode if set
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

const streamFn = models.streamSimple.bind(models);
for await (const event of agentLoop([userMessage], context, config, undefined, streamFn)) {
  console.log(event.type);
}

// Continue from existing context
for await (const event of agentLoopContinue(context, config, undefined, streamFn)) {
  console.log(event.type);
}
```

These low-level streams are observational. They preserve event order, but they do not wait for your async event handling to settle before later producer phases continue. If you need message processing to act as a barrier before tool preflight, use the `Agent` class instead of raw `agentLoop()` or `agentLoopContinue()`.

## Public API

### Loop and durable contracts

The following exports are the cross-package loop contract retained for
`aos-agent`. Each description names the primary consumer; lower-level
applications may also compose these contracts directly.

**`ScopedExecutionGateway`.** Executes provider work under an admitted scope; the coding-agent in-process Subagent provider consumes it.

**`validateAsk`.** Validates an Ask record before persistence; the coding-agent Ask store consumes it.

**`validateGoal`.** Validates a Goal aggregate; the coding-agent goal store consumes it.

**`validatePlan`.** Validates a Plan and its ordered stages; the coding-agent goal store consumes it.

**`validateStage`.** Validates one Stage in a Plan; the coding-agent goal store consumes it.

**`validateTaskResultRef`.** Validates a durable Task result reference; the coding-agent goal store consumes it.

**`validateTodo`.** Validates a Todo owned by a Stage; the coding-agent goal store consumes it.

**`AcceptanceCriterion`.** Describes one condition a Goal or Task must satisfy; the coding-agent orchestration store consumes it.

**`AcceptanceFact`.** Records evidence against an acceptance condition; the coding-agent scheduler, prompt adapter, and orchestration store consume it.

**`Ask`.** Represents a durable question in the orchestration loop; the coding-agent Ask store, query API, and scheduler messaging consume it.

**`AskReply`.** Represents the answer attached to an Ask; the coding-agent Ask store consumes it.

**`AskStatus`.** Enumerates the lifecycle state of an Ask; the coding-agent Ask store consumes it.

**`Goal`.** Defines the desired orchestration outcome and its acceptance contract; the coding-agent goal store and query API consume it.

**`Plan`.** Defines the staged route to a Goal; the coding-agent goal store and query API consume it.

**`PlanStatus`.** Enumerates Plan lifecycle states; the coding-agent goal store consumes it.

**`Stage`.** Defines one ordered unit of a Plan; the coding-agent goal store and query API consume it.

**`StageStatus`.** Enumerates Stage lifecycle states; the coding-agent goal store consumes it.

**`TaskResultRef`.** Points from orchestration state to a settled Task result; the coding-agent goal store consumes it.

**`Todo`.** Defines a concrete pending action within a Stage; the coding-agent goal store and query API consume it.

**`TodoStatus`.** Enumerates Todo lifecycle states; the coding-agent goal store consumes it.

**`ServiceContract`.** Describes a service requirement exposed through orchestration queries; the coding-agent query API consumes it.

**`SessionLedger`.** Provides typed fact and intent access over one canonical Session; coding-agent Connector, Scheduler, Subagent, and session services consume it.

**`LayeredResultSettlement`.** Validates and writes Dispatch, Attempt, TaskResult, and Run settlement through the canonical ledger; coding-agent Scheduler, Subagent, RPC, and runtime composition consume it.

**`persistTaskEnvelopeBeforeResolver`.** Persists an immutable Task before dependency resolution or provider effects; coding-agent product-run, prompt, and Subagent composition consume it.

**`CanonicalRunResult`.** Projects the canonical settled Run and receipt; coding-agent lifecycle, audit, Automation, and RPC surfaces consume it.

**`DispatchStartResult`.** Reports the admitted Dispatch and Attempt start state; the coding-agent Scheduler dispatch path consumes it.

**`isSideEffectRetryable`.** Decides whether an idempotency declaration permits replay for a side-effect state; coding-agent Scheduler host policy consumes it.

**`Idempotency`.** Describes an operation's replay guarantee; coding-agent Scheduler and tool-pipeline consumers use it for retry decisions.

**`SideEffectState`.** Records whether an operation had no, known, or unknown side effects; coding-agent Worker, Connector, and settlement consumers use it.

**`TaskEnvelopePublicProjectionSchema`.** Validates the safe public subset of a Task envelope; coding-agent Subagent context-fork consumes it.

**`createAttempt`.** Constructs a validated Attempt from an admitted Dispatch; coding-agent Connector, Scheduler, Subagent, and prompt ingress consume it.

**`createTaskEnvelope`.** Constructs an immutable Task envelope; coding-agent product-run, prompt, and Subagent composition consume it.

**`projectTaskEnvelope`.** Produces a safe Task projection for child context; coding-agent Subagent context-fork consumes it.

**`validateAttempt`.** Validates an Attempt before execution or settlement; coding-agent Connector, Scheduler, and Subagent consumers use it.

**`validateDispatch`.** Validates a Dispatch before execution or settlement; coding-agent Scheduler, Subagent, and AgentHarness consumers use it.

**`validateSpawnAgentIntent`.** Validates a child-agent spawn intent before settlement; the coding-agent Subagent supervisor consumes it.

**`validateTaskEnvelope`.** Validates a Task envelope and immutable references; coding-agent Scheduler, Subagent, and runtime consumers use it.

**`validateTaskEnvelopePublicProjection`.** Validates a safe child-facing Task projection; coding-agent Subagent context-fork consumes it.

**`Attempt`.** Identifies one provider execution attempt under a Dispatch; coding-agent Connector, Scheduler, and Subagent consumers use it.

**`Dispatch`.** Binds a Task, provider, and execution authority; coding-agent Connector, Scheduler, Subagent, and AgentHarness consumers use it.

**`TaskArtifactProjection`.** Describes artifacts safe to include in child context; coding-agent Subagent context-fork and fork protocol consume it.

**`TaskEnvelope`.** Carries the immutable Task contract into execution; coding-agent Scheduler, Subagent, Connector, and settlement consumers use it.

**`TaskEnvelopePublicProjection`.** Carries the safe child-facing subset of a Task; coding-agent Subagent context-fork consumes it.

**`MemoryError`.** Provides stable errors for scoped memory operations; coding-agent Subagent memory consumes it.

**`ScopedMemoryStore`.** Reads and writes memory within provenance and scope boundaries; coding-agent Subagent composition consumes it.

**`MemoryProvenanceBoundary`.** Describes the allowed provenance of scoped memory; coding-agent Subagent memory and context-ledger consumers use it.

**`bashExecutionToText`.** Converts a Bash execution message into model-facing text; repository smoke tooling consumes it.

**`convertToLlm`.** Converts Agent messages into provider messages; AgentHarness, compaction, and repository smoke tooling consume it.

**`createCompactionSummaryMessage`.** Creates the transcript message that carries a compaction summary; coding-agent session composition consumes it.

**`createCustomMessage`.** Creates a typed custom Agent message; repository smoke tooling consumes it.

**`formatPromptTemplateInvocation`.** Formats prompt-template arguments into an Agent message; AgentHarness and resource consumers use it.

**`parseCommandArgs`.** Parses command-style resource arguments; AgentHarness resource consumers and smoke tooling use it.

**`Result`.** Provides the success-or-error constructor used by Foundation operations; agent-core and coding-agent contract implementations consume it.

**`ResultValue`.** Describes the typed success-or-error value produced by Foundation operations; agent-core and coding-agent contract implementations consume it.

**`parseFoundationMutation`.** Decodes a durable Foundation mutation from storage; JSONL storage, migration, audit, and coding-agent lifecycle consumers use it.

**`DurableLedgerError`.** Provides stable durable-ledger failure codes; ledger, settlement, and coding-agent lifecycle consumers use it.

**`invalidDurableRecord`.** Constructs a stable invalid-record error without leaking raw data; durable state and coding-agent lifecycle consumers use it.

**`FoundationLedgerState`.** Folds durable Foundation records, revisions, leases, and retention in memory; agent-core storage backends and coding-agent lifecycle, storage, and audit services consume it.

**`AcquireWriterLeaseOptions`.** Configures acquisition of the ledger's single-writer lease; Session storage and coding-agent manager storage consume it.

**`AppendFoundationRecordResult`.** Reports an appended record and resulting revision; Session, ledger writer, storage, and tool-pipeline consumers use it.

**`DurableLedgerApi`.** Defines the durable record, query, lease, and retention storage interface; agent-core backends and coding-agent Scheduler/session services implement or consume it.

**`FoundationFactRecord`.** Represents an immutable durable fact; ledger, settlement, storage, and coding-agent lifecycle consumers use it.

**`FoundationObjectResult`.** Represents the current folded state of a Foundation object; Session, ledger, storage, and coding-agent consumers use it.

**`FoundationRecord`.** Represents any durable Foundation fact or intent record; Session, codec, storage, and coding-agent consumers use it.

**`FoundationRecordQuery`.** Filters durable Foundation record reads; Session, ledger, storage, and coding-agent consumers use it.

**`FoundationRetentionPolicy`.** Defines retention limits for durable Foundation records; storage and coding-agent session management consume it.

**`LedgerWriterLease`.** Identifies the active single-writer authority and revision; Session, ledger writer, storage, and coding-agent consumers use it.

**`ProvisionedFoundationRecord`.** Represents a durable record with assigned revision metadata; Session, ledger, and storage consumers use it.

**`ReleaseWriterLeaseOptions`.** Configures release of a writer lease; Session storage and coding-agent manager storage consume it.

**`RenewWriterLeaseOptions`.** Configures renewal of a writer lease; Session storage and coding-agent manager storage consume it.

**`SetRetentionPolicyOptions`.** Configures a retention-policy update; Session storage and coding-agent manager storage consume it.

**`SessionLedgerWriter`.** Serializes canonical ledger mutations under one Session and writer identity; agent-core artifact, context, memory, and settlement services plus coding-agent Scheduler and Subagent consumers use it.

### Complete exported-name index

This index is checked against the public API whitelist. It provides searchable
documentation evidence for every retained package-root export; the sections
above and the rest of this README provide behavioral guidance for the primary
contracts.

```text
AcceptanceCriterion, AcceptanceFact, AcquireWriterLeaseOptions, Agent, AgentBinding, AgentContext, AgentEvent, AgentHarness, AgentHarnessFoundationExecution, AgentHarnessOptions, AgentHarnessTool, AgentInstance, AgentLoopConfig, AgentMessage, AgentOperationError, AgentOperationSignal, AgentState, AgentTool, AgentToolResult, AgentToolUpdateCallback, AppendFoundationRecordResult, ArtifactDigest, ArtifactRef, ArtifactRefSchema, ArtifactStoreProvider, Ask, AskReply, AskStatus, Attempt, AttemptReceipt, AttemptReceiptUsage, BindingEpoch, BranchBounds, Budget, BudgetSchema, BudgetUsage, BudgetUsageSchema, CanonicalRunResult, ChildAgentProvider, ChildSpawnRequest, ChildSpawnResult, ConnectorCapabilitySnapshot, ContextForkMode, ContextSnapshot, ContextSnapshotRecord, ContextSnapshotSource, Dispatch, DispatchExecutionResult, DispatchStartResult, DurableEventCategory, DurableEventEnvelope, DurableLedgerApi, DurableLedgerError, EXTERNAL_ERROR_CODES, EXTERNAL_ERROR_MESSAGES, Entry, EntryOrder, EntryQuery, EventCorrelationRef, ExecutionCorrelation, ExecutionEnv, ExecutionProviderDescriptor, ExecutionToolContext, ExternalAgentConnector, ExternalErrorCode, FOUNDATION_ERROR_CODES, FOUNDATION_TOOL_RESULT_CUSTOM_TYPE, FileError, FileSystem, Fingerprint, FingerprintSchema, ForkOptions, FoundationEnvelope, FoundationError, FoundationErrorCode, FoundationEventEnvelope, FoundationFactRecord, FoundationJsonValue, FoundationLedgerState, FoundationObjectResult, FoundationObserver, FoundationProviderCapability, FoundationProviderExecutionOptions, FoundationRecord, FoundationRecordQuery, FoundationRetentionPolicy, FoundationToolGatewayAuthority, Goal, HarnessCompactionHookInput, HarnessCompactionHookResult, HarnessCompactionResult, HarnessContextPreparationInput, HarnessModelCallBoundaryInput, HarnessTool, Idempotency, InMemoryArtifactBlobStore, InMemorySessionRepo, InMemorySessionStorage, LanePointer, LaneRecord, LayeredResultSettlement, LedgerWriterLease, LogItem, LogOptions, McpCapabilityBinding, McpSelection, McpToolRoute, MemoryError, MemoryProvenanceBoundary, MessageEntry, ModelProfile, ModelRoute, ModelRouteSchema, NewRecord, ObserverCursor, OperationStartedRecord, Plan, PlanStatus, PluginContract, PrepareNextTurnContext, ProfileContract, ProvisionedEntry, ProvisionedFoundationRecord, PublicExecutionError, PublicExecutionErrorCategory, QueueMode, QuotaAttribution, QuotaProvider, QuotaReservation, ROLE_RESOLUTION_ORDER, RecordQuery, ReleaseWriterLeaseOptions, RenewWriterLeaseOptions, ResourceSelector, ResourceSelectorSchema, Result, ResultProvenance, ResultValidation, ResultValue, RevisionReference, RevisionReferenceSchema, RoleDefinition, RoleRegistry, RoleRevision, RunOutcome, RunReceipt, SandboxOperationProvider, SandboxOperationRequest, SchedulerClaimEventPayload, SchedulerDeadlockEventPayload, SchedulerDispatchEventPayload, SchedulerHandoffEventPayload, SchedulerQueueEventPayload, SchedulerTaskExecutorProvider, SchedulerWakeEventPayload, ScopedExecutionGateway, ScopedMemoryStore, ScopedModelGateway, ServiceContract, Session, SessionCreateOptions, SessionError, SessionLedger, SessionLedgerWriter, SessionLedgerWriterOptions, SessionMetadata, SessionRepo, SessionSearch, SessionSearchHit, SessionSearchOptions, SessionStats, SessionStorage, SetRetentionPolicyOptions, SettleTaskResultInput, SideEffectState, Stage, StageStatus, StepAttemptRecord, StreamFn, TaskArtifactProjection, TaskContextPackage, TaskEnvelope, TaskEnvelopePublicProjection, TaskEnvelopePublicProjectionSchema, TaskExecutorAttemptContext, TaskExecutorProvider, TaskResult, TaskResultRef, ThinkingLevel, Todo, TodoStatus, ToolExecutionMode, ToolExecutionResult, ToolGateway, ToolGatewayProvider, ToolGatewayRequest, ToolGatewayRoute, ToolGatewayRouteCatalog, ValidationResult, VersionedReference, WorkerReceipt, WorkerReceiptRef, agentLoop, agentLoopContinue, artifactDigestFromId, assertJsonSerializable, bashExecutionToText, budgetExhaustionReason, canonicalFoundationJson, cloneDeepFrozen, contextSnapshotFromJSON, convertToLlm, createAgentInstance, createAgentOperationSignal, createAttempt, createBashTool, createBindingEpoch, createCompactionSummaryMessage, createConnectorCapabilitySnapshot, createContextSnapshot, createCustomMessage, createDurableEvent, createEditTool, createExecutionCorrelation, createFoundationToolGateway, createFoundationToolGatewayAuthority, createHostTerminalGateAuthority, createModelProfileRevision, createOrderedBindingEpoch, createReadTool, createRoleRevision, createSandboxOperationToolGatewayProvider, createTaskEnvelope, createWriteTool, decodeLegacyFoundationRecordV1, executeOperation, fingerprintFoundationValue, formatPromptTemplateInvocation, formatSkillInvocation, formatSkillsForSystemPrompt, getFileSystemResultOrThrow, getOrThrow, invalidDurableRecord, isSideEffectRetryable, isToolGatewayRoute, isValidArtifactDigest, isValidArtifactId, newFoundationId, ok, parseCommandArgs, parseExactShape, parseFoundationMutation, persistTaskEnvelopeBeforeResolver, projectMcpSelectionToSelector, projectTaskEnvelope, redactText, resolveAgentBinding, resolveMcpSelection, selectorsNarrow, serializeExactShape, setDefaultStreamFn, sha256HexValue, streamProxy, toError, truncateHead, validateAgentBinding, validateAgentInstance, validateAndVerifyToolReceipt, validateArtifactRef, validateAsk, validateAttempt, validateAttemptReceipt, validateAttemptReceiptForProvider, validateAttemptReceiptUsage, validateBindingEpoch, validateBudget, validateBudgetUsage, validateChildMcpSelection, validateChildSpawnRequest, validateConnectorCapabilitySnapshot, validateConnectorCapabilitySnapshotForProvider, validateDispatch, validateDurableEvent, validateEventPayloadForCategory, validateExactShape, validateExecutionCorrelation, validateFingerprint, validateFoundationProviderCapability, validateFoundationToolResultEntry, validateGoal, validateImmutableAgentBinding, validateMcpSelection, validateMcpSelectionForBinding, validatePlan, validateProviderJson, validatePublicExecutionError, validateQuotaAttribution, validateQuotaReservation, validateRoleRevision, validateRunReceipt, validateSandboxOperationRequest, validateSecretFreeModelProfile, validateSpawnAgentIntent, validateStage, validateTaskEnvelope, validateTaskEnvelopePublicProjection, validateTaskResult, validateTaskResultRef, validateTodo, validateToolExecutionResult, validateToolGatewayRequest, validateVersionedReference, validateWorkerReceipt, validateWorkerReceiptForProvider
```

## License

MIT
