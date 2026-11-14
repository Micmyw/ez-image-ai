"use client";

import { useAuthErrorMessages } from "@auth/hooks/errors-messages";
import { fetchSession, sessionQueryKey } from "@auth/lib/api";
import { loadAuthClient, preloadAuthClient } from "@auth/lib/auth-client";
import { beginAuthJourney, finishAuthJourney } from "@auth/lib/auth-journey";
import { authErrorReturnPath, cancelGoogleOneTap } from "@auth/lib/auth-navigation";
import { config } from "@config";
import { zodResolver } from "@hookform/resolvers/zod";
import { OrganizationInvitationAlert } from "@organizations/components/OrganizationInvitationAlert";
import { config as authConfig } from "@repo/auth/config";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@repo/ui/components/form";
import { Input } from "@repo/ui/components/input";
import { useRouter } from "@shared/hooks/router";
import { createJourneyReference, trackGenerationJourney } from "@shared/lib/generation-journey";
import { getSafeRedirectPath } from "@shared/lib/redirect";
import { useQueryClient } from "@tanstack/react-query";
import {
	AlertTriangleIcon,
	ArrowRightIcon,
	EyeIcon,
	EyeOffIcon,
	KeyIcon,
	MailboxIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type BaseSyntheticEvent, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { withQuery } from "ufo";
import { z } from "zod";

import { type OAuthProvider, oAuthProviders } from "../constants/oauth-providers";
import { useSession } from "../hooks/use-session";
import { AuthDraftPreview } from "./AuthDraftPreview";
import { GoogleOneTap } from "./GoogleOneTap";
import { LoginModeSwitch } from "./LoginModeSwitch";
import { SocialSigninButton } from "./SocialSigninButton";

const formSchema = z.union([
	z.object({
		mode: z.literal("magic-link"),
		email: z.email(),
	}),
	z.object({
		mode: z.literal("password"),
		email: z.email(),
		password: z.string().min(1),
	}),
]);

export function LoginForm() {
	const t = useTranslations();
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const router = useRouter();
	const queryClient = useQueryClient();
	const searchParams = useSearchParams();
	const { user, loaded: sessionLoaded } = useSession();

	const [showPassword, setShowPassword] = useState(false);
	const [hydrated, setHydrated] = useState(false);
	const [isPasskeyPending, setIsPasskeyPending] = useState(false);
	const submissionInFlight = useRef(false);
	useEffect(() => setHydrated(true), []);
	const invitationId = searchParams.get("invitationId");
	const email = searchParams.get("email");
	const redirectTo = searchParams.get("redirectTo");

	const form = useForm({
		resolver: zodResolver(formSchema),
		defaultValues: {
			email: email ?? "",
			password: "",
			mode: authConfig.enableMagicLink ? "magic-link" : "password",
		},
	});

	const redirectPath = invitationId
		? `/organization-invitation/${invitationId}`
		: getSafeRedirectPath(redirectTo, config.redirectAfterSignIn);
	useEffect(() => {
		let observed = false;
		const observe = () => {
			if (observed || document.visibilityState !== "visible") return;
			observed = true;
			void trackGenerationJourney({ stage: "auth_viewed", actionRef: createJourneyReference() });
			if (searchParams.has("authError") || searchParams.has("error"))
				finishAuthJourney("cancelled");
		};
		observe();
		document.addEventListener("visibilitychange", observe);
		return () => document.removeEventListener("visibilitychange", observe);
	}, [searchParams]);

	useEffect(() => {
		if (sessionLoaded && user && !user.isAnonymous) {
			router.replace(redirectPath);
		}
	}, [user, sessionLoaded, redirectPath, router]);

	const finishSignIn = async () => {
		const session = await fetchSession();
		if (!session?.user || session.user.isAnonymous) throw new Error("AUTH_SESSION_NOT_READY");
		queryClient.setQueryData(sessionQueryKey, session);
		router.replace(redirectPath);
	};

	const submitForm = form.handleSubmit(async (values) => {
		cancelGoogleOneTap();
		beginAuthJourney(values.mode === "magic-link" ? "magic_link" : "email", redirectPath);
		try {
			const authClient = await loadAuthClient();
			if (values.mode === "password") {
				const { data, error } = await authClient.signIn.email({
					...values,
				});

				if (error) {
					throw error;
				}

				if ((data as any).twoFactorRedirect) {
					router.replace(withQuery("/verify", Object.fromEntries(searchParams.entries())));
					return;
				}

				await finishSignIn();
			} else {
				const { error } = await authClient.signIn.magicLink({
					...values,
					callbackURL: redirectPath,
					errorCallbackURL: authErrorReturnPath(redirectPath, invitationId),
				});

				if (error) {
					throw error;
				}
			}
		} catch (e) {
			form.setError("root", {
				message: getAuthErrorMessage(
					e && typeof e === "object" && "code" in e ? (e.code as string) : undefined,
				),
			});
		}
	});

	const onSubmit = async (event?: BaseSyntheticEvent) => {
		event?.preventDefault();
		if (submissionInFlight.current) return;
		submissionInFlight.current = true;
		try {
			await submitForm(event);
		} finally {
			submissionInFlight.current = false;
		}
	};

	const signInWithPasskey = async () => {
		if (submissionInFlight.current) return;
		submissionInFlight.current = true;
		setIsPasskeyPending(true);
		cancelGoogleOneTap();
		beginAuthJourney("unknown", redirectPath);
		form.clearErrors("root");
		try {
			const authClient = await loadAuthClient();
			const { error } = await authClient.signIn.passkey();

			if (error) {
				throw error;
			}

			await finishSignIn();
		} catch (e) {
			form.setError("root", {
				message: getAuthErrorMessage(
					e && typeof e === "object" && "code" in e ? (e.code as string) : undefined,
				),
			});
		} finally {
			submissionInFlight.current = false;
			setIsPasskeyPending(false);
		}
	};

	const signinMode = form.watch("mode");
	const isSigningIn = form.formState.isSubmitting || isPasskeyPending;

	return (
		<div data-auth-form="login">
			<GoogleOneTap
				enabled={sessionLoaded && (!user || Boolean(user.isAnonymous)) && !isSigningIn}
				redirectPath={redirectPath}
			/>
			<AuthDraftPreview returnPath={redirectPath} />
			<div className="mb-4 gap-2 text-xs font-bold flex items-center tracking-[0.16em] text-[#b79cff] uppercase">
				<SparklesIcon className="size-4" aria-hidden="true" />
				<span>{t("media.create.eyebrow")}</span>
			</div>
			<h1 className="text-2xl font-semibold text-white md:text-3xl text-left tracking-[-0.03em]">
				{t("auth.login.title")}
			</h1>
			<p className="mb-7 mt-2 text-sm leading-6 text-left text-[#b7acbf]">
				{t("auth.login.subtitle")}
			</p>
			{(searchParams.has("authError") || searchParams.has("error")) && (
				<Alert className="mb-4">
					<AlertDescription>{t("auth.login.cancelled")}</AlertDescription>
				</Alert>
			)}

			{form.formState.isSubmitSuccessful && signinMode === "magic-link" ? (
				<Alert variant="success">
					<MailboxIcon />
					<AlertTitle>{t("auth.login.hints.linkSent.title")}</AlertTitle>
					<AlertDescription>{t("auth.login.hints.linkSent.message")}</AlertDescription>
				</Alert>
			) : (
				<>
					{invitationId && <OrganizationInvitationAlert className="mb-6" />}
					{authConfig.enableSocialLogin && (
						<div className="mb-6">
							<SocialSigninButton
								provider="google"
								label={t("auth.login.continueWithGoogle")}
								disabled={!hydrated || isSigningIn}
								className="min-h-12 border-white/20 bg-white hover:bg-white/90 w-full rounded-xl border text-[#21182c] focus-visible:ring-[#b79cff]"
							/>
							<div className="mt-5 gap-3 flex items-center">
								<hr className="border-white/10 flex-1" />
								<p className="text-xs text-[#91869b]">{t("auth.login.orEmail")}</p>
								<hr className="border-white/10 flex-1" />
							</div>
						</div>
					)}

					<Form {...form}>
						<form
							className="space-y-4"
							method="post"
							onSubmit={onSubmit}
							onFocusCapture={preloadAuthClient}
							onPointerEnter={preloadAuthClient}
							aria-busy={isSigningIn}
						>
							{authConfig.enableMagicLink && authConfig.enablePasswordLogin && (
								<LoginModeSwitch
									activeMode={signinMode}
									onChange={(mode) => {
										if (!submissionInFlight.current) {
											form.setValue("mode", mode as typeof signinMode);
										}
									}}
									variant="auth"
								/>
							)}

							{form.formState.errors.root?.message && (
								<Alert variant="error">
									<AlertTriangleIcon />
									<AlertTitle>{form.formState.errors.root.message}</AlertTitle>
								</Alert>
							)}

							<FormField
								control={form.control}
								name="email"
								render={({ field }) => (
									<FormItem>
										<FormLabel>{t("auth.signup.email")}</FormLabel>
										<FormControl>
											<Input
												{...field}
												autoComplete="email"
												disabled={!hydrated || isSigningIn}
												className="h-12 border-white/10 px-4 text-white rounded-xl bg-[#171020] shadow-none focus-visible:border-[#b79cff] focus-visible:ring-[#b79cff]/35 aria-invalid:border-destructive aria-invalid:ring-destructive/25"
											/>
										</FormControl>
									</FormItem>
								)}
							/>

							{authConfig.enablePasswordLogin && signinMode === "password" && (
								<FormField
									control={form.control}
									name="password"
									render={({ field }) => (
										<FormItem className="relative">
											<FormLabel>{t("auth.signup.password")}</FormLabel>
											<FormControl>
												<div className="relative">
													<Input
														type={showPassword ? "text" : "password"}
														className="h-12 border-white/10 px-4 pr-12 text-white rounded-xl bg-[#171020] shadow-none focus-visible:border-[#b79cff] focus-visible:ring-[#b79cff]/35 aria-invalid:border-destructive aria-invalid:ring-destructive/25"
														{...field}
														autoComplete="current-password"
														disabled={!hydrated || isSigningIn}
													/>
													<button
														type="button"
														onClick={() => setShowPassword(!showPassword)}
														className="inset-y-0 right-0 min-h-11 min-w-11 hover:text-white absolute flex items-center justify-center rounded-r-xl text-[#b79cff] transition focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[#b79cff]"
														aria-label={t(
															showPassword ? "auth.login.hidePassword" : "auth.login.showPassword",
														)}
													>
														{showPassword ? (
															<EyeOffIcon className="size-4" />
														) : (
															<EyeIcon className="size-4" />
														)}
													</button>
												</div>
											</FormControl>
											<Link
												href="/forgot-password"
												className="right-0 top-0 rounded text-xs font-medium hover:text-white absolute text-[#a99db2] transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b79cff]"
											>
												{t("auth.login.forgotPassword")}
											</Link>
										</FormItem>
									)}
								/>
							)}

							<Button
								className="min-h-12 text-white w-full rounded-xl bg-[#6c4dff] shadow-[0_15px_36px_-16px_rgba(108,77,255,0.95)] hover:bg-[#7d63ff] focus-visible:ring-[#b79cff] focus-visible:ring-offset-[#21182c]"
								type="submit"
								variant="primary"
								loading={form.formState.isSubmitting}
								disabled={!hydrated || isSigningIn}
							>
								{signinMode === "magic-link"
									? t("auth.login.sendMagicLink")
									: t("auth.login.submit")}
							</Button>
						</form>
					</Form>

					{(authConfig.enablePasskeys ||
						(authConfig.enableSignup && authConfig.enableSocialLogin)) && (
						<>
							<div className="my-6 gap-3 flex items-center">
								<hr className="border-white/10 flex-1" />
								<p className="text-xs font-medium shrink-0 text-[#91869b]">
									{t("auth.login.continueWith")}
								</p>
								<hr className="border-white/10 flex-1" />
							</div>

							<div className="gap-2 sm:grid-cols-2 grid grid-cols-1 items-stretch">
								{authConfig.enableSignup &&
									authConfig.enableSocialLogin &&
									Object.keys(oAuthProviders)
										.filter((providerId) => providerId !== "google")
										.map((providerId) => (
											<SocialSigninButton
												key={providerId}
												provider={providerId as OAuthProvider}
												disabled={isSigningIn}
												className="min-h-11 border-white/10 bg-white/[0.065] text-white hover:bg-white/[0.11] rounded-xl border focus-visible:ring-[#b79cff] focus-visible:ring-offset-[#21182c]"
											/>
										))}

								{authConfig.enablePasskeys && (
									<Button
										variant="secondary"
										className="min-h-11 border-white/[0.08] hover:bg-white/[0.05] hover:text-white sm:col-span-2 w-full rounded-xl border bg-transparent text-[#c9becf] focus-visible:ring-[#b79cff] focus-visible:ring-offset-[#21182c]"
										onClick={() => signInWithPasskey()}
										onFocus={preloadAuthClient}
										onPointerEnter={preloadAuthClient}
										loading={isPasskeyPending}
										disabled={!hydrated || isSigningIn}
										aria-busy={isPasskeyPending}
									>
										<KeyIcon className="mr-1.5 size-4 text-primary" />
										{t("auth.login.loginWithPasskey")}
									</Button>
								)}
							</div>
						</>
					)}

					{authConfig.enableSignup && (
						<div className="mt-7 text-sm text-center">
							<span className="text-[#9f93aa]">{t("auth.login.dontHaveAnAccount")} </span>
							<Link
								href={withQuery("/signup", Object.fromEntries(searchParams.entries()))}
								className="rounded font-semibold hover:text-white text-[#c9b9ff] transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b79cff]"
							>
								{t("auth.login.createAnAccount")}
								<ArrowRightIcon className="ml-1 size-4 inline align-middle" />
							</Link>
						</div>
					)}
				</>
			)}
		</div>
	);
}
