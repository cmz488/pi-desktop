import { supportsHostChannel } from "../../api";
import { NativePreferences } from "../native/NativePreferences";
import type { ContextManagerMode } from "@percho/shared";
import type { Language } from "../../i18n";
import { useI18nStore, useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { Switch } from "../ui/Switch";
import { Segmented } from "./Segmented";

const CONTEXT_MANAGER_MODES: ContextManagerMode[] = ["evaporation", "off"];

/** 通用设置：所有会话共用的 Pi 模型/工具/上下文，加上界面语言与两个宿主级开关。 */
export function GeneralPanel() {
	const t = useT();
	const language = useI18nStore((s) => s.language);
	const setLanguage = useI18nStore((s) => s.setLanguage);
	const contextManagerMode = useSettingsStore((s) => s.contextManagerMode);
	const setContextManagerMode = useSettingsStore((s) => s.setContextManagerMode);
	const channelWatchEnabled = useSettingsStore((s) => s.channelWatchEnabled);
	const setChannelWatchEnabled = useSettingsStore((s) => s.setChannelWatchEnabled);

	return (
		<div className="flex flex-col gap-6">
			<section className="space-y-3">
				<div>
					<h3 className="text-ui-13 font-medium text-ink">模型、工具与上下文</h3>
					<p className="mt-0.5 text-ui-11 leading-relaxed text-ink-faint">
						所有会话共用这些 Pi 设置；修改后重载生效，启动项需重启进程。
					</p>
				</div>
				<NativePreferences />
			</section>

			<section className="space-y-2 border-t border-border pt-5">
				<h3 className="text-ui-13 font-medium text-ink">{t("settings.language")}</h3>
				<p className="text-ui-11 text-ink-faint">{t("settings.languageHint")}</p>
				<Segmented
					label={t("settings.language")}
					value={language}
					options={(["zh", "en"] as Language[]).map((lang) => ({
						value: lang,
						label: t(`lang.${lang}`),
					}))}
					onChange={setLanguage}
				/>
			</section>

			{supportsHostChannel("contextManager:getConfig") && (
				<section className="space-y-2 border-t border-border pt-5">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<h3 className="text-ui-13 font-medium text-ink">{t("settings.contextManager")}</h3>
						<Segmented
							label={t("settings.contextManager")}
							value={contextManagerMode ?? "off"}
							disabled={contextManagerMode === null}
							options={CONTEXT_MANAGER_MODES.map((mode) => ({
								value: mode,
								label: t(`settings.contextManagerMode.${mode}`),
							}))}
							onChange={(mode) => void setContextManagerMode(mode)}
						/>
					</div>
					<p className="text-ui-11 leading-relaxed text-ink-faint">
						{contextManagerMode ? t(`settings.contextManagerHint.${contextManagerMode}`) : ""}
					</p>
				</section>
			)}

			{supportsHostChannel("channelWatch:getConfig") && (
				<section className="space-y-2 border-t border-border pt-5">
					<div className="flex items-center justify-between gap-4">
						<h3 className="text-ui-13 font-medium text-ink">{t("settings.channelWatch")}</h3>
						<Switch
							checked={channelWatchEnabled === true}
							disabled={channelWatchEnabled === null}
							onCheckedChange={(enabled) => void setChannelWatchEnabled(enabled)}
						/>
					</div>
					<p className="text-ui-11 leading-relaxed text-ink-faint">
						{t("settings.channelWatchHint")}
					</p>
				</section>
			)}
		</div>
	);
}
