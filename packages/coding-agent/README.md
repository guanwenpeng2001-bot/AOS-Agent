# AOS Agent

AOS Agent is a terminal coding agent with an interactive TUI, non-interactive print mode, built-in file and shell tools, model selection, and resumable sessions.

This package is the installable standalone product in the AOS Agent baseline. Upstream source provenance and legal notices are maintained separately in [`../../UPSTREAM.md`](../../UPSTREAM.md) and [`../../LICENSE`](../../LICENSE).

## Install from this repository

Build the workspace once, then install this package into an npm prefix:

```sh
npm install --ignore-scripts
npm run build
npm install --global --ignore-scripts ./packages/coding-agent
```

The build also generates the local AOS-owned model registry under `.artifacts/aos-model-registry/`; its source policy and reproducibility contract are documented in [`../ai/AOS-MODEL-REGISTRY.md`](../ai/AOS-MODEL-REGISTRY.md).

Start the agent with:

```sh
aos
```

Verify a non-interactive installation with:

```sh
aos --help
```

The default user data directory is `~/.aos-agent/agent`. The project-local configuration directory is `.aos-agent/`. Use `aos --offline` to disable startup update, package, and install-telemetry network operations.

## Basic usage

```sh
aos "Explain this repository"
aos --continue "Continue the previous task"
aos --print "Summarize the current directory"
aos --model openai/gpt-4o "Review this change"
aos --no-extensions --offline --help
```

Authentication can be supplied through provider-specific environment variables or the built-in auth commands:

```sh
aos auth check --provider openai
aos auth print-api-key --provider openai
```

Run `aos --help` for the complete option and provider list.

## Configuration and extensions

Global settings live under `~/.aos-agent/agent/`; project settings and resources live under `.aos-agent/`. The agent supports user-provided extensions, skills, prompt templates, and themes. Review any third-party package before installing it, and use `--no-extensions`/`--no-skills` for a source-only startup check.

Extension API and package manifest details are documented in the accompanying `docs/` directory.

## Package contents

- `dist/` — generated build output; it is created by `npm run build` and is not source-controlled in this baseline.
- `src/` — CLI and agent implementation.
- `docs/` and `examples/` — usage and integration references.
- `package.json` — package identity `aos-agent` and executable `aos`.

## License

This package is MIT-licensed as part of the imported upstream baseline. Preserve the repository-level license, package attribution, and all third-party notices when copying or redistributing it.
