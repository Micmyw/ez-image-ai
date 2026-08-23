"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@repo/auth/client";
import { Button } from "@repo/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/components/dialog";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@repo/ui/components/form";
import { Input } from "@repo/ui/components/input";
import { Textarea } from "@repo/ui/components/textarea";
import { toastError, toastSuccess } from "@repo/ui/components/toast";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type BanUser = {
	id: string;
	name: string | null;
	email: string;
};

type BanUserDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	user: BanUser | null;
};

function getLocalDateValue(date: Date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${year}-${month}-${day}`;
}

function getBanExpiresIn(expirationDate: string) {
	if (!expirationDate) {
		return undefined;
	}

	const expirationTime = new Date(`${expirationDate}T23:59:59.999`).getTime();

	return Math.max(1, Math.floor((expirationTime - Date.now()) / 1000));
}

export function BanUserDialog({ open, onOpenChange, user }: BanUserDialogProps) {
	const translations = useTranslations();
	const queryClient = useQueryClient();
	const today = getLocalDateValue(new Date());
	const banUserSchema = z.object({
		banReason: z.string().trim().min(1, translations("admin.users.ban.validation.reasonRequired")),
		expirationDate: z
			.string()
			.refine(
				(value) => !value || new Date(`${value}T23:59:59.999`).getTime() > Date.now(),
				translations("admin.users.ban.validation.expirationFuture"),
			),
	});
	const form = useForm({
		resolver: zodResolver(banUserSchema),
		defaultValues: {
			banReason: "",
			expirationDate: "",
		},
	});

	useEffect(() => {
		if (open) {
			form.reset();
		}
	}, [form, open, user]);

	const onSubmit = form.handleSubmit(async ({ banReason, expirationDate }) => {
		if (!user) {
			return;
		}

		try {
			if (!expirationDate) {
				const { error: clearExpirationError } = await authClient.admin.updateUser({
					userId: user.id,
					data: {
						banExpires: null,
					},
				});

				if (clearExpirationError) {
					throw clearExpirationError;
				}
			}

			const { error } = await authClient.admin.banUser({
				userId: user.id,
				banReason,
				banExpiresIn: getBanExpiresIn(expirationDate),
			});

			if (error) {
				throw error;
			}

			await queryClient.invalidateQueries({
				queryKey: orpc.admin.users.list.key(),
			});

			toastSuccess(translations("admin.users.ban.notifications.banSuccess"));
			onOpenChange(false);
		} catch {
			toastError(translations("admin.users.ban.notifications.banError"));
		}
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{translations("admin.users.ban.dialog.title")}</DialogTitle>
					<DialogDescription>
						{translations("admin.users.ban.dialog.description", {
							name: user?.name ?? user?.email ?? "",
						})}
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form onSubmit={onSubmit} className="space-y-4">
						<FormField
							control={form.control}
							name="banReason"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{translations("admin.users.ban.fields.reason")}</FormLabel>
									<FormControl>
										<Textarea {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="expirationDate"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{translations("admin.users.ban.fields.expiration")}</FormLabel>
									<FormControl>
										<Input {...field} type="date" min={today} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<DialogFooter>
							<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
								{translations("common.confirmation.cancel")}
							</Button>
							<Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
								{form.formState.isSubmitting
									? translations("admin.users.ban.actions.banning")
									: translations("admin.users.ban.actions.confirmBan")}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}
