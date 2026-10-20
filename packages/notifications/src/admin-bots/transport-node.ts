import { lookup } from "node:dns/promises";
import { request } from "node:https";

import type { BotPostJson } from "./types";
import { isPublicBotAddress } from "./url-policy";

export const postBotJson: BotPostJson = async (url, body, headers) => {
	const addresses = await Promise.race([
		lookup(url.hostname, { all: true, verbatim: true }),
		new Promise<never>((_, reject) => {
			const timer = setTimeout(() => reject(new Error("ADMIN_BOT_DNS_TIMEOUT")), 5_000);
			timer.unref();
		}),
	]);
	if (!addresses.length || addresses.some(({ address }) => !isPublicBotAddress(address)))
		throw new Error("ADMIN_BOT_PRIVATE_ADDRESS");
	const payload = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				method: "POST",
				headers: {
					...headers,
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
				},
				// Resolve once and pin: a DNS rebinding between validation and connection
				// cannot send a bot credential to a private address.
				lookup: (_hostname, options, callback) => {
					const selected = options.family
						? addresses.filter((item) => item.family === options.family)
						: addresses;
					if (!selected.length) return callback(new Error("ADMIN_BOT_DNS_FAMILY"), "", 4);
					if (options.all) callback(null, selected);
					else callback(null, selected[0]!.address, selected[0]!.family);
				},
			},
			(response) => {
				const status = response.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					response.resume();
					reject(new Error(`ADMIN_BOT_HTTP_${status}`));
					return;
				}
				let bytes = 0;
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => {
					bytes += chunk.byteLength;
					if (bytes > 16_384) req.destroy(new Error("ADMIN_BOT_RESPONSE_TOO_LARGE"));
					else chunks.push(chunk);
				});
				response.on("error", () => reject(new Error("ADMIN_BOT_NETWORK_ERROR")));
				response.on("end", () => {
					clearTimeout(timer);
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch {
						resolve(null);
					}
				});
			},
		);
		const timer = setTimeout(() => req.destroy(new Error("ADMIN_BOT_TIMEOUT")), 8_000);
		req.on("error", () => {
			clearTimeout(timer);
			reject(new Error("ADMIN_BOT_NETWORK_ERROR"));
		});
		req.on("close", () => clearTimeout(timer));
		// HTTPS request does not follow Location. A redirect is an HTTP failure.
		req.end(payload);
	});
};
