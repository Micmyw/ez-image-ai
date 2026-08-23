"use client";

import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/components/select";
import { Textarea } from "@repo/ui/components/textarea";

import { MediaUploader } from "./MediaUploader";

export interface PublicField {
	type: "text" | "select" | "slider" | "aspect-ratio" | "count" | "image-asset" | "video-asset";
	key: string;
	label: string;
	required?: boolean;
	min?: number;
	max?: number;
	step?: number;
	options?: Array<{ value: string; label: string }>;
}

export function GenerationFields({
	fields,
	values,
	onChange,
}: {
	fields: PublicField[];
	values: Record<string, string | number>;
	onChange: (key: string, value: string | number) => void;
}) {
	return (
		<div className="space-y-5">
			{fields.map((field) => (
				<div key={field.key} className="space-y-2">
					<Label htmlFor={`generation-${field.key}`}>{field.label}</Label>
					{field.type === "text" && (
						<Textarea
							id={`generation-${field.key}`}
							value={String(values[field.key] ?? "")}
							required={field.required}
							rows={6}
							onChange={(event) => onChange(field.key, event.target.value)}
						/>
					)}
					{(field.type === "slider" || field.type === "count") && (
						<div className="gap-4 flex items-center">
							<Input
								id={`generation-${field.key}`}
								type={field.type === "slider" ? "range" : "number"}
								min={field.min}
								max={field.max}
								step={field.step}
								value={Number(values[field.key] ?? field.min ?? 1)}
								onChange={(event) => onChange(field.key, Number(event.target.value))}
							/>
							<output className="min-w-10 text-sm text-right tabular-nums">
								{values[field.key] ?? field.min ?? 1}
							</output>
						</div>
					)}
					{(field.type === "select" || field.type === "aspect-ratio") && (
						<Select
							value={String(values[field.key] ?? field.options?.[0]?.value ?? "1:1")}
							onValueChange={(value) => {
								if (value !== null) onChange(field.key, value);
							}}
						>
							<SelectTrigger id={`generation-${field.key}`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(
									field.options ?? [
										{ value: "1:1", label: "Square" },
										{ value: "4:3", label: "Landscape" },
										{ value: "3:4", label: "Portrait" },
									]
								).map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					{(field.type === "image-asset" || field.type === "video-asset") && (
						<MediaUploader
							multiple={false}
							value={values[field.key] ? [String(values[field.key])] : []}
							onChange={(ids) => onChange(field.key, ids[0] ?? "")}
						/>
					)}
				</div>
			))}
		</div>
	);
}
