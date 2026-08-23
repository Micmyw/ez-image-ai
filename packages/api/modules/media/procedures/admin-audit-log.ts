import { listAdminMediaAudit } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";

function decodeAuditCursor(value: string | undefined) {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
			createdAt?: string;
			id?: string;
		};
		const createdAt = new Date(parsed.createdAt ?? "");
		if (!parsed.id || Number.isNaN(createdAt.getTime())) throw new Error("invalid");
		return { createdAt, id: parsed.id };
	} catch {
		throw new Error("INVALID_CURSOR");
	}
}

export const listMediaAuditLog = adminProcedure
	.route({ method: "GET", path: "/admin/media/audit", tags: ["Admin", "Media"] })
	.input(
		z.object({
			limit: z.number().int().min(1).max(100).default(20),
			cursor: z.string().max(512).optional(),
		}),
	)
	.handler(async ({ input }) =>
		listAdminMediaAudit({ limit: input.limit, cursor: decodeAuditCursor(input.cursor) }, db),
	);
