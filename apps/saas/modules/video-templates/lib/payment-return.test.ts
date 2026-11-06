import { FLYING_CAR_TEMPLATE_KEYS } from "@repo/config/video-template-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sanitizeVideoEffectReturnPath } from "../../video-effects/lib/paths";
import {
	bindVideoEffectPaymentReturn,
	consumeVideoEffectPaymentReturn,
	saveVideoEffectPaymentReturn,
} from "../../video-effects/lib/payment-return";

beforeEach(() => {
	const storage = new Map<string, string>();
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
});
afterEach(() => vi.unstubAllGlobals());
describe("template checkout return", () => {
	it("only permits exact known source workspace destinations", () => {
		expect(sanitizeVideoEffectReturnPath("/video-templates/bulin-47")).toBe(
			"/video-templates/bulin-47",
		);
		for (const templateKey of FLYING_CAR_TEMPLATE_KEYS) {
			const path = `/video-templates/${templateKey}`;
			expect(sanitizeVideoEffectReturnPath(path)).toBe(path);
			expect(sanitizeVideoEffectReturnPath(`${path}?asset=private`)).toBeNull();
		}
		for (const path of [
			"/video-templates/flying-car",
			"/video-templates/not-a-template",
			"/video-templates/bulin-47?asset=private",
			"//other.invalid/video-templates/bulin-47",
			"/video-templates/bulin-47#fragment",
		])
			expect(sanitizeVideoEffectReturnPath(path)).toBeNull();
	});
	it("binds the saved draft return only to the same owner, template and actual checkout", () => {
		const path = "/video-templates/bulin-47";
		saveVideoEffectPaymentReturn("owner-a", path);
		expect(consumeVideoEffectPaymentReturn("owner-a", "intent-a")).toBeNull();
		expect(bindVideoEffectPaymentReturn("owner-b", "intent-a", path)).toBe(false);
		expect(
			bindVideoEffectPaymentReturn("owner-a", "intent-a", "/video-templates/paws-at-you"),
		).toBe(false);
		expect(
			bindVideoEffectPaymentReturn(
				"owner-a",
				"intent-a",
				`/pricing?returnTo=${encodeURIComponent(path)}`,
			),
		).toBe(true);
		expect(consumeVideoEffectPaymentReturn("owner-a", "unrelated-intent")).toBeNull();
		expect(consumeVideoEffectPaymentReturn("owner-a", "intent-a")).toBe(path);
		expect(consumeVideoEffectPaymentReturn("owner-a", "intent-a")).toBeNull();
	});
	it("does not copy private job or input IDs into the payment return marker", () => {
		const path = "/video-templates/58th-floor";
		saveVideoEffectPaymentReturn("owner-a", path);
		expect(
			bindVideoEffectPaymentReturn(
				"owner-a",
				"intent-a",
				`${path}?job=private-job&asset=private-asset`,
			),
		).toBe(true);
		expect(consumeVideoEffectPaymentReturn("owner-a", "intent-a")).toBe(path);
	});
});
