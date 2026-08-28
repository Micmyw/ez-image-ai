import { schedules } from "@trigger.dev/sdk";

import { expireGuestMedia } from "../src/handlers/expire-guest-media";
import { databaseGuestMediaExpiryDependencies } from "../src/runtime";

export const expireGuestMediaTask = schedules.task({
	id: "media-expire-guest-media",
	cron: "*/5 * * * *",
	queue: { name: "media-guest-retention", concurrencyLimit: 1 },
	maxDuration: 120,
	run: () =>
		expireGuestMedia({ now: new Date(), limit: 100 }, databaseGuestMediaExpiryDependencies),
});
