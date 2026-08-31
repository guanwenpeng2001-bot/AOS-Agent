# Upstream pi Fix Triage

Run this audit before each release and at least once per release cycle. Its purpose is to keep upstream correctness fixes visible before the divergence becomes expensive to review.

## Inputs

Record these values in the report:

- AOS Agent commit under review.
- Previously reviewed and current pi commits.
- Production paths included in the comparison.
- Known AOS rewrites that moved an upstream subsystem.

Use the previous report's current pi commit as the next report's starting commit. If that baseline is unavailable, state how the range was reconstructed instead of silently choosing one.

## Procedure

1. List commits in the pi range that touch the relevant production paths.
2. Keep commits whose subject contains `fix`, case-insensitively, and deduplicate by SHA.
3. Read every retained production diff. Use forward and reverse `git apply --check` only as location evidence; neither result proves semantic coverage.
4. Map moved code to its current AOS location and cite the file and behavior that support the disposition.
5. Assign a ticket to every `port` row. Resolve every `needs investigation` row before release.

The normal production scope is `packages/ai/src`, `packages/coding-agent/src/core`, and `packages/coding-agent/src/modes`. Expand it when AOS or pi moved the affected subsystem, and record the expansion.

## Report Format

Start with the two commit ranges and disposition counts, then use this table:

| SHA | pi fix summary | disposition | AOS evidence | proposed ticket |
| --- | --- | --- | --- | --- |
| `<sha>` | Concrete behavior fixed upstream | `port` | `path/to/file.ts:line` still has the old behavior | `F01` |

Allowed dispositions:

- `port`: AOS still has the affected behavior.
- `covered`: AOS already has equivalent behavior and regression coverage.
- `not applicable`: the feature or affected path does not exist in AOS, or the upstream change was superseded. State which.
- `needs investigation`: evidence is incomplete. This is temporary and blocks release.

End the report with grouped proposed tickets and the next pi baseline commit. Keep intermediate repositories, patches, and generated evidence outside the product tree.
