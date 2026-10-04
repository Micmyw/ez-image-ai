import { orpcClient } from "@shared/lib/orpc-client";

export const videoEffectsApi = orpcClient.videoEffects;
export type VideoEffectState = Awaited<ReturnType<typeof videoEffectsApi.jobs.get>>;
