import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import { assertCheckoutReturnOwnerScope } from "./procedures/get-checkout-return-state";

describe("checkout return ownership", () => {
	it("rejects organization scope in the user-only first release", () => {
		expect(() => assertCheckoutReturnOwnerScope("org-other")).toThrowError(ORPCError);
	});

	it("accepts the authenticated user scope", () => {
		expect(() => assertCheckoutReturnOwnerScope(undefined)).not.toThrow();
	});
});
