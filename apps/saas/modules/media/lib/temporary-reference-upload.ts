import { z } from "zod";

export const temporaryReferenceReceiptSchema = z
	.object({
		assetId: z.uuid(),
		token: z.string().min(1).max(2048),
		expiresAt: z.iso.datetime(),
	})
	.strict();
export type TemporaryReferenceReceipt = z.infer<typeof temporaryReferenceReceiptSchema>;

export async function uploadTemporaryReferenceFile(
	file: File,
	signal: AbortSignal,
): Promise<TemporaryReferenceReceipt> {
	const response = await fetch("/api/media/temporary-references", {
		method: "POST",
		body: file,
		signal,
		headers: { "Content-Type": file.type, "X-Upload-Size": String(file.size) },
	});
	const result = await response.json();
	if (!response.ok)
		throw new Error(typeof result.code === "string" ? result.code : "UPLOAD_FAILED");
	return temporaryReferenceReceiptSchema.parse(result);
}
