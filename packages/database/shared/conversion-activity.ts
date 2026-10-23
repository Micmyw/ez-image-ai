import type { AdminAnalyticsFacts } from "./admin-analytics";
import type { ConversionEvent, ConversionJob } from "./conversion-funnel";
import { registrationSource } from "./conversion-funnel";

/** In-window activity for new and existing customers; distinct from the registration cohort. */
export function buildConversionActivity(
	facts: AdminAnalyticsFacts,
	events: ConversionEvent[],
	jobs: ConversionJob[],
	from: Date,
	to: Date,
	filter: { source?: string; device?: string },
) {
	const device = new Map(events.filter((e) => e.userId).map((e) => [e.userId!, e.device]));
	const customers = facts.users.filter(
		(u) =>
			!u.isAnonymous &&
			!u.legacyGuest &&
			u.role !== "admin" &&
			(!filter.source || registrationSource(u.registrationAttribution) === filter.source) &&
			(!filter.device || (device.get(u.id) ?? "unknown") === filter.device),
	);
	return (["new", "existing"] as const).map((cohort) => {
		const ids = new Set(
			customers
				.filter((u) =>
					cohort === "new" ? u.createdAt >= from && u.createdAt < to : u.createdAt < from,
				)
				.map((u) => u.id),
		);
		const observed = events.filter(
			(e) => e.userId && ids.has(e.userId) && e.createdAt >= from && e.createdAt < to,
		);
		const attempted = jobs.filter(
			(j) => ids.has(j.userId) && j.createdAt >= from && j.createdAt < to,
		);
		const successful = attempted.filter(
			(j) => j.status === "SUCCEEDED" && j.terminalAt && j.terminalAt < to,
		);
		const latency = successful
			.map((j) => j.terminalAt!.getTime() - j.createdAt.getTime())
			.filter((ms) => ms >= 0)
			.sort((a, b) => a - b);
		const percentile = (p: number) =>
			latency.length ? latency[Math.ceil(p * latency.length) - 1]! : null;
		const users = (names: string[]) =>
			new Set(observed.filter((e) => names.includes(e.name)).map((e) => e.userId)).size;
		return {
			cohort,
			attemptedUsers: new Set(attempted.map((j) => j.userId)).size,
			jobs: attempted.length,
			succeeded: successful.length,
			failed: attempted.filter((j) => j.status === "FAILED" && j.terminalAt && j.terminalAt < to)
				.length,
			resultViewers: users(["result_viewed"]),
			downloaders: users(["result_downloaded"]),
			purchaseClicked: users(["purchase_clicked"]),
			checkouts: new Set(
				facts.checkouts
					.filter((c) => c.userId && ids.has(c.userId) && c.createdAt >= from && c.createdAt < to)
					.map((c) => c.userId),
			).size,
			paid: new Set(
				facts.payments
					.filter(
						(p) =>
							p.userId &&
							ids.has(p.userId) &&
							p.environment === "production" &&
							p.evidence === "verified" &&
							p.renewal === false &&
							p.amountMicros !== null &&
							p.amountMicros > 0n &&
							p.paidAt &&
							p.paidAt >= from &&
							p.paidAt < to,
					)
					.map((p) => p.userId),
			).size,
			latencySamples: latency.length,
			p50Ms: percentile(0.5),
			p90Ms: percentile(0.9),
		};
	});
}
