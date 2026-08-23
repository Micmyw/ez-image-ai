import { getSession } from "@auth/lib/server";
import { CreatorWorkspace } from "@media/components/CreatorWorkspace";
import { getClaimedGenerationDraft } from "@repo/database";
import { db } from "@repo/database/client";
import { cookies } from "next/headers";

export default async function CreatePage({
	searchParams,
}: {
	searchParams: Promise<{ reuseJob?: string; asset?: string }>;
}) {
	const session = await getSession();
	const filters = await searchParams;
	const cookieStore = await cookies();
	const draftId = cookieStore.get("media_claimed_draft")?.value;
	let draftInput =
		session && draftId
			? await getClaimedGenerationDraft({ draftId, userId: session.user.id }, db)
			: null;
	if (session && filters.reuseJob) {
		const job = await db.generationJob.findFirst({
			where: { id: filters.reuseJob, ownerType: "USER", ownerId: session.user.id },
		});
		if (job)
			draftInput = {
				id: job.id,
				productKey: job.productKey,
				input: job.inputSnapshot as Record<string, unknown>,
			};
	}
	if (session && filters.asset) {
		const asset = await db.mediaAsset.findFirst({
			where: {
				id: filters.asset,
				ownerType: "USER",
				ownerId: session.user.id,
				status: "READY",
				deletedAt: null,
			},
		});
		if (asset) {
			const isImage = asset.mimeType.startsWith("image/");
			draftInput = {
				id: asset.id,
				productKey: isImage ? "image-fast" : null,
				input: { prompt: "", sourceAssetId: asset.id },
			};
		}
	}
	return <CreatorWorkspace draftInput={draftInput} />;
}
