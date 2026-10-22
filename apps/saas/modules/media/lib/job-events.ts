import {
	MEDIA_JOB_EVENTS_PROTOCOL,
	MEDIA_JOB_HEARTBEAT_INTERVAL_MS,
	MEDIA_JOB_HEARTBEAT_TIMEOUT_MS,
	MEDIA_JOB_SUBSCRIPTION_TTL_MS,
	readMediaJobNotification,
} from "@repo/jobs/realtime/contracts";

export interface JobEventsSocket {
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number }) => void) | null;
	onerror: (() => void) | null;
	send(data: string): void;
	close(): void;
}

/** Notifications are hints to refresh authorized state, never result data.
 * Transport health cannot prove publication from PostgreSQL succeeded. Callers
 * must retain the independent 2-second active-job database polling fallback.
 */
export function connectMediaJobEvents(input: {
	jobId: string;
	url: string;
	refresh(): Promise<unknown>;
	onHealthChange?(healthy: boolean): void;
	createSocket?(url: string): JobEventsSocket;
}): () => void {
	let closed = false;
	let socket: JobEventsSocket | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let heartbeat: ReturnType<typeof setTimeout> | undefined;
	let responseDeadline: ReturnType<typeof setTimeout> | undefined;
	let ticketExpiry: ReturnType<typeof setTimeout> | undefined;
	let handshakeDeadline: ReturnType<typeof setTimeout> | undefined;
	let ticketDeadline = Infinity;
	let failures = 0;
	let generation = 0;
	let nonce = 0;
	let pendingNonce: number | undefined;
	let protocol = false;
	let readySeen = false;
	let connectionReadRequested = false;
	let synchronized = false;
	let heartbeatConfirmed = false;
	let healthy = false;
	let refreshTask: Promise<void> | undefined;
	let refreshAgain = false;
	let cursor: string | null = null;
	const seen = new Set<string>();
	const setHealth = (value: boolean) => {
		if (healthy === value) return;
		healthy = value;
		input.onHealthChange?.(value);
	};
	const updateHealth = () =>
		setHealth(Boolean(!closed && socket && protocol && synchronized && heartbeatConfirmed));
	const refresh = () => {
		refreshAgain = true;
		if (refreshTask) return;
		// One synchronous ready/replay burst needs one fresh read. A distinct commit
		// arriving after that read starts still schedules a subsequent read.
		refreshTask = Promise.resolve().then(async () => {
			try {
				while (refreshAgain && !closed) {
					refreshAgain = false;
					const readingGeneration = generation;
					try {
						await input.refresh();
						if (readingGeneration === generation && socket) synchronized = !refreshAgain;
					} catch {
						if (readingGeneration === generation) synchronized = false;
						// The independent query fallback retries errors; an unsuccessful
						// read must never certify a synchronized healthy connection.
					}
					updateHealth();
				}
			} finally {
				refreshTask = undefined;
			}
		});
	};
	const requestRead = () => {
		connectionReadRequested = true;
		synchronized = false;
		updateHealth();
		refresh();
	};
	const observe = (value: unknown): boolean => {
		const notification = readMediaJobNotification(value);
		if (notification.jobId !== input.jobId) throw new Error("JOB_MISMATCH");
		if (seen.has(notification.eventId)) return false;
		seen.add(notification.eventId);
		cursor = notification.eventId;
		if (seen.size > 64) seen.delete(seen.values().next().value!);
		return true;
	};
	const clearConnectionTimers = () => {
		clearTimeout(heartbeat);
		clearTimeout(responseDeadline);
		clearTimeout(ticketExpiry);
		clearTimeout(handshakeDeadline);
		heartbeat = responseDeadline = ticketExpiry = handshakeDeadline = undefined;
		pendingNonce = undefined;
	};
	const scheduleReconnect = (reauthenticate = false) => {
		if (closed || retry !== undefined) return;
		const delay = reauthenticate ? 0 : Math.min(1_000 * 2 ** Math.min(failures++, 5), 30_000);
		retry = setTimeout(() => {
			retry = undefined;
			connect();
		}, delay);
	};
	const loseConnection = (current: JobEventsSocket, reauthenticate = false) => {
		if (closed || socket !== current) return;
		current.onmessage = current.onclose = current.onerror = null;
		socket = undefined;
		clearConnectionTimers();
		synchronized = heartbeatConfirmed = false;
		setHealth(false);
		current.close();
		if (connectionReadRequested) refresh();
		scheduleReconnect(reauthenticate);
	};
	const readTicket = (message: Record<string, unknown>, current: JobEventsSocket) => {
		if (
			message.protocol !== MEDIA_JOB_EVENTS_PROTOCOL ||
			!Number.isSafeInteger(message.expiresAt) ||
			(message.expiresAt as number) <= 0 ||
			!Number.isSafeInteger(message.expiresInMs) ||
			(message.expiresInMs as number) <= 0 ||
			(message.expiresInMs as number) > MEDIA_JOB_SUBSCRIPTION_TTL_MS
		)
			throw new Error("INVALID_SUBSCRIPTION_TICKET");
		// Heartbeats may shorten but never renew the authenticated ticket. Only a
		// new HTTP upgrade through the owner/session checks can renew it.
		ticketDeadline = Math.min(ticketDeadline, performance.now() + (message.expiresInMs as number));
		clearTimeout(ticketExpiry);
		ticketExpiry = setTimeout(
			() => loseConnection(current, true),
			Math.max(0, ticketDeadline - performance.now()),
		);
	};
	const sendHeartbeat = (current: JobEventsSocket) => {
		if (closed || socket !== current || !protocol) return;
		pendingNonce = ++nonce;
		responseDeadline = setTimeout(() => loseConnection(current), MEDIA_JOB_HEARTBEAT_TIMEOUT_MS);
		try {
			current.send(JSON.stringify({ type: "heartbeat", nonce: pendingNonce, cursor }));
		} catch {
			loseConnection(current);
		}
	};
	const connect = () => {
		if (closed) return;
		let current: JobEventsSocket;
		generation += 1;
		protocol = readySeen = connectionReadRequested = synchronized = heartbeatConfirmed = false;
		ticketDeadline = Infinity;
		try {
			const url = new URL(input.url);
			url.searchParams.set("protocol", String(MEDIA_JOB_EVENTS_PROTOCOL));
			current = input.createSocket
				? input.createSocket(url.toString())
				: createBrowserSocket(url.toString());
			socket = current;
		} catch {
			scheduleReconnect();
			return;
		}
		handshakeDeadline = setTimeout(() => loseConnection(current), 10_000);
		current.onmessage = (event) => {
			if (
				closed ||
				socket !== current ||
				typeof event.data !== "string" ||
				event.data.length > 2_048
			)
				return;
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			if (!message || message.jobId !== input.jobId) return;
			try {
				if (message.type === "ready") {
					if (readySeen) return;
					if (message.protocol === MEDIA_JOB_EVENTS_PROTOCOL) {
						readTicket(message, current);
						const changed = message.latest === null ? false : observe(message.latest);
						protocol = true;
						if (changed || !connectionReadRequested) requestRead();
						sendHeartbeat(current);
					} else if (!connectionReadRequested) requestRead();
					readySeen = true;
					failures = 0;
					clearTimeout(handshakeDeadline);
				} else if (message.type === "job-updated") {
					if (observe(message)) requestRead();
				} else if (
					message.type === "heartbeat" &&
					protocol &&
					pendingNonce !== undefined &&
					message.nonce === pendingNonce
				) {
					readTicket(message, current);
					const changed = message.latest === null ? false : observe(message.latest);
					clearTimeout(responseDeadline);
					pendingNonce = undefined;
					heartbeatConfirmed = true;
					if (changed) requestRead();
					updateHealth();
					heartbeat = setTimeout(() => sendHeartbeat(current), MEDIA_JOB_HEARTBEAT_INTERVAL_MS);
				}
			} catch {
				// Malformed hints cannot authorize output or renew health. The independent
				// database poll remains active, including against an old protocol server.
			}
		};
		current.onclose = (event) => loseConnection(current, event.code === 4001);
		current.onerror = () => loseConnection(current);
	};
	connect();
	return () => {
		closed = true;
		refreshAgain = false;
		clearTimeout(retry);
		clearConnectionTimers();
		setHealth(false);
		if (socket) {
			socket.onmessage = socket.onclose = socket.onerror = null;
			socket.close();
		}
	};
}

function createBrowserSocket(url: string): JobEventsSocket {
	const transport = new WebSocket(url);
	const socket: JobEventsSocket = {
		onmessage: null,
		onclose: null,
		onerror: null,
		send: (data) => transport.send(data),
		close: () => transport.close(),
	};
	transport.onmessage = (event) => socket.onmessage?.({ data: event.data });
	transport.onclose = (event) => socket.onclose?.({ code: event.code });
	transport.onerror = () => socket.onerror?.();
	return socket;
}
