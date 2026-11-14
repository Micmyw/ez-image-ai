"use client";

import { useSession } from "@auth/hooks/use-session";
import {
	authDraftIdFromReturnPath,
	readAuthDraft,
	type AuthDraft,
} from "@auth/lib/auth-draft-storage";
import { isSupportedImageUploadSource, prepareImageUpload } from "@media/lib/prepare-image-upload";
import { ImageIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";

export function AuthDraftPreview({ returnPath }: { returnPath: string }) {
	const t = useTranslations("auth.draft");
	const { user } = useSession();
	const [draft, setDraft] = useState<AuthDraft | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	useEffect(() => {
		let active = true;
		let objectUrl: string | null = null;
		setDraft(null);
		setPreviewUrl(null);
		void readAuthDraft({
			id: authDraftIdFromReturnPath(returnPath),
			ownerId: user?.isAnonymous ? null : user?.id,
			returnPath,
		}).then(async (saved) => {
			if (!active || !saved) return;
			setDraft(saved);
			if (saved.file && isSupportedImageUploadSource(saved.file)) {
				try {
					const prepared = await prepareImageUpload(saved.file);
					if (!active) return;
					objectUrl = URL.createObjectURL(prepared);
					setPreviewUrl(objectUrl);
				} catch {
					/* The original draft stays available if this browser cannot render its image. */
				}
			}
		});
		return () => {
			active = false;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [returnPath, user?.id, user?.isAnonymous]);
	if (!draft) return null;
	const destination = new URL(draft.originPath, "https://auth-draft.invalid");
	destination.searchParams.set("authDraft", draft.id);
	return (
		<aside
			className="mb-6 p-3 rounded-2xl border border-[#b79cff]/20 bg-[#b79cff]/[0.06]"
			data-auth-draft="saved"
			data-clarity-mask="true"
		>
			<div className="gap-3 flex items-start">
				{previewUrl ? (
					<img
						src={previewUrl}
						alt={t("imageAlt")}
						className="size-16 shrink-0 rounded-xl object-cover"
					/>
				) : (
					<span className="size-12 bg-white/5 grid shrink-0 place-items-center rounded-xl">
						<ImageIcon className="size-5 text-[#b79cff]" aria-hidden="true" />
					</span>
				)}
				<div className="min-w-0 text-sm">
					<p className="font-medium text-white">{t("title")}</p>
					{draft.values.prompt && (
						<p className="mt-1 text-xs line-clamp-2 break-words text-[#b7acbf]">
							{draft.values.prompt}
						</p>
					)}
					<p className="mt-1 text-xs text-[#b7acbf]">{t("saved")}</p>
					<Link
						prefetch={false}
						className="mt-2 text-xs font-semibold inline-flex text-[#c9b9ff] underline underline-offset-4"
						href={destination.pathname + destination.search}
					>
						{t("returnToEdit")}
					</Link>
				</div>
			</div>
		</aside>
	);
}
