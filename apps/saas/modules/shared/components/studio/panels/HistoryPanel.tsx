"use client";

import { JobHistory } from "@media/components/JobHistory";

import type { StudioPanelProps } from "../StudioPanels";

export function HistoryPanel({ onChange }: StudioPanelProps) {
	return <JobHistory embedded onSelect={(jobId) => onChange({ kind: "history", jobId })} />;
}
