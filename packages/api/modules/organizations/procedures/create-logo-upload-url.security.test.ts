import { describe, expect, it } from "vitest";

import {
	assertCanUploadOrganizationLogo,
	organizationLogoUploadSchema,
} from "./create-logo-upload-url";

describe("organization logo upload security", () => {
	it("allows only organization owners and admins", () => {
		expect(() => assertCanUploadOrganizationLogo("owner")).not.toThrow();
		expect(() => assertCanUploadOrganizationLogo("admin")).not.toThrow();
		expect(() => assertCanUploadOrganizationLogo("member")).toThrow(
			expect.objectContaining({ code: "FORBIDDEN" }),
		);
	});

	it("accepts bounded PNG uploads only", () => {
		expect(
			organizationLogoUploadSchema.safeParse({
				organizationId: "organization-1",
				contentType: "image/png",
				contentLength: 1024,
			}),
		).toMatchObject({ success: true });
		expect(
			organizationLogoUploadSchema.safeParse({
				organizationId: "organization-1",
				contentType: "image/jpeg",
				contentLength: 1024,
			}),
		).toMatchObject({ success: false });
		expect(
			organizationLogoUploadSchema.safeParse({
				organizationId: "organization-1",
				contentType: "image/png",
				contentLength: 2_000_001,
			}),
		).toMatchObject({ success: false });
	});
});
