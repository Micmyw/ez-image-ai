import { APIError } from "better-auth/api";
import { beforeAll, describe, expect, it, vi } from "vitest";

type OrganizationSlugHook = (input: {
	organization: { name?: string; slug?: string };
	member?: unknown;
	user?: unknown;
}) => Promise<unknown>;

type OrganizationPluginOptions = {
	organizationHooks?: {
		beforeCreateOrganization?: OrganizationSlugHook;
		beforeUpdateOrganization?: OrganizationSlugHook;
	};
};

const TOP_LEVEL_STATIC_ROUTE_SEGMENTS = [
	"admin",
	"api",
	"assets",
	"blog",
	"changelog",
	"chatbot",
	"checkout-return",
	"choose-plan",
	"contact",
	"create",
	"credit-pack-checkout-return",
	"dashboard",
	"docs",
	"draft",
	"edits",
	"forgot-password",
	"history",
	"icon.png",
	"image-proxy",
	"llms-full.txt",
	"llms.mdx",
	"llms.txt",
	"login",
	"new-organization",
	"og",
	"onboarding",
	"opengraph-image",
	"organization-invitation",
	"pricing",
	"privacy",
	"reset-password",
	"robots.txt",
	"settings",
	"signup",
	"sitemap.xml",
	"terms",
	"try",
	"verify",
] as const;

const organizationPluginCapture = vi.hoisted(() => ({
	options: undefined as OrganizationPluginOptions | undefined,
}));

vi.mock("@better-auth/passkey", () => ({ passkey: vi.fn(() => ({ id: "passkey" })) }));
vi.mock("@repo/database", () => ({
	db: {},
	getInvitationById: vi.fn(),
	getOrganizationMembership: vi.fn(),
	getPurchasesByOrganizationId: vi.fn(),
	getPurchasesByUserId: vi.fn(),
	getUserByEmail: vi.fn(),
	getUserById: vi.fn(),
}));
vi.mock("@repo/i18n", () => ({
	config: { defaultLocale: "en", localeCookieName: "NEXT_LOCALE" },
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("@repo/mail", () => ({ sendEmail: vi.fn() }));
vi.mock("@repo/notifications", () => ({ createWelcomeNotification: vi.fn() }));
vi.mock("@repo/payments", () => ({ cancelProviderSubscription: vi.fn() }));
vi.mock("@repo/utils", () => ({ getBaseUrl: vi.fn(() => "http://localhost:3000") }));
vi.mock("better-auth", () => ({ betterAuth: vi.fn(() => ({})) }));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: vi.fn(() => ({})) }));
vi.mock("better-auth/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("better-auth/api")>();
	return {
		...actual,
		createAuthMiddleware: vi.fn((handler) => handler),
	};
});
vi.mock("better-auth/plugins", () => ({
	admin: vi.fn(() => ({ id: "admin" })),
	anonymous: vi.fn(() => ({ id: "anonymous" })),
	magicLink: vi.fn(() => ({ id: "magic-link" })),
	openAPI: vi.fn(() => ({ id: "open-api" })),
	organization: vi.fn((options: OrganizationPluginOptions) => {
		organizationPluginCapture.options = options;
		return { id: "organization" };
	}),
	twoFactor: vi.fn(() => ({ id: "two-factor" })),
}));
vi.mock("./anonymous-boundary", () => ({
	getAnonymousBootstrapEmail: vi.fn(),
	runRegisteredUserCreatedLifecycle: vi.fn(),
}));
vi.mock("./organization", () => ({ updateSeatsInOrganizationSubscription: vi.fn() }));
vi.mock("./organization-deletion", () => ({
	cancelOrganizationSubscriptionsBeforeDeletion: vi.fn(),
}));
vi.mock("../plugins/invitation-only", () => ({
	invitationOnlyPlugin: vi.fn(() => ({ id: "invitation-only" })),
}));

describe("Better Auth organization slug hooks", () => {
	beforeAll(async () => {
		await import("../auth");
	});

	it.each(TOP_LEVEL_STATIC_ROUTE_SEGMENTS)(
		"rejects creating an organization at the /%s static route",
		async (slug) => {
			const createHook =
				organizationPluginCapture.options?.organizationHooks?.beforeCreateOrganization;
			expect(createHook).toBeTypeOf("function");

			const validation = createHook!({
				organization: { name: "Route collision", slug },
				user: { id: "user-1" },
			});
			await expect(validation).rejects.toBeInstanceOf(APIError);
			await expect(validation).rejects.toMatchObject({
				status: "BAD_REQUEST",
				body: { code: "ORGANIZATION_SLUG_RESERVED" },
			});
		},
	);

	it.each(TOP_LEVEL_STATIC_ROUTE_SEGMENTS)(
		"rejects updating an organization to the /%s static route",
		async (slug) => {
			const updateHook =
				organizationPluginCapture.options?.organizationHooks?.beforeUpdateOrganization;
			expect(updateHook).toBeTypeOf("function");

			const validation = updateHook!({
				organization: { name: "Route collision", slug },
				member: { id: "member-1", role: "owner" },
				user: { id: "user-1" },
			});
			await expect(validation).rejects.toBeInstanceOf(APIError);
			await expect(validation).rejects.toMatchObject({
				status: "BAD_REQUEST",
				body: { code: "ORGANIZATION_SLUG_RESERVED" },
			});
		},
	);
});
