import DOMPurify from "dompurify";
import { useMemo } from "react";
import type { DesktopPresentation } from "@percho/shared";
import { createExtensionAdapterRegistry } from "../../../../../../shared/extension-adapters.mjs";

const registry = createExtensionAdapterRegistry();

/** The same adapter registry and sanitizer as the workbench; extension scripts stay in Pi. */
export function DesktopExtensionMessage({
	desktop,
}: {
	desktop: DesktopPresentation;
}) {
	const html = useMemo(
		() => DOMPurify.sanitize(registry.render(desktop.extensionView)),
		[desktop.extensionView],
	);
	return (
		<section className="desktop-card" aria-label="扩展卡片">
			{html ? (
				<div dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				<p role="status">此扩展卡片没有可用的展示适配器</p>
			)}
		</section>
	);
}
