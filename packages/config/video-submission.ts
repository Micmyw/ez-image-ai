import { z } from "zod";

import { videoV1ReceiptInputSchema } from "./video-v1";

const credits = z.string().regex(/^(0|[1-9]\d{0,9})$/);
export const videoRetailDisplaySchema = z
	.object({
		policyVersion: z.string().min(1).max(160),
		audience: z.enum(["annual", "standard"]),
		credits,
		standardCredits: credits,
		annualCredits: credits,
		savedCredits: credits,
		annualSavingsCredits: credits,
	})
	.strict();

/** Public consent only. Routing, prices and input identity are resolved on the server. */
export const videoSubmissionInputSchema = z
	.object({
		idempotencyKey: z.string().trim().min(1).max(128),
		// Receipt validation allows an accepted historical request to replay after retirement.
		request: videoV1ReceiptInputSchema,
		expectedCredits: z.string().regex(/^[1-9]\d{0,9}$/),
		expectedPricing: videoRetailDisplaySchema.nullable(),
	})
	.strict();

export type VideoSubmissionInput = z.infer<typeof videoSubmissionInputSchema>;
