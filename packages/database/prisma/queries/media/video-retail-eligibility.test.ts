import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./billing", () => ({ findEffectivePaidSubscription: vi.fn() }));
import { findEffectivePaidSubscription } from "./billing";
import type { MediaDatabaseClient } from "./types";
import {
	assertVideoRetailEligibility,
	resolveVideoRetailEligibility,
} from "./video-retail-eligibility";

const now = new Date("2026-10-08T10:00:00Z");
const end = new Date("2027-01-01T00:00:00Z");
const client = {} as MediaDatabaseClient;
const effective = vi.mocked(findEffectivePaidSubscription);
function subscription() {
	return {
		id: "annual-owner",
		ownerType: "USER" as const,
		ownerId: "owner",
		status: "ACTIVE" as const,
		graceEndsAt: null,
		currentPeriodEnd: end,
		plan: {
			name: "Creator",
			metadata: { planId: "creator", interval: "year" },
			productKind: "PLAN" as const,
		},
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	effective.mockResolvedValue(subscription());
});
describe("server annual video qualification", () => {
	it.each(["creator", "ultimate", "studio"])(
		"qualifies a paid annual %s using the owner-scoped effective subscription",
		async (planId) => {
			const paid = subscription();
			paid.plan.metadata.planId = planId;
			effective.mockResolvedValue(paid);
			expect(await resolveVideoRetailEligibility("owner", client, now)).toMatchObject({
				audience: "annual",
				ownerId: "owner",
				planKey: planId,
				subscriptionId: "annual-owner",
				validUntil: end.toISOString(),
			});
			expect(effective).toHaveBeenCalledWith({ ownerType: "USER", ownerId: "owner", now }, client);
		},
	);
	it.each([
		{
			label: "monthly",
			change: {
				plan: { ...subscription().plan, metadata: { planId: "creator", interval: "month" } },
			},
		},
		{
			label: "missing cadence",
			change: { plan: { ...subscription().plan, metadata: { planId: "creator" } } },
		},
		{
			label: "unknown plan",
			change: { plan: { ...subscription().plan, metadata: { planId: "free", interval: "year" } } },
		},
		{
			label: "credit pack",
			change: { plan: { ...subscription().plan, productKind: "CREDIT_PACK" as const } },
		},
		{ label: "other user", change: { ownerId: "different-owner" } },
		{ label: "organization", change: { ownerType: "ORGANIZATION" as const } },
		{ label: "expired at boundary", change: { currentPeriodEnd: now } },
	])("does not qualify $label", async ({ change }) => {
		effective.mockResolvedValue({ ...subscription(), ...change });
		expect(await resolveVideoRetailEligibility("owner", client, now)).toMatchObject({
			audience: "standard",
			subscriptionId: null,
			validUntil: null,
		});
	});
	it("does not qualify absent, unpaid, fully refunded or expired subscriptions excluded by billing", async () => {
		effective.mockResolvedValue(null);
		expect((await resolveVideoRetailEligibility("owner", client, now)).audience).toBe("standard");
	});
	it("retains a canceled paid term and uses the existing paid grace boundary", async () => {
		effective.mockResolvedValue({ ...subscription(), status: "CANCELED" });
		expect((await resolveVideoRetailEligibility("owner", client, now)).audience).toBe("annual");
		effective.mockResolvedValue({ ...subscription(), status: "PAST_DUE", graceEndsAt: end });
		expect((await resolveVideoRetailEligibility("owner", client, now)).validUntil).toBe(
			end.toISOString(),
		);
		effective.mockResolvedValue({ ...subscription(), status: "PAST_DUE", graceEndsAt: now });
		expect((await resolveVideoRetailEligibility("owner", client, now)).audience).toBe("standard");
	});
	it("rejects qualification changes and cross-owner proof; preserves legacy/template snapshots", async () => {
		const eligibility = await resolveVideoRetailEligibility("owner", client, now);
		const details = {
			retail: {
				version: "video-retail-2026-10-08.1",
				eligibility,
				display: { audience: "annual" },
			},
		};
		await expect(
			assertVideoRetailEligibility("owner", details, client, now),
		).resolves.toBeUndefined();
		await expect(assertVideoRetailEligibility("another", details, client, now)).rejects.toThrow(
			"PRICE_CHANGED",
		);
		effective.mockResolvedValue(null);
		await expect(assertVideoRetailEligibility("owner", details, client, now)).rejects.toThrow(
			"PRICE_CHANGED",
		);
		await expect(
			assertVideoRetailEligibility("owner", { retail: {} }, client, now),
		).rejects.toThrow("PRICE_CHANGED");
		await expect(
			assertVideoRetailEligibility("owner", { template: {} }, client, now),
		).resolves.toBeUndefined();
	});
});
