import { createInterface } from "node:readline";

import {
	adminRequest,
	commandArguments,
	redactTokens,
	resolveConnection,
} from "./admin-client.mjs";

// JSON-lines stdio transport. stdout belongs exclusively to MCP.
export async function startAdminMcp() {
	const { project, args } = commandArguments();
	if (args.length) throw new Error("Use only --project NAME for the stdio bridge.");
	const connection = await resolveConnection({ project });
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line.trim()) continue;
		let request;
		try {
			if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Input too large");
			request = JSON.parse(line);
		} catch {
			process.stdout.write(
				'{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON"}}\n',
			);
			continue;
		}
		if (
			!request ||
			typeof request !== "object" ||
			Array.isArray(request) ||
			request.jsonrpc !== "2.0" ||
			typeof request.method !== "string" ||
			("id" in request &&
				request.id !== null &&
				typeof request.id !== "string" &&
				!(typeof request.id === "number" && Number.isFinite(request.id)))
		) {
			process.stdout.write(
				'{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid request"}}\n',
			);
			continue;
		}
		try {
			const response = await adminRequest("/api/admin/agent/mcp", request, connection);
			if (!Object.hasOwn(request, "id")) continue;
			if (response.status !== 200 || response.result?.jsonrpc !== "2.0")
				throw new Error("Remote request failed");
			process.stdout.write(`${redactTokens(response.result)}\n`);
		} catch {
			if (!request || typeof request !== "object" || !Object.hasOwn(request, "id")) continue;
			process.stdout.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					error: {
						code: -32000,
						message:
							"Administration connection failed. A write may already have taken effect. Inspect its original execution and retain the same input and key.",
					},
				})}\n`,
			);
		}
	}
}

startAdminMcp().catch(() => {
	process.stderr.write(
		"Cannot start EzPic MCP. Select --project NAME and configure its management credential.\n",
	);
	process.exitCode = 1;
});
