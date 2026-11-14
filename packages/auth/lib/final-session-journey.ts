import { recordGrowthEvent } from "@repo/database";
import { persistGenerationJourneyConfirmation } from "@repo/utils/lib/generation-journey-server";
import { getRequestDefer } from "@repo/utils/request-lifecycle";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/** Keep this plugin last: twoFactor's after hook can revoke an intermediate session. */
export const finalSessionJourneyPlugin = () =>
	({
		id: "ezpic-final-session-journey",
		hooks: {
			after: [
				{
					matcher: (ctx) =>
						/^\/(?:sign-in\/|sign-up\/|callback\/|one-tap\/callback$|magic-link\/verify$|verify-email$|two-factor\/verify-)/.test(
							ctx.path ?? "",
						),
					handler: createAuthMiddleware(async (ctx) => {
						const session = ctx.context.newSession;
						const returned = ctx.context.returned;
						if (
							!session?.user.id ||
							session.user.isAnonymous === true ||
							returned instanceof APIError ||
							(returned &&
								typeof returned === "object" &&
								"twoFactorRedirect" in returned &&
								returned.twoFactorRedirect === true)
						)
							return;
						const headers = ctx.request?.headers ?? ctx.headers;
						if (!headers) return;
						const path = ctx.path;
						const authMethod =
							path === "/one-tap/callback"
								? "google_one_tap"
								: path === "/callback/google" ||
									  (path === "/callback/:id" && ctx.params?.id === "google")
									? "google"
									: path === "/magic-link/verify"
										? "magic_link"
										: path === "/sign-in/email" ||
											  path === "/sign-up/email" ||
											  path === "/verify-email"
											? "email"
											: "unknown";
						const publication = persistGenerationJourneyConfirmation(
							{
								headers,
								stage: "auth_session_established",
								entityKey: session.session.id,
								user: {
									id: session.user.id,
									isAnonymous: false,
									role: typeof session.user.role === "string" ? session.user.role : null,
								},
								impersonated: Boolean(session.session.impersonatedBy),
								authMethod,
							},
							{ save: recordGrowthEvent },
						);
						const defer = getRequestDefer();
						if (defer) {
							try {
								// The website Worker keeps this request's database alive until registered work settles.
								defer(publication);
								return;
							} catch {
								/* Failed registration must drain the already-started write. */
							}
						}
						await publication;
					}),
				},
			],
		},
	}) satisfies BetterAuthPlugin;
