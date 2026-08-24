import { createHash } from "node:crypto";

import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { auth } from "@repo/auth";
import { createCreditGrant, createUser, createUserAccount } from "@repo/database";
import { db } from "@repo/database/client";
import { MEDIA_VERIFICATION_RETRY_POLICY } from "@repo/jobs";
import { createAssetObjectKey, putPrivateMediaObject } from "@repo/storage";

import { E2E_PASSWORD, E2E_PNG, emptyEmail, fundedEmail } from "./fixtures";
import { assertLocalMediaE2E, LOCAL_MEDIA_SAFETY_PROVIDER } from "./guard";

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
	await db.$transaction(async (tx) => {
		const now = new Date();
		const existing = await tx.mediaAsset.findUnique({ where: { id: assetId } });
		const approvedEvidence = existing
			? await tx.assetModerationResult.findFirst({
					where: {
						assetId,
						assetChecksum: stored.sha256,
						verificationGeneration: existing.verificationGeneration,
						evidenceKind: "INPUT",
						provider: LOCAL_MEDIA_SAFETY_PROVIDER,
						ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
						policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
						status: "APPROVED",
						validUntil: { gt: now },
					},
				})
			: null;

		if (
			existing?.verificationValidUntil &&
			existing.verificationValidUntil > now &&
			approvedEvidence?.validUntil?.getTime() === existing.verificationValidUntil.getTime()
		) {
			await tx.mediaAsset.update({
				where: { id: assetId },
				data: {
					status: "READY",
					objectKey,
					mimeType: "image/png",
					byteSize: BigInt(stored.bytes),
					checksum: stored.sha256,
					deletedAt: null,
					sourceUrl: `e2e-seed:${runId}`,
				},
			});
			return;
		}

		const verificationGeneration = Math.max((existing?.verificationGeneration ?? 0) + 1, 1);
		const verificationValidUntil = new Date(
			now.getTime() + MEDIA_VERIFICATION_RETRY_POLICY.evidenceTtlMs,
		);
		await tx.mediaAsset.upsert({
			where: { id: assetId },
			create: {
				id: assetId,
				ownerType: "USER",
				ownerId: funded.id,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey,
				mimeType: "image/png",
				byteSize: BigInt(stored.bytes),
				checksum: stored.sha256,
				sourceUrl: `e2e-seed:${runId}`,
				verificationGeneration,
				verificationAttemptCount: 1,
				verificationProvider: LOCAL_MEDIA_SAFETY_PROVIDER,
				verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				verificationValidUntil,
			},
			update: {
				status: "VERIFYING",
				objectKey,
				mimeType: "image/png",
				byteSize: BigInt(stored.bytes),
				checksum: stored.sha256,
				deletedAt: null,
				sourceUrl: `e2e-seed:${runId}`,
				verificationGeneration,
				verificationAttemptCount: 1,
				verificationProvider: LOCAL_MEDIA_SAFETY_PROVIDER,
				verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				verificationValidUntil,
				verificationProviderTaskId: null,
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationNextAttemptAt: null,
				verificationLastErrorCode: null,
			},
		});
		await tx.assetModerationResult.create({
			data: {
				assetId,
				assetChecksum: stored.sha256,
				verificationGeneration,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: LOCAL_MEDIA_SAFETY_PROVIDER,
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				status: "APPROVED",
				reasonCode: "LOCAL_E2E_SEED_ALLOW",
				categories: { runId },
				rawEnvelope: { decision: "ALLOW", source: "local-media-e2e" },
				validUntil: verificationValidUntil,
			},
		});
		await tx.mediaAsset.update({
			where: { id: assetId },
			data: { status: "READY" },
		});
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
