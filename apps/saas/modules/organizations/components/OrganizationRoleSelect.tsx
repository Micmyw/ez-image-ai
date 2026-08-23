import { useOrganizationMemberRoleOptions } from "@organizations/hooks/member-roles";
import type { OrganizationMemberRole } from "@repo/auth";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/components/select";

export function OrganizationRoleSelect({
	value,
	onSelect,
	disabled,
}: {
	value?: OrganizationMemberRole;
	onSelect: (value: OrganizationMemberRole) => void;
	disabled?: boolean;
}) {
	const roleOptions = useOrganizationMemberRoleOptions();

	return (
		<Select
			value={value}
			items={roleOptions}
			onValueChange={(selectedValue) => {
				if (selectedValue === null) {
					return;
				}
				onSelect(selectedValue);
			}}
			disabled={disabled}
		>
			<SelectTrigger>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{roleOptions.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
