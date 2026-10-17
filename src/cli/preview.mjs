import { createServer } from "node:http";
import {
  createStaticAssetHandler,
  publicAssets,
} from "../server/web-assets.mjs";

const serve = createStaticAssetHandler(publicAssets("preview"));
const server = createServer(async (request, response) => {
  try {
    if (
      await serve(
        request,
        response,
        new URL(request.url, "http://localhost").pathname,
      )
    )
      return;
    response.writeHead(404);
    response.end("Not found");
  } catch (error) {
    console.error(error);
    response.writeHead(500);
    response.end("Preview file could not be read");
  }
});
server.listen(4317, "127.0.0.1", () =>
  console.log("Pi Desk design: http://127.0.0.1:4317"),
);
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
