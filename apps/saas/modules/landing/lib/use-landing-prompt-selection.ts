"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { generatorModeUrl } from "../../media/lib/generator-navigation";
import {
	LANDING_PROMPT_SELECTED_EVENT,
	type LandingPromptSelectedDetail,
} from "./prompt-selection";

function focusImageEditor() {
	const editor = document.getElementById("image-editor");
	editor
		?.querySelector<HTMLTextAreaElement>('[data-generator-panel="image"] textarea')
		?.focus({ preventScroll: true });
	editor?.scrollIntoView({
		behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
		block: "start",
	});
}

/** Apply an idea only when the mounted editor acknowledges it; otherwise use its normal link. */
export function useLandingPromptSelection() {
	const mode = useSearchParams().get("mode") === "video" ? "video" : "image";
	const focusAfterSwitch = useRef(false);
	useEffect(() => {
		if (mode !== "image" || !focusAfterSwitch.current) return;
		focusAfterSwitch.current = false;
		const frame = requestAnimationFrame(focusImageEditor);
		return () => cancelAnimationFrame(frame);
	}, [mode]);
	return (prompt: string) => {
		const selection = new CustomEvent<LandingPromptSelectedDetail>(LANDING_PROMPT_SELECTED_EVENT, {
			cancelable: true,
			detail: { prompt },
		});
		if (window.dispatchEvent(selection)) return false;
		if (mode === "video") {
			focusAfterSwitch.current = true;
			window.history.pushState(null, "", generatorModeUrl(window.location.href, "image"));
		} else requestAnimationFrame(focusImageEditor);
		return true;
	};
}
