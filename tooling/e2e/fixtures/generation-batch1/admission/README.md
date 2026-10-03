# Admission timing-only baseline

These fixtures contain source code and synthetic in-memory simulation evidence only. They contain no production records, prompt history, provider credentials, tokens or signed URLs. No test here calls a real moderation or generation service.

The four `.ts.txt` files are byte-for-byte copies of the timing-only sources saved before the batch 1 admission behavior change. `admission-before.json.txt` is the original single-sample evidence, copied without modification. The `.txt` suffix prevents source generation or formatting from altering the evidence. The test checks its three procedure hashes before loading the baseline. The original evidence did not hash `generation-authorization.ts`; the archived authorization content was separately compared with commit `aed472af9f843d2503a55eec252b086b248b63fe` (equal after CRLF normalization), and subsequent verified evidence records its hash too.

`packages/api/modules/media/procedures/admission-simulation.test.ts` relocates relative import paths into ignored runtime files under `packages/api/.cache/generation-batch1/admission-baseline-runtime/`. It does not edit the checkout or change archived business logic. The rest of the harness and shared dispatch handler are the same for both admission variants. This isolates the admission change rather than claiming to replay an entire historical deployment.

From the repository root, in a process with installed workspace dependencies:

```powershell
$env:GENERATION_ADMISSION_SNAPSHOT='verified'
pnpm --filter @repo/api test modules/media/procedures/admission-simulation.test.ts
```

The command writes new before/after evidence under `.cache/generation-batch1/`: bare-domain return and mock Kie acceptance, plus actual protected procedure/RPC Fetch encoding and decoding. No external network or real database is used. Each variant runs three samples per scenario. Original cache snapshots are retained; the tracked fixtures make replay possible without those cache files.
