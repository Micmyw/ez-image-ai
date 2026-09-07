export const HOME_FAQ_KEYS = [
	"guestAvailability",
	"guestVsFree",
	"editTiers",
	"creditReservation",
	"failedEdits",
	"privateUploads",
	"formats",
	"outputBehavior",
	"stableTiers",
	"annualBilling",
	"cancelSubscription",
	"refundPolicy",
	"commercialUse",
] as const;

export const PRICING_FAQ_KEYS = [
	"guestVsFree",
	"editTiers",
	"creditReservation",
	"failedEdits",
	"annualBilling",
	"cancelSubscription",
	"refundPolicy",
	"commercialUse",
] as const satisfies readonly (typeof HOME_FAQ_KEYS)[number][];

export type HomeFaqKey = (typeof HOME_FAQ_KEYS)[number];
