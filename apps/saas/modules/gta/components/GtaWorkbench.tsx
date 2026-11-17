"use client";

import { ToolComposerProvider } from "@media/lib/tool-composer-context";
import { ToolPromptProvider, useToolPrompt } from "@media/lib/tool-prompt-context";
import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { WallpaperScreenPreview } from "../../christmas/components/WallpaperScreenPreview";
import {
	useWallpaperPreview,
	WallpaperResultProvider,
} from "../../christmas/lib/wallpaper-result-context";
import { trackGtaToolEvent } from "../lib/analytics";
import {
	buildGtaPrompt,
	gtaPromptDetails,
	GTA_DETAILS_LIMIT,
	defaultGtaSettings,
	gtaAspectRatio,
	gtaHash,
	GTA_PAGES,
	GTA_SCENES,
	gtaSettingsFromPrompt,
	parseGtaHash,
	type GtaIntent,
	type GtaSettings,
} from "../lib/config";
import { findGtaExample, GTA_EXAMPLES } from "../lib/examples";
import { GtaCompositionPreview } from "./GtaCompositionPreview";
import { LoadingArtPreview } from "./LoadingArtPreview";

import "../gta-composer.css";

export function GtaWorkbench({ intent, children }: { intent: GtaIntent; children: ReactNode }) {
	const [settings, setSettings] = useState(() => defaultGtaSettings(intent));
	const [restored, setRestored] = useState(false);
	useEffect(() => {
		let saved = "";
		try {
			saved = sessionStorage.getItem(`ezpic:gta-preset:v1:${intent}`) ?? "";
		} catch {
			// Public preset choices still work when browser storage is unavailable.
		}
		const shared = /(?:^#|&)(?:scene|format|mode|position)=/.test(window.location.hash);
		setSettings(parseGtaHash(intent, shared ? window.location.hash : saved));
		setRestored(true);
	}, [intent]);
	return (
		<ToolPromptProvider
			initialPrompt={buildGtaPrompt(intent, settings)}
			initialAspectRatio={gtaAspectRatio(settings.format)}
			returnPath={GTA_PAGES[intent].path}
			generationAccess="paid"
			allowReference={settings.sourceMode === "photo"}
			suspendReference={settings.sourceMode === "scene"}
			requireReference={settings.sourceMode === "photo"}
			rasterOnly
			lockAspectRatio
		>
			<WallpaperResultProvider>
				<Workbench intent={intent} settings={settings} setSettings={setSettings}>
					{restored ? children : <p aria-busy="true">Loading the image editor…</p>}
				</Workbench>
			</WallpaperResultProvider>
		</ToolPromptProvider>
	);
}

function Workbench({
	intent,
	settings,
	setSettings,
	children,
}: {
	intent: GtaIntent;
	settings: GtaSettings;
	setSettings: (settings: GtaSettings) => void;
	children: ReactNode;
}) {
	const editor = useToolPrompt();
	const { result, source, selectSource } = useWallpaperPreview();
	const accepted = result?.prompt ? gtaSettingsFromPrompt(result.prompt) : null;
	const [error, setError] = useState("");
	const [galleryFormat, setGalleryFormat] = useState<"phone" | "desktop">("phone");
	const [shareMessage, setShareMessage] = useState("");
	const [shareUrl, setShareUrl] = useState("");
	const hashChange = useRef<(hash: string) => void>(() => {});
	const pendingHash = useRef<string | null>(null);
	const scene = GTA_SCENES.find((item) => item.id === settings.sceneId)!;
	const example = findGtaExample(intent, settings);
	const disabled = !editor?.ready || editor.busy;
	useEffect(() => {
		if (editor?.ready)
			void trackGtaToolEvent("tool_view", intent, settings, { dedupeKey: `gta-view:${intent}` });
	}, [editor?.ready, intent, settings]);
	useEffect(() => {
		const update = () => hashChange.current(window.location.hash);
		window.addEventListener("hashchange", update);
		return () => window.removeEventListener("hashchange", update);
	}, []);
	useEffect(() => {
		if (!editor?.ready || editor.busy || !pendingHash.current) return;
		const hash = pendingHash.current;
		pendingHash.current = null;
		hashChange.current(hash);
	}, [editor?.ready, editor?.busy]);
	useEffect(() => {
		if (!editor?.ready) return;
		// An owner-bound resumed editor draft is authoritative over public preset storage.
		const accepted = gtaSettingsFromPrompt(editor.prompt);
		if (
			accepted?.intent === intent &&
			Object.keys(settings).some(
				(key) => settings[key as keyof GtaSettings] !== accepted.settings[key as keyof GtaSettings],
			)
		) {
			setSettings(accepted.settings);
			persistGtaPreset(intent, accepted.settings);
		}
	}, [editor?.ready, editor?.prompt, intent, setSettings, settings]);

	function apply(next: GtaSettings) {
		if (!editor?.ready || editor.busy) return;
		const currentPreset = gtaSettingsFromPrompt(editor.prompt);
		const details =
			currentPreset?.intent === intent
				? gtaPromptDetails(editor.prompt, intent, currentPreset.settings)
				: null;
		if (details === null && !window.confirm("Replace your edited prompt with this scene preset?"))
			return;
		const prompt = buildGtaPrompt(intent, next, details ?? "");
		if (!editor.apply(prompt, { aspectRatio: gtaAspectRatio(next.format) })) {
			setError(
				"This model does not support that layout. Choose a supported model in the editor and try again.",
			);
			return;
		}
		setSettings(next);
		setError("");
		setShareMessage("");
		setShareUrl("");
		persistGtaPreset(intent, next);
		void trackGtaToolEvent("scene_selected", intent, next);
		return true;
	}
	hashChange.current = (hash) => {
		if (hash.length > 256 || !/(?:^#|&)(?:scene|format|mode|position)=/.test(hash)) return;
		if (!editor?.ready || editor.busy) pendingHash.current = hash;
		else apply(parseGtaHash(intent, hash));
	};

	async function share() {
		const url = new URL(GTA_PAGES[intent].path, window.location.origin);
		url.hash = gtaHash(settings).slice(1);
		try {
			await navigator.clipboard.writeText(url.href);
			setShareUrl("");
			setShareMessage("Scene link copied.");
		} catch {
			setShareMessage("Copy your scene link below.");
			setShareUrl(url.href);
		}
	}
	function useScene(next: GtaSettings) {
		if (apply(next)) selectSource("example");
	}
	function trackPreviewDownload() {
		const generated = result && source === "result";
		void trackGtaToolEvent(
			generated ? "result_download_clicked" : "sample_download",
			intent,
			generated && accepted?.intent === intent ? accepted.settings : settings,
			generated && result.jobId ? { jobKey: result.jobId } : undefined,
		);
	}
	const preset = editor?.prompt ? gtaSettingsFromPrompt(editor.prompt) : null;
	const details =
		preset?.intent === intent
			? gtaPromptDetails(editor?.prompt ?? "", intent, preset.settings)
			: null;
	const composer = {
		beforeReference: (
			<>
				{intent === "wallpaper" && (
					<fieldset className="gta-mode" disabled={disabled}>
						<legend>Start with</legend>
						{(["photo", "scene"] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								aria-pressed={settings.sourceMode === mode}
								onClick={() => apply({ ...settings, sourceMode: mode })}
							>
								{mode === "photo" ? "Use my photo" : "Create a scene"}
							</button>
						))}
					</fieldset>
				)}
				<p className="gta-editor-hint">
					{settings.sourceMode === "photo"
						? "Upload one clear portrait with your face visible."
						: "Create a scene without people. Your photo stays available when you switch back."}
				</p>
			</>
		),
		afterReference: (
			<>
				<section className="gta-scenes" id="gta-scenes" aria-labelledby="gta-scenes-title">
					<div className="gta-section-heading">
						<h3 id="gta-scenes-title">Choose a scene</h3>
					</div>
					<div className="gta-scene-grid">
						{GTA_SCENES.map((item) => {
							const sample = GTA_EXAMPLES.find(
								(entry) => entry.sceneId === item.id && !entry.sourceSrc,
							)!;
							return (
								<article
									key={item.id}
									className={settings.sceneId === item.id ? "is-selected" : undefined}
								>
									<button
										type="button"
										disabled={disabled}
										aria-pressed={settings.sceneId === item.id}
										aria-label={`Use ${item.name} scene`}
										onClick={() => useScene({ ...settings, sceneId: item.id })}
									>
										<div className="gta-scene-image">
											<Image
												src={sample.src}
												alt={sample.alt}
												width={sample.width}
												height={sample.height}
												sizes="(max-width: 600px) 44vw, (max-width: 1000px) 28vw, 190px"
											/>
										</div>
										<span className="gta-scene-name">{item.name}</span>
									</button>
								</article>
							);
						})}
					</div>
				</section>
				<div className="gta-options">
					<fieldset className="gta-screen-options" disabled={disabled}>
						<legend>Layout</legend>
						{(["phone", "desktop"] as const).map((format) => (
							<button
								key={format}
								type="button"
								aria-pressed={settings.format === format}
								onClick={() => apply({ ...settings, format })}
							>
								{format === "phone" ? "Phone · 9:16" : "Desktop · 16:9"}
							</button>
						))}
					</fieldset>
					{intent === "loading-art" && (
						<fieldset className="gta-position-options" disabled={disabled}>
							<legend>Portrait position</legend>
							{(["left", "right"] as const).map((position) => (
								<button
									key={position}
									type="button"
									aria-pressed={settings.position === position}
									onClick={() => apply({ ...settings, position })}
								>
									{position === "left" ? "Left" : "Right"}
								</button>
							))}
						</fieldset>
					)}
				</div>
				{details !== null ? (
					<details className="gta-extra-details">
						<summary>
							Additional instructions <span>(optional)</span>
						</summary>
						<label htmlFor="gta-extra-instructions">Details to include</label>
						<textarea
							id="gta-extra-instructions"
							name="gta-details"
							autoComplete="off"
							rows={3}
							maxLength={GTA_DETAILS_LIMIT}
							value={details}
							disabled={disabled}
							data-clarity-mask="true"
							placeholder="For example, warm sunset light and a blue jacket…"
							onChange={(event) =>
								editor?.apply(buildGtaPrompt(intent, settings, event.target.value))
							}
						/>
					</details>
				) : (
					<p className="gta-editor-hint">
						Your custom instructions have been preserved. Choosing a scene lets you replace them
						with its preset.
					</p>
				)}
			</>
		),
		summary: (
			<p className="gta-draft-summary">
				{scene.name} · {gtaAspectRatio(settings.format)} ·{" "}
				{intent === "loading-art" ? "Static image · PNG name export" : "Wallpaper · preview & crop"}
			</p>
		),
	};
	return (
		<>
			<div className="gta-workbench" data-input-mode={settings.sourceMode}>
				<section className="gta-editor" id="gta-editor" aria-labelledby="gta-editor-title">
					<h2 id="gta-editor-title">
						{intent === "wallpaper" ? "Make your wallpaper" : "Make your loading art"}
					</h2>
					{error && <p role="alert">{error}</p>}
					<ToolComposerProvider value={composer}>{children}</ToolComposerProvider>
					<p className="gta-editor-hint">
						Generate with subscription credits, a credit pack, or an Image Pass.
					</p>
					<a
						className="gta-policy-reminder"
						href="/terms#prohibited-content"
						target="_blank"
						rel="noopener noreferrer"
						data-test="content-policy-reminder"
					>
						Adult / NSFW content is prohibited
						<span className="sr-only"> — Read our content policy in a new tab</span>
					</a>
					<button className="gta-share" type="button" onClick={() => void share()}>
						Copy scene link
					</button>
					{shareMessage && <output>{shareMessage}</output>}
					{shareUrl && (
						<label className="gta-share-link">
							Scene link
							<input readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} />
						</label>
					)}
				</section>
				{intent === "wallpaper" ? (
					<WallpaperScreenPreview
						settings={{
							screen:
								source === "result" && accepted?.intent === intent
									? accepted.settings.format
									: settings.format,
						}}
						styleName={scene.name}
						example={example}
						examplePlaceholder={<GtaCompositionPreview intent={intent} settings={settings} />}
						exportPrefix="gta-wallpaper"
						onDownload={trackPreviewDownload}
					/>
				) : (
					<LoadingArtPreview
						placeholder={<GtaCompositionPreview intent={intent} settings={settings} />}
						example={example}
						format={settings.format}
						position={settings.position}
						onDownload={trackPreviewDownload}
					/>
				)}
			</div>
			{intent === "wallpaper" && (
				<section className="gta-gallery" id="gta-gallery" aria-labelledby="gta-gallery-title">
					<div className="gta-section-heading">
						<div>
							<h2 id="gta-gallery-title">Original wallpapers to download</h2>
							<p>Original AI artwork · GTA-inspired</p>
						</div>
						<fieldset className="gta-gallery-filters">
							<legend className="sr-only">Wallpaper format</legend>
							{(["phone", "desktop"] as const).map((format) => (
								<button
									key={format}
									type="button"
									aria-pressed={galleryFormat === format}
									onClick={() => setGalleryFormat(format)}
								>
									{format === "phone" ? "Phone wallpapers" : "Desktop wallpapers"}
								</button>
							))}
						</fieldset>
					</div>
					<div className="gta-gallery-grid">
						{GTA_EXAMPLES.filter(
							(item) =>
								item.intent === "wallpaper" && item.format === galleryFormat && !item.sourceSrc,
						).map((item) => (
							<article key={item.id}>
								<Image
									src={item.src}
									alt={item.alt}
									width={item.width}
									height={item.height}
									sizes="(max-width: 600px) 90vw, (max-width: 1000px) 44vw, 350px"
								/>
								<h3>{GTA_SCENES.find((entry) => entry.id === item.sceneId)!.name}</h3>
								<p>
									{item.width} × {item.height} px
								</p>
								<a
									href={item.downloadSrc}
									download={`ezimageai-${item.id}.jpg`}
									onClick={() =>
										void trackGtaToolEvent("sample_download", intent, {
											...settings,
											sceneId: item.sceneId,
											format: item.format,
											sourceMode: "scene",
										})
									}
								>
									Download sample wallpaper
								</a>
								<button
									type="button"
									disabled={disabled}
									onClick={() =>
										useScene({ ...settings, sceneId: item.sceneId, format: item.format })
									}
								>
									Use this scene
								</button>
							</article>
						))}
					</div>
				</section>
			)}
		</>
	);
}

function persistGtaPreset(intent: GtaIntent, next: GtaSettings) {
	const url = new URL(window.location.href);
	url.hash = gtaHash(next);
	window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
	try {
		sessionStorage.setItem(`ezpic:gta-preset:v1:${intent}`, gtaHash(next));
	} catch {
		/* Optional public preferences. */
	}
}
