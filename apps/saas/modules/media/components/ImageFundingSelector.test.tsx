import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		values ? `${key} ${Object.values(values).join(" ")}` : key,
}));
import { ImageFundingSelector, type ImageFundingSource } from "./ImageFundingSelector";

function input(markup: string, value: ImageFundingSource) {
	return markup.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))?.[0];
}

function findInput(
	element: React.ReactElement,
	value: ImageFundingSource,
): React.ReactElement<{
	onChange: () => void;
}> {
	if (element.type === "input" && (element.props as { value?: string }).value === value)
		return element as ReturnType<typeof findInput>;
	for (const child of React.Children.toArray(
		(element.props as { children?: React.ReactNode }).children,
	)) {
		if (!React.isValidElement(child)) continue;
		try {
			return findInput(child, value);
		} catch {
			/* Continue siblings. */
		}
	}
	throw new Error("input missing");
}

describe("explicit image funding choice", () => {
	it.each([
		{ available: 0, reserved: 0 },
		{ available: undefined, reserved: undefined },
		{ available: 0, reserved: 0, failed: true },
		{ available: undefined, reserved: undefined, failed: true },
	])("hides the selector without known passes while credits are selected: %o", (balance) => {
		const onChange = vi.fn();
		expect(
			renderToStaticMarkup(
				<ImageFundingSelector value="CREDITS" {...balance} onChange={onChange} />,
			),
		).toBe("");
		expect(onChange).not.toHaveBeenCalled();
	});
	it("keeps credits selected even when image passes are available", () => {
		const onChange = vi.fn();
		const markup = renderToStaticMarkup(
			<ImageFundingSelector value="CREDITS" available={3} onChange={onChange} />,
		);
		expect(input(markup, "CREDITS")).toContain('checked=""');
		expect(input(markup, "IMAGE_PASS")).not.toContain('checked=""');
		expect(markup).toContain("fundingPasses 3");
		expect(markup).not.toContain("/image-pass");
		expect(markup).not.toContain("fundingSeparate");
		expect(markup).not.toContain("fundingPolicy");
		expect(onChange).not.toHaveBeenCalled();
	});
	it("shows reserved passes even when none are currently available", () => {
		const markup = renderToStaticMarkup(
			<ImageFundingSelector value="CREDITS" available={0} reserved={2} onChange={vi.fn()} />,
		);
		expect(markup).toContain("fundingPasses 0");
		expect(markup).toContain("fundingReserved 2");
		expect(input(markup, "IMAGE_PASS")).toContain('disabled=""');
		expect(input(markup, "CREDITS")).not.toContain('disabled=""');
	});
	it("keeps an exhausted pass choice visible and offers an explicit switch to credits", () => {
		const onChange = vi.fn();
		const element = ImageFundingSelector({ value: "IMAGE_PASS", available: 0, onChange });
		const markup = renderToStaticMarkup(element);
		expect(input(markup, "IMAGE_PASS")).toContain('checked=""');
		expect(input(markup, "IMAGE_PASS")).toContain('disabled=""');
		expect(input(markup, "CREDITS")).not.toContain('disabled=""');
		expect(markup).toContain("fundingExhausted");
		expect(onChange).not.toHaveBeenCalled();
		findInput(element!, "CREDITS").props.onChange();
		expect(onChange).toHaveBeenCalledExactlyOnceWith("CREDITS");
	});
	it("keeps a selected pass visible while its balance is loading", () => {
		const onChange = vi.fn();
		const markup = renderToStaticMarkup(
			<ImageFundingSelector value="IMAGE_PASS" onChange={onChange} />,
		);
		expect(markup).toContain("fundingLoading");
		expect(input(markup, "IMAGE_PASS")).toContain('checked=""');
		expect(input(markup, "IMAGE_PASS")).toContain('disabled=""');
		expect(onChange).not.toHaveBeenCalled();
	});
	it("keeps a failed pass choice visible with a retry and manual credits exit", () => {
		const onChange = vi.fn();
		const markup = renderToStaticMarkup(
			<ImageFundingSelector value="IMAGE_PASS" failed onChange={onChange} onRefresh={vi.fn()} />,
		);
		expect(markup).toContain("balanceError");
		expect(markup).toContain("retryBalance");
		expect(input(markup, "IMAGE_PASS")).toContain('checked=""');
		expect(input(markup, "IMAGE_PASS")).toContain('disabled=""');
		expect(input(markup, "CREDITS")).not.toContain('disabled=""');
		expect(onChange).not.toHaveBeenCalled();
	});
	it("disables the funding controls while generation is pending", () => {
		const markup = renderToStaticMarkup(
			<ImageFundingSelector
				value="IMAGE_PASS"
				available={3}
				failed
				disabled
				onChange={vi.fn()}
				onRefresh={vi.fn()}
			/>,
		);
		expect(markup.match(/<fieldset[^>]*>/)?.[0]).toContain('disabled=""');
		expect(markup).toContain("retryBalance");
	});
});
