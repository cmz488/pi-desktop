import { useEffect, useState } from "react";
import { nativeRequest, desktopRequest } from "../../pi-http-bridge";
import { useDesktopWorkspace, useNativeSession } from "../../stores/desktop-workspace";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { COMPOSER_FOCUS_EVENT, useDraftStore, withDraftText } from "../../stores/drafts";
import { Button } from "../ui/Button";
import { Switch } from "../ui/Switch";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptySession, Feedback, Field, inputClass, useSettingsSessionId } from "./NativeControls";

export function NativeSkills() {
	const id = useSettingsSessionId();
	return id ? <SkillResources key={id} id={id} /> : <EmptySession />;
}
function SkillResources({ id }: { id: string }) {
	const { snapshot } = useNativeSession(id);
	const [rows, setRows] = useState<any[]>([]);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [query, setQuery] = useState("");
	const load = async () => {
		const value = await nativeRequest("/api/skills", undefined, id);
		setRows(value.rows);
	};
	useEffect(() => {
		let live = true;
		void nativeRequest("/api/skills", undefined, id)
			.then((value) => {
				if (live) setRows(value.rows);
			})
			.catch((reason: Error) => {
				if (live) setError(reason.message);
			});
		return () => {
			live = false;
		};
	}, [id]);
	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (reason) {
			setError((reason as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const commands = (snapshot?.commands ?? []).filter((row: any) =>
		["prompt", "template", "extension"].includes(row.source),
	);
	const use = (name: string) => {
		const active = useSessionsStore.getState().activeSessionId;
		if (!active || active !== id) {
			setError("请先在左侧打开此会话，再使用命令。");
			return;
		}
		useDraftStore.getState().updateDraft(id, (draft) => withDraftText(draft, `/${name} `));
		useSettingsStore.getState().setOpen(false);
		window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT, { detail: { moveToEnd: true } }));
	};
	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between">
				<h3 className="text-ui-13 font-medium text-ink">技能与提示模板</h3>
				<Button
					disabled={busy}
					onClick={() =>
						void run(async () => {
							await nativeRequest("/api/reload", {}, id);
							await load();
							setMessage("资源已重载。");
						})
					}
				>
					重载资源
				</Button>
			</div>
			<input
				aria-label="搜索技能与模板"
				placeholder="搜索技能、提示模板和扩展命令"
				className={inputClass}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			<Feedback error={error} message={message} />
			<ul className="divide-y divide-border">
				{rows
					.filter((row) =>
						`${row.name} ${row.description}`.toLowerCase().includes(query.toLowerCase()),
					)
					.map((row) => (
						<li key={row.id} className="space-y-1 py-3">
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate text-ui-13 font-medium text-ink">
									{row.name}
								</span>
								<span className="text-ui-10 text-ink-faint">
									{row.scope === "project" ? "项目" : "用户"}
								</span>
								<Switch
									checked={row.enabled}
									disabled={busy}
									aria-label={`启用技能 ${row.name}`}
									onCheckedChange={(enabled) =>
										void run(async () => {
											await nativeRequest(
												"/api/skill",
												{ id: row.id, revision: row.revision, enabled },
												id,
											);
											await load();
											setMessage("技能配置已保存，重载后应用。");
										})
									}
								/>
							</div>
							<p className="text-ui-12 text-ink-dim">{row.description}</p>
							<p className="break-all font-mono text-ui-10 text-ink-faint">{row.path}</p>
							<Button size="sm" disabled={!row.enabled} onClick={() => use(`skill:${row.name}`)}>
								使用技能
							</Button>
						</li>
					))}
			</ul>
			{commands
				.filter((row: any) =>
					`${row.name} ${row.description}`.toLowerCase().includes(query.toLowerCase()),
				)
				.map((row: any) => (
					<div
						key={`${row.source}:${row.name}`}
						className="flex items-center gap-2 border-t border-border py-2"
					>
						<div className="min-w-0 flex-1">
							<p className="text-ui-12 text-ink">/{row.name}</p>
							<p className="text-ui-11 text-ink-faint">{row.description}</p>
						</div>
						<Button size="sm" onClick={() => use(row.name)}>
							使用
						</Button>
					</div>
				))}
			{!rows.length && !commands.length && !error && (
				<p className="py-4 text-ui-12 text-ink-faint">
					尚未发现技能或模板，可在资源设置中调整加载路径。
				</p>
			)}
		</section>
	);
}

export function InstalledPackages() {
	const id = useSettingsSessionId();
	return id ? <PackageResources key={id} id={id} /> : <EmptySession />;
}
function PackageResources({ id }: { id: string }) {
	const { snapshot } = useNativeSession(id);
	const global = useDesktopWorkspace((s) => s.supported);
	const [inventory, setInventory] = useState<any>(null);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [source, setSource] = useState("");
	const [scope, setScope] = useState("global");
	const [query, setQuery] = useState("");
	const [confirmation, setConfirmation] = useState<{
		title: string;
		description: string;
		execute: () => Promise<void>;
	} | null>(null);
	const [editor, setEditor] = useState<any>(null);
	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError("");
		try {
			await action();
		} catch (reason) {
			setError((reason as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const load = async () => {
		setInventory(await nativeRequest("/api/plugins", undefined, id));
	};
	useEffect(() => {
		let live = true;
		void nativeRequest("/api/plugins", undefined, id)
			.then((value) => {
				if (live) setInventory(value);
			})
			.catch((reason: Error) => {
				if (live) setError(reason.message);
			});
		return () => {
			live = false;
		};
	}, [id]);
	const action = (kind: string, row?: any) => {
		const selectedSource = row?.source ?? source;
		const selectedScope = row?.scope ?? scope;
		const revision = row?.revision;
		const inventoryKey = inventory.inventoryKey;
		setConfirmation({
			title: `${{ install: "安装", update: "更新", remove: "移除" }[kind]}插件`,
			description: `${selectedSource} · ${selectedScope === "project" ? "当前项目" : "用户配置"}。使用 Pi 原生包管理规则；不会自动重载。`,
			execute: async () => {
				await nativeRequest(
					"/api/package",
					{
						action: kind,
						source: selectedSource,
						scope: selectedScope,
						revision,
						inventoryKey,
						sessionId: String(snapshot.sessionId),
					},
					id,
				);
				await load();
				setMessage("包操作已完成，重载后应用。");
			},
		});
	};
	const edit = (row: any, resources: boolean) =>
		void run(async () => {
			const doc = await nativeRequest(
				`/${resources ? "api/plugin-resources" : "api/plugin-config"}?id=${encodeURIComponent(row.id)}`,
				undefined,
				id,
			);
			const values = resources
				? Object.fromEntries(
						["extensions", "skills", "prompts", "themes"].map((key) => [
							key,
							Object.hasOwn(doc.values, key) ? JSON.stringify(doc.values[key], null, 2) : "",
						]),
					)
				: Object.fromEntries(
						doc.fields.map((spec: any) => [
							spec.key,
							spec.secret ? "" : (doc.data[spec.key] ?? ""),
						]),
					);
			setEditor({
				row,
				resources,
				doc,
				values,
				autoload: doc.values?.autoload === undefined ? "inherit" : String(doc.values.autoload),
			});
		});
	return (
		<section className="space-y-3">
			<Feedback error={error} message={message} />
			<div className="flex flex-wrap items-center gap-1">
				<Button disabled={busy} onClick={() => void run(load)}>
					刷新
				</Button>
				<Button
					disabled={busy || !inventory?.updatesSupported || !inventory?.writable}
					onClick={() =>
						void run(async () => {
							setInventory(
								await nativeRequest(
									"/api/package-updates",
									{ sessionId: String(snapshot.sessionId) },
									id,
								),
							);
							setMessage("原生更新检查完成；未报告更新不代表已是最新。");
						})
					}
				>
					检查更新
				</Button>
				{global && (
					<Button
						disabled={busy}
						onClick={() =>
							void run(async () => {
								const preview = await desktopRequest("/api/packages/update-all");
								setConfirmation({
									title: "全量更新 Pi 插件",
									description: `${preview.sources.join("、") || "没有用户插件"}。遵循固定版本规则，更新后需重载各会话。`,
									execute: async () => {
										await desktopRequest("/api/packages/update-all", {
											revision: preview.revision,
											inventoryKey: preview.inventoryKey,
										});
										await load();
										setMessage("全量更新完成，重载后应用。");
									},
								});
							})
						}
					>
						全量更新
					</Button>
				)}
				<Button
					disabled={busy}
					onClick={() =>
						void run(async () => {
							await nativeRequest("/api/reload", {}, id);
							await load();
							setMessage("资源已重载。");
						})
					}
				>
					重载并应用
				</Button>
			</div>
			<form
				className="flex flex-wrap items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					action("install");
				}}
			>
				<div className="min-w-40 flex-1">
					<Field label="安装来源">
						<input
							aria-label="安装来源"
							className={inputClass}
							required
							placeholder="npm:包名 或 Git 来源"
							value={source}
							onChange={(event) => setSource(event.target.value)}
						/>
					</Field>
				</div>
				<select
					aria-label="安装范围"
					className={`${inputClass} !w-auto`}
					value={scope}
					onChange={(event) => setScope(event.target.value)}
				>
					<option value="global">用户配置</option>
					<option value="project" disabled={!snapshot?.projectTrusted}>
						当前项目
					</option>
				</select>
				<Button type="submit" disabled={busy || !source.trim() || !inventory?.writable}>
					从来源安装
				</Button>
			</form>
			<input
				aria-label="搜索已安装包"
				className={inputClass}
				placeholder="搜索已安装包"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>
			<ul className="divide-y divide-border">
				{inventory?.rows
					?.filter((row: any) =>
						`${row.name} ${row.source}`.toLowerCase().includes(query.toLowerCase()),
					)
					.map((row: any) => (
						<li key={row.id} className="space-y-2 py-3">
							<div className="flex items-center gap-2">
								<strong className="min-w-0 flex-1 truncate text-ui-13 text-ink">{row.name}</strong>
								<Switch
									aria-label={`${row.enabled ? "停用" : "启用"} ${row.name}`}
									checked={row.enabled}
									disabled={busy || !inventory.writable}
									onCheckedChange={(enabled) =>
										void run(async () => {
											await nativeRequest(
												"/api/plugin",
												{ id: row.id, enabled, revision: row.revision ?? inventory.revision },
												id,
											);
											await load();
											setMessage("扩展配置已保存，重载后应用。");
										})
									}
								/>
							</div>
							<p className="break-all font-mono text-ui-10 text-ink-faint">{row.source}</p>
							<p className="text-ui-12 text-ink-dim">{row.description}</p>
							<p className="text-ui-11 text-ink-faint">
								{row.installedVersion ? `v${row.installedVersion}` : "版本未读取"} ·{" "}
								{row.pending ? "待重载" : row.enabled ? "已启用" : "已停用"}
								{row.updateAvailable ? " · 有更新" : ""}
							</p>
							<div className="flex flex-wrap gap-1">
								{row.adapted && (
									<Button size="sm" disabled={busy} onClick={() => edit(row, false)}>
										配置
									</Button>
								)}
								{row.type === "package" && (
									<>
										<Button
											size="sm"
											disabled={busy || !inventory.writable}
											onClick={() => edit(row, true)}
										>
											资源过滤
										</Button>
										<Button
											size="sm"
											disabled={busy || !inventory.writable}
											onClick={() => action("update", row)}
										>
											原生更新
										</Button>
										<Button
											size="sm"
											tone="danger"
											disabled={busy || !inventory.writable}
											onClick={() => action("remove", row)}
										>
											卸载
										</Button>
									</>
								)}
							</div>
						</li>
					))}
			</ul>
			{editor && (
				<form
					className="space-y-3 rounded-lg border border-border p-3"
					onSubmit={(event) => {
						event.preventDefault();
						void run(async () => {
							const patch: Record<string, unknown> = {};
							for (const [key, raw] of Object.entries(editor.values)) {
								const spec = editor.doc.fields?.find((field: any) => field.key === key);
								if (editor.resources)
									patch[key] = String(raw).trim() ? JSON.parse(String(raw)) : null;
								else if (!spec.secret || raw !== "")
									patch[key] = spec.type === "number" ? Number(raw) : raw;
							}
							if (editor.resources)
								patch.autoload = editor.autoload === "inherit" ? null : editor.autoload === "true";
							await nativeRequest(
								editor.resources ? "/api/plugin-resources" : "/api/plugin-config",
								{ id: editor.row.id, revision: editor.doc.revision, patch },
								id,
							);
							setEditor(null);
							await load();
							setMessage("配置已保存，重载后应用。");
						});
					}}
				>
					<h4 className="text-ui-12 font-medium text-ink">
						{editor.row.name} · {editor.resources ? "资源过滤" : "配置"}
					</h4>
					{Object.entries(editor.values).map(([key, value]) => {
						const spec = editor.doc.fields?.find((field: any) => field.key === key);
						return (
							<Field key={key} label={spec?.label ?? key}>
								{editor.resources ? (
									<textarea
										aria-label={key}
										className={inputClass}
										rows={3}
										value={String(value)}
										onChange={(event) =>
											setEditor({
												...editor,
												values: { ...editor.values, [key]: event.target.value },
											})
										}
									/>
								) : spec.type === "boolean" ? (
									<Switch
										checked={Boolean(value)}
										onCheckedChange={(checked) =>
											setEditor({ ...editor, values: { ...editor.values, [key]: checked } })
										}
									/>
								) : spec.type === "enum" ? (
									<select
										className={inputClass}
										value={JSON.stringify(value)}
										onChange={(event) =>
											setEditor({
												...editor,
												values: { ...editor.values, [key]: JSON.parse(event.target.value) },
											})
										}
									>
										{spec.options.map((option: unknown) => (
											<option key={JSON.stringify(option)} value={JSON.stringify(option)}>
												{String(option)}
											</option>
										))}
									</select>
								) : (
									<input
										className={inputClass}
										type={spec.secret ? "password" : spec.type === "number" ? "number" : "text"}
										value={String(value)}
										onChange={(event) =>
											setEditor({
												...editor,
												values: { ...editor.values, [key]: event.target.value },
											})
										}
									/>
								)}
							</Field>
						);
					})}
					{editor.resources && (
						<Field label="自动加载">
							<select
								className={inputClass}
								value={editor.autoload}
								onChange={(event) => setEditor({ ...editor, autoload: event.target.value })}
							>
								<option value="inherit">包默认</option>
								<option value="true">开启</option>
								<option value="false">仅加载显式资源</option>
							</select>
						</Field>
					)}
					<Button type="submit" variant="primary" disabled={busy}>
						保存资源配置
					</Button>
					<Button onClick={() => setEditor(null)}>取消</Button>
				</form>
			)}
			{confirmation && (
				<ConfirmDialog
					title={confirmation.title}
					description={confirmation.description}
					confirmLabel="确认"
					cancelLabel="取消"
					onCancel={() => setConfirmation(null)}
					onConfirm={() => {
						const action = confirmation.execute;
						setConfirmation(null);
						void run(action);
					}}
				/>
			)}
		</section>
	);
}
