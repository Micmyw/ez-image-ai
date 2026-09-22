import type { EditorDraftInput } from "./editor-recovery";
import type { TemporaryReferenceReceipt } from "./temporary-reference-upload";

export interface EditorWorkspaceState {
	temporaryReference?: TemporaryReferenceReceipt;
	parentJobId: string | null;
	initialDraft: EditorDraftInput | null;
	formKey: number;
	recoveryVisible: boolean;
}

export function beginNewEditorWorkspaceState(state: EditorWorkspaceState): EditorWorkspaceState {
	return {
		parentJobId: null,
		initialDraft: null,
		formKey: state.formKey + 1,
		recoveryVisible: false,
	};
}
