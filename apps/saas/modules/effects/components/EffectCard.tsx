import { useTranslations } from "next-intl";
import Image from "next/image";
import Link from "next/link";

import { effectPath, type PublicEffect } from "../lib/types";

export function EffectCard({
	effect,
	internalSource = "effects-directory",
	featured = false,
}: {
	effect: PublicEffect;
	internalSource?: "effects-directory" | "home" | "image-to-image" | "model" | "effect";
	featured?: boolean;
}) {
	const t = useTranslations("effects");
	const href = `${effectPath(effect)}?from=${internalSource}`;
	const heading = (
		<>
			<p className="effect-eyebrow">
				{featured && <span className="effect-featured-label">{t("featuredLabel")}</span>}
				{t(`categories.${effect.primaryCategoryId}`)}
			</p>
			<h2>
				<Link href={href}>{effect.title}</Link>
			</h2>
		</>
	);
	return (
		<article className={`effect-card${featured ? " is-featured" : ""}`}>
			{featured && <div className="effect-card-featured-heading">{heading}</div>}
			<Link href={href} className="effect-card-image" tabIndex={-1} aria-hidden="true">
				<Image
					src={effect.cover.src}
					alt={effect.cover.alt}
					width={effect.cover.width}
					height={effect.cover.height}
					sizes={
						featured
							? "(max-width: 767px) 100vw, (max-width: 1280px) 55vw, 660px"
							: "(max-width: 600px) 100vw, (max-width: 1024px) 50vw, 33vw"
					}
					loading={featured ? "eager" : "lazy"}
				/>
			</Link>
			<div className="effect-card-copy">
				{!featured && heading}
				<p>{effect.summary}</p>
				<Link className={featured ? "effect-button" : "effect-text-link"} href={href}>
					{t(featured ? "explorePrompts" : "exploreEffect")} <span aria-hidden="true">↗</span>
				</Link>
			</div>
		</article>
	);
}
