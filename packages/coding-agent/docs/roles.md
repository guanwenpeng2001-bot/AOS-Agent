# Role configuration

A Role is a versioned instruction and resource-selection record. Global and project Roles share the same schema; a project Role may override a Global Role with the same stable identity. Organization distribution is not part of this configuration surface.

Required fields are `roleId`, `scope`, `slug`, `name`, `description`, `persona`, `modelProfileRef`, and the capability, skill, and MCP selectors. Optional fields include `whenToUse`, `customInstructions`, policy references, and `overridesRoleId`.

Selectors use one of four policies:

- `all`: all resources available from the parent scope;
- `none`: no resources;
- `named`: only the listed resource IDs;
- `except`: all parent resources except the listed IDs.

Resolution is tighten-only. A lower-precedence project, path, goal, task, or run selector cannot add permissions excluded by a managed or parent selector. Role Studio previews this check before it produces a resolved binding.

ModelProfiles are separate secret-free immutable revisions. They contain provider/model routing, optional effort and service tier, fallback routes, and budgets. Credentials, headers, tokens, and API keys are never ModelProfile fields.

`executionPolicyRef` selects an ExecutionPolicy by versioned reference. The referenced policy remains an independent binding fact; saving a Role does not change the active policy or switch a running agent.

Edits append immutable Role or ModelProfile revisions. Delete creates a Role tombstone and retains revision history. Runtime mode switching is intentionally outside this configuration surface.
