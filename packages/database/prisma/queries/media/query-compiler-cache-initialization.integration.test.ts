import * as runtime from "@prisma/client/runtime/wasm-compiler-edge";

import { registerQueryCompilerCachePostgresSuite } from "../../../test-support/query-compiler-cache-postgres-suite";

// A rejected constructor disables this isolate's cache, so it needs a fresh worker.
registerQueryCompilerCachePostgresSuite("ESM", runtime, "initialization");
