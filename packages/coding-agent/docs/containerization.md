# Containerization

AOS Agent uses the host-compatible `legacy` Execution Policy by default. That mode preserves existing host behavior and is not an isolation boundary. Use a container, VM, micro-VM, remote sandbox, or a registered Sandbox Provider when tool execution needs a separate resource boundary.

There are two general options. You can either:

1. run the whole `aos` process inside an isolated environment; or
2. run `aos` on the host and route selected tool execution into an isolated environment.

## Policy and sandbox boundary

Capability profiles decide which tools enter a run. Execution Policy decides whether each selected capability invocation, filesystem operation, process, network connection, credential exposure, or sandbox preparation is allowed, requires approval, or is denied. A Sandbox Provider executes allowed operations inside its reported, enforceable filesystem/process/network/credential boundary. ModelBroker selects model routes and budgets model calls; it cannot grant tool permissions, select a sandbox, expose credentials, or use model fallback to bypass a policy result.

Select a named registered policy profile with `--policy <profile>`, SDK `policyProfile`, or Automation Host `run.start` / `run.resume` `policyProfile`. There is no inline policy object or allow-all selector. Without a selected profile, the built-in `legacy` profile uses host behavior.

Strict profiles use `enforcement: "sandbox"` and a registered provider. They fail closed before a side effect when the provider is missing (`sandbox_required`), unavailable (`sandbox_unavailable`), missing a required capability (`sandbox_capability_insufficient`), or cannot prepare (`sandbox_start_failed`). They never fall back to host or legacy execution. The `legacy-host` compatibility marker and `host-policy` local checks do not claim the strong boundary required for arbitrary Bash, network access, or untrusted child processes.

An outer Docker, VM, or OpenShell boundary is independent of AOS Agent's policy binding. A host-routing extension may delegate built-in operations into a VM, but custom extension tools still run on the host unless they delegate too; the extension does not automatically register a Sandbox Provider or make every tool isolated. Only the provider bound to the run can satisfy strict policy enforcement.

## Choose a pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| Gondolin extension | Built-in tools and `!` commands | Local micro-VM isolation while keeping auth on host | See [`examples/extensions/gondolin/`](../examples/extensions/gondolin/). |
| Plain Docker | Whole `aos` process in a local container | Simple local isolation | Provider API keys enter the container. |
| OpenShell | Whole `aos` process in a policy-controlled sandbox | Local or remote managed sandbox | Requires an OpenShell gateway. |

Extensions run wherever the `aos` process runs. If you run host `aos` with a tool-routing extension, other custom extension tools still run on the host unless they also delegate their operations.

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM. Use the [example extension](../examples/extensions/gondolin) when you want `aos` on the host but built-in tools routed into the VM.

Setup:

```bash
cp -R packages/coding-agent/examples/extensions/gondolin ~/.aos-agent/agent/extensions/gondolin
cd ~/.aos-agent/agent/extensions/gondolin
npm install --ignore-scripts
```

Run from the project you want mounted:

```bash
cd /path/to/project
aos -e ~/.aos-agent/agent/extensions/gondolin
```

The extension mounts the host cwd at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. User `!` commands are routed into the VM, as well. File changes under `/workspace` write through to the host.

Requirements: Node.js >= 23.6.0 for `@earendil-works/gondolin`, plus QEMU (requires installation through your package manager).

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
