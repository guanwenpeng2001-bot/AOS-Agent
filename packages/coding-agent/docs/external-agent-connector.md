# External Agent Connector

## Status

The External Agent Connector contract and the architecture convergence are implemented. Product entry wiring (default CLI/RPC/SDK composition and settings-based connector registration) and the final promotion gate (multi-OS packaged smoke, upgrade/restart, soak, pinned vendor certification) are not complete. This checkout does not claim product readiness.

`ExternalAgentConnector` is the only public execution contract for an external
agent. It implements the shared `TaskExecutorProvider` boundary and therefore
enters the same executor pool as every other provider. An external run uses the
canonical Task, Dispatch, AgentBinding/BindingEpoch, Attempt, AttemptReceipt,
TaskResult, and RunReceipt facts; it never creates an `AgentInstance`.

## Trusted composition

The Host constructs connectors and registers them in one
`ExternalConnectorRegistry`. Registration accepts an exact descriptor and one
trusted connector instance. It never accepts a module path, command, endpoint,
environment, credential, vendor name, or product fallback.

```ts
import {
  createAgentRuntimeCompositionFactory,
  createExternalConnectorRegistry,
} from "aos-agent";

const registry = createExternalConnectorRegistry();
await registry.register({ descriptor, connector });

const runtimeComposition = createAgentRuntimeCompositionFactory({
  externalConnectorRegistry: () => registry,
});
```

Trust is derived from Host composition: the Host creates the registry, constructs
the connector instance, and supplies that registry to the runtime composition.
Registration has no caller-controlled trust flag, so a connector cannot
self-attest as trusted.

The descriptor pins `providerId`, `providerClass: "external_connector"`,
`revision`, and the capability snapshot digest. A selection must repeat those
mutable identity fields exactly. Registry selection revalidates the pinned
capability snapshot before execution.

## Execution and persistence

The connector receives the shared Foundation execution input. Canonical text
and trusted artifact or image references are gated before Run acceptance.
Execution persists one canonical connector mapping and the standard Foundation
receipt chain. Connector capability, model-access, observation, cancellation,
deadline, and disposal behavior fail closed when evidence is absent or drifts.

The Host owns Run acceptance and terminal settlement. Connector output is
evidence for the canonical `AttemptReceipt`; it is not a second receipt or an
independent terminal authority. Current external traces contain no
`AgentInstance` records.

## Private vendor boundary

Vendor protocol drivers, process handles, probing, startup, cancellation, and
supervision types are implementation details under `src/core/vendor-drivers`.
They are not package-root exports and their package subpaths are not importable.
A vendor driver can translate a protocol, but it cannot introduce a second
registry, mapping, receipt, provider taxonomy, or execution contract.

Historical automation-ledger external references are decoded only by the
private migration parser. Migration never generates current `AgentInstance` or
external execution records.

## Packaged public subpath

Package consumers import the connector surface from
`aos-agent/external-connector`. The Node packaging regression stages the
generated entrypoint and fixture asset, creates an npm tarball, installs it in a
directory outside the repository, and resolves that public subpath from the
installed package. The packaged fake driver is deterministic and disabled by
default; a missing allowlisted asset fails with
`external_agent_driver_asset_missing`.

## Local closure and promotion boundary

The ordinary local regressions cover the packaged Node owner above, the standard
product composition across run/switch/fork/import/reload/cancel/restart,
immutable RuntimeLimits and no-widen validation, passive runtime-status
projection, and a durable terminal retry decision for `side_effect_unknown`.
They do not substitute a scheduler-shaped fixture or inspect private Host
fields.

The following promotion evidence was not run in this closure: Bun package and
compiled artifacts, Windows/Linux/macOS CI, upgrade and restart from a
previously published package, pinned vendor certification, and exact-head remote
artifacts. These checks are part of the final promotion gate and are not complete
in this checkout.
