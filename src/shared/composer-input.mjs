/** Serializable editor input shared by the HTTP boundary and its callers. */
export function composerInput(args) {
  if (!args.document) return String(args.text ?? "");
  if (args.document.version !== 1 || !Array.isArray(args.document.parts))
    throw new Error("输入文档格式无效");
  return args.document.parts
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string")
        return part.text;
      if (
        part.type === "file" &&
        typeof part.path === "string" &&
        part.path &&
        (part.label === undefined || typeof part.label === "string")
      )
        return `@${part.path}`;
      if (part.type === "skill" && typeof part.label === "string")
        return part.label;
      throw new Error("输入引用格式无效");
    })
    .join("");
}

export function composerDisplayText(document) {
  composerInput({ document });
  return document.parts
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "file"
          ? `@${part.label ?? part.path}`
          : part.label,
    )
    .join("");
}
