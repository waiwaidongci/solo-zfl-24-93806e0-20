import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createStore } from "./store.js";
import { createGateway } from "./gateway.js";
import {
  METRICS,
  DomainError,
  nextId,
  ingestReading,
  evaluateDeviceAlarms,
  confirmAlarm,
  resolveAlarm,
  syncFansWithAlarms,
  createCommandWorker
} from "./monitor.js";
import { page } from "./page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pigeonSeed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ]
};

function monitorSeed() {
  return {
    counters: { user: 1, loft: 0, device: 0, fan: 0, alarm: 0, command: 0 },
    users: [{ id: "U0001", username: "admin", password: "admin123", role: "admin", loftId: null, createdAt: Date.now() }],
    lofts: [],
    devices: [],
    fans: [],
    alarms: [],
    commands: []
  };
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function need(condition, status, code) {
  if (!condition) throw new DomainError(status, code);
}

export function createApp(options = {}) {
  const dataDir = options.dataDir || join(__dirname, "..", "data");
  const monitorStore = createStore(join(dataDir, "monitor.json"), monitorSeed(), options.monitorStoreHooks);
  const pigeonStore = createStore(join(dataDir, "pigeons.json"), pigeonSeed, options.pigeonStoreHooks);
  const gateway = options.gateway || createGateway(options.gatewayOptions);
  const worker = createCommandWorker({
    store: monitorStore,
    gateway,
    attemptTimeoutMs: options.attemptTimeoutMs ?? 1500,
    auto: options.autoWorker !== false
  });
  const sessions = new Map(); // token -> { user, createdAt }（会话在内存中，重启后需重新登录）

  function authUser(req) {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const session = sessions.get(match[1]);
    return session ? session.user : null;
  }
  function requireUser(req) {
    const user = authUser(req);
    if (!user) throw new DomainError(401, "unauthenticated");
    return user;
  }
  function requireAdmin(req) {
    const user = requireUser(req);
    if (user.role !== "admin") throw new DomainError(403, "forbidden");
    return user;
  }
  // 棚管员只能查看和操作本棚；总站管理员可操作所有棚
  function requireLoftAccess(user, loftId) {
    if (user.role !== "admin" && user.loftId !== loftId) throw new DomainError(403, "forbidden_loft");
  }

  function deviceView(device, { includeKey = false } = {}) {
    const view = {
      id: device.id,
      loftId: device.loftId,
      type: device.type,
      name: device.name,
      thresholds: device.thresholds,
      streak: device.streak,
      lastValue: device.lastValue ?? null,
      lastCollectedAt: device.lastCollectedAt ?? null,
      lastReceivedAt: device.lastReceivedAt ?? null,
      readingCount: device.readings.length,
      recentReadings: device.readings.slice(-10).reverse(),
      createdAt: device.createdAt
    };
    if (includeKey) view.key = device.key;
    return view;
  }

  function loftOverview(db, loftId, { includeKeys = false } = {}) {
    const loft = db.lofts.find(l => l.id === loftId);
    if (!loft) throw new DomainError(404, "loft_not_found");
    return {
      loft,
      devices: db.devices.filter(d => d.loftId === loftId).map(d => deviceView(d, { includeKey: includeKeys })),
      fans: db.fans.filter(f => f.loftId === loftId),
      alarms: db.alarms.filter(a => a.loftId === loftId).slice(0, 50),
      commands: db.commands.filter(c => c.loftId === loftId).slice(0, 50)
    };
  }

  function relation(db, ringNo) {
    const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
    if (!pigeon) return null;
    const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
    const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
    const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
    return { pigeon, father, mother, children };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page);
      }
      if (req.method === "GET" && path === "/api/health") return sendJson(res, 200, { ok: true });

      // ---------- 原有鸽只档案接口（公开） ----------
      if (req.method === "GET" && path === "/api/pigeons") return sendJson(res, 200, pigeonStore.get().pigeons);
      if (req.method === "POST" && path === "/api/pigeons") {
        const input = await body(req);
        const pigeon = await pigeonStore.mutate(db => {
          if (db.pigeons.some(item => item.ringNo === input.ringNo)) throw new DomainError(409, "ring_exists");
          const created = { ...input, vaccines: [], transfers: [], races: [] };
          db.pigeons.unshift(created);
          return created;
        });
        return sendJson(res, 201, pigeon);
      }
      const relationMatch = path.match(/^\/api\/pigeons\/(.+)\/relation$/);
      if (relationMatch && req.method === "GET") {
        const data = relation(pigeonStore.get(), decodeURIComponent(relationMatch[1]));
        return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
      }
      const pigeonActionMatch = path.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
      if (pigeonActionMatch && req.method === "POST") {
        const input = await body(req);
        const pigeon = await pigeonStore.mutate(db => {
          const target = db.pigeons.find(item => item.ringNo === decodeURIComponent(pigeonActionMatch[1]));
          if (!target) throw new DomainError(404, "pigeon_not_found");
          if (pigeonActionMatch[2] === "transfers") {
            const transfer = { date: input.date || new Date().toISOString().slice(0, 10), from: target.owner, to: input.to };
            target.owner = input.to;
            target.transfers.push(transfer);
          }
          if (pigeonActionMatch[2] === "races") target.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
          if (pigeonActionMatch[2] === "vaccines") target.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name });
          return target;
        });
        return sendJson(res, 200, pigeon);
      }

      // ---------- 登录会话 ----------
      if (req.method === "POST" && path === "/api/login") {
        const input = await body(req);
        const user = monitorStore.get().users.find(u => u.username === input.username && u.password === input.password);
        if (!user) return sendJson(res, 401, { error: "invalid_credentials" });
        const token = randomUUID();
        const sessionUser = { id: user.id, username: user.username, role: user.role, loftId: user.loftId };
        sessions.set(token, { user: sessionUser, createdAt: Date.now() });
        return sendJson(res, 200, { token, user: sessionUser });
      }
      if (req.method === "POST" && path === "/api/logout") {
        const header = req.headers.authorization || "";
        const match = header.match(/^Bearer\s+(.+)$/i);
        if (match) sessions.delete(match[1]);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/api/me") return sendJson(res, 200, { user: authUser(req) });

      // ---------- 总站管理员：棚区 / 棚管员 / 设备与阈值 / 风机 ----------
      if (req.method === "POST" && path === "/api/admin/lofts") {
        requireAdmin(req);
        const input = await body(req);
        need(input.name && String(input.name).trim(), 400, "invalid_name");
        const loft = await monitorStore.mutate(db => {
          const created = { id: nextId(db, "loft"), name: String(input.name).trim(), createdAt: Date.now() };
          db.lofts.push(created);
          return created;
        });
        return sendJson(res, 201, loft);
      }
      if (req.method === "GET" && path === "/api/admin/users") {
        requireAdmin(req);
        const users = monitorStore.get().users.map(u => ({ id: u.id, username: u.username, role: u.role, loftId: u.loftId, createdAt: u.createdAt }));
        return sendJson(res, 200, users);
      }
      if (req.method === "POST" && path === "/api/admin/users") {
        requireAdmin(req);
        const input = await body(req);
        need(input.username && input.password, 400, "invalid_credentials_payload");
        const user = await monitorStore.mutate(db => {
          need(!db.users.some(u => u.username === input.username), 409, "user_exists");
          const loftId = input.loftId || null;
          if (loftId) need(db.lofts.some(l => l.id === loftId), 404, "loft_not_found");
          const created = { id: nextId(db, "user"), username: String(input.username), password: String(input.password), role: "keeper", loftId, createdAt: Date.now() };
          db.users.push(created);
          return created;
        });
        return sendJson(res, 201, { id: user.id, username: user.username, role: user.role, loftId: user.loftId });
      }
      if (req.method === "POST" && path === "/api/admin/devices") {
        requireAdmin(req);
        const input = await body(req);
        need(METRICS.includes(input.type), 400, "invalid_metric");
        need(Number.isFinite(Number(input.min)) && Number.isFinite(Number(input.max)) && Number(input.min) < Number(input.max), 400, "invalid_thresholds");
        const device = await monitorStore.mutate(db => {
          need(db.lofts.some(l => l.id === input.loftId), 404, "loft_not_found");
          const created = {
            id: nextId(db, "device"),
            loftId: input.loftId,
            type: input.type,
            name: String(input.name || input.type),
            key: `dev_${randomUUID()}`,
            thresholds: { min: Number(input.min), max: Number(input.max) },
            readings: [],
            reportIds: [],
            streak: 0,
            lastValue: null,
            lastCollectedAt: null,
            lastReceivedAt: null,
            createdAt: Date.now()
          };
          db.devices.push(created);
          return created;
        });
        return sendJson(res, 201, deviceView(device, { includeKey: true }));
      }
      const deviceAdminMatch = path.match(/^\/api\/admin\/devices\/([^/]+)$/);
      if (deviceAdminMatch && req.method === "PUT") {
        requireAdmin(req);
        const input = await body(req);
        need(Number.isFinite(Number(input.min)) && Number.isFinite(Number(input.max)) && Number(input.min) < Number(input.max), 400, "invalid_thresholds");
        const device = await monitorStore.mutate(db => {
          const target = db.devices.find(d => d.id === decodeURIComponent(deviceAdminMatch[1]));
          need(target, 404, "device_not_found");
          target.thresholds = { min: Number(input.min), max: Number(input.max) };
          return target;
        });
        return sendJson(res, 200, deviceView(device, { includeKey: true }));
      }
      if (req.method === "POST" && path === "/api/admin/fans") {
        requireAdmin(req);
        const input = await body(req);
        const fan = await monitorStore.mutate(db => {
          need(db.lofts.some(l => l.id === input.loftId), 404, "loft_not_found");
          const created = { id: nextId(db, "fan"), loftId: input.loftId, name: String(input.name || "风机"), state: "off", commandEpoch: 0, createdAt: Date.now() };
          db.fans.push(created);
          return created;
        });
        return sendJson(res, 201, fan);
      }
      // 模拟网关模式（验证回滚重试用）：ok / fail / timeout / flaky
      if (req.method === "POST" && path === "/api/admin/gateway") {
        requireAdmin(req);
        const input = await body(req);
        need(["ok", "fail", "timeout", "flaky"].includes(input.mode), 400, "invalid_mode");
        gateway.setMode(input.mode, Number(input.failures || 0));
        return sendJson(res, 200, { mode: gateway.state.mode, failuresLeft: gateway.state.failuresLeft });
      }
      if (req.method === "GET" && path === "/api/admin/gateway") {
        requireAdmin(req);
        return sendJson(res, 200, { mode: gateway.state.mode, failuresLeft: gateway.state.failuresLeft, log: gateway.state.log.slice(-20) });
      }

      // ---------- 棚区视图（棚管员仅限本棚） ----------
      if (req.method === "GET" && path === "/api/lofts") {
        const user = requireUser(req);
        const lofts = monitorStore.get().lofts.filter(l => user.role === "admin" || l.id === user.loftId);
        return sendJson(res, 200, lofts);
      }
      const overviewMatch = path.match(/^\/api\/lofts\/([^/]+)\/overview$/);
      if (overviewMatch && req.method === "GET") {
        const user = requireUser(req);
        const loftId = decodeURIComponent(overviewMatch[1]);
        requireLoftAccess(user, loftId);
        const overview = loftOverview(monitorStore.get(), loftId, { includeKeys: user.role === "admin" });
        if (user.role === "admin") overview.gateway = { mode: gateway.state.mode };
        return sendJson(res, 200, overview);
      }

      // ---------- 设备上报读数（设备 key 或管理员） ----------
      const readingMatch = path.match(/^\/api\/devices\/([^/]+)\/readings$/);
      if (readingMatch && req.method === "POST") {
        const deviceId = decodeURIComponent(readingMatch[1]);
        const input = await body(req);
        const result = await monitorStore.mutate(db => {
          const device = db.devices.find(d => d.id === deviceId);
          need(device, 404, "device_not_found");
          const user = authUser(req);
          const keyOk = req.headers["x-device-key"] === device.key;
          if (!keyOk && !(user && user.role === "admin")) throw new DomainError(401, "invalid_device_key");
          const r = ingestReading(device, input);
          let alarmEvents = [];
          let commands = [];
          if (r.stored) {
            alarmEvents = evaluateDeviceAlarms(db, device);
            commands = syncFansWithAlarms(db, device.loftId);
          }
          return {
            ...r,
            readingCount: device.readings.length,
            streak: device.streak,
            alarmEvents: alarmEvents.map(e => ({ type: e.type, alarmId: e.alarm.id, level: e.alarm.level, status: e.alarm.status })),
            commands: commands.map(c => ({ id: c.id, action: c.action, status: c.status, epoch: c.epoch }))
          };
        });
        worker.schedule();
        return sendJson(res, 200, result);
      }

      // ---------- 告警确认 / 解除（本棚管理员，不可跳级） ----------
      const alarmActionMatch = path.match(/^\/api\/alarms\/([^/]+)\/(confirm|resolve)$/);
      if (alarmActionMatch && req.method === "POST") {
        const user = requireUser(req);
        const alarmId = decodeURIComponent(alarmActionMatch[1]);
        const action = alarmActionMatch[2];
        const result = await monitorStore.mutate(db => {
          const alarm = db.alarms.find(a => a.id === alarmId);
          need(alarm, 404, "alarm_not_found");
          requireLoftAccess(user, alarm.loftId);
          const updated = action === "confirm" ? confirmAlarm(alarm, user.username) : resolveAlarm(alarm, user.username);
          const commands = action === "resolve" ? syncFansWithAlarms(db, alarm.loftId) : [];
          return { alarm: updated, commands: commands.map(c => ({ id: c.id, action: c.action, status: c.status, epoch: c.epoch })) };
        });
        worker.schedule();
        return sendJson(res, 200, result);
      }
      if (req.method === "GET" && path === "/api/alarms") {
        const user = requireUser(req);
        const loftId = url.searchParams.get("loftId");
        if (user.role !== "admin") requireLoftAccess(user, loftId || user.loftId);
        let alarms = monitorStore.get().alarms;
        alarms = user.role === "admin" ? alarms : alarms.filter(a => a.loftId === user.loftId);
        if (loftId) alarms = alarms.filter(a => a.loftId === loftId);
        return sendJson(res, 200, alarms.slice(0, 100));
      }
      if (req.method === "GET" && path === "/api/commands") {
        const user = requireUser(req);
        const loftId = url.searchParams.get("loftId");
        if (user.role !== "admin") requireLoftAccess(user, loftId || user.loftId);
        let commands = monitorStore.get().commands;
        commands = user.role === "admin" ? commands : commands.filter(c => c.loftId === user.loftId);
        if (loftId) commands = commands.filter(c => c.loftId === loftId);
        return sendJson(res, 200, commands.slice(0, 100));
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DomainError) return sendJson(res, error.status, { error: error.code });
      sendJson(res, 500, { error: error.message });
    }
  });

  async function start(port = 0) {
    await monitorStore.load();
    await pigeonStore.load();
    await worker.recoverAfterBoot();
    await new Promise(resolve => server.listen(port, resolve));
    worker.schedule();
    return server.address().port;
  }

  async function stop() {
    worker.stop();
    await new Promise(resolve => server.close(resolve));
  }

  return {
    server,
    start,
    stop,
    gateway,
    worker,
    sessions,
    stores: { monitor: monitorStore, pigeons: pigeonStore },
    port: () => (server.address() ? server.address().port : null)
  };
}
