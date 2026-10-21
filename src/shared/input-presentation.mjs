/**
 * 输入展示的窄数据契约，不推导模型上下文，也不依据正文标签推断来源。
 *
 * 接口：INPUT_PRESENTATION_TYPE／INPUT_COMMAND_TYPE 为原生 custom 类型；
 *   normalizeInputPresentation／normalizeInputCommand 只采纳支持的窄数据，其他字段不带入展示。
 * 不变量：未知／无效数据不授予可信来源；调用方保留完整原生文字作兼容回退。
 * 错误：格式不支持返回 undefined，不删除原始内容。
 */
export const INPUT_PRESENTATION_TYPE = "pi-desktop-input";
export const INPUT_COMMAND_TYPE = "pi-desktop-command";
const MAX_ORIGINAL_UNITS = 512000;
export function normalizeInputCommand(value) {
  if (
    value?.version !== 1 ||
    typeof value.original !== "string" ||
    value.original.length > MAX_ORIGINAL_UNITS
  )
    return undefined;
  return {
    version: 1,
    original: value.original,
    ...(Number.isFinite(value.timestamp) ? { timestamp: value.timestamp } : {}),
  };
}
export function normalizeInputPresentation(value) {
  if (!value || !["user", "automatic", "unknown"].includes(value.source))
    return undefined;
  if (value.source !== "user") return { source: value.source };
  if (
    value.original !== undefined &&
    (typeof value.original !== "string" ||
      value.original.length > MAX_ORIGINAL_UNITS)
  )
    return undefined;
  return {
    source: "user",
    ...(value.original === undefined ? {} : { original: value.original }),
  };
}
