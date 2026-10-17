import { DeskError } from "../config/config-store.mjs";

export const approvalModes = ["ask-all", "ask-risky", "yolo"];
export function validateApprovalMode(mode) {
  if (!approvalModes.includes(mode)) throw new DeskError(422, "权限等级无效");
  return mode;
}

const destructiveToolName =
  /(?:^|[_-])(?:delete|remove|rm|unlink|rmdir|shred|srm|trash|purge|wipe|destroy|drop)(?:$|[_-])/i;
const safeMutationTools = new Set([
  "write",
  "edit",
  "apply_patch",
  "bash",
  "codemode",
]);
const deletionCommands = [
  /\b(?:rm|rmdir|unlink|shred|srm|trash)\b/i,
  /\bfind\b[^;&|\n]*\s-delete\b/i,
  /\bgit\s+(?:rm\b|clean\b[^;&|\n]*(?:\s-f|--force)|reset\b[^;&|\n]*--hard)/i,
  /\b(?:wipefs|mkfs(?:\.\w+)?|truncate)\b/i,
  /\bdd\b[^;&|\n]*\bof=/i,
  /\bsudo\b/i,
];

function destructiveShellCommand(input) {
  const command =
    typeof input === "string"
      ? input
      : [input?.command, input?.cmd, input?.script]
          .filter((value) => typeof value === "string")
          .join("\n");
  return deletionCommands.some((pattern) => pattern.test(command));
}

export function requiresRiskApproval(toolName, input, annotations = {}) {
  const name = String(toolName ?? "");
  if (
    destructiveToolName.test(name) ||
    /^(?:delete|remove|rm|unlink|rmdir|shred|srm|trash|purge|wipe|destroy|drop)[A-Z]/.test(
      name,
    )
  )
    return true;
  if (name === "bash") return destructiveShellCommand(input);
  if (safeMutationTools.has(name)) return false;
  if (input && typeof input === "object") {
    const operation = String(input.action ?? input.operation ?? "");
    if (
      destructiveToolName.test(operation) ||
      /^(?:delete|remove|rm|unlink|rmdir|shred|srm|trash|purge|wipe|destroy|drop)[A-Z]/.test(
        operation,
      )
    )
      return true;
  }
  return annotations.destructiveHint === true;
}

// Policy is a Pi extension: Pi owns dispatch, nested calls, UI and cancellation.
// Annotations are hints, so unclassified tools require approval by default.
export function createApprovalExtension(policy) {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const mode = validateApprovalMode(policy.mode);
      const tool = pi.getAllTools().find((row) => row.name === event.toolName);
      if (
        mode === "yolo" ||
        (mode === "ask-risky" &&
          !requiresRiskApproval(event.toolName, event.input, tool?.annotations))
      )
        return;
      const input = JSON.stringify(event.input, null, 2).slice(0, 6000);
      const allowed = await ctx.ui.confirm(
        `允许 ${event.toolName}？${event.parentToolCallId ? "（嵌套调用）" : ""}`,
        input,
      );
      if (!allowed) return { block: true, reason: "用户未批准本次工具调用" };
    });
  };
}
