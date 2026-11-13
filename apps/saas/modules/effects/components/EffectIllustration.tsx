"use client";

import { useTranslations } from "next-intl";
import Image from "next/image";

import type { PublicEffectIllustration } from "../lib/types";

export function EffectIllustration({ illustration }: { illustration: PublicEffectIllustration }) {
	const t = useTranslations("effects");
	return (
		<figure className="effect-style-preview">
			<Image
				loading="eager"
				src={illustration.image.src}
				alt={illustration.image.alt}
				width={illustration.image.width}
				height={illustration.image.height}
				sizes="(max-width: 767px) 90vw, 48vw"
			/>
			<figcaption>
				<strong>{illustration.caption}</strong>
				<span>{t("illustrationNotice")}</span>
			</figcaption>
		</figure>
	);
}
