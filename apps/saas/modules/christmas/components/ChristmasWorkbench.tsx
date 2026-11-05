"use client";

import { ToolPromptProvider, useToolPrompt } from "@media/lib/tool-prompt-context";
import { MonitorIcon, SmartphoneIcon, SnowflakeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { useRef, useState, type ReactNode } from "react";

import {
	buildChristmasPrompt,
	CHRISTMAS_STYLES,
	DEFAULT_WALLPAPER_SETTINGS,
	wallpaperAspectRatio,
	wallpaperImage,
	type WallpaperSettings,
} from "../lib/wallpaper";
import { useWallpaperPreview, WallpaperResultProvider } from "../lib/wallpaper-result-context";
import { WallpaperScreenPreview } from "./WallpaperScreenPreview";

export function ChristmasWorkbench({ children }: { children: ReactNode }) {
	const [settings, setSettings] = useState(DEFAULT_WALLPAPER_SETTINGS);
	return (
		<ToolPromptProvider
			initialPrompt={buildChristmasPrompt(DEFAULT_WALLPAPER_SETTINGS)}
			initialAspectRatio="9:16"
			returnPath="/christmas-wallpaper"
			allowReference={settings.mode === "photo"}
		>
			<WallpaperResultProvider>
				<Workbench settings={settings} setSettings={setSettings}>
					{children}
				</Workbench>
			</WallpaperResultProvider>
		</ToolPromptProvider>
	);
}

function Workbench({
	children,
	settings,
	setSettings,
}: {
	children: ReactNode;
	settings: WallpaperSettings;
	setSettings: (settings: WallpaperSettings) => void;
}) {
	const t = useTranslations("christmas");
	const editor = useToolPrompt();
	const { selectSource } = useWallpaperPreview();
	const [error, setError] = useState(false);
	const lastApplied = useRef(buildChristmasPrompt(DEFAULT_WALLPAPER_SETTINGS));
	const selected = CHRISTMAS_STYLES.find((style) => style.id === settings.style)!;
	function apply(next: WallpaperSettings) {
		if (!editor?.ready || editor.busy) return;
		if (editor.prompt !== lastApplied.current && !window.confirm(t("replacePrompt"))) return;
		const prompt = buildChristmasPrompt(next);
		if (
			!editor.apply(prompt, {
				aspectRatio: wallpaperAspectRatio(next.screen),
				clearReference: next.mode === "scene" && settings.mode !== "scene",
			})
		) {
			setError(true);
			return;
		}
		lastApplied.current = prompt;
		setSettings(next);
		setError(false);
		return true;
	}
	return (
		<>
			<div className="christmas-workbench" data-input-mode={settings.mode}>
				<section
					className="christmas-editor"
					id="image-editor"
					aria-labelledby="christmas-editor-title"
				>
					<div className="christmas-editor-heading">
						<SnowflakeIcon aria-hidden="true" />
						<h2 id="christmas-editor-title">{t("makeYours")}</h2>
					</div>
					<fieldset className="christmas-mode" disabled={!editor?.ready || editor.busy}>
						<legend className="sr-only">{t("inputMode")}</legend>
						{(["photo", "scene"] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								aria-pressed={settings.mode === mode}
								onClick={() => apply({ ...settings, mode })}
							>
								{t(mode)}
							</button>
						))}
					</fieldset>
					<div className="christmas-options">
						<fieldset disabled={!editor?.ready || editor.busy}>
							<legend>{t("screen")}</legend>
							<div className="christmas-screen-options">
								{(["phone", "desktop"] as const).map((screen) => (
									<button
										key={screen}
										type="button"
										aria-pressed={settings.screen === screen}
										onClick={() => apply({ ...settings, screen })}
									>
										{screen === "phone" ? (
											<SmartphoneIcon aria-hidden="true" />
										) : (
											<MonitorIcon aria-hidden="true" />
										)}
										{t(screen)}
									</button>
								))}
							</div>
						</fieldset>
						<label className="christmas-outfit">
							<input
								type="checkbox"
								checked={settings.festiveOutfit}
								disabled={!editor?.ready || editor.busy || settings.mode === "scene"}
								onChange={(event) => apply({ ...settings, festiveOutfit: event.target.checked })}
							/>
							{t("outfit")}
						</label>
					</div>
					<p className="christmas-editor-hint">
						{settings.mode === "photo" ? t("photoHint") : t("sceneHint")}
					</p>
					{error && <p role="alert">{t("unsupportedRatio")}</p>}
					<div className="christmas-current-style">
						<span>{t("selectedStyle")}</span>
						<strong>{selected.name}</strong>
						<a href="#christmas-styles">{t("changeStyle")} ↓</a>
					</div>
					{children}
					<p className="christmas-cost-note">{t("costNote")}</p>
				</section>
				<WallpaperScreenPreview settings={settings} styleName={selected.name} />
			</div>
			<section
				className="christmas-styles"
				id="christmas-styles"
				aria-labelledby="christmas-styles-title"
			>
				<div className="christmas-section-heading">
					<div>
						<p className="christmas-eyebrow">A little holiday inspiration</p>
						<h2 id="christmas-styles-title">Six ways to make it Christmas.</h2>
					</div>
					<p>Choose a look. Make it yours.</p>
				</div>
				<div className="christmas-style-grid">
					{CHRISTMAS_STYLES.map((style) => (
						<article className={style.id === settings.style ? "is-selected" : ""} key={style.id}>
							<div className="christmas-style-image">
								<Image
									src={wallpaperImage(style.id)}
									alt={`${style.name} Christmas wallpaper style`}
									width={941}
									height={1672}
									sizes="(max-width: 600px) 44vw, (max-width: 1000px) 28vw, 190px"
								/>
								<span>{style.photo ? t("photoStyle") : t("sceneStyle")}</span>
							</div>
							<h3>{style.name}</h3>
							<p>{style.detail}</p>
							<button
								type="button"
								disabled={!editor?.ready || editor.busy}
								aria-label={`${t("useStyle")}: ${style.name}`}
								aria-pressed={settings.style === style.id}
								onClick={() => {
									if (apply({ ...settings, style: style.id })) {
										selectSource("example");
										document.getElementById("image-editor")?.scrollIntoView({
											behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
												? "instant"
												: "smooth",
											block: "start",
										});
									}
								}}
							>
								{settings.style === style.id ? t("selected") : t("useStyle")}{" "}
								<span aria-hidden="true">↗</span>
							</button>
						</article>
					))}
				</div>
			</section>
		</>
	);
}
