import { ORPCError } from "@orpc/server";
import { getAdminImageContent, listAdminImageContent } from "@repo/database";
import { db } from "@repo/database/client";
import {
	createSignedReadUrl,
	createProviderOriginalReadUrl,
	isProviderOriginalKey,
} from "@repo/storage";

import { adminProcedure } from "../../../orpc/procedures";
import {
	adminImageDetailInputSchema,
	adminImageDetailOutputSchema,
	adminImageListInputSchema,
	adminImageListOutputSchema,
} from "../admin-content-types";

const privateAdminProcedure = adminProcedure.use(({ context, next }) => {
	context.responseHeaders?.set("Cache-Control", "private, no-store");
	context.responseHeaders?.set("X-Robots-Tag", "noindex, nofollow");
	return next();
});

export const adminImageContentList = privateAdminProcedure
	.route({
		method: "GET",
		path: "/admin/media/content",
		tags: ["Admin", "Media"],
		summary: "List customer images and recorded moderation",
		description:
			"Read uploaded and generated images, including refusals without a recovery review. Image bytes and prompts are only returned by the audited detail read.",
	})
	.input(adminImageListInputSchema)
	.output(adminImageListOutputSchema)
	.handler(({ input, context: { user } }) => listAdminImageContent(input, db, user.id));

async function signImage(image: Awaited<ReturnType<typeof getAdminImageContent>>["image"]) {
	const { previewKey, ...content } = image;
	if (!previewKey) return { ...content, previewUrl: null, previewError: false };
	try {
		return {
			...content,
			previewUrl: isProviderOriginalKey(previewKey)
				? createProviderOriginalReadUrl({ key: previewKey, expiresIn: 60, scope: "admin" })
				: await createSignedReadUrl({ bucket: "media", key: previewKey, expiresIn: 60 }),
			previewError: false,
		};
	} catch {
		return { ...content, previewUrl: null, previewError: true };
	}
}

export const adminImageContentDetail = privateAdminProcedure
	.route({
		method: "GET",
		path: "/admin/media/content/{assetId}",
		tags: ["Admin", "Media"],
		summary: "Inspect original images, generated results and classifier labels",
		description:
			"Audit the administrator's private read, then issue short-lived image previews and bounded stored moderation evidence for the selected image and its bound job.",
	})
	.input(adminImageDetailInputSchema)
	.output(adminImageDetailOutputSchema)
	.handler(async ({ input, context: { user } }) => {
		try {
			const detail = await getAdminImageContent(input, user.id, db);
			const [image, relatedImages] = await Promise.all([
				signImage(detail.image),
				Promise.all(detail.relatedImages.map(signImage)),
			]);
			return { ...detail, image, relatedImages };
		} catch (error) {
			if (
				error instanceof Error &&
				["ADMIN_CONTENT_NOT_FOUND", "ADMIN_CONTENT_JOB_NOT_FOUND"].includes(error.message)
			)
				throw new ORPCError("NOT_FOUND");
			throw error;
		}
	});
