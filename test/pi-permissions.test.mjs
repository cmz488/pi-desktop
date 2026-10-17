import { test } from "node:test";
import assert from "node:assert/strict";
import { requiresRiskApproval } from "../src/agent/pi-permissions.mjs";

test("risk confirmation allows routine tools and requests confirmation for deletion operations", () => {
  for (const [name, input] of [
    ["read", { path: "src/app.mjs" }],
    ["write", { path: "src/app.mjs", content: "updated" }],
    ["edit", { path: "src/app.mjs", oldText: "a", newText: "b" }],
    ["bash", { command: "npm test && git status --short" }],
    ["bash", { command: "git commit -am 'fix'" }],
    ["codemode", { code: "await tools.write({ path, content })" }],
  ])
    assert.equal(
      requiresRiskApproval(name, input),
      false,
      `${name} should pass`,
    );

  for (const command of [
    "rm -rf ./build",
    "sudo rm -- ./cache",
    "find ./tmp -type f -delete",
    "git rm -r ./old",
    "git clean -fd",
    "git reset --hard HEAD~1",
    "mkfs.ext4 /dev/example",
  ])
    assert.equal(
      requiresRiskApproval("bash", { command }),
      true,
      `${command} should request confirmation`,
    );

  assert.equal(requiresRiskApproval("delete_file", {}), true);
  assert.equal(requiresRiskApproval("removeFile", {}), true);
  assert.equal(
    requiresRiskApproval("mcp__files__write", {}, { destructiveHint: true }),
    true,
  );
  assert.equal(
    requiresRiskApproval("mcp__files__list", {}, { readOnlyHint: true }),
    false,
  );
  assert.equal(requiresRiskApproval("workspace", { action: "delete" }), true);
});
