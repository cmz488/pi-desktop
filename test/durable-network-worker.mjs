import { startDurableDesk } from "../src/server/durable-server.mjs";

async function run() {
  const root = process.argv.at(-1);
  const app = await startDurableDesk({
    cwd: root,
    agentDir: root,
    directory: root + "/data",
    resources: false,
    port: 0,
    workspaceOptions: { settings: { retry: { enabled: false } } },
  });
  try {
    const id = (await app.workspace.read()).agents[0].id;
    await app.workspace.execute("send", {
      id,
      message: "local proxy fixture",
      requestId: "proxy-fixture",
    });
    let state;
    const deadline = Date.now() + 5000;
    do {
      state = (await app.workspace.read(id)).active;
      if (state.idle && state.messages.some((m) => m.role === "assistant"))
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    console.log(
      JSON.stringify({
        idle: state.idle,
        answers: state.messages
          .filter((m) => m.role === "assistant")
          .map((m) => ({ text: m.text, error: m.error })),
      }),
    );
  } finally {
    await app.stop();
  }
}

if (process.versions.electron) {
  const { app } = await import("electron");
  app
    .whenReady()
    .then(run)
    .then(() => app.exit(0))
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
} else {
  await run();
  process.exit(0);
}
