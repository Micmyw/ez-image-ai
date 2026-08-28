import { describe, expect, it, vi } from "vitest";

import { GuestAdmissionBusyError, admitGuestGeneration } from "./admit-guest-generation";

describe("guest slow-queue admission", () => {
	it("admits the oldest eligible guest job and returns its committed dispatch version", async () => {
		const admit = vi.fn(async () => ({
			outcome: "ADMITTED" as const,
			jobId: "job-oldest",
			version: 1,
		}));

		await expect(
			admitGuestGeneration(
				{ jobId: "job-oldest", trialId: "trial-oldest" },
				{ admit, now: () => new Date("2026-08-28T00:00:00.000Z") },
			),
		).resolves.toEqual({ outcome: "ADMITTED", jobId: "job-oldest", version: 1 });
		expect(admit).toHaveBeenCalledWith({
			jobId: "job-oldest",
			trialId: "trial-oldest",
			now: new Date("2026-08-28T00:00:00.000Z"),
		});
	});

	it("keeps a capacity-blocked durable event retryable instead of completing it", async () => {
		const retryAt = new Date("2026-08-28T00:00:30.000Z");

		await expect(
			admitGuestGeneration(
				{ jobId: "job-waiting", trialId: "trial-waiting" },
				{
					admit: async () => ({ outcome: "BUSY", retryAt }),
					now: () => new Date("2026-08-28T00:00:00.000Z"),
				},
			),
		).rejects.toMatchObject({
			name: "GuestAdmissionBusyError",
			message: "GUEST_ADMISSION_BUSY",
			retryAt,
		});
	});

	it("exposes a terminal pre-provider expiry and its single bounded replacement", async () => {
		await expect(
			admitGuestGeneration(
				{ jobId: "job-expired", trialId: "trial-1" },
				{
					admit: async () => ({
						outcome: "EXPIRED",
						jobId: "job-expired",
						replacementJobId: "job-replacement",
					}),
				},
			),
		).resolves.toEqual({
			outcome: "EXPIRED",
			jobId: "job-expired",
			replacementJobId: "job-replacement",
		});
	});

	it("exports a typed busy error for Trigger delivery retry classification", () => {
		const retryAt = new Date("2026-08-28T00:01:00.000Z");
		expect(new GuestAdmissionBusyError(retryAt)).toMatchObject({
			name: "GuestAdmissionBusyError",
			message: "GUEST_ADMISSION_BUSY",
			retryAt,
		});
	});
});
