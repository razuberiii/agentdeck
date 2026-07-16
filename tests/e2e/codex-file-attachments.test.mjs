import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import WebSocket, { WebSocketServer } from "ws";
test(
  "Codex ordinary files survive Runtime restart and reach the app-server as verified paths",
  { timeout: 45_000 },
  async () => {
    const root = await mkdtemp(
        path.join(os.tmpdir(), "agentdeck-codex-files-"),
      ),
      data = path.join(root, "data"),
      workspace = path.join(root, "workspace"),
      home = path.join(root, "codex-home"),
      runtimePort = await port(),
      webPort = await port(),
      appPort = await port(),
      session = "codex-files",
      logs = [],
      fake = await fakeCodex(appPort, session, workspace);
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "auth.json"), "{}");
    const common = {
      ...process.env,
      NODE_ENV: "test",
      DATA_DIR: data,
      RUNTIME_DATA_DIR: data,
      RUNTIME_DB: path.join(data, "runtime.sqlite3"),
      RUNTIME_TOKEN: "file-test-token",
      AGENT_RUNTIME_TOKEN: "file-test-token",
      AGENT_RUNTIME_URL: `http://127.0.0.1:${runtimePort}`,
      CODEX_APP_SERVER_DEFAULT_PORT: String(appPort),
      CODEX_HOME: home,
      HOME: root,
      MAX_ATTACHMENT_BYTES: "1024",
      MAX_ATTACHMENTS_PER_MESSAGE: "10",
      MAX_TOTAL_ATTACHMENT_BYTES: "4096",
      ALLOWED_WORKSPACES: workspace,
      DEFAULT_WORKDIR: workspace,
      COOKIE_SECRET: "codex-file-cookie-secret-123456789",
      COOKIE_SECURE: "false",
      ADMIN_PASSWORD: "test-password",
      ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`,
      USE_AGENT_RUNTIME: "1",
    };
    let runtime = start(
        "server/dist/agentdeck-runtime.js",
        {
          ...common,
          RUNTIME_HOST: "127.0.0.1",
          RUNTIME_PORT: String(runtimePort),
          SKIP_RUNTIME_BOOTSTRAP: "1",
        },
        logs,
      ),
      web = start(
        "server/dist/index.js",
        { ...common, HOST: "127.0.0.1", PORT: String(webPort) },
        logs,
      ),
      ws;
    try {
      await waitHttp(runtimePort, "/healthz", runtime, logs);
      await waitHttp(webPort, "/api/status", web, logs);
      seed(path.join(data, "agentdeck.sqlite3"), session, workspace, home);
      assert.equal(
        (
          await post(
            runtimePort,
            "/codex/sessions/resume",
            {
              threadId: session,
              accountId: "default",
              codexHome: home,
              cwd: workspace,
              title: "files",
            },
            "file-test-token",
          )
        ).status,
        200,
      );
      const origin = `http://127.0.0.1:${webPort}`,
        login = await fetch(`${origin}/api/login`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            username: "admin",
            password: "test-password",
          }),
        }),
        cookies = login.headers
          .getSetCookie()
          .map((value) => value.split(";")[0]),
        cookie = cookies.join("; "),
        csrf =
          cookies
            .find((value) => value.startsWith("agentdeck_csrf="))
            ?.split("=")[1] || "",
        headers = { origin, cookie, "x-csrf-token": csrf };
      const status = await fetch(`${origin}/api/status`, {
          headers: { cookie },
        }).then((r) => r.json()),
        caps = status.capabilities;
      assert.equal(caps.providers.codex.imageInput, true);
      assert.equal(caps.providers.codex.fileInput, true);
      assert.equal(caps.providers.codex.fileTransport, "verified_path");
      assert.equal(caps.maxAttachmentBytes, 1024);
      assert.equal(caps.maxAttachmentsPerMessage, 10);
      assert.equal(caps.maxTotalAttachmentBytes, 4096);
      const files = [
        ["note.txt", "hello text", "text/plain"],
        ["readme.md", "# readme", "text/markdown"],
        ["data.json", '{"ok":true}', "application/json"],
        ["report.pdf", "%PDF-1.4\n%%EOF", "application/pdf"],
        [
          "bundle.zip",
          Buffer.from([0x50, 0x4b, 3, 4, 0, 0]),
          "application/zip",
        ],
        ["Main.java", "class Main {}", "text/plain"],
        ["app.ts", "export const x=1", "text/plain"],
        ["tool.py", "print(1)", "text/plain"],
        ["query.sql", "select 1;", "text/plain"],
        ["../../escape.ts", "export const safe=1", "text/plain"],
      ];
      const saved = [];
      for (const [name, content, type] of files) {
        const form = new FormData();
        form.append("file", new Blob([content], { type }), name);
        const response = await fetch(
          `${origin}/api/sessions/${session}/attachments`,
          { method: "POST", headers, body: form },
        );
        if (response.status !== 200)
          throw new Error(
            `${name}: ${response.status} ${await response.text()}`,
          );
        saved.push(await response.json());
      }
      assert.equal(saved.at(-1).name.includes(".."), false);
      assert.equal(saved.at(-1).name.includes("/"), false);
      const tooLarge = new FormData();
      tooLarge.append(
        "file",
        new Blob(["x".repeat(1025)], { type: "text/plain" }),
        "large.txt",
      );
      assert.equal(
        (
          await fetch(`${origin}/api/sessions/${session}/attachments`, {
            method: "POST",
            headers,
            body: tooLarge,
          })
        ).status,
        413,
      );
      runtime.kill("SIGTERM");
      await exited(runtime);
      runtime = start(
        "server/dist/agentdeck-runtime.js",
        {
          ...common,
          RUNTIME_HOST: "127.0.0.1",
          RUNTIME_PORT: String(runtimePort),
          SKIP_RUNTIME_BOOTSTRAP: "1",
        },
        logs,
      );
      await waitHttp(runtimePort, "/healthz", runtime, logs);
      assert.equal(
        (
          await post(
            runtimePort,
            "/codex/accounts/default",
            {},
            "file-test-token",
          )
        ).status,
        200,
      );
      await fake.connections(2);
      ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws`, {
        headers: { origin, cookie },
      });
      await opened(ws);
      ws.send(
        JSON.stringify({
          type: "join",
          sessionId: session,
          lastSequence: 0,
          clientAppliedSequence: 0,
          snapshotCoveredSequence: 0,
          clientConnectionId: "file-browser",
          joinRequestId: "join",
          recoveryEpoch: 0,
          runtimeGeneration: "",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      ws.send(
        JSON.stringify({
          type: "send",
          sessionId: session,
          clientMessageId: "file-message",
          text: "inspect files",
          attachments: saved.map(({ id, name, type, size }) => ({
            id,
            name,
            type,
            size,
          })),
          planMode: "direct",
        }),
      );
      await wait(() => {
        const receipt = messageReceipt(
          path.join(data, "agentdeck.sqlite3"),
          session,
          "file-message",
        );
        return !!receipt && receipt.status !== "received";
      });
      const receipt = messageReceipt(
        path.join(data, "agentdeck.sqlite3"),
        session,
        "file-message",
      );
      if (receipt?.status === "failed")
        throw new Error(`message failed: ${receipt.error}`);
      const turn = await fake.turn();
      const input = turn.params.input,
        joined = JSON.stringify(input);
      for (const item of saved) {
        assert.match(joined, new RegExp(escape(item.name)));
        const meta = JSON.parse(
          await readFile(
            path.join(data, "attachments", session, item.id, "meta.json"),
            "utf8",
          ),
        );
        await access(meta.path);
        assert.match(joined, new RegExp(escape(meta.path)));
        assert.ok(
          path
            .resolve(meta.path)
            .startsWith(path.resolve(data, "attachments", session) + path.sep),
        );
      }
      await wait(
        () =>
          canonicalAttachments(
            path.join(data, "agentdeck.sqlite3"),
            session,
            "file-message",
          ).length === saved.length,
      );
      const snapshot = await fetch(`${origin}/api/sessions/${session}`, {
        headers: { cookie },
      }).then((r) => r.json());
      assert.equal(JSON.stringify(snapshot).includes("note.txt"), true);
      fake.notify("turn/completed", {
        threadId: session,
        turn: { id: "provider-file-turn", status: "completed" },
      });
    } catch (error) {
      throw new Error(
        `${error?.stack || error}\n${logs.join("").slice(-12000)}`,
      );
    } finally {
      try {
        ws?.close();
      } catch {}
      for (const child of [web, runtime])
        if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.all([web, runtime].map(exited));
      await fake.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
function seed(file, id, cwd, home) {
  const db = new Database(file),
    now = Date.now();
  db.exec("DELETE FROM codex_profiles");
  db.prepare(
    "INSERT INTO codex_profiles(id,name,codex_home,active,status,created_at,updated_at)VALUES('default','Default',?,1,'authenticated',?,?)",
  ).run(home, now, now);
  db.prepare(
    "INSERT INTO sessions(id,codex_thread_id,project_dir,title,status,permission_mode,approval_policy,sandbox_mode,archived,created_at,updated_at,provider_id,account_id,creator_profile_id,selected_profile_id,executing_profile_id,upstream_binding_profile_id,last_execution_account_id,current_upstream_account_id)VALUES(?,?,?,'Files','idle','workspace-write','never','workspace-write',0,?,?,'codex','default','default','default','default','default','default','default')",
  ).run(id, id, cwd, now, now);
  db.close();
}
function canonicalAttachments(file, session, client) {
  const db = new Database(file, { readonly: true }),
    value = db
      .prepare(
        "SELECT attachments_json FROM agent_messages WHERE session_id=? AND client_message_id=?",
      )
      .pluck()
      .get(session, client);
  db.close();
  return value ? JSON.parse(value) : [];
}
function messageReceipt(file, session, client) {
  const db = new Database(file, { readonly: true }),
    row = db
      .prepare(
        "SELECT status,error FROM message_receipts WHERE session_id=? AND client_message_id=?",
      )
      .get(session, client);
  db.close();
  return row;
}
function start(file, env, logs) {
  const child = spawn(process.execPath, [file], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (x) => logs.push(String(x)));
  child.stderr.on("data", (x) => logs.push(String(x)));
  return child;
}
async function fakeCodex(portNumber, threadId, cwd) {
  const sockets = [],
    turns = [],
    waiters = [],
    server = createServer((req, res) => {
      res.statusCode = req.url === "/readyz" ? 200 : 404;
      res.end();
    }),
    wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws)),
  );
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id === undefined) return;
      if (msg.method === "turn/start") {
        turns.push(msg);
        waiters.shift()?.resolve(msg);
      }
      let result = {};
      if (msg.method === "initialize") result = { capabilities: {} };
      else if (msg.method === "thread/resume" || msg.method === "thread/read")
        result = {
          thread: { id: threadId, cwd, status: { type: "active" }, turns: [] },
        };
      else if (msg.method === "thread/list") result = { data: [] };
      else if (msg.method === "turn/start")
        result = { turn: { id: "provider-file-turn", status: "inProgress" } };
      else if (msg.method === "account/read")
        result = { account: { type: "chatgpt" } };
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(portNumber, "127.0.0.1", resolve);
  });
  return {
    async connections(count) {
      await wait(() => sockets.length >= count);
    },
    turn() {
      if (turns.length) return Promise.resolve(turns.shift());
      return new Promise((resolve, reject) => {
        const waiter = { resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("turn/start not received"));
        }, 10000);
      });
    },
    notify(method, params) {
      const ws = [...sockets].reverse().find((x) => x.readyState === 1);
      ws.send(JSON.stringify({ method, params }));
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
      wss.close();
    },
  };
}
async function wait(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition timeout");
}
async function waitHttp(portNumber, url, child, logs) {
  await wait(async () => {
    if (child.exitCode !== null) throw new Error(logs.join(""));
    try {
      return (
        await fetch(`http://127.0.0.1:${portNumber}${url}`, {
          headers: { authorization: "Bearer file-test-token" },
        })
      ).ok;
    } catch {
      return false;
    }
  });
}
function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(value)));
    });
  });
}
async function post(portNumber, url, body, token) {
  const response = await fetch(`http://127.0.0.1:${portNumber}${url}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
function opened(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}
function exited(child) {
  return new Promise((resolve) =>
    child.exitCode === null ? child.once("exit", resolve) : resolve(),
  );
}
function escape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
