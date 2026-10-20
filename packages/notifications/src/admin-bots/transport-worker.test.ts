import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});
it("uses Workers-supported manual redirects and never sends to Location", async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValue(
			new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }),
		);
	vi.stubGlobal("fetch", fetcher);
	const { postBotJson } = await import("./transport-worker");
	await expect(
		postBotJson(new URL("https://notify.example.test/"), {}, { Authorization: "Bearer test" }),
	).rejects.toThrow("ADMIN_BOT_HTTP_302");
	expect(fetcher).toHaveBeenCalledOnce();
	expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
});
