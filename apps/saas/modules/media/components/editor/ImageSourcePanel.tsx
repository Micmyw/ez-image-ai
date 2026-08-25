"use client";

import { Button } from "@repo/ui/components/button";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect } from "react";

import { MediaUploader } from "../MediaUploader";

export function ImageSourcePanel({
	sourceAssetId,
	onChange,
	onReadyChange,
	maximumImageBytes,
}: {
	sourceAssetId: string;
	onChange: (assetId: string) => void;
	onReadyChange: (ready: boolean) => void;
	maximumImageBytes?: number;
}) {
	const t = useTranslations("media.editor.source");
	const preview = useQuery({
		queryKey: ["media-asset-preview", sourceAssetId],
		queryFn: () =>
			orpcClient.media.getAssetAccessUrl({ assetId: sourceAssetId, disposition: "inline" }),
		enabled: Boolean(sourceAssetId),
		retry: false,
		refetchInterval: (query) => (sourceAssetId && !query.state.data ? 2_000 : false),
		staleTime: 4 * 60_000,
	});

	useEffect(() => {
		if (!sourceAssetId || preview.isError) onReadyChange(false);
		if (preview.data) onReadyChange(true);
	}, [onReadyChange, preview.data, preview.isError, sourceAssetId]);

	return (
		<div className="space-y-3">
			<div className="gap-3 flex flex-wrap items-center justify-between">
				<h2 className="font-medium text-sm">{t("title")}</h2>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					render={(props) => <Link {...props} href="/assets" />}
				>
					{t("chooseLibrary")}
				</Button>
			</div>
			{sourceAssetId && (
				<div className="gap-3 p-3 sm:grid-cols-[7rem_1fr] grid items-center rounded-xl border bg-muted/30">
					<div className="aspect-square overflow-hidden rounded-lg bg-muted">
						{preview.data ? (
							<img
								src={preview.data.url}
								alt={t("selectedAlt")}
								className="size-full object-cover"
							/>
						) : (
							<div
								className="p-3 text-xs flex size-full items-center justify-center text-center text-muted-foreground"
								aria-live="polite"
							>
								{t("preparing")}
							</div>
						)}
					</div>
					<div>
						<p className="font-medium text-sm">{preview.data ? t("ready") : t("preparing")}</p>
						<p className="mt-1 text-xs text-muted-foreground">{t("private")}</p>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="mt-2"
							onClick={() => onChange("")}
						>
							{t("remove")}
						</Button>
					</div>
				</div>
			)}
			<MediaUploader
				multiple={false}
				maximumImageBytes={maximumImageBytes}
				value={sourceAssetId ? [sourceAssetId] : []}
				onChange={(assetIds) => onChange(assetIds[0] ?? "")}
			/>
		</div>
	);
}
