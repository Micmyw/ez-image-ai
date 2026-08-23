import { redactForLog } from "./redaction";

export function sentryBeforeSend<T extends object>(event: T, release = deploymentRelease()): T {
	const scrubbed = redactForLog(event) as T & { fingerprint?: string[]; release?: string };
	if (!release) return scrubbed;
	return {
		...scrubbed,
		release: scrubbed.release ?? release,
		fingerprint: scrubbed.fingerprint ?? ["{{ default }}", release],
	} as T;
}

export function deploymentRelease(): string | undefined {
	return process.env.DEPLOYMENT_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? undefined;
}
