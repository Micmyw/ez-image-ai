"use client";

import { Button } from "@repo/ui/components/button";
import { NextIntlClientProvider, useLocale, useMessages, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import {
	studioPanelResourceKind,
	studioPanelResources,
	type StudioPanelResource,
} from "./studio-panel-resources";
import { StudioPanels, type StudioPanelProps } from "./StudioPanels";

/** Panels can open on public editor routes outside RegisteredWorkspaceBoundary.
 * This lightweight boundary starts only the selected view and locale, in parallel. */
export function LocalizedStudioPanels(props: StudioPanelProps) {
	const locale = useLocale();
	const messages = useMessages();
	const t = useTranslations("studio");
	const kind = studioPanelResourceKind(props.panel);
	const key = `${locale}:${kind}`;
	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<{
		key: string;
		attempt: number;
		resource?: StudioPanelResource;
		failed?: boolean;
	} | null>(null);
	const current = state?.key === key && state.attempt === attempt ? state : null;
	const resource = current?.resource ?? studioPanelResources.read(kind, locale);

	useEffect(() => {
		let active = true;
		studioPanelResources.load(kind, locale).then(
			(loaded) => {
				if (active) setState({ key, attempt, resource: loaded });
			},
			() => {
				if (active) setState({ key, attempt, failed: true });
			},
		);
		return () => {
			active = false;
		};
	}, [kind, locale, key, attempt]);

	if (!resource) {
		return current?.failed ? (
			<div role="alert">
				<p className="text-sm">{t("error")}</p>
				<Button
					type="button"
					className="mt-3"
					variant="secondary"
					onClick={() => setAttempt((value) => value + 1)}
				>
					{t("retry")}
				</Button>
			</div>
		) : (
			<output className="text-sm block text-muted-foreground" aria-live="polite">
				{t("loading")}
			</output>
		);
	}

	const selected = resource.messages;
	const media = messages.media;
	return (
		<NextIntlClientProvider
			locale={locale}
			messages={{
				...messages,
				imagePass: selected.imagePass,
				settings: selected.settings,
				media: { ...(media && typeof media === "object" ? media : {}), ...selected.media },
			}}
		>
			<StudioPanels component={resource.component} {...props} />
		</NextIntlClientProvider>
	);
}
