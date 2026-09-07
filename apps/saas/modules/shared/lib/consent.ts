import type { ConsentStatus } from "@shared/components/ConsentProvider";

export function parseConsentStatus(value: string | undefined): ConsentStatus {
	if (value === "true") return "accepted";
	if (value === "false") return "declined";
	return "undecided";
}
