"use client";

import { ClapperboardIcon, ImageIcon, LockKeyholeIcon } from "lucide-react";
import { useTranslations } from "next-intl";

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
				<button type="button" className="composer-category" aria-pressed="false" disabled>
					<ClapperboardIcon size={17} aria-hidden="true" />
					{composer("video")}
					<span className="composer-coming-soon">{composer("comingSoon")}</span>
				</button>
			</fieldset>
			<span className="composer-private" title={studio("private")}>
				<LockKeyholeIcon size={15} aria-hidden="true" />
				<span className="composer-private-label">{composer("private")}</span>
			</span>
		</div>
	);
}
