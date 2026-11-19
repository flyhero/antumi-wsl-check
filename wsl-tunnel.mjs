// packages/core/src/wsl-tunnel.ts
import { mkdir, readFile as readFile2, rm as rm2 } from "node:fs/promises";
import path from "node:path";

// packages/protocol/src/node/private-file.ts
import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
async function writePrivateJson(file, value) {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
    await chmod(tmp, 384);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

// packages/protocol/src/node/stdio-tunnel.ts
import { createConnection, createServer } from "node:net";
var FRAME = { open: 1, data: 2, end: 3, reset: 4 };
var HEADER_BYTES = 10;
var MAX_FRAME_BYTES = 1024 * 1024;
var DATA_SLICE_BYTES = 256 * 1024;
var TUNNEL_SENTINEL = "ANTUMI-TUNNEL 1 ";
var TUNNEL_TARGETS = { app: "app", helper: "helper" };
async function openStdioTunnel(options) {
  const listening = [];
  try {
    for (const offer of options.offers ?? []) {
      if ("server" in offer) listening.push({ target: offer.target, server: offer.server, owned: false });
      else listening.push({ target: offer.target, server: await listenLoopback(offer.port ?? 0), owned: true });
    }
  } catch (error) {
    for (const entry of listening) if (entry.owned) entry.server.close();
    throw error;
  }
  return runTunnel(options, listening);
}
function listenLoopback(port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer({ allowHalfOpen: true });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
function runTunnel(options, listening) {
  const { input, output } = options;
  const dials = options.dials ?? {};
  const mine = /* @__PURE__ */ new Map();
  const theirs = /* @__PURE__ */ new Map();
  let nextId = 1;
  let finished = false;
  let settle = () => {
  };
  const closed = new Promise((resolve) => settle = resolve);
  let outboundBlocked = false;
  const stalled = /* @__PURE__ */ new Set();
  const send = (type, stream, payload) => {
    if (finished) return;
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt8(type, 0);
    header.writeUInt8(stream.mine ? 0 : 1, 1);
    header.writeUInt32BE(stream.id, 2);
    header.writeUInt32BE(payload?.length ?? 0, 6);
    let ok = output.write(header);
    if (payload?.length) ok = output.write(payload);
    if (!ok && !outboundBlocked) {
      outboundBlocked = true;
      for (const each of [...mine.values(), ...theirs.values()]) each.socket.pause();
    }
  };
  const onDrain = () => {
    outboundBlocked = false;
    for (const each of [...mine.values(), ...theirs.values()]) each.socket.resume();
  };
  const unstall = (stream) => {
    if (stalled.delete(stream) && stalled.size === 0 && !finished) input.resume();
  };
  const forget = (stream) => {
    stream.gone = true;
    (stream.mine ? mine : theirs).delete(stream.id);
    unstall(stream);
  };
  const attach = (stream) => {
    const { socket } = stream;
    (stream.mine ? mine : theirs).set(stream.id, stream);
    if (outboundBlocked) socket.pause();
    socket.on("data", (chunk) => {
      for (let at = 0; at < chunk.length; at += DATA_SLICE_BYTES) send(FRAME.data, stream, chunk.subarray(at, at + DATA_SLICE_BYTES));
    });
    socket.on("end", () => {
      stream.sentEnd = true;
      send(FRAME.end, stream);
    });
    socket.on("drain", () => unstall(stream));
    socket.on("error", () => {
    });
    socket.on("close", () => {
      if (stream.gone) return;
      if (!(stream.sentEnd && stream.gotEnd)) send(FRAME.reset, stream);
      forget(stream);
    });
  };
  const offerConnection = (target) => (socket) => {
    if (finished) {
      abort(socket);
      return;
    }
    const stream = { id: nextId, mine: true, socket, sentEnd: false, gotEnd: false, gone: false };
    nextId = nextId >= 4294967295 ? 1 : nextId + 1;
    attach(stream);
    send(FRAME.open, stream, Buffer.from(target, "utf8"));
  };
  const handlers = listening.map((entry) => {
    const handler = offerConnection(entry.target);
    entry.server.on("connection", handler);
    return { server: entry.server, handler, owned: entry.owned };
  });
  const ports = Object.fromEntries(listening.map((entry) => [entry.target, portOf(entry.server)]));
  const opened = (id, target) => {
    const port = dials[target];
    const socket = port === void 0 ? null : createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
    if (!socket || theirs.has(id)) {
      send(FRAME.reset, { id, mine: false });
      if (socket) abort(socket);
      return;
    }
    attach({ id, mine: false, socket, sentEnd: false, gotEnd: false, gone: false });
  };
  const deliver = (type, opener, id, payload) => {
    if (type === FRAME.open) {
      if (opener !== 0) throw new Error("tunnel: OPEN for a stream this end owns");
      opened(id, payload.toString("utf8"));
      return;
    }
    const stream = (opener === 0 ? theirs : mine).get(id);
    if (type === FRAME.data) {
      if (stream && !stream.gotEnd && !stream.socket.write(payload)) {
        stalled.add(stream);
        input.pause();
      }
    } else if (type === FRAME.end) {
      if (stream && !stream.gotEnd) {
        stream.gotEnd = true;
        stream.socket.end();
      }
    } else if (type === FRAME.reset) {
      if (stream) {
        forget(stream);
        abort(stream.socket);
      }
    } else {
      throw new Error(`tunnel: unknown frame type ${type}`);
    }
  };
  let pending = Buffer.alloc(0);
  const queued = [];
  let reading = false;
  const onData = (chunk) => {
    queued.push(chunk);
    if (reading) return;
    reading = true;
    try {
      for (let next = queued.shift(); next && !finished; next = queued.shift()) {
        pending = pending.length ? Buffer.concat([pending, next]) : next;
        let at = 0;
        while (!finished && pending.length - at >= HEADER_BYTES) {
          const length = pending.readUInt32BE(at + 6);
          if (length > MAX_FRAME_BYTES) throw new Error(`tunnel: frame of ${length} bytes`);
          if (pending.length - at < HEADER_BYTES + length) break;
          const type = pending.readUInt8(at);
          const opener = pending.readUInt8(at + 1);
          const id = pending.readUInt32BE(at + 2);
          const payload = pending.subarray(at + HEADER_BYTES, at + HEADER_BYTES + length);
          at += HEADER_BYTES + length;
          deliver(type, opener, id, payload);
        }
        pending = pending.subarray(at);
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    } finally {
      reading = false;
    }
  };
  const onEnd = () => finish(null);
  const onClose = () => finish(new Error("tunnel: input closed without ending"));
  const onError = (error) => finish(error);
  function finish(reason2) {
    if (finished) return;
    finished = true;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", onClose);
    output.off("drain", onDrain);
    for (const { server, handler, owned } of handlers) {
      server.off("connection", handler);
      if (owned) server.close();
    }
    for (const stream of [...mine.values(), ...theirs.values()]) {
      stream.gone = true;
      abort(stream.socket);
    }
    mine.clear();
    theirs.clear();
    stalled.clear();
    try {
      output.end();
    } catch {
    }
    input.destroy();
    settle(reason2);
  }
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onClose);
  input.on("error", onError);
  output.on("drain", onDrain);
  output.on("error", onError);
  if (options.head?.length) onData(options.head);
  if (!finished) input.resume();
  return { ports, close: () => finish(null), closed };
}
function abort(socket) {
  if (socket.destroyed) return;
  socket.on("error", () => {
  });
  socket.resetAndDestroy();
}
function portOf(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("tunnel: offered server is not listening on a port");
  return address.port;
}
function readFirstLine(input, options) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const prefix = options.prefix === void 0 ? null : Buffer.from(options.prefix, "utf8");
    const timer = options.timeoutMs === void 0 ? null : setTimeout(() => fail2(new Error(`no first line within ${options.timeoutMs} ms`)), options.timeoutMs);
    const done = () => {
      if (timer) clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", fail2);
    };
    function fail2(error) {
      done();
      input.pause();
      reject(error);
    }
    const onEnd = () => fail2(new Error("stream ended before its first line"));
    const onData = (chunk) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      const newline = buffered.indexOf(10);
      const head = newline === -1 ? buffered : buffered.subarray(0, newline);
      if (prefix) {
        const span = Math.min(head.length, prefix.length);
        if (!head.subarray(0, span).equals(prefix.subarray(0, span)) || newline !== -1 && head.length < prefix.length) {
          fail2(new Error(`unexpected output before the first line: ${JSON.stringify(head.subarray(0, 200).toString("utf8"))}`));
          return;
        }
      }
      if (newline === -1) {
        if (buffered.length > options.maxBytes) fail2(new Error(`first line longer than ${options.maxBytes} bytes`));
        return;
      }
      done();
      input.pause();
      resolve({ line: buffered.subarray(0, newline).toString("utf8").replace(/\r$/, ""), rest: buffered.subarray(newline + 1) });
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.on("error", fail2);
    input.resume();
  });
}
function sentinelLine(port) {
  return `${TUNNEL_SENTINEL}${JSON.stringify({ port })}
`;
}

// packages/core/src/wsl-tunnel.ts
function parseTunnelHelperConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("config is not JSON");
  }
  if (!isObject(raw)) throw new Error("config is not an object");
  const config = {};
  if (raw.listen !== void 0) {
    const listen = raw.listen;
    if (!isObject(listen)) throw new Error("listen is not an object");
    const { endpointFile, endpoint } = listen;
    if (endpointFile !== void 0 && (typeof endpointFile !== "string" || !path.posix.isAbsolute(endpointFile))) throw new Error("listen.endpointFile is not an absolute path");
    if (endpoint !== void 0 && !isObject(endpoint)) throw new Error("listen.endpoint is not an object");
    if (endpointFile === void 0 !== (endpoint === void 0)) throw new Error("listen.endpointFile and listen.endpoint go together");
    config.listen = endpointFile === void 0 || endpoint === void 0 ? {} : { endpointFile, endpoint };
  }
  if (raw.dial !== void 0) {
    const dial = raw.dial;
    if (!isObject(dial) || typeof dial.port !== "number" || !Number.isInteger(dial.port) || dial.port < 1 || dial.port > 65535) throw new Error("dial.port is not a port");
    config.dial = { port: dial.port };
  }
  if (!config.listen && !config.dial) throw new Error("config has neither listen nor dial");
  return config;
}
async function startTunnelHelper(options) {
  const pid = options.pid ?? process.pid;
  const { line, rest } = await readFirstLine(options.stdin, { maxBytes: 64 * 1024 });
  const config = parseTunnelHelperConfig(line);
  const server = config.listen ? await listenLoopback(0) : null;
  const address = server?.address();
  const port = address && typeof address === "object" ? address.port : null;
  const endpointFile = config.listen?.endpointFile;
  options.stdout.write(sentinelLine(port));
  const tunnel = await openStdioTunnel({
    input: options.stdin,
    output: options.stdout,
    head: rest,
    offers: server ? [{ target: TUNNEL_TARGETS.app, server }] : [],
    dials: config.dial ? { [TUNNEL_TARGETS.helper]: config.dial.port } : {}
  });
  const stopped = tunnel.closed.then(async (reason2) => {
    server?.close();
    if (endpointFile) await removeOwnEndpoint(endpointFile, pid).catch(() => {
    });
    return reason2;
  });
  if (endpointFile && port !== null) {
    try {
      await mkdir(path.dirname(endpointFile), { recursive: true, mode: 448 });
      await writePrivateJson(endpointFile, { ...config.listen?.endpoint, port, pid });
    } catch (error) {
      tunnel.close();
      await stopped;
      throw error;
    }
  }
  return {
    port,
    stop: async () => {
      tunnel.close();
      await stopped;
    },
    stopped
  };
}
async function removeOwnEndpoint(file, pid) {
  let current;
  try {
    current = JSON.parse(await readFile2(file, "utf8"));
  } catch {
    return;
  }
  if (isObject(current) && current.pid === pid) await rm2(file, { force: true });
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// packages/core/src/wsl-tunnel-main.ts
function fail(error) {
  process.stderr.write(`[antumi-tunnel] ${error instanceof Error ? error.message : String(error)}
`);
  process.exit(1);
}
var helper = await startTunnelHelper({ stdin: process.stdin, stdout: process.stdout }).catch(fail);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void helper.stop());
}
var reason = await helper.stopped;
if (reason) process.stderr.write(`[antumi-tunnel] ${reason.message}
`);
process.exit(0);
