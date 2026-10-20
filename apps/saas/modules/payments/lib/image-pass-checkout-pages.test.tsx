import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() =>
	vi.fn((href: string): never => {
		throw new Error(`redirect:${href}`);
	}),
);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@payments/components/ImagePassPurchase", () => ({ ImagePassPurchase: () => null }));
vi.mock("@payments/components/ImagePassCheckoutReturnContent", () => ({
	ImagePassCheckoutReturnContent: () => null,
}));
import ImagePassReturnPage from "../../../app/(authenticated)/image-pass-checkout-return/page";
import ImagePassPage from "../../../app/(authenticated)/image-pass/page";

function contentProps(element: ReactElement) {
	return (element.props as { children: ReactElement }).children.props as Record<string, unknown>;
}
beforeEach(() => vi.clearAllMocks());
describe("image pass checkout query boundaries", () => {
	it("ignores repeated purchase intent values instead of failing the page", async () => {
		const page = await ImagePassPage({
			searchParams: Promise.resolve({ intentId: ["one", "two"] }),
		});
		expect(contentProps(page).intentId).toBeUndefined();
	});
	it("redirects repeated return intent values to the purchase page", async () => {
		await expect(
			ImagePassReturnPage({ searchParams: Promise.resolve({ intentId: ["one", "two"] }) }),
		).rejects.toThrow("redirect:/image-pass");
	});
	it("does not accept repeated tokens or approved markers as approval", async () => {
		const page = await ImagePassReturnPage({
			searchParams: Promise.resolve({
				intentId: "intent",
				token: ["one", "two"],
				approved: ["1", "1"],
			}),
		});
		expect(contentProps(page)).toMatchObject({ providerOrderId: undefined, approved: false });
	});
	it("gives any canceled marker priority over the token and approval marker", async () => {
		await expect(
			ImagePassReturnPage({
				searchParams: Promise.resolve({
					intentId: "intent",
					token: "token",
					approved: "1",
					canceled: ["", "1"],
				}),
			}),
		).rejects.toThrow("redirect:/image-pass?canceled=1&intentId=intent");
	});
});
