import { getSignedUploadUrl } from "@repo/storage";
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
	.output(
		z.object({
			signedUploadUrl: z.url(),
			path: z.string().min(1),
		}),
	)
	.handler(async ({ context: { user } }) => {
		const path = `${user.id}.png`;
		const signedUploadUrl = await getSignedUploadUrl(`${user.id}.png`, {
			bucket: "avatars",
		});

		return { signedUploadUrl, path };
	});
