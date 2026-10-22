import type {
	connectMediaJobEvents,
	JobEventsSocket,
} from "../../../apps/saas/modules/media/lib/job-events";

interface NativeSocket {
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number; reason?: string }) => void) | null;
	onerror: (() => void) | null;
	send(data: string): void;
	close(): void;
}

/** Observe the real product connector without replacing its reconnect/refresh behavior. */
export function connectScanlessJobNotifications(input: {
	connect: typeof connectMediaJobEvents;
	jobId: string;
	url: string;
	refresh(): Promise<unknown>;
	createWebSocket?(url: string): NativeSocket;
	onNotification(message: Record<string, unknown>): void;
	onProtocolFrame?(event: {
		direction: "sent" | "received";
		kind: "heartbeat" | "replay";
		message: Record<string, unknown>;
	}): void;
	onHealthChange?(healthy: boolean): void;
	onConnection(event: {
		type: "connect" | "close" | "error";
		code?: number;
		reason?: string;
	}): void;
}): () => void {
	return input.connect({
		jobId: input.jobId,
		url: input.url,
		refresh: () => input.refresh(),
		onHealthChange: (healthy) => input.onHealthChange?.(healthy),
		createSocket: (url) => {
			const native = input.createWebSocket ? input.createWebSocket(url) : new WebSocket(url);
			const socket: JobEventsSocket = {
				onmessage: null,
				onclose: null,
				onerror: null,
				send: (data) => {
					const message = JSON.parse(data) as Record<string, unknown>;
					if (message.type === "heartbeat")
						input.onProtocolFrame?.({ direction: "sent", kind: "heartbeat", message });
					native.send(data);
				},
				close: () => native.close(),
			};
			input.onConnection({ type: "connect" });
			native.onmessage = (event: { data: unknown }) => {
				if (typeof event.data === "string" && event.data.length <= 2_048) {
					try {
						const message = JSON.parse(event.data);
						if (
							message?.jobId === input.jobId &&
							(message.type === "ready" ||
								(message.type === "job-updated" &&
									typeof message.eventId === "string" &&
									/^mju_[a-f0-9]{64}$/.test(message.eventId)))
						)
							input.onNotification(message);
						if (message?.jobId === input.jobId && message.type === "heartbeat")
							input.onProtocolFrame?.({ direction: "received", kind: "heartbeat", message });
						if (
							message?.jobId === input.jobId &&
							message.latest &&
							(message.type === "ready" || message.type === "heartbeat")
						)
							input.onProtocolFrame?.({ direction: "received", kind: "replay", message });
					} catch {
						// The production connector remains responsible for rejecting bad hints.
					}
				}
				socket.onmessage?.({ data: event.data });
			};
			native.onclose = (event: { code: number; reason?: string }) => {
				input.onConnection({ type: "close", code: event.code, reason: event.reason });
				socket.onclose?.({ code: event.code });
			};
			native.onerror = () => {
				input.onConnection({ type: "error" });
				socket.onerror?.();
			};
			return socket;
		},
	});
}
