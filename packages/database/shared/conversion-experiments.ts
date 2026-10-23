import {
	EXPERIMENT_CONVERSION_WINDOW_MS,
	GROWTH_EXPERIMENTS,
	growthExperimentVariant,
	type GrowthExperimentId,
} from "@repo/config/growth-experiments";

import type { AdminAnalyticsFacts } from "./admin-analytics";
import type { ConversionEvent } from "./conversion-funnel";

function groupBy<T, K>(items: readonly T[], key: (item: T) => K) {
	const groups = new Map<K, T[]>();
	for (const item of items) {
		const id = key(item);
		const group = groups.get(id) ?? [];
		group.push(item);
		groups.set(id, group);
	}
	return groups;
}

/** Browser observations establish exposure, never payment. Payment uses an exact persisted checkout. */
export function buildConversionExperiments(
	facts: AdminAnalyticsFacts,
	allEvents: ConversionEvent[],
	from: Date,
	to: Date,
	filter: { source?: string; device?: string },
) {
	const customers = new Set(
		facts.users
			.filter((u) => !u.isAnonymous && !u.legacyGuest && u.role !== "admin")
			.map((u) => u.id),
	);
	const excluded = new Set(
		allEvents
			.filter((e) => e.internal || (e.userId && !customers.has(e.userId)))
			.map((e) => e.sessionHash),
	);
	const events = allEvents.filter((e) => e.createdAt < to && !excluded.has(e.sessionHash));
	const eventsByBrowser = groupBy(events, (e) => e.sessionHash);
	const checkoutsByUser = groupBy(facts.checkouts, (c) => c.userId);
	const paymentsByCheckout = groupBy(facts.payments, (p) => p.checkoutIntentId);
	const accounts = new Map<string, Set<string>>();
	for (const e of events)
		if (e.userId) {
			const ids = accounts.get(e.sessionHash) ?? new Set<string>();
			ids.add(e.userId);
			accounts.set(e.sessionHash, ids);
		}
	return (Object.keys(GROWTH_EXPERIMENTS) as GrowthExperimentId[]).map((experimentId) => {
		const exposures = new Map<string, ConversionEvent>();
		for (const event of events) {
			if (
				!["experiment_exposed", "experiment_clicked"].includes(event.name) ||
				event.diagnostics?.experimentId !== experimentId ||
				event.diagnostics.variant !== growthExperimentVariant(experimentId, event.sessionHash)
			)
				continue;
			const previous = exposures.get(event.sessionHash);
			if (!previous || event.createdAt < previous.createdAt)
				exposures.set(event.sessionHash, event);
		}
		const browsersByUser = new Map<string, Set<string>>();
		for (const hash of exposures.keys())
			for (const id of accounts.get(hash) ?? []) {
				const browsers = browsersByUser.get(id) ?? new Set<string>();
				browsers.add(hash);
				browsersByUser.set(id, browsers);
			}
		return {
			experimentId,
			windowDays: 7,
			variants: GROWTH_EXPERIMENTS[experimentId].map((variant) => {
				const row = {
					variant,
					exposed: 0,
					clicked: 0,
					purchaseClicked: 0,
					linked: 0,
					ambiguous: 0,
					checkouts: 0,
					paid: 0,
					mature: 0,
					maturePaid: 0,
				};
				for (const [hash, exposure] of exposures) {
					if (
						exposure.createdAt < from ||
						exposure.diagnostics?.variant !== variant ||
						(filter.source && (exposure.source ?? "unknown") !== filter.source) ||
						(filter.device && exposure.device !== filter.device)
					)
						continue;
					row.exposed++;
					const until = exposure.createdAt.getTime() + EXPERIMENT_CONVERSION_WINDOW_MS;
					const mature = until <= to.getTime();
					if (mature) row.mature++;
					const after = (date: Date) =>
						date >= exposure.createdAt && date.getTime() < until && date < to;
					const browserEvents = (eventsByBrowser.get(hash) ?? []).filter((e) => after(e.createdAt));
					if (
						browserEvents.some(
							(e) =>
								e.name === "experiment_clicked" &&
								e.diagnostics?.experimentId === experimentId &&
								e.diagnostics.variant === variant,
						)
					)
						row.clicked++;
					if (browserEvents.some((e) => e.name === "purchase_clicked")) row.purchaseClicked++;
					const ids = [...(accounts.get(hash) ?? [])];
					if (ids.length > 1 || (ids[0] && (browsersByUser.get(ids[0])?.size ?? 0) > 1)) {
						row.ambiguous++;
						continue;
					}
					const userId = ids[0];
					// A server-resolved account observation must exist within this conversion window.
					if (!userId || !browserEvents.some((e) => e.userId === userId)) continue;
					row.linked++;
					const checkouts = (checkoutsByUser.get(userId) ?? []).filter((c) => after(c.createdAt));
					if (checkouts.length) row.checkouts++;
					const paid = checkouts.some((checkout) =>
						(paymentsByCheckout.get(checkout.id) ?? []).some((p) => {
							return (
								checkout &&
								p.userId === userId &&
								p.ownerType === checkout.ownerType &&
								p.ownerId === checkout.ownerId &&
								p.environment === "production" &&
								p.evidence === "verified" &&
								p.renewal === false &&
								p.amountMicros !== null &&
								p.amountMicros > 0n &&
								p.paidAt &&
								after(p.paidAt) &&
								p.paidAt >= checkout.createdAt
							);
						}),
					);
					if (paid) {
						row.paid++;
						if (mature) row.maturePaid++;
					}
				}
				return row;
			}),
		};
	});
}
