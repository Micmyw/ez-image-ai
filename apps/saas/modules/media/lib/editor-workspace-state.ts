import type { EditorDraftInput } from "./editor-recovery";

export interface EditorWorkspaceState {
	jobId: string | null;
	parentJobId: string | null;
	initialDraft: EditorDraftInput | null;
	formKey: number;
	recoveryVisible: boolean;
}

export function beginNewEditorWorkspaceState(state: EditorWorkspaceState): EditorWorkspaceState {
	return {
		jobId: null,
		parentJobId: null,
		initialDraft: null,
		formKey: state.formKey + 1,
		recoveryVisible: false,
	};
}
