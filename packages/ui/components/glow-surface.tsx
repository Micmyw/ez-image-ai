"use client";

import {
	useEffect,
	useImperativeHandle,
	useRef,
	type ComponentPropsWithRef,
	type CSSProperties,
} from "react";

import { cn } from "../lib";

import "./glow-surface.css";

export type GlowSurfaceProps = ComponentPropsWithRef<"div"> & {
	variant?: "ambient" | "frame";
	tone?: "aurora" | "violet" | "cyan";
	intensity?: "subtle" | "normal" | "strong";
	radius?: CSSProperties["borderRadius"];
	interactive?: boolean;
};

/** Decorative light only: children keep their own semantics, layout and input behavior. */
export function GlowSurface({
	variant = "ambient",
	tone = "aurora",
	intensity = "normal",
	radius = "1.75rem",
	interactive = true,
	className,
	style,
	children,
	ref,
	...props
}: GlowSurfaceProps) {
	const surfaceRef = useRef<HTMLDivElement>(null);
	useImperativeHandle(ref, () => surfaceRef.current!, []);

	useEffect(() => {
		const surface = surfaceRef.current;
		if (!surface || !interactive) return;
		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const pointer = window.matchMedia("(any-hover: hover) and (any-pointer: fine)");
		let frame = 0;
		let x = 0;
		let y = 0;
		const reset = () => {
			cancelAnimationFrame(frame);
			frame = 0;
			delete surface.dataset.glowActive;
			surface.style.removeProperty("--glow-x");
			surface.style.removeProperty("--glow-y");
			surface.style.removeProperty("--glow-progress");
		};
		const move = (event: PointerEvent) => {
			if (motion.matches || !pointer.matches || event.pointerType === "touch") return;
			x = event.clientX;
			y = event.clientY;
			if (frame) return;
			frame = requestAnimationFrame(() => {
				const bounds = surface.getBoundingClientRect();
				surface.style.setProperty("--glow-x", `${x - bounds.left}px`);
				surface.style.setProperty("--glow-y", `${y - bounds.top}px`);
				surface.style.setProperty(
					"--glow-progress",
					`${((x - bounds.left) / bounds.width) * 100}%`,
				);
				surface.dataset.glowActive = "true";
				frame = 0;
			});
		};
		surface.addEventListener("pointermove", move, { passive: true });
		surface.addEventListener("pointerleave", reset);
		motion.addEventListener("change", reset);
		pointer.addEventListener("change", reset);
		return () => {
			reset();
			surface.removeEventListener("pointermove", move);
			surface.removeEventListener("pointerleave", reset);
			motion.removeEventListener("change", reset);
			pointer.removeEventListener("change", reset);
		};
	}, [interactive]);

	return (
		<div
			{...props}
			ref={surfaceRef}
			className={cn("glow-surface", className)}
			data-glow-variant={variant}
			data-glow-tone={tone}
			data-glow-intensity={intensity}
			style={
				{
					"--glow-radius": typeof radius === "number" ? `${radius}px` : radius,
					...style,
				} as CSSProperties
			}
		>
			<div className="glow-surface-light" aria-hidden="true" />
			<div className="glow-surface-spot" aria-hidden="true" />
			{children}
		</div>
	);
}
