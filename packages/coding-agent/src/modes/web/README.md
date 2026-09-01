# Web surface mode

`aos --mode web` starts a local operations dashboard backed by a child Automation Host through `RpcClient`.

Security boundary:

- HTTP binds only to IPv4 loopback `127.0.0.1`.
- The read proxy allowlists `run.get`, `audit.query`, `task.gate.list`, `task.graph.get`, and `task.graph.list`.
- A separate confirmed-write handler allowlists only `task.gate.approve`, `task.gate.reject`, `run.cancel`, and `run.resume`.
- Every other write, including `run.start`, `task.gate.cancel`, and task graph mutation, receives HTTP 403.
- Host failures map to bounded user-facing messages without returning internal error text.
- HTML, CSS, and JavaScript are packaged locally. The page loads no CDN or remote resource.

The run list is derived from safe current-session audit events and refreshed with `run.get`. Gate, task graph, and audit data remain read-only projections from the same RPC Host. The page is a loopback single-operator surface; it does not add authentication or remote access.
