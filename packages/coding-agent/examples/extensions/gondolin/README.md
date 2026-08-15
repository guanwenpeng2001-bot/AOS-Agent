# Gondolin sandbox provider

This example provides an optional `gondolin-local` `SandboxProvider`. It does
not register itself, start a VM, override built-in tools, or change AOS Agent's
defaults when loaded as an extension. The default `legacy` profile therefore
keeps the existing host behavior.

## Explicit registration

Construct the provider in trusted host code and pass that instance to the
existing SDK option. Select a named strict policy profile whose
`sandboxProvider` is `gondolin-local`:

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

`workspace-safe` must already be a trusted, named execution-policy profile with
`enforcement: "sandbox"` and `sandboxProvider: "gondolin-local"`.
`sandboxProviders` receives provider instances, not package names, paths, URLs,
commands, or settings values. Loading this directory with `-e` is not provider
registration; it is a no-op extension entry point.

The core session prepares one provider handle for the immutable policy binding,
routes built-in filesystem and process operations through the guest-only
adapters, and disposes the handle on shutdown, rebind, or resume. A later run
never reuses a disposed handle. Missing registration or unavailable prerequisites
fails closed; it never falls back to host execution for a strict profile.

## Boundary and prerequisites

- The only mount is the host workspace root at guest `/workspace`. Reads and
  writes below that mount use write-through semantics. Parent traversal, outside
  paths, other drives/UNC roots, and symlink or junction escapes are rejected
  before a guest operation.
- Networking is disabled by default (`network: false`). MCP transport is not
  available in v1 and cannot fall back to a host connection.
- Process environments are filtered by policy. The host auth store, session
  files, model credentials, full parent environment, and raw provider errors do
  not enter guest operations or public diagnostics.
- The optional package requires Node.js >= 23.6.0 and a QEMU system binary on
  `PATH`. These are external prerequisites; the core package does not depend on
  Gondolin.

`AbortSignal` and operation timeouts are forwarded to guest filesystem and
process calls; the run deadline is carried by the existing session signal.
Gondolin cannot prove that a dispatched process or write stopped after an abort,
timeout, or VM close. Such an effect is reported as unknown and is not
automatically retried. Reads and listings may report ordinary cancellation.

## Real smoke test

The fake-VM contract tests do not start QEMU. Run the opt-in real smoke from
this directory only on a host with the optional dependency and QEMU installed:

```powershell
$env:AOS_AGENT_GONDOLIN_SMOKE = "1"
npm run smoke
```

Without the environment variable the command exits without creating a VM. The
smoke uses a temporary workspace and removes it after checking guest filesystem
and process execution, network rejection, cancellation classification, and
idempotent disposal.
