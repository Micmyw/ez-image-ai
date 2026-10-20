import { z } from "zod";

export const supportTicketStatusSchema = z.enum(["OPEN", "AWAITING_CUSTOMER", "CLOSED"]);
export const supportRequestKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
export const supportListInputSchema = z
	.object({
		page: z.number().int().min(1).max(10_000).default(1),
		pageSize: z.number().int().min(1).max(100).default(20),
		status: supportTicketStatusSchema.optional(),
	})
	.strict();
export const supportTicketIdSchema = z.object({ ticketId: z.string().min(1).max(200) }).strict();
export const supportReplyInputSchema = supportTicketIdSchema.extend({
	body: z.string().trim().min(1).max(5000),
});
export const supportStatusInputSchema = supportTicketIdSchema.extend({
	status: supportTicketStatusSchema,
	expectedUpdatedAt: z.string().datetime({ offset: true }),
});
export const supportTicketSchema = z.object({
	id: z.string(),
	subject: z.string(),
	status: supportTicketStatusSchema,
	createdByUserId: z.string(),
	organizationId: z.string().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export const supportMessageSchema = z.object({
	id: z.string(),
	authorType: z.enum(["CUSTOMER", "ADMIN", "SERVICE"]),
	body: z.string(),
	createdAt: z.string().datetime(),
});
export const supportTicketDetailSchema = supportTicketSchema.extend({
	messages: z.array(supportMessageSchema),
});
export const supportListResultSchema = z.object({
	items: z.array(supportTicketSchema),
	total: z.number(),
	page: z.number(),
	pageSize: z.number(),
});
export const supportWriteResultSchema = z.object({
	ticket: supportTicketDetailSchema,
	created: z.boolean(),
});
export const adminSupportStatusResultSchema = z.object({
	ticketId: z.string(),
	status: supportTicketStatusSchema,
	updatedAt: z.string().datetime(),
});
export const adminSupportReplyResultSchema = adminSupportStatusResultSchema.extend({
	messageId: z.string(),
	created: z.boolean(),
});

const secret = z.string().max(4096);
export const botConfigurationSchema = z
	.object({
		paymentEnabled: z.boolean(),
		ticketEnabled: z.boolean(),
		language: z.enum(["en", "zh"]),
		timeZone: z.string().min(1).max(100),
		templates: z.object({ payment: z.string().max(3000), ticket: z.string().max(3000) }).strict(),
		channels: z
			.object({
				telegram: z
					.object({
						enabled: z.boolean(),
						apiBase: z.string().max(2048),
						chatId: z.string().max(200),
						botToken: secret,
					})
					.strict(),
				feishu: z.object({ enabled: z.boolean(), webhookUrl: secret, secret }).strict(),
				wecom: z.object({ enabled: z.boolean(), webhookUrl: secret }).strict(),
				webhook: z.object({ enabled: z.boolean(), url: secret, token: secret }).strict(),
			})
			.strict(),
	})
	.strict();
export const botConfigurationResultSchema = z.object({
	version: z.number().int(),
	configuration: botConfigurationSchema,
	encryptionReady: z.boolean(),
	deliveryMode: z.literal("best_effort"),
});
export const botTestResultSchema = z.object({
	test: z.literal(true),
	results: z.array(
		z.object({
			channel: z.enum(["telegram", "feishu", "wecom", "webhook"]),
			success: z.boolean(),
			error: z.string().optional(),
		}),
	),
});

export const adminSupportInputSchemas = {
	tickets_list: supportListInputSchema,
	tickets_get: supportTicketIdSchema,
	tickets_reply: supportReplyInputSchema,
	tickets_status: supportStatusInputSchema,
	notifications_get: z.object({}).strict(),
	notifications_update: z
		.object({
			expectedVersion: z.number().int().nonnegative(),
			configuration: botConfigurationSchema,
		})
		.strict(),
	notifications_test: z
		.object({
			configuration: botConfigurationSchema.optional(),
			channel: z.enum(["telegram", "feishu", "wecom", "webhook"]).optional(),
			event: z.enum(["payment", "ticket"]).optional(),
		})
		.strict(),
};
export const adminSupportOutputSchemas = {
	tickets_list: supportListResultSchema,
	tickets_get: supportTicketDetailSchema,
	tickets_reply: adminSupportReplyResultSchema,
	tickets_status: adminSupportStatusResultSchema,
	notifications_get: botConfigurationResultSchema,
	notifications_update: botConfigurationResultSchema,
	notifications_test: botTestResultSchema,
};
