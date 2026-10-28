import type { ReactNode } from "react";

export type SegmentedOption<T extends string> = {
	value: T;
	label: ReactNode;
	disabled?: boolean;
};

/**
 * 小集合的单选控件（2–4 个选项）：替代设置页里到处都是的原生 `<select>`。
 * 视觉与 Percho 既有的语言/上下文按钮一致（选中 = 墨底反白），并保持 radiogroup 语义。
 */
export function Segmented<T extends string>({
	label,
	value,
	options,
	disabled,
	onChange,
}: {
	label: string;
	value: T;
	options: readonly SegmentedOption<T>[];
	disabled?: boolean;
	onChange: (value: T) => void;
}) {
	return (
		<div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={value === option.value}
					disabled={disabled || option.disabled}
					className={`rounded-lg border px-2.5 py-1 text-ui-12 transition-colors disabled:opacity-40 ${
						value === option.value
							? "border-ink bg-ink text-on-ink"
							: "border-border text-ink-2 hover:border-border-strong hover:bg-hover"
					}`}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
