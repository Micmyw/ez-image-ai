"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@repo/ui/components/dialog";
import { ArrowUpRightIcon, CheckIcon, CopyIcon, TextIcon } from "lucide-react";
import { useRef, useState } from "react";

import type { LandingPromptSelectedDetail } from "../../landing/lib/prompt-selection";
import {
	applyInspirationPrompt,
	InspirationPrompt,
} from "../../models/components/InspirationPrompt";

import "./example-prompt.css";

type PreviewImage = { src: string; alt: string; width: number; height: number };
type ExamplePromptActionsProps = LandingPromptSelectedDetail & {
	title: string;
	model: string;
	resolution: string;
	image: PreviewImage;
	referenceImage?: PreviewImage;
	transparent?: boolean;
};

export function ExamplePromptActions({
	title,
	model,
	resolution,
	image,
	referenceImage,
	transparent,
	prompt,
	selection,
}: ExamplePromptActionsProps) {
	const [open, setOpen] = useState(false);
	const [applying, setApplying] = useState(false);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
	const pendingUse = useRef(false);

	async function copyPrompt() {
		try {
			await navigator.clipboard.writeText(prompt);
			setCopyState("copied");
		} catch {
			setCopyState("failed");
		}
	}

	return (
		<div className="example-prompt-actions">
			<Dialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (next) {
						setApplying(false);
						setCopyState("idle");
					}
				}}
				onOpenChangeComplete={(next) => {
					if (next || !pendingUse.current) return;
					pendingUse.current = false;
					applyInspirationPrompt({ prompt, selection });
					document
						.querySelector<HTMLTextAreaElement>("#image-editor textarea")
						?.focus({ preventScroll: true });
				}}
			>
				<DialogTrigger
					render={
						<button type="button" className="example-prompt-view">
							<TextIcon size={15} aria-hidden="true" />
							View prompt
						</button>
					}
				/>
				<DialogContent
					className="example-prompt-dialog"
					overlayProps={{ className: "example-prompt-backdrop" }}
					finalFocus={applying ? false : undefined}
				>
					<header className="example-prompt-header">
						<DialogDescription className="example-prompt-meta">
							{model} <span aria-hidden="true"> / </span> {resolution}
							{transparent ? " · Transparent PNG" : ""}
						</DialogDescription>
						<DialogTitle>{title}</DialogTitle>
					</header>
					<div className="example-prompt-body">
						<div className="example-prompt-preview" data-transparent={transparent || undefined}>
							<img src={image.src} alt={image.alt} width={image.width} height={image.height} />
							{referenceImage && (
								<a href={referenceImage.src} download>
									Download reference <span aria-hidden="true">↓</span>
								</a>
							)}
						</div>
						{/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable text needs keyboard access. */}
						<section className="example-prompt-reading" aria-label="Full prompt" tabIndex={0}>
							<p>{prompt}</p>
						</section>
						{/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
					</div>
					<footer className="example-prompt-footer">
						<output className="example-prompt-copy-status">
							{copyState === "failed"
								? "Select the text to copy."
								: copyState === "copied"
									? "Prompt copied"
									: ""}
						</output>
						<button type="button" className="example-prompt-copy" onClick={() => void copyPrompt()}>
							{copyState === "copied" ? (
								<CheckIcon size={15} aria-hidden="true" />
							) : (
								<CopyIcon size={15} aria-hidden="true" />
							)}{" "}
							{copyState === "copied" ? "Copied" : "Copy prompt"}
						</button>
						<button
							type="button"
							className="example-prompt-use"
							onClick={() => {
								pendingUse.current = true;
								setApplying(true);
								setOpen(false);
							}}
						>
							Use this prompt <ArrowUpRightIcon size={15} aria-hidden="true" />
						</button>
					</footer>
				</DialogContent>
			</Dialog>
			<InspirationPrompt prompt={prompt} selection={selection} />
		</div>
	);
}
