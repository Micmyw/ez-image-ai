import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

import {
	assertOrganizationCheckoutOwner,
	resolveCheckoutCustomerId,
	resolveCheckoutRedirectUrl,
} from "./procedures/create-checkout-link";

describe("checkout security boundaries", () => {
	it("allows only organization owners to create organization checkout", () => {
		expect(() => assertOrganizationCheckoutOwner("owner")).not.toThrow();
		expect(() => assertOrganizationCheckoutOwner("admin")).toThrowError(ORPCError);
		expect(() => assertOrganizationCheckoutOwner("member")).toThrowError(ORPCError);
		expect(() => assertOrganizationCheckoutOwner(undefined)).toThrowError(ORPCError);
	});

	it("rejects a non-owner before reading the organization Stripe customer", async () => {
		const getCustomerId = vi.fn().mockResolvedValue("cus_organization");
		await expect(
			resolveCheckoutCustomerId(
				{ organizationId: "org-1", userId: "member-1" },
				{
					getMembership: vi.fn().mockResolvedValue({ role: "member" }),
					getCustomerId,
				},
			),
		).rejects.toBeInstanceOf(ORPCError);
		expect(getCustomerId).not.toHaveBeenCalled();
	});

	it("reads the organization Stripe customer for an owner", async () => {
		const getCustomerId = vi.fn().mockResolvedValue("cus_organization");
		await expect(
			resolveCheckoutCustomerId(
				{ organizationId: "org-1", userId: "owner-1" },
				{
					getMembership: vi.fn().mockResolvedValue({ role: "owner" }),
					getCustomerId,
				},
			),
		).resolves.toBe("cus_organization");
		expect(getCustomerId).toHaveBeenCalledWith({ organizationId: "org-1" });
	});

	it("accepts only the configured SaaS return origin", () => {
		const environment = {
			NEXT_PUBLIC_SAAS_URL: "https://app.example.com",
			NEXT_PUBLIC_MARKETING_URL: "https://www.example.com",
		} as NodeJS.ProcessEnv;

		expect(resolveCheckoutRedirectUrl(undefined, environment)).toBe(
			"https://app.example.com/checkout-return",
		);
		expect(
			resolveCheckoutRedirectUrl(
				"https://app.example.com/checkout-return?plan=creator",
				environment,
			),
		).toBe("https://app.example.com/checkout-return?plan=creator");
		expect(() =>
			resolveCheckoutRedirectUrl("https://www.example.com/pricing", environment),
		).toThrowError(ORPCError);
	});

	it("rejects external and lookalike return origins", () => {
		const environment = {
			NEXT_PUBLIC_SAAS_URL: "https://app.example.com",
			NEXT_PUBLIC_MARKETING_URL: "https://www.example.com",
		} as NodeJS.ProcessEnv;

		for (const redirectUrl of [
			"https://evil.example/checkout-return",
			"https://app.example.com.evil.example/checkout-return",
			"https://app.example.com@evil.example/checkout-return",
		]) {
			expect(() => resolveCheckoutRedirectUrl(redirectUrl, environment)).toThrowError(ORPCError);
		}
	});
});
