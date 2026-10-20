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
}));

vi.mock("@auth/lib/api", () => ({ sessionQueryKey: ["session"] }));
vi.mock("@auth/lib/server", () => ({
	getSession: mocks.getSession,
	getOrganizationList: vi.fn(),
}));
vi.mock("@organizations/lib/api", () => ({ organizationListQueryKey: ["organizations"] }));
vi.mock("@payments/lib/server", () => ({ listPurchases: vi.fn() }));
vi.mock("@repo/auth/config", () => ({ config: { organizations: { enable: false } } }));
vi.mock("@repo/payments/config", () => ({ config: { billingAttachedTo: "organization" } }));
vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));
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
	return (
		<p>
			{assets("subtitle")} {edits("subtitle")} {history("subtitle")} {preparation("copying")}{" "}
			{imagePass("returnPending")}
		</p>
	);
}

describe("registered workspace private media messages", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getServerQueryClient.mockImplementation(() => new QueryClient());
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
			});
			expect(markup).toContain(full.media.assets.subtitle);
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
