import { getSignedUploadUrl, MAX_AVATAR_UPLOAD_BYTES } from "@repo/storage";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

export const createAvatarUploadUrl = protectedProcedure
	.route({
		method: "POST",
		path: "/users/avatar-upload-url",
		tags: ["Users"],
		summary: "Create avatar upload URL",
		description: "Create a signed upload URL to upload an avatar image to the storage bucket",
	})
	.input(
		z.strictObject({
			contentType: z.literal("image/png"),
			contentLength: z.number().int().positive().max(MAX_AVATAR_UPLOAD_BYTES),
		}),
	)
	.output(
		z.object({
			signedUploadUrl: z.url(),
			path: z.string().min(1),
		}),
	)
	.handler(async ({ input, context: { user } }) => {
		const path = `${user.id}.png`;
		const signedUploadUrl = await getSignedUploadUrl(`${user.id}.png`, {
			bucket: "avatars",
			contentType: input.contentType,
			contentLength: input.contentLength,
		});

		return { signedUploadUrl, path };
	});
