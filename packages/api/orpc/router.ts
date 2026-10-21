import type { RouterClient } from "@orpc/server";

import { adminRouter } from "../modules/admin/router";
import { aiRouter } from "../modules/ai/router";
import { ingestGrowthEvent } from "../modules/analytics/ingest";
import { getAnalyticsPolicy } from "../modules/analytics/policy";
import { ingestAggregateTraffic } from "../modules/analytics/traffic";
import { mediaRouter } from "../modules/media/router";
import { notificationsRouter } from "../modules/notifications/router";
import { organizationsRouter } from "../modules/organizations/router";
import { paymentsRouter } from "../modules/payments/router";
import { supportRouter } from "../modules/support/router";
import { usersRouter } from "../modules/users/router";
import { videoEffectsRouter } from "../modules/video-effects/router";
import { videoV1Router } from "../modules/video-v1/router";
import { publicProcedure } from "./procedures";

export const router = publicProcedure.router({
	admin: adminRouter,
	analytics: {
		ingest: ingestGrowthEvent,
		policy: getAnalyticsPolicy,
		traffic: ingestAggregateTraffic,
	},
	organizations: organizationsRouter,
	users: usersRouter,
	payments: paymentsRouter,
	support: supportRouter,
	ai: aiRouter,
	notifications: notificationsRouter,
	media: mediaRouter,
	videoV1: videoV1Router,
	videoEffects: videoEffectsRouter,
});

export type ApiRouterClient = RouterClient<typeof router>;
