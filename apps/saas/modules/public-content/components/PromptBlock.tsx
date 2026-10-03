"use client";

import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

export function PromptBlock({
	prompt,
	title,
	onCopied,
}: {
	prompt: string;
	title?: string;
	onCopied?: () => void;
}) {
	const t = useTranslations();
	const id = useId();
	const promptRef = useRef<HTMLPreElement>(null);
	const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
	async function copy() {
		try {
			if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(prompt);
		} catch {
			setStatus("failed");
			return;
		}
		setStatus("copied");
		onCopied?.();
	}
	function selectPrompt() {
		if (!promptRef.current) return;
		const range = document.createRange();
		range.selectNodeContents(promptRef.current);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		promptRef.current.focus();
	}
	return (
		<div className="my-6 min-w-0 border-violet-300/20 bg-violet-300/5 p-4 sm:p-5 rounded-2xl border">
			<div className="mb-3 gap-3 flex flex-wrap items-center justify-between">
				<p id={`${id}-label`} className="m-0 text-sm font-semibold text-violet-100">
					{title ?? t("guides.promptLabel")}
				</p>
				<button
					type="button"
					onClick={copy}
					aria-describedby={`${id}-status`}
					className="min-h-11 border-violet-300/30 px-3 py-2 text-sm font-medium text-violet-100 hover:bg-violet-300/10 focus-visible:outline-violet-300 rounded-lg border focus-visible:outline-2 focus-visible:outline-offset-2"
				>
					{status === "copied" ? t("guides.copied") : t("guides.copyPrompt")}
				</button>
			</div>
			<pre
				ref={promptRef}
				tabIndex={-1}
				aria-labelledby={`${id}-label`}
				className="m-0 font-sans text-base leading-7 text-slate-200 focus-visible:outline-violet-300 max-w-full [overflow-wrap:anywhere] break-words whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-offset-4"
			>
				{prompt}
			</pre>
			<output
				id={`${id}-status`}
				aria-live="polite"
				className="mt-2 text-sm leading-6 text-violet-200 block"
			>
				{status === "copied"
					? t("guides.copied")
					: status === "failed"
						? t("guides.copyFailed")
						: ""}
			</output>
			{status === "failed" && (
				<button
					type="button"
					onClick={selectPrompt}
					className="min-h-11 px-3 py-2 text-sm text-violet-100 focus-visible:outline-violet-300 rounded-lg underline underline-offset-4 focus-visible:outline-2"
				>
					{t("guides.selectPrompt")}
				</button>
			)}
		</div>
	);
}
