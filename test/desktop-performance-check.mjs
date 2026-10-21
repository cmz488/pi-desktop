import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

/**
 * 固定拓扑性能夹具：通过 Host／worker HTTP、真实工具回合及 Chromium 采集指标。
 *
 * 接口：node test/desktop-performance-check.mjs [证据目录]；固定重复三次。
 * 不变量：只建临时项目；两个正常 worker 执行相同历史与流式工作；不取消后台工作。
 * 错误：超时、浏览器异常、采样失败或无效时钟均使本轮失败，不进入有效结果。
 */
const REPEATS = 3;
const HISTORY_TURNS = 60;
const HISTORY_UNITS = 512;
const ANSWER_WORDS = 128;
const INTERACTIONS = 12;
const WARMUP_SWITCHES = 2;
const SAMPLE_MS = 50;
const SETTLE_MS = 1500;
const STREAM_CHUNKS = 40;
const STREAM_INTERVAL_MS = 20;
const VIEWPORT = {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
};
const output = process.argv[2] ?? (await mkdtemp(join(tmpdir(), "pi-perf-")));
await mkdir(output, { recursive: true });
const diagnostic = fileURLToPath(
  new URL("./memory-metrics-fixture.mjs", import.meta.url),
);
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const provenance = {
  fixture: "desktop-two-workers-history-stream-v1",
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  script: await digest(fileURLToPath(import.meta.url)),
  memoryFixture: await digest(diagnostic),
  packageJson: await digest(new URL("../package.json", import.meta.url)),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  offline: process.env.PI_OFFLINE ?? "",
};
const results = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quantile = (values, p) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
  ];
async function rss(pid) {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const value = {
    rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]),
    peakKiB: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]),
  };
  assert.ok(value.rssKiB > 0 && value.peakKiB > 0);
  return value;
}

for (let run = 0; run < REPEATS; run++) {
  const fixture = await desktopFixture({
    extensionPaths: [diagnostic],
    modelReply: async (input) => {
      const last = input.messages.at(-1);
      if (
        last?.role === "user" &&
        typeof last.content === "string" &&
        last.content.startsWith("BENCH_MEMORY_")
      )
        return {
          toolCalls: [
            {
              id: last.content,
              type: "function",
              function: { name: "fixture_process_memory", arguments: "{}" },
            },
          ],
        };
      if (last?.role === "user" && last.content === "BENCH_STREAM")
        return {
          stream: (async function* () {
            for (let index = 0; index < STREAM_CHUNKS; index++) {
              await pause(STREAM_INTERVAL_MS);
              yield `BENCH_STREAM_PART_${index} `;
            }
            yield "BENCH_STREAM_END";
          })(),
        };
      return { text: "BENCH_ANSWER " + "data ".repeat(ANSWER_WORDS) };
    },
  });
  let browser, driver, timer, samplingError;
  let sampling = Promise.resolve();
  const samples = [];
  try {
    const project = (await fixture.call("/api/workspace")).projects.find(
      (row) => row.cwd === fixture.cwd,
    );
    const actors = [];
    for (const name of ["A", "B"]) {
      // 只给临时测量工具免交互准入，不改变生产默认权限；安全专项仍用 ask-risky。
      const actor = await fixture.command("conversation.create", {
        projectId: project.id,
        name: `Bench ${name}`,
        approvalMode: "yolo",
      });
      actor.prefix = `/agents/${actor.id}`;
      actor.session = (
        await fixture.call(actor.prefix + "/api/state")
      ).sessionId;
      actors.push(actor);
    }
    async function state(actor) {
      return fixture.call(
        actor.prefix + `/api/state?sessionId=${actor.session}`,
      );
    }
    async function send(actor, message) {
      await fixture.call(
        actor.prefix + `/api/prompt?sessionId=${actor.session}`,
        {
          sessionId: actor.session,
          message,
        },
      );
      return until(
        () => state(actor),
        (value) =>
          value.idle &&
          value.messages.some(
            (row) => row.role === "user" && row.text === message,
          ) &&
          value.messages.at(-1)?.role === "assistant",
      );
    }
    async function memory(actor, phase) {
      const callId = `BENCH_MEMORY_${run}_${phase}_${actor.id}`;
      await send(actor, callId);
      const value = await until(
        () => state(actor),
        (current) =>
          current.messages.some(
            (row) => row.toolCallId === callId && row.role === "toolResult",
          ),
      );
      const measured = JSON.parse(
        value.messages.find(
          (row) => row.toolCallId === callId && row.role === "toolResult",
        ).text,
      );
      assert.ok(measured.sampleCount > 0 && measured.afterGc.heapUsed > 0);
      return measured;
    }
    for (let index = 0; index < HISTORY_TURNS; index++)
      await send(
        actors[0],
        `BENCH_HISTORY_${index} ` + "x".repeat(HISTORY_UNITS),
      );
    await send(actors[1], "BENCH_B_WARM");
    const heapBefore = await Promise.all(
      actors.map((actor) => memory(actor, "before")),
    );
    const catalog = await fixture.call("/api/workspace");
    const pids = actors.map(
      (actor) => catalog.agents.find((row) => row.id === actor.id).pid,
    );
    assert.deepEqual(
      heapBefore.map((value) => value.pid),
      pids,
    );
    timer = setInterval(() => {
      sampling = sampling
        .then(async () => samples.push(await Promise.all(pids.map(rss))))
        .catch((error) => {
          samplingError = error;
          clearInterval(timer);
        });
    }, SAMPLE_MS);
    const profile = join(fixture.root, "perf-browser");
    browser = spawn(
      "/usr/bin/chromium",
      [
        "--headless",
        "--password-store=basic",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    driver = await browserDriver(profile);
    const { call, evaluate, until: ready } = driver;
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: `(()=>{
      window.bench={requests:[],longTasks:[],mutations:0};
      const original=fetch.bind(window);
      window.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);window.bench.requests.push({path:url.pathname,query:url.search,time:performance.now()});return original(input,options);};
      new PerformanceObserver(list=>window.bench.longTasks.push(...list.getEntries().map(entry=>entry.duration))).observe({entryTypes:['longtask']});
      window.addEventListener('DOMContentLoaded',()=>new MutationObserver(rows=>window.bench.mutations+=rows.length).observe(document.body,{subtree:true,childList:true,characterData:true}));
    })()`,
    });
    await call("Performance.enable");
    await call("Emulation.setDeviceMetricsOverride", VIEWPORT);
    const url = new URL(fixture.app.url);
    url.searchParams.set("agent", actors[0].id);
    const navigationStart = performance.now();
    await call("Page.navigate", { url: url.href });
    const frame = "document.querySelector('#runtime')?.contentDocument";
    await ready(
      `document.querySelector('#runtime')?.dataset.owner===${JSON.stringify(actors[0].id)}&&(${frame})?.querySelector('#connection-status')?.textContent==='Pi 已连接'&&(${frame})?.querySelector('#messages')?.innerText.includes('BENCH_HISTORY_${HISTORY_TURNS - 1}')`,
    );
    const historyReadyMs = performance.now() - navigationStart;
    const switchTimes = [];
    for (let index = 0; index < INTERACTIONS + WARMUP_SWITCHES; index++) {
      const actor = actors[(index + 1) % 2];
      await evaluate(
        `(()=>{window.benchStart=performance.now();document.querySelector('#projects button[data-agent-id="${actor.id}"]:not([data-conversation-id])').click();})()`,
      );
      await ready(
        `document.querySelector('#runtime')?.dataset.owner===${JSON.stringify(actor.id)}&&(${frame})?.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
      );
      if (index >= WARMUP_SWITCHES)
        switchTimes.push(await evaluate("performance.now()-window.benchStart"));
    }
    await evaluate("document.querySelector('#extensions-entry').click()");
    await ready(
      `(()=>{const d=${frame};return [...d.querySelectorAll('.extension-page-choice')].some(node=>node.textContent.includes('任务与子代理'));})()`,
    );
    const panelTimes = [];
    for (let index = 0; index < INTERACTIONS; index++) {
      const task = index % 2 === 0;
      await evaluate(
        `(()=>{const d=${frame};d.defaultView.benchStart=d.defaultView.performance.now();[...d.querySelectorAll('.extension-page-choice')].find(node=>node.textContent.includes(${JSON.stringify(task ? "任务与子代理" : "对话分支")})).click();})()`,
      );
      await ready(
        `(()=>{const d=${frame};return ${task ? "!!d.querySelector('.task-panel-empty')?.checkVisibility()" : "!!d.querySelector('.branch-tree svg')?.checkVisibility()"};})()`,
      );
      panelTimes.push(
        await evaluate(
          `(${frame}).defaultView.performance.now()-(${frame}).defaultView.benchStart`,
        ),
      );
    }
    const afterCycles = await Promise.all(
      actors.map((actor) => memory(actor, "cycles")),
    );
    await evaluate(
      `document.querySelector('#projects button[data-agent-id="${actors[0].id}"]:not([data-conversation-id])').click()`,
    );
    await ready(`!(${frame}).querySelector('#view-workspace').hidden`);
    await evaluate(
      `(()=>{const d=${frame};window.benchStreamStart=performance.now();d.querySelector('#prompt').value='BENCH_STREAM';d.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));d.querySelector('#send-button').click();})()`,
    );
    await ready(
      `(${frame}).querySelector('#messages').innerText.includes('BENCH_STREAM_PART_0')`,
    );
    const streamFirstTokenMs = await evaluate(
      "performance.now()-window.benchStreamStart",
    );
    await ready(
      `(${frame}).querySelector('#messages').innerText.includes('BENCH_STREAM_END')`,
    );
    const streamTotalMs = await evaluate(
      "performance.now()-window.benchStreamStart",
    );
    await until(
      () => state(actors[0]),
      (value) => value.idle,
    );
    await pause(SETTLE_MS);
    const browserMetrics = await call("Performance.getMetrics");
    const browserReport = await evaluate(
      `(()=>{const all=[window,...[...document.querySelectorAll('iframe')].map(frame=>frame.contentWindow)].filter(current=>current.bench);return {requests:all.flatMap(current=>current.bench.requests),longTasks:all.flatMap(current=>current.bench.longTasks),mutations:all.reduce((sum,current)=>sum+current.bench.mutations,0)};})()`,
    );
    const heapAfter = await Promise.all(
      actors.map((actor) => memory(actor, "after")),
    );
    const rssAfter = await Promise.all(pids.map(rss));
    clearInterval(timer);
    timer = undefined;
    await sampling;
    if (samplingError) throw samplingError;
    assert.deepEqual(driver.errors, []);
    assert.ok(
      [...switchTimes, ...panelTimes].every(
        (value) => Number.isFinite(value) && value >= 0,
      ),
    );
    const row = {
      run: run + 1,
      fixture: {
        workers: 2,
        historyTurns: HISTORY_TURNS,
        historyUnits: HISTORY_UNITS,
        interactions: INTERACTIONS,
        sampleMs: SAMPLE_MS,
        fixtureApprovalMode: "yolo",
      },
      historyReadyMs,
      streamFirstTokenMs,
      streamTotalMs,
      switchMs: {
        values: switchTimes,
        median: quantile(switchTimes, 0.5),
        p95: quantile(switchTimes, 0.95),
      },
      panelMs: {
        values: panelTimes,
        median: quantile(panelTimes, 0.5),
        p95: quantile(panelTimes, 0.95),
      },
      heapBefore,
      afterCycles,
      heapAfter,
      rssAfter,
      rssSamples: samples,
      retainedAfterCycles: afterCycles.map(
        (value, index) =>
          value.afterGc.heapUsed - heapBefore[index].afterGc.heapUsed,
      ),
      browser: {
        ...browserReport,
        metrics: Object.fromEntries(
          browserMetrics.metrics.map((value) => [value.name, value.value]),
        ),
      },
      modelRequests: fixture.requests.length,
    };
    results.push(row);
    await writeFile(
      join(output, "results.json"),
      JSON.stringify({ provenance, repeats: REPEATS, runs: results }, null, 2) +
        "\n",
    );
    console.log(
      JSON.stringify({
        run: row.run,
        switchMedianMs: row.switchMs.median,
        switchP95Ms: row.switchMs.p95,
        panelMedianMs: row.panelMs.median,
        panelP95Ms: row.panelMs.p95,
        workerRssKiB: rssAfter.map((value) => value.rssKiB),
        retainedAfterCycles: row.retainedAfterCycles,
        modelRequests: row.modelRequests,
        requests: browserReport.requests.length,
        longTasks: browserReport.longTasks.length,
        mutations: browserReport.mutations,
      }),
    );
  } finally {
    clearInterval(timer);
    await sampling;
    driver?.close();
    if (browser && browser.exitCode === null) {
      const closed = once(browser, "close");
      browser.kill("SIGTERM");
      await closed;
    }
    await fixture.close();
  }
}
console.log(`性能原始结果：${join(output, "results.json")}`);
