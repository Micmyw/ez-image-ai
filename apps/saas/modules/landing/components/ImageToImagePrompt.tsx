"use client";

import { LANDING_PROMPT_SELECTED_EVENT } from "../lib/prompt-selection";

export function ImageToImagePrompt({ prompt, label }: { prompt: string; label: string }) {
	return (
		<button
			type="button"
			className="mt-5 border-violet-300/25 px-4 py-2 text-sm font-semibold text-violet-200 hover:bg-violet-300/10 focus-visible:outline-violet-300 rounded-lg border transition focus-visible:outline-2 focus-visible:outline-offset-4"
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
			{label} <span aria-hidden="true">↗</span>
		</button>
	);
}
