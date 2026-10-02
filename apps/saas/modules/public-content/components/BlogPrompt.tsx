"use client";

import { recordBlogPromptCopied } from "../../effects/lib/analytics";
import { PromptBlock } from "./PromptBlock";

/** The suggested example stays in the article body; no second prompt record is maintained. */
export function BlogPrompt({
	prompt,
	post,
}: {
	prompt: string;
	post: { id: string; slug: string; published: boolean };
}) {
	return (
		<PromptBlock
			prompt={prompt}
			onCopied={() => {
				void recordBlogPromptCopied(post);
			}}
		/>
	);
}
