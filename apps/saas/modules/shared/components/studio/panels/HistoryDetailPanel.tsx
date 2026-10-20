"use client";

import { EditorResultPanel } from "@media/components/editor/EditorResultPanel";
import { Button } from "@repo/ui/components/button";
import { ArrowLeftIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import type { StudioPanelProps } from "../StudioPanels";

export function HistoryDetailPanel({ panel, onChange, onClose }: StudioPanelProps) {
	const detail = useTranslations("media.detail");
	if (!panel.jobId) return null;
	return (
		<div>
			<Button
				type="button"
				className="mb-4"
				variant="secondary"
				onClick={() => onChange({ kind: "history" })}
			>
				<ArrowLeftIcon className="size-4" aria-hidden="true" />
				{detail("back")}
			</Button>
			<EditorResultPanel jobId={panel.jobId} onNew={onClose} />
		</div>
	);
}
