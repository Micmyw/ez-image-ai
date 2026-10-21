import { z } from "zod";

export const conversionInputSchema = z
	.object({
		range: z.enum(["24h", "7d", "30d"]).default("30d"),
		source: z.string().max(256).optional(),
		device: z.enum(["mobile", "desktop", "tablet", "unknown"]).optional(),
	})
	.strict();
const count = z.number().int().nonnegative();
const steps = z.object({
	signups: count,
	generated: count,
	succeeded: count,
	purchaseClicked: count,
	checkouts: count,
	paid: count,
});
export const conversionOutputSchema = z.object({
	since: z.string(),
	asOf: z.string(),
	aggregateTraffic: z.object({
		since: z.string(),
		views: count,
		sources: z.array(z.object({ source: z.string(), views: count })),
	}),
	generationObservations: z.array(
		z.object({
			mediaKind: z.string(),
			phase: z.string(),
			publicModel: z.string().nullable(),
			textLength: z.string().nullable(),
			inputCount: count.nullable(),
			reason: z.string().nullable(),
			observations: count,
		}),
	),
	totals: steps.extend({
		checkoutRequested: count,
		checkoutRedirected: count,
		checkoutFailed: count,
	}),
	rows: z.array(steps.extend({ source: z.string(), browsers: count })),
	sources: z.array(z.string()),
	traffic: z.object({ browsers: count, pageViews: count }),
	visitorCohort: z.object({
		registeredBrowsers: count,
		successfulBrowsers: count,
		paidBrowsers: count,
		registrationRate: z.number().min(0).max(1).nullable(),
	}),
	coverage: z.object({
		unknownSourceUsers: count,
		usersWithBrowserEvents: count,
		internalBrowsersExcluded: count,
		firstObservedAt: z.string().nullable(),
	}),
	firstAttempt: z.object({ attempted: count, succeeded: count, failed: count }),
	checkoutFailures: z.array(z.object({ category: z.string(), events: count })),
	failures: z.array(z.object({ reason: z.string(), jobs: count })),
	checkoutProducts: z.array(
		z.object({
			productKind: z.string(),
			clicked: count,
			requested: count,
			redirected: count,
			failed: count,
		}),
	),
});
export type ConversionFunnel = z.infer<typeof conversionOutputSchema>;
