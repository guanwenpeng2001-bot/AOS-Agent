# GitHub delivery results

A completed Automation Host Run can be associated with a GitHub pull request through a durable `delivery.ref` fact. The fact is keyed by the canonical `TaskResult.taskResultId`, so process restart and Run replay resolve the same PR and check state without inferring it from logs.

The public `DeliveryRef` contains:

- `provider: "github"`, repository, PR number, URL, and branch
- the latest check names, statuses, and conclusions returned by `gh pr view`
- an aggregate `conclusion` and terminal `concludedAt` when checks are no longer pending
- `updatedAt` for the persisted status snapshot

`RpcClient.createPullRequestDelivery()` creates a PR only for a completed Run, then reads its checks and writes the association. `RpcClient.refreshPullRequestDelivery()` performs a read-only GitHub status query and writes the refreshed snapshot. These paths do not trigger CI, approve, merge, or support non-GitHub providers.

Both operations require the GitHub CLI. If `gh` is missing, AOS Agent returns `gh_missing` with the installation URL and the required `gh auth login` step. Command execution is bounded by a timeout and a 1 MiB output limit; malformed or excessive output fails closed.

The loopback Web surface is read-only for delivery results. Run detail displays the PR, checks, aggregate conclusion, TaskResult tests, diff, and artifacts. Download links call the `delivery.artifact.get` claim path, which serves bytes only when the requested artifact is referenced by that Run's validated TaskResult and its Artifact Store metadata matches the public reference.
