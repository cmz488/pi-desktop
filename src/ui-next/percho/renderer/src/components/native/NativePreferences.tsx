import { useEffect, useState } from "react";
import { desktopRequest, desktopSessions, nativeRequest } from "../../pi-http-bridge";
import {
	useDesktopWorkspace,
	useNativeSession,
	type PromptProfile,
} from "../../stores/desktop-workspace";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { Button } from "../ui/Button";
import { Switch } from "../ui/Switch";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptySession, Feedback, Field, inputClass, useSettingsSessionId } from "./NativeControls";

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
			settingsDrafts.set(`${id}:${scope}`, { values: next, revision: settingsDrafts.get(`${id}:${scope}`)?.revision ?? doc!.revision });
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
				{ scope, revision: settingsDrafts.get(`${id}:${scope}`)?.revision ?? doc.revision, patch, sessionId: String(snapshot.sessionId) },
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
		<section className="space-y-4" aria-label="原生 Pi 配置">
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-ui-13 font-medium text-ink">
					{group ? "Pi 原生设置" : "模型、工具与上下文"}
				</h3>
				<select
					aria-label="配置范围"
					className={`${inputClass} !w-auto`}
					value={scope}
					onChange={(event) =>
						count ? setNextScope(event.target.value) : setScope(event.target.value)
					}
				>
					<option value="global">用户配置</option>
					<option value="project">当前项目</option>
				</select>
			</div>
			<p className="break-all font-mono text-ui-10 text-ink-faint">{doc?.file ?? snapshot?.cwd}</p>
			<input
				className={inputClass}
				aria-label="搜索 Pi 配置"
				placeholder="搜索设置"
				value={search}
				onChange={(event) => setSearch(event.target.value)}
			/>
			<Feedback error={error} message={message} />
			{!doc && !error && (
				<p role="status" className="text-ui-12 text-ink-faint">
					读取配置…
				</p>
			)}
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
							className="space-y-4 border-t border-border pt-4"
							disabled={busy || (scope === "project" && doc.trusted === false)}
						>
							<legend className="pr-2 text-ui-12 font-medium text-ink">{row.title}</legend>
							{fields.map((spec) => {
								const raw = Object.hasOwn(draft, spec.key) ? draft[spec.key] : undefined;
								const stored = doc.values[spec.key] ?? doc.inherited?.[spec.key] ?? spec.default;
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
								return (
									<div key={spec.key} className="space-y-1">
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
											) : ["array", "object"].includes(spec.type) ? (
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
														spec.secret ? "password" : spec.type === "number" ? "number" : "text"
													}
													disabled={disabled}
													value={String(value)}
													onChange={(event) => change(spec.key, event.target.value)}
												/>
											)}
										</Field>
										<Button
											size="sm"
											disabled={disabled || busy}
											onClick={() => change(spec.key, null)}
										>
											恢复继承值
										</Button>
									</div>
								);
							})}
						</fieldset>
					) : null;
				})}
			{scope === "project" && doc?.trusted === false && (
				<p role="status" className="text-ui-12 text-ink-faint">
					请先在左侧会话菜单中信任项目，再修改项目配置。
				</p>
			)}
			<div className="sticky bottom-0 flex flex-wrap items-center gap-2 bg-surface py-2">
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
	const workspace = useDesktopWorkspace((s) => s.workspace);
	const supported = useDesktopWorkspace((s) => s.supported);
	const [doc, setDoc] = useState<any>(null);
	const [content, setContent] = useState("");
	const [profile, setProfile] = useState<PromptProfile | null>(null);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [profileRevision, setProfileRevision] = useState<string>();
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
	const edit = (row?: PromptProfile) =>
		void run(async () => {
			const revision = workspace?.revision;
			const detail = row
				? await desktopRequest(`/api/workspace/detail?kind=prompt&id=${encodeURIComponent(row.id)}`)
				: { id: "", name: "", instructions: "" };
			setProfile(detail);
			setProfileRevision(revision);
		});
	if (supported === false)
		return <p className="text-ui-12 text-ink-faint">人格配置由当前 Pi 宿主管理。</p>;
	return (
		<section className="space-y-4">
			<h3 className="text-ui-13 font-medium text-ink">人格与提示词</h3>
			<p className="text-ui-11 text-ink-faint">
				全局 AGENTS.md 应用到所有项目；会话可在左侧菜单中选择追加的人格。
			</p>
			<Feedback error={error} message={message} />
			{doc && (
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						const revision = doc.revision;
						void run(async () => {
							const result = await desktopRequest("/api/personality", { content, revision });
							setDoc(result);
							setMessage(
								result.reloadRequired?.length
									? "已保存，部分会话需重载后应用。"
									: "人格已保存并应用。",
							);
						});
					}}
				>
					<p className="break-all font-mono text-ui-10 text-ink-faint">{doc.file}</p>
					<Field label="全局 AGENTS.md">
						<textarea
							aria-label="全局 AGENTS.md"
							rows={10}
							className={inputClass}
							value={content}
							onChange={(event) => setContent(event.target.value)}
						/>
					</Field>
					<Button type="submit" variant="primary" disabled={busy}>
						保存并应用
					</Button>
				</form>
			)}
			<div className="flex items-center justify-between border-t border-border pt-4">
				<h4 className="text-ui-12 font-medium text-ink">可选人格</h4>
				<Button onClick={() => edit()} disabled={busy}>
					新建人格
				</Button>
			</div>
			{workspace?.promptProfiles.map((row) => (
				<div key={row.id} className="flex items-center justify-between py-1 text-ui-12 text-ink">
					<span>{row.name}</span>
					<Button onClick={() => edit(row)} disabled={busy}>
						编辑
					</Button>
				</div>
			))}
			{profile && (
				<form
					className="space-y-3 rounded-lg border border-border p-3"
					onSubmit={(event) => {
						event.preventDefault();
						void run(async () => {
							await useDesktopWorkspace
								.getState()
								.command(
									"prompt.save",
									profile.id || undefined,
									{ name: profile.name, instructions: profile.instructions },
									profileRevision,
								);
							setProfile(null);
							setMessage("人格已保存。");
						});
					}}
				>
					<Field label="人格名称">
						<input
							aria-label="人格名称"
							required
							className={inputClass}
							value={profile.name}
							onChange={(event) => setProfile({ ...profile, name: event.target.value })}
						/>
					</Field>
					<Field label="系统提示词">
						<textarea
							aria-label="系统提示词"
							rows={8}
							className={inputClass}
							value={profile.instructions ?? ""}
							onChange={(event) => setProfile({ ...profile, instructions: event.target.value })}
						/>
					</Field>
					<Button type="submit" variant="primary" disabled={busy}>
						保存人格
					</Button>
					<Button onClick={() => setProfile(null)}>取消</Button>
				</form>
			)}
		</section>
	);
}

export function AgentSettingsPanel() {
	const workspace = useDesktopWorkspace((s) => s.workspace);
	const current = useSettingsSessionId();
	const requested = useUiStore((s) => s.settingsAgentId);
	const [id, setId] = useState(requested ?? current);
	const selected = id ?? current;
	return (
		<section className="space-y-4">
			<h3 className="text-ui-13 font-medium text-ink">会话配置</h3>
			<Field label="配置会话">
				<select
					className={inputClass}
					aria-label="配置会话"
					value={selected ?? ""}
					onChange={(event) => setId(event.target.value)}
				>
					<option value="" disabled>
						选择会话
					</option>
					{workspace?.agents
						.filter((row) => row.status === "running" && !row.archived)
						.map((row) => (
							<option key={row.id} value={row.id}>
								{row.name}
							</option>
						))}
				</select>
			</Field>
			{selected ? (
				<>
					<AgentPolicy id={selected} />
					<AgentForm key={selected} id={selected} />
				</>
			) : (
				<EmptySession />
			)}
		</section>
	);
}
function AgentPolicy({ id }: { id: string }) {
	const workspace = useDesktopWorkspace((s) => s.workspace);
	const row = workspace?.agents.find((agent) => agent.id === id);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const change = async (command: string, extra: Record<string, unknown>) => {
		if (!workspace) return;
		setBusy(true);
		setError("");
		try {
			await useDesktopWorkspace.getState().command(command, id, extra, workspace.revision);
		} catch (reason) {
			setError((reason as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return row ? (
		<div className="space-y-3 border-b border-border pb-4">
			<Feedback error={error} />
			<Field label="追加人格">
				<select
					aria-label="追加人格"
					className={inputClass}
					disabled={busy}
					value={row.promptProfileId ?? "standard"}
					onChange={(event) => void change("agent.prompt", { promptProfileId: event.target.value })}
				>
					<option value="standard">Pi 默认</option>
					{workspace?.promptProfiles.map((profile) => (
						<option key={profile.id} value={profile.id}>
							{profile.name}
						</option>
					))}
				</select>
			</Field>
			<Field label="审批模式">
				<select
					aria-label="审批模式"
					className={inputClass}
					disabled={busy}
					value={row.approvalMode ?? "ask-risky"}
					onChange={(event) => void change("agent.policy", { mode: event.target.value })}
				>
					<option value="ask-risky">风险操作确认</option>
					<option value="ask-all">全部确认</option>
					<option value="yolo">完全访问</option>
				</select>
			</Field>
		</div>
	) : null;
}
function AgentForm({ id }: { id: string }) {
	const [descriptor, setDescriptor] = useState<any>(null);
	const [form, setForm] = useState<any>(null);
	const [environment, setEnvironment] = useState("");
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const load = async () => {
		const data = await nativeRequest("/api/agent", undefined, id);
		setDescriptor(data);
		setForm(data.active);
		setEnvironment("");
	};
	useEffect(() => {
		let live = true;
		void nativeRequest("/api/agent", undefined, id)
			.then((data) => {
				if (live) {
					setDescriptor(data);
					setForm(data.active);
				}
			})
			.catch((reason: Error) => {
				if (live) setError(reason.message);
			});
		return () => {
			live = false;
		};
	}, [id]);
	const save = async () => {
		if (!form || busy) return;
		setBusy(true);
		setError("");
		try {
			const state = await desktopSessions.state(id);
			await nativeRequest(
				"/api/command",
				{
					command: "configure",
					id: form.id,
					sessionId: String(state.sessionId),
					revision: form.revision,
					name: form.name,
					cwd: form.cwd,
					instructions: form.instructions,
					shellPath: form.shellPath,
					tools: form.tools,
					extensions: form.extensions,
					...(form.model ? { model: form.model } : {}),
					...(environment.trim() ? { shellEnv: JSON.parse(environment) } : {}),
				},
				id,
			);
			await load();
			await useDesktopWorkspace.getState().refresh();
			if (useSessionsStore.getState().activeSessionId === id)
				await useSessionsStore.getState().loadModels();
			setMessage("会话配置已保存。");
		} catch (reason) {
			setError((reason as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Feedback error={error} message={message} />
			{form ? (
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					{[
						["name", "名称"],
						["cwd", "项目目录"],
						["shellPath", "Shell 路径"],
					].map(([key, label]) => (
						<Field key={key} label={label}>
							<input
								aria-label={label}
								required={key !== "shellPath"}
								className={inputClass}
								value={form[key] ?? ""}
								onChange={(event) => setForm({ ...form, [key]: event.target.value })}
							/>
						</Field>
					))}
					<Field label="模型">
						<select
							aria-label="Agent 模型"
							className={inputClass}
							value={JSON.stringify(form.model ?? null)}
							onChange={(event) => setForm({ ...form, model: JSON.parse(event.target.value) })}
						>
							<option value="null">保持当前模型</option>
							{descriptor.models.map((row: any) => {
								const model = { provider: row.provider, modelId: row.modelId ?? row.id };
								return (
									<option key={`${model.provider}/${model.modelId}`} value={JSON.stringify(model)}>
										{model.provider} / {row.name ?? model.modelId}
									</option>
								);
							})}
						</select>
					</Field>
					<Field label="额外指令">
						<textarea
							aria-label="额外指令"
							className={inputClass}
							rows={4}
							value={form.instructions ?? ""}
							onChange={(event) => setForm({ ...form, instructions: event.target.value })}
						/>
					</Field>
					<Field
						label="工具环境变量"
						hint={`留空保留已有值；填写 JSON 替换。已配置：${form.environmentKeys?.join(", ") || "无"}`}
					>
						<textarea
							aria-label="工具环境变量"
							className={`${inputClass} font-mono`}
							rows={3}
							value={environment}
							onChange={(event) => setEnvironment(event.target.value)}
						/>
					</Field>
					{(["tools", "extensions"] as const).map((key) => (
						<fieldset key={key} className="space-y-2">
							<legend className="mb-2 text-ui-12 text-ink">
								{key === "tools" ? "工具" : "Durable 扩展"}
							</legend>
							{descriptor[key].map((value: string) => (
								<label key={value} className="flex items-center gap-2 text-ui-12 text-ink-dim">
									<input
										type="checkbox"
										checked={form[key]?.includes(value) ?? false}
										onChange={(event) =>
											setForm({
												...form,
												[key]: event.target.checked
													? [...(form[key] ?? []), value]
													: form[key].filter((item: string) => item !== value),
											})
										}
									/>
									{value}
								</label>
							))}
						</fieldset>
					))}
					<Button type="submit" variant="primary" disabled={busy}>
						保存会话配置
					</Button>
				</form>
			) : (
				!error && (
					<p role="status" className="text-ui-12 text-ink-faint">
						读取会话配置…
					</p>
				)
			)}
		</>
	);
}
