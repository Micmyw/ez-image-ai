"use client";

import { useSession } from "@auth/hooks/use-session";
import {
	downloadBrowserCanvas,
	drawBrowserGuestWatermark,
	loadBrowserExportImage,
} from "@media/lib/browser-image-export";
import { Button } from "@repo/ui/components/button";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useWallpaperPreview } from "../../christmas/lib/wallpaper-result-context";
import { gtaSettingsFromPrompt } from "../lib/config";
import {
	drawLoadingName,
	loadingExportFont,
	LOADING_NAME_LIMIT,
	nameGraphemes,
	normalizeLoadingName,
} from "../lib/name-layout";

import "../loading-art.css";

type LoadingExample = { src: string; alt: string; width: number; height: number };

type LoadingArtProps = {
	example?: LoadingExample;
	placeholder?: ReactNode;
	position: "left" | "right";
	format: "phone" | "desktop";
	onDownload?: () => void;
};

export function LoadingArtPreview(props: LoadingArtProps) {
	const { user } = useSession();
	const owner = user && user.isAnonymous !== true ? user.id : "guest";
	return <OwnedLoadingArtPreview key={owner} {...props} />;
}

function OwnedLoadingArtPreview({
	example,
	placeholder,
	position,
	format,
	onDownload,
}: LoadingArtProps) {
	const { result, source, selectSource } = useWallpaperPreview();
	const [name, setName] = useState("");
	const [withName, setWithName] = useState(false);
	const generated = Boolean(result && source === "result");
	const accepted = generated && result?.prompt ? gtaSettingsFromPrompt(result.prompt) : null;
	// Accepted artwork owns its layout even while the next draft is being edited.
	const resultFormat =
		accepted?.settings.format ?? (result?.aspectRatio === "9:16" ? "phone" : "desktop");
	return (
		<aside
			className="gta-art-preview"
			aria-label="Loading-screen art preview"
			data-art-source={generated ? "result" : "example"}
		>
			<div className="gta-art-preview-heading">
				<strong>
					{generated ? "Your loading-screen art" : example ? "Style preview" : "Your composition"}
				</strong>
				{result && (
					<fieldset aria-label="Preview image">
						<button type="button" aria-pressed={generated} onClick={() => selectSource("result")}>
							Your result
						</button>
						<button type="button" aria-pressed={!generated} onClick={() => selectSource("example")}>
							Style preview
						</button>
					</fieldset>
				)}
			</div>
			<ArtCanvas
				key={generated ? result?.assetId : (example?.src ?? "composition")}
				example={example}
				placeholder={placeholder}
				name={name}
				setName={setName}
				withName={withName}
				setWithName={setWithName}
				imageUrl={generated ? result?.imageUrl : example?.src}
				getImageUrl={generated ? result?.getImageUrl : undefined}
				generated={generated}
				watermarked={generated && result?.watermarked}
				position={generated ? accepted?.settings.position : position}
				format={generated ? resultFormat : format}
				onDownload={onDownload}
			/>
		</aside>
	);
}

function ArtCanvas({
	example,
	placeholder,
	name,
	setName,
	withName,
	setWithName,
	imageUrl,
	getImageUrl,
	generated,
	watermarked,
	position,
	format,
	onDownload,
}: {
	example?: LoadingExample;
	placeholder?: ReactNode;
	name: string;
	setName: (name: string) => void;
	withName: boolean;
	setWithName: (enabled: boolean) => void;
	imageUrl?: string;
	getImageUrl?: () => Promise<string>;
	generated: boolean;
	watermarked?: boolean;
	position?: "left" | "right";
	format: "phone" | "desktop";
	onDownload?: () => void;
}) {
	const id = useId();
	const canvas = useRef<HTMLCanvasElement>(null);
	const resolver = useRef(getImageUrl);
	resolver.current = getImageUrl;
	const [picture, setPicture] = useState<HTMLImageElement | null>(null);
	const [failed, setFailed] = useState(false);
	const [saving, setSaving] = useState(false);
	const [retry, setRetry] = useState(0);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (!imageUrl && !resolver.current) return;
		const controller = new AbortController();
		let dispose: (() => void) | undefined;
		let active = true;
		setFailed(false);
		void (async () => {
			try {
				const url = resolver.current ? await resolver.current() : imageUrl;
				if (!url) throw new Error("Image unavailable");
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
	}, [imageUrl, retry]);
	const paint = useCallback(
		async (
			image: HTMLImageElement,
			node: HTMLCanvasElement,
			isCurrent: () => boolean = () => true,
		) => {
			const font = withName && name.trim() ? await loadingExportFont(name) : "Arial, sans-serif";
			if (!isCurrent()) return;
			node.width = image.naturalWidth;
			node.height = image.naturalHeight;
			const context = node.getContext("2d");
			if (!context) throw new Error("Preview unavailable");
			context.drawImage(image, 0, 0);
			if (withName && name.trim())
				drawLoadingName(context, name, node.width, node.height, position, format, font);
			if (watermarked) drawBrowserGuestWatermark(context, node.width, node.height);
		},
		[withName, name, position, format, watermarked],
	);
	useEffect(() => {
		const node = canvas.current;
		if (!node || !picture) return;
		let active = true;
		// A slower font load cannot overwrite a newer name or an unmounted result.
		void paint(picture, node, () => active).catch(() => {
			if (active) setFailed(true);
		});
		return () => {
			active = false;
		};
	}, [picture, paint]);
	async function download() {
		if (!picture || saving) return;
		onDownload?.();
		setSaving(true);
		setFailed(false);
		let dispose: (() => void) | undefined;
		try {
			let current = picture;
			if (resolver.current) {
				const loaded = await loadBrowserExportImage(await resolver.current());
				current = loaded.image;
				dispose = loaded.dispose;
			}
			const output = document.createElement("canvas");
			await paint(current, output, () => mounted.current);
			if (!mounted.current) return;
			await downloadBrowserCanvas(
				output,
				`gta-loading-art-${output.width}x${output.height}${withName && name.trim() ? "-named" : ""}.png`,
			);
		} catch {
			if (mounted.current) setFailed(true);
		} finally {
			dispose?.();
			if (mounted.current) setSaving(false);
		}
	}
	return (
		<div className="gta-art-canvas" data-format={format} data-name-position={position ?? "bottom"}>
			{!generated && !example ? (
				placeholder
			) : (
				<div
					className="gta-art-stage"
					style={{
						aspectRatio: picture
							? `${picture.naturalWidth}/${picture.naturalHeight}`
							: example
								? `${example.width}/${example.height}`
								: format === "phone"
									? "9/16"
									: "16/9",
					}}
				>
					{!picture && !generated && example && (
						<img
							src={example.src}
							alt={example.alt}
							width={example.width}
							height={example.height}
						/>
					)}
					{!picture && generated && <output>Loading your image…</output>}
					<canvas
						ref={canvas}
						hidden={!picture}
						aria-label={generated ? "Your loading-screen art" : example?.alt}
						data-clarity-mask={generated ? "true" : undefined}
					/>
				</div>
			)}
			<div className="gta-art-name-controls">
				<label htmlFor={`${id}-name`}>
					Your name{" "}
					<span>
						{nameGraphemes(name).length}/{LOADING_NAME_LIMIT}
					</span>
				</label>
				<input
					id={`${id}-name`}
					data-clarity-mask="true"
					value={name}
					name="loading-art-name"
					placeholder="For example, Alex Rivera…"
					autoComplete="off"
					disabled={saving}
					onChange={(event) => {
						const next = normalizeLoadingName(event.target.value);
						setName(next);
						setWithName(Boolean(next.trim()));
					}}
				/>
				<fieldset aria-label="Name layer" disabled={saving}>
					<button
						type="button"
						aria-pressed={!withName || !name.trim()}
						onClick={() => setWithName(false)}
					>
						Clean image
					</button>
					<button
						type="button"
						aria-pressed={withName && Boolean(name.trim())}
						disabled={!name.trim()}
						onClick={() => setWithName(true)}
					>
						With my name
					</button>
				</fieldset>
				<p>Your name stays editable. Previewing and downloading use no generation credits.</p>
				<output>
					{picture ? `${picture.naturalWidth} × ${picture.naturalHeight} px · PNG` : ""}
				</output>
				<Button
					type="button"
					onClick={() => void download()}
					disabled={!picture || saving}
					loading={saving}
				>
					{generated
						? "Download my art"
						: example
							? "Download style preview"
							: "Generate to download your art"}
				</Button>
				{failed && (
					<div role="alert">
						<p>
							The image could not be loaded or exported. Your name is saved. Retry to refresh image
							access.
						</p>
						<Button
							type="button"
							variant="secondary"
							disabled={saving}
							onClick={() => setRetry((value) => value + 1)}
						>
							Try again
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
