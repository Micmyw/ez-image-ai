import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buttons = vi.hoisted(
	() => [] as { onClick: () => void; disabled?: boolean; "aria-pressed"?: boolean }[],
);
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, string | number>) =>
		key === "selection" ? `${values?.model} · ${values?.credits} credits` : key,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: (props: {
		children: React.ReactNode;
		onClick: () => void;
		disabled?: boolean;
		"aria-pressed"?: boolean;
	}) => {
		buttons.push(props);
		return (
			<button disabled={props.disabled} aria-pressed={props["aria-pressed"]}>
				{props.children}
			</button>
		);
	},
}));

import { ImagePurposeShortcuts } from "./ImagePurposeShortcuts";

describe("ImagePurposeShortcuts", () => {
	beforeEach(() => {
		buttons.length = 0;
	});
	it("shows the real model and cost and selects that exact public pair on click", () => {
		const onSelect = vi.fn();
		const markup = renderToStaticMarkup(
			<ImagePurposeShortcuts
				products={[
					{
						key: "image-gpt-image-2-6-flare",
						label: "Flare",
						skuMatrix: { cells: [{ skuKey: "gpt-image-2-6-flare-1k", credits: 20 }] },
					},
				]}
				value="image-gpt-image-2-6-flare"
				skuKey="gpt-image-2-6-flare-1k"
				onSelect={onSelect}
			/>,
		);
		expect(markup).toContain("Flare · 20 credits");
		expect(buttons[0]?.["aria-pressed"]).toBe(true);
		buttons[0]?.onClick();
		expect(onSelect).toHaveBeenCalledWith("image-gpt-image-2-6-flare", "gpt-image-2-6-flare-1k");
	});
	it("keeps busy choices disabled", () => {
		renderToStaticMarkup(
			<ImagePurposeShortcuts
				products={[
					{
						key: "image-minimax-h3",
						label: "H3",
						skuMatrix: { cells: [{ skuKey: "minimax-h3-1k", credits: 5 }] },
					},
				]}
				value={null}
				skuKey={null}
				disabled
				onSelect={vi.fn()}
			/>,
		);
		expect(buttons[0]?.disabled).toBe(true);
	});
});
