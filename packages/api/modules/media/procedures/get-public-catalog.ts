import { getPublicProductCatalog } from "@repo/ai";

import { publicProcedure } from "../../../orpc/procedures";

export const getPublicCatalog = publicProcedure
	.route({ method: "GET", path: "/media/catalog", tags: ["Media"] })
	.handler(() => getPublicProductCatalog());
