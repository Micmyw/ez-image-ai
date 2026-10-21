import { db } from "@repo/database/client";
import { getBaseUrl } from "@repo/utils";
import {
	parseRegistrationAttribution,
	sanitizeAttributionPath,
	type CheckoutAttribution,
} from "@repo/utils/lib/acquisition-attribution";
import { resolveAnalyticsPolicy } from "@repo/utils/lib/analytics-policy";
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
	if (!input || !resolveAnalyticsPolicy(headers).analyticsAllowed) return undefined;
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
