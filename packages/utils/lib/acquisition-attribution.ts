import { z } from "zod";

import {
	cleanFirstTouch,
	FIRST_TOUCH_MAX_AGE_SECONDS,
	sanitizeAttributionPath,
} from "./acquisition-attribution-core";

export {
	ATTRIBUTION_COOKIE_NAME,
	collectFirstTouchAttribution,
	FIRST_TOUCH_MAX_AGE_SECONDS,
	sanitizeAttributionPath,
} from "./acquisition-attribution-core";

const nullableText = z.string().nullable();
export const firstTouchAttributionSchema = z
	.object({
		version: z.literal(1),
		landingPath: nullableText,
		referrerOrigin: nullableText,
		source: z.enum(["direct", "referral", "campaign", "unknown"]),
		utmSource: nullableText,
		utmMedium: nullableText,
		utmCampaign: nullableText,
		capturedAt: z.iso.datetime(),
	})
	.strict();
export const registrationAttributionSchema = firstTouchAttributionSchema.extend({
	registeredAt: z.iso.datetime(),
});
export const checkoutAttributionSchema = z
	.object({
		version: z.literal(1),
		registration: registrationAttributionSchema.nullable(),
		triggerPath: nullableText,
		triggeredAt: z.iso.datetime(),
	})
	.strict();
export type FirstTouchAttribution = z.infer<typeof firstTouchAttributionSchema>;
export type RegistrationAttribution = z.infer<typeof registrationAttributionSchema>;
export type CheckoutAttribution = z.infer<typeof checkoutAttributionSchema>;

export function sanitizeFirstTouchAttribution(
	value: unknown,
	origin: string,
	now = new Date(),
): FirstTouchAttribution | null {
	const parsed = firstTouchAttributionSchema.safeParse(value);
	if (!parsed.success) return null;
	const age = now.getTime() - new Date(parsed.data.capturedAt).getTime();
	if (age < -5 * 60 * 1000 || age > FIRST_TOUCH_MAX_AGE_SECONDS * 1000) return null;
	return cleanFirstTouch(parsed.data, origin);
}
/** Read immutable snapshots without applying the browser cookie's expiry to old orders. */
export function parseCheckoutAttribution(
	value: unknown,
	origin = "https://ezimageai.com",
): CheckoutAttribution | null {
	const parsed = checkoutAttributionSchema.safeParse(value);
	if (!parsed.success) return null;
	const registration = parsed.data.registration;
	return {
		version: 1,
		registration: parseRegistrationAttribution(registration, origin),
		triggerPath: parsed.data.triggerPath
			? sanitizeAttributionPath(parsed.data.triggerPath, origin)
			: null,
		triggeredAt: parsed.data.triggeredAt,
	};
}
export function parseRegistrationAttribution(
	value: unknown,
	origin = "https://ezimageai.com",
): RegistrationAttribution | null {
	const parsed = registrationAttributionSchema.safeParse(value);
	if (!parsed.success) return null;
	const { registeredAt, ...firstTouch } = parsed.data;
	return { ...cleanFirstTouch(firstTouch, origin), registeredAt };
}
