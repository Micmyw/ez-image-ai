import { createRequire } from "node:module";

import type * as edgeRuntime from "@prisma/client/runtime/wasm-compiler-edge";

import { registerQueryPlanCachePostgresSuite } from "../../../test-support/query-plan-cache-postgres-suite";

const runtime = createRequire(import.meta.url)(
	"@prisma/client/runtime/wasm-compiler-edge",
) as typeof edgeRuntime;
registerQueryPlanCachePostgresSuite("CJS", runtime, "panic");
