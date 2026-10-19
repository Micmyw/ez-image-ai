import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		values ? `${key} ${Object.values(values).join(" ")}` : key,
}));
import { ImageFundingSelector } from "./ImageFundingSelector";

describe("explicit image funding choice", () => {
	it("keeps credits selected even when image passes are available", () => {
		const onChange = vi.fn();
		const markup = renderToStaticMarkup(
			<ImageFundingSelector value="CREDITS" available={3} onChange={onChange} />,
		);
		expect(markup.match(/<input[^>]*value="CREDITS"[^>]*>/)?.[0]).toContain('checked=""');
		expect(markup.match(/<input[^>]*value="IMAGE_PASS"[^>]*>/)?.[0]).not.toContain('checked=""');
		expect(onChange).not.toHaveBeenCalled();
	});
	it("keeps an exhausted pass choice visible without switching to credits", () => {
		const onChange = vi.fn();
		const markup = renderToStaticMarkup(
			<ImageFundingSelector value="IMAGE_PASS" available={0} onChange={onChange} />,
		);
		expect(markup.match(/<input[^>]*value="IMAGE_PASS"[^>]*>/)?.[0]).toContain('checked=""');
		expect(markup).toContain("/image-pass");
		expect(markup).toContain("fundingEmpty");
		expect(onChange).not.toHaveBeenCalled();
	});
});
