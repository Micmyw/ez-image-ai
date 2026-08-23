const DEFAULT_MAXIMUM_ACTIVE_UPLOAD_SESSIONS = 5;
const DEFAULT_MAXIMUM_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

export function mediaUploadLimits(environment: NodeJS.ProcessEnv = process.env) {
	return {
		maximumActiveSessions: positiveInteger(
			environment.MEDIA_MAX_ACTIVE_UPLOAD_SESSIONS,
			DEFAULT_MAXIMUM_ACTIVE_UPLOAD_SESSIONS,
		),
		maximumReservedBytes: maximumMediaStorageBytes(environment),
	};
}

/**
 * A deployment-wide owner cap shared by upload and generation admission. The
 * database transaction receives this value explicitly so it can enforce the
 * same limit under an owner-scoped advisory lock.
 */
export function maximumMediaStorageBytes(environment: NodeJS.ProcessEnv = process.env): bigint {
	return BigInt(
		positiveInteger(environment.MEDIA_MAX_STORAGE_BYTES, DEFAULT_MAXIMUM_STORAGE_BYTES),
	);
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
