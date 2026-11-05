"use client";

import { usePrivateAssetPreview } from "@media/components/editor/use-private-asset-preview";
import { orpcClient } from "@shared/lib/orpc-client";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import {
	wallpaperCrop,
	wallpaperImage,
	WALLPAPER_TARGETS,
	type WallpaperCropSettings,
	type WallpaperSettings,
} from "../lib/wallpaper";
import { useWallpaperPreview, type WallpaperResult } from "../lib/wallpaper-result-context";
import { WallpaperButton } from "./WallpaperButton";

import "../wallpaper-crop.css";

export function WallpaperScreenPreview({
	settings,
	styleName,
}: {
	settings: WallpaperSettings;
	styleName: string;
}) {
	const t = useTranslations("christmas");
	const { result, source, selectSource } = useWallpaperPreview();
	const [savedCrop, setSavedCrop] = useState<{
		key: string;
		crop: WallpaperCropSettings;
	} | null>(null);
	const resultKey = `${result?.assetId}:${settings.screen}`;
	const generated = Boolean(result && source === "result");
	const controls = result ? (
		<fieldset className="christmas-preview-sources" aria-label={t("preview")}>
			<button type="button" aria-pressed={generated} onClick={() => selectSource("result")}>
				{t("yourResult")}
			</button>
			<button type="button" aria-pressed={!generated} onClick={() => selectSource("example")}>
				{t("stylePreview")}
			</button>
		</fieldset>
	) : null;
	const previewProps: PreviewControls = {
		controls,
		initialCrop: generated && savedCrop?.key === resultKey ? savedCrop.crop : undefined,
		onApplyCrop: generated ? (crop) => setSavedCrop({ key: resultKey, crop }) : undefined,
	};
	if (generated && result && !result.imageUrl) {
		return <AccountPreview key={resultKey} result={result} settings={settings} {...previewProps} />;
	}
	return (
		<ScreenPreview
			key={`${generated ? `result:${result?.assetId}` : `style:${settings.style}`}:${settings.screen}`}
			imageUrl={generated && result?.imageUrl ? result.imageUrl : wallpaperImage(settings.style)}
			generated={generated}
			settings={settings}
			styleName={styleName}
			{...previewProps}
		/>
	);
}

type PreviewControls = {
	controls?: ReactNode;
	initialCrop?: WallpaperCropSettings;
	onApplyCrop?: (crop: WallpaperCropSettings) => void;
};

function AccountPreview({
	result,
	settings,
	...previewProps
}: {
	result: WallpaperResult;
	settings: WallpaperSettings;
} & PreviewControls) {
	const preview = usePrivateAssetPreview(result.assetId);
	const t = useTranslations("christmas");
	if (!preview.data) {
		return (
			<aside className="christmas-preview" aria-label={t("preview")}>
				<div className="christmas-preview-heading">
					<strong>{t("yourWallpaper")}</strong>
					{previewProps.controls}
				</div>
				<p role={preview.isError ? "alert" : "status"}>
					{t(preview.isError ? "crop.error" : "crop.loading")}
				</p>
				{preview.isError && (
					<button type="button" onClick={() => void preview.refetch()}>
						{t("crop.retry")}
					</button>
				)}
			</aside>
		);
	}
	return (
		<ScreenPreview
			imageUrl={preview.data.url}
			getImageUrl={async () =>
				(
					await orpcClient.media.getAssetAccessUrl({
						assetId: result.assetId,
						disposition: "inline",
					})
				).url
			}
			generated
			settings={settings}
			onImageError={() => preview.refetch()}
			{...previewProps}
		/>
	);
}

function ScreenPreview({
	imageUrl,
	getImageUrl,
	generated,
	settings,
	styleName,
	onImageError,
	controls,
	initialCrop,
	onApplyCrop,
}: {
	imageUrl: string;
	getImageUrl?: () => Promise<string>;
	generated: boolean;
	settings: WallpaperSettings;
	styleName?: string;
	onImageError?: () => Promise<unknown>;
} & PreviewControls) {
	const t = useTranslations("christmas");
	const [crop, setCrop] = useState<WallpaperCropSettings>(
		initialCrop ?? {
			target: "original",
			x: 50,
			y: 50,
			zoom: 1,
			overlay: true,
			darkClock: !generated && settings.style === "pink",
		},
	);
	const [size, setSize] = useState<{ width: number; height: number }>();
	const [failed, setFailed] = useState(false);
	const [retried, setRetried] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const pixels = size
		? wallpaperCrop(size.width, size.height, crop.target, crop.x, crop.y, crop.zoom)
		: null;
	const target = pixels ?? WALLPAPER_TARGETS[settings.screen];
	const desktop = target.width > target.height;
	return (
		<aside
			className={`christmas-preview ${desktop ? "is-desktop" : ""}`}
			aria-label={t("preview")}
			data-wallpaper-source={generated ? "result" : "example"}
		>
			<div className="christmas-preview-heading">
				<span>{t("preview")}</span>
				{controls ?? <span>{t("stylePreview")}</span>}
			</div>
			<div className={`christmas-device ${desktop ? "desktop" : "phone"}`}>
				<div
					className="christmas-device-screen"
					style={{ aspectRatio: `${target.width}/${target.height}` }}
				>
					{failed ? (
						<div role="alert">
							<p>{t("crop.error")}</p>
							<button
								type="button"
								onClick={() => {
									setFailed(false);
									setRetried(false);
									setAttempt((value) => value + 1);
								}}
							>
								{t("crop.retry")}
							</button>
						</div>
					) : (
						<img
							key={attempt}
							data-clarity-mask={generated ? "true" : undefined}
							src={imageUrl}
							alt={generated ? t("yourWallpaper") : `${styleName} Christmas wallpaper`}
							referrerPolicy="no-referrer"
							onLoad={(event) => {
								setSize({
									width: event.currentTarget.naturalWidth,
									height: event.currentTarget.naturalHeight,
								});
								setFailed(false);
							}}
							onError={async () => {
								if (onImageError && !retried) {
									setRetried(true);
									await onImageError();
									setAttempt((value) => value + 1);
								} else setFailed(true);
							}}
							style={
								pixels && size
									? {
											position: "absolute",
											maxWidth: "none",
											width: `${(size.width / pixels.sw) * 100}%`,
											height: `${(size.height / pixels.sh) * 100}%`,
											left: `${(-pixels.sx / pixels.sw) * 100}%`,
											top: `${(-pixels.sy / pixels.sh) * 100}%`,
										}
									: undefined
							}
						/>
					)}
					{crop.overlay &&
						!failed &&
						(desktop ? (
							<div className="christmas-desktop-icons" aria-hidden="true">
								<i />
								<i />
								<i />
							</div>
						) : (
							<div
								className={`wallpaper-screen-overlay ${crop.darkClock ? "dark-clock" : ""}`}
								aria-hidden="true"
							>
								<span>Thursday, December 24</span>
								<strong>09:41</strong>
								<div className="wallpaper-phone-controls">
									<i />
									<i />
								</div>
							</div>
						))}
				</div>
			</div>
			<strong className="christmas-preview-name">
				{generated ? t("yourWallpaper") : styleName}
			</strong>
			<p>{t(generated ? "resultPreviewNote" : "previewNote")}</p>
			<WallpaperButton
				imageUrl={imageUrl}
				getImageUrl={getImageUrl}
				label={t(generated ? "crop.action" : "tryCrop")}
				initialCrop={crop}
				onApply={(next) => {
					setCrop(next);
					onApplyCrop?.(next);
				}}
			/>
		</aside>
	);
}
