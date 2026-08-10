# Changelog

## [Unreleased]

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
