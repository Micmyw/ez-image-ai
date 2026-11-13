"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useEffect } from "react";

import type { EditorProductKey } from "../lib/editor-recovery";
import { scheduleReferencePromptSave } from "../lib/reference-prompt-save";

export function useReferencePromptCapture({
	ownerId,
	assetId,
	productKey,
	prompt,
	enabled,
}: {
	ownerId: string | null;
	assetId: string;
	productKey: EditorProductKey;
	prompt: string;
	enabled: boolean;
}) {
	useEffect(() => {
		if (!enabled || !ownerId || !assetId || !prompt.trim() || prompt.length > 10_000) return;
		return scheduleReferencePromptSave({ assetId, productKey, prompt }, (input, signal) =>
			orpcClient.media.saveReferencePrompt(input, { signal }),
		);
	}, [ownerId, assetId, productKey, prompt, enabled]);
}
