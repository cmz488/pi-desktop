import { basename } from "node:path";

/** Read the SDK loader's actual loaded set, rather than its configured package list. */
export function loadedResources(session) {
  const extensions = session.resourceLoader.getExtensions();
  const skills = session.resourceLoader.getSkills();
  const scope = (source) =>
    source?.scope === "project"
      ? "project"
      : source?.scope === "temporary"
        ? "temporary"
        : "user";
  const source = (info) => info?.source ?? info?.type ?? "";
  return {
    skills: skills.skills.map((skill) => ({
      ...skill,
      path: skill.filePath,
      scope: scope(skill.sourceInfo),
      source: source(skill.sourceInfo),
    })),
    skillDiagnostics: skills.diagnostics,
    extensions: extensions.extensions.map((extension) => ({
      name: basename(extension.path),
      path: extension.path,
      scope: scope(extension.sourceInfo),
      source: source(extension.sourceInfo),
      hidden: extension.hidden === true,
      toolsCount: extension.tools.size,
      tools: [...extension.tools.keys()],
      commands: [...extension.commands.keys()],
      flagsCount: extension.flags.size,
      shortcutsCount: extension.shortcuts.size,
    })),
    extensionErrors: [
      ...extensions.errors.map((error) => ({ ...error, level: "error" })),
      ...(extensions.warnings ?? []).map((warning) => ({
        path: warning.path,
        error: warning.warning,
        level: "info",
      })),
    ],
  };
}
