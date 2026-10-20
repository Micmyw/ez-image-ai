"use client";

import { useAuthErrorMessages } from "@auth/hooks/errors-messages";
import { useSession } from "@auth/hooks/use-session";
import { loadAuthClient, preloadAuthClient } from "@auth/lib/auth-client";
import { config } from "@config";
import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, AlertTitle } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@repo/ui/components/form";
import { passwordSchema } from "@repo/utils";
import { PasswordInput } from "@shared/components/PasswordInput";
import { useRouter } from "@shared/hooks/router";
import { AlertTriangleIcon, ArrowLeftIcon, MailboxIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type BaseSyntheticEvent, useRef } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

const formSchema = z.object({
	password: passwordSchema,
});

export function ResetPasswordForm() {
	const t = useTranslations();
	const { user } = useSession();
	const router = useRouter();
	const { getAuthErrorMessage } = useAuthErrorMessages();
	const searchParams = useSearchParams();
	const token = searchParams.get("token");
	const submissionInFlight = useRef(false);

	const form = useForm({
		resolver: zodResolver(formSchema),
		defaultValues: {
			password: "",
		},
	});

	const submitForm = form.handleSubmit(async ({ password }) => {
		try {
			const authClient = await loadAuthClient();
			const { error } = await authClient.resetPassword({
				token: token ?? undefined,
				newPassword: password,
			});

			if (error) {
				throw error;
			}

			if (user) {
				router.push(config.redirectAfterSignIn);
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
			<h1 className="font-bold text-xl md:text-2xl text-center">{t("auth.resetPassword.title")}</h1>
			<p className="mt-1 mb-6 text-center text-balance text-foreground/60">
				{t("auth.resetPassword.message")}{" "}
			</p>

			{form.formState.isSubmitSuccessful ? (
				<Alert variant="success">
					<MailboxIcon />
					<AlertTitle>{t("auth.resetPassword.hints.success")}</AlertTitle>
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
							name="password"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("auth.resetPassword.newPassword")}</FormLabel>
									<FormControl>
										<PasswordInput
											autoComplete="new-password"
											showPasswordCriteria
											showGenerateButton
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<Button loading={form.formState.isSubmitting}>{t("auth.resetPassword.submit")}</Button>
					</form>
				</Form>
			)}

			<div className="mt-6 text-sm text-center">
				<Link href="/login">
					<ArrowLeftIcon className="mr-1 size-4 inline align-middle" />
					{t("auth.resetPassword.backToSignin")}
				</Link>
			</div>
		</>
	);
}
