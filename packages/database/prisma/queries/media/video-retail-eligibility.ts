import {
	VIDEO_ANNUAL_ELIGIBILITY_VERSION,
	VIDEO_RETAIL_PRICE_VERSION,
	type VideoRetailEligibility,
} from "@repo/config/video-pricing.server";

import { findEffectivePaidSubscription } from "./billing";
import type { MediaDatabaseClient } from "./types";

/** Cadence comes only from the effective, paid server subscription, never a checkout or UI plan. */
export async function resolveVideoRetailEligibility(
	ownerId: string,
	client: MediaDatabaseClient,
	now = new Date(),
): Promise<VideoRetailEligibility> {
	const standard: VideoRetailEligibility = {
		version: VIDEO_ANNUAL_ELIGIBILITY_VERSION,
		ownerId,
		audience: "standard",
		subscriptionId: null,
		planKey: null,
		validUntil: null,
	};
	const subscription = await findEffectivePaidSubscription(
		{ ownerType: "USER", ownerId, now },
		client,
	);
	if (
		!subscription ||
		subscription.ownerType !== "USER" ||
		subscription.ownerId !== ownerId ||
		subscription.plan.productKind !== "PLAN"
	)
		return standard;
	const metadata = subscription.plan.metadata;
	if (
		!metadata ||
		typeof metadata !== "object" ||
		Array.isArray(metadata) ||
		metadata.interval !== "year"
	)
		return standard;
	const planKey = metadata.planId;
	if (planKey !== "creator" && planKey !== "ultimate" && planKey !== "studio") return standard;
	const end =
		subscription.status === "PAST_DUE" ? subscription.graceEndsAt : subscription.currentPeriodEnd;
	if (!end || end <= now) return standard;
	return {
		...standard,
		audience: "annual",
		subscriptionId: subscription.id,
		planKey,
		validUntil: end.toISOString(),
	};
}

/** Run again at admission after the credit-account lock, sharing the refund serialization boundary. */
export async function assertVideoRetailEligibility(
	ownerId: string,
	details: unknown,
	client: MediaDatabaseClient,
	now: Date,
): Promise<void> {
	if (!details || typeof details !== "object" || !("retail" in details)) return;
	const retail = details.retail;
	if (
		!retail ||
		typeof retail !== "object" ||
		!("version" in retail) ||
		retail.version !== VIDEO_RETAIL_PRICE_VERSION ||
		!("eligibility" in retail)
	)
		throw new Error("PRICE_CHANGED");
	const proof = retail.eligibility;
	if (!proof || typeof proof !== "object") throw new Error("PRICE_CHANGED");
	const current = await resolveVideoRetailEligibility(ownerId, client, now);
	if (
		Object.entries(current).some(
			([key, value]) => (proof as Record<string, unknown>)[key] !== value,
		)
	)
		throw new Error("PRICE_CHANGED");
	if (
		!("display" in retail) ||
		!retail.display ||
		typeof retail.display !== "object" ||
		!("audience" in retail.display) ||
		retail.display.audience !== current.audience
	)
		throw new Error("PRICE_CHANGED");
}
