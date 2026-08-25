import type { Page } from "@playwright/test";

const saasUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";

export interface CapturedGrowthEvent {
	name: string;
	properties: Record<string, string>;
}

export async function captureConsentedGrowthEvents(page: Page): Promise<CapturedGrowthEvent[]> {
	await page.context().addCookies([{ name: "consent", value: "true", url: saasUrl }]);
	const events: CapturedGrowthEvent[] = [];
	await page.exposeFunction("__recordEzPicGrowthEvent", (event: CapturedGrowthEvent) => {
		events.push(event);
	});
	await page.addInitScript(() => {
		window.addEventListener("ezpic:growth-event", (event) => {
			const record = (
				window as typeof window & {
					__recordEzPicGrowthEvent: (detail: unknown) => Promise<void>;
				}
			).__recordEzPicGrowthEvent;
			void record((event as CustomEvent).detail);
		});
	});
	return events;
}
