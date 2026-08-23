import { recoverExpiredPaymentEvents } from "@repo/database";
import { db } from "@repo/database/client";
import { schedules } from "@trigger.dev/sdk";

export const recoverPaymentEventsTask = schedules.task({
	id: "media-recover-payment-events",
	cron: "* * * * *",
	queue: { name: "media-payment-recovery", concurrencyLimit: 1 },
	maxDuration: 120,
	run: () => recoverExpiredPaymentEvents({ limit: 25 }, db),
});
