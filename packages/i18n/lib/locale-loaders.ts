// Keep each namespace statically addressable. Broad dynamic import contexts also
// pulled application and administration copy into email-only and proxy bundles.
import type { Locale } from "../config";

export const marketingMessages = {
	en: () => import("../translations/en/marketing.json"),
	de: () => import("../translations/de/marketing.json"),
	es: () => import("../translations/es/marketing.json"),
	fr: () => import("../translations/fr/marketing.json"),
} satisfies Record<Locale, () => Promise<{ default: Record<string, unknown> }>>;

export const saasMessages = {
	en: () => import("../translations/en/saas.json"),
	de: () => import("../translations/de/saas.json"),
	es: () => import("../translations/es/saas.json"),
	fr: () => import("../translations/fr/saas.json"),
} satisfies Record<Locale, () => Promise<{ default: Record<string, unknown> }>>;

export const mailMessages = {
	en: () => import("../translations/en/mail.json"),
	de: () => import("../translations/de/mail.json"),
	es: () => import("../translations/es/mail.json"),
	fr: () => import("../translations/fr/mail.json"),
} satisfies Record<Locale, () => Promise<{ default: Record<string, unknown> }>>;

export const sharedMessages = {
	en: () => import("../translations/en/shared.json"),
	de: () => import("../translations/de/shared.json"),
	es: () => import("../translations/es/shared.json"),
	fr: () => import("../translations/fr/shared.json"),
} satisfies Record<Locale, () => Promise<{ default: Record<string, unknown> }>>;

export const videoMessages = {
	en: () => import("../translations/en/video.json"),
	de: () => import("../translations/de/video.json"),
	es: () => import("../translations/es/video.json"),
	fr: () => import("../translations/fr/video.json"),
} satisfies Record<Locale, () => Promise<{ default: Record<string, unknown> }>>;
