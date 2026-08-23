import { getAdminMediaDiagnostics } from "@repo/database";
import { db } from "@repo/database/client";

import { adminProcedure } from "../../../orpc/procedures";

export const adminMediaDiagnostics = adminProcedure
	.route({ method: "GET", path: "/admin/media/diagnostics", tags: ["Admin", "Media"] })
	.handler(async () => getAdminMediaDiagnostics(db));
