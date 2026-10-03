import { useTranslations } from "next-intl";
import Link from "next/link";

import { getEffectsForProduct, getFeaturedEffects } from "../lib/content";
import type { PublicEffect } from "../lib/types";
import { EffectCard } from "./EffectCard";

import "../effects.css";

export function EffectRecommendations({
	effects,
	title,
	productKey,
	featured = false,
	internalSource,
}: {
	effects?: PublicEffect[];
	title?: string;
	productKey?: string;
	featured?: boolean;
	internalSource?: "home" | "image-to-image" | "model" | "effect";
}) {
	const t = useTranslations("effects");
	const selected =
		effects ??
		(featured ? getFeaturedEffects(4) : productKey ? getEffectsForProduct(productKey) : []);
	if (!selected.length) return null;
	return (
		<section className="effects-related container">
			<div className="effects-section-heading">
				<h2>{title ?? (featured ? t("featured") : t("relatedEffects"))}</h2>
				<Link href="/effects" className="effect-text-link">
					{t("exploreAll")} <span aria-hidden="true">↗</span>
				</Link>
			</div>
			<div className={selected.length === 1 ? "effects-grid is-single" : "effects-grid"}>
				{selected.slice(0, featured ? 4 : 3).map((effect) => (
					<EffectCard
						key={effect.id}
						effect={effect}
						featured={selected.length === 1}
						internalSource={internalSource ?? (featured ? "home" : productKey ? "model" : "effect")}
					/>
				))}
			</div>
		</section>
	);
}
