"use client";

import {
	FLYING_CAR_TEMPLATE_KEYS,
	isFlyingCarTemplate,
	type SourceTemplateChoices,
	type SourceTemplateKey,
	type SourceTemplateRole,
} from "@repo/config/video-template-library";
import { useTranslations } from "next-intl";

export function TemplateRoleLabel({
	templateKey,
	role,
	preset,
}: {
	templateKey: SourceTemplateKey;
	role: SourceTemplateRole;
	preset?: SourceTemplateChoices["preset"];
}) {
	const t = useTranslations("videoTemplates");
	if (role === "performer-1" || role === "performer-2") {
		if (templateKey === "green-booth-freestyle")
			return t(role === "performer-1" ? "leftSupport" : "rightLead");
		if ((templateKey === "58th-floor" || templateKey === "source-hotel-lobby") && preset === "duo")
			return t(role === "performer-1" ? "leftPerformer" : "rightPerformer");
	}
	if (templateKey === "spin-me-round" && role.startsWith("performer-"))
		return t("dancer", { number: role.slice(-1) });
	return t(`roles.${role}`);
}

export function FlyingCarVariants({
	templateKey,
	assetId,
	disabled = false,
}: {
	templateKey: SourceTemplateKey;
	assetId?: string | null;
	disabled?: boolean;
}) {
	const t = useTranslations("videoTemplates");
	if (!isFlyingCarTemplate(templateKey)) return null;
	return (
		<div className="vt-field vt-variant-picker">
			<label htmlFor="vt-stunt">{t("flyingVariant")}</label>
			<select
				id="vt-stunt"
				value={templateKey}
				disabled={disabled}
				onChange={(event) => {
					if (!isFlyingCarTemplate(event.target.value)) return;
					window.location.assign(
						`/video-templates/${event.target.value}${assetId ? `?asset=${encodeURIComponent(assetId)}` : ""}`,
					);
				}}
			>
				{FLYING_CAR_TEMPLATE_KEYS.map((key) => (
					<option key={key} value={key}>
						{t(`variants.${key}`)}
					</option>
				))}
			</select>
			<p className="vt-help">{t("flyingVariantHint")}</p>
		</div>
	);
}

export function TemplateFormat({ options }: { options: SourceTemplateChoices }) {
	const t = useTranslations("videoTemplates");
	return (
		<dl className="vt-format" aria-label={t("settingsSummary")}>
			<div>
				<dt>{t("duration")}</dt>
				<dd>
					{options.durationSeconds
						? t("seconds", { count: options.durationSeconds })
						: t("templateDuration")}
				</dd>
			</div>
			{options.resolution && (
				<div>
					<dt>{t("resolution")}</dt>
					<dd>{options.resolution}</dd>
				</div>
			)}
			<div>
				<dt>{t("ratio")}</dt>
				<dd>{options.aspectRatio === "adaptive" ? t("adaptive") : options.aspectRatio}</dd>
			</div>
		</dl>
	);
}
