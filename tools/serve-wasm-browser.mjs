import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const documentRoot = join(repositoryRoot, "dist", "wasm-browser");
const diskOverride = process.env.TRIPTYCH_CPM22_IMAGE || undefined;
const diskPath = resolve(diskOverride ?? join(documentRoot, "cpm22.img"));
const requestedPort = Number.parseInt(process.env.PORT ?? "8080", 10);
if (
  !Number.isInteger(requestedPort) ||
  requestedPort < 1 ||
  requestedPort > 65_535
) {
  throw new Error("PORT must be an integer from 1 through 65535");
}

const contentTypes = new Map([
  [".bin", "application/octet-stream"],
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

await stat(documentRoot);
await stat(diskPath);

function sendJson(response, value, method) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(method === "HEAD" ? undefined : body);
}

async function sendFile(response, path, method) {
  const information = await stat(path);
  response.writeHead(200, {
    "Content-Type":
      contentTypes.get(extname(path)) ?? "application/octet-stream",
    "Content-Length": information.size,
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (method === "HEAD") {
    response.end();
  } else {
    createReadStream(path).pipe(response);
  }
}

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (diskOverride !== undefined && url.pathname === "/config.json") {
      sendJson(
        response,
        {
          diskUrl: "/cpm22.img",
          diskName: basename(diskPath),
        },
        method,
      );
      return;
    }
    if (diskOverride !== undefined && url.pathname === "/cpm22.img") {
      await sendFile(response, diskPath, method);
      return;
    }

    const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const candidate = resolve(
      documentRoot,
      `.${decodeURIComponent(requestPath)}`,
    );
    const route = relative(documentRoot, candidate);
    if (route.startsWith("..") || resolve(documentRoot, route) !== candidate) {
      response.writeHead(403);
      response.end();
      return;
    }
    await sendFile(response, candidate, method);
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 500);
    response.end(error?.code === "ENOENT" ? "Not found\n" : "Server error\n");
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? address.port
      : requestedPort;
  console.log(`Triptych WASM terminal: http://127.0.0.1:${port}/`);
  console.log(`CP/M disk: ${diskPath}`);
  console.log("Press Ctrl-C to stop.");
});
