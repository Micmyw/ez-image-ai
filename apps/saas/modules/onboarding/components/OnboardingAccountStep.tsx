"use client";

import { useSession } from "@auth/hooks/use-session";
import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
} from "@repo/ui/components/form";
import { Input } from "@repo/ui/components/input";
import { UserAvatarUpload } from "@settings/components/UserAvatarUpload";
import { ArrowRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type BaseSyntheticEvent, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

const formSchema = z.object({
	name: z.string(),
});

export function OnboardingAccountStep({ onCompleted }: { onCompleted: () => Promise<void> }) {
	const t = useTranslations();
	const { user } = useSession();
	const submissionInFlight = useRef(false);
	const form = useForm({
		resolver: zodResolver(formSchema),
		defaultValues: {
			name: user?.name ?? "",
		},
	});

	useEffect(() => {
		if (user) {
			form.setValue("name", user.name ?? "");
		}
	}, [user]); // oxlint-disable-line eslint-plugin-react-hooks/exhaustive-deps

	const submitForm = form.handleSubmit(async ({ name }) => {
		form.clearErrors("root");

		try {
			const { error } = await authClient.updateUser({
				name,
			});
			if (error) throw error;

			await onCompleted();
		} catch {
			form.setError("root", {
				type: "server",
				message: t("onboarding.notifications.accountSetupFailed"),
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
		<div>
			<Form {...form}>
				<form
					className="gap-8 flex flex-col items-stretch"
					onSubmit={onSubmit}
					aria-busy={form.formState.isSubmitting}
				>
					{form.formState.errors.root?.message && (
						<Alert variant="error">
							<AlertDescription>{form.formState.errors.root.message}</AlertDescription>
						</Alert>
					)}
					<FormField
						control={form.control}
						name="name"
						render={({ field }) => (
							<FormItem>
								<FormLabel>{t("onboarding.account.name")}</FormLabel>
								<FormControl>
									<Input {...field} />
								</FormControl>
							</FormItem>
						)}
					/>

					<FormItem className="gap-4 flex items-center justify-between">
						<div>
							<FormLabel>{t("onboarding.account.avatar")}</FormLabel>

							<FormDescription>{t("onboarding.account.avatarDescription")}</FormDescription>
						</div>
						<FormControl>
							<UserAvatarUpload
								onSuccess={() => {
									return;
								}}
								onError={() => {
									return;
								}}
							/>
						</FormControl>
					</FormItem>

					<Button type="submit" loading={form.formState.isSubmitting}>
						{t("onboarding.continue")}
						<ArrowRightIcon className="ml-2 size-4" />
					</Button>
				</form>
			</Form>
		</div>
	);
}
