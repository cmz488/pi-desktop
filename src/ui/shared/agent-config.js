/** Existing Durable Agent form; all changes still go through the owning worker and its revision. */
export async function openAgentConfiguration({
  api,
  snapshot,
  dialog,
  root,
  escape,
  refresh,
}) {
  const state = snapshot();
  const descriptor = await api("/api/agent");
  const active = descriptor.active;
  if (!active) throw new Error("请先打开 Agent");
  const selection = (name, values, checked) =>
    `<fieldset><legend>${name === "tools" ? "工具" : "Durable 扩展"}</legend><div class="agent-options">${values.map((value) => `<label><input type="checkbox" name="${name}" value="${escape(value)}" ${checked.includes(value) ? "checked" : ""}>${escape(value)}</label>`).join("")}</div></fieldset>`;
  const choices = descriptor.models.map((model) => ({
    provider: model.provider,
    modelId: model.modelId ?? model.id,
    name: model.name ?? model.modelId ?? model.id,
  }));
  if (
    active.model &&
    !choices.some(
      (row) =>
        row.provider === active.model.provider &&
        row.modelId === active.model.modelId,
    )
  )
    choices.push({ ...active.model, name: active.model.modelId });
  dialog.open(
    "配置当前 Agent",
    `<div class="agent-config-form">
    <label>名称<input name="agentName" value="${escape(active.name)}" required></label>
    <label>项目目录<input name="agentCwd" value="${escape(active.cwd)}" required></label>
    <label>模型<select name="agentModel"><option value="">保持当前模型</option>${choices.map((row) => `<option value="${escape(JSON.stringify({ provider: row.provider, modelId: row.modelId }))}" ${active.model?.provider === row.provider && active.model?.modelId === row.modelId ? "selected" : ""}>${escape(row.provider)} / ${escape(row.name)}</option>`).join("")}</select></label>
    <label>额外指令<textarea name="agentInstructions" rows="5">${escape(active.instructions)}</textarea></label>
    <label>Shell 路径<input name="agentShell" value="${escape(active.shellPath)}" placeholder="系统默认 Shell"></label>
    <label>工具环境变量<textarea name="agentEnv" rows="3" placeholder='{"NAME":"value"}'></textarea><small>${active.environmentKeys?.length ? `已配置 ${escape(active.environmentKeys.join(", "))}；留空保留，填写 JSON 替换。` : "留空使用宿主环境。"}</small></label>
    ${selection("tools", descriptor.tools, active.tools ?? [])}
    ${selection("extensions", descriptor.extensions, active.extensions ?? [])}
  </div>`,
    async (form) => {
      const input = {
        command: "configure",
        id: active.id,
        sessionId: String(state.sessionId),
        revision: active.revision,
        name: form.get("agentName"),
        cwd: form.get("agentCwd"),
        instructions: form.get("agentInstructions"),
        shellPath: form.get("agentShell"),
        tools: form.getAll("tools"),
        extensions: form.getAll("extensions"),
        ...(form.get("agentModel")
          ? { model: JSON.parse(form.get("agentModel")) }
          : {}),
        ...(form.get("agentEnv").trim()
          ? { shellEnv: JSON.parse(form.get("agentEnv")) }
          : {}),
      };
      await api("/api/command", input);
      await refresh();
    },
  );
}
