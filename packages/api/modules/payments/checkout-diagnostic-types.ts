import {
	checkoutBrowserEventSchema,
	checkoutDiagnosticSchema,
	checkoutDiagnosticOutcomeSchema,
} from "@repo/database";
import { z } from "zod";

export const checkoutBrowserDiagnosticInputSchema = z
	.object({
		intentId: z.string().trim().min(1).max(128),
		event: checkoutBrowserEventSchema,
	})
	.strict();
export type CheckoutBrowserDiagnosticInput = z.infer<typeof checkoutBrowserDiagnosticInputSchema>;

export const checkoutDiagnosticsOutputSchema = z.object({
	truncated: z.boolean(),
	rows: z.array(
		z.object({
			id: z.string(),
			ownerId: z.string(),
			ownerType: z.enum(["USER", "ORGANIZATION"]),
			provider: z.string(),
			productKind: z.string(),
			planKey: z.string(),
			status: z.string(),
			createdAt: z.string(),
			expiresAt: z.string().nullable(),
			expired: z.boolean(),
			outcome: checkoutDiagnosticOutcomeSchema,
			eventsTruncated: z.boolean(),
			unreadableEvents: z.number().int().nonnegative(),
			events: z.array(
				z.object({ id: z.string(), receivedAt: z.string(), diagnostic: checkoutDiagnosticSchema }),
			),
		}),
	),
});
export type CheckoutDiagnosticsOutput = z.infer<typeof checkoutDiagnosticsOutputSchema>;
