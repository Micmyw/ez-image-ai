import { EmailVerification } from "./EmailVerification";
import { ForgotPassword } from "./ForgotPassword";
import { MagicLink } from "./MagicLink";
import { Notification } from "./Notification";
import { OrganizationInvitation } from "./OrganizationInvitation";

export const mailTemplates = {
	magicLink: MagicLink,
	forgotPassword: ForgotPassword,
	organizationInvitation: OrganizationInvitation,
	emailVerification: EmailVerification,
	notification: Notification,
} as const;
