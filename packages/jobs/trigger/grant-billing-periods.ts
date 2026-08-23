import { schedules } from "@trigger.dev/sdk";

import { grantBillingPeriods } from "../src/handlers/grant-billing-periods";

export const grantBillingPeriodsTask = schedules.task({
	id: "media-grant-billing-periods",
	cron: "5 * * * *",
	queue: { name: "media-billing-periods", concurrencyLimit: 1 },
	maxDuration: 120,
	run: () => grantBillingPeriods({ limit: 100 }),
});
