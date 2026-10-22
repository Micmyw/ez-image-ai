import pg from "pg";
import { CloudflareSocket } from "pg-cloudflare";

import { measureQueries, summarize } from "./pg-cloudflare-queries.mjs";

class InstrumentedSocket extends CloudflareSocket {
	probe = { writerCalls: 0, writerBytes: 0, maxBufferedBytes: 0, maxBufferedFrames: 0 };

	_addClosedHandler() {
		super._addClosedHandler();
		const writer = this._cfWriter;
		const write = writer.write.bind(writer);
		writer.write = (bytes) => {
			this.probe.writerCalls++;
			this.probe.writerBytes += bytes.byteLength;
			return write(bytes);
		};
	}

	write(...args) {
		const result = super.write(...args);
		this.probe.maxBufferedBytes = Math.max(this.probe.maxBufferedBytes, this._corkBytes);
		this.probe.maxBufferedFrames = Math.max(this.probe.maxBufferedFrames, this._corkBuffers.length);
		return result;
	}
}

export default {
	async fetch(request, env) {
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
		const input = await request.json();
		if (
			!["cork-disabled", "installed"].includes(input.variant) ||
			!Number.isInteger(input.repeats) ||
			input.repeats < 1 ||
			input.repeats > 40
		) {
			return new Response("Invalid probe", { status: 400 });
		}
		const socket = new InstrumentedSocket(false);
		if (input.variant === "cork-disabled") {
			// Isolate coalescing using the same installed class and completion handling.
			// This baseline is deliberately not described as an unpatched dependency.
			socket.cork = undefined;
			socket.uncork = undefined;
		}
		const client = new pg.Client({
			connectionString: env.HYPERDRIVE.connectionString,
			stream: socket,
			ssl: false,
			application_name: `ezpic-pg-socket-${input.variant}`,
			options:
				"-c default_transaction_read_only=on -c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000",
			connectionTimeoutMillis: 5000,
			query_timeout: 10000,
		});
		const connectStarted = performance.now();
		try {
			await client.connect();
			const connectMs = performance.now() - connectStarted;
			const result = await measureQueries(client, input.repeats, () => ({ ...socket.probe }));
			return Response.json({
				variant: input.variant,
				connectMs,
				...result,
				summary: summarize(result.samples),
				socket: { hasCork: typeof socket.cork === "function", ...socket.probe },
				runtime: { userAgent: navigator.userAgent },
			});
		} catch (error) {
			return Response.json(
				{ error: { message: error.message, code: error.code }, socket: socket.probe },
				{ status: 500 },
			);
		} finally {
			await client.end();
		}
	},
};
