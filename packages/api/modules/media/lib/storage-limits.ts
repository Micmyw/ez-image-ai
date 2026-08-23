import { maximumMediaStorageBytes } from "@repo/config/server";

const DEFAULT_MAXIMUM_ACTIVE_UPLOAD_SESSIONS = 5;

export { maximumMediaStorageBytes };

export function mediaUploadLimits(environment: NodeJS.ProcessEnv = process.env) {
	return {
		maximumActiveSessions: positiveInteger(
			environment.MEDIA_MAX_ACTIVE_UPLOAD_SESSIONS,
			DEFAULT_MAXIMUM_ACTIVE_UPLOAD_SESSIONS,
		),
		maximumReservedBytes: maximumMediaStorageBytes(environment),
	};
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
