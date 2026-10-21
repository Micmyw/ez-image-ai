import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const record = vi.hoisted(() => vi.fn());
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({ recordAggregateTraffic: record }));
import { getAnalyticsPolicy } from "./policy";
import { ingestAggregateTraffic } from "./traffic";

beforeEach(() => {
	vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://ezimageai.com");
	record.mockReset().mockResolvedValue({ accepted: true });
});
const input = { path: "/create" as const, source: "chatgpt.com" as const };
const invoke = (headers: Record<string, string> = {}, body: unknown = input) =>
	call(ingestAggregateTraffic, body as typeof input, {
		context: {
			headers: new Headers({
				origin: "https://ezimageai.com",
				"user-agent": "Mozilla/5.0 Mobile",
				...headers,
			}),
		},
	});

describe("anonymous page counters", () => {
	it("accepts an ordinary credentialless JSON POST at the public endpoint", async () => {
		const headers = new Headers({
			origin: "https://ezimageai.com",
			"content-type": "application/json",
		});
		const result = await new OpenAPIHandler({ traffic: ingestAggregateTraffic }).handle(
			new Request("https://ezimageai.com/api/analytics/traffic", {
				method: "POST",
				headers,
				body: JSON.stringify(input),
			}),
			{ prefix: "/api", context: { headers } },
		);
		expect(await result.response?.json()).toEqual({ accepted: true });
		expect(record).toHaveBeenCalledWith({ ...input, device: "unknown" });
	});
	it("never accepts credentials, opt-out signals, bots or extra visit identity", async () => {
		for (const headers of [
			{ cookie: "consent=true" },
			{ authorization: "Bearer example" },
			{ "sec-gpc": "1" },
			{ dnt: "1" },
			{ "user-agent": "Googlebot" },
		] as Record<string, string>[])
			expect(await invoke(headers)).toEqual({ accepted: false });
		await expect(invoke({}, { ...input, visitorId: "user" })).rejects.toThrow();
		await expect(invoke({}, { ...input, path: "/admin/users" })).rejects.toThrow();
		await expect(invoke({}, { ...input, source: "person@example.com" })).rejects.toThrow();
		await expect(invoke({ origin: "https://another.test" })).rejects.toThrow();
		expect(record).not.toHaveBeenCalled();
	});
	it("serves policy as a no-store GET instead of embedding shared geo HTML", async () => {
		vi.stubEnv("MEDIA_TRUSTED_PROXY_PROVIDER", "cloudflare");
		const responseHeaders = new Headers();
		expect(
			await call(getAnalyticsPolicy, undefined, {
				context: { headers: new Headers({ "cf-ipcountry": "DE" }), responseHeaders },
			}),
		).toMatchObject({ requiresOptIn: true, analyticsAllowed: false });
		expect(responseHeaders.get("cache-control")).toBe("private, no-store");
	});
});
