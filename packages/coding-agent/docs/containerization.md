# Containerization

AOS Agent uses the host-compatible `legacy` Execution Policy by default. That mode preserves existing host behavior and is not an isolation boundary. Use a container, VM, micro-VM, remote sandbox, or a registered Sandbox Provider when tool execution needs a separate resource boundary.

There are two general options. You can either:

1. run the whole `aos` process inside an isolated environment; or
2. run `aos` on the host and route selected tool execution into an isolated environment.

## Policy and sandbox boundary

Capability profiles decide which tools enter a run. Execution Policy decides whether each selected capability invocation, filesystem operation, process, network connection, credential exposure, or sandbox preparation is allowed, requires approval, or is denied. A Sandbox Provider executes allowed operations inside its reported, enforceable filesystem/process/network/credential boundary. ModelBroker selects model routes and budgets model calls; it cannot grant tool permissions, select a sandbox, expose credentials, or use model fallback to bypass a policy result.

Select a named registered policy profile with `--policy <profile>`, SDK `policyProfile`, or Automation Host `run.start` / `run.resume` `policyProfile`. There is no inline policy object or allow-all selector. Without a selected profile, the built-in `legacy` profile uses host behavior.

Strict profiles use `enforcement: "sandbox"` and a registered provider. They fail closed before a side effect when the provider is missing (`sandbox_required`), unavailable (`sandbox_unavailable`), missing a required capability (`sandbox_capability_insufficient`), or cannot prepare (`sandbox_start_failed`). They never fall back to host or legacy execution. The `legacy-host` compatibility marker and `host-policy` local checks do not claim the strong boundary required for arbitrary Bash, network access, or untrusted child processes.

An outer Docker, VM, or OpenShell boundary is independent of AOS Agent's policy binding. A custom extension tool still runs on the host unless it delegates its own operation; loading an extension does not automatically register a Sandbox Provider or make every tool isolated. Only the provider bound to the run can satisfy strict policy enforcement.

### Explicit provider registration

Selecting a profile is not the same as loading a provider. `--policy` and
`policyProfile` select a named profile; they do not install a package, execute a
command, or load a provider from project settings. A trusted SDK or embedded host
must construct and register the provider before selecting a strict profile:

```ts
import { createAgentSession } from "aos-agent";
import { createGondolinSandboxProvider } from "./packages/coding-agent/examples/extensions/gondolin/register.ts";

const cwd = process.cwd();
const gondolinLocal = createGondolinSandboxProvider({ workspaceRoot: cwd });

const { session } = await createAgentSession({
  cwd,
  policyProfile: "workspace-safe",
  sandboxProviders: [gondolinLocal],
});
```

The named `workspace-safe` profile must already be trusted, use
`enforcement: "sandbox"`, and set `sandboxProvider: "gondolin-local"`.
`sandboxProviders` accepts provider instances only; it does not load package
names, module paths, URLs, commands, or project settings. Loading the example
with `-e` alone does not register a provider. With no selected strict profile,
the `legacy` profile remains the default and host behavior is unchanged.

## Choose a pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| Gondolin provider example | Built-in tools and `!` commands | Local micro-VM isolation while keeping auth on host | Explicit SDK registration required; see [`examples/extensions/gondolin/`](../examples/extensions/gondolin/). |
| Plain Docker | Whole `aos` process in a local container | Simple local isolation | Provider API keys enter the container. |
| OpenShell | Whole `aos` process in a policy-controlled sandbox | Local or remote managed sandbox | Requires an OpenShell gateway. |

Extensions run wherever the `aos` process runs. If you run host `aos` with a tool-routing extension, other custom extension tools still run on the host unless they also delegate their operations.

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM.
The [example package](../examples/extensions/gondolin) exposes an optional
`gondolin-local` provider and the shared guest-only filesystem/process
adapters. Its extension entry point is intentionally side-effect free: it does
not start a VM or override built-in tools. Use the explicit SDK registration
above when strict policy should route built-in operations into the guest.

Setup:

```bash
cp -R packages/coding-agent/examples/extensions/gondolin ~/.aos-agent/agent/extensions/gondolin
cd ~/.aos-agent/agent/extensions/gondolin
npm install --ignore-scripts
```

The `-e` command only loads the no-op extension entry point; it does not
register `gondolin-local`, select a policy, or start a VM. The strict SDK path
prepares one provider handle for the immutable policy binding. Core built-in
read, write, edit, grep, find, ls, bash, and `!` operations then use the
provider's guest-only adapters. Custom extension tools and MCP are not made
guest-side by this provider.

The provider mounts only the host workspace root at `/workspace`. Reads and
writes below that mount are write-through to the host. Parent traversal,
outside paths, different Windows drives or UNC roots, and symlink/junction
escapes are rejected before a guest operation. Host auth files, session files,
the Agent directory, and credential roots are not mounted. A write-through
mount is not a rollback or copy-on-write boundary.

The strict `gondolin-local` binding reports `filesystem: true`, `process: true`,
`credentialIsolation: true`, and `network: false`. These booleans describe
enforceable boundaries, not best-effort checks. The provider keeps AOS
control-plane authentication on the host: ModelRuntime credentials, the full
parent environment, session files, and MCP header values are not copied into a
guest tool process; only policy-filtered explicit environment names may be
passed. This does not isolate model requests made by the host AOS process.

The provider starts its VM with networking and WebSockets disabled. Guest
network operations therefore fail with `sandbox_capability_insufficient`
rather than using the host network. Strict MCP stdio or HTTP also remains
unavailable when the provider has no controlled MCP transport: it fails closed
with `sandbox_capability_insufficient` and never falls back to a host MCP
connection.

Cancellation and deadlines use the existing Run and operation contracts. An
`AbortSignal` stops the guest operation before the provider handle is disposed;
an explicit `run.cancel` settles as `run.cancelled`, while an accepted Run
deadline settles as `run.failed` with `run_deadline_exceeded`. If cancellation,
timeout, or VM close cannot prove whether a write or process side effect
occurred, the operation is `side-effect-unknown` and is not automatically
retried. Provider disposal is idempotent, and a disposed handle is never reused
by resume, policy rebind, or a later session.

Requirements: the example pins `@earendil-works/gondolin` to exactly `0.12.0`,
requires Node.js >= 23.6.0, and requires a QEMU system binary on `PATH`.
Install QEMU with your platform package manager; a working host AOS process
alone does not prove that Gondolin or QEMU is available. The first VM start may
also resolve Gondolin guest assets. The core `aos-agent` package has no
Gondolin or QEMU dependency.

### Optional Gondolin smoke test

The example includes a real-VM smoke script. It is deliberately outside the
normal package scripts and CI jobs. It exits successfully with a skip message
unless `AOS_AGENT_GONDOLIN_SMOKE=1` is set, and it does not call a model, use an
API key, or contact an external service. Run it only on a machine where the
Node.js and QEMU prerequisites are installed:

```bash
cd packages/coding-agent/examples/extensions/gondolin
AOS_AGENT_GONDOLIN_SMOKE=1 node smoke.mjs
```

PowerShell:

```powershell
Set-Item Env:AOS_AGENT_GONDOLIN_SMOKE 1
node .\smoke.mjs
Remove-Item Env:AOS_AGENT_GONDOLIN_SMOKE
```

The smoke checks VM startup, the `/workspace` write-through, a guest process
abort, filtered environment behavior, networking disabled at VM creation, and
clean disposal. Ordinary `npm run check`, tests, and CI do not invoke this
script.

## Plain Docker

Run the whole `aos` process in Docker when you want the simplest local container boundary.

`Dockerfile.aos`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts aos-agent

WORKDIR /workspace
ENTRYPOINT ["aos"]
```

Build and run:

```bash
docker build -t aos-sandbox -f Dockerfile.aos .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v aos-agent-home:/root/.aos-agent/agent \
  aos-sandbox
```

The `-v "$PWD:/workspace"` mount makes reads and writes in `/workspace` inside Docker affect host files, like in the Gondolin example. Use a named volume for `/root/.aos-agent/agent` if you want container-local settings and sessions. Mounting the host `~/.aos-agent/agent` exposes host auth and session files to the container.

## OpenShell

Use [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) when you want a policy-controlled sandbox with filesystem, process, network, credential, and inference controls. OpenShell can run sandboxes through a local gateway backed by Docker, Podman, or a VM runtime, or through a remote Kubernetes gateway.

Every sandbox requires an active gateway. Register and select one before creating a sandbox:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

Launch `aos` inside an OpenShell sandbox:

```bash
openshell sandbox create --name aos-sandbox --from aos -- aos
```

In this pattern, the whole `aos` process runs inside the sandbox. Built-in tools, `!` commands, and extension tools execute inside the OpenShell boundary.

If the gateway is remote, project files are not bind-mounted from the host, meaning writes in the sandbox are not reflected on your machine. Clone the repository inside the sandbox or use OpenShell file transfer commands:

```bash
openshell sandbox upload aos-sandbox ./repo /workspace
openshell sandbox download aos-sandbox /workspace/repo ./repo-out
```

OpenShell providers can keep raw model API keys outside the sandbox. When inference routing is configured, code inside the sandbox can call `https://inference.local`, and the gateway injects the configured provider credentials upstream. Configure AOS Agent to use the corresponding OpenAI-compatible or Anthropic-compatible endpoint if you want model traffic to use this route.

## Inspection and redaction

Use `/policy` in the TUI or `get_execution_policy` in RPC mode to inspect the active profile, immutable binding, project trust, enforcement, sandbox status, provider capability booleans, last decision, and pending approval metadata. `policy.approve` and `policy.reject` resolve a pending request only for the current session and binding.

These surfaces expose policy metadata and fixed reason codes only. They never expose raw commands or arguments, cwd or full sensitive paths, environment/header values, tokens, credentials, authorization URLs, model credentials, provider process ids, temporary paths, MCP instructions, or agent self-reports. Resume creates a new policy binding and sandbox handle after fresh preflight; it does not reuse approvals or disposed handles.
