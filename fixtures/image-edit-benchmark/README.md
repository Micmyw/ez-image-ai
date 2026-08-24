# Image-edit benchmark fixtures

The checked-in `manifest.json` is a contract fixture, not a real benchmark dataset. It expresses ten
input slots across the five required categories and three synthetic edit prompts per slot (30 tasks
total). Every source is a placeholder and every authorization status is pending. No image file,
license claim, private asset identifier, human rating, or Provider output is included.

`provider-request-mappings.json` contains `.test` transfer values and hand-authored expected request
bodies for the current Replicate, Fal, and Gemini adapter mappings. It exercises the existing
server-resolved image-to-image boundary; it is not evidence that any model accepts, completes, or
produces a usable edit.

## Preparing a private live manifest

Keep the live manifest and all source/output media outside Git. Make a private copy of
`manifest.json`, then for every input:

1. replace `{ "kind": "placeholder", "replacementRequired": true }` with a private
   `source` reference shaped as `{ "kind": "private-asset", "assetId": "asset_..." }`;
2. set `authorization.status` to `authorized` and provide a non-secret internal `evidenceRef`;
3. confirm the asset is owned by the benchmark operator, READY, checksum-bound, and covered by
   current input moderation evidence in the existing production pipeline;
4. keep at least ten inputs, at least three tasks per input, at least 30 tasks overall, and all five
   categories;
5. do not add source URLs, signed URLs, local file paths, raw Provider payloads, or credentials.

The harness rejects placeholder/pending inputs before checking credentials or invoking an executor.
A live executor must use the existing production job, remote URL policy, private transfer, and output
moderation path. Direct Provider output handling is prohibited.

## Safe dry run

From the repository root:

```bash
pnpm provider:benchmark:image-edit
```

The report contains counts and internal candidate tuples only. It omits source IDs, prompts, output
references, signed URLs, raw responses, credentials, and human rating records. All real metrics and
route decisions remain `NOT_COMPLETED` until an authorized run and human review are performed.
