"use client";

import dynamic from "next/dynamic";

import type {
	EditorDraftInput,
	EditorProductKey,
	EditorRestoreNotice,
	EditorRestoreState,
} from "../lib/editor-recovery";

// Keep this split inside a client boundary so importing the server-side
// RegisteredEditor does not add the signed-in editor to a visitor's bundle.
const ImageEditorWorkspace = dynamic(() =>
	import("./editor/ImageEditorWorkspace").then((module) => module.ImageEditorWorkspace),
);

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
