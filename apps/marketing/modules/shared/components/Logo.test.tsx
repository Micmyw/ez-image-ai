import { Logo } from "@repo/ui/components/logo";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("EzPic logo", () => {
	it("renders the configured product label with an accessible original mark", () => {
		const markup = renderToStaticMarkup(<Logo label="Configured Editor" />);

		expect(markup).toContain("Configured Editor");
		expect(markup).toContain("Configured Editor image editor mark");
		expect(markup).not.toContain("EzPic image editor mark");
		expect(markup).not.toMatch(/acme|supastarter/i);
	});
});
