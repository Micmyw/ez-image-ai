import { useTranslations } from "next-intl";
import Link from "next/link";

import { EffectExample } from "../../effects/components/EffectExample";
import { effectPath, type PublicEffect } from "../../effects/lib/types";
import { getPublishedPhotoIdeaBySlug } from "../lib/content";
import { BlogPresetPrompt } from "./BlogPresetPrompt";

export function BlogEffectFeature({
	post,
	effect,
	presetId,
	showExample = true,
	showPrompt = true,
}: {
	post: { id: string; slug: string; published: boolean };
	effect: PublicEffect;
	presetId: string;
	showExample?: boolean;
	showPrompt?: boolean;
}) {
	const t = useTranslations();
	const idea = getPublishedPhotoIdeaBySlug(effect.slug);
	const preset = effect.presets.find((candidate) => candidate.id === presetId);
	if (!preset || !idea) return null;
	const example = effect.examples.find(
		(candidate) =>
			candidate.presetId === preset.id &&
			candidate.presetVersion === preset.version &&
			preset.exampleIds.includes(candidate.id),
	);
	return (
		<aside className="blog-effect-feature">
			<div className="blog-effect-feature-heading">
				<p className="blog-category">{t("guides.relatedEffects")}</p>
				<p className="blog-effect-feature-title">{idea.post.title}</p>
				<p>{idea.post.description}</p>
			</div>
			{showExample && example && <EffectExample example={example} />}
			{showPrompt && <BlogPresetPrompt post={post} effect={effect} presetId={preset.id} />}
			<Link className="blog-effect-feature-cta" href={effectPath(effect, preset.id, post.id)}>
				{t("guides.usePreset")}
				<span aria-hidden="true"> →</span>
			</Link>
		</aside>
	);
}
