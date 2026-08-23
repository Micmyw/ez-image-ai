import type { Prisma } from "../../generated/client";
import type { MediaTransactionClient } from "./types";
import { runSerializable } from "./types";

export async function upsertRateLimitBucket(
	input: {
		action: string;
		subjectHash: string;
		windowStart: Date;
		windowEnd: Date;
		limit: bigint;
	},
	client: MediaTransactionClient,
) {
	if (input.limit < 1n || input.windowEnd <= input.windowStart) {
		throw new Error("Rate limit window is invalid");
	}
	const rows = await client.$queryRaw<Array<{ count: bigint; allowed: boolean }>>`
		INSERT INTO "rate_limit_bucket" (
			"id", "action", "subjectHash", "windowStart", "windowEnd", "count", "updatedAt"
		)
		VALUES (
			gen_random_uuid()::text, ${input.action}, ${input.subjectHash},
			${input.windowStart}, ${input.windowEnd}, 1, now()
		)
		ON CONFLICT ("action", "subjectHash", "windowStart") DO UPDATE
		SET "count" = "rate_limit_bucket"."count" + 1,
		    "windowEnd" = EXCLUDED."windowEnd", "updatedAt" = now()
		RETURNING "count", ("count" <= ${input.limit}) AS "allowed"`;
	return rows[0]!;
}

export async function createRuntimeConfigOverride(
	input: {
		configKey: string;
		value: Prisma.InputJsonValue;
		reason: string;
		createdByUserId: string;
	},
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('runtime_config_override_version'))`;
		const [version] = await tx.$queryRaw<Array<{ nextVersion: number }>>`
			SELECT COALESCE(MAX("version"), 0) + 1 AS "nextVersion"
			FROM "runtime_config_override"`;
		const created = await tx.runtimeConfigOverride.create({
			data: { ...input, version: version!.nextVersion },
		});
		await tx.auditLog.create({
			data: {
				actorUserId: input.createdByUserId,
				action: "RUNTIME_CONFIG_OVERRIDE_CREATED",
				targetType: "RUNTIME_CONFIG_OVERRIDE",
				targetId: created.id,
				after: { configKey: created.configKey, version: created.version },
				metadata: {},
			},
		});
		return created;
	});
}

export async function revertRuntimeConfigOverride(
	id: string,
	revertedByUserId: string,
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		const existing = await tx.runtimeConfigOverride.findUniqueOrThrow({ where: { id } });
		if (!existing.active) return existing;
		const reverted = await tx.runtimeConfigOverride.update({
			where: { id },
			data: { active: false, revertedAt: new Date(), revertedByUserId },
		});
		await tx.auditLog.create({
			data: {
				actorUserId: revertedByUserId,
				action: "RUNTIME_CONFIG_OVERRIDE_REVERTED",
				targetType: "RUNTIME_CONFIG_OVERRIDE",
				targetId: id,
				before: { active: true },
				after: { active: false },
				metadata: {},
			},
		});
		return reverted;
	});
}

export async function getActiveRuntimeConfigOverrides(client: MediaTransactionClient) {
	return client.runtimeConfigOverride.findMany({
		where: { active: true },
		orderBy: { version: "asc" },
	});
}

export async function appendAuditLog(
	input: Prisma.AuditLogUncheckedCreateInput,
	client: MediaTransactionClient,
) {
	return client.auditLog.create({ data: input });
}
