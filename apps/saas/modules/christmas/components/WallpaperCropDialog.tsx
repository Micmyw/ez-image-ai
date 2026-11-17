"use client";

import { drawBrowserGuestWatermark, loadBrowserExportImage } from "@media/lib/browser-image-export";
import { Button } from "@repo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@repo/ui/components/dialog";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

import { wallpaperCrop, type WallpaperTarget, type WallpaperCropSettings } from "../lib/wallpaper";

import "../wallpaper-crop.css";

export function WallpaperCropDialog({
	open,
	onOpenChange,
	imageUrl,
	getImageUrl,
	initialCrop,
	onApply,
	exportPrefix = "christmas-wallpaper",
	watermarked = false,
	onDownload,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	imageUrl?: string;
	getImageUrl?: () => Promise<string>;
	initialCrop?: WallpaperCropSettings;
	onApply?: (settings: WallpaperCropSettings) => void;
	exportPrefix?: string;
	watermarked?: boolean;
	onDownload?: () => void;
}) {
	const t = useTranslations("christmas.crop");
	const id = useId();
	const resolver = useRef(getImageUrl);
	resolver.current = getImageUrl;
	const canvas = useRef<HTMLCanvasElement>(null);
	const drag = useRef<{
		pointer: number;
		x: number;
		y: number;
		startX: number;
		startY: number;
	} | null>(null);
	const [picture, setPicture] = useState<HTMLImageElement | null>(null);
	const [failed, setFailed] = useState(false);
	const [saving, setSaving] = useState(false);
	const [retry, setRetry] = useState(0);
	const [target, setTarget] = useState<WallpaperTarget>(initialCrop?.target ?? "original");
	const [position, setPosition] = useState({
		x: initialCrop?.x ?? 50,
		y: initialCrop?.y ?? 50,
		zoom: initialCrop?.zoom ?? 1,
	});
	const [overlay, setOverlay] = useState(initialCrop?.overlay ?? true);
	const [darkClock, setDarkClock] = useState(initialCrop?.darkClock ?? false);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		let dispose: (() => void) | undefined;
		let active = true;
		setPicture(null);
		setFailed(false);
		void (async () => {
			try {
				const url = resolver.current ? await resolver.current() : imageUrl;
				if (!url || !active) throw new Error("Image unavailable");
				const loaded = await loadBrowserExportImage(url, controller.signal);
				dispose = loaded.dispose;
				if (active) setPicture(loaded.image);
				else loaded.dispose();
			} catch {
				if (active) setFailed(true);
			}
		})();
		return () => {
			active = false;
			controller.abort();
			dispose?.();
		};
	}, [open, imageUrl, retry]);
	const crop = picture
		? wallpaperCrop(
				picture.naturalWidth,
				picture.naturalHeight,
				target,
				position.x,
				position.y,
				position.zoom,
			)
		: null;
	const landscape = crop ? crop.width > crop.height : target === "desktop";
	useEffect(() => {
		const node = canvas.current;
		if (!node || !picture) return;
		const next = wallpaperCrop(
			picture.naturalWidth,
			picture.naturalHeight,
			target,
			position.x,
			position.y,
			position.zoom,
		);
		node.width = next.width;
		node.height = next.height;
		const context = node.getContext("2d");
		if (!context) return;
		context.drawImage(picture, next.sx, next.sy, next.sw, next.sh, 0, 0, next.width, next.height);
		if (watermarked) drawBrowserGuestWatermark(context, next.width, next.height);
	}, [picture, target, position, watermarked]);
	async function download() {
		if (!canvas.current || !picture || saving) return;
		onDownload?.();
		setSaving(true);
		let dispose: (() => void) | undefined;
		try {
			let current = picture;
			if (resolver.current) {
				const loaded = await loadBrowserExportImage(await resolver.current());
				current = loaded.image;
				dispose = loaded.dispose;
			}
			const pixels = wallpaperCrop(
				current.naturalWidth,
				current.naturalHeight,
				target,
				position.x,
				position.y,
				position.zoom,
			);
			const output = document.createElement("canvas");
			output.width = pixels.width;
			output.height = pixels.height;
			const context = output.getContext("2d");
			if (!context) throw new Error("Export failed");
			context.drawImage(
				current,
				pixels.sx,
				pixels.sy,
				pixels.sw,
				pixels.sh,
				0,
				0,
				pixels.width,
				pixels.height,
			);
			if (watermarked) drawBrowserGuestWatermark(context, pixels.width, pixels.height);
			const blob = await new Promise<Blob>((resolve, reject) =>
				output.toBlob(
					(value) => (value ? resolve(value) : reject(new Error("Export failed"))),
					"image/png",
				),
			);
			if (!mounted.current) return;
			onApply?.({ target, ...position, overlay, darkClock });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `${exportPrefix}-${pixels.width}x${pixels.height}.png`;
			document.body.append(link);
			link.click();
			link.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch {
			if (mounted.current) setFailed(true);
		} finally {
			dispose?.();
			if (mounted.current) setSaving(false);
		}
	}
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="wallpaper-crop-dialog"
				data-orientation={landscape ? "landscape" : "portrait"}
				style={{ "--wallpaper-ratio": crop ? crop.width / crop.height : 1 } as CSSProperties}
				closeLabel={t("close")}
			>
				<DialogTitle>{t("title")}</DialogTitle>
				<DialogDescription className="wallpaper-crop-description">
					{t("description")}
				</DialogDescription>
				<div className="wallpaper-crop-layout">
					<div className="wallpaper-crop-stage">
						{!picture && !failed && <output>{t("loading")}</output>}
						<div
							className="wallpaper-crop-frame"
							style={{
								visibility: picture ? "visible" : "hidden",
								width: crop
									? `min(100%, calc(var(--wallpaper-preview-height) * ${crop.width / crop.height}))`
									: undefined,
							}}
						>
							<div
								className="wallpaper-crop-viewport"
								style={{
									aspectRatio: crop ? `${crop.width}/${crop.height}` : undefined,
									touchAction: "none",
									cursor: picture ? "grab" : undefined,
								}}
								onPointerDown={(event) => {
									if (!picture) return;
									event.currentTarget.setPointerCapture(event.pointerId);
									drag.current = {
										pointer: event.pointerId,
										x: position.x,
										y: position.y,
										startX: event.clientX,
										startY: event.clientY,
									};
								}}
								onPointerMove={(event) => {
									const start = drag.current;
									if (!start || start.pointer !== event.pointerId || !picture || !crop) return;
									const bounds = event.currentTarget.getBoundingClientRect();
									const availableX = picture.naturalWidth - crop.sw;
									const availableY = picture.naturalHeight - crop.sh;
									setPosition((current) => ({
										...current,
										x:
											availableX > 0
												? Math.max(
														0,
														Math.min(
															100,
															start.x -
																((((event.clientX - start.startX) / bounds.width) * crop.sw) /
																	availableX) *
																	100,
														),
													)
												: 50,
										y:
											availableY > 0
												? Math.max(
														0,
														Math.min(
															100,
															start.y -
																((((event.clientY - start.startY) / bounds.height) * crop.sh) /
																	availableY) *
																	100,
														),
													)
												: 50,
									}));
								}}
								onPointerUp={() => {
									drag.current = null;
								}}
								onPointerCancel={() => {
									drag.current = null;
								}}
							>
								<canvas ref={canvas} aria-label={t("preview")} />
								{overlay && (
									<div
										className={`wallpaper-screen-overlay ${darkClock ? "dark-clock" : ""}`}
										aria-hidden="true"
									>
										{landscape ? (
											<div className="wallpaper-desktop-icons">
												<i />
												<i />
												<i />
											</div>
										) : (
											<>
												<span>Thursday, December 24</span>
												<strong>09:41</strong>
												<div className="wallpaper-phone-controls">
													<i />
													<i />
												</div>
											</>
										)}
									</div>
								)}
							</div>
						</div>
					</div>
					<div className="wallpaper-crop-controls">
						<label htmlFor={`${id}-screen`}>{t("screen")}</label>
						<select
							id={`${id}-screen`}
							value={target}
							disabled={saving}
							onChange={(event) => {
								setTarget(event.target.value as WallpaperTarget);
								setPosition({ x: 50, y: 50, zoom: 1 });
							}}
						>
							<option value="original">{t("original")}</option>
							<option value="phone">{t("phone")}</option>
							<option value="tall">{t("tall")}</option>
							<option value="desktop">{t("desktop")}</option>
						</select>
						{(["x", "y", "zoom"] as const).map((key) => (
							<label key={key} htmlFor={`${id}-${key}`}>
								{t(key)}
								<input
									id={`${id}-${key}`}
									type="range"
									min={key === "zoom" ? 1 : 0}
									max={key === "zoom" ? 3 : 100}
									step={key === "zoom" ? 0.01 : 1}
									value={position[key]}
									disabled={!picture || saving}
									onChange={(event) =>
										setPosition((current) => ({ ...current, [key]: Number(event.target.value) }))
									}
								/>
							</label>
						))}
						<label className="wallpaper-check">
							<input
								type="checkbox"
								checked={overlay}
								disabled={saving}
								onChange={(event) => setOverlay(event.target.checked)}
							/>
							{t("overlay")}
						</label>
						<label className="wallpaper-check">
							<input
								type="checkbox"
								checked={darkClock}
								disabled={!overlay || landscape || saving}
								onChange={(event) => setDarkClock(event.target.checked)}
							/>
							{t("darkClock")}
						</label>
						<p>{t("deviceNote")}</p>
						<output>{crop ? `${crop.width} × ${crop.height} px · PNG` : ""}</output>
						<p>{t("resolutionNote")}</p>
						{onApply && (
							<Button
								type="button"
								variant="secondary"
								disabled={!picture || saving}
								onClick={() => {
									onApply({ target, ...position, overlay, darkClock });
									onOpenChange(false);
								}}
							>
								{t("apply")}
							</Button>
						)}
						<Button
							type="button"
							onClick={() => void download()}
							disabled={!picture || saving}
							loading={saving}
						>
							{t("download")}
						</Button>
						{failed && (
							<div role="alert">
								<p>{t("error")}</p>
								<Button
									type="button"
									variant="secondary"
									onClick={() => setRetry((value) => value + 1)}
								>
									{t("retry")}
								</Button>
							</div>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
