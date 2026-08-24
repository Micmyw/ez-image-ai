import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sliderState = vi.hoisted(() => ({
	position: 50,
	setPosition: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useState: () => [sliderState.position, sliderState.setPosition],
	};
});

import { BeforeAfterSlider } from "./BeforeAfterSlider";

describe("BeforeAfterSlider", () => {
	beforeEach(() => {
		sliderState.position = 50;
		sliderState.setPosition.mockReset();
		sliderState.setPosition.mockImplementation((next: number | ((current: number) => number)) => {
			sliderState.position = typeof next === "function" ? next(sliderState.position) : next;
		});
	});

	it("provides a keyboard slider and explicit original/result alternatives", () => {
		const markup = renderSlider();

		expect(markup).toContain('type="range"');
		expect(markup).toContain('aria-label="Compare original and edited image"');
		expect(markup).toContain("Show original");
		expect(markup).toContain("Show result");
		expect(markup).toContain('alt="Original source image"');
		expect(markup).toContain('alt="Edited result image"');
		expect(markup).not.toMatch(/aria-hidden="true"[^>]*>\s*<img[^>]+alt="Edited result image"/);
	});

	it("shows the input on the left and the approved output on the right at the midpoint", () => {
		const markup = renderSlider();
		const overlay = clippedLayer(markup);
		const overlayStart = markup.indexOf('style="clip-path:inset(0 50% 0 0)"');

		expect(overlayStart).toBeGreaterThan(-1);
		expect(markup.indexOf('alt="Edited result image"')).toBeLessThan(overlayStart);
		expect(markup.indexOf(">Result</span>")).toBeLessThan(overlayStart);
		expect(overlay).toContain('alt="Original source image"');
		expect(overlay).toContain(">Original</span>");
		expect(overlay).not.toContain('alt="Edited result image"');
		expect(overlay).not.toContain(">Result</span>");
	});

	it("shows the correct full image from the original and result alternatives", () => {
		const tree = BeforeAfterSlider(sliderProps);
		const buttons = findElements(tree, "button");
		const showOriginal = buttonNamed(buttons, "Show original");
		const showResult = buttonNamed(buttons, "Show result");

		showOriginal.props.onClick();
		expect(sliderState.position).toBe(100);
		expect(renderSlider()).toContain('style="clip-path:inset(0 0% 0 0)"');
		expect(clippedLayer(renderSlider())).toContain('alt="Original source image"');

		showResult.props.onClick();
		expect(sliderState.position).toBe(0);
		expect(renderSlider()).toContain('style="clip-path:inset(0 100% 0 0)"');
		expect(renderSlider().indexOf('alt="Edited result image"')).toBeLessThan(
			renderSlider().indexOf('style="clip-path:inset(0 100% 0 0)"'),
		);
	});
});

const sliderProps = {
	beforeUrl: "https://signed.test/input",
	afterUrl: "https://signed.test/output",
	beforeAlt: "Original source image",
	afterAlt: "Edited result image",
	controlLabel: "Compare original and edited image",
	showOriginalLabel: "Show original",
	showResultLabel: "Show result",
	beforeLabel: "Original",
	afterLabel: "Result",
};

function renderSlider() {
	return renderToStaticMarkup(<BeforeAfterSlider {...sliderProps} />);
}

function clippedLayer(markup: string) {
	const styleStart = markup.indexOf('style="clip-path:');
	const layerStart = markup.lastIndexOf("<div", styleStart);
	const contentStart = markup.indexOf(">", styleStart) + 1;
	const layerEnd = markup.indexOf("</div>", contentStart);
	return markup.slice(layerStart, layerEnd);
}

function findElements(node: React.ReactNode, type: string): React.ReactElement[] {
	if (Array.isArray(node)) return node.flatMap((child) => findElements(child, type));
	if (!React.isValidElement(node)) return [];
	const props = node.props as { children?: React.ReactNode };
	return [...(node.type === type ? [node] : []), ...findElements(props.children, type)];
}

function buttonNamed(buttons: React.ReactElement[], name: string) {
	const button = buttons.find(
		(candidate) => (candidate.props as { children?: React.ReactNode }).children === name,
	);
	if (!button) throw new Error(`Missing ${name} button`);
	return button as React.ReactElement<{ onClick(): void }>;
}
