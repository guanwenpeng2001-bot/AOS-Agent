# Development

See [AGENTS.md](../../AGENTS.md) for additional guidelines.

## Setup

From the repository root of this baseline:

```bash
npm install --ignore-scripts
npm run build
```

Run from source:

```bash
/path/to/AOS-Agent/aos-test.sh
```

The script can be run from any directory. AOS Agent keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "aosAgentConfig": {
    "name": "aos",
    "configDir": ".aos-agent"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.aos-agent/agent/aos-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
