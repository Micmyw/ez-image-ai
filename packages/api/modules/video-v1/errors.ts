import { ORPCError } from "@orpc/server";

export async function videoAction<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof ORPCError) throw error;
		const message = error instanceof Error ? error.message : "VIDEO_REQUEST_FAILED";
		// Provider messages, SQL errors, prompts and private URLs remain server-only.
		const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : "VIDEO_REQUEST_FAILED";
		throw new ORPCError(
			code === "IDEMPOTENCY_CONFLICT"
				? "CONFLICT"
				: code === "NOT_FOUND"
					? "NOT_FOUND"
					: code === "VIDEO_ACCESS_DENIED"
						? "FORBIDDEN"
						: "BAD_REQUEST",
			{ message: code, data: { code } },
		);
	}
}
