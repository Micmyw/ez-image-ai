"use client";

import { Button } from "@repo/ui/components/button";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { MediaUploadItem, MediaUploadStatus } from "../../hooks/use-media-upload";
import { getModerationErrorReason } from "../../lib/editor-error";
import type { TemporaryReferenceReceipt } from "../../lib/temporary-reference-upload";
import { ContentSafetyNotice } from "../ContentSafetyNotice";
import { MediaUploader } from "../MediaUploader";

interface LocalPreview {
	file: File;
	url: string;
	assetId: string | null;
	selectionSourceId: string;
	status: MediaUploadStatus;
}

const uploadStatusLabels = {
	idle: "uploading",
	uploading: "uploading",
	finalizing: "saving",
	paused: "paused",
	error: "uploadFailed",
	uploaded: "checking",
} as const;

export function ImageSourcePanel({
	sourceAssetId,
	temporaryReference,
	onChange,
	onReadyChange,
	onPendingChange,
	maximumImageBytes,
	compact = false,
	label,
}: {
	sourceAssetId: string;
	temporaryReference?: TemporaryReferenceReceipt;
	onChange: (assetId: string, reference?: TemporaryReferenceReceipt) => void;
	onReadyChange: (ready: boolean) => void;
	onPendingChange?: (pending: boolean) => void;
	maximumImageBytes?: number;
	compact?: boolean;
	label?: string;
}) {
	const t = useTranslations("media.editor.source");
	const [pending, setPending] = useState(false);
	const [referenceExpired, setReferenceExpired] = useState(false);
	useEffect(() => {
		setReferenceExpired(false);
		if (!temporaryReference) return;
		const delay = Date.parse(temporaryReference.expiresAt) - Date.now();
		if (delay <= 0) {
			setReferenceExpired(true);
			return;
		}
		const timer = setTimeout(() => setReferenceExpired(true), delay);
		return () => clearTimeout(timer);
	}, [temporaryReference]);
	const [uploadRevision, setUploadRevision] = useState(0);
	const [localPreview, setLocalPreview] = useState<LocalPreview | null>(null);
	const localPreviewRef = useRef<LocalPreview | null>(null);
	const updateLocalPreview = useCallback((next: LocalPreview | null) => {
		const previous = localPreviewRef.current;
		if (previous && previous.url !== next?.url) URL.revokeObjectURL(previous.url);
		localPreviewRef.current = next;
		setLocalPreview(next);
	}, []);
	useEffect(
		() => () => {
			if (localPreviewRef.current) URL.revokeObjectURL(localPreviewRef.current.url);
		},
		[],
	);
	const updateUpload = useCallback(
		(item: MediaUploadItem | null) => {
			const current = localPreviewRef.current;
			if (!item) {
				// Completing the upload remounts the uploader; retain the panel-owned
				// preview while the server verifies the newly assigned asset ID.
				if (current && !current.assetId) updateLocalPreview(null);
				return;
			}
			updateLocalPreview({
				file: item.file,
				url: current?.file === item.file ? current.url : URL.createObjectURL(item.file),
				assetId: item.assetId,
				selectionSourceId: sourceAssetId,
				status: item.status,
			});
		},
		[sourceAssetId, updateLocalPreview],
	);
	const updateAsset = useCallback(
		(assetIds: string[], reference?: TemporaryReferenceReceipt) => {
			const assetId = assetIds[0] ?? "";
			if (localPreviewRef.current && assetId) {
				updateLocalPreview({ ...localPreviewRef.current, assetId, status: "uploaded" });
			}
			onChange(assetId, reference);
		},
		[onChange, updateLocalPreview],
	);
	useEffect(() => {
		const current = localPreviewRef.current;
		if (current && sourceAssetId !== (current.assetId ?? current.selectionSourceId)) {
			updateLocalPreview(null);
		}
	}, [sourceAssetId, updateLocalPreview]);
	const updatePending = useCallback(
		(next: boolean) => {
			setPending(next);
			onPendingChange?.(next);
		},
		[onPendingChange],
	);
	const removeSource = useCallback(() => {
		updateLocalPreview(null);
		setUploadRevision((revision) => revision + 1);
		updatePending(false);
		onReadyChange(false);
		onChange("");
	}, [onChange, onReadyChange, updateLocalPreview, updatePending]);
	const currentLocalPreview =
		localPreview && sourceAssetId === (localPreview.assetId ?? localPreview.selectionSourceId)
			? localPreview
			: null;
	const serverPreviewEnabled =
		!temporaryReference &&
		Boolean(sourceAssetId) &&
		(!currentLocalPreview || currentLocalPreview.assetId === sourceAssetId);
	const preview = useQuery({
		queryKey: ["media-asset-preview", sourceAssetId],
		queryFn: () =>
			orpcClient.media.getAssetAccessUrl({ assetId: sourceAssetId, disposition: "inline" }),
		enabled: serverPreviewEnabled,
		retry: false,
		refetchInterval: (query) =>
			sourceAssetId && !query.state.data && !terminalSafetyMessage(query.state.error)
				? 2_000
				: false,
		staleTime: 4 * 60_000,
	});
	const safetyMessage = serverPreviewEnabled ? terminalSafetyMessage(preview.error) : null;
	const readablePreview = !serverPreviewEnabled || preview.isError ? undefined : preview.data;
	const ready = Boolean(
		sourceAssetId &&
		(readablePreview || (temporaryReference?.assetId === sourceAssetId && !referenceExpired)) &&
		!pending,
	);
	const previewUrl = safetyMessage ? undefined : (currentLocalPreview?.url ?? readablePreview?.url);
	const status = referenceExpired
		? "expired"
		: safetyMessage
			? "unavailable"
			: ready
				? temporaryReference
					? "uploadedForGeneration"
					: "ready"
				: currentLocalPreview
					? uploadStatusLabels[currentLocalPreview.status]
					: "checking";

	useEffect(() => {
		onReadyChange(ready);
	}, [onReadyChange, ready, sourceAssetId]);

	return (
		<div
			className={
				compact
					? "studio-source min-w-0 space-y-2"
					: "space-y-3 border-slate-200 bg-slate-50/60 p-4 rounded-xl border"
			}
		>
			<div className="gap-3 flex flex-wrap items-center justify-between">
				<h2 className={compact ? "sr-only" : "font-medium text-sm"}>{label ?? t("title")}</h2>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					render={(props) => <Link {...props} href="/assets" />}
				>
					{t("chooseLibrary")}
				</Button>
			</div>
			{(sourceAssetId || currentLocalPreview) && (
				<div
					className={
						compact
							? "space-y-2"
							: "gap-3 border-violet-200 bg-white p-3 sm:grid-cols-[7rem_1fr] grid items-center rounded-xl border"
					}
				>
					<div className="aspect-square overflow-hidden rounded-lg bg-muted">
						{previewUrl ? (
							<img src={previewUrl} alt={t("selectedAlt")} className="size-full object-contain" />
						) : (
							<div
								className="p-3 text-xs flex size-full items-center justify-center text-center text-muted-foreground"
								aria-live="polite"
							>
								{t(
									referenceExpired
										? "expired"
										: temporaryReference
											? "uploadedForGeneration"
											: safetyMessage
												? "unavailable"
												: "preparing",
								)}
							</div>
						)}
					</div>
					<div>
						<p
							className={compact ? "text-xs text-muted-foreground" : "font-medium text-sm"}
							aria-live="polite"
						>
							{t(status)}
						</p>
						{!compact && <p className="mt-1 text-xs text-muted-foreground">{t("private")}</p>}
						<Button type="button" size="sm" variant="ghost" className="mt-2" onClick={removeSource}>
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
					onRevise={removeSource}
				/>
			)}
			<div hidden={compact && Boolean(sourceAssetId) && !pending}>
				<MediaUploader
					temporaryReference
					key={`${sourceAssetId || "new-reference"}:${uploadRevision}`}
					compact={compact}
					multiple={false}
					maximumImageBytes={maximumImageBytes}
					value={sourceAssetId ? [sourceAssetId] : []}
					onChange={updateAsset}
					onPendingChange={updatePending}
					onUploadChange={updateUpload}
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
