import { publicProcedure } from "../../../orpc/procedures";
import { getCurrentPublicCatalogProjection } from "../lib/executable-route-graph";

export const getPublicCatalog = publicProcedure
	.route({ method: "GET", path: "/media/catalog", tags: ["Media"] })
	.handler(async () => (await getCurrentPublicCatalogProjection()).catalog);
