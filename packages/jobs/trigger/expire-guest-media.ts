import { monitorGuestOperationalSafety } from "@repo/database";
import { db } from "@repo/database/client";
import { schedules } from "@trigger.dev/sdk";

import { expireGuestMedia } from "../src/handlers/expire-guest-media";
import { databaseGuestMediaExpiryDependencies } from "../src/runtime";

export const expireGuestMediaTask = schedules.task({
	id: "media-expire-guest-media",
	cron: "*/5 * * * *",
	queue: { name: "media-guest-retention", concurrencyLimit: 1 },
	maxDuration: 120,
	run: async ({ timestamp }) => {
		await expireGuestMedia({ now: timestamp, limit: 100 }, databaseGuestMediaExpiryDependencies);
		return monitorGuestOperationalSafety(db, {
			guestEnvironmentEnabled: process.env.GUEST_MEDIA_ENABLED === "true",
			guestPromotionPeriod: process.env.GUEST_PROMOTION_PERIOD ?? "",
			guestRiskBudgetMicros: guestRiskBudgetMicros(process.env.GUEST_RISK_BUDGET_MICROS),
			now: timestamp,
		});
	},
});

function guestRiskBudgetMicros(value: string | undefined): bigint {
	if (!value || !/^[1-9][0-9]*$/.test(value)) return 0n;
	return BigInt(value);
}
