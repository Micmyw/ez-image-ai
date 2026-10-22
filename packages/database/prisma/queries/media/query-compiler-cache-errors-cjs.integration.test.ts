import { createRequire } from "node:module";

import type * as edgeRuntime from "@prisma/client/runtime/wasm-compiler-edge";

import { registerQueryCompilerCachePostgresSuite } from "../../../test-support/query-compiler-cache-postgres-suite";

const runtime = createRequire(import.meta.url)(
	"@prisma/client/runtime/wasm-compiler-edge",
) as typeof edgeRuntime;
registerQueryCompilerCachePostgresSuite("CJS", runtime, "engine-errors");
