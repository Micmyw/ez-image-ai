import { getSession } from "@auth/lib/server";
import { CreatorWorkspace } from "@media/components/CreatorWorkspace";
import { resolveEditorAllowedProductKeys, resolveEditorRecovery } from "@media/lib/editor-recovery";
import { getClaimedGenerationDraft } from "@repo/database";
import { db } from "@repo/database/client";
import { cookies } from "next/headers";

interface CreatePageFilters {
	reuseJob?: string;
	asset?: string;
	draftError?: string;
}

export default async function CreatePage({
	searchParams,
}: {
	searchParams: Promise<CreatePageFilters>;
}) {
	const session = await getSession();
	const filters = await searchParams;
	const cookieStore = await cookies();
	const draftId = cookieStore.get("media_claimed_draft")?.value;
	const requested = Boolean(filters.draftError || filters.asset || filters.reuseJob || draftId);
	let candidate: { productKey: string | null; input: Record<string, unknown> } | null = null;
	let sourceAsset: {
		id: string;
		status: string;
		mimeType: string;
		deletedAt: Date | null;
	} | null = null;

	const subscription = session
		? await db.subscription.findFirst({
				where: { ownerType: "USER", ownerId: session.user.id, status: "ACTIVE" },
				include: { plan: { select: { metadata: true, name: true } } },
				orderBy: { updatedAt: "desc" },
			})
		: null;
	const allowedProductKeys = resolveEditorAllowedProductKeys(
		subscription?.plan.metadata,
		subscription?.plan.name,
	);

	if (session && !filters.draftError) {
		if (filters.asset) {
			sourceAsset = await findEditorSourceAsset(filters.asset, session.user.id);
			candidate = {
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "",
					sourceAssetId: filters.asset,
				},
			};
		} else if (filters.reuseJob) {
			const job = await db.generationJob.findFirst({
				where: {
					id: filters.reuseJob,
					ownerType: "USER",
					ownerId: session.user.id,
				},
				select: { productKey: true, inputSnapshot: true },
			});
			if (job) {
				candidate = {
					productKey: job.productKey,
					input: job.inputSnapshot as Record<string, unknown>,
				};
				const sourceAssetId = candidate.input.sourceAssetId;
				if (typeof sourceAssetId === "string") {
					sourceAsset = await findEditorSourceAsset(sourceAssetId, session.user.id);
				}
			}
		} else if (draftId) {
			candidate = await getClaimedGenerationDraft({ draftId, userId: session.user.id }, db);
			const sourceAssetId = candidate?.input.sourceAssetId;
			if (typeof sourceAssetId === "string") {
				sourceAsset = await findEditorSourceAsset(sourceAssetId, session.user.id);
			}
		}
	}

	const recovery = resolveEditorRecovery({
		requested,
		candidate,
		sourceAsset,
		allowedProductKeys,
	});

	return (
		<CreatorWorkspace
			initialDraft={recovery.initialDraft}
			allowedProductKeys={allowedProductKeys}
			restoreState={recovery.restoreState}
			restoreNotice={recovery.notice}
		/>
	);
}

async function findEditorSourceAsset(assetId: string, userId: string) {
	return db.mediaAsset.findFirst({
		where: { id: assetId, ownerType: "USER", ownerId: userId },
		select: { id: true, status: true, mimeType: true, deletedAt: true },
	});
}
