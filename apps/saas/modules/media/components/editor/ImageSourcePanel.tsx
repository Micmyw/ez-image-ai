"use client";

import { Button } from "@repo/ui/components/button";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { getModerationErrorReason } from "../../lib/editor-error";
import { ContentSafetyNotice } from "../ContentSafetyNotice";
import { MediaUploader } from "../MediaUploader";

export function ImageSourcePanel({
	sourceAssetId,
	onChange,
	onReadyChange,
	onPendingChange,
	maximumImageBytes,
	compact = false,
}: {
	sourceAssetId: string;
	onChange: (assetId: string) => void;
	onReadyChange: (ready: boolean) => void;
	onPendingChange?: (pending: boolean) => void;
	maximumImageBytes?: number;
	compact?: boolean;
}) {
	const t = useTranslations("media.editor.source");
	const [pending, setPending] = useState(false);
	const updatePending = useCallback(
		(next: boolean) => {
			setPending(next);
			onPendingChange?.(next);
		},
		[onPendingChange],
	);
	const preview = useQuery({
		queryKey: ["media-asset-preview", sourceAssetId],
		queryFn: () =>
			orpcClient.media.getAssetAccessUrl({ assetId: sourceAssetId, disposition: "inline" }),
		enabled: Boolean(sourceAssetId),
		retry: false,
		refetchInterval: (query) =>
			sourceAssetId && !query.state.data && !terminalSafetyMessage(query.state.error)
				? 2_000
				: false,
		staleTime: 4 * 60_000,
	});
	const safetyMessage = terminalSafetyMessage(preview.error);
	const readablePreview = preview.isError ? undefined : preview.data;

	useEffect(() => {
		onReadyChange(Boolean(sourceAssetId && readablePreview));
	}, [onReadyChange, readablePreview, sourceAssetId]);

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
						{readablePreview ? (
							<img
								src={readablePreview.url}
								alt={t("selectedAlt")}
								className="size-full object-contain"
							/>
						) : (
							<div
								className="p-3 text-xs flex size-full items-center justify-center text-center text-muted-foreground"
								aria-live="polite"
							>
								{t(safetyMessage ? "unavailable" : "preparing")}
							</div>
						)}
					</div>
					<div>
						<p className={compact ? "sr-only" : "font-medium text-sm"}>
							{readablePreview ? t("ready") : t(safetyMessage ? "unavailable" : "preparing")}
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
			{sourceAssetId && safetyMessage && (
				<ContentSafetyNotice
					stage="input"
					outcome={safetyMessage === "blocked" ? "blocked" : "unavailable"}
					reason={getModerationErrorReason(preview.error)}
					billing="beforeGeneration"
					onRevise={() => onChange("")}
				/>
			)}
			<div hidden={compact && Boolean(sourceAssetId) && !pending}>
				<MediaUploader
					key={sourceAssetId || "new-reference"}
					compact={compact}
					multiple={false}
					maximumImageBytes={maximumImageBytes}
					value={sourceAssetId ? [sourceAssetId] : []}
					onChange={(assetIds) => onChange(assetIds[0] ?? "")}
					onPendingChange={updatePending}
				/>
			</div>
		</div>
	);
}

function terminalSafetyMessage(error: unknown): "blocked" | "safetyUnavailable" | null {
	const message = error instanceof Error ? error.message : "";
	if (message.includes("ASSET_CONTENT_NOT_ALLOWED")) return "blocked";
	if (message.includes("ASSET_SAFETY_UNAVAILABLE") || message.includes("NOT_FOUND"))
		return "safetyUnavailable";
	return null;
}
