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
	compact = false,
}: {
	sourceAssetId: string;
	onChange: (assetId: string) => void;
	onReadyChange: (ready: boolean) => void;
	maximumImageBytes?: number;
	compact?: boolean;
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
		<div
			className={
				compact
					? "studio-source min-w-0 space-y-2"
					: "space-y-3 border-slate-200 bg-slate-50/60 p-4 rounded-xl border"
			}
		>
			<div className="gap-3 flex flex-wrap items-center justify-between">
				<h2 className={compact ? "sr-only" : "font-medium text-sm"}>{t("title")}</h2>
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
				<div
					className={
						compact
							? "space-y-2"
							: "gap-3 border-violet-200 bg-white p-3 sm:grid-cols-[7rem_1fr] grid items-center rounded-xl border"
					}
				>
					<div className="aspect-square overflow-hidden rounded-lg bg-muted">
						{preview.data ? (
							<img
								src={preview.data.url}
								alt={t("selectedAlt")}
								className="size-full object-contain"
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
						<p className={compact ? "sr-only" : "font-medium text-sm"}>
							{preview.data ? t("ready") : t("preparing")}
						</p>
						{!compact && <p className="mt-1 text-xs text-muted-foreground">{t("private")}</p>}
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
			<div hidden={compact && Boolean(sourceAssetId)}>
				<MediaUploader
					compact={compact}
					multiple={false}
					maximumImageBytes={maximumImageBytes}
					value={sourceAssetId ? [sourceAssetId] : []}
					onChange={(assetIds) => onChange(assetIds[0] ?? "")}
				/>
			</div>
		</div>
	);
}
