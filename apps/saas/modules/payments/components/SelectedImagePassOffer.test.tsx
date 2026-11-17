import { EZPIC_PRODUCT_KEYS, IMAGE_SKU_KEYS_BY_PRODUCT } from "@repo/config";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), purchase: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
	useQuery: mocks.query,
	queryOptions: (options: unknown) => options,
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, string | number>) =>
		key === "title" ? `$${values?.amount} for ${values?.units} successful images` : key,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: (props: { children: React.ReactNode; onClick: () => void }) => {
		mocks.purchase.mockImplementation(props.onClick);
		return <button>{props.children}</button>;
	},
}));

import { SelectedImagePassOffer } from "./SelectedImagePassOffer";

describe("SelectedImagePassOffer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.query.mockReturnValue({ data: { available: true }, isError: false });
	});
	it("offers the covered selection only when checkout is available and delegates the saved-draft handoff", () => {
		const onContinue = vi.fn();
		const markup = renderToStaticMarkup(
			<SelectedImagePassOffer
				productKey="image-gpt-image-2-6-flare"
				skuKey="gpt-image-2-6-flare-1k"
				outputFormat="svg"
				onContinue={onContinue}
			/>,
		);
		expect(markup).toContain("$2.99 for 3 successful images");
		mocks.purchase();
		expect(onContinue).toHaveBeenCalledOnce();
	});
	it.each(
		EZPIC_PRODUCT_KEYS.flatMap((productKey) =>
			IMAGE_SKU_KEYS_BY_PRODUCT[productKey].map((skuKey) => ({ productKey, skuKey })),
		),
	)("offers the same pass for $productKey / $skuKey", ({ productKey, skuKey }) => {
		expect(
			renderToStaticMarkup(
				<SelectedImagePassOffer productKey={productKey} skuKey={skuKey} onContinue={vi.fn()} />,
			),
		).toContain("$2.99 for 3 successful images");
		expect(mocks.query).toHaveBeenCalledOnce();
	});
	it.each([
		{ data: { available: false }, isError: false },
		{ data: { available: true }, isError: true },
		{ data: undefined, isError: false },
	])("fails closed on unavailable or uncertain checkout", (query) => {
		mocks.query.mockReturnValue(query);
		expect(
			renderToStaticMarkup(
				<SelectedImagePassOffer
					productKey="image-nano-banana-pro"
					skuKey="nano-banana-pro-4k"
					onContinue={vi.fn()}
				/>,
			),
		).toBe("");
	});
});
