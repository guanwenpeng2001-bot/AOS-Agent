# Offline model fixtures

These files are a small, test-only normalized catalog. They contain only model IDs
referenced by the AI tests; all other fields are synthetic and must not be copied
from an upstream catalog.

`image-models.json` follows the same rule and uses one synthetic image model because
the tests only require a non-empty image provider catalog.

`prepare-test-catalog` consumes these snapshots to hydrate the ignored generated
files under `src/`. Normal model generation still fetches the upstream catalogs.
