import { z } from "zod";

const id = z.string().trim().min(1).max(160);
export const adminContentOwnerSchema = z
	.object({ ownerType: z.enum(["USER", "ORGANIZATION", "GUEST_BROWSER", "UNKNOWN"]), ownerId: id })
	.strict();
const recordKind = z.enum(["INPUT", "OUTPUT", "JOB", "BLOCKED_REQUEST"]);
const customerCursor = adminContentOwnerSchema.extend({ lastActivityAt: z.coerce.date() });
const contentCursor = z.object({ createdAt: z.coerce.date(), recordKind, id }).strict();
export const adminContentCustomersInputSchema = z
	.object({
		limit: z.number().int().min(1).max(50).default(25),
		search: z.string().trim().min(1).max(254).optional(),
		audience: z.enum(["GUEST", "ACCOUNT", "UNKNOWN"]).optional(),
		before: customerCursor.optional(),
	})
	.strict();
const count = z.number().int().nonnegative();
export const adminContentCustomersOutputSchema = z.object({
	items: z
		.array(
			adminContentOwnerSchema.extend({
				name: z.string().nullable(),
				email: z.string().nullable(),
				audience: z.enum(["GUEST", "ACCOUNT", "UNKNOWN"]),
				lastActivityAt: z.date(),
				inputCount: count,
				outputCount: count,
				jobCount: count,
				blockedCount: count,
				issueCount: count,
			}),
		)
		.max(50),
	nextCursor: customerCursor.nullable(),
});
export const adminCustomerContentInputSchema = z
	.object({
		owner: adminContentOwnerSchema,
		limit: z.number().int().min(1).max(50).default(25),
		kind: recordKind.optional(),
		issuesOnly: z.boolean().optional(),
		before: contentCursor.optional(),
	})
	.strict();
export const adminCustomerContentOutputSchema = z.object({
	items: z
		.array(
			adminContentOwnerSchema.extend({
				id,
				recordKind,
				createdAt: z.date(),
				status: z.string().max(80),
				reasonCode: z.string().max(160).nullable(),
				productKey: z.string().max(160).nullable(),
				hasPrompt: z.boolean(),
				isIssue: z.boolean(),
			}),
		)
		.max(50),
	nextCursor: contentCursor.nullable(),
});
export type AdminContentCustomer = z.infer<
	typeof adminContentCustomersOutputSchema
>["items"][number];
export type AdminCustomerContent = z.infer<typeof adminCustomerContentOutputSchema>;
export type AdminContentCustomersInput = z.input<typeof adminContentCustomersInputSchema>;
export type AdminCustomerContentInput = z.input<typeof adminCustomerContentInputSchema>;
