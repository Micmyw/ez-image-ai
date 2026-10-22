import type { MediaJobNotification } from "@repo/database/media-job-notifications";

export type { MediaJobNotification } from "@repo/database/media-job-notifications";

export const MEDIA_JOB_EVENTS_PATH = "/internal/job-events";
export const MEDIA_JOB_SUBSCRIPTION_TTL_MS = 60_000;
export const MEDIA_JOB_EVENTS_PROTOCOL = 2;
// Transport health is independent of the browser's 2-second authoritative read.
// Five-second heartbeats repair missed broadcasts without adding database work.
export const MEDIA_JOB_HEARTBEAT_INTERVAL_MS = 5_000;
export const MEDIA_JOB_HEARTBEAT_TIMEOUT_MS = 2_000;

export interface MediaJobEventsHeartbeat {
	type: "heartbeat";
	nonce: number;
	cursor: string | null;
}

export function readMediaJobHeartbeat(value: unknown): MediaJobEventsHeartbeat {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("INVALID_MEDIA_JOB_HEARTBEAT");
	const message = value as Partial<MediaJobEventsHeartbeat>;
	if (
		message.type !== "heartbeat" ||
		!Number.isSafeInteger(message.nonce) ||
		message.nonce! <= 0 ||
		(message.cursor !== null &&
			(typeof message.cursor !== "string" || !/^mju_[a-f0-9]{64}$/.test(message.cursor)))
	)
		throw new Error("INVALID_MEDIA_JOB_HEARTBEAT");
	return { type: "heartbeat", nonce: message.nonce!, cursor: message.cursor! };
}

export function readMediaJobNotification(value: unknown): MediaJobNotification {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("INVALID_MEDIA_JOB_NOTIFICATION");
	const notification = value as Partial<MediaJobNotification>;
	if (
		typeof notification.eventId !== "string" ||
		!/^mju_[a-f0-9]{64}$/.test(notification.eventId) ||
		typeof notification.jobId !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(notification.jobId) ||
		typeof notification.version !== "string" ||
		!notification.version ||
		notification.version.length > 256
	)
		throw new Error("INVALID_MEDIA_JOB_NOTIFICATION");
	// Deliberately discard unexpected fields. No private URLs or provider payloads leave the hub.
	return {
		eventId: notification.eventId,
		jobId: notification.jobId,
		version: notification.version,
	};
}
