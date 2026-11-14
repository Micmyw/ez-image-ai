"use client";

import {
	LANDING_PROMPT_SELECTED_EVENT,
	type LandingPromptSelectedDetail,
} from "../../landing/lib/prompt-selection";
import { generatorModeUrl } from "../../media/lib/generator-navigation";

export function applyInspirationPrompt({ prompt, selection }: LandingPromptSelectedDetail) {
	window.dispatchEvent(
		new CustomEvent<LandingPromptSelectedDetail>(LANDING_PROMPT_SELECTED_EVENT, {
			detail: { prompt, selection },
		}),
	);
	if (new URL(window.location.href).searchParams.get("mode") === "video")
		window.history.pushState(null, "", generatorModeUrl(window.location.href, "image"));
	document.getElementById("image-editor")?.scrollIntoView({
		behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
	});
}

export function InspirationPrompt({ prompt, selection }: LandingPromptSelectedDetail) {
	return (
		<button
			type="button"
			className="model-prompt-button"
			onClick={() => applyInspirationPrompt({ prompt, selection })}
		>
			Use this prompt <span aria-hidden="true">↗</span>
		</button>
	);
}
