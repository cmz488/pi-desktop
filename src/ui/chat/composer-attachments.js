/**
 * 输入区附件：拥有选择、读取、粘贴、移除与预览事件，不拥有文字草稿或发送循环。
 *
 * 接口：createComposerAttachments({ live, embedded, drafts, api, getState, esc,
 *   toast, onChange, openPreview }) 返回 render、resize、rows(owner?)、
 *   restore(files, owner)、只读 choosing 与 dispose；见
 *   docs/architecture/interfaces/chat-views.md。
 * 依赖：drafts 是入口唯一的 sessionDrafts；getState 返回实时只读快照；api 保留
 *   api(path, input, { signal }) 协议；embedded = !!runtimePrefix；onChange
 *   同步发送按钮，openPreview(file) 由入口复用工作台／对话框。
 * 不变量：构造只绑定事件，不 render／调用 onChange，避免入口装配 TDZ；render
 *   才通知 onChange。restore 只追加附件并生成新 ID，文字与最终 render 由入口处理。
 *   每批读取固定 owner 与能力上限，切会话仍可写回原草稿；updateFile 不复活删除项。
 *   不清空草稿、不提交消息、不更改后端权限；本地引用不计入 16 MiB 上传草稿限额。
 * 错误：读取失败保留可移除的错误项，选择失败 toast；只有销毁后的结果不再发布。
 *   dispose 撤事件、中止本模块的 FileReader／HTTP 等待；不取消原生 Agent，
 *   无法中止的原生选择器／缓存调用完成后不再写回。
 */
const MAX_DRAFT_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MAX_CLIPBOARD_CACHE_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  maxCount: 8,
  maxTotalBytes: 4 * 1024 * 1024,
  maxTextBytes: 512 * 1024,
});
const PREVIEW_TEXT_LENGTH = 4000;
const COMPOSER_MIN_HEIGHT = 36;
const COMPOSER_MAX_HEIGHT = 120;
const IMAGE_MIME_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
});

function desktopFiles() {
  try {
    return window.piDesk ?? window.parent.piDesk;
  } catch (error) {
    // 跨源嵌入无法访问父窗口 preload，仍可使用宿主的文件选择接口。
    if (error.name !== "SecurityError") throw error;
    return undefined;
  }
}

export function createComposerAttachments({
  live,
  embedded,
  drafts,
  api,
  getState,
  esc,
  toast,
  onChange,
  openPreview,
}) {
  const prompt = document.querySelector("#prompt"),
    composer = document.querySelector("#composer"),
    attachButton = document.querySelector("#attach-context"),
    fileInput = document.querySelector("#context-files"),
    attachments = document.querySelector("#context-attachments");
  const readers = new Set();
  const controller = new AbortController();
  let serial = 0,
    choosing = false,
    disposed = false;

  function rows(owner = drafts.read().owner) {
    return drafts.read(owner).files;
  }

  function resize() {
    if (disposed || !embedded) return;
    prompt.rows = 1;
    prompt.style.height = "auto";
    prompt.style.height = `${Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, prompt.scrollHeight))}px`;
  }

  function render() {
    if (disposed) return;
    resize();
    const files = rows();
    const capabilities = getState()?.capabilities?.attachments;
    attachments.hidden = files.length === 0;
    attachButton.disabled = choosing || (live && !capabilities);
    attachButton.title =
      capabilities?.defaultMode === "reference"
        ? "添加本地文件引用"
        : "上传上下文文件";
    attachments.innerHTML = files
      .map(
        (file) =>
          `<div class="attachment-chip" data-attachment-id="${file.id}"><button type="button" data-context-preview="${file.id}" title="${esc(file.path ?? file.name)}" ${file.status !== "ready" ? "disabled" : ""}>${esc(file.name)}<small>${file.status === "reading" ? "读取中…" : file.status === "error" ? esc(file.error) : file.kind === "reference" ? "本地引用 · 按需读取" : `${Math.ceil(file.size / 1024)} KiB · 提交时校验`}</small></button><button type="button" data-context-remove="${file.id}" aria-label="移除 ${esc(file.name)}">✕</button></div>`,
      )
      .join("");
    onChange();
  }

  function capture() {
    const capabilities = getState()?.capabilities?.attachments;
    return {
      owner: drafts.read().owner,
      supported: !live || !!capabilities,
      // 复制数值上限／模式，不在 await 后读取另一会话的能力快照。
      limits: { ...DEFAULT_LIMITS, ...capabilities },
    };
  }

  function restore(files, owner) {
    if (disposed) return;
    for (const file of files)
      drafts.addFile(owner, {
        ...file,
        id: `transferred-${++serial}`,
      });
  }

  function addReferences(files, owner, limits) {
    for (const file of files) {
      if (rows(owner).length >= limits.maxCount) {
        toast(`最多添加 ${limits.maxCount} 个上下文文件`);
        break;
      }
      drafts.addFile(owner, {
        ...file,
        id: `context-${++serial}`,
        status: "ready",
        preview: `${file.path}\n\n本地文件引用，Agent 将按需读取。`,
      });
    }
    render();
  }

  async function chooseFiles() {
    if (disposed || choosing) return;
    const { owner, limits } = capture();
    if (limits.defaultMode !== "reference") return fileInput.click();
    choosing = true;
    render();
    try {
      const paths = await desktopFiles()?.pickFiles?.();
      if (disposed || (paths && !paths.length)) return;
      const result = await api(
        "/api/context/files",
        { sessionId: owner, ...(paths ? { paths } : {}) },
        { signal: controller.signal },
      );
      if (!disposed) addReferences(result.files, owner, limits);
    } catch (error) {
      if (!disposed) toast(error.message || "无法选择上下文文件");
    } finally {
      choosing = false;
      render();
    }
  }

  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const finish = (error) => {
        readers.delete(reader);
        reader.onload = reader.onerror = reader.onabort = null;
        if (error) reject(error);
        else resolve(String(reader.result));
      };
      reader.onload = () => finish();
      reader.onerror = () => finish(new Error("无法读取文件，请重新选择"));
      reader.onabort = () => finish(new Error("文件读取已取消"));
      readers.add(reader);
      try {
        reader.readAsDataURL(file);
      } catch (error) {
        finish(error);
      }
    });
  }

  async function readReference(file, entry, owner) {
    const desktop = desktopFiles();
    let path;
    try {
      path = desktop?.filePath?.(file);
    } catch {
      // Electron 可能拒绝合成的剪贴板 File；保留原来的缓存回退，
      // 失败由下面的缓存／无路径错误报告，不把文本路径当成本机授权。
    }
    if (!path && desktop?.cacheContextFile) {
      if (file.size > MAX_CLIPBOARD_CACHE_BYTES)
        throw new Error("剪贴板附件超过 4 MiB，请保存后选择原文件");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (disposed) return;
      path = await desktop.cacheContextFile({ name: file.name, bytes });
      if (disposed) return;
    }
    if (!path)
      throw new Error(
        "浏览器无法提供文件路径，请使用 + 选择本机文件；剪贴板文件请先保存",
      );
    const reference = (
      await api(
        "/api/context/files",
        { sessionId: owner, paths: [path] },
        { signal: controller.signal },
      )
    ).files[0];
    if (disposed) return;
    Object.assign(entry, reference, {
      status: "ready",
      preview: `${reference.path}\n\n本地文件引用，Agent 将按需读取。`,
    });
  }

  async function readUpload(file, entry, owner, limits) {
    if (
      /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|pages|zip|7z|rar)$/i.test(file.name)
    )
      throw new Error("Pi 当前不支持此格式；请先转为 UTF-8 文本或图片");
    if (
      rows(owner).reduce((sum, item) => sum + item.size, 0) >
        limits.maxTotalBytes ||
      drafts.totalBytes() > MAX_DRAFT_ATTACHMENT_BYTES
    )
      throw new Error("附件超出限制：每会话 4 MiB，全部草稿 16 MiB");
    const image =
      /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name) ||
      Object.values(IMAGE_MIME_TYPES).includes(file.type);
    if (
      file.type.startsWith("image/") &&
      file.type !== "image/svg+xml" &&
      !image
    )
      throw new Error("Pi 当前不支持此图片格式");
    if (!image && file.size > limits.maxTextBytes)
      throw new Error("文本附件不能超过 512 KiB");
    const url = await readDataUrl(file);
    if (disposed) return;
    entry.url = url;
    entry.data = url.slice(url.indexOf(",") + 1);
    if (image) {
      entry.image = true;
      const mime =
        IMAGE_MIME_TYPES[file.name.split(".").at(-1).toLowerCase()] ??
        file.type;
      entry.url = `data:${mime};base64,${entry.data}`;
    } else {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(entry.data), (value) => value.charCodeAt(0)),
      );
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
        throw new Error("Pi 当前不支持二进制附件");
      entry.preview =
        text.slice(0, PREVIEW_TEXT_LENGTH) +
        (text.length > PREVIEW_TEXT_LENGTH
          ? "\n…（仅预览截断，提交完整文本）"
          : "");
    }
    entry.status = "ready";
  }

  async function addContextFiles(chosen) {
    if (disposed) return;
    const { owner, limits, supported } = capture();
    if (!supported) {
      toast("当前服务尚未支持附件；请等任务结束后更新宿主");
      return;
    }
    const reference = limits.defaultMode === "reference";
    for (const file of chosen) {
      if (disposed) return;
      if (rows(owner).length >= limits.maxCount) {
        toast(
          reference
            ? `最多添加 ${limits.maxCount} 个上下文文件`
            : `最多添加 ${limits.maxCount} 个附件；未添加 ${file.name}`,
        );
        if (reference) break;
        continue;
      }
      const entry = {
        id: `context-${++serial}`,
        name: file.name,
        size: file.size,
        ...(reference ? { kind: "reference" } : { type: file.type }),
        status: "reading",
      };
      drafts.addFile(owner, entry);
      render();
      try {
        if (reference) await readReference(file, entry, owner);
        else await readUpload(file, entry, owner, limits);
      } catch (error) {
        // 销毁只取消本视图的等待，不向已卸载的 UI 发布错误。
        if (disposed) return;
        entry.status = "error";
        entry.error =
          error.message || (reference ? "无法引用本地文件" : "附件读取失败");
        delete entry.data;
        delete entry.url;
      }
      if (disposed) return;
      drafts.updateFile(owner, entry);
      render();
    }
  }

  function reportError(error) {
    if (!disposed) toast(error.message || "附件读取失败");
  }

  function filesChanged(event) {
    const files = [...event.target.files];
    event.target.value = "";
    void addContextFiles(files).catch(reportError);
  }

  function pasteFiles(event) {
    const data = event.clipboardData;
    if (!data || event.currentTarget.disabled || composer.hidden) return;
    const files = data.files.length
      ? [...data.files]
      : [...data.items]
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter(Boolean);
    // 只有剪贴板中的真实 File 才是附件；不把文本路径当成本机访问授权。
    if (!files.length) return;
    event.preventDefault();
    const text = data.getData("text/plain");
    if (text) {
      prompt.setRangeText(
        text,
        prompt.selectionStart,
        prompt.selectionEnd,
        "end",
      );
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    }
    void addContextFiles(files).catch(reportError);
  }

  function attachmentClicked(event) {
    const button = event.target.closest("button");
    if (!button) return;
    const id = button.dataset.contextRemove ?? button.dataset.contextPreview;
    const file = rows().find((item) => item.id === id);
    if (!file) return;
    if (button.dataset.contextRemove) {
      drafts.removeFile(drafts.read().owner, id);
      render();
    } else openPreview(file);
  }

  attachButton.addEventListener("click", chooseFiles);
  fileInput.addEventListener("change", filesChanged);
  prompt.addEventListener("paste", pasteFiles);
  attachments.addEventListener("click", attachmentClicked);

  function dispose() {
    if (disposed) return;
    disposed = true;
    choosing = false;
    attachButton.removeEventListener("click", chooseFiles);
    fileInput.removeEventListener("change", filesChanged);
    prompt.removeEventListener("paste", pasteFiles);
    attachments.removeEventListener("click", attachmentClicked);
    controller.abort();
    for (const reader of readers) reader.abort();
    readers.clear();
  }

  return {
    render,
    resize,
    rows,
    restore,
    get choosing() {
      return choosing;
    },
    dispose,
  };
}
