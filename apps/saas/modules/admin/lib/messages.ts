import type { UnifiedAppMessages } from "@repo/i18n";

import chinese from "./messages/zh-CN.json";

// Private display language, deliberately absent from public locale configuration.
export const ADMIN_DISPLAY_LOCALE = "zh-CN";

type AdminMessages = UnifiedAppMessages["admin"];

const translated = chinese satisfies Pick<
	AdminMessages,
	"title" | "description" | "menu" | "conversion" | "media"
> & {
	capabilities: Pick<AdminMessages["capabilities"], "common" | "analytics">;
};

export function getAdminDisplayMessages(admin: AdminMessages): AdminMessages {
	return {
		...admin,
		...translated,
		capabilities: { ...admin.capabilities, ...translated.capabilities },
	};
}
