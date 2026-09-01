# Web surface

Start the local dashboard from the project and Session you want to inspect:

```bash
aos --mode web
```

The command prints the dashboard URL. Keep the process running while the page is open; `Ctrl+C` closes both the HTTP listener and its child RPC Host.

The first screen shows:

- the current Session's runs, derived from safe audit records and refreshed through `run.get`;
- selected run status, usage, recovery, and terminal receipt data;
- read-only task graph nodes and dependencies;
- a filtered current-Session audit query.

## Security boundary

The Web surface is loopback only. Its HTTP server always binds the IPv4 address `127.0.0.1`; it does not accept a remote bind address.

The HTTP proxy exposes only four RPC methods: `run.get`, `audit.query`, `task.graph.get`, and `task.graph.list`. Calls such as `run.start`, `run.cancel`, Gate approval, and task graph mutation are rejected before they reach `RpcClient`. The page has no write controls.

All HTML, CSS, and JavaScript ship inside the package. The page loads no CDN, font, script, image, or other remote resource. A restrictive Content Security Policy permits only same-origin script, style, and API access.

`RpcClient` owns the Host transport below this server. The Web server depends only on its typed read-only methods, so it does not access Session internals or control-plane stores directly.
