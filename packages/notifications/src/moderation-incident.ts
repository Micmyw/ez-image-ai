import { createHash } from "node:crypto";

import { getModerationIncidentNotification } from "@repo/database";

import { createInAppNotification } from "./in-app";

/** One in-app outage notification and one recovery per incident and administrator. */
export async function deliverModerationIncidentNotification(
	incidentId: string,
	state: "OPEN" | "RECOVERED",
) {
	const data = await getModerationIncidentNotification(incidentId);
	if (!data) return;
	for (const user of data.admins) {
		await createInAppNotification({
			userId: user.id,
			type: "MODERATION_ALERT",
			deliveryId: `moderation:${createHash("sha256").update(`${incidentId}:${state}:${user.id}`).digest("hex")}`,
			link: "/admin/media#moderation",
			data: {
				headline:
					state === "OPEN"
						? "Safety check service needs attention"
						: "Safety check service recovered",
				message:
					state === "OPEN"
						? "Technical failures reached the retry limit. Review the incident and any content allowed pending review."
						: "A completed safety check confirmed recovery. Previously flagged content still needs review.",
				incidentId,
				state,
			},
		});
	}
}
