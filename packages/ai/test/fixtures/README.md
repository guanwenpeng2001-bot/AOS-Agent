# Offline model fixtures

These files are a small, test-only normalized catalog. They contain only model IDs
referenced by the AI tests; all other fields are synthetic and must not be copied
from an upstream catalog.

`image-models.json` follows the same rule and uses one synthetic image model because
the tests only require a non-empty image provider catalog.

`prepare-test-catalog` consumes these snapshots to hydrate the ignored generated
files under `src/`. Default `build`, CI, and release use this path so a live
upstream catalog deletion cannot fail typecheck. Live fetch remains
`npm run generate-models` / `update-aos-model-registry` from `packages/ai`.
