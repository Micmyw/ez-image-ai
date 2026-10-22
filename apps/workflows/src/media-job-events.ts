import { readBoundedBody } from "@repo/jobs/orchestration/auth";
import {
	MEDIA_JOB_SUBSCRIPTION_TTL_MS,
	MEDIA_JOB_EVENTS_PROTOCOL,
	readMediaJobHeartbeat,
	readMediaJobNotification,
	type MediaJobNotification,
} from "@repo/jobs/realtime/contracts";
import { DurableObject } from "cloudflare:workers";

type HubState = { jobId: string; latest?: MediaJobNotification; recent: string[] };
type Subscription = {
	jobId: string;
	expiresAt: number;
	protocol?: number;
	lastHeartbeatAt?: number;
	lastNonce?: number;
};
const STATE_KEY = "notification-state";
const MAX_SUBSCRIBERS = 16;

/** Identity hints only. Business state and authorization always remain in PostgreSQL. */
export class MediaJobEvents extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/subscribe")
			return this.subscribe(request, url);
		if (request.method === "POST" && url.pathname === "/publish") {
			let notification: MediaJobNotification;
			try {
				notification = readMediaJobNotification(JSON.parse(await readBoundedBody(request, 2_048)));
			} catch {
				return new Response("Invalid notification", { status: 400 });
			}
			const accepted = await this.ctx.storage.transaction(async (transaction) => {
				const previous = await transaction.get<HubState>(STATE_KEY);
				if (previous && previous.jobId !== notification.jobId) return false;
				if (!previous?.recent.includes(notification.eventId)) {
					// Persist atomically before sending or confirming. A concurrent subscription
					// must not replace a just-committed notification with its initial empty state.
					await transaction.put<HubState>(STATE_KEY, {
						jobId: notification.jobId,
						latest: notification,
						recent: [...(previous?.recent ?? []), notification.eventId].slice(-64),
					});
				}
				return true;
			});
			if (!accepted) return new Response("Job mismatch", { status: 409 });
			// Even a replay can repair a crash after persistence and before the first broadcast.
			const message = JSON.stringify({ type: "job-updated", ...notification });
			for (const socket of this.ctx.getWebSockets()) {
				if (!this.isCurrent(socket)) continue;
				try {
					socket.send(message);
				} catch {
					socket.close(1011, "Reconnect");
				}
			}
			return Response.json({ persisted: true, eventId: notification.eventId });
		}
		return new Response("Not found", { status: 404 });
	}

	private async subscribe(request: Request, url: URL): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
			return new Response("WebSocket required", { status: 426 });
		const jobId = url.searchParams.get("jobId") ?? "";
		const expiresAt = Number(url.searchParams.get("expiresAt"));
		if (
			!/^[A-Za-z0-9_-]{1,128}$/.test(jobId) ||
			!Number.isSafeInteger(expiresAt) ||
			expiresAt <= Date.now() ||
			expiresAt > Date.now() + MEDIA_JOB_SUBSCRIPTION_TTL_MS
		)
			return new Response("Invalid subscription", { status: 400 });
		const accepted = await this.ctx.storage.transaction(async (transaction) => {
			const previous = await transaction.get<HubState>(STATE_KEY);
			if (previous && previous.jobId !== jobId) return false;
			if (!previous) await transaction.put<HubState>(STATE_KEY, { jobId, recent: [] });
			return true;
		});
		if (!accepted) return new Response("Job mismatch", { status: 409 });
		const active = this.ctx.getWebSockets().filter((socket) => this.isCurrent(socket));
		if (active.length >= MAX_SUBSCRIBERS)
			return new Response("Subscription capacity", { status: 429 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		const protocol = url.searchParams.get("protocol") === String(MEDIA_JOB_EVENTS_PROTOCOL);
		const subscription = {
			jobId,
			expiresAt,
			...(protocol ? { protocol: MEDIA_JOB_EVENTS_PROTOCOL } : {}),
		} satisfies Subscription;
		server.serializeAttachment(subscription);
		// Always refresh on connect, including when the job committed before subscription.
		// In v2 the persisted hint shares the handshake frame: ready + replay must not
		// force two full authorized reads. Read after accepting to cover racing publishes.
		if (protocol) {
			const state = await this.ctx.storage.get<HubState>(STATE_KEY);
			if (this.isCurrent(server))
				server.send(JSON.stringify({ type: "ready", ...this.replay(subscription, state) }));
		} else server.send(JSON.stringify({ type: "ready", jobId }));
		await this.ctx.storage.transaction(async (transaction) => {
			const alarm = await transaction.getAlarm();
			if (alarm === null || alarm > expiresAt) await transaction.setAlarm(expiresAt);
		});
		return new Response(null, { status: 101, webSocket: client });
	}

	private isCurrent(socket: WebSocket): boolean {
		const subscription = socket.deserializeAttachment() as Subscription | null;
		if (!subscription || subscription.expiresAt <= Date.now()) {
			socket.close(4001, "Reauthenticate");
			return false;
		}
		return true;
	}

	async alarm(): Promise<void> {
		let nextExpiry = Infinity;
		for (const socket of this.ctx.getWebSockets()) {
			if (this.isCurrent(socket))
				nextExpiry = Math.min(
					nextExpiry,
					(socket.deserializeAttachment() as Subscription).expiresAt,
				);
		}
		if (Number.isFinite(nextExpiry)) await this.ctx.storage.setAlarm(nextExpiry);
	}

	private replay(subscription: Subscription, state: HubState | undefined) {
		return {
			protocol: MEDIA_JOB_EVENTS_PROTOCOL,
			jobId: subscription.jobId,
			expiresAt: subscription.expiresAt,
			// A duration avoids interpreting server wall time using the browser's clock.
			expiresInMs: Math.max(0, subscription.expiresAt - Date.now()),
			latest: state?.jobId === subscription.jobId ? (state.latest ?? null) : null,
		};
	}

	async webSocketMessage(socket: WebSocket, value: string | ArrayBuffer): Promise<void> {
		if (!this.isCurrent(socket)) return;
		const subscription = socket.deserializeAttachment() as Subscription;
		try {
			if (
				subscription.protocol !== MEDIA_JOB_EVENTS_PROTOCOL ||
				typeof value !== "string" ||
				value.length > 256
			)
				throw new Error("INVALID_MEDIA_JOB_HEARTBEAT");
			const message = readMediaJobHeartbeat(JSON.parse(value));
			const now = Date.now();
			if (
				message.nonce <= (subscription.lastNonce ?? 0) ||
				(subscription.lastHeartbeatAt !== undefined && now - subscription.lastHeartbeatAt < 1_000)
			)
				throw new Error("INVALID_MEDIA_JOB_HEARTBEAT");
			subscription.lastHeartbeatAt = now;
			subscription.lastNonce = message.nonce;
			socket.serializeAttachment(subscription);
			const state = await this.ctx.storage.get<HubState>(STATE_KEY);
			if (this.isCurrent(socket))
				socket.send(
					JSON.stringify({
						type: "heartbeat",
						nonce: message.nonce,
						...this.replay(subscription, state),
					}),
				);
		} catch {
			// A cursor is only a replay hint. Clients cannot publish, renew their
			// authorization ticket, choose another owner/job, or mutate business state.
			socket.close(1008, "Invalid heartbeat");
		}
	}

	webSocketClose(socket: WebSocket, code: number): void {
		socket.close(code);
	}
	webSocketError(socket: WebSocket): void {
		socket.close(1011, "Reconnect");
	}
}
