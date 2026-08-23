"use client";

import { Button } from "@repo/ui/components/button";
import { orpcClient } from "@shared/lib/orpc-client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

export interface AssetCardProps {
	asset: {
		id: string;
		kind: string;
		mimeType: string;
		byteSize: string;
		createdAt: string;
		sourceJobId: string | null;
	};
	onDeleted: () => void;
}

export function AssetCard({ asset, onDeleted }: AssetCardProps) {
	const t = useTranslations("media.assets");
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	async function access(disposition: "inline" | "attachment") {
		const result = await orpcClient.media.getAssetAccessUrl({ assetId: asset.id, disposition });
		if (disposition === "attachment") window.location.assign(result.url);
		else setPreviewUrl(result.url);
	}
	return (
		<article className="overflow-hidden rounded-2xl border bg-background" data-asset-id={asset.id}>
			<div className="aspect-video flex items-center justify-center bg-muted">
				{previewUrl ? (
					asset.mimeType.startsWith("image/") ? (
						<img src={previewUrl} alt={t("previewAlt")} className="size-full object-cover" />
					) : (
						<video
							src={previewUrl}
							controls
							aria-label={t("previewAlt")}
							className="size-full object-cover"
						>
							<track kind="captions" />
						</video>
					)
				) : (
					<Button variant="ghost" onClick={() => void access("inline")}>
						{t("preview")}
					</Button>
				)}
			</div>
			<div className="p-4">
				<p className="font-medium truncate">
					{asset.mimeType.startsWith("video/") ? t("video") : t("image")}
				</p>
				<p className="mt-1 text-xs text-muted-foreground">
					{new Date(asset.createdAt).toLocaleString()}
				</p>
				<div className="mt-4 gap-2 flex flex-wrap">
					{asset.mimeType.startsWith("image/") && (
						<Button
							size="sm"
							variant="primary"
							render={(props) => (
								<Link {...props} href={`/create?asset=${encodeURIComponent(asset.id)}`} />
							)}
						>
							{t("reuse")}
						</Button>
					)}
					<Button size="sm" variant="secondary" onClick={() => void access("attachment")}>
						{t("download")}
					</Button>
					{asset.sourceJobId && (
						<Button
							size="sm"
							variant="ghost"
							render={(props) => <Link {...props} href={`/history/${asset.sourceJobId}`} />}
						>
							{t("source")}
						</Button>
					)}
					<Button
						size="sm"
						variant="ghost"
						onClick={() => void orpcClient.media.deleteAsset({ assetId: asset.id }).then(onDeleted)}
					>
						{t("delete")}
					</Button>
				</div>
			</div>
		</article>
	);
}
