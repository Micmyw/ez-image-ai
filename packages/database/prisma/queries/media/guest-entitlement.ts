import type { Prisma } from "../../generated/client";

type EntitlementClient = Pick<
	Prisma.TransactionClient,
	"guestTrialEntitlement" | "guestMediaTrial"
>;

export function guestEntitlementSubjects(input: { ownerId: string; browserSubjectHash?: string }) {
	return [
		`owner:${input.ownerId}`,
		...(input.browserSubjectHash ? [`browser:${input.browserSubjectHash}`] : []),
	].sort();
}

/** A campaign, clock change or retired abuse evidence cannot renew this receipt. */
export async function getGuestLifetimeAllowance(
	input: { ownerId: string; browserSubjectHash?: string },
	client: EntitlementClient,
) {
	const receipt = await client.guestTrialEntitlement.findFirst({
		where: { subjectKey: { in: guestEntitlementSubjects(input) } },
		select: { trialId: true, reservedJobId: true },
	});
	// Covers historical admitted owners during a receiver-first transition. This
	// deliberately has no campaign/date/abuse-evidence filters.
	const historical = receipt
		? null
		: await client.guestMediaTrial.findFirst({
				where: { ownerId: input.ownerId },
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
				select: { id: true, currentJobId: true, consumedJobId: true },
			});
	return {
		limit: 1 as const,
		remaining: receipt || historical ? 0 : 1,
		resetsAt: null,
		existingJobId:
			receipt?.reservedJobId ?? historical?.currentJobId ?? historical?.consumedJobId ?? null,
	};
}

/** Caller holds all sorted subject advisory locks and commits job/funding together. */
export async function reserveGuestLifetimeEntitlement(
	input: { ownerId: string; browserSubjectHash: string; trialId: string; jobId: string; now: Date },
	tx: Pick<Prisma.TransactionClient, "guestTrialEntitlement">,
) {
	for (const subjectKey of guestEntitlementSubjects(input)) {
		await tx.guestTrialEntitlement.create({
			data: {
				subjectKey,
				trialId: input.trialId,
				reservedJobId: input.jobId,
				createdAt: input.now,
			},
		});
	}
}
