import type { MediaDatabaseClient } from "./types";
import { getMediaDatabaseClient } from "./types";

export async function listCreditReservationAllocations(
	reservationId: string,
	client?: MediaDatabaseClient,
) {
	return getMediaDatabaseClient(client).creditReservationAllocation.findMany({
		where: { reservationId },
		include: { lot: true },
		orderBy: [{ lot: { expiresAt: "asc" } }, { lot: { createdAt: "asc" } }, { lotId: "asc" }],
	});
}
