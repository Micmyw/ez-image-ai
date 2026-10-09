import { z } from "zod";

/** Public, measured output only: never includes a prompt, provider route or private URL. */
export const videoOutputReportSchema = z
	.object({
		schemaVersion: z.literal(1),
		actual: z
			.object({
				durationMillis: z.number().int().positive().safe(),
				width: z.number().int().min(1).max(8192),
				height: z.number().int().min(1).max(8192),
				audioTracks: z.number().int().min(0).max(1),
			})
			.strict(),
		requested: z
			.object({
				durationSeconds: z.number().int().min(2).max(30),
				resolution: z.string().max(20),
				aspectRatio: z.string().max(20),
				sound: z.boolean(),
			})
			.strict(),
		warnings: z
			.array(
				z.enum([
					"DURATION_MISMATCH",
					"UNEXPECTED_AUDIO",
					"MISSING_AUDIO",
					"RESOLUTION_MISMATCH",
					"ASPECT_RATIO_MISMATCH",
				]),
			)
			.max(5),
	})
	.strict();

export type VideoOutputReport = z.infer<typeof videoOutputReportSchema>;

/** Old jobs without a report keep their existing state; arbitrary stage data stays private. */
export function readVideoOutputReport(stageData: unknown): VideoOutputReport | undefined {
	if (!stageData || typeof stageData !== "object" || !("outputSpec" in stageData)) return undefined;
	const spec = stageData.outputSpec;
	if (!spec || typeof spec !== "object" || !("report" in spec)) return undefined;
	const parsed = videoOutputReportSchema.safeParse(spec.report);
	if (!parsed.success) return undefined;
	const binding = spec as Record<string, unknown>;
	if (
		typeof binding.assetId !== "string" ||
		!binding.assetId ||
		typeof binding.checksum !== "string" ||
		!/^[a-f0-9]{64}$/.test(binding.checksum) ||
		typeof binding.etag !== "string" ||
		!binding.etag ||
		Object.entries(parsed.data.actual).some(([key, value]) => binding[key] !== value)
	)
		return undefined;
	return parsed.data;
}
