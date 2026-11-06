"use client";

import type { PublicVideoTemplate } from "@repo/config/video-template-library";
import { XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
	type Dispatch,
	type SetStateAction,
} from "react";

type ActivePreview = { key: string; mode: "hover" | "manual" } | null;
const PreviewContext = createContext<{
	active: ActivePreview;
	setActive: Dispatch<SetStateAction<ActivePreview>>;
} | null>(null);
function supportsHoverPreview() {
	return (
		window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
		!window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}
export function TemplatePreviewProvider({ children }: { children: ReactNode }) {
	const [active, setActive] = useState<ActivePreview>(null);
	useEffect(() => {
		const hide = () => {
			if (document.hidden) setActive(null);
		};
		document.addEventListener("visibilitychange", hide);
		return () => document.removeEventListener("visibilitychange", hide);
	}, []);
	return (
		<PreviewContext.Provider value={{ active, setActive }}>{children}</PreviewContext.Provider>
	);
}
export function TemplatePreview({
	template,
	priority = false,
	layout = "card",
}: {
	template: PublicVideoTemplate;
	priority?: boolean;
	layout?: "card" | "detail";
}) {
	const t = useTranslations("videoTemplates");
	const [interactive, setInteractive] = useState(false);
	useEffect(() => setInteractive(true), []);
	const coordinator = useContext(PreviewContext);
	const setActive = coordinator?.setActive;
	const [failed, setFailed] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	// A pointer can arrive while the server-rendered card is still hydrating.
	// Pick it up once the card becomes interactive, without timers or preloading.
	useEffect(() => {
		if (interactive && ref.current?.matches(":hover") && supportsHoverPreview())
			setActive?.((current) =>
				current?.key === template.key ? current : { key: template.key, mode: "hover" },
			);
	}, [interactive, template.key, setActive]);
	const active = coordinator?.active?.key === template.key;
	const manual = active && coordinator?.active?.mode === "manual";
	function stop() {
		coordinator?.setActive((current) => (current?.key === template.key ? null : current));
	}
	useEffect(() => {
		if (!active || !ref.current) return;
		const onEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape")
				setActive?.((current) => (current?.key === template.key ? null : current));
		};
		const observer = new IntersectionObserver((entries) => {
			if (!entries[0]?.isIntersecting)
				coordinator?.setActive((current) => (current?.key === template.key ? null : current));
		});
		observer.observe(ref.current);
		document.addEventListener("keydown", onEscape);
		return () => {
			observer.disconnect();
			document.removeEventListener("keydown", onEscape);
		};
	}, [active, coordinator, template.key, setActive]);
	if (!template.sample) return null;
	return (
		<div
			className="vt-preview"
			ref={ref}
			data-layout={layout}
			data-category={template.category}
			onPointerEnter={(event) => {
				if (event.pointerType !== "mouse" || !supportsHoverPreview()) return;
				setFailed(false);
				coordinator?.setActive((current) =>
					current?.key === template.key ? current : { key: template.key, mode: "hover" },
				);
			}}
			onPointerLeave={() => {
				if (!manual) stop();
			}}
		>
			<Image
				src={template.sample.poster}
				alt={t("sampleAlt", { name: template.name })}
				fill
				sizes="(max-width: 600px) 90vw, (max-width: 1000px) 44vw, 280px"
				loading={priority ? "eager" : "lazy"}
			/>
			{active && template.sample && !failed && (
				<>
					{/* Source examples have no supplied transcript; do not invent captions. */}
					{/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
					<video
						key={template.key}
						src={template.sample.video}
						poster={template.sample.poster}
						controls={manual}
						muted={!manual}
						loop
						playsInline
						autoPlay
						preload="none"
						aria-label={t("sampleAlt", { name: template.name })}
						onError={() => {
							setFailed(true);
							coordinator?.setActive((current) => (current?.key === template.key ? null : current));
						}}
					/>
				</>
			)}
			{template.sample && (
				<button
					className="vt-preview-action"
					data-manual={manual}
					type="button"
					disabled={!interactive || !coordinator}
					onClick={() => {
						setFailed(false);
						if (manual) stop();
						else coordinator?.setActive({ key: template.key, mode: "manual" });
					}}
					aria-label={t(manual ? "closePreview" : active ? "listenPreview" : "playPreview", {
						name: template.name,
					})}
				>
					{manual && <XIcon aria-hidden />}
				</button>
			)}
			{failed && (
				<span className="vt-preview-error" aria-live="polite">
					{t("previewFailed")}
				</span>
			)}
		</div>
	);
}
