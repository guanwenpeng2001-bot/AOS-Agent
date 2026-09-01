# Changelog

## [Unreleased]

### Breaking Changes

- Renamed `TextSignatureV1` to `TextSignature`; the wire field `v` remains `1`.
- Renamed the public fake test-provider API from `Faux*`/`faux*` to `Fake*`/`fake*`, including `registerFakeProvider`, with no compatibility aliases.

### Changed

- The Radius provider again defaults to the upstream-hosted gateway (`https://radius.pi.dev`), so its catalog and OAuth discovery work without configuration; custom gateways still override per provider in `models.json`.
- Default `build`, CI, and release regenerate the ignored model wrappers from the tracked `test/fixtures` snapshot. Live catalog fetch is limited to explicit `generate-models` / `update-aos-model-registry`.
- Package author metadata is AOS Agent.
- AOS Messages tests use the `x-aos-gateway-upstream-provider` header name. The previous `x-pi-gateway-upstream-provider` name was not present on a shipped gateway in this repository.

### Fixed

- OpenAI-compatible reasoning details now persist in thinking signatures and replay in their original order.
- Fragmented Mistral tool calls now merge by stream index when continuation chunks omit the call ID.
- Assigned conservative nonzero context and output limits to Cursor's dynamic models so requests are not rejected before reaching the Cursor CLI.
- Made Cursor login check for the CLI before saving credentials, distinguish missing, timed-out, expired, and token-missing states, and explain empty or unsupported model catalogs.
- Made clean and offline checkouts use reproducible tracked model catalogs generated from the canonical catalog scripts.
- Made the Anthropic OAuth callback flow fall back to manual code entry when a local callback listener is unavailable.

## [0.84.3] - 2026-08-10

### Added

### Changed

### Fixed

### Removed

## [0.84.2] - 2026-08-10

### Added

- Cursor provider (`cursor` / `cursor-cli`): Method 1 OAuth imports access and refresh tokens from Cursor private storage (`auth.json` / macOS Keychain) into the AOS credential store after `cursor-agent status --format json` confirms login. Models are discovered dynamically via `cursor-agent models` (no static catalog). Requests run through `cursor-agent` print mode with stream-json parsing (ignores thinking and other non-result events). Windows spawns the installed `node.exe` + `index.js` entrypoint without a shell so multi-line prompts and auth env stay intact. User API keys use `CURSOR_API_KEY`; session JWTs re-hydrate Cursor private `auth.json` for CLI auth. Failed CLI runs surface stderr in the error message.

### Changed

### Fixed

### Removed
