import * as runtime from "@prisma/client/runtime/wasm-compiler-edge";

import { registerQueryCompilerCachePostgresSuite } from "../../../test-support/query-compiler-cache-postgres-suite";

// Actual ClientEngine panic signaling, with test-side signal injection rather than a Rust panic.
registerQueryCompilerCachePostgresSuite("ESM", runtime, "engine-errors");
