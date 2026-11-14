import { z } from "zod";

const id = z.string().min(1).max(160);
export const adminCleanupPreviewInputSchema = z
	.object({
		assetIds: z.array(id).max(20),
		includeExpiredInternalDiagnostics: z.boolean().default(false),
		diagnosticEventIds: z.array(id).max(100).optional(),
		reason: z.string().trim().min(5).max(500),
	})
	.strict();
export const adminCleanupPreviewOutputSchema = z.object({
	planId: id,
	planHash: z.string().regex(/^[a-f0-9]{64}$/),
	expiresAt: z.date(),
	assets: z
		.array(z.object({ id, bytes: z.string().regex(/^\d+$/), blocked: z.array(z.string()) }))
		.max(20),
	assetCount: z.number().int().min(0).max(20),
	assetBytes: z.string().regex(/^\d+$/),
	logCount: z.number().int().min(0).max(100),
	logBytes: z.number().int().min(0),
	confirmation: z.string(),
});
export const adminCleanupExecuteInputSchema = z
	.object({
		planId: id,
		planHash: z.string().regex(/^[a-f0-9]{64}$/),
		confirmation: z.string().max(160),
	})
	.strict();
export const adminCleanupExecuteOutputSchema = z.object({
	planId: id,
	queuedAssets: z.number().int().min(0).max(20),
	deletedLogs: z.number().int().min(0).max(100),
	replayed: z.boolean(),
	requeuedAssets: z.number().int().min(0).max(20).optional(),
});
export type AdminContentCleanupPlan = z.infer<typeof adminCleanupPreviewOutputSchema>;
