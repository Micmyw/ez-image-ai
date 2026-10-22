import * as runtime from "@prisma/client/runtime/wasm-compiler-edge";

import { registerParamGraphCacheSuite } from "./testing/param-graph-cache-suite";

// Each runtime must own its compiler glue module in a separate test worker.
registerParamGraphCacheSuite("ESM", runtime);
