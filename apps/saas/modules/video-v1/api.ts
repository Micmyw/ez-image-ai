import { orpcClient } from "@shared/lib/orpc-client";

export const videoApi = orpcClient.videoV1;
export type VideoCatalog = Awaited<ReturnType<typeof videoApi.catalog>>;
export type VideoState = Awaited<ReturnType<typeof videoApi.jobs.get>>;
export type VideoRequest = Parameters<typeof videoApi.quote>[0];
export type VideoQuote = Awaited<ReturnType<typeof videoApi.quote>>;
export type VideoCreateInput = Parameters<typeof videoApi.jobs.create>[0];
