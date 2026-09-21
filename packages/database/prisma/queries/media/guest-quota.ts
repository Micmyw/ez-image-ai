import type { Prisma } from "../../generated/client";

/** Calendar-day allowance. Campaign identity and in-flight limits never reset with the day. */
export async function getGuestDailyAllowance(
	input: {
		ownerId: string;
		promotionPeriod: string;
		sourceSessionHash: string;
		deviceHash?: string;
		maximumAcceptedTrialsPerSessionPerDay: number;
		maximumAcceptedTrialsPerDevicePerDay: number;
		now: Date;
	},
	client: Pick<Prisma.TransactionClient, "guestMediaTrial">,
) {
	const dayStart = new Date(Math.floor(input.now.getTime() / 86_400_000) * 86_400_000);
	const resetsAt = new Date(dayStart.getTime() + 86_400_000);
	const where = {
		promotionPeriod: input.promotionPeriod,
		createdAt: { gte: dayStart, lt: resetsAt },
	};
	const [ownerCount, sessionCount, deviceCount] = await Promise.all([
		client.guestMediaTrial.count({ where: { ...where, ownerId: input.ownerId } }),
		client.guestMediaTrial.count({
			where: { ...where, sourceSessionHash: input.sourceSessionHash },
		}),
		input.deviceHash
			? client.guestMediaTrial.count({ where: { ...where, deviceHash: input.deviceHash } })
			: 0,
	]);
	return {
		limit: Math.min(
			input.maximumAcceptedTrialsPerSessionPerDay,
			input.maximumAcceptedTrialsPerDevicePerDay,
		),
		remaining: Math.max(
			0,
			Math.min(
				input.maximumAcceptedTrialsPerSessionPerDay - Math.max(ownerCount, sessionCount),
				input.maximumAcceptedTrialsPerDevicePerDay - deviceCount,
			),
		),
		resetsAt,
	};
}
