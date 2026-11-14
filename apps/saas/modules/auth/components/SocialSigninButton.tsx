"use client";

import { useAuthErrorMessages } from "@auth/hooks/errors-messages";
import { loadAuthClient, preloadAuthClient } from "@auth/lib/auth-client";
import { beginAuthJourney } from "@auth/lib/auth-journey";
import { authErrorReturnPath, cancelGoogleOneTap } from "@auth/lib/auth-navigation";
import { config } from "@config";
import { Button } from "@repo/ui/components/button";
import { captureRegistrationFirstTouch } from "@shared/lib/purchase-attribution";
import { getSafeRedirectPath } from "@shared/lib/redirect";
import { parseAsString, useQueryState } from "nuqs";
import { useRef, useState } from "react";

import { oAuthProviders } from "../constants/oauth-providers";

export function SocialSigninButton({
	provider,
	className,
	disabled,
	label,
}: {
	provider: keyof typeof oAuthProviders;
	className?: string;
	disabled?: boolean;
	label?: string;
}) {
	const [invitationId] = useQueryState("invitationId", parseAsString);
	const [redirectTo] = useQueryState("redirectTo", parseAsString);
	const providerData = oAuthProviders[provider];
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const submissionInFlight = useRef(false);
	const [pending, setPending] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const redirectPath = invitationId
		? `/organization-invitation/${invitationId}`
		: getSafeRedirectPath(redirectTo, config.redirectAfterSignIn);

	const onSignin = async () => {
		if (disabled || submissionInFlight.current) return;
		submissionInFlight.current = true;
		setPending(true);
		setErrorMessage(null);
		cancelGoogleOneTap();
		beginAuthJourney(provider === "google" ? "google" : "unknown", redirectPath);
		try {
			const [authClient] = await Promise.all([
				loadAuthClient(),
				Promise.resolve()
					.then(captureRegistrationFirstTouch)
					.catch(() => {}),
			]);
			const callbackURL = new URL(redirectPath, window.location.origin);
			const { error } = await authClient.signIn.social({
				provider,
				callbackURL: callbackURL.toString(),
				errorCallbackURL: new URL(
					authErrorReturnPath(redirectPath, invitationId),
					window.location.origin,
				).toString(),
			});
			if (error) throw error;
		} catch (error) {
			setErrorMessage(
				getAuthErrorMessage(
					error && typeof error === "object" && "code" in error
						? (error.code as string)
						: undefined,
				),
			);
		} finally {
			submissionInFlight.current = false;
			setPending(false);
		}
	};

	return (
		<div className="gap-2 min-w-0 flex flex-col">
			<Button
				onClick={() => onSignin()}
				onFocus={preloadAuthClient}
				onPointerEnter={preloadAuthClient}
				variant="secondary"
				type="button"
				className={className}
				loading={pending}
				disabled={disabled || pending}
				aria-busy={pending}
			>
				{providerData.icon && (
					<i className="mr-2 text-primary">
						<providerData.icon className="size-4" />
					</i>
				)}
				{label ?? providerData.name}
			</Button>
			{errorMessage && (
				<p role="alert" className="text-xs text-destructive">
					{errorMessage}
				</p>
			)}
		</div>
	);
}
