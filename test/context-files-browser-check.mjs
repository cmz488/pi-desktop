import { spawn } from "node:child_process";
import { writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

const f = await desktopFixture();
let browser, driver;
try {
  const projectId = (await f.call("/api/workspace")).projects[0].id;
  const { id } = await f.command("conversation.create", { projectId });
  const url = `${f.app.url}agents/${id}/`;
  const pdf = join(f.cwd, "local-document.pdf"),
    text = join(f.cwd, "local-index.txt"),
    remote = join(f.cwd, "phone.txt");
  await writeFile(pdf, "%PDF-PRIVATE_PDF_BYTES");
  await writeFile(text, "PRIVATE_LOCAL_FILE_BYTES");
  await writeFile(remote, "REMOTE_FILE_CONTENT_MARKER");
  const entry = join(f.root, "context-electron.mjs");
  await writeFile(
    entry,
    `import {dialog} from 'electron'; dialog.showOpenDialog=async(_window, options)=>{if(!options.properties.includes('openFile'))throw new Error('wrong picker');return {canceled:false,filePaths:[${JSON.stringify(pdf)}]};};await import(${JSON.stringify(fileURLToPath(new URL("../src/desktop/desktop.mjs", import.meta.url)))});`,
  );
  const profile = join(f.root, "config", "pi-desk");
  browser = spawn(
    "xvfb-run",
    [
      "-a",
      "/usr/bin/electron43",
      "--no-sandbox",
      "--disable-gpu",
      "--ozone-platform=x11",
      "--remote-debugging-port=0",
      entry,
      url,
    ],
    {
      env: { ...process.env, XDG_CONFIG_HOME: join(f.root, "config") },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  driver = await browserDriver(profile, undefined, url);
  const { evaluate, call } = driver;
  await driver.until(
    "document.querySelector('#attach-context')?.title === '添加本地文件引用' && !document.querySelector('#attach-context').disabled && typeof window.piDesk?.filePath === 'function'",
  );
  await evaluate(
    `window.sentAttachments=[]; window.fileReads=0; const realFetch=window.fetch; window.fetch=(url,options)=>{if(String(url).includes('/api/prompt')&&options?.body)window.sentAttachments.push(JSON.parse(options.body));return realFetch(url,options)};FileReader.prototype.readAsDataURL=()=>{throw new Error('local bytes must not be uploaded')}; const read=File.prototype.arrayBuffer; File.prototype.arrayBuffer=function(){if(this.name==='local-index.txt')window.fileReads++;return read.call(this)};document.querySelector('#attach-context').click()`,
  );
  await driver.until(
    "document.querySelector('#context-attachments').innerText.includes('local-document.pdf')",
  );
  await call("DOM.enable");
  const chooseFiles = async (files) => {
    const node = (await call("DOM.getDocument")).root.nodeId;
    const nodeId = (
      await call("DOM.querySelector", {
        nodeId: node,
        selector: "#context-files",
      })
    ).nodeId;
    await call("DOM.setFileInputFiles", { nodeId, files });
  };
  await chooseFiles([text]);
  await driver.until(
    "document.querySelectorAll('[data-context-preview]:not([disabled])').length===2",
  );
  assert.equal(await evaluate("window.fileReads"), 0);
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('[data-context-preview]')].find(button=>button.textContent.includes('local-index.txt')).title",
    ),
    text,
  );
  await evaluate(
    `const data=new DataTransfer();data.items.add(new File(['PRIVATE_CLIPBOARD_BYTES'],'clipboard.txt',{type:'text/plain'}));document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))`,
  );
  await driver.until(
    "document.querySelectorAll('[data-context-preview]:not([disabled])').length===3",
  );
  const clipboard = await evaluate(
    "[...document.querySelectorAll('[data-context-preview]')].find(button=>button.textContent.includes('clipboard.txt')).title",
  );
  assert(clipboard.startsWith(profile + "/context-files/"));
  assert.equal(await readFile(clipboard, "utf8"), "PRIVATE_CLIPBOARD_BYTES");
  assert.equal((await stat(clipboard)).mode & 0o777, 0o600);
  await evaluate(
    "document.querySelector('#prompt').value='local references';document.querySelector('#composer').requestSubmit()",
  );
  await until(
    () => f.requests,
    (rows) => rows.length === 1,
  );
  const submitted = await evaluate("window.sentAttachments[0]");
  assert.equal(submitted.attachments.length, 3);
  assert(
    submitted.attachments.every(
      (file) =>
        file.kind === "reference" && file.path && file.data === undefined,
    ),
  );
  assert(JSON.stringify(f.requests[0]).includes(pdf));
  assert(!JSON.stringify(f.requests[0]).includes("PRIVATE_"));
  await driver.until("document.querySelector('#context-attachments').hidden");
  await call("Network.enable");
  await call("Network.setExtraHTTPHeaders", {
    headers: { "x-pi-remote-client": "1" },
  });
  await evaluate("location.reload()");
  await driver.until(
    "document.querySelector('#attach-context')?.title === '上传上下文文件' && !document.querySelector('#attach-context').disabled",
  );
  await chooseFiles([remote]);
  await driver.until(
    "document.querySelector('#context-attachments').innerText.includes('提交时校验')",
  );
  await evaluate(
    "document.querySelector('#prompt').value='phone upload';document.querySelector('#composer').requestSubmit()",
  );
  await until(
    () => f.requests,
    (rows) => rows.length === 2,
  );
  const remoteRequest = JSON.stringify(f.requests[1]);
  assert(!remoteRequest.includes("REMOTE_FILE_CONTENT_MARKER"));
  assert(!remoteRequest.includes(remote));
  const cachedPath = /\/tmp\/pi-desk-context-cache\/[^\s"'\\]+/.exec(
    remoteRequest,
  )?.[0];
  assert(cachedPath, remoteRequest.slice(-1200));
  assert.equal(
    await readFile(cachedPath, "utf8"),
    "REMOTE_FILE_CONTENT_MARKER",
  );
  assert.equal(
    await evaluate(
      `fetch(${JSON.stringify(`/agents/${id}/api/context/files`)},{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status)`,
    ),
    403,
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    "Context file browser passed: native selection, path-only files, locally cached clipboard, real model request, remote upload and remote picker denial.",
  );
} finally {
  driver?.close();
  if (browser) {
    const closed = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill("SIGTERM");
    await closed;
  }
  await f.close();
}
