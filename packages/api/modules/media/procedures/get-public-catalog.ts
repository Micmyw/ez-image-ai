import { getPublicProductCatalog } from "@repo/ai";

import { publicProcedure } from "../../../orpc/procedures";
import { getCurrentExecutableRouteGraphOptions } from "../lib/executable-route-graph";

export const getPublicCatalog = publicProcedure
	.route({ method: "GET", path: "/media/catalog", tags: ["Media"] })
	.handler(async () => getPublicProductCatalog(await getCurrentExecutableRouteGraphOptions()));
