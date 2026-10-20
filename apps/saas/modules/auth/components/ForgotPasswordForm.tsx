"use client";

import { useAuthErrorMessages } from "@auth/hooks/errors-messages";
import { loadAuthClient, preloadAuthClient } from "@auth/lib/auth-client";
import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@repo/ui/components/form";
import { Input } from "@repo/ui/components/input";
import { AlertTriangleIcon, ArrowLeftIcon, MailboxIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { type BaseSyntheticEvent, useRef } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

const formSchema = z.object({
	email: z.email(),
});

export function ForgotPasswordForm() {
	const t = useTranslations();
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const submissionInFlight = useRef(false);

	const form = useForm({
		resolver: zodResolver(formSchema),
		defaultValues: {
			email: "",
		},
	});

	const submitForm = form.handleSubmit(async ({ email }) => {
		try {
			const authClient = await loadAuthClient();
			const redirectTo = new URL("/reset-password", window.location.origin).toString();

			const { error } = await authClient.requestPasswordReset({
				email,
				redirectTo,
			});

			if (error) {
				throw error;
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

	return (
		<>
			<h1 className="font-bold text-xl md:text-2xl text-center">
				{t("auth.forgotPassword.title")}
			</h1>
			<p className="mt-1 mb-6 text-center text-balance text-foreground/60">
				{t("auth.forgotPassword.message")}{" "}
			</p>

			{form.formState.isSubmitSuccessful ? (
				<Alert variant="success">
					<MailboxIcon />
					<AlertTitle>{t("auth.forgotPassword.hints.linkSent.title")}</AlertTitle>
					<AlertDescription>{t("auth.forgotPassword.hints.linkSent.message")}</AlertDescription>
				</Alert>
			) : (
				<Form {...form}>
					<form
						className="gap-4 flex flex-col items-stretch"
						onSubmit={onSubmit}
						onFocusCapture={preloadAuthClient}
						onPointerEnter={preloadAuthClient}
						aria-busy={form.formState.isSubmitting}
					>
						{form.formState.errors.root && (
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
									<FormLabel>{t("auth.forgotPassword.email")}</FormLabel>
									<FormControl>
										<Input {...field} autoComplete="email" />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
							{t("auth.forgotPassword.submit")}
						</Button>
					</form>
				</Form>
			)}

			<div className="mt-6 text-sm text-center">
				<Link href="/login">
					<ArrowLeftIcon className="mr-1 size-4 inline align-middle" />
					{t("auth.forgotPassword.backToSignin")}
				</Link>
			</div>
		</>
	);
}
