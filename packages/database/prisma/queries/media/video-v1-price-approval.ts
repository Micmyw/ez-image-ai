import { z } from "zod";

const deadlineSchema = z.iso.datetime({ offset: true });

/** Frozen approval only; quote TTL and funding authorizations have separate lifetimes. */
export function assertVideoPriceApprovalValid(details: Record<string, unknown>, now: Date) {
	if (details.priceApprovalExpiryMode === "none") {
		if (details.validUntil !== null) throw new Error("VIDEO_PRICE_INVALID");
		return;
	}
	// Pre-mode snapshots remain finite. Missing/malformed dates never imply approval.
	if (details.priceApprovalExpiryMode !== undefined && details.priceApprovalExpiryMode !== "until")
		throw new Error("VIDEO_PRICE_INVALID");
	const deadline = deadlineSchema.safeParse(details.validUntil);
	if (!deadline.success) throw new Error("VIDEO_PRICE_INVALID");
	if (Date.parse(deadline.data) <= now.getTime()) throw new Error("VIDEO_PRICE_EXPIRED");
}
