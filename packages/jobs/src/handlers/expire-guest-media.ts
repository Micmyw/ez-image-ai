import type {
	GuestMediaExpiryDependencies,
	GuestMediaExpiryInput,
	GuestMediaExpiryResult,
} from "../contracts";

export function expireGuestMedia(
	input: GuestMediaExpiryInput,
	dependencies: GuestMediaExpiryDependencies,
): Promise<GuestMediaExpiryResult> {
	return dependencies.expire(input);
}
