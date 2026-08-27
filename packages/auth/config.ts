import type { AuthConfig } from "./types";

export const config = {
	enableAnonymousTrial: true,
	enableSignup: true,
	enableMagicLink: true,
	enableSocialLogin: true,
	enablePasskeys: true,
	enablePasswordLogin: true,
	enableTwoFactor: true,
	sessionCookieMaxAge: 60 * 60 * 24 * 30,
	users: {
		enableOnboarding: true,
	},
	organizations: {
		enable: true,
		hideOrganization: false,
		enableUsersToCreateOrganizations: true,
		requireOrganization: false,
		forbiddenOrganizationSlugs: [
			"new-organization",
			"admin",
			"settings",
			"ai-demo",
			"organization-invitation",
			"chatbot",
			"create",
			"edits",
			"history",
			"assets",
			"draft",
		],
	},
} as const satisfies AuthConfig;
