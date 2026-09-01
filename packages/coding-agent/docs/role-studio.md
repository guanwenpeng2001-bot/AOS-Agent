# Role Studio

Start the loopback Web surface and open its Role Studio route:

```bash
aos --mode web
```

```text
http://127.0.0.1:<printed-port>/role-studio
```

The page lists Global and Project Roles and supports view, create, edit, copy, and delete. The editor covers persona, custom instructions, capability/skill/MCP selectors, ModelProfile selection, and an ExecutionPolicy reference. It also displays immutable revision/source information and resolver conflicts.

ModelProfile management creates or appends secret-free revisions for provider/model routing and budgets. Profiles are independent from Roles; selecting a profile writes only the Role reference.

The Binding preview is a read-only calculation. It passes the draft Role, selected ModelProfile, and optional managed permission ceiling through the production Role Resolver. The returned `AgentBinding`, source trace, and conflicts therefore use the same resolution code as execution. Preview does not persist a Task, binding, Role, or policy fact.

Permission preview follows the resolver's frozen precedence order. If the draft selector widens its managed ceiling, the page reports the tighten-only failure and does not return a binding.

## Write boundary

Role Studio reads use a separate exact allowlist: `role.list`, `role.get`, `role.preview`, `model_profile.list`, `model_profile.get`, and `policy.get`.

Writes use `/api/role-studio/ops`. Its exact allowlist is `role.create`, `role.edit`, `role.copy`, `role.delete`, and `model_profile.put`. Every request must carry the acknowledgement produced by a browser confirmation. Unlisted methods receive HTTP 403 before reaching `RpcClient`.

The page does not distribute Roles to an organization and does not switch the Role of a running agent.

## SDK building blocks

`RpcClient` exposes the Role Studio methods. The shared package surface also exports the existing sealed-registry building blocks used by the Host: `DurableRoleRegistry`, `DurableModelProfileStore`, `InMemoryRoleRegistry`, `ModelProfileRecord`, `RoleDefinitionPatch`, `RoleRegistryRecord`, `RoleResolutionLayer`, `RoleResolutionPreview`, `RoleResolveInput`, `RoleTombstone`, `createSecretFreeModelProfile`, `resolveRoleResolution`, and `validateRoleSelectorTightening`. These are additive exports; the Role Registry schemas and mutation semantics are unchanged.
