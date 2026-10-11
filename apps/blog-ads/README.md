# Isolated blog advertising assets

This package generates two static documents for the approved test origin `ads.ezimageai.com`.
It has no Worker entry point, bindings, dependencies, secrets or deployment script.
The shared `getBlogAdDocument` function is the only source of placement configuration.

Run from the repository root with the existing toolchain:

```sh
pnpm --filter @repo/blog-ads build
pnpm --filter @repo/blog-ads test
pnpm --filter @repo/blog-ads type-check
```

The default build overwrites both documents with empty HTML containing no supplier URL or script.
Generated `dist/banner.html`, `dist/native.html` and `dist/_headers` are ignored by Git.
Nothing in the generator makes network requests or changes Cloudflare configuration.

A temporary test requires an explicit future UTC deadline, at most two hours from generation:

```sh
pnpm --filter @repo/blog-ads build --test-until 2026-10-11T13:00:00Z
```

The date is an example of an authorized finite window; an expired or too distant date fails.
The generator hashes the exact guarded inline scripts and style. The bootstrap checks the deadline
before parser-inserting the original supplier tag. A direct top-level visit starts no supplier script.
At expiry the embedded document navigates itself to `about:blank`, ending the loaded document;
the embedding site must also remove the entire iframe at expiry. Rebuild without arguments to return
the static source to blank documents.

Each response has a strict CSP with only its original supplier host, `sandbox allow-scripts`, and
`frame-ancestors https://ezimageai.com`. It disables referrers, indexing, caching, inline attributes,
forms, workers and browser permissions. The embedding iframe must also retain its sandbox and
`referrerPolicy="no-referrer"`. There is no X-Frame-Options DENY header.

Pinned review fingerprints reject any source unit, style or template change. Unexpected source tags,
attributes, hosts or configuration fail generation. If real creatives request
another origin or capability, record the blocked behavior and stop the test; do not widen the policy.
These offline tests cannot establish supplier creative behavior, responsiveness, fill or revenue.

Cloudflare documents [_headers support](https://developers.cloudflare.com/workers/static-assets/headers/)
and [free static asset requests](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).
This config serves assets directly with no user Worker invocation. Deployment and domain changes
remain separate coordinated actions; generating files does not publish them.
