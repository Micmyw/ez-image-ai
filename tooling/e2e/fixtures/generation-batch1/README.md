# Generation batch 1 timing-only baseline

These text fixtures preserve the instrumented source saved before the 1A/1B behavior changes, based on `aed472af9f843d2503a55eec252b086b248b63fe`. They are test inputs, not production modules or a second supported implementation. The `.txt` suffix prevents normal TypeScript builds from compiling their historical relative imports.

The API, admission, Outbox and browser harnesses load these sources only in explicit baseline comparison mode. They substitute modules within the test process and never reset Git or replace working-tree files. Providers, database boundaries and private image endpoints are isolated mocks; no production data, prompt, credential or signed URL was copied into these fixtures.

Keep their bytes unchanged when updating the optimized implementation. Results are written under `.cache/generation-batch1/`; existing baseline evidence must not be overwritten. For the measured conditions, commands and interpretation limits, see `docs/operations/generation-batch1-validation-2026-09-30.md` in the repository root.
