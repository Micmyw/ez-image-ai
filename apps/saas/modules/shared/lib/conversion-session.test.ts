import { getOrCreateBrowserGrowthAnalyticsSessionHash } from "@repo/utils/lib/growth-analytics";
import { invalidatePendingBrowserGrowthAnalytics } from "@repo/utils/lib/growth-analytics-browser";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());
describe("conversion browser identity", () => {
	it("uses one identifier for simultaneous landing and identity observations", async () => {
		const cookieWrites: string[] = [];
		vi.stubGlobal("document", {
			get cookie() {
				return "consent=true; consent_version=2";
			},
			set cookie(value: string) {
				cookieWrites.push(value);
			},
		});
		const digest = vi.fn().mockResolvedValue(new Uint8Array(32).buffer);
		vi.stubGlobal("crypto", { getRandomValues: (v: Uint8Array) => v, subtle: { digest } });
		const [page, identity] = await Promise.all([
			getOrCreateBrowserGrowthAnalyticsSessionHash(),
			getOrCreateBrowserGrowthAnalyticsSessionHash(),
		]);
		expect(page).toBe(identity);
		expect(digest).toHaveBeenCalledTimes(1);
		expect(cookieWrites).toHaveLength(1);
	});
	it("does not create an identifier after consent changes during hashing", async () => {
		let finish!: (value: ArrayBuffer) => void;
		const write = vi.fn();
		vi.stubGlobal("document", {
			get cookie() {
				return "consent=true; consent_version=2";
			},
			set cookie(value: string) {
				write(value);
			},
		});
		vi.stubGlobal("crypto", {
			getRandomValues: (v: Uint8Array) => v,
			subtle: {
				digest: () =>
					new Promise<ArrayBuffer>((resolve) => {
						finish = resolve;
					}),
			},
		});
		const pending = getOrCreateBrowserGrowthAnalyticsSessionHash();
		invalidatePendingBrowserGrowthAnalytics();
		finish(new Uint8Array(32).buffer);
		expect(await pending).toBeUndefined();
		expect(write).not.toHaveBeenCalled();
	});
});
