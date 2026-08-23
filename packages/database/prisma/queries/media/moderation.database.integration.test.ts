import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("generation quote moderation migration", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl(TEST_DATABASE_URL) }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("prevents approved quote security fields from being updated", async () => {
		const suffix = crypto.randomUUID();
		const quoteInput = {
			ownerType: "USER" as const,
			ownerId: `moderation-owner-${suffix}`,
			submittedByUserId: `moderation-owner-${suffix}`,
			productKey: "image-fast",
			catalogVersion: "catalog-v1",
			pricingVersion: "pricing-v1",
			credits: 4n,
			costMicros: 100n,
			inputSnapshot: { kind: "text-to-image", prompt: "approved prompt" },
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		};
		const quote = await createModeratedGenerationQuoteTransaction(
			{
				...quoteInput,
				moderation: {
					decision: "ALLOW",
					provider: "test",
					ruleVersion: "TEST_ALLOW_IMMUTABILITY_V1",
					reasonCode: "TEST_ALLOW_IMMUTABILITY",
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
				},
			},
			client,
		);

		await expect(
			client.generationQuote.update({
				where: { id: quote.id },
				data: { inputSnapshot: { kind: "text-to-image", prompt: "tampered prompt" } },
			}),
		).rejects.toThrow(/immutable/i);
	});
});

function safeTestDatabaseUrl(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		parsed.port !== "55432" ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(databaseName) ||
		["postgres", "template0", "template1"].includes(databaseName)
	) {
		throw new Error("TEST_DATABASE_URL must target a local test database on port 55432");
	}
	return value;
}
