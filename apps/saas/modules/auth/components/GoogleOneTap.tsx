"use client";

import { fetchSession, sessionQueryKey } from "@auth/lib/api";
import { loadAuthClient } from "@auth/lib/auth-client";
import { beginAuthJourney, finishAuthJourney } from "@auth/lib/auth-journey";
import { cancelGoogleOneTap } from "@auth/lib/auth-navigation";
import { config as authConfig } from "@repo/auth/config";
import { useRouter } from "@shared/hooks/router";
import { captureRegistrationFirstTouch } from "@shared/lib/purchase-attribution";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/** Optional convenience. Its dismissal/failure leaves all ordinary sign-in controls available. */
export function GoogleOneTap({
	enabled,
	redirectPath,
}: {
	enabled: boolean;
	redirectPath: string;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const started = useRef(false);
	useEffect(() => {
		if (
			!enabled ||
			!authConfig.enableGoogleOneTap ||
			!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim()
		)
			return;
		let active = true;
		let starting = false;
		async function start() {
			if (document.visibilityState !== "visible" || started.current || starting) return;
			starting = true;
			try {
				const authClient = await loadAuthClient();
				await Promise.resolve()
					.then(captureRegistrationFirstTouch)
					.catch(() => {});
				if (!active || document.visibilityState !== "visible") return;
				started.current = true;
				beginAuthJourney("google_one_tap", redirectPath);
				await authClient.oneTap({
					autoSelect: false,
					// The plugin must not navigate before a final non-anonymous session is observed.
					fetchOptions: {
						onSuccess: async () => {
							const session = await fetchSession();
							if (!active || !session?.user || session.user.isAnonymous) return;
							queryClient.setQueryData(sessionQueryKey, session);
							router.replace(redirectPath);
						},
					},
					onPromptNotification: (notification) => {
						const reason: unknown =
							notification?.getDismissedReason?.() ?? notification?.getSkippedReason?.();
						if (reason === "tap_outside" || reason === "user_cancel" || reason === "cancel_called")
							finishAuthJourney("cancelled", "google_one_tap");
					},
				});
			} catch {
				/* A blocked GIS script, dismissed prompt or failed callback uses normal sign-in. */
			} finally {
				starting = false;
			}
		}
		void start();
		document.addEventListener("visibilitychange", start);
		return () => {
			active = false;
			document.removeEventListener("visibilitychange", start);
			cancelGoogleOneTap();
		};
	}, [enabled, queryClient, redirectPath, router]);
	return null;
}
