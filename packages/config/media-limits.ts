const DEFAULT_MAXIMUM_MEDIA_STORAGE_BYTES = 2n * 1024n * 1024n * 1024n;

/**
 * One server-only deployment cap shared by upload admission, generation
 * admission, and generated-output finalization.
 */
export function maximumMediaStorageBytes(environment: NodeJS.ProcessEnv = process.env): bigint {
	const value = environment.MEDIA_MAX_STORAGE_BYTES;
	if (!value || !/^\d+$/u.test(value)) return DEFAULT_MAXIMUM_MEDIA_STORAGE_BYTES;
	const parsed = BigInt(value);
	return parsed > 0n ? parsed : DEFAULT_MAXIMUM_MEDIA_STORAGE_BYTES;
}
