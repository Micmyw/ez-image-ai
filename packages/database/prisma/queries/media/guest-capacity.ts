import type { Prisma } from "../../generated/client";
import type { MediaTransactionClient } from "./types";

export const GUEST_PRINCIPAL_CAPACITY_CONFIG_KEY =
	"media.guestGeneration.maximumTemporaryPrincipals";

export function assertGuestPrincipalCapacity(value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error("GUEST_PRINCIPAL_CAPACITY_INVALID");
	}
}

export async function resolveGuestPrincipalCapacity(
	defaultMaximum: number,
	client: Pick<Prisma.TransactionClient, "runtimeConfigOverride">,
) {
	const override = await client.runtimeConfigOverride.findFirst({
		where: { configKey: GUEST_PRINCIPAL_CAPACITY_CONFIG_KEY, active: true, revertedAt: null },
		orderBy: { version: "desc" },
		select: { value: true, version: true },
	});
	const maximumTemporaryPrincipals = override ? override.value : defaultMaximum;
	assertGuestPrincipalCapacity(maximumTemporaryPrincipals);
	return {
		maximumTemporaryPrincipals,
		version: override?.version ?? 0,
		source: override ? ("admin" as const) : ("environment" as const),
	};
}

export async function getAdminGuestPrincipalCapacity(
	defaultMaximum: number,
	client: MediaTransactionClient,
) {
	return client.$transaction(
		async (tx) => {
			const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
			const [capacity, anonymousPrincipals, activePrincipalLeases] = await Promise.all([
				resolveGuestPrincipalCapacity(defaultMaximum, tx),
				tx.user.count({ where: { isAnonymous: true } }),
				tx.guestSessionBootstrap.count({
					where: {
						ownerId: null,
						principalLeaseToken: { not: null },
						principalLeaseExpiresAt: { gt: clock!.now },
					},
				}),
			]);
			const used = anonymousPrincipals + activePrincipalLeases;
			return {
				generatedAt: clock!.now.toISOString(),
				...capacity,
				anonymousPrincipals,
				activePrincipalLeases,
				used,
				remaining: Math.max(0, capacity.maximumTemporaryPrincipals - used),
			};
		},
		{ isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 20_000 },
	);
}
