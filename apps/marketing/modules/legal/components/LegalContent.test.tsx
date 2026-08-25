import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LegalContent } from "./LegalContent";

describe("LegalContent", () => {
	it("renders repository-owned Markdown without a client evaluator or raw HTML", () => {
		const markup = renderToStaticMarkup(
			<LegalContent
				content={`_Last updated_

## Privacy and safety

Private media stays private. Use \`settings\`, never <script>alert("unsafe")</script>.

- Owner-scoped access
- Short-lived links`}
			/>,
		);

		expect(markup).toContain("<em>Last updated</em>");
		expect(markup).toContain("<h2>Privacy and safety</h2>");
		expect(markup).toContain("<code>settings</code>");
		expect(markup).toContain("<li>Owner-scoped access</li>");
		expect(markup).toContain("&lt;script&gt;");
		expect(markup).not.toContain("<script>");
	});
});
