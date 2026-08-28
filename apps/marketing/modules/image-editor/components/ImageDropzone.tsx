"use client";

import { ImageIcon, UploadCloudIcon, XIcon } from "lucide-react";
import { type ChangeEvent, type DragEvent, useRef } from "react";

interface ImageDropzoneProps {
	accept: string;
	error?: string;
	fileName?: string;
	hint: string;
	label: string;
	onClear: () => void;
	onFile: (file: File) => void;
	onUploadStarted: () => void;
	removeLabel: string;
	uploadLabel: string;
}

export function ImageDropzone({
	accept,
	error,
	fileName,
	hint,
	label,
	onClear,
	onFile,
	onUploadStarted,
	removeLabel,
	uploadLabel,
}: ImageDropzoneProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		const nextFile = event.target.files?.[0];
		if (nextFile) onFile(nextFile);
		event.target.value = "";
	}

	function handleDrop(event: DragEvent<HTMLButtonElement>) {
		event.preventDefault();
		const nextFile = event.dataTransfer.files[0];
		if (nextFile) {
			onUploadStarted();
			onFile(nextFile);
		}
	}

	return (
		<div>
			<div className="mb-2 gap-3 flex items-center justify-between">
				<label htmlFor="marketing-reference" className="text-sm font-semibold text-slate-950">
					{label}
				</label>
				{fileName && (
					<button
						type="button"
						onClick={onClear}
						className="gap-1 text-xs font-semibold text-slate-500 hover:text-slate-950 focus-visible:rounded focus-visible:outline-indigo-600 inline-flex items-center underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
					>
						<XIcon className="size-3.5" aria-hidden="true" />
						{removeLabel}
					</button>
				)}
			</div>
			<button
				type="button"
				aria-label={fileName ? `${uploadLabel}: ${fileName}` : uploadLabel}
				aria-describedby={`marketing-reference-hint${error ? " marketing-reference-error" : ""}`}
				onClick={() => {
					onUploadStarted();
					inputRef.current?.click();
				}}
				onDragOver={(event) => event.preventDefault()}
				onDrop={handleDrop}
				className="group min-h-36 border-violet-300 bg-violet-50/70 px-4 py-5 hover:border-violet-500 hover:bg-violet-50 focus-visible:border-violet-600 focus-visible:ring-violet-600 flex w-full cursor-pointer items-center justify-center rounded-xl border border-dashed text-center transition focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
			>
				<span className="gap-2 flex flex-col items-center">
					<span className="size-11 bg-white text-violet-700 shadow-sm ring-violet-100 group-hover:-translate-y-0.5 grid place-items-center rounded-xl ring-1 transition motion-reduce:transform-none">
						{fileName ? (
							<ImageIcon className="size-5" aria-hidden="true" />
						) : (
							<UploadCloudIcon className="size-5" aria-hidden="true" />
						)}
					</span>
					<span className="text-sm font-semibold text-slate-900 max-w-full truncate">
						{fileName || uploadLabel}
					</span>
					<span id="marketing-reference-hint" className="text-xs text-slate-500">
						{hint}
					</span>
				</span>
			</button>
			<input
				ref={inputRef}
				id="marketing-reference"
				aria-describedby={`marketing-reference-hint${error ? " marketing-reference-error" : ""}`}
				aria-invalid={Boolean(error)}
				aria-label={label}
				aria-required="true"
				type="file"
				accept={accept}
				tabIndex={-1}
				className="sr-only"
				onChange={handleChange}
			/>
			{error && (
				<p id="marketing-reference-error" role="alert" className="mt-2 text-sm text-red-700">
					{error}
				</p>
			)}
		</div>
	);
}
