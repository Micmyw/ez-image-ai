type ComparisonSources = { before: string; poster: string };

export type HomepageShowcaseStart = {
	href: string;
	time: number;
	sources: ComparisonSources;
};

export type ShowcasePreloadScript = HTMLScriptElement & {
	homepageShowcaseStart?: HomepageShowcaseStart;
};

type CloseOptions = { immediate?: boolean; restoreFocus?: boolean; afterClose?: () => void };
type PreviewHandlers = {
	onOpenChange: (open: boolean) => void;
	onCreate: (event: MouseEvent) => void;
};
type HomepageShowcaseController = {
	close: (options?: CloseOptions) => void;
	prepareComparison: () => HTMLImageElement | undefined;
	connect: (handlers: PreviewHandlers) => () => void;
};

export type ShowcaseDialogElement = HTMLDialogElement & {
	homepageShowcase?: HomepageShowcaseController;
};

/** Also runs in the initial HTML. Keep this function independent of module state. */
export function mountHomepageShowcase(
	dialog: ShowcaseDialogElement,
	options: {
		sources: ComparisonSources;
		earliestOpen: number | null;
		promptEvent: string;
	},
): HomepageShowcaseController {
	if (dialog.homepageShowcase) return dialog.homepageShowcase;
	const trigger = dialog.previousElementSibling as HTMLButtonElement;
	const entryHref = location.href;
	const signal = new AbortController();
	const events = { signal: signal.signal };
	let timer: number | undefined;
	let closeTimer: number | undefined;
	let consentTimer: number | undefined;
	let autoPending = options.earliestOpen !== null;
	let originalReady = false;
	let previousFocus: HTMLElement | null = null;
	let outsidePointerDown = false;
	let onOpenChange: PreviewHandlers["onOpenChange"] | undefined;
	let onCreate: PreviewHandlers["onCreate"] | undefined;

	const title = () => dialog.querySelector<HTMLElement>("[data-showcase-title]");
	const getConsent = () => document.querySelector<HTMLElement>("[data-consent-banner]");
	const watchConsent = new MutationObserver(() => {
		if (!getConsent() || onOpenChange || consentTimer !== undefined) return;
		// If partial hydration stalls, unblock the page notice. Otherwise the enhanced
		// carousel will render the controls inside the same dialog without moving focus.
		consentTimer = window.setTimeout(() => {
			consentTimer = undefined;
			if (getConsent() && !onOpenChange) close({ immediate: true });
		}, 800);
	});

	function prepareComparison() {
		const images = Array.from(dialog.querySelectorAll<HTMLImageElement>("[data-showcase-source]"));
		for (const image of images) {
			if (image.hasAttribute("src")) continue;
			image.src =
				image.dataset.showcaseSource === "before" ? options.sources.before : options.sources.poster;
			if (image.dataset.showcaseSource === "poster") {
				void image.decode().then(
					() => {
						image
							.closest(".homepage-showcase-comparison")
							?.setAttribute("data-showcase-after-ready", "");
					},
					() => {
						// Keep the original displayed if the edited image is unavailable.
					},
				);
			}
		}
		return images.find((image) => image.dataset.showcaseSource === "before");
	}

	function canOpen() {
		return (
			dialog.isConnected &&
			typeof dialog.showModal === "function" &&
			!dialog.open &&
			!Array.from(
				document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'),
			).some((other) => other.getClientRects().length > 0) &&
			(!!onOpenChange || !getConsent())
		);
	}

	function open(automatic = false) {
		if (!canOpen()) return;
		prepareComparison();
		const active = document.activeElement;
		previousFocus =
			active instanceof HTMLElement &&
			active !== document.body &&
			active !== document.documentElement
				? active
				: trigger;
		dialog.toggleAttribute("data-showcase-auto-open", automatic);
		dialog.showModal();
		autoPending = false;
		window.clearTimeout(timer);
		title()?.focus({ preventScroll: true });
		if (onOpenChange) onOpenChange(true);
		else watchConsent.observe(document.body, { childList: true, subtree: true });
	}

	function close({ immediate = false, restoreFocus = true, afterClose }: CloseOptions = {}) {
		if (!dialog.open || (closeTimer !== undefined && !immediate)) return;
		window.clearTimeout(closeTimer);
		dialog.querySelector("video")?.pause();
		const finish = () => {
			closeTimer = undefined;
			watchConsent.disconnect();
			window.clearTimeout(consentTimer);
			consentTimer = undefined;
			dialog.close();
			delete dialog.dataset.showcaseAutoOpen;
			delete dialog.dataset.showcaseClosing;
			if (restoreFocus) {
				const target = previousFocus?.isConnected ? previousFocus : trigger;
				target?.focus({ preventScroll: true });
			}
			onOpenChange?.(false);
			afterClose?.();
		};
		if (immediate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
			finish();
		} else {
			dialog.dataset.showcaseClosing = "";
			closeTimer = window.setTimeout(finish, 220);
		}
	}

	function reveal() {
		window.clearTimeout(timer);
		if (
			!autoPending ||
			!dialog.isConnected ||
			!originalReady ||
			location.href !== entryHref ||
			document.visibilityState !== "visible"
		)
			return;
		const wait = (options.earliestOpen ?? 0) - performance.now();
		if (wait > 0) {
			timer = window.setTimeout(reveal, wait);
			return;
		}
		const active = document.activeElement;
		// A lazy drawer's trigger is expanded before its dialog enters the document.
		const openingDialog = document.querySelector(
			'[aria-haspopup="dialog"]:is([aria-expanded="true"], :active)',
		);
		if (active?.closest("[data-consent-banner], #image-editor") || openingDialog || !canOpen()) {
			timer = window.setTimeout(reveal, 500);
			return;
		}
		open(true);
	}

	function outside(event: MouseEvent) {
		const { left, right, top, bottom } = dialog.getBoundingClientRect();
		return (
			event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom
		);
	}

	function useSlider(event: Event) {
		const input = event.target;
		if (!(input instanceof HTMLInputElement) || input.type !== "range") return;
		const scene = input.closest<HTMLElement>(".homepage-showcase-comparison");
		if (!scene) return;
		scene.dataset.reveal = "manual";
		scene.style.setProperty("--showcase-position", `${input.value}%`);
		input.setAttribute("aria-valuetext", `${input.dataset.showcaseAfter} ${input.value}%`);
	}

	trigger.addEventListener("click", () => open(), events);
	dialog.addEventListener(
		"cancel",
		(event) => {
			event.preventDefault();
			close();
		},
		events,
	);
	dialog.addEventListener(
		"pointerdown",
		(event) => {
			outsidePointerDown = event.target === dialog && outside(event);
			useSlider(event);
		},
		events,
	);
	dialog.addEventListener("keydown", useSlider, events);
	dialog.addEventListener("input", useSlider, events);
	dialog.addEventListener(
		"click",
		(event) => {
			if (!(event.target instanceof Element)) return;
			if (
				event.target.closest("[data-showcase-close]") ||
				(event.target === dialog && outsidePointerDown && outside(event))
			) {
				close();
				return;
			}
			const link = event.target.closest<HTMLAnchorElement>("[data-showcase-create]");
			if (!link) return;
			if (closeTimer !== undefined) {
				event.preventDefault();
				return;
			}
			if (onCreate) {
				onCreate(event);
				return;
			}
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			const prompt = link.dataset.showcasePrompt;
			// A partially hydrated editor can already own an upload or prompt. Let it accept the idea
			// before following the regular Create link, which also works when the app JS never runs.
			if (
				prompt &&
				!window.dispatchEvent(
					new CustomEvent(options.promptEvent, { cancelable: true, detail: { prompt } }),
				)
			) {
				event.preventDefault();
				close({
					restoreFocus: false,
					afterClose: () => {
						const editor = document.getElementById("image-editor");
						editor
							?.querySelector<HTMLElement>('[data-generator-panel="image"] textarea')
							?.focus({ preventScroll: true });
						editor?.scrollIntoView({ block: "start" });
					},
				});
			}
		},
		events,
	);
	document.addEventListener("visibilitychange", reveal, events);
	function cancelStaleEntry() {
		if (location.href !== entryHref) {
			autoPending = false;
			window.clearTimeout(timer);
			close({ immediate: true, restoreFocus: false });
		}
	}
	window.addEventListener("hashchange", cancelStaleEntry, events);
	window.addEventListener("popstate", cancelStaleEntry, events);

	if (autoPending && typeof dialog.showModal === "function") {
		const original = prepareComparison();
		void original?.decode().then(
			() => {
				if (signal.signal.aborted) return;
				originalReady = true;
				reveal();
			},
			() => {
				// The regular trigger still works if the automatic preview's images are unavailable.
				autoPending = false;
			},
		);
	}

	const controller = {
		close,
		prepareComparison,
		connect(handlers: PreviewHandlers) {
			watchConsent.disconnect();
			window.clearTimeout(consentTimer);
			consentTimer = undefined;
			onOpenChange = handlers.onOpenChange;
			onCreate = handlers.onCreate;
			onOpenChange(dialog.open);
			return () => {
				onOpenChange = undefined;
				onCreate = undefined;
				// Strict Mode can reconnect the existing dialog. Only tear down a removed page.
				queueMicrotask(() => {
					if (dialog.isConnected) return;
					window.clearTimeout(timer);
					window.clearTimeout(closeTimer);
					window.clearTimeout(consentTimer);
					watchConsent.disconnect();
					signal.abort();
				});
			};
		},
	};
	dialog.homepageShowcase = controller;
	return controller;
}
