import * as runtime from "@prisma/client/runtime/wasm-compiler-edge";

import { registerQueryCompilerCachePostgresSuite } from "../../../test-support/query-compiler-cache-postgres-suite";

// Keep WASM glue ownership separate from the CommonJS runtime's loader.
registerQueryCompilerCachePostgresSuite("ESM", runtime);
