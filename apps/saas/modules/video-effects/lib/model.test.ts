import { afterEach, describe, expect, it, vi } from "vitest";

import { sanitizeEditorReturnPath } from "../../payments/lib/editor-upgrade";
import { videoEffectMayIndex } from "./indexing";
import {
	changeEffectInputs,
	createEffectConfirmation,
	effectError,
	effectReadinessMessage,
	effectRequest,
	effectStorageKey,
	emptyEffectDraft,
	readEffectDraft,
	swapEffectInputs,
	validEffectFile,
	VIDEO_EFFECT_MAX_BYTES,
} from "./model";
import { isVideoEffectPath, videoEffectJobPath } from "./paths";
import {
	bindVideoEffectPaymentReturn,
	consumeVideoEffectPaymentReturn,
	isVideoEffectPaymentOrigin,
	readVideoEffectPaymentReturn,
	saveVideoEffectPaymentReturn,
} from "./payment-return";

describe("video effect indexing boundary", () => {
	it("keeps private and localized views noindex after future publication", () => {
		expect(videoEffectMayIndex(true, {})).toBe(true);
		expect(videoEffectMayIndex(false, {})).toBe(false);
		expect(videoEffectMayIndex(true, { job: "private-job" })).toBe(false);
		expect(videoEffectMayIndex(true, { job: "" })).toBe(false);
		expect(videoEffectMayIndex(true, { lang: "de" })).toBe(false);
		expect(videoEffectMayIndex(true, { lang: "en" })).toBe(true);
		expect(videoEffectMayIndex(true, { lang: "invalid" })).toBe(true);
		expect(videoEffectMayIndex(true, { lang: ["en", "de"] })).toBe(true);
		expect(videoEffectMayIndex(true, { asset: "private" })).toBe(false);
	});
});

const quote = { quoteId: "quote-1", credits: "24", expiresAt: "2030-01-01T00:00:00.000Z" };
describe("Rumpelstiltskin internal solo draft", () => {
	it("binds one upload twice, isolates its recovery intent and routes history to its test entry", () => {
		const draft = {
			...emptyEffectDraft("owner-1", "rumpelstiltskin-solo"),
			leftAssetId: "portrait",
		};
		expect(effectRequest(draft).inputs).toEqual({
			leftAssetId: "portrait",
			rightAssetId: "portrait",
		});
		const pending = { ...draft, confirmation: createEffectConfirmation(draft, quote) };
		expect(readEffectDraft(JSON.stringify(pending), "owner-1", "rumpelstiltskin-solo")).toEqual(
			pending,
		);
		expect(readEffectDraft(JSON.stringify(pending), "owner-1", "raindance-solo")).toBeNull();
		expect(effectStorageKey("owner-1", "rumpelstiltskin-solo")).not.toBe(
			effectStorageKey("owner-1", "raindance-solo"),
		);
		expect(videoEffectJobPath("rumpelstiltskin-solo", "private-job")).toBe(
			"/video/effects/rumpelstiltskin?job=private-job",
		);
		// Internal testing is never a public checkout return destination.
		expect(isVideoEffectPath("/video/effects/rumpelstiltskin")).toBe(false);
	});
	it.each([
		["MOTION_REFERENCE_REQUIRED", "rumpelstiltskin.motionRequired"],
		["MOTION_REFERENCE_INVALID", "rumpelstiltskin.motionInvalid"],
		["COST_APPROVAL_REQUIRED", "rumpelstiltskin.costRequired"],
		["COST_APPROVAL_INVALID", "rumpelstiltskin.costInvalid"],
	])("translates only the safe %s refusal reason", (reason, message) => {
		expect(effectReadinessMessage(reason)).toBe(message);
		expect(effectError(new Error(reason))).toBe(message);
	});
	it("does not expose unknown provider or private asset data as UI copy", () => {
		expect(effectReadinessMessage("provider https://private.example?token=secret")).toBe(
			"unavailable",
		);
	});
});
describe("Raindance draft isolation", () => {
	it("binds a solo upload once and cannot restore a confirmation into another template", () => {
		const solo = { ...emptyEffectDraft("owner-1", "raindance-solo"), leftAssetId: "portrait" };
		expect(effectRequest(solo).inputs).toEqual({
			leftAssetId: "portrait",
			rightAssetId: "portrait",
		});
		const accepted = { ...solo, confirmation: createEffectConfirmation(solo, quote) };
		expect(readEffectDraft(JSON.stringify(accepted), "owner-1", "raindance-solo")).toEqual(
			accepted,
		);
		expect(readEffectDraft(JSON.stringify(accepted), "owner-1", "raindance-duo")).toBeNull();
		expect(readEffectDraft(JSON.stringify(accepted), "owner-1")).toBeNull();
		expect(
			new Set(
				["hotel-lobby-duo", "raindance-solo", "raindance-duo"].map((id) =>
					effectStorageKey("owner-1", id as "hotel-lobby-duo"),
				),
			).size,
		).toBe(3);
	});
	it("allows only the clean canonical Raindance payment return", () => {
		expect(sanitizeEditorReturnPath("/blog/raindance-ai-trend")).toBe("/blog/raindance-ai-trend");
		expect(sanitizeEditorReturnPath("/blog/raindance-ai-trend?asset=private")).toBe("/create");
		expect(sanitizeEditorReturnPath("//evil.example/blog/raindance-ai-trend")).toBe("/create");
		expect(isVideoEffectPaymentOrigin("/pricing?returnTo=%2Fblog%2Fraindance-ai-trend")).toBe(true);
	});
});
const ready = () => ({
	...emptyEffectDraft("owner-1"),
	leftAssetId: "asset-left",
	rightAssetId: "asset-right",
});
describe("Hotel Lobby private draft and paid confirmation", () => {
	it("swaps actual bindings and increments revision so a pending quote cannot apply", () => {
		const draft = ready();
		const swapped = swapEffectInputs(draft);
		expect(effectRequest(swapped).inputs).toEqual({
			leftAssetId: "asset-right",
			rightAssetId: "asset-left",
		});
		expect(swapped.revision).toBe(draft.revision + 1);
	});
	it("refresh/network recovery keeps the same complete confirmation even if the draft changed", () => {
		const original = ready();
		const confirmation = createEffectConfirmation(
			original,
			quote,
			"b858321c-38a1-4da5-a547-05bbbfcb0277",
		);
		const next = changeEffectInputs(
			{ ...original, confirmation, jobId: "accepted-older-job" },
			{ leftAssetId: "replacement" },
		);
		const recovered = readEffectDraft(JSON.stringify(next), "owner-1")!;
		expect(recovered.confirmation).toEqual(confirmation);
		expect(recovered.confirmation?.input.request.inputs.leftAssetId).toBe("asset-left");
		expect(recovered.leftAssetId).toBe("replacement");
		expect(recovered.jobId).toBe("accepted-older-job");
	});
	it("rejects another owner, tampered payloads and signed/raw photo data", () => {
		expect(readEffectDraft(JSON.stringify(ready()), "owner-2")).toBeNull();
		for (const patch of [
			{ previewUrl: "https://private.example?secret=1" },
			{ leftAssetId: "data:image/png;base64,secret" },
			{ version: 2 },
		])
			expect(readEffectDraft(JSON.stringify({ ...ready(), ...patch }), "owner-1")).toBeNull();
		const intent = createEffectConfirmation(ready(), quote);
		expect(
			readEffectDraft(
				JSON.stringify({
					...ready(),
					confirmation: { ...intent, input: { ...intent.input, quoteId: "different-quote" } },
				}),
				"owner-1",
			),
		).toBeNull();
	});
	it("allows the same adult photo in both roles", () => {
		expect(effectRequest({ ...ready(), rightAssetId: "asset-left" }).inputs).toEqual({
			leftAssetId: "asset-left",
			rightAssetId: "asset-left",
		});
	});
	it("enforces decimal 10,000,000 bytes and the stricter account limit before remote upload", () => {
		expect(validEffectFile({ type: "image/png", size: VIDEO_EFFECT_MAX_BYTES }, 20_000_000)).toBe(
			true,
		);
		expect(
			validEffectFile({ type: "image/png", size: VIDEO_EFFECT_MAX_BYTES + 1 }, 20_000_000),
		).toBe(false);
		expect(validEffectFile({ type: "image/webp", size: 5_000_001 }, 5_000_000)).toBe(false);
		expect(validEffectFile({ type: "image/svg+xml", size: 100 }, 5_000_000)).toBe(false);
	});
	it("does not mistake an uncertain credit/provider failure for a safely rejected order", () => {
		expect(effectError(new Error("CREDIT_SETTLEMENT_UNCERTAIN"))).toBe("requestFailed");
		expect(effectError(new Error("INSUFFICIENT_ELIGIBLE_CREDITS"))).toBe("insufficient");
		expect(effectError(new Error("QUOTE_EXPIRED_OR_CHANGED"))).toBe("quoteExpired");
	});
});
describe("template payment return", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
	const raw = (patch = {}) =>
		JSON.stringify({
			ownerId: "owner-1",
			path: "/video-effects/hotel-lobby-ai",
			stage: "bound",
			intentId: "intent-1",
			createdAt: 100,
			...patch,
		});
	it("restores only the original owner, exact safe path and unexpired handoff", () => {
		expect(readVideoEffectPaymentReturn(raw(), "owner-1", "intent-1", 200)).toBe(
			"/video-effects/hotel-lobby-ai",
		);
		expect(readVideoEffectPaymentReturn(raw(), "owner-2", "intent-1", 200)).toBeNull();
		expect(readVideoEffectPaymentReturn(raw(), "owner-1", "other-intent", 200)).toBeNull();
		expect(readVideoEffectPaymentReturn(raw(), "owner-1", undefined, 200)).toBeNull();
		expect(
			readVideoEffectPaymentReturn(
				raw({ path: "https://evil.example" }),
				"owner-1",
				"intent-1",
				200,
			),
		).toBeNull();
		expect(readVideoEffectPaymentReturn(raw(), "owner-1", "intent-1", 4_000_000)).toBeNull();
		expect(
			readVideoEffectPaymentReturn(raw({ createdAt: 300 }), "owner-1", "intent-1", 200),
		).toBeNull();
		expect(
			readVideoEffectPaymentReturn(
				raw({ stage: "armed", intentId: undefined }),
				"owner-1",
				"intent-1",
				200,
			),
		).toBeNull();
	});

	function mockStorage() {
		const values = new Map<string, string>();
		vi.stubGlobal("sessionStorage", {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		});
		vi.spyOn(Date, "now").mockReturnValue(200);
		return values;
	}

	it("abandoned pricing never redirects a later unrelated completed checkout", () => {
		mockStorage();
		saveVideoEffectPaymentReturn("owner-1");
		expect(consumeVideoEffectPaymentReturn("owner-1", "unrelated-intent")).toBeNull();
		expect(
			bindVideoEffectPaymentReturn("owner-1", "unrelated-intent", "/pricing?plan=creator"),
		).toBe(false);
		expect(consumeVideoEffectPaymentReturn("owner-1", "unrelated-intent")).toBeNull();
	});

	it("binds and consumes only the originating owner and exact durable checkout intent", () => {
		mockStorage();
		saveVideoEffectPaymentReturn("owner-1");
		expect(
			bindVideoEffectPaymentReturn("owner-2", "intent-1", "/video-effects/hotel-lobby-ai"),
		).toBe(false);
		expect(
			bindVideoEffectPaymentReturn("owner-1", "intent-1", "/video-effects/hotel-lobby-ai"),
		).toBe(true);
		expect(consumeVideoEffectPaymentReturn("owner-2", "intent-1")).toBeNull();
		expect(consumeVideoEffectPaymentReturn("owner-1", "unrelated-intent")).toBeNull();
		expect(
			bindVideoEffectPaymentReturn(
				"owner-1",
				"replacement-intent",
				"/video-effects/hotel-lobby-ai",
			),
		).toBe(false);
		expect(consumeVideoEffectPaymentReturn("owner-1", "intent-1")).toBe(
			"/video-effects/hotel-lobby-ai",
		);
		expect(consumeVideoEffectPaymentReturn("owner-1", "intent-1")).toBeNull();
	});

	it("allows the explicit fallback pricing return only with a matching armed owner", () => {
		mockStorage();
		const path = "/pricing?view=credit-packs&returnTo=%2Fvideo-effects%2Fhotel-lobby-ai";
		expect(bindVideoEffectPaymentReturn("owner-1", "intent-1", path)).toBe(false);
		saveVideoEffectPaymentReturn("owner-1");
		expect(bindVideoEffectPaymentReturn("owner-1", "intent-1", path)).toBe(true);
		expect(consumeVideoEffectPaymentReturn("owner-1", "intent-1")).toBe(
			"/video-effects/hotel-lobby-ai",
		);
	});

	it.each([
		"/pricing",
		"/create",
		"//evil.example/video-effects/hotel-lobby-ai",
		"/pricing?returnTo=https://evil.example",
		"/pricing?returnTo=/video-effects/hotel-lobby-ai?asset=private",
	])("rejects unrelated or unsafe checkout origin %s", (path) => {
		expect(isVideoEffectPaymentOrigin(path)).toBe(false);
	});
	it("allows the exact template return without persisting asset or signed URL query parameters", () => {
		expect(sanitizeEditorReturnPath("/video-effects/hotel-lobby-ai")).toBe(
			"/video-effects/hotel-lobby-ai",
		);
		expect(sanitizeEditorReturnPath("/video-effects/hotel-lobby-ai?asset=private")).toBe("/create");
		expect(sanitizeEditorReturnPath("//evil.example/video-effects/hotel-lobby-ai")).toBe("/create");
	});
});
