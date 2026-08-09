# AOS model registry

The AOS Agent build generates a provider-neutral model registry locally at
`.artifacts/aos-model-registry/registry.json`. The directory is ignored by Git,
the generated registry is not product data shipped by this baseline, and the
package `files` lists do not include it. The registry is therefore a local
build/refresh aid, not a distributable AOS model catalog.

This document is an engineering provenance and terms record, not a legal
opinion. Public visibility or API access is not treated as permission to copy
or redistribute model metadata.

## Generation contract

- `npm run update-aos-model-registry` from `packages/ai` refreshes the imported
  provider-normalization inputs and regenerates the ignored local registry.
- `npm run generate-aos-model-registry` from `packages/ai` reproduces the
  registry from already hydrated input data without fetching new data.
- `npm run check:aos-model-registry` from the workspace root, or
  `npm run generate-aos-model-registry -- --check` from `packages/ai`, verifies
  that the ignored output matches the current input snapshot.
- The output records schema/source versions, the input manifest hashes, source
  records, source audit metadata, coverage notes, and normalization/update
  policy. It does not invent model facts.

The imported engine's compatible public metadata inputs remain the first
generation boundary. The AOS allowlist is the extension point for future
provider-neutral adapters. Add an official provider source only when it fills
an actual coverage gap; reuse an accurate existing provider or gateway entry
instead of adding a duplicate source.

## Artifact boundary

The generated registry and manifest must remain outside version control and
package contents:

- `.gitignore` ignores `.artifacts/` and the hydrated model-input directory.
- `packages/ai/package.json` packages `dist` and its README, not `.artifacts`.
- `packages/coding-agent/package.json` packages its declared runtime/docs
  files, not `.artifacts`.
- Do not use `git add -f`, package overrides, or a release script to include
  `.artifacts/aos-model-registry/`.

Pending or conditional source terms do not block publication of the standalone
AOS Agent itself because this generated artifact is neither committed nor
packaged. They do block treating the artifact as an AOS-distributed catalog.
If a future release intentionally distributes model metadata, perform a new
record-level review and add the required notices before doing so.

## Source terms audit — 2026-08-10

The four configured sources were reviewed separately against their official
API documentation, terms, or repository license. Classifications are
conservative engineering defaults:

- `approved-for-local-refresh-only`: usable for a local ignored refresh under
  the listed conditions; not cleared for AOS redistribution.
- `approved-for-redistribution-under-conditions`: not currently assigned to
  any source; would require explicit record-level review and notices.
- `pending/blocked`: permission is not established, or the source terms
  contain a restriction that prevents the current automated use until
  clarified.

### models.dev public model metadata API

Classification: `approved-for-local-refresh-only`.

- Fetching: the official repository documents `https://models.dev/api.json` as
  the public API. Use that documented endpoint or an identified repository
  snapshot, and record the retrieval timestamp and input hash.
- Local storage: permitted for the local generated-input/output boundary under
  this record. Retain the upstream source URL and the models.dev MIT notice in
  the provenance record.
- Open-source redistribution: not approved by this audit. The repository is
  MIT-licensed, but its README describes records containing provider/model
  metadata, pricing, links, and other fields without establishing a separate
  data license for every record or third-party field.
- Attribution and restrictions: preserve the upstream MIT copyright and
  permission notice; do not imply that the MIT source license clears provider
  marks, model licenses, links, pricing, or other third-party material.
- Facts and conditions: names, limits, prices, capabilities, licenses, and
  provider links are source/third-party facts and may change; normalization
  must omit unknown values rather than infer them.
- Default: refresh only the ignored local artifact; do not commit or package
  the resulting records until a separate record-level review is complete.

Evidence:

- [models.dev repository](https://github.com/anomalyco/models.dev)
- [models.dev MIT license](https://raw.githubusercontent.com/anomalyco/models.dev/dev/LICENSE)
- [models.dev README and API description](https://raw.githubusercontent.com/anomalyco/models.dev/dev/README.md)

### OpenRouter public model metadata API

Classification: `pending/blocked`.

- Fetching: the official Models API documentation describes the model-list
  endpoint and response fields, but endpoint visibility is not a copying
  license. The OpenRouter Terms prohibit scraping or copying information from
  the Site or Services; the current bulk-list refresh is not cleared by this
  audit.
- Local storage: do not treat a bulk response as an approved local snapshot
  unless OpenRouter gives explicit permission applicable to this use. Preserve
  any already hydrated local test input only as a non-distributed build input.
- Open-source redistribution: not approved. OpenRouter also requires review
  of the applicable model/provider terms, which can vary by model and change.
- Attribution and restrictions: obey the anti-scraping/copying language and
  each model/provider terms boundary; do not use the listing to create a
  competing or resold service.
- Facts and conditions: model IDs, descriptions, prices, limits, benchmarks,
  and provider terms are gateway/provider data, not AOS facts to republish.
- Default: leave the source recorded in the allowlist, but await explicit
  permission or a narrower compliant adapter before refreshing it.

Evidence:

- [OpenRouter Models API documentation](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter Terms](https://openrouter.ai/terms)

### Vercel AI Gateway public model metadata API

Classification: `pending/blocked`.

- Fetching: Vercel documents an unauthenticated `GET /v1/models` endpoint
  returning model metadata. The API Terms separately limit API Data use to
  stated internal purposes and prohibit data harvesting; unauthenticated
  access is not redistribution permission.
- Local storage: no blanket approval for the current automated catalog
  refresh. A future adapter must confirm that its request volume and internal
  use fit the applicable API terms and provider terms.
- Open-source redistribution: not approved. The API Terms restrict exporting,
  distributing, transferring, or sublicensing API Data, and AI Gateway use
  incorporates the applicable provider terms.
- Attribution and restrictions: do not scrape/harvest or export the listing;
  preserve applicable provider/model notices and terms when a future source is
  reviewed.
- Facts and conditions: IDs, context windows, pricing, capabilities, and
  provider routing are gateway/provider data and can change independently.
- Default: keep the source as a documented local candidate, but do not share
  or package its generated records without a new terms review.

Evidence:

- [Vercel AI Gateway models and providers](https://vercel.com/docs/ai-gateway/models-and-providers)
- [Vercel API Terms](https://vercel.com/legal/api-terms)
- [Vercel AI Product Terms](https://vercel.com/legal/ai-product-terms)

### NVIDIA NIM public model metadata API

Classification: `pending/blocked`.

- Fetching: NVIDIA documents `/v1/models` for NIM model availability. Access
  must be through an authorized NIM/API deployment or subscription; no
  credential or authenticated response is stored in this repository.
- Local storage: the API Trial Terms restrict the trial to testing/evaluation
  and prohibit copying or distributing API Service content except as stated by
  the applicable terms. No general local catalog snapshot permission was
  established for this baseline.
- Open-source redistribution: not approved. The trial terms reserve catalog
  content to NVIDIA/licensors and defer to accompanying model and third-party
  licenses; a model list is not treated as an MIT-style data grant.
- Attribution and restrictions: preserve NVIDIA and model-specific notices;
  do not remove proprietary notices, bypass access controls, or distribute API
  Service content without an applicable permission.
- Facts and conditions: model IDs, availability, model cards, and component
  licenses can be provider/model-specific; each record needs its own source
  and terms boundary.
- Default: keep this source pending, use only authorized local inputs, and
  never add credentials or package the resulting data.

Evidence:

- [NVIDIA NIM LLM API reference](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)
- [NVIDIA API Trial Terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)
- [NVIDIA Community Models License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-community-models-license/)

## Coverage verified in the current local inputs

This is a metadata-input coverage check, not a claim that AOS adds runtime
provider integrations. The verified strict local generation emitted the
following provider shards and gateway records:

| Provider family | Current local coverage | Decision |
| --- | --- | --- |
| Alibaba Cloud / Qwen | `qwen-token-plan`, `qwen-token-plan-cn`, `qwen-token-plan-individual`, plus gateway records | Reuse; no duplicate source |
| ByteDance Volcengine Ark / Doubao | ByteDance/Seed records in `openrouter` and `vercel-ai-gateway` | Reuse gateway coverage; direct Ark adapter remains future |
| DeepSeek | `deepseek`, `openrouter`, `vercel-ai-gateway` | Reuse; no duplicate source |
| Tencent Hunyuan | Tencent/HY records in `openrouter` and `vercel-ai-gateway` | Reuse gateway coverage; direct catalog remains future |
| Baidu Qianfan / ERNIE | No matching provider shard or gateway record in the verified output | Future official/manual adapter only |
| Zhipu / GLM | `zai`, `zai-coding-cn`, plus gateway records | Reuse; no duplicate source |
| Moonshot / Kimi | `moonshotai`, `moonshotai-cn`, `kimi-coding`, plus gateway records | Reuse; no duplicate source |
| MiniMax | `minimax`, `minimax-cn`, plus gateway records | Reuse; no duplicate source |

Baidu's official Qianfan documentation exposes a model-list API at
`https://qianfan.baidubce.com/v2/models`, but it requires API-key
authentication. The official documentation tables are useful for future
manual review, but are not copied here and do not authorize credentials or
scraping. See [Baidu's model-list API documentation](https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y).

For future coverage additions, use an `official-provider-catalog` source with
the existing `future-provider-neutral-adapter` boundary. Record the official
URL, retrieval/version date, terms/license evidence, normalization and
deduplication decisions, and review status. Prefer an unauthenticated,
machine-readable official metadata endpoint; otherwise leave the provider as a
future/manual adapter. Do not add arbitrary catalog dumps, credentials, paid
calls, or model invocation paths merely to increase menu counts.

## Normalization and update policy

Normalize source metadata into the provider-neutral Model contract only.
Preserve source attribution, record corrections and conflicts in the adapter
decision record, omit unknown facts instead of inferring them, and never copy
provider code, proprietary registry content, credentials, or unreviewed
catalog dumps. The imported normalizer performs no new AOS-specific provider
integration in this baseline.

Refreshes must be reproducible from an identified input snapshot and manifest
hash. Do not silently follow a mutable branch. User-defined sources are
opt-in-only and must use the same source, terms, normalization, and artifact
boundary.
