import { AsyncLocalStorage } from "node:async_hooks";

export type RequestFreeEligibility = {
	status: "eligible" | "excluded" | "unverified";
	countryCode: string | null;
};

// OpenNext and the Worker entry can have separate copies of this module.
const key = Symbol.for("ezpic.request.free-eligibility.v1");
const globals = globalThis as typeof globalThis & {
	[key]?: AsyncLocalStorage<RequestFreeEligibility>;
};
const context = (globals[key] ??= new AsyncLocalStorage<RequestFreeEligibility>());

/** Only call at the platform ingress with the original Request.cf.country. */
export function runWithCloudflareFreeEligibility<T>(country: unknown, callback: () => T): T {
	const countryCode =
		typeof country === "string" && /^[A-Z]{2}$/.test(country) && !["XX", "ZZ"].includes(country)
			? country
			: null;
	return context.run(
		Object.freeze({
			status: countryCode === null ? "unverified" : countryCode === "IN" ? "excluded" : "eligible",
			countryCode,
		}),
		callback,
	);
}

/** Headers, client claims and deployment configuration cannot establish location. */
export function getRequestFreeEligibility(): RequestFreeEligibility {
	return context.getStore() ?? { status: "unverified", countryCode: null };
}

export function canReceiveNewFreeAllowance(): boolean {
	return getRequestFreeEligibility().status === "eligible";
}

// Guest sponsorship is independent of the registered sign-in allowance.
// US/Canada, EU members and the remaining European countries; no overseas territories.
const GUEST_TRIAL_COUNTRIES = new Set([
	"US",
	"CA",
	"AT",
	"BE",
	"BG",
	"HR",
	"CY",
	"CZ",
	"DK",
	"EE",
	"FI",
	"FR",
	"DE",
	"GR",
	"HU",
	"IE",
	"IT",
	"LV",
	"LT",
	"LU",
	"MT",
	"NL",
	"PL",
	"PT",
	"RO",
	"SK",
	"SI",
	"ES",
	"SE",
	"AL",
	"AD",
	"BY",
	"BA",
	"IS",
	"XK",
	"LI",
	"MD",
	"MC",
	"ME",
	"MK",
	"NO",
	"RU",
	"SM",
	"RS",
	"CH",
	"UA",
	"GB",
	"VA",
]);

export function getRequestGuestTrialEligibility(): RequestFreeEligibility {
	const { countryCode } = getRequestFreeEligibility();
	return {
		countryCode,
		status:
			countryCode === null
				? "unverified"
				: GUEST_TRIAL_COUNTRIES.has(countryCode)
					? "eligible"
					: "excluded",
	};
}

export function assertRequestFreeEligibility(): void {
	const eligibility = getRequestFreeEligibility();
	if (eligibility.status !== "eligible") {
		throw new Error(
			eligibility.status === "excluded" ? "FREE_REGION_EXCLUDED" : "FREE_REGION_UNVERIFIED",
		);
	}
}
