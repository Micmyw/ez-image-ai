import { z } from "zod";

export const adminAnalyticsDimensions = [
	"source",
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"referrer",
	"country",
] as const;
const environment = z.enum(["production", "test"]);
export const adminAnalyticsOverviewInputSchema = z
	.object({ environment: environment.default("production") })
	.strict();
const filterValue = z.string().max(512).nullable().optional();
export const adminAnalyticsFunnelInputSchema = z
	.object({
		range: z.enum(["24h", "7d", "30d"]).default("7d"),
		environment: environment.default("production"),
		groupBy: z.enum(adminAnalyticsDimensions).default("utm_source"),
		filters: z
			.object({
				source: filterValue,
				utm_source: filterValue,
				utm_medium: filterValue,
				utm_campaign: filterValue,
				utm_term: filterValue,
				utm_content: filterValue,
				referrer: filterValue,
				country: filterValue,
			})
			.strict()
			.default({}),
	})
	.strict();
export const adminAnalyticsReportInputSchema = z
	.object({
		from: z.iso.datetime({ offset: true }).optional(),
		to: z.iso.datetime({ offset: true }).optional(),
		compare: z.boolean().default(true),
		environment: environment.default("production"),
	})
	.strict()
	.superRefine((value, context) => {
		if (!value.from || !value.to) return;
		const span = new Date(value.to).getTime() - new Date(value.from).getTime();
		if (span <= 0)
			context.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
		if (span > 92 * 86_400_000)
			context.addIssue({
				code: "custom",
				path: ["to"],
				message: "The period can span at most 92 days",
			});
	});

const count = z.number().int().nonnegative();
const micros = z.string().regex(/^-?\d+$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const coverage = z.object({
	unknownPaymentFacts: count,
	unknownPaymentDates: count,
	unknownPaymentUsers: count,
	unknownRenewalKinds: count,
	unknownAttributionUsers: count,
	trialingAvailable: z.literal(false),
	excludedTestPayments: count,
	unclassifiedPayments: count,
	unclassifiedRefunds: count,
	unlinkedCheckoutPayments: count,
	unclassifiedSubscriptions: count,
});
const revenue = z.object({
	currency,
	grossMicros: micros,
	refundedMicros: micros,
	netMicros: micros,
});
export const adminAnalyticsOverviewOutputSchema = z.object({
	generatedAt: z.string(),
	environment,
	users: z.object({ total: count, new24h: count }),
	revenue30d: z.array(revenue.extend({ orders: count })),
	revenueBasis: z.literal("payments_in_last_30d_less_their_recorded_refunds"),
	subscriptions: z.object({ active: count, trialing: z.null() }),
	openTickets: count,
	coverage,
});
const counts = z.object({ signups: count, checkouts: count, paid: count });
export const adminAnalyticsFunnelOutputSchema = z.object({
	range: z.enum(["24h", "7d", "30d"]),
	environment,
	since: z.string(),
	asOf: z.string(),
	groupBy: z.enum(adminAnalyticsDimensions),
	totals: counts,
	rows: z.array(counts.extend({ value: z.string().nullable() })),
	rowsTruncated: z.boolean(),
	options: z.object({
		source: z.array(z.string().nullable()),
		utm_source: z.array(z.string().nullable()),
		utm_medium: z.array(z.string().nullable()),
		utm_campaign: z.array(z.string().nullable()),
		utm_term: z.array(z.string().nullable()),
		utm_content: z.array(z.string().nullable()),
		referrer: z.array(z.string().nullable()),
		country: z.array(z.string().nullable()),
	}),
	basis: z.literal("registration_cohort_lifetime_nonrenewal_payments"),
	countryBasis: z.literal("consented_registration_proxy"),
	coverage,
});
const reportPeriod = z.object({
	from: z.string(),
	to: z.string(),
	users: z.object({ new: count }),
	checkout: z.object({ users: count, orders: count }),
	payments: z.object({
		orders: count,
		newPurchases: count,
		renewals: count,
		unknownPurchaseKinds: count,
		payingUsers: count,
		firstTimePayers: count,
		revenue: z.array(revenue),
	}),
	rates: z.object({
		checkoutToPaid: z.number().min(0).max(1).nullable(),
		signupToPaid: z.number().min(0).max(1).nullable(),
	}),
	subscriptions: z.object({ new: count, canceled: count }),
});
export const adminAnalyticsReportOutputSchema = z.object({
	generatedAt: z.string(),
	environment,
	current: reportPeriod,
	previous: reportPeriod.nullable(),
	subscriptionsActiveNow: count,
	revenueBasis: z.literal("payments_by_paid_at_refunds_by_occurred_at"),
	cancellationBasis: z.literal("currently_canceled_with_recorded_renewal_disabled_at"),
	coverage,
});
export type AdminAnalyticsOverview = z.infer<typeof adminAnalyticsOverviewOutputSchema>;
export type AdminAnalyticsFunnel = z.infer<typeof adminAnalyticsFunnelOutputSchema>;
export type AdminAnalyticsReport = z.infer<typeof adminAnalyticsReportOutputSchema>;
