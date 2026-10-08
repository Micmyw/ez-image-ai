import { db } from "@repo/database/client";
import {
	getBaseUrl,
	parseRegistrationAttribution,
	sanitizeAttributionPath,
	type CheckoutAttribution,
} from "@repo/utils";
import { z } from "zod";

// Optional analytics data cannot select an owner, price, plan, or redirect destination.
export const checkoutTriggerInputSchema = z
	.object({
		triggerPath: z.string().max(2048).nullable(),
	})
	.strict()
	.optional();

export async function captureCheckoutAttribution(
	headers: Headers,
	input: z.infer<typeof checkoutTriggerInputSchema>,
	userId: string,
	now = new Date(),
): Promise<CheckoutAttribution | undefined> {
	if (
		!input ||
		!headers
			.get("cookie")
			?.split(";")
			.some((cookie) => cookie.trim() === "consent=true")
	)
		return undefined;
	const origin = getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL, 3000);
	const user = await db.user.findUnique({
		where: { id: userId },
		select: { registrationAttribution: true },
	});
	return {
		version: 1,
		registration: parseRegistrationAttribution(user?.registrationAttribution, origin),
		triggerPath: input.triggerPath ? sanitizeAttributionPath(input.triggerPath, origin) : null,
		triggeredAt: now.toISOString(),
	};
}
