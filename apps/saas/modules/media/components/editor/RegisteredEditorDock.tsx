"use client";

import { useJob } from "@media/hooks/use-job";
import { getJobPresentation } from "@media/lib/job-status";
import { ArrowUpIcon, ImageIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export function RegisteredEditorDock({ prompt, jobId }: { prompt: string; jobId: string | null }) {
	const t = useTranslations("studio");
	const stages = useTranslations("media.status.stages");
	const job = useJob(jobId);
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const editor = document.getElementById("registered-generator");
		if (!editor || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(([entry]) => {
			setVisible(Boolean(entry && !entry.isIntersecting && entry.boundingClientRect.bottom < 0));
		});
		observer.observe(editor);
		return () => observer.disconnect();
	}, []);
	if (!visible) return null;
	function returnToEditor(result: boolean) {
		const element = document.getElementById(result ? "current-editor-result" : "generation-prompt");
		element?.scrollIntoView({
			block: "center",
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
		});
		if (element instanceof HTMLElement) element.focus({ preventScroll: true });
	}
	return (
		<aside className="studio-dock" aria-label={t("dock.label")} data-test="registered-editor-dock">
			<ImageIcon className="ml-2 size-5 text-violet-300 shrink-0" aria-hidden />
			<button
				type="button"
				className="min-h-11 min-w-0 px-2 text-sm flex-1 truncate rounded-lg text-left"
				onClick={() => returnToEditor(false)}
				aria-label={t("dock.return")}
			>
				{prompt || t("dock.placeholder")}
			</button>
			{jobId && (
				<button
					type="button"
					className="min-h-11 px-3 text-xs text-violet-200 shrink-0 rounded-lg"
					onClick={() => returnToEditor(true)}
					aria-label={t("dock.result")}
				>
					<output>{job.data ? stages(getJobPresentation(job.data).stage) : t("loading")}</output>
				</button>
			)}
			<button
				type="button"
				className="studio-icon bg-primary text-primary-foreground"
				onClick={() => returnToEditor(false)}
				aria-label={t("dock.return")}
			>
				<ArrowUpIcon />
			</button>
		</aside>
	);
}
