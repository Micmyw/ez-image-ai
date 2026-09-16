import { PrismaPg } from "@prisma/adapter-pg";
import { MODERATION_BYPASS_REASON } from "@repo/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	applyAdminModerationReview,
	assertQuoteModerationPermitted,
	completeAdminTextRecheck,
	recordModerationOutcome,
} from "./moderation-operations";
import {
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";

let client: PrismaClient;
beforeAll(() => {
	const url = new URL(process.env.TEST_DATABASE_URL!);
	if (url.hostname !== "127.0.0.1" || url.port !== "55432" || !/test/.test(url.pathname))
		throw new Error("Unsafe database");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
});
afterAll(() => client?.$disconnect());
function fixture(failures = 4) {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const base = {
		ownerType: "USER" as const,
		ownerId: id,
		submittedByUserId: id,
		productKey: "image-fast",
		catalogVersion: "v1",
		pricingVersion: "v1",
		credits: 4n,
		inputSnapshot: { prompt: "A forest" },
		expiresAt: new Date(Date.now() + 300_000),
	};
	return {
		...base,
		moderation: {
			decision: "BYPASS" as const,
			provider: `waffo-${id}`,
			ruleVersion: "v1",
			reasonCode: MODERATION_BYPASS_REASON,
			inputFingerprint: fingerprintGenerationQuoteSecurityPayload(base),
			retry: { failures, lastErrorCode: "MODERATION_TIMEOUT", startedAt: now, lastFailureAt: now },
		},
	};
}
function action(
	review: { id: string; version: number },
	decision: "APPROVE" | "REJECT" | "RECHECK",
) {
	return {
		reviewId: review.id,
		version: review.version,
		action: decision,
		reason: "Manually reviewed the original prompt",
		idempotencyKey: crypto.randomUUID(),
		actorUserId: "moderation-test-admin",
		verification: { provider: "test", ruleVersion: "v1", policyVersion: "v1" },
	};
}

describe("outage quote persistence and review", () => {
	it("cannot persist outage permission without an exhausted budget", async () => {
		await expect(createModeratedGenerationQuoteTransaction(fixture(3), client)).rejects.toThrow(
			"TEXT_MODERATION_BYPASS",
		);
	});
	it("atomically binds a bypassed quote to its review and keeps the quote immutable", async () => {
		const quote = await createModeratedGenerationQuoteTransaction(fixture(), client);
		const review = await client.moderationReview.findUniqueOrThrow({
			where: { targetType_targetId: { targetType: "QUOTE", targetId: quote.id } },
		});
		expect(review).toMatchObject({ status: "PENDING_REVIEW", failureCount: 4, bypassed: true });
		await client.$transaction((tx) => assertQuoteModerationPermitted(quote, tx));
		await expect(
			client.generationQuote.update({
				where: { id: quote.id },
				data: { moderationDecision: "ALLOW" },
			}),
		).rejects.toThrow(/immutable/i);
		await applyAdminModerationReview(action(review, "REJECT"), client);
		await expect(
			client.$transaction((tx) => assertQuoteModerationPermitted(quote, tx)),
		).rejects.toThrow("TEXT_MODERATION_EVIDENCE_INVALID");
	});
	it("permits only one concurrent administrator decision for a version", async () => {
		const quote = await createModeratedGenerationQuoteTransaction(fixture(), client);
		const review = await client.moderationReview.findUniqueOrThrow({
			where: { targetType_targetId: { targetType: "QUOTE", targetId: quote.id } },
		});
		const results = await Promise.allSettled([
			applyAdminModerationReview(action(review, "APPROVE"), client),
			applyAdminModerationReview(action(review, "REJECT"), client),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});
	it("retains the pending marker when a manual recheck also exhausts its retries", async () => {
		const input = fixture();
		const quote = await createModeratedGenerationQuoteTransaction(input, client);
		const review = await client.moderationReview.findUniqueOrThrow({
			where: { targetType_targetId: { targetType: "QUOTE", targetId: quote.id } },
		});
		await applyAdminModerationReview(action(review, "RECHECK"), client);
		await completeAdminTextRecheck(
			{ reviewId: review.id, version: review.version + 1, moderation: input.moderation },
			client,
		);
		await expect(
			client.moderationReview.findUniqueOrThrow({ where: { id: review.id } }),
		).resolves.toMatchObject({ status: "PENDING_REVIEW", failureCount: 8, bypassed: true });
	});
	it("ignores a stale recheck result after an administrator has blocked the prompt", async () => {
		const input = fixture();
		const quote = await createModeratedGenerationQuoteTransaction(input, client);
		let review = await client.moderationReview.findUniqueOrThrow({
			where: { targetType_targetId: { targetType: "QUOTE", targetId: quote.id } },
		});
		await applyAdminModerationReview(action(review, "RECHECK"), client);
		const recheckVersion = review.version + 1;
		review = await client.moderationReview.findUniqueOrThrow({ where: { id: review.id } });
		await applyAdminModerationReview(action(review, "REJECT"), client);
		expect(
			await completeAdminTextRecheck(
				{
					reviewId: review.id,
					version: recheckVersion,
					moderation: { ...input.moderation, decision: "ALLOW" },
				},
				client,
			),
		).toEqual({ stale: true, status: "REJECTED" });
		expect(
			(await client.moderationReview.findUniqueOrThrow({ where: { id: review.id } })).status,
		).toBe("REJECTED");
	});
	it("does not let an older success close a more recent outage", async () => {
		const input = fixture();
		const quote = await createModeratedGenerationQuoteTransaction(input, client);
		await client.$transaction((tx) =>
			recordModerationOutcome(
				{
					targetType: "TEXT_ATTEMPT",
					targetId: "old-check",
					provider: input.moderation.provider,
					stage: "TEXT",
					epoch: "v1",
					failures: 0,
					lastErrorCode: "",
					startedAt: new Date(0),
					lastFailureAt: new Date(0),
					status: "APPROVED",
				},
				tx,
			),
		);
		const review = await client.moderationReview.findUniqueOrThrow({
			where: { targetType_targetId: { targetType: "QUOTE", targetId: quote.id } },
		});
		expect(
			(await client.moderationIncident.findUniqueOrThrow({ where: { id: review.incidentId! } }))
				.status,
		).toBe("OPEN");
	});
});
