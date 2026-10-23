"use client";

import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactEventHandler } from "react";

import type { EditorProductKey } from "../../lib/editor-recovery";
import { recordOutputLoaded } from "../../lib/preview-timing";
import { BeforeAfterSlider } from "./BeforeAfterSlider";
import { usePrivateAssetPreview } from "./use-private-asset-preview";

export interface InlinePreviewAsset {
	id: string;
	contentVersion: string;
	visibleUntil: string;
	preview: { url: string; expiresAt: string } | null;
}

/** Keep one download per content identity; only an explicit failed-load retry changes src. */
export function InlineOutputPreview({
	jobId,
	asset,
	sourceId,
	productKey,
	refresh,
}: {
	jobId: string;
	asset: InlinePreviewAsset;
	sourceId?: string;
	productKey: EditorProductKey;
	refresh: () => Promise<{ data?: { assets: InlinePreviewAsset[] }; isError?: boolean }>;
}) {
	const t = useTranslations("media.status");
	const [display, setDisplay] = useState({
		version: asset.contentVersion,
		url: asset.preview?.url,
	});
	const [time, setTime] = useState(() => Date.now());
	const retryCount = useRef(0);
	const [retryKey, setRetryKey] = useState(0);
	const [unavailable, setUnavailable] = useState(false);
	if (display.version !== asset.contentVersion || (!display.url && asset.preview?.url)) {
		setDisplay({ version: asset.contentVersion, url: asset.preview?.url });
	}
	useEffect(() => {
		const remaining = Date.parse(asset.visibleUntil) - Date.now();
		const timer = setTimeout(
			() => {
				setTime(Date.now());
				void refresh();
			},
			Math.max(0, Math.min(remaining, 2_147_483_647)),
		);
		return () => clearTimeout(timer);
	}, [asset.visibleUntil, refresh]);
	const refreshPreview = async () => {
		try {
			const result = await refresh();
			const next = result.data?.assets.find(
				(candidate) =>
					candidate.id === asset.id && candidate.contentVersion === asset.contentVersion,
			);
			if (result.isError || !next?.preview || Date.parse(next.visibleUntil) <= Date.now()) {
				setUnavailable(true);
				return;
			}
			// Use the completed authorization response, not the previous render's URL.
			setDisplay({ version: next.contentVersion, url: next.preview.url });
			setRetryKey((value) => value + 1);
			setUnavailable(false);
		} catch {
			setUnavailable(true);
		}
	};
	if (Math.max(time, Date.now()) >= Date.parse(asset.visibleUntil))
		return <p>{t("comparisonUnavailable")}</p>;
	if (unavailable)
		return (
			<div>
				<p>{t("comparisonUnavailable")}</p>
				<button
					type="button"
					onClick={() => {
						retryCount.current = 0;
						void refreshPreview();
					}}
				>
					{t("retry")}
				</button>
			</div>
		);
	if (!display.url) return <p aria-busy="true">{t("loading")}</p>;
	const loaded: ReactEventHandler<HTMLImageElement> = (event) => {
		recordOutputLoaded(jobId, asset.id, event.currentTarget);
	};
	const failed = async () => {
		// One automatic credential refresh per mounted content identity. Persistent
		// missing/invalid objects must not create a status/sign/download retry loop.
		if (retryCount.current >= 1) {
			setUnavailable(true);
			return;
		}
		retryCount.current++;
		await refreshPreview();
	};
	return (
		<InlineComparison
			key={retryKey}
			sourceId={sourceId}
			outputUrl={display.url}
			outputId={asset.id}
			productKey={productKey}
			onLoad={loaded}
			onError={failed}
		/>
	);
}

function InlineComparison({
	sourceId,
	outputUrl,
	outputId,
	productKey,
	onLoad,
	onError,
}: {
	sourceId?: string;
	outputUrl: string;
	outputId: string;
	productKey: EditorProductKey;
	onLoad: ReactEventHandler<HTMLImageElement>;
	onError: ReactEventHandler<HTMLImageElement>;
}) {
	const t = useTranslations("media.status");
	const input = usePrivateAssetPreview(sourceId);
	return (
		<BeforeAfterSlider
			beforeUrl={sourceId ? input.data?.url : undefined}
			afterUrl={outputUrl}
			beforeAlt={t("compare.beforeAlt")}
			afterAlt={t("compare.afterAlt")}
			outputOnlyAlt={t("generatedAlt")}
			controlLabel={t("compare.control")}
			showOriginalLabel={t("compare.showOriginal")}
			showResultLabel={t("compare.showResult")}
			beforeLabel={t("compare.before")}
			afterLabel={t("compare.after")}
			onOutputLoad={onLoad}
			onOutputError={onError}
			onCompared={() => void saasGrowthFunnel.resultCompared(outputId, productKey)}
		/>
	);
}
