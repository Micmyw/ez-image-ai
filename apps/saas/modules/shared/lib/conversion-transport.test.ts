import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hash = `sha256:${"a".repeat(64)}`;
const event = {
	name: "purchase_clicked" as const,
	properties: { anonymousSessionHash: hash, productKind: "PLAN" as const },
};

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal("window", {
		location: new URL("https://ezimageai.com/create?utm_source=chatgpt.com&prompt=private#private"),
	});
	vi.stubGlobal("document", {
		cookie: `consent=true; consent_version=2; ezpic_analytics_session=${hash}`,
		referrer: "https://chatgpt.com/c/private-conversation",
	});
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ accepted: true })));
});
afterEach(() => vi.unstubAllGlobals());
describe("first-party event transport", () => {
	it.each([503, 429, 200])(
		"does not mark an unaccepted observation delivered (%s)",
		async (status) => {
			vi.mocked(fetch).mockResolvedValue(Response.json({ accepted: false }, { status }));
			const { sendFirstPartyGrowthEvent } = await import("@repo/utils/lib/conversion-transport");
			await expect(sendFirstPartyGrowthEvent(event)).rejects.toThrow(
				"ANALYTICS_OBSERVATION_NOT_ACCEPTED",
			);
		},
	);
	it("carries safe attribution independently of vendor configuration", async () => {
		const { sendFirstPartyGrowthEvent } = await import("@repo/utils/lib/conversion-transport");
		await sendFirstPartyGrowthEvent(event);
		expect(fetch).toHaveBeenCalledWith(
			"/api/analytics/events",
			expect.objectContaining({ keepalive: true, credentials: "same-origin" }),
		);
		const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
		expect(body).toMatchObject({
			path: "/create",
			firstTouch: { utmSource: "chatgpt.com", referrerOrigin: "https://chatgpt.com" },
		});
		expect(JSON.stringify(body)).not.toContain("private");
	});
	it("does not send after refusal or when the browser identifier changed", async () => {
		const { sendFirstPartyGrowthEvent } = await import("@repo/utils/lib/conversion-transport");
		document.cookie = "consent=false";
		await sendFirstPartyGrowthEvent(event);
		document.cookie = `consent=true; consent_version=2; ezpic_analytics_session=sha256:${"b".repeat(64)}`;
		await sendFirstPartyGrowthEvent(event);
		expect(fetch).not.toHaveBeenCalled();
	});
});
