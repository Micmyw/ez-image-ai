/** Display metadata only; purchase and generation authorization use the full frozen offer. */
export const IMAGE_PASS_OFFER_SUMMARY = /* @__PURE__ */ Object.freeze({
	offerKey: "image-pass-3",
	offerVersion: "2026-11-04.2",
	provider: "paypal",
	amount: "2.99",
	currency: "USD",
	units: 3,
} as const);

/** Purchases before this version may use every image size; see IMAGE_PASS_LEGACY_OFFER. */
export const IMAGE_PASS_LEGACY_OFFER_VERSION = "2026-10-19.1";

/** Frozen standard-size USD 1 offer; never upgrade historical paid grants in place. */
export const IMAGE_PASS_STANDARD_OFFER_VERSION = "2026-11-04.1";
