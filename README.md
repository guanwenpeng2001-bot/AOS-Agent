# AOS Agent

AOS Agent is a standalone terminal agent for reading, editing, and running code. It provides an interactive terminal UI, print and structured modes, resumable sessions, built-in file and shell tools, and a compatibility-focused extension surface.

This repository contains the controlled AOS Agent source baseline and its terminal-agent packages.

Package mapping: `packages/coding-agent` is published as npm `aos-agent` (CLI `aos`); `packages/agent` is published as `@aos-agent/agent-core`.

## Quick start

The current public CLI release is `aos-agent@0.84.3`. Install it globally with Node.js 22.19 or newer:

```sh
npm install --global aos-agent@0.84.3
aos --help
```

For source development, build and install the checkout instead:

```sh
npm install --ignore-scripts
npm run build
npm install --global --ignore-scripts ./packages/coding-agent
aos --help
```

Start the installed agent in the project it should work on:

```sh
cd /path/to/project
aos
```

Use an isolated npm prefix when validating or experimenting with the install flow. The commands above do not publish to npm. `aos --offline --no-extensions --help` is the smallest safe startup check when network access or third-party extensions should be avoided.

## Scope

The installable package is `aos-agent`, and it exposes the `aos` executable. The baseline supports:

- interactive terminal sessions and non-interactive print/structured modes;
- read, write, edit, shell, search, and directory tools;
- session persistence, resume, branching, and context compaction;
- configured provider APIs, custom model definitions, and reviewed user extensions.

This repository contains the source for the published `0.84.3` package set. Hosted services and generated model catalogs remain outside the release boundary.

The External Agent Connector contract and the architecture convergence are implemented. Product entry wiring (default CLI/RPC/SDK composition and settings-based connector registration) and the final promotion gate (multi-OS packaged smoke, upgrade/restart, soak, pinned vendor certification) are not complete. This checkout does not claim product readiness.

The root `./test.sh` script runs non-e2e product tests.

## Configuration

User data defaults to `~/.aos-agent/agent/`. Project-local settings and resources use `.aos-agent/`. Provider credentials can be supplied through the provider's documented environment variable or the local auth flow; do not commit credentials or place them in project files that will be shared.

Useful checks:

```sh
aos --help
aos --offline --no-extensions --help
aos --version
```

The detailed reference is in [`packages/coding-agent/docs`](packages/coding-agent/docs), beginning with the [quickstart](packages/coding-agent/docs/quickstart.md), [providers](packages/coding-agent/docs/providers.md), and [security](packages/coding-agent/docs/security.md) pages.

## Model catalog policy

The build creates a local, provider-neutral registry under `.artifacts/aos-model-registry/`. It is ignored by Git and is not part of the package or this repository's product data.

The registry boundary accepts reviewed source records for official provider catalogs/APIs, model gateways, open-model registries, compatible user-supplied catalogs, and future provider-neutral adapters. Public visibility alone is not permission to copy or redistribute metadata. Every source must record its URL, version or retrieval date, terms boundary, authoritative review evidence, normalization decisions, and review status. Unknown facts remain unknown; conflicts and corrections must be explicit.

The current candidate inputs include sources that are approved for local refresh only and sources that remain pending. They may be used for a local build when the documented conditions are met, but the generated registry must not be committed, packaged, or redistributed. User-supplied catalogs are opt-in only and are not loaded by this baseline.

See [`AOS-MODEL-REGISTRY.md`](packages/ai/AOS-MODEL-REGISTRY.md) for the generation contract:

```sh
npm run generate:aos-model-registry
npm run check:aos-model-registry
```

## Security and provenance

AOS Agent runs with the permissions of the local user and can execute shell commands and modify files in its working directory. Review project instructions, extensions, skills, packages, and model/provider configuration before trusting them. Use a container or another policy-controlled sandbox for untrusted repositories or unattended work.

The source baseline is imported from an upstream open-source coding-agent baseline at immutable revision `936aff00918de1187f085f123c2812d8f2d67745`. The upstream MIT license, copyright, third-party notices, and source-origin records remain in [`LICENSE`](LICENSE) and [`UPSTREAM.md`](UPSTREAM.md). They are legal and technical provenance, not the AOS product identity.

## Contributing and release boundaries

Keep changes inside the isolated baseline and keep AOS-specific changes separable from imported upstream source. For an upstream update, record a new immutable revision, compare legal notices and generated inputs, review the exact diff, and rerun the build and isolated `aos --help` install check.

The immutable `v0.84.3` tag identifies the published `0.84.3` release snapshot. `main` may contain post-tag maintenance commits; those commits are not retroactively part of the `v0.84.3` tag or its package artifact. The earlier `v0.84.2` tag remains immutable. Any future release that distributes generated model metadata requires a separate record-level source-terms review, clean artifact and credential checks, and independent review of the upstream provenance boundary; the ignored local registry is not a release artifact.

## License

See [`LICENSE`](LICENSE) and the package-level attribution files for the applicable MIT and third-party notices. Preserve those notices when copying or redistributing this source.
