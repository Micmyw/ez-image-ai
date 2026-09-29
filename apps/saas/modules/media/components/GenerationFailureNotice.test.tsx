import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import messages from "../../../../../packages/i18n/translations/en/saas.json";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: { credits?: string }) =>
		(messages.media.failure as Record<string, string>)[key]?.replace(
			"{credits}",
			values?.credits ?? "",
		) ?? key,
}));

import { GenerationFailureNotice } from "./GenerationFailureNotice";

const job = {
	status: "FAILED",
	failureReason: "GENERATION_TIMEOUT",
	creditsReserved: "5",
	creditsCharged: "0",
	creditsReleased: "5",
};

describe("GenerationFailureNotice", () => {
	it("explains a technical timeout and the actual returned amount without blaming the prompt", () => {
		const text = renderToStaticMarkup(<GenerationFailureNotice job={job} />);
		expect(text).toContain("generation service timed out");
		expect(text).toContain("5 reserved credits have been returned");
		expect(text).toContain("prompt and settings are saved");
		expect(text).not.toMatch(/Kie|524|violation|adjust the instruction/i);
	});
	it("does not promise returned credits until settlement is complete", () => {
		const text = renderToStaticMarkup(
			<GenerationFailureNotice job={{ ...job, creditsReleased: "0" }} />,
		);
		expect(text).toContain("returning your reserved credits");
		expect(text).not.toContain("have been returned");
	});
	it("describes an unknown result without promising a refund or a retry", () => {
		const text = renderToStaticMarkup(
			<GenerationFailureNotice
				job={{ ...job, status: "NEEDS_RECONCILIATION", creditsReleased: "0" }}
			/>,
		);
		expect(text).toContain("checking the generation result");
		expect(text).not.toMatch(/have been returned|try again|queued/);
	});
	it("keeps content-safety handling separate and explains an expired reference", () => {
		expect(
			renderToStaticMarkup(
				<GenerationFailureNotice job={{ ...job, failureReason: "CONTENT_NOT_ALLOWED" }} />,
			),
		).toBe("");
		expect(
			renderToStaticMarkup(
				<GenerationFailureNotice job={{ ...job, inputReferenceState: "EXPIRED" }} />,
			),
		).toContain("select a reference image again");
	});
});
