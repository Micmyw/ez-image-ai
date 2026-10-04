/** These credentials and switches must not enter either deployed runtime. */
export const retiredModerationBindings = [
	"SIGHTENGINE_API_USER",
	"SIGHTENGINE_API_SECRET",
	"MODERATION_TEXT_SIGHTENGINE_ENABLED",
	"MODERATION_IMAGE_SIGHTENGINE_ENABLED",
	"VIDEO_V1_MODERATION_WEBHOOK_SECRET",
	"VIDEO_V1_MODERATION_CALLBACK_CONFIGURED",
	"VIDEO_AUDIO_SAFETY_ADAPTER",
	"OPENAI_AUDIO_MODERATION_API_KEY",
	"OPENAI_AUDIO_TRANSCRIPTION_MODEL",
] as const;

const retired = new Set<string>(retiredModerationBindings);

export function isRetiredModerationBinding(key: string): boolean {
	return retired.has(key);
}
