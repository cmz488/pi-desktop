// Workspace grouping follows DSH tree.ts / owningParentFolder (MIT, see NOTICE).
export const defaultSidebarView = {
  groupBy: "workspace",
  orderBy: "updated",
  archived: "hide",
  manual: [],
};
export function normalizeSidebarView(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  return {
    groupBy: ["workspace", "workspace-tree", "flat"].includes(value.groupBy)
      ? value.groupBy
      : "workspace",
    orderBy: ["manual", "updated"].includes(value.orderBy)
      ? value.orderBy
      : "updated",
    archived: ["hide", "show", "only"].includes(value.archived)
      ? value.archived
      : "hide",
    manual: Array.isArray(value.manual)
      ? value.manual.filter((id) => typeof id === "string").slice(0, 10000)
      : [],
  };
}
export function orderSessions(rows, view) {
  const positions = new Map(view.manual.map((id, index) => [id, index]));
  return [...rows].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      (view.orderBy === "updated"
        ? String(b.updatedAt ?? b.createdAt ?? "").localeCompare(
            String(a.updatedAt ?? a.createdAt ?? ""),
          )
        : (positions.get(a.id) ?? Infinity) -
            (positions.get(b.id) ?? Infinity) || 0),
  );
}
export function workspaceParents(projects) {
  const path = (value) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  return new Map(
    projects.map((project) => {
      const child = path(project.cwd);
      const parent = projects
        .filter(
          (row) =>
            row.id !== project.id && child.startsWith(path(row.cwd) + "/"),
        )
        .sort((a, b) => b.cwd.length - a.cwd.length)[0];
      return [project.id, parent?.id];
    }),
  );
}
