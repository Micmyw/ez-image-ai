import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./PendingSubscriptionCheckout", () => ({ PendingSubscriptionCheckout: () => null }));

const testState = vi.hoisted(() => ({
	availabilityInputs: [] as Array<{ interval: "month" | "year"; planId: string }>,
	ownerId: "user-1",
	anonymous: false,
	orgId: null as string | null,
	behavior: false,
	cursor: 0,
	slots: [] as { current?: unknown; value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
	action: null as { key: string; stage: "starting" | "redirecting" } | null,
	checkout: vi.fn(),
	acquire: vi.fn(),
	release: vi.fn(),
	redirecting: vi.fn(),
	started: vi.fn(),
	bindReturn: vi.fn(),
	pendingReads: [] as unknown[],
	pendingCache: new Map<string, { id: string } | null>(),
}));

vi.mock("react", async (original) => {
	const react = await original<typeof import("react")>();
	return {
		...react,
		useRef: (value: unknown) =>
			testState.behavior
				? (testState.slots[testState.cursor++] ??= { current: value })
				: react.useRef(value),
		useState: (value: unknown) => {
			if (!testState.behavior) return react.useState(value);
			const slot = (testState.slots[testState.cursor++] ??= { value });
			return [
				slot.value,
				(next: unknown) => {
					slot.value = next;
				},
			];
		},
		useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
			if (!testState.behavior) return react.useEffect(effect, deps);
			const index = testState.cursor++,
				prior = testState.slots[index];
			if (prior?.deps && deps.every((value, i) => value === prior.deps![i])) return;
			prior?.cleanup?.();
			testState.slots[index] = { deps, cleanup: effect() || undefined };
		},
	};
});
vi.mock("@payments/hooks/use-payment-action", () => ({
	usePaymentAction: () => ({
		action: testState.action,
		getSnapshot: () => testState.action,
		acquire: testState.acquire,
		release: testState.release,
		redirecting: testState.redirecting,
	}),
}));
vi.mock("@shared/lib/purchase-attribution", () => ({
	captureCheckoutTrigger: vi.fn(),
	clearCheckoutTrigger: vi.fn(),
	getCurrentCheckoutAttribution: vi.fn(async () => ({})),
}));
vi.mock("../../video-effects/lib/payment-return", () => ({
	bindVideoEffectPaymentReturn: testState.bindReturn,
}));

vi.mock("@auth/lib/api", () => ({
	useSessionQuery: () => ({
		data: {
			user: { id: testState.ownerId, isAnonymous: testState.anonymous },
			session: { activeOrganizationId: testState.orgId },
		},
	}),
}));

vi.mock("@payments/hooks/plan-data", () => ({
	usePlanData: () => ({
		planData: {
			creator: { title: "Pro", description: "Pro plan", features: [] },
			ultimate: { title: "Ultimate", description: "Ultimate plan", features: [] },
			studio: { title: "Max", description: "Max plan", features: [] },
		},
	}),
}));
vi.mock("@repo/payments/config", () => ({
	config: {
		plans: {
			creator: {
				prices: [
					{ type: "subscription", amount: 19, currency: "USD", interval: "month" },
					{ type: "subscription", amount: 190, currency: "USD", interval: "year" },
				],
			},
			ultimate: {
				recommended: true,
				prices: [
					{ type: "subscription", amount: 49, currency: "USD", interval: "month" },
					{ type: "subscription", amount: 490, currency: "USD", interval: "year" },
				],
			},
			studio: {
				prices: [
					{ type: "subscription", amount: 79, currency: "USD", interval: "month" },
					{ type: "subscription", amount: 790, currency: "USD", interval: "year" },
				],
			},
		},
	},
}));
vi.mock("@repo/ui", () => ({
	cn: (...values: unknown[]) => values.filter((value) => typeof value === "string").join(" "),
}));
vi.mock("@repo/ui/components/button", () => ({
	Button: ({
		children,
		loading: _loading,
		variant: _variant,
		...props
	}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
		loading?: boolean;
		variant?: string;
	}) => <button {...props}>{children}</button>,
}));
vi.mock("@repo/ui/components/tabs", () => ({
	Tabs: ({ children, value }: { children: React.ReactNode; value: string }) => (
		<div data-selected-interval={value}>{children}</div>
	),
	TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => (
		<button data-interval={value}>{children}</button>
	),
}));
vi.mock("@shared/hooks/locale-currency", () => ({ useLocaleCurrency: () => "USD" }));
vi.mock("@shared/hooks/router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@shared/lib/growth-analytics", () => ({
	saasGrowthFunnel: { checkoutStarted: testState.started },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			getPendingSubscriptionCheckout: { queryOptions: () => ({ pendingCheckout: true }) },
			createCheckoutLink: { mutationOptions: () => ({}) },
			getProviderAvailability: {
				queryOptions: ({ input }: { input: { interval: "month" | "year"; planId: string } }) => ({
					input,
				}),
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	keepPreviousData: (data: unknown) => data,
	useQueryClient: () => ({ prefetchQuery: vi.fn() }),
	useMutation: () => ({ mutateAsync: testState.checkout }),
	useQuery: ({
		input,
		queryKey,
	}: {
		input?: { interval: "month" | "year"; planId: string };
		queryKey?: unknown;
	}) => {
		if (!input) {
			testState.pendingReads.push(queryKey);
			return {
				data: testState.pendingCache.get(JSON.stringify(queryKey)) ?? null,
				isPending: false,
				isError: false,
			};
		}
		testState.availabilityInputs.push(input);
		return {
			data: {
				providers: [{ name: "paypal", capabilities: { checkout: true } }],
			},
			isError: false,
			isPending: false,
		};
	},
}));
vi.mock("next-intl", () => ({
	useLocale: () => "en",
	useFormatter: () => ({
		number: (value: number, { currency }: { currency: string }) => `${currency} ${value}`,
	}),
	useTranslations: () => (key: string) => key,
}));
vi.mock("./PaymentProviderSelector", () => ({
	PaymentProviderSelector: ({ name }: { name: string }) => <div data-provider-selector={name} />,
}));

import { PricingTable } from "./PricingTable";

function renderCheckout() {
	testState.behavior = true;
	testState.cursor = 0;
	return PricingTable({ userId: testState.ownerId });
}
function checkout(node: React.ReactElement): (provider: "paypal") => Promise<void> {
	const props = node.props as {
		onCheckout?: (provider: "paypal") => Promise<void>;
		children?: React.ReactNode;
	};
	if (props.onCheckout) return props.onCheckout;
	for (const child of React.Children.toArray(props.children)) {
		if (!React.isValidElement(child)) continue;
		try {
			return checkout(child);
		} catch {}
	}
	throw new Error("checkout control missing");
}
async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("PricingTable", () => {
	it("shows subscription management instead of a second paid checkout for subscribers", () => {
		const markup = renderToStaticMarkup(<PricingTable userId="user-1" activePlanId="ultimate" />);
		expect(markup).toContain("pricing.subscriptionAlreadyExists");
		expect(markup).not.toContain("data-provider-selector");
		expect(markup).not.toContain("pricing.choosePlan");
	});
	beforeEach(() => {
		vi.clearAllMocks();
		testState.availabilityInputs.length = 0;
		testState.pendingReads.length = 0;
		testState.pendingCache.clear();
		testState.ownerId = "user-1";
		testState.anonymous = false;
		testState.orgId = null;
		testState.behavior = false;
		testState.slots = [];
		testState.action = null;
		testState.checkout.mockReset();
		testState.started.mockResolvedValue(undefined);
		testState.acquire.mockImplementation((key: string) => {
			if (testState.action) return false;
			testState.action = { key, stage: "starting" };
			return true;
		});
		testState.release.mockImplementation(() => {
			testState.action = null;
		});
		testState.redirecting.mockImplementation(() => {
			if (testState.action) testState.action = { ...testState.action, stage: "redirecting" };
		});
		vi.stubGlobal("window", {
			location: { href: "https://example.test/pricing", pathname: "/pricing", search: "" },
		});
	});
	afterEach(() => {
		for (const slot of testState.slots) slot.cleanup?.();
		vi.unstubAllGlobals();
	});

	it("defaults authenticated subscription selection to yearly billing", () => {
		const markup = renderToStaticMarkup(<PricingTable userId="user-1" />);

		expect(markup).toContain('data-selected-interval="year"');
		expect(markup).toContain("USD 190");
		expect(markup).toContain("USD 490");
		expect(markup).toContain("USD 790");
	});

	it("renders checkout controls and provider availability for Ultimate", () => {
		const markup = renderToStaticMarkup(<PricingTable userId="user-1" />);

		expect(markup).toContain('data-provider-selector="ultimate-year-provider"');
		expect(testState.availabilityInputs).toContainEqual({ planId: "ultimate", interval: "year" });
	});
	it("shares the owned pending-checkout cache and unlocks when read-only status closes it", () => {
		const key = ["pending-subscription-checkout", "user-1"];
		testState.pendingCache.set(JSON.stringify(key), { id: "intent" });
		const pending = renderToStaticMarkup(<PricingTable userId="user-1" />);
		expect(testState.pendingReads).toContainEqual(key);
		expect(
			pending
				.match(/<button\b(?=[^>]*data-test="subscription-checkout")[^>]*>/g)
				?.every((button) => button.includes("disabled")),
		).toBe(true);
		testState.pendingCache.set(JSON.stringify(key), null);
		const closed = renderToStaticMarkup(<PricingTable userId="user-1" />);
		expect(
			closed
				.match(/<button\b(?=[^>]*data-test="subscription-checkout")[^>]*>/g)
				?.some((button) => !button.includes("disabled")),
		).toBe(true);
	});
	it("does not reuse another owner's pending checkout after sign-in changes", () => {
		testState.pendingCache.set(JSON.stringify(["pending-subscription-checkout", "user-1"]), {
			id: "old-intent",
		});
		testState.ownerId = "user-2";
		const markup = renderToStaticMarkup(<PricingTable userId="user-2" />);
		expect(testState.pendingReads).toContainEqual(["pending-subscription-checkout", "user-2"]);
		expect(
			markup
				.match(/<button\b(?=[^>]*data-test="subscription-checkout")[^>]*>/g)
				?.some((button) => !button.includes("disabled")),
		).toBe(true);
	});
	it("does not put an anonymous session in an owned checkout cache", () => {
		testState.anonymous = true;
		renderToStaticMarkup(<PricingTable userId="user-1" />);
		expect(testState.pendingReads).toContainEqual(["pending-subscription-checkout", null]);
	});
	it("releases only its pending action on unmount and ignores the late checkout", async () => {
		let resolve!: (value: unknown) => void;
		testState.checkout.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const pending = checkout(renderCheckout())("paypal");
		await flush();
		for (const slot of testState.slots) slot.cleanup?.();
		expect(testState.action).toBeNull();
		resolve({ checkoutLink: "https://paypal.example/old", checkoutIntentId: "old" });
		await pending;
		expect(window.location.href).toBe("https://example.test/pricing");
		expect(testState.bindReturn).not.toHaveBeenCalled();
		expect(testState.started).not.toHaveBeenCalled();
	});
	it("ignores the prior owner and organization and gives the new scope a fresh attempt", async () => {
		let resolve!: (value: unknown) => void;
		testState.checkout.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const old = checkout(renderCheckout())("paypal");
		await flush();
		const oldKey = testState.checkout.mock.calls[0]![0].idempotencyKey;
		testState.ownerId = "user-2";
		testState.orgId = "org-2";
		renderCheckout();
		testState.checkout.mockResolvedValueOnce({
			checkoutLink: "https://paypal.example/new",
			checkoutIntentId: "new",
		});
		const current = checkout(renderCheckout())("paypal");
		await current;
		expect(testState.checkout).toHaveBeenCalledTimes(2);
		expect(testState.checkout.mock.calls[1]![0].idempotencyKey).not.toBe(oldKey);
		const currentAction = testState.action;
		resolve({ checkoutLink: "https://paypal.example/old", checkoutIntentId: "old" });
		await old;
		expect(window.location.href).toBe("https://paypal.example/new");
		expect(testState.action).toBe(currentAction);
		expect(testState.bindReturn).toHaveBeenCalledOnce();
		expect(testState.bindReturn).toHaveBeenCalledWith("user-2", "new", "/pricing");
	});
	it("does not redirect or release a newer action with the same plan key", async () => {
		let resolve!: (value: unknown) => void;
		testState.checkout.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const pending = checkout(renderCheckout())("paypal");
		await flush();
		testState.release();
		testState.acquire("plan:creator");
		const newer = testState.action;
		resolve({ checkoutLink: "https://paypal.example/old", checkoutIntentId: "old" });
		await pending;
		expect(window.location.href).toBe("https://example.test/pricing");
		expect(testState.action).toBe(newer);
		expect(testState.bindReturn).not.toHaveBeenCalled();
		expect(testState.started).not.toHaveBeenCalled();
	});
	it("keeps a newer same-key action when the prior request fails or unmounts", async () => {
		let reject!: (error: Error) => void;
		testState.checkout.mockImplementationOnce(
			() =>
				new Promise((_done, fail) => {
					reject = fail;
				}),
		);
		const pending = checkout(renderCheckout())("paypal");
		await flush();
		testState.release();
		testState.acquire("plan:creator");
		const newer = testState.action;
		for (const slot of testState.slots) slot.cleanup?.();
		expect(testState.action).toBe(newer);
		reject(new Error("old response lost"));
		await pending;
		expect(testState.action).toBe(newer);
		expect(testState.release).toHaveBeenCalledOnce();
	});
	it("preserves normal redirecting state during navigation cleanup", async () => {
		testState.checkout.mockResolvedValueOnce({
			checkoutLink: "https://paypal.example/current",
			checkoutIntentId: "current",
		});
		await checkout(renderCheckout())("paypal");
		expect(window.location.href).toBe("https://paypal.example/current");
		const redirecting = testState.action;
		expect(redirecting?.stage).toBe("redirecting");
		for (const slot of testState.slots) slot.cleanup?.();
		expect(testState.action).toBe(redirecting);
		expect(testState.release).not.toHaveBeenCalled();
	});
});
