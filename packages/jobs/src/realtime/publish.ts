import {
	acknowledgePublishedMediaJobNotification,
	type MediaJobNotification,
} from "@repo/database/media-job-notifications";
import { getRequestDefer } from "@repo/utils/request-lifecycle";

import { signRequest } from "../orchestration/auth";
import { getMediaJobEventsBinding, mediaJobEventsStub } from "./context";
import { MEDIA_JOB_EVENTS_PATH, readMediaJobNotification } from "./contracts";

type NotificationDatabase = Parameters<typeof acknowledgePublishedMediaJobNotification>[1];

/** Durable Outbox consumers retry when the hub did not confirm persistence. */
export async function deliverMediaJobNotification(
	payload: unknown,
	signal?: AbortSignal,
): Promise<void> {
	const notification = readMediaJobNotification(payload);
	const body = JSON.stringify(notification);
	const binding = getMediaJobEventsBinding();
	let response: Response;
	if (binding) {
		response = await mediaJobEventsStub(binding, notification.jobId).fetch(
			new Request("https://media-job-events.internal/publish", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
				signal,
			}),
		);
	} else {
		const secret = process.env.WORKFLOWS_DISPATCH_SECRET ?? "";
		const configuredUrl = process.env.WORKFLOWS_DISPATCH_URL;
		if (!configuredUrl || secret.length < 32) throw new Error("MEDIA_JOB_EVENTS_UNAVAILABLE");
		const url = new URL(MEDIA_JOB_EVENTS_PATH, configuredUrl);
		if (
			url.protocol !== "https:" &&
			!(process.env.NODE_ENV !== "production" && url.protocol === "http:")
		)
			throw new Error("MEDIA_JOB_EVENTS_INVALID_ORIGIN");
		response = await fetch(url, {
			method: "POST",
			headers: await signRequest(secret, "POST", MEDIA_JOB_EVENTS_PATH, body),
			body,
			redirect: "manual",
			signal: signal ?? AbortSignal.timeout(5_000),
		});
	}
	if (response.status !== 200) throw new Error("MEDIA_JOB_EVENTS_UNCONFIRMED");
	const receipt = (await response.json()) as { persisted?: unknown; eventId?: unknown };
	if (receipt.persisted !== true || receipt.eventId !== notification.eventId)
		throw new Error("MEDIA_JOB_EVENTS_UNCONFIRMED");
}

/** A failed fast path leaves the transaction's Outbox intent available for recovery. */
export async function publishCommittedMediaJobNotification(
	notification: MediaJobNotification,
	client?: NotificationDatabase,
): Promise<boolean> {
	if (process.env.MEDIA_JOB_EVENTS_ENABLED !== "true") return false;
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			deliverMediaJobNotification(notification, controller.signal),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					controller.abort();
					reject(new Error("MEDIA_JOB_EVENTS_FAST_PATH_TIMEOUT"));
				}, 250);
			}),
		]);
		await acknowledgePublishedMediaJobNotification(notification, client);
		return true;
	} catch {
		return false;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

/** Start after commit, and retain the publisher's ACK inside the request's DB lifetime. */
export async function publishCommittedMediaJobNotifications(
	notifications: readonly MediaJobNotification[],
	client?: NotificationDatabase,
): Promise<void> {
	if (!notifications.length || process.env.MEDIA_JOB_EVENTS_ENABLED !== "true") return;
	const publication = Promise.all(
		notifications.map((notification) => publishCommittedMediaJobNotification(notification, client)),
	);
	const defer = getRequestDefer();
	if (defer) {
		try {
			defer(publication);
			return;
		} catch {
			// Registration failed: keep the already-started publication and its DB work alive.
		}
	}
	await publication;
}
