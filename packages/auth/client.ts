import { passkeyClient } from "@better-auth/passkey/client";
import {
	adminClient,
	anonymousClient,
	inferAdditionalFields,
	magicLinkClient,
	oneTapClient,
	organizationClient,
	twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import type { auth } from ".";

export const googleOneTapClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() ?? "";

export const authClient = createAuthClient({
	plugins: [
		inferAdditionalFields<typeof auth>(),
		anonymousClient(),
		magicLinkClient(),
		// Registering does not load GIS; the UI invokes it only with an explicit client ID.
		oneTapClient({
			clientId: googleOneTapClientId,
			autoSelect: false,
			promptOptions: { maxAttempts: 0 },
		}),
		organizationClient(),
		adminClient(),
		passkeyClient(),
		twoFactorClient(),
	],
});

export type AuthClientErrorCodes = typeof authClient.$ERROR_CODES & {
	INVALID_INVITATION: string;
};
