import { describe, expect, it } from "vitest";

import { createEditorActionController } from "./editor-action";

describe("editor quote and confirmation actions", () => {
	it("rejects a late quote response after image, prompt, or mode invalidates the action", () => {
		const controller = createEditorActionController(() => "idempotency-1");
		const staleRequest = controller.beginQuoteRequest();

		controller.invalidate();

		expect(controller.acceptQuote(staleRequest)).toBe(false);
		const currentRequest = controller.beginQuoteRequest();
		expect(controller.acceptQuote(currentRequest)).toBe(true);
	});

	it("keeps one stable idempotency key for repeated confirmation of the same quote", () => {
		const generated = ["idempotency-1", "idempotency-2"];
		const controller = createEditorActionController(() => generated.shift()!);

		expect(controller.idempotencyKeyFor("quote-1")).toBe("idempotency-1");
		expect(controller.idempotencyKeyFor("quote-1")).toBe("idempotency-1");

		controller.invalidate();

		expect(controller.idempotencyKeyFor("quote-2")).toBe("idempotency-2");
	});
});
