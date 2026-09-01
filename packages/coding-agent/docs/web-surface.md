# Web surface

Start the local dashboard from the project and Session you want to inspect:

```bash
aos --mode web
```

The command prints the dashboard URL. Keep the process running while the page is open; `Ctrl+C` closes both the HTTP listener and its child RPC Host.

The first screen shows:

- the current Session's runs, derived from safe audit records and refreshed through `run.get`;
- selected run status, usage, recovery, and terminal receipt data;
- recorded token and cost summary cards with detail tables grouped by Session, model, and UTC day;
- a selectable Task Graph board with a self-drawn SVG DAG, dependency edges, node status, and derived availability;
- node details linked to the associated Run Attempt, Operation Workers, and a parent/Child Agent tree;
- pending Task Gates with approve and reject controls;
- cancel controls for active Runs and resume controls for terminal or interrupted Runs;
- a filtered current-Session audit query.

Open `/role-studio` on the same loopback origin to manage Roles and ModelProfiles. See [Role Studio](role-studio.md) for its separate read and confirmed-write allowlists.

Every write requires a browser confirmation before it is sent. Resume also requires the operator to enter the Session file path to restore and the message for the new attempt. The page reports the accepted result or a stable, user-readable error after each operation.

## Security boundary

The Web surface is loopback only. Its HTTP server always binds the IPv4 address `127.0.0.1`; it does not accept a remote bind address.

The read proxy exposes only `run.get`, `audit.query`, `task.gate.list`, `task.graph.get`, `task.graph.list`, `worker.list`, `subagent.list`, the server-side `usage.summary` aggregation, and `delivery.artifact.get`. The board aggregation endpoint calls only the typed graph, Run, Worker, and Child read methods and reports partial optional projections without exposing Host errors. `usage.summary` accepts no parameters and pages through `audit.query` with `session-directory` scope. It totals tokens from terminal Run receipt projections, uses recorded Model attempt or budget cost without applying pricing rules, and groups the result by Session, model, and UTC day. `delivery.artifact.get` and the `/api/delivery/artifacts/:runId/:artifactId` download path serve TaskResult-backed diffs and artifacts only. Writes such as `run.start`, `worker.reclaim`, `subagent.cancel`, and task graph mutation are rejected on `/api/rpc` before they reach `RpcClient`.

Writes use a separate `/api/ops` handler. Its exact allowlist is `task.gate.approve`, `task.gate.reject`, `run.cancel`, and `run.resume`. Each request must carry the confirmation acknowledgement, and Gate and resume writes carry a caller-generated idempotency key. `run.start`, `task.gate.cancel`, task graph mutations, and every other method receive HTTP 403. Host errors are mapped from stable RPC codes to bounded Web messages; raw internal error text is not returned.

All HTML, CSS, and JavaScript ship inside the package. The page loads no CDN, font, script, image, or other remote resource. A restrictive Content Security Policy permits only same-origin script, style, and API access.

`RpcClient` owns the Host transport below this server. Both handlers depend only on typed client methods, so the Web server does not access Session internals or control-plane stores directly. The page renders only the returned usage aggregates; it does not calculate billing or rates. The page polls every three seconds; it does not subscribe to a live event stream. The write boundary is intended for one local operator; it does not add authentication, tenant separation, RBAC, billing, or remote access.
