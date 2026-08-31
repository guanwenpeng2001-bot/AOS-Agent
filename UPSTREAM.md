# AOS Agent upstream baseline

This file records the isolated upstream baseline for the standalone AOS Agent. Keep AOS-specific work separable from imported upstream source so future updates can be reviewed and reapplied safely.

## Provenance

- Upstream source: <https://github.com/earendil-works/pi>
- Immutable baseline: `936aff00918de1187f085f123c2812d8f2d67745`
- Baseline selection: the full commit SHA above; do not record a mutable branch or tag as the baseline.
- Import date: 2026-08-10
- License: MIT, Copyright (c) 2025 Mario Zechner. The product [`LICENSE`](LICENSE) now attributes AOS Agent; this line records the imported upstream copyright.

The former `badlogic/pi-mono` repository URL redirects to the canonical upstream URL above. The upstream repository URL, source-origin comments, and third-party notices remain part of the provenance record and are not product branding.

## Import and maintenance

The imported tree is now the repository root and was copied from the pinned commit without nested Git metadata. The two tracked Doom build outputs below were excluded because they are generated artifacts; the upstream build script remains available to regenerate them when needed:

- `packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.js`
- `packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.wasm`

The deterministic upstream JSONL test fixtures are retained as test data, not runtime sessions. Root and in-file/vendor license and attribution notices must be preserved.

For a future update, fetch upstream out of tree, select and record a new full commit SHA, compare source and legal notices, exclude generated outputs and transient data, review package/runtime changes, and then import the reviewed snapshot. Do not update this baseline by silently following a branch.

The AOS build owns its provider-neutral model registry outside the imported source snapshot. Its source policy, normalization boundary, input hashes, and review status are documented in [`packages/ai/aos-model-registry.md`](packages/ai/aos-model-registry.md); generated output under `.artifacts/aos-model-registry/` is ignored and is not part of this import.

## Rebrand boundary

The product identity is AOS Agent: package `aos-agent`, CLI `aos`, config paths under `~/.aos-agent/agent` and project `.aos-agent/`, environment variables `AOS_AGENT_*`, and first-party packages under `@aos-agent/*`. Documentation and product-facing text use that identity only.

Upstream repository names, source-origin comments, and third-party notices remain as provenance. External product services that previously used `pi.dev` are not part of the AOS Agent product surface; do not document them as active AOS services.
