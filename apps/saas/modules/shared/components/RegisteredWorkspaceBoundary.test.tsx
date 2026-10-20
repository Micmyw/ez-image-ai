import { getUnifiedMessagesForLocale } from "@repo/i18n";
import { QueryClient } from "@tanstack/react-query";
import { NextIntlClientProvider, useMessages, useTranslations } from "next-intl";
import type { PropsWithChildren } from "react";
import { renderToReadableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getMessages: vi.fn(),
	getServerQueryClient: vi.fn(),
	messages: vi.fn(),
	getOrganizationList: vi.fn(),
	listPurchases: vi.fn(),
	organizations: { enable: false },
	payments: { billingAttachedTo: "organization" },
}));

vi.mock("@auth/lib/api", () => ({ sessionQueryKey: ["session"] }));
vi.mock("@auth/lib/server", () => ({
	getSession: mocks.getSession,
	getOrganizationList: mocks.getOrganizationList,
}));
vi.mock("@organizations/lib/api", () => ({ organizationListQueryKey: ["organizations"] }));
vi.mock("@payments/lib/server", () => ({ listPurchases: mocks.listPurchases }));
vi.mock("@repo/auth/config", () => ({ config: { organizations: mocks.organizations } }));
vi.mock("@repo/payments/config", () => ({ config: mocks.payments }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { payments: { listPurchases: { queryKey: () => ["purchases"] } } },
}));
vi.mock("@shared/lib/server", () => ({ getServerQueryClient: mocks.getServerQueryClient }));
vi.mock("next-intl/server", () => ({ getMessages: mocks.getMessages }));
vi.mock("next/dynamic", async () => ({
	default: (await import("next/dist/shared/lib/app-dynamic")).default,
}));
vi.mock("@auth/components/SessionProvider", () => ({
	SessionProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock("@organizations/components/ActiveOrganizationProvider", () => ({
	ActiveOrganizationProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock("./ConfirmationAlertProvider", () => ({
	ConfirmationAlertProvider: ({ children }: PropsWithChildren) => children,
}));

import { RegisteredWorkspaceBoundary } from "./RegisteredWorkspaceBoundary";
import { RegisteredWorkspaceProviders } from "./RegisteredWorkspaceProviders";

function PrivateMediaProbe() {
	mocks.messages(useMessages());
	const assets = useTranslations("media.assets");
	const edits = useTranslations("media.edits");
	const history = useTranslations("media.history");
	const preparation = useTranslations("media.create.preparation");
	const imagePass = useTranslations("imagePass");
	const settings = useTranslations("settings.account.changeName");
	const support = useTranslations("support");
	return (
		<p>
			{assets("subtitle")} {edits("subtitle")} {history("subtitle")} {preparation("copying")}{" "}
			{imagePass("returnPending")} {settings("title")} {support("title")}
		</p>
	);
}

describe("registered workspace private media messages", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.organizations.enable = false;
		mocks.payments.billingAttachedTo = "organization";
		mocks.getServerQueryClient.mockImplementation(() => new QueryClient());
	});

	it("starts independent account reads together after authentication", async () => {
		mocks.organizations.enable = true;
		mocks.payments.billingAttachedTo = "user";
		mocks.getSession.mockResolvedValue({ user: { id: "member", isAnonymous: false } });
		mocks.getMessages.mockResolvedValue(await getUnifiedMessagesForLocale("en"));
		let finishOrganizations!: (value: unknown[]) => void;
		mocks.getOrganizationList.mockReturnValueOnce(
			new Promise((resolve) => {
				finishOrganizations = resolve;
			}),
		);
		mocks.listPurchases.mockResolvedValue([]);
		const boundary = RegisteredWorkspaceBoundary({ children: "Workspace" });
		try {
			await vi.waitFor(() => {
				expect(mocks.getOrganizationList).toHaveBeenCalledOnce();
				expect(mocks.listPurchases).toHaveBeenCalledOnce();
				expect(mocks.getMessages).toHaveBeenCalledOnce();
			});
		} finally {
			finishOrganizations([]);
			await boundary;
		}
	});

	it.each(["en", "de", "es", "fr"] as const)(
		"restores complete %s media while retaining the parent message namespaces",
		async (locale) => {
			const full = await getUnifiedMessagesForLocale(locale);
			const publicMessages = {
				common: full.common,
				parentOnly: { label: "Inherited application copy" },
				media: { history: { title: full.media.history.title } },
				imagePass: { buy: full.imagePass.buy },
			};
			const onError = vi.fn();
			const stream = await renderToReadableStream(
				<NextIntlClientProvider
					locale={locale}
					messages={publicMessages}
					timeZone="UTC"
					onError={onError}
				>
					<RegisteredWorkspaceProviders
						mediaMessages={full.media}
						imagePassMessages={full.imagePass}
						checkoutReturnMessages={full.checkoutReturn}
						creditPackCheckoutReturnMessages={full.creditPackCheckoutReturn}
						settingsMessages={full.settings}
						supportMessages={full.support}
					>
						<PrivateMediaProbe />
					</RegisteredWorkspaceProviders>
				</NextIntlClientProvider>,
			);
			const markup = await new Response(stream).text();
			expect(mocks.messages).toHaveBeenLastCalledWith({
				...publicMessages,
				media: full.media,
				imagePass: full.imagePass,
				checkoutReturn: full.checkoutReturn,
				creditPackCheckoutReturn: full.creditPackCheckoutReturn,
				settings: full.settings,
				support: full.support,
			});
			expect(markup).toContain(full.media.assets.subtitle);
			expect(markup).toContain(full.settings.account.changeName.title);
			expect(markup).toContain(full.support.title);
			expect(onError).not.toHaveBeenCalled();
		},
	);

	it("loads and passes full media only after the registered session check", async () => {
		const full = await getUnifiedMessagesForLocale("en");
		mocks.getSession.mockResolvedValue({ user: { id: "member", isAnonymous: false } });
		mocks.getMessages.mockResolvedValue(full);
		const result = await RegisteredWorkspaceBoundary({ children: "Workspace content" });
		expect(mocks.getMessages).toHaveBeenCalledOnce();
		expect(result.props.children.type).toBe(RegisteredWorkspaceProviders);
		expect(result.props.children.props).toEqual({
			mediaMessages: full.media,
			imagePassMessages: full.imagePass,
			checkoutReturnMessages: full.checkoutReturn,
			creditPackCheckoutReturnMessages: full.creditPackCheckoutReturn,
			settingsMessages: full.settings,
			supportMessages: full.support,
			children: "Workspace content",
		});
	});

	it.each([
		[null, "/login"],
		[{ user: { id: "guest", isAnonymous: true } }, "/try"],
	])("never fetches private messages for a nonregistered session (%j)", async (session, path) => {
		mocks.getSession.mockResolvedValue(session);
		await expect(
			RegisteredWorkspaceBoundary({ children: "Private workspace" }),
		).rejects.toMatchObject({
			digest: `NEXT_REDIRECT;replace;${path};307;`,
		});
		expect(mocks.getMessages).not.toHaveBeenCalled();
		expect(mocks.getServerQueryClient).not.toHaveBeenCalled();
	});
});
