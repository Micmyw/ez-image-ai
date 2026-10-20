import { and, eq, sql } from "drizzle-orm";

import { db } from "../client";
import { adminBotConfig, adminBotReceipt, user } from "../schema/postgres";

type BotClient = Pick<typeof db, "query" | "insert" | "update">;
type JsonInput =
	| string
	| number
	| boolean
	| { readonly [key: string]: JsonInput | null }
	| readonly (JsonInput | null)[];

export async function getAdminBotConfigRow(client: BotClient = db) {
	return (
		(await client.query.adminBotConfig.findFirst({
			where: eq(adminBotConfig.id, "platform"),
		})) ?? null
	);
}

export async function saveAdminBotConfigRow(
	input: {
		expectedVersion: number;
		payload: JsonInput;
		encryptedSecrets: string | null;
		updatedBy: string;
	},
	client: BotClient = db,
) {
	const data = {
		payload: input.payload,
		encryptedSecrets: input.encryptedSecrets,
		updatedBy: input.updatedBy,
		updatedAt: new Date(),
	};
	const changed =
		input.expectedVersion === 0
			? await client
					.insert(adminBotConfig)
					.values({ id: "platform", ...data, version: 1 })
					.onConflictDoNothing()
					.returning({ id: adminBotConfig.id })
			: await client
					.update(adminBotConfig)
					.set({ ...data, version: sql`${adminBotConfig.version} + 1` })
					.where(
						and(
							eq(adminBotConfig.id, "platform"),
							eq(adminBotConfig.version, input.expectedVersion),
						),
					)
					.returning({ id: adminBotConfig.id });
	if (changed.length !== 1) throw new Error("ADMIN_BOT_CONFIG_CONFLICT");
	return input.expectedVersion + 1;
}

export async function claimAdminBotReceipt(
	input: { eventKey: string; event: string },
	client: BotClient = db,
) {
	const result = await client
		.insert(adminBotReceipt)
		.values({ id: crypto.randomUUID(), ...input, status: "CLAIMED" })
		.onConflictDoNothing()
		.returning({ id: adminBotReceipt.id });
	return result.length === 1;
}

export async function completeAdminBotReceipt(
	input: { eventKey: string; results: JsonInput },
	client: BotClient = db,
) {
	const result = await client
		.update(adminBotReceipt)
		.set({ status: "COMPLETED", results: input.results, completedAt: new Date() })
		.where(and(eq(adminBotReceipt.eventKey, input.eventKey), eq(adminBotReceipt.status, "CLAIMED")))
		.returning({ id: adminBotReceipt.id });
	return { count: result.length };
}

export async function getSupportBotIdentity(userId: string, client: BotClient = db) {
	return (
		(await client.query.user.findFirst({
			where: eq(user.id, userId),
			columns: { name: true, email: true, createdAt: true, registrationAttribution: true },
		})) ?? null
	);
}

// getPaymentBotData belongs to the existing Prisma-only media payment domain.
// This alternative has no PaymentEvent, BillingPeriod, or ImagePassGrant schema,
// so it cannot establish the verified payment evidence required by that query.
