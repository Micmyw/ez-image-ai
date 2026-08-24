import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@config", () => ({ config: { saasUrl: "https://app.configured.test" } }));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		({
			video: "Video",
			reference: "Source image",
			prompt: "Edit instructions",
			continue: "Continue to edit",
		})[key] ?? key,
}));
vi.mock("@repo/ui/components/alert", () => ({
	Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	AlertDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({
		children,
		className,
		disabled,
		onClick,
	}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button className={className} disabled={disabled} onClick={onClick}>
			{children}
		</button>
	),
}));
vi.mock("@repo/ui/components/select", () => ({
	Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
		<span data-value={value}>{children}</span>
	),
	SelectTrigger: ({ children, id }: { children: React.ReactNode; id?: string }) => (
		<div id={id}>{children}</div>
	),
	SelectValue: () => null,
}));
vi.mock("@repo/ui/components/textarea", () => ({
	Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

import { MarketingGenerator } from "./MarketingGenerator";

describe("MarketingGenerator", () => {
	it("renders an image-edit-only draft form with a required source image", () => {
		const markup = renderToStaticMarkup(<MarketingGenerator />);

		expect(markup).toContain('type="file"');
		expect(markup).toContain("Source image");
		expect(markup).toContain("required");
		expect(markup).not.toContain("Video");
		expect(markup).not.toContain("marketing-kind");
	});
});
