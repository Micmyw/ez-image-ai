"use client";

import { CheckIcon, LockKeyholeIcon } from "lucide-react";
import Image from "next/image";

interface SourcePreviewProps {
	caption: string;
	fileName?: string;
	placeholderAlt: string;
	previewAlt: string;
	previewUrl?: string;
	privateLabel: string;
}

export function SourcePreview({
	caption,
	fileName,
	placeholderAlt,
	previewAlt,
	previewUrl,
	privateLabel,
}: SourcePreviewProps) {
	return (
		<div className="bg-slate-950 p-4 text-white shadow-2xl shadow-indigo-950/20 sm:p-5 relative min-h-[18rem] overflow-hidden rounded-2xl">
			<div
				className="inset-0 absolute opacity-35"
				style={{
					backgroundImage:
						"linear-gradient(rgba(255,255,255,.07) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.07) 1px, transparent 1px)",
					backgroundSize: "28px 28px",
				}}
				aria-hidden="true"
			/>
			<div className="relative flex h-full min-h-[16rem] flex-col">
				<div className="mb-4 font-semibold text-slate-300 flex items-center justify-between text-[0.68rem] tracking-[0.16em] uppercase">
					<span className="gap-2 flex items-center">
						<span className="size-2 bg-emerald-400 rounded-full" aria-hidden="true" />
						{caption}
					</span>
					<span className="gap-1.5 bg-white/10 px-3 py-1.5 tracking-normal text-slate-100 flex items-center rounded-full normal-case">
						<LockKeyholeIcon className="size-3" aria-hidden="true" />
						{privateLabel}
					</span>
				</div>

				<div className="bg-slate-800 ring-white/15 relative flex-1 overflow-hidden rounded-2xl ring-1">
					<Image
						src={previewUrl || "/examples/studio-before.svg"}
						alt={fileName ? previewAlt : placeholderAlt}
						fill
						priority
						unoptimized={Boolean(previewUrl)}
						className="object-cover"
					/>
					<div
						className="inset-4 border-white/30 pointer-events-none absolute border"
						aria-hidden="true"
					>
						<span className="size-5 border-cyan-300 absolute -top-px -left-px border-t-2 border-l-2" />
						<span className="size-5 border-cyan-300 absolute -top-px -right-px border-t-2 border-r-2" />
						<span className="size-5 border-cyan-300 absolute -bottom-px -left-px border-b-2 border-l-2" />
						<span className="size-5 border-cyan-300 absolute -right-px -bottom-px border-r-2 border-b-2" />
					</div>
					{fileName && (
						<div className="right-3 bottom-3 left-3 gap-2 bg-slate-950/80 px-3 py-2 text-xs backdrop-blur absolute flex items-center rounded-xl">
							<span className="size-5 bg-emerald-400 text-emerald-950 grid place-items-center rounded-full">
								<CheckIcon className="size-3" aria-hidden="true" />
							</span>
							<span className="min-w-0 flex-1 truncate">{fileName}</span>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
