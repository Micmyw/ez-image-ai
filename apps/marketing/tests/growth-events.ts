import type { Page } from "@playwright/test";

export interface CapturedGrowthEvent {
	name: string;
	properties: Record<string, string>;
}

export async function captureGrowthEvents(page: Page): Promise<CapturedGrowthEvent[]> {
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
