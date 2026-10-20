import { AdminAccessError } from "@repo/database/admin-access";
import { z } from "zod";

import { AdminGatewayError } from "./types";

export function privateAdminResponse(value: unknown, status = 200, headers?: HeadersInit) {
	const response = Response.json(value, { status, headers });
	response.headers.set("Cache-Control", "private, no-store");
	response.headers.set("X-Robots-Tag", "noindex, nofollow");
	response.headers.set("Vary", "Authorization, Cookie");
	return response;
}

export function adminErrorDetails(error: unknown) {
	if (error instanceof z.ZodError)
		return {
			code: "ADMIN_INPUT_INVALID",
			message: "Input does not match the operation schema.",
			status: 400,
		};
	if (error instanceof AdminGatewayError || error instanceof AdminAccessError)
		return {
			code: error.code,
			message: error.message,
			status: error.status,
			...(error instanceof AdminGatewayError && error.executionId
				? { executionId: error.executionId }
				: {}),
		};
	return { code: "ADMIN_UNAVAILABLE", message: "Administration is unavailable.", status: 503 };
}

export function adminErrorResponse(error: unknown) {
	const { status, ...detail } = adminErrorDetails(error);
	return privateAdminResponse(
		{ error: detail },
		status,
		status === 401 ? { "WWW-Authenticate": 'Bearer realm="ezpic-admin"' } : undefined,
	);
}

export async function readAdminJson(request: Request): Promise<unknown> {
	if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
		throw new AdminGatewayError("ADMIN_JSON_REQUIRED", 415);
	}
	const maximum = 1024 * 1024;
	if (Number(request.headers.get("content-length") ?? 0) > maximum)
		throw new AdminGatewayError("ADMIN_BODY_TOO_LARGE", 413);
	const reader = request.body?.getReader();
	if (!reader) throw new AdminGatewayError("ADMIN_JSON_REQUIRED", 400);
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > maximum) {
			await reader.cancel();
			throw new AdminGatewayError("ADMIN_BODY_TOO_LARGE", 413);
		}
		chunks.push(value);
	}
	const body = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw new AdminGatewayError("ADMIN_JSON_INVALID", 400);
	}
}
