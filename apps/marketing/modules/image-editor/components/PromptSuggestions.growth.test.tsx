import React, { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	examplePromptSelected: vi.fn(() => Promise.resolve("sent")),
}));

vi.mock("@analytics", () => ({
	marketingGrowthFunnel: { examplePromptSelected: mocks.examplePromptSelected },
}));

import { PromptSuggestions } from "./PromptSuggestions";

describe("PromptSuggestions growth event", () => {
	it("tracks a suggestion selection without sending the prompt text", () => {
		const onSelect = vi.fn();
		const tree = PromptSuggestions({
			label: "Examples",
			onSelect,
			suggestions: ["private example prompt"],
		});
		const button = findElement(tree, (element) => element.type === "button");

		expect(button).toBeDefined();
		(button?.props.onClick as (() => void) | undefined)?.();

		expect(onSelect).toHaveBeenCalledWith("private example prompt");
		expect(mocks.examplePromptSelected).toHaveBeenCalledWith();
		expect(JSON.stringify(mocks.examplePromptSelected.mock.calls)).not.toContain(
			"private example prompt",
		);
	});
});

function findElement(
	node: ReactNode,
	predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
	if (!isValidElement<Record<string, unknown>>(node)) return undefined;
	if (predicate(node)) return node;
	const children = (node.props as { children?: ReactNode }).children;
	return React.Children.toArray(children)
		.map((child) => findElement(child, predicate))
		.find(Boolean);
}
