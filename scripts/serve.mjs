import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));
const options = parseOptions(process.argv.slice(2));
const host = options.host ?? process.env.HOST ?? "127.0.0.1";
const requestedPort = parsePort(options.port ?? process.env.PORT ?? "4173");
const portWasSpecified = options.port !== undefined || process.env.PORT !== undefined;

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
]);

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    respond(response, 405, "Method not allowed\n", "text/plain; charset=utf-8");
    return;
  }

  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    const pathname = decodeURIComponent(requestUrl.pathname);
    let filePath = resolve(rootDirectory, `.${pathname === "/" ? "/index.html" : pathname}`);

    if (filePath !== rootDirectory && !filePath.startsWith(`${rootDirectory}${sep}`)) {
      respond(response, 403, "Forbidden\n", "text/plain; charset=utf-8");
      return;
    }

    const fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      filePath = resolve(filePath, "index.html");
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    const statusCode = error?.code === "ENOENT" || error?.code === "ENOTDIR" ? 404 : 500;
    const message = statusCode === 404 ? "Not found\n" : "Server error\n";
    respond(response, statusCode, message, "text/plain; charset=utf-8");
  }
});

const activePort = await startServer(requestedPort);

if (activePort !== null) {
  console.log(`Global Conflict Tracker running at http://${host}:${activePort}`);
  console.log("Press Ctrl+C to stop the server.");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function respond(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function parseOptions(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--host" || argument === "--port") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      parsed[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return parsed;
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

async function startServer(startingPort) {
  const maximumAttempts = portWasSpecified ? 1 : 20;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const candidatePort = startingPort + attempt;
    if (candidatePort > 65535) {
      break;
    }

    try {
      await listen(candidatePort);
      return candidatePort;
    } catch (error) {
      const canTryNextPort = error?.code === "EADDRINUSE" && !portWasSpecified;
      if (canTryNextPort && attempt + 1 < maximumAttempts) {
        console.warn(`Port ${candidatePort} is already in use. Trying ${candidatePort + 1}...`);
        continue;
      }

      if (error?.code === "EADDRINUSE") {
        console.error(
          `Port ${candidatePort} is already in use. Choose another with npm run dev -- --port ${candidatePort + 1}`,
        );
      } else {
        console.error(`The development server could not start: ${error?.message ?? error}`);
      }
      process.exitCode = 1;
      return null;
    }
  }

  console.error(`No available port was found between ${startingPort} and ${startingPort + maximumAttempts - 1}.`);
  process.exitCode = 1;
  return null;
}

function listen(candidatePort) {
  return new Promise((resolveListen, rejectListen) => {
    const handleError = (error) => {
      server.off("listening", handleListening);
      rejectListen(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolveListen();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(candidatePort, host);
  });
}
