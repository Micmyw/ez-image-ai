import { db } from "@repo/database/client";
import { getImagePassBalance as loadImagePassBalance } from "@repo/database/media-image-passes";

import { protectedProcedure } from "../../../orpc/procedures";

export const getImagePassBalance = protectedProcedure
	.route({ method: "GET", path: "/media/image-pass/balance", tags: ["Media"] })
	.handler(async ({ context: { user, responseHeaders } }) => {
		responseHeaders?.set("Cache-Control", "private, no-store");
		return loadImagePassBalance({ ownerId: user.id }, db);
	});
