"use client";

import type {
	EditorDraftInput,
	EditorProductKey,
	EditorRestoreNotice,
	EditorRestoreState,
} from "../lib/editor-recovery";
import { ImageEditorWorkspace } from "./editor/ImageEditorWorkspace";

export function CreatorWorkspace(props: {
	claimedDraft?: boolean;
	initialDraft?: EditorDraftInput | null;
	allowedProductKeys: EditorProductKey[];
	restoreState: EditorRestoreState;
	restoreNotice: EditorRestoreNotice;
	parentJobId?: string | null;
}) {
	return <ImageEditorWorkspace {...props} />;
}
