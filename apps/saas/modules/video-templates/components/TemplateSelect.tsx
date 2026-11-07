"use client";

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/components/select";

export function TemplateSelect<T extends string | number>({
	id,
	label,
	value,
	items,
	onChange,
	disabled = false,
}: {
	id: string;
	label: string;
	value: T | undefined;
	items: { value: T; label: string }[];
	onChange: (value: T) => void;
	disabled?: boolean;
}) {
	return (
		<div className="vt-field">
			<label htmlFor={id}>{label}</label>
			<Select
				items={items}
				value={value ?? null}
				disabled={disabled}
				onValueChange={(next) => {
					if (next !== null) onChange(next);
				}}
			>
				<SelectTrigger id={id} className="vt-select-trigger">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{items.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
