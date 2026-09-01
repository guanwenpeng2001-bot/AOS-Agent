# Web surface mode

`aos --mode web` starts a local operations dashboard backed by a child Automation Host through `RpcClient`.

Security boundary:

- HTTP binds only to IPv4 loopback `127.0.0.1`.
- The read proxy allowlists `run.get`, `audit.query`, `task.gate.list`, `task.graph.get`, `task.graph.list`, `worker.list`, and `subagent.list`.
- A separate confirmed-write handler allowlists only `task.gate.approve`, `task.gate.reject`, `run.cancel`, and `run.resume`.
- `/role-studio` uses a separate six-method read allowlist and five-method confirmed-write allowlist for Role and ModelProfile management.
- Every other write, including `run.start`, `task.gate.cancel`, and task graph mutation, receives HTTP 403.
- Host failures map to bounded user-facing messages without returning internal error text.
- HTML, CSS, and JavaScript are packaged locally. The page loads no CDN or remote resource.

The initial run list is derived from safe current-session audit events and refreshed with `run.get`. The Task Graph board draws its DAG locally and links node details to safe Run, Worker, Attempt, and Child Agent projections from the same RPC Host. Gate lists remain read-only projections from the same Host. The page is a loopback single-operator surface; it does not add authentication or remote access.

Role Studio reuses the durable Role Registry and ModelProfile store through `RpcClient`. Its Binding preview calls the production Resolver as a pure calculation and never appends Session facts. It does not add organization distribution or runtime Role switching.
