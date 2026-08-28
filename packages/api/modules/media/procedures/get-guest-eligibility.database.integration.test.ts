import { createHash, randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import type { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const testEnvironment = vi.hoisted(() => ({
	databaseUrl: process.env.DATABASE_URL,
	testDatabaseUrl: process.env.TEST_DATABASE_URL,
}));
const capabilityMocks = vi.hoisted(() => ({ loadGuestCapability: vi.fn() }));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("../lib/guest-capability", () => capabilityMocks);
vi.mock("@repo/database/client", async () => {
	const connectionString = safeTestDatabaseUrl(
		testEnvironment.testDatabaseUrl,
		testEnvironment.databaseUrl,
	);
	const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
		import("@prisma/adapter-pg"),
		import("@repo/database/generated-client"),
	]);
	return { db: new PrismaClient({ adapter: new PrismaPg({ connectionString }) }) };
});

import { auth } from "@repo/auth";
import { db } from "@repo/database/client";

import { getGuestEligibility } from "./get-guest-eligibility";

const client = db as PrismaClient;

describe("getGuestEligibility claimed draft database boundary", () => {
	beforeAll(async () => {
		await client.$connect();
	});

	beforeEach(async () => {
		vi.clearAllMocks();
		await client.$executeRawUnsafe('TRUNCATE TABLE "user" CASCADE');
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest-placeholder", isAnonymous: true },
			session: { id: "guest-session-placeholder", userId: "guest-placeholder" },
		} as never);
		capabilityMocks.loadGuestCapability.mockResolvedValue({
			config: { enabled: true, promotionPeriod: "launch-task-5" },
			snapshot: { version: "guest-task-5" },
		});
	});

	afterAll(async () => {
		await client.$disconnect();
	});

	it("loads only the completed owner's submitted Standard draft relation", async () => {
		const fixture = await createClaimedDraftFixture();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: fixture.ownerId, isAnonymous: true },
			session: { id: `session-${fixture.ownerId}`, userId: fixture.ownerId },
		} as never);

		await expect(
			call(getGuestEligibility, undefined, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({
			eligible: true,
			reason: "AVAILABLE",
			claimedDraft: {
				sourceAssetId: fixture.assetId,
				prompt: "Replace the background with a violet studio",
			},
		});
	});
});

async function createClaimedDraftFixture() {
	const suffix = randomUUID();
	const ownerId = `guest-task-5-${suffix}`;
	const assetId = `asset-task-5-${suffix}`;
	const draftId = `draft-task-5-${suffix}`;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);

	await client.user.create({
		data: {
			id: ownerId,
			name: "Guest",
			email: `${suffix}@anonymous.invalid`,
			emailVerified: false,
			isAnonymous: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	await client.mediaAsset.create({
		data: {
			id: assetId,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			retentionClass: "GUEST_TRIAL",
			deleteAfter: expiresAt,
			objectKey: `users/${ownerId}/assets/${assetId}/original.png`,
			mimeType: "image/png",
			byteSize: 1024n,
			checksum: createHash("sha256").update(assetId).digest("hex"),
			finalizedAt: now,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationProviderTaskId: `moderation-${suffix}`,
			verificationRuleVersion: "media-safety-rule-v1",
			verificationPolicyVersion: "media-safety-policy-v1",
			verificationValidUntil: expiresAt,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId,
			assetChecksum: createHash("sha256").update(assetId).digest("hex"),
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "INPUT",
			provider: "test",
			providerTaskId: `moderation-${suffix}`,
			ruleVersion: "media-safety-rule-v1",
			policyVersion: "media-safety-policy-v1",
			status: "APPROVED",
			reasonCode: "ALLOW",
			categories: {},
			rawEnvelope: {},
			validUntil: expiresAt,
		},
	});
	await client.mediaAsset.update({ where: { id: assetId }, data: { status: "READY" } });
	await client.generationDraft.create({
		data: {
			id: draftId,
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			claimTokenHash: createHash("sha256").update(draftId).digest("hex"),
			assetId,
			productKey: "image-fast",
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "Replace the background with a violet studio",
			},
			status: "SUBMITTED",
			expiresAt,
		},
	});
	await client.guestSessionBootstrap.create({
		data: {
			ownerId,
			promotionPeriod: "launch-task-5",
			claimHash: createHash("sha256").update(`claim-${suffix}`).digest("hex"),
			idempotencyKey: `bootstrap-task-5-${suffix}`,
			claimedDraftId: draftId,
			sourceAssetId: assetId,
			expiresAt,
			completedAt: now,
		},
	});

	return { assetId, ownerId };
}

function safeTestDatabaseUrl(value: string | undefined, databaseUrl: string | undefined): string {
	if (!value) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	if (databaseUrl && value === databaseUrl) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	const parsed = new URL(value);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(databaseName)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected a disposable loopback test database");
	}
	return value;
}
