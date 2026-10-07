"use client";

import { ClapperboardIcon, ImageIcon, LockKeyholeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

export function ComposerHeader() {
	const studio = useTranslations("studio");
	const composer = useTranslations("studio.composer");

	return (
		<div className="studio-composer-heading">
			<fieldset className="composer-categories" aria-label={composer("mediaType")}>
				<button type="button" className="composer-category" aria-pressed="true">
					<ImageIcon size={17} aria-hidden="true" />
					{composer("image")}
				</button>
				<Link href="/video" className="composer-category">
					<ClapperboardIcon size={17} aria-hidden="true" />
					{composer("video")}
				</Link>
			</fieldset>
			<span className="composer-private" title={studio("private")}>
				<LockKeyholeIcon size={15} aria-hidden="true" />
				<span className="composer-private-label">{composer("private")}</span>
			</span>
		</div>
	);
}
