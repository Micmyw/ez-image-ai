import { signMultipartPart } from "@repo/storage";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { requireOwnedUploadSession } from "../lib/asset-authorization";
import { getMultipartPartPlan } from "../lib/upload-parts";

const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

export const createMultipartPartUrl = protectedProcedure
	.route({
		method: "POST",
		path: "/media/upload-sessions/{sessionId}/parts",
		tags: ["Media"],
		summary: "Re-sign a multipart upload part",
	})
	.input(
		z.object({ sessionId: z.string().min(1), partNumber: z.number().int().min(1).max(10_000) }),
	)
	.handler(async ({ context: { user }, input }) => {
		const session = await requireOwnedUploadSession(input.sessionId, user.id);
		if (
			session.status !== "PENDING" ||
			!session.multipartUploadId ||
			session.expiresAt <= new Date()
		)
			throw new Error("Upload session is not active");
		const plan = getMultipartPartPlan(
			Number(session.expectedBytes),
			MULTIPART_PART_SIZE,
			input.partNumber,
		);
		return {
			partNumber: input.partNumber,
			contentLength: plan.contentLength,
			uploadUrl: await signMultipartPart({
				bucket: "media",
				key: session.asset.objectKey,
				uploadId: session.multipartUploadId,
				partNumber: input.partNumber,
				contentLength: plan.contentLength,
			}),
		};
	});
