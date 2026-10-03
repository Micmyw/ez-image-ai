import Image from "next/image";
import Link from "next/link";

import { effectPath, type PublicEffect } from "../../effects/lib/types";

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
				<p className="blog-effect-title">{effect.title}</p>
				<p>{effect.summary}</p>
				<Link href={effectPath(effect, presetId, sourceBlogId)}>
					{label}
					<span aria-hidden="true"> →</span>
				</Link>
			</div>
		</aside>
	);
}
