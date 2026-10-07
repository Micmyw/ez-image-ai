"use client";

import { ClapperboardIcon, ImageIcon, LockKeyholeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { useGenerationMode } from "../../lib/generation-mode-context";

export function ComposerHeader() {
	const studio = useTranslations("studio");
	const composer = useTranslations("studio.composer");
	const workspace = useGenerationMode();
	const mode = workspace?.mode ?? "image";

	return (
		<div className="studio-composer-heading">
			<fieldset className="composer-categories" aria-label={composer("mediaType")}>
				<button
					type="button"
					className="composer-category"
					aria-pressed={mode === "image"}
					data-generator-mode="image"
					onClick={() => workspace?.selectMode("image")}
				>
					<ImageIcon size={17} aria-hidden="true" />
					{composer("image")}
				</button>
				{workspace ? (
					<button
						type="button"
						className="composer-category"
						aria-pressed={mode === "video"}
						data-generator-mode="video"
						onClick={() => workspace.selectMode("video")}
					>
						<ClapperboardIcon size={17} aria-hidden="true" />
						{composer("video")}
					</button>
				) : (
					<Link href="/create?mode=video" className="composer-category">
						<ClapperboardIcon size={17} aria-hidden="true" />
						{composer("video")}
					</Link>
				)}
			</fieldset>
			<span className="composer-private" title={studio("private")}>
				<LockKeyholeIcon size={15} aria-hidden="true" />
				<span className="composer-private-label">{composer("private")}</span>
			</span>
		</div>
	);
}
