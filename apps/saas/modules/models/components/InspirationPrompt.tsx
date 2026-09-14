"use client";

import { LANDING_PROMPT_SELECTED_EVENT } from "../../landing/lib/prompt-selection";

export function InspirationPrompt({ prompt }: { prompt: string }) {
	return (
		<button
			type="button"
			className="model-prompt-button"
			onClick={() => {
				window.dispatchEvent(
					new CustomEvent(LANDING_PROMPT_SELECTED_EVENT, { detail: { prompt } }),
				);
				document.getElementById("image-editor")?.scrollIntoView({
					behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
						? "auto"
						: "smooth",
				});
			}}
		>
			Use this prompt <span aria-hidden="true">↗</span>
		</button>
	);
}
