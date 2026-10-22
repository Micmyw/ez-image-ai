import * as runtime from "@prisma/client/runtime/wasm-compiler-edge";

import { registerQueryPlanCachePostgresSuite } from "../../../test-support/query-plan-cache-postgres-suite";

registerQueryPlanCachePostgresSuite("ESM", runtime, "isolation");
