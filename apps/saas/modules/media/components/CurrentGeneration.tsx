"use client";

import { EditorResultPanel } from "./editor/EditorResultPanel";

export function CurrentGeneration({ jobId, onNew }: { jobId: string | null; onNew: () => void }) {
	return <EditorResultPanel jobId={jobId} onNew={onNew} />;
}
