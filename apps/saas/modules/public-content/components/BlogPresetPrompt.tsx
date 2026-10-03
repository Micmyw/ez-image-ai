"use client";

import { recordBlogPromptCopied } from "../../effects/lib/analytics";
import type { PublicEffect } from "../../effects/lib/types";
import { PromptBlock } from "./PromptBlock";

export function BlogPresetPrompt({
	post,
	effect,
	presetId,
}: {
	post: { id: string; slug: string; published: boolean };
	effect: PublicEffect;
	presetId: string;
}) {
	const preset = effect.presets.find((candidate) => candidate.id === presetId);
	if (!preset) return null;
	return (
		<div className="blog-preset-prompt">
			<PromptBlock
				title={preset.name}
				prompt={preset.prompt}
				onCopied={() => {
					void recordBlogPromptCopied(post, { effect, presetId, allowedSourceBlogIds: [post.id] });
				}}
			/>
		</div>
	);
}
