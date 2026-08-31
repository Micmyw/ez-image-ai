import { createHash } from "node:crypto";

import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { auth } from "@repo/auth";
import {
	createCreditGrant,
	createUser,
	createUserAccount,
	expireGenerationDrafts,
} from "@repo/database";
import { db } from "@repo/database/client";
import { MEDIA_VERIFICATION_RETRY_POLICY } from "@repo/jobs";
import { createAssetObjectKey, putPrivateMediaObject } from "@repo/storage";

import { E2E_PASSWORD, E2E_PNG, emptyEmail, freeEmail, fundedEmail } from "./fixtures";
import { assertLocalMediaE2E, LOCAL_MEDIA_SAFETY_PROVIDER } from "./guard";

export async function seedLocalMediaE2E(): Promise<void> {
	const { runId } = assertLocalMediaE2E();
	await resetAbandonedMarketingDraftFixtures();
	const mediaModelOverrideKeys = [
		"media.generation.enabled",
		"media.model.image-fast.enabled",
		"media.model.image-quality.enabled",
		"media.model.video-fast.enabled",
		"media.model.video-quality.enabled",
		"media.guestGeneration.enabled",
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
	await enableGuestRuntimeOverride(runId);
	const funded = await ensureCredentialUser(fundedEmail(runId), `E2E Funded ${runId}`);
	const empty = await ensureCredentialUser(emptyEmail(runId), `E2E Empty ${runId}`);
	const free = await ensureCredentialUser(freeEmail(runId), `E2E Free ${runId}`);
	await ensureCreatorSubscription(funded.id, runId, "funded");
	await ensureCreatorSubscription(empty.id, runId, "empty");

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
			ownerType_ownerId: { ownerType: "USER", ownerId: empty.id },
		},
		create: { ownerType: "USER", ownerId: empty.id },
		update: {},
	});
	await ensureReadySourceAsset(funded.id, `reuse:${runId}`, runId);
	await ensureReadySourceAsset(empty.id, `empty:${runId}`, runId);
	await ensureReadySourceAsset(free.id, `free:${runId}`, runId);
}

async function enableGuestRuntimeOverride(runId: string): Promise<void> {
	await db.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('runtime_config_override_version'))`;
		const [next] = await tx.$queryRaw<Array<{ version: number }>>`
			SELECT COALESCE(MAX("version"), 0)::int + 1 AS "version" FROM "runtime_config_override"`;
		await tx.runtimeConfigOverride.create({
			data: {
				configKey: "media.guestGeneration.enabled",
				version: next!.version,
				value: true,
				reason: `Local deterministic guest E2E run ${runId}`,
				createdByUserId: `local-e2e:${runId}`,
			},
		});
	});
}

async function ensureReadySourceAsset(ownerId: string, assetSeed: string, fixtureRunId: string) {
	const assetId = `asset_${createHash("sha256").update(assetSeed).digest("base64url").slice(0, 24)}`;
	const objectKey = createAssetObjectKey(ownerId, assetId, "image/png");
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
					sourceUrl: `e2e-seed:${fixtureRunId}`,
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
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey,
				mimeType: "image/png",
				byteSize: BigInt(stored.bytes),
				checksum: stored.sha256,
				sourceUrl: `e2e-seed:${fixtureRunId}`,
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
				sourceUrl: `e2e-seed:${fixtureRunId}`,
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
				categories: { runId: fixtureRunId },
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

async function resetAbandonedMarketingDraftFixtures(): Promise<void> {
	const activeDrafts = await db.generationDraft.findMany({
		where: { status: "ACTIVE" },
		select: { id: true, inputSnapshot: true },
	});
	const abandonedIds = activeDrafts
		.filter((draft) => {
			const snapshot = draft.inputSnapshot;
			if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
			const prompt = (snapshot as Record<string, unknown>).prompt;
			return typeof prompt === "string" && prompt.startsWith("[e2e:draft] [run:");
		})
		.map((draft) => draft.id);
	const now = new Date();
	if (abandonedIds.length > 0) {
		await db.generationDraft.updateMany({
			where: { id: { in: abandonedIds }, status: "ACTIVE" },
			data: { expiresAt: now },
		});
		await expireGenerationDrafts(now, db, abandonedIds);
	}
	await db.rateLimitBucket.deleteMany({
		where: { action: { in: ["marketing-draft", "marketing-draft-global"] } },
	});
}

async function ensureCreatorSubscription(
	userId: string,
	runId: string,
	fixture: "funded" | "empty",
): Promise<void> {
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
	const providerSubscriptionId =
		fixture === "funded" ? `e2e:${runId}:creator` : `e2e:${runId}:creator:empty`;
	await db.subscription.upsert({
		where: {
			provider_providerSubscriptionId: { provider: "e2e", providerSubscriptionId },
		},
		create: {
			ownerType: "USER",
			ownerId: userId,
			provider: "e2e",
			providerSubscriptionId,
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
