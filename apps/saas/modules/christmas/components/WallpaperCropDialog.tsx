"use client";

import { Button } from "@repo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@repo/ui/components/dialog";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { wallpaperCrop, type WallpaperTarget } from "../lib/wallpaper";

import "../wallpaper-crop.css";

export function WallpaperCropDialog({
	open,
	onOpenChange,
	imageUrl,
	getImageUrl,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	imageUrl?: string;
	getImageUrl?: () => Promise<string>;
}) {
	const t = useTranslations("christmas.crop");
	const id = useId();
	const resolver = useRef(getImageUrl);
	resolver.current = getImageUrl;
	const canvas = useRef<HTMLCanvasElement>(null);
	const [picture, setPicture] = useState<HTMLImageElement | null>(null);
	const [failed, setFailed] = useState(false);
	const [saving, setSaving] = useState(false);
	const [retry, setRetry] = useState(0);
	const [target, setTarget] = useState<WallpaperTarget>("phone");
	const [position, setPosition] = useState({ x: 50, y: 50, zoom: 1 });
	const [overlay, setOverlay] = useState(true);
	const [darkClock, setDarkClock] = useState(false);
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
		const timer = window.setTimeout(() => controller.abort(), 30_000);
		let objectUrl: string | undefined;
		let active = true;
		setPicture(null);
		setFailed(false);
		void (async () => {
			try {
				const url = resolver.current ? await resolver.current() : imageUrl;
				if (!url || !active) throw new Error("Image unavailable");
				const response = await fetch(url, {
					signal: controller.signal,
					cache: "no-store",
					credentials: "omit",
					referrerPolicy: "no-referrer",
				});
				const mime = response.headers.get("content-type")?.split(";")[0] ?? "";
				if (
					!response.ok ||
					!["image/png", "image/jpeg", "image/webp"].includes(mime) ||
					!response.body
				)
					throw new Error("Image unavailable");
				const reader = response.body.getReader();
				const chunks: Uint8Array<ArrayBuffer>[] = [];
				let size = 0;
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						size += value.byteLength;
						if (size > 25 * 1024 * 1024) throw new Error("Image too large");
						chunks.push(new Uint8Array(value));
					}
				} finally {
					await reader.cancel();
					reader.releaseLock();
				}
				if (!active || !size) return;
				objectUrl = URL.createObjectURL(new Blob(chunks, { type: mime }));
				const image = new Image();
				image.src = objectUrl;
				await image.decode();
				if (image.naturalWidth * image.naturalHeight > 64_000_000)
					throw new Error("Image too large");
				if (active) setPicture(image);
			} catch {
				if (active) setFailed(true);
			} finally {
				window.clearTimeout(timer);
			}
		})();
		return () => {
			active = false;
			controller.abort();
			window.clearTimeout(timer);
			if (objectUrl) URL.revokeObjectURL(objectUrl);
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
		node
			.getContext("2d")
			?.drawImage(picture, next.sx, next.sy, next.sw, next.sh, 0, 0, next.width, next.height);
	}, [picture, target, position]);
	async function download() {
		if (!canvas.current || !picture || saving) return;
		setSaving(true);
		try {
			const blob = await new Promise<Blob>((resolve, reject) =>
				canvas.current!.toBlob(
					(value) => (value ? resolve(value) : reject(new Error("Export failed"))),
					"image/png",
				),
			);
			if (!mounted.current) return;
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `christmas-wallpaper-${crop!.width}x${crop!.height}.png`;
			document.body.append(link);
			link.click();
			link.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch {
			if (mounted.current) setFailed(true);
		} finally {
			if (mounted.current) setSaving(false);
		}
	}
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="wallpaper-crop-dialog" closeLabel={t("close")}>
				<DialogTitle>{t("title")}</DialogTitle>
				<DialogDescription className="wallpaper-crop-description">
					{t("description")}
				</DialogDescription>
				<div className="wallpaper-crop-layout">
					<div className="wallpaper-crop-stage">
						{!picture && !failed && <output>{t("loading")}</output>}
						<div
							className={`wallpaper-crop-frame ${target === "desktop" ? "is-desktop" : "is-phone"}`}
							style={{
								aspectRatio:
									target === "desktop" ? "16/9" : target === "tall" ? "1170/2532" : "9/16",
								visibility: picture ? "visible" : "hidden",
							}}
						>
							<canvas ref={canvas} aria-label={t("preview")} />
							{overlay && (
								<div
									className={`wallpaper-screen-overlay ${darkClock ? "dark-clock" : ""}`}
									aria-hidden="true"
								>
									{target === "desktop" ? (
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
					<div className="wallpaper-crop-controls">
						<label htmlFor={`${id}-screen`}>{t("screen")}</label>
						<select
							id={`${id}-screen`}
							value={target}
							onChange={(event) => {
								setTarget(event.target.value as WallpaperTarget);
								setPosition({ x: 50, y: 50, zoom: 1 });
							}}
						>
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
									disabled={!picture}
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
								onChange={(event) => setOverlay(event.target.checked)}
							/>
							{t("overlay")}
						</label>
						<label className="wallpaper-check">
							<input
								type="checkbox"
								checked={darkClock}
								onChange={(event) => setDarkClock(event.target.checked)}
							/>
							{t("darkClock")}
						</label>
						<p>{t("deviceNote")}</p>
						<output>{crop ? `${crop.width} × ${crop.height} px · PNG` : ""}</output>
						<p>{t("resolutionNote")}</p>
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
