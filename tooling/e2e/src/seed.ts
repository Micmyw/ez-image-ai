import { createHash } from "node:crypto";

import { auth } from "@repo/auth";
import { createCreditGrant, createUser, createUserAccount } from "@repo/database";
import { db } from "@repo/database/client";
import { createAssetObjectKey, putPrivateMediaObject } from "@repo/storage";

import { E2E_PASSWORD, E2E_PNG, emptyEmail, fundedEmail } from "./fixtures";
import { assertLocalMediaE2E } from "./guard";

export async function seedLocalMediaE2E(): Promise<void> {
	const { runId } = assertLocalMediaE2E();
	const mediaModelOverrideKeys = [
		"media.generation.enabled",
		"media.model.image-fast.enabled",
		"media.model.image-quality.enabled",
		"media.model.video-fast.enabled",
		"media.model.video-quality.enabled",
	];
	await db.runtimeConfigOverride.updateMany({
		where: {
			active: true,
			configKey: {
				in: mediaModelOverrideKeys,
			},
		},
		data: { active: false, revertedAt: new Date() },
	});
	const disabledActiveOverrideCount = await db.runtimeConfigOverride.count({
		where: {
			active: true,
			configKey: { in: mediaModelOverrideKeys },
			value: { equals: false },
		},
	});
	if (disabledActiveOverrideCount !== 0) {
		throw new Error("Local media E2E seed left an active disabled media runtime override");
	}
	const funded = await ensureCredentialUser(fundedEmail(runId), `E2E Funded ${runId}`);
	await ensureCredentialUser(emptyEmail(runId), `E2E Empty ${runId}`);
	await ensureCreatorSubscription(funded.id, runId);

	const account = await db.creditAccount.upsert({
		where: { ownerType_ownerId: { ownerType: "USER", ownerId: funded.id } },
		create: { ownerType: "USER", ownerId: funded.id },
		update: {},
	});
	await createCreditGrant(
		{
			accountId: account.id,
			amount: 1_000n,
			referenceKey: `e2e:${runId}:funded`,
			metadata: { source: "local-media-e2e", runId },
		},
		db,
	);
	await db.creditAccount.upsert({
		where: {
			ownerType_ownerId: {
				ownerType: "USER",
				ownerId: (await db.user.findUniqueOrThrow({ where: { email: emptyEmail(runId) } })).id,
			},
		},
		create: {
			ownerType: "USER",
			ownerId: (await db.user.findUniqueOrThrow({ where: { email: emptyEmail(runId) } })).id,
		},
		update: {},
	});

	const assetId = `asset_${createHash("sha256").update(`reuse:${runId}`).digest("base64url").slice(0, 24)}`;
	const objectKey = createAssetObjectKey(funded.id, assetId, "image/png");
	const stored = await putPrivateMediaObject({
		bucket: "media",
		key: objectKey,
		contentType: "image/png",
		body: E2E_PNG,
	});
	await db.mediaAsset.upsert({
		where: { id: assetId },
		create: {
			id: assetId,
			ownerType: "USER",
			ownerId: funded.id,
			kind: "INPUT",
			status: "READY",
			objectKey,
			mimeType: "image/png",
			byteSize: BigInt(stored.bytes),
			checksum: stored.sha256,
			sourceUrl: `e2e-seed:${runId}`,
		},
		update: { status: "READY", deletedAt: null },
	});
	await db.assetModerationResult.upsert({
		where: { assetId_provider: { assetId, provider: "e2e-seed" } },
		create: {
			assetId,
			provider: "e2e-seed",
			status: "APPROVED",
			categories: { runId },
			rawEnvelope: { decision: "ALLOW" },
		},
		update: { status: "APPROVED" },
	});
}

async function ensureCreatorSubscription(userId: string, runId: string): Promise<void> {
	const plan = await db.billingPlan.upsert({
		where: {
			provider_providerPriceId: {
				provider: "e2e",
				providerPriceId: "e2e-creator",
			},
		},
		create: {
			provider: "e2e",
			providerPriceId: "e2e-creator",
			name: "creator",
			creditsPerPeriod: 1_000n,
			priceMicros: 0n,
			currency: "USD",
			metadata: { planId: "creator", source: "local-media-e2e" },
		},
		update: { active: true, metadata: { planId: "creator", source: "local-media-e2e" } },
	});
	await db.subscription.upsert({
		where: { providerSubscriptionId: `e2e:${runId}:creator` },
		create: {
			ownerType: "USER",
			ownerId: userId,
			provider: "e2e",
			providerSubscriptionId: `e2e:${runId}:creator`,
			planId: plan.id,
			status: "ACTIVE",
		},
		update: { ownerId: userId, planId: plan.id, status: "ACTIVE" },
	});
}

async function ensureCredentialUser(email: string, name: string) {
	const existing = await db.user.findUnique({ where: { email } });
	if (existing) return existing;
	const user = await createUser({
		email,
		name,
		role: "user",
		emailVerified: true,
		onboardingComplete: true,
	});
	const authContext = await auth.$context;
	await createUserAccount({
		userId: user.id,
		providerId: "credential",
		accountId: user.id,
		hashedPassword: await authContext.password.hash(E2E_PASSWORD),
	});
	return user;
}

seedLocalMediaE2E()
	.then(() => db.$disconnect())
	.catch(async (error) => {
		console.error(error);
		await db.$disconnect();
		process.exitCode = 1;
	});
