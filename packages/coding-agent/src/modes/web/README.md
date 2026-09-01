# Web surface mode

`aos --mode web` starts a local read-only dashboard backed by a child Automation Host through `RpcClient`.

Security boundary:

- HTTP binds only to IPv4 loopback `127.0.0.1`.
- The proxy allowlists `run.get`, `audit.query`, `task.graph.get`, and `task.graph.list`.
- The page cannot start, cancel, resume, approve, or otherwise mutate a run or control-plane record.
- HTML, CSS, and JavaScript are packaged locally. The page loads no CDN or remote resource.

The initial run list is derived from safe current-session audit events and refreshed with `run.get`. Task graphs and audit results are read-only projections from the same RPC Host.
