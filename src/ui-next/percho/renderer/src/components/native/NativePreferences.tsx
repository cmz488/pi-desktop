import { useEffect, useState } from "react";
import { desktopRequest, nativeRequest } from "../../pi-http-bridge";
import { useDesktopWorkspace, useNativeSession } from "../../stores/desktop-workspace";
import { useSessionsStore } from "../../stores/sessions";
import { Button } from "../ui/Button";
import { Switch } from "../ui/Switch";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptySession, Feedback, Field, inputClass, useSettingsSessionId } from "./NativeControls";
import { Segmented } from "../settings/Segmented";

type Spec = {
	key: string;
	label: string;
	type: string;
	default?: unknown;
	options?: unknown[];
	help?: string;
	globalOnly?: boolean;
	secret?: boolean;
};
type Group = { id: string; title: string; fields: Spec[] };
type SettingsDocument = {
	revision: string;
	scope: string;
	file: string;
	groups: Group[];
	values: Record<string, unknown>;
	inherited?: Record<string, unknown>;
	trusted?: boolean;
};
// Category navigation preserves the original write revision, so stale drafts still conflict.
const settingsDrafts = new Map<string, { revision: string; values: Record<string, unknown> }>();

export function NativePreferences({ group }: { group?: string }) {
	const id = useSettingsSessionId();
	return id ? <PreferencesForm key={id} id={id} group={group} /> : <EmptySession />;
}
function PreferencesForm({ id, group }: { id: string; group?: string }) {
	const { snapshot } = useNativeSession(id);
	const [scope, setScope] = useState("global");
	const [nextScope, setNextScope] = useState<string | null>(null);
	const [doc, setDoc] = useState<SettingsDocument | null>(null);
	const [draft, setDraft] = useState<Record<string, unknown>>(
		settingsDrafts.get(`${id}:global`)?.values ?? {},
	);
	const [search, setSearch] = useState("");
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [version, setVersion] = useState(0);
	useEffect(() => {
		let live = true;
		setDoc(null);
		setError("");
		setDraft(settingsDrafts.get(`${id}:${scope}`)?.values ?? {});
		void nativeRequest(`/api/settings?scope=${scope}`, undefined, id)
			.then((value) => {
				if (live) setDoc(value);
			})
			.catch((reason: Error) => {
				if (live) setError(reason.message);
			});
		return () => {
			live = false;
		};
	}, [id, scope, version]);
	const change = (key: string, value: unknown) =>
		setDraft((previous) => {
			const next = { ...previous, [key]: value };
			settingsDrafts.set(`${id}:${scope}`, {
				values: next,
				revision: settingsDrafts.get(`${id}:${scope}`)?.revision ?? doc!.revision,
			});
			return next;
		});
	const save = async () => {
		if (!doc || !snapshot || busy) return;
		setBusy(true);
		setError("");
		try {
			const patch: Record<string, unknown> = {};
			for (const spec of doc.groups.flatMap((row) => row.fields))
				if (Object.hasOwn(draft, spec.key)) {
					const value = draft[spec.key];
					patch[spec.key] =
						value === null
							? null
							: spec.type === "object"
								? JSON.parse(String(value))
								: spec.type === "array"
									? String(value)
											.split("\n")
											.map((v) => v.trim())
											.filter(Boolean)
									: ["number", "auto-number"].includes(spec.type)
										? value === "auto"
											? "auto"
											: Number(value)
										: value;
				}
			await nativeRequest(
				"/api/settings",
				{
					scope,
					revision: settingsDrafts.get(`${id}:${scope}`)?.revision ?? doc.revision,
					patch,
					sessionId: String(snapshot.sessionId),
				},
				id,
			);
			settingsDrafts.delete(`${id}:${scope}`);
			setDraft({});
			setVersion((v) => v + 1);
			setMessage("配置已保存，重载后应用；网络代理、存储路径等启动项需重启所属进程。");
		} catch (reason) {
			setError((reason as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const reload = async () => {
		setBusy(true);
		setError("");
		try {
			await nativeRequest("/api/reload", {}, id);
			setMessage("资源已重载并应用。");
			setVersion((v) => v + 1);
			await useSessionsStore.getState().loadModels();
		} catch (reason) {
			setError((reason as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const count = Object.keys(draft).length;
	return (
		<section className="space-y-6" aria-label="原生 Pi 配置">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0">
					<Segmented
						label="配置范围"
						value={scope}
						options={[
							{ value: "global", label: "用户配置" },
							{ value: "project", label: "当前项目" },
						]}
						onChange={(value) => (count ? setNextScope(value) : setScope(value))}
					/>
					<p className="mt-2 break-all font-mono text-ui-10 text-ink-faint">
						{doc?.file ?? snapshot?.cwd}
					</p>
				</div>
				<input
					className={`${inputClass} sm:w-52`}
					aria-label="搜索 Pi 配置"
					placeholder="搜索设置"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</div>
			<Feedback error={error} message={message} />
			{!doc && !error && (
				<p role="status" className="text-ui-12 text-ink-faint">
					读取配置…
				</p>
			)}
			<div className="space-y-5">
				{doc?.groups
					.filter((row) =>
						!group ? !["network", "resources", "display"].includes(row.id) : row.id === group,
					)
					.map((row) => {
						const fields = row.fields.filter((spec) =>
							`${spec.label} ${spec.key}`.toLowerCase().includes(search.toLowerCase()),
						);
						return fields.length ? (
							<fieldset
								key={row.id}
								className="space-y-3 border-t border-border pt-5 first:border-t-0 first:pt-0"
								disabled={busy || (scope === "project" && doc.trusted === false)}
							>
								<legend className="text-ui-12 font-medium text-ink">{row.title}</legend>
								<div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
									{fields.map((spec) => {
										const raw = Object.hasOwn(draft, spec.key) ? draft[spec.key] : undefined;
										const stored =
											doc.values[spec.key] ?? doc.inherited?.[spec.key] ?? spec.default;
										const value =
											raw === undefined
												? spec.secret
													? ""
													: spec.type === "object"
														? JSON.stringify(stored ?? {}, null, 2)
														: spec.type === "array"
															? (Array.isArray(stored) ? stored : []).join("\n")
															: (stored ?? "")
												: raw === null
													? spec.type === "boolean"
														? false
														: ""
													: raw;
										const disabled = scope === "project" && spec.globalOnly;
										const inherited =
											doc.values[spec.key] !== undefined || doc.inherited?.[spec.key] !== undefined;
										const wide = ["array", "object"].includes(spec.type);
										return (
											<div
												key={spec.key}
												className={wide ? "space-y-1 sm:col-span-2" : "space-y-1"}
											>
												<Field label={spec.label} hint={disabled ? "仅用户配置可修改" : spec.help}>
													{spec.type === "boolean" ? (
														<Switch
															checked={Boolean(value)}
															disabled={disabled}
															onCheckedChange={(checked) => change(spec.key, checked)}
														/>
													) : spec.type === "enum" ? (
														<select
															aria-label={spec.label}
															className={inputClass}
															disabled={disabled}
															value={JSON.stringify(value)}
															onChange={(event) => change(spec.key, JSON.parse(event.target.value))}
														>
															{spec.options?.map((option) => (
																<option key={JSON.stringify(option)} value={JSON.stringify(option)}>
																	{String(option)}
																</option>
															))}
														</select>
													) : wide ? (
														<textarea
															aria-label={spec.label}
															rows={3}
															className={`${inputClass} font-mono`}
															disabled={disabled}
															value={String(value)}
															onChange={(event) => change(spec.key, event.target.value)}
														/>
													) : (
														<input
															aria-label={spec.label}
															className={inputClass}
															type={
																spec.secret
																	? "password"
																	: spec.type === "number"
																		? "number"
																		: "text"
															}
															disabled={disabled}
															value={String(value)}
															onChange={(event) => change(spec.key, event.target.value)}
														/>
													)}
												</Field>
												{inherited && (
													<button
														type="button"
														className="text-ui-10 text-ink-faint transition-colors hover:text-ink disabled:opacity-40"
														disabled={disabled || busy}
														onClick={() => change(spec.key, null)}
													>
														恢复默认
													</button>
												)}
											</div>
										);
									})}
								</div>
							</fieldset>
						) : null;
					})}
			</div>
			{scope === "project" && doc?.trusted === false && (
				<p role="status" className="text-ui-12 text-ink-faint">
					请先在左侧会话菜单中信任项目，再修改项目配置。
				</p>
			)}
			<div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t border-border bg-surface px-1 py-3">
				<span className="mr-auto text-ui-11 text-ink-faint">
					{count ? `${count} 项未保存` : "没有未保存的修改"}
				</span>
				<Button
					disabled={busy || !count}
					onClick={() => {
						settingsDrafts.delete(`${id}:${scope}`);
						setDraft({});
					}}
				>
					放弃修改
				</Button>
				<Button
					variant="primary"
					disabled={busy || !count || !doc || !snapshot}
					onClick={() => void save()}
				>
					保存修改
				</Button>
				<Button disabled={busy || count > 0} onClick={() => void reload()}>
					重载并应用
				</Button>
			</div>
			{nextScope && (
				<ConfirmDialog
					title="切换配置范围"
					description="当前表单有未保存的修改。放弃后切换配置范围？"
					confirmLabel="放弃并切换"
					cancelLabel="取消"
					onCancel={() => setNextScope(null)}
					onConfirm={() => {
						settingsDrafts.delete(`${id}:${scope}`);
						setScope(nextScope);
						setNextScope(null);
					}}
				/>
			)}
		</section>
	);
}

export function PersonalityPanel() {
	const supported = useDesktopWorkspace((s) => s.supported);
	const [doc, setDoc] = useState<any>(null);
	const [content, setContent] = useState("");
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let live = true;
		if (supported)
			void desktopRequest("/api/personality")
				.then((value) => {
					if (live) {
						setDoc(value);
						setContent(value.content);
					}
				})
				.catch((reason: Error) => {
					if (live) setError(reason.message);
				});
		return () => {
			live = false;
		};
	}, [supported]);
	if (supported === false)
		return <p className="text-ui-12 text-ink-faint">人格配置由当前 Pi 宿主管理。</p>;
	return (
		<section className="space-y-5">
			<p className="max-w-[62ch] text-ui-11 leading-relaxed text-ink-faint">
				全局 AGENTS.md 应用到所有项目与会话。会话默认继承 Pi 全局设置，不再单独配置。
			</p>
			<Feedback error={error} message={message} />
			{doc && (
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						setBusy(true);
						setError("");
						const revision = doc.revision;
						void desktopRequest("/api/personality", { content, revision })
							.then((result) => {
								setDoc(result);
								setMessage(
									result.reloadRequired?.length
										? "已保存，部分会话需重载后应用。"
										: "人格已保存并应用。",
								);
							})
							.catch((reason: Error) => setError(reason.message))
							.finally(() => setBusy(false));
					}}
				>
					<p className="break-all font-mono text-ui-10 text-ink-faint">{doc.file}</p>
					<Field label="全局 AGENTS.md" hint="保存后应用到所有会话">
						<textarea
							aria-label="全局 AGENTS.md"
							rows={16}
							className={`${inputClass} font-mono`}
							value={content}
							onChange={(event) => setContent(event.target.value)}
						/>
					</Field>
					<div className="flex justify-end">
						<Button type="submit" variant="primary" disabled={busy}>
							保存并应用
						</Button>
					</div>
				</form>
			)}
		</section>
	);
}
