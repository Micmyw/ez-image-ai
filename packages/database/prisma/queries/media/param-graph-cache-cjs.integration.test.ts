import { createRequire } from "node:module";

import type * as edgeEsm from "@prisma/client/runtime/wasm-compiler-edge";

import { registerParamGraphCacheSuite } from "./testing/param-graph-cache-suite";

const runtime = createRequire(import.meta.url)(
	"@prisma/client/runtime/wasm-compiler-edge",
) as typeof edgeEsm;
registerParamGraphCacheSuite("CJS", runtime);
