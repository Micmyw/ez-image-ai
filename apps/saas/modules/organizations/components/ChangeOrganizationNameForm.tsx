"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useActiveOrganization } from "@organizations/hooks/use-active-organization";
import { organizationListQueryKey } from "@organizations/lib/api";
import { authClient } from "@repo/auth/client";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { toastError, toastSuccess } from "@repo/ui/components/toast";
import { SettingsItem } from "@shared/components/SettingsItem";
import { useRouter } from "@shared/hooks/router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

const formSchema = z.object({
	name: z.string().min(3),
});

export function ChangeOrganizationNameForm() {
	const t = useTranslations();
	const router = useRouter();
	const queryClient = useQueryClient();
	const { activeOrganization, refetchActiveOrganization } = useActiveOrganization();

	const form = useForm({
		resolver: zodResolver(formSchema),
		defaultValues: {
			name: activeOrganization?.name ?? "",
		},
	});

	useEffect(() => {
		if (!activeOrganization?.name) {
			return;
		}
		form.reset({ name: activeOrganization.name });
	}, [activeOrganization?.id, activeOrganization?.name, form]);

	const onSubmit = form.handleSubmit(async ({ name }) => {
		if (!activeOrganization) {
			return;
		}

		try {
			const { error } = await authClient.organization.update({
				organizationId: activeOrganization.id,
				data: {
					name,
				},
			});

			if (error) {
				throw error;
			}

			await queryClient.refetchQueries({ queryKey: organizationListQueryKey });

			await refetchActiveOrganization();

			router.refresh();

			toastSuccess(t("organizations.settings.changeName.notifications.success"));

			form.reset({ name });
		} catch {
			toastError(t("organizations.settings.changeName.notifications.error"));
		}
	});

	return (
		<SettingsItem title={t("organizations.settings.changeName.title")}>
			<form onSubmit={onSubmit}>
				<Input {...form.register("name")} />

				<div className="mt-4 flex justify-end">
					<Button
						type="submit"
						disabled={!(form.formState.isValid && form.formState.dirtyFields.name)}
						loading={form.formState.isSubmitting}
					>
						{t("settings.save")}
					</Button>
				</div>
			</form>
		</SettingsItem>
	);
}
