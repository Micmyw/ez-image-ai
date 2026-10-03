import Image from "next/image";
import Link from "next/link";

import { effectPath, type PublicEffect } from "../../effects/lib/types";
import { getPublishedPhotoIdeaBySlug } from "../lib/content";

export function EffectCallout({
	effect,
	presetId,
	sourceBlogId,
	label,
	compact = false,
}: {
	effect: PublicEffect;
	presetId?: string;
	sourceBlogId?: string;
	label: string;
	compact?: boolean;
}) {
	const idea = getPublishedPhotoIdeaBySlug(effect.slug);
	if (!idea) return null;
	return (
		<aside className={`blog-effect-callout${compact ? " blog-effect-callout-compact" : ""}`}>
			<Image
				src={effect.cover.src}
				alt={effect.cover.alt}
				width={effect.cover.width}
				height={effect.cover.height}
				loading="lazy"
				sizes={compact ? "180px" : "(max-width: 639px) 80px, 132px"}
			/>
			<div>
				<p className="blog-effect-title">{idea.post.title}</p>
				<p>{idea.post.description}</p>
				<Link href={effectPath(effect, presetId, sourceBlogId)}>
					{label}
					<span aria-hidden="true"> →</span>
				</Link>
			</div>
		</aside>
	);
}
