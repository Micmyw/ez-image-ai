import type {
	GuestAdmissionDependencies,
	GuestAdmissionPayload,
	GuestAdmissionResult,
} from "../contracts";

export class GuestAdmissionBusyError extends Error {
	readonly retryAt: Date;

	constructor(retryAt: Date) {
		super("GUEST_ADMISSION_BUSY");
		this.name = "GuestAdmissionBusyError";
		this.retryAt = retryAt;
	}
}

export async function admitGuestGeneration(
	payload: GuestAdmissionPayload,
	dependencies: GuestAdmissionDependencies,
): Promise<Exclude<GuestAdmissionResult, { outcome: "BUSY" }>> {
	const result = await dependencies.admit({
		...payload,
		now: dependencies.now?.() ?? new Date(),
	});
	if (result.outcome === "BUSY") throw new GuestAdmissionBusyError(result.retryAt);
	return result;
}
