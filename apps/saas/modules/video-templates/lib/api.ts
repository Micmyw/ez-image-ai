import { orpcClient } from "@shared/lib/orpc-client";

export const videoTemplatesApi = orpcClient.videoTemplates;
export type TemplateRequest = Parameters<typeof videoTemplatesApi.quote>[0];
export type TemplateQuote = Awaited<ReturnType<typeof videoTemplatesApi.quote>>;
export type TemplateState = Awaited<ReturnType<typeof videoTemplatesApi.jobs.get>>;
