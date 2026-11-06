import { rapAdaptiveRatio } from "./rap-catalog";
import { rapSongKind } from "./rap-composition";
import type { RapDraft } from "./rap-draft";

export type RapPromptStage = {
	prompt: string;
	defaultLyrics: readonly string[];
};

export type RapPromptCopy = {
	withPhotos: string;
	withoutPhotos: string;
	scene: string;
	song: string;
	occasion: string;
	content: string;
	defaultSong: string;
	customerSong: string;
	freestyleSong: string;
	performance: string;
	format: (duration: number, aspectRatio: string) => string;
};

export type RapComposerOptions = {
	// Pass the first preset when custom is selected; blank custom falls back to it.
	stage: RapPromptStage;
	customStage?: string;
	occasion?: string;
	copy: RapPromptCopy;
};

export function rapSongContent(draft: RapDraft, options: RapComposerOptions) {
	const content = draft.direction.trim();
	const occasion = options.occasion?.trim();
	const kind = rapSongKind(draft, options);
	return {
		kind,
		text:
			kind === "preset"
				? options.stage.defaultLyrics.join("\n")
				: [
						kind === "freestyle" && options.copy.freestyleSong,
						occasion && `${options.copy.occasion}: ${occasion}`,
						content && `${options.copy.content}: ${content}`,
					]
						.filter(Boolean)
						.join("\n"),
	};
}

/** The composer has one flow; validated photos determine the provider mode. */
export function rapPhotoSettings(draft: RapDraft, photos: File[]) {
	const mode = photos.length ? ("image" as const) : ("text" as const);
	return {
		photos,
		mode,
		aspectRatio: rapAdaptiveRatio(draft.modelId, mode)
			? ("adaptive" as const)
			: draft.aspectRatio === "adaptive"
				? ("9:16" as const)
				: draft.aspectRatio,
	};
}

/** Resolve each creative choice once; user content replaces the default lyrics. */
export function composeRapDraft(draft: RapDraft, options: RapComposerOptions): RapDraft {
	const photoSettings = rapPhotoSettings(draft, draft.photos);
	const song = rapSongContent(draft, options);
	const { copy } = options;
	const songInstructions =
		song.kind === "preset"
			? copy.defaultSong
			: song.kind === "customer"
				? copy.customerSong
				: undefined;
	return {
		...draft,
		...photoSettings,
		promptVersion: 1,
		direction: [
			draft.photos.length ? copy.withPhotos : copy.withoutPhotos,
			`${copy.scene}\n${options.customStage?.trim() || options.stage.prompt.trim()}`,
			`${copy.song}\n${[songInstructions, song.text].filter(Boolean).join("\n")}`,
			copy.format(draft.duration, photoSettings.aspectRatio),
			copy.performance,
		].join("\n\n"),
	};
}
