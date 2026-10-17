import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DeskError } from "../config/config-store.mjs";

const run = promisify(execFile);
export function createDirectoryPicker({
  platform = process.platform,
  execute = run,
} = {}) {
  let pending;
  async function pick(files = false) {
    if (pending) throw new DeskError(409, "文件夹选择器已打开");
    const controller = new AbortController();
    pending = controller;
    const options = {
      signal: controller.signal,
      timeout: 120000,
      maxBuffer: 16384,
      windowsHide: true,
    };
    try {
      let result;
      if (platform === "darwin")
        result = await execute(
          "osascript",
          [
            "-e",
            files
              ? 'set output to ""\nrepeat with chosen in (choose file with prompt "添加本地文件引用" with multiple selections allowed)\nset output to output & (POSIX path of chosen) & linefeed\nend repeat\nreturn output'
              : 'POSIX path of (choose folder with prompt "选择项目文件夹")',
          ],
          options,
        );
      else if (platform === "win32")
        result = await execute(
          "powershell.exe",
          [
            "-NoProfile",
            "-STA",
            "-Command",
            files
              ? 'Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.OpenFileDialog; $picker.Multiselect = $true; $picker.Title = "添加本地文件引用"; if ($picker.ShowDialog() -eq "OK") { [Console]::WriteLine(($picker.FileNames -join "`n")) }'
              : 'Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "选择项目文件夹"; if ($picker.ShowDialog() -eq "OK") { [Console]::WriteLine($picker.SelectedPath) }',
          ],
          options,
        );
      else {
        try {
          result = await execute(
            "zenity",
            files
              ? [
                  "--file-selection",
                  "--multiple",
                  "--separator=\n",
                  "--title=添加本地文件引用",
                ]
              : ["--file-selection", "--directory", "--title=选择项目文件夹"],
            options,
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          result = await execute(
            "kdialog",
            files
              ? [
                  "--multiple",
                  "--separate-output",
                  "--getopenfilename",
                  ".",
                  "--title",
                  "添加本地文件引用",
                ]
              : ["--getexistingdirectory", ".", "--title", "选择项目文件夹"],
            options,
          );
        }
      }
      if (files)
        return result.stdout
          .replace(/(?:\r?\n)+$/, "")
          .split(/\r?\n/)
          .filter(Boolean);
      const path = result.stdout.trim();
      if (!path) return null;
      if (!isAbsolute(path) || !(await stat(path)).isDirectory())
        throw new DeskError(422, "请选择有效的项目文件夹");
      return await realpath(path);
    } catch (error) {
      if (
        error.code === 1 ||
        /User canceled|用户取消|\(-128\)/.test(error.stderr ?? "")
      )
        return files ? [] : null;
      if (error instanceof DeskError) throw error;
      throw new DeskError(
        503,
        error.code === "ENOENT"
          ? "未找到系统文件夹选择器，请安装 Zenity／KDialog 或使用 Desktop。"
          : "无法打开系统文件夹选择器，请确认电脑图形会话可用。",
      );
    } finally {
      pending = undefined;
    }
  }
  return {
    pick: () => pick(),
    pickFiles: () => pick(true),
    close() {
      pending?.abort();
    },
  };
}
