/** Pi 的一次性交互身份同时携带所属会话与 prompt，避免跨会话答复。 */
export function dialogRequestId(sessionId, jobId, promptId) {
  return [sessionId, jobId, promptId].map(encodeURIComponent).join("|");
}
export function parseDialogRequestId(value) {
  const parts = String(value).split("|").map(decodeURIComponent);
  if (parts.length !== 3 || parts.some((part) => !part))
    throw new Error("交互身份无效");
  return { sessionId: parts[0], id: parts[1], promptId: parts[2] };
}
export function toDialogs(rows, sessionId) {
  return (rows ?? [])
    .filter((job) => job.status === "running" && job.prompt)
    .map((job) => {
      const prompt = job.prompt;
      const confirm =
        prompt.type === "select" &&
        prompt.options?.length === 2 &&
        prompt.options[0].id === "yes" &&
        prompt.options[1].id === "no";
      return {
        id: dialogRequestId(sessionId, job.id, prompt.id),
        sessionId,
        kind: confirm
          ? "confirm"
          : prompt.type === "select"
            ? "select"
            : "input",
        title: job.label ?? "交互",
        message: prompt.message,
        options: prompt.options?.map((row) => row.label),
        placeholder: prompt.placeholder,
        requestedAt: 0,
      };
    });
}
