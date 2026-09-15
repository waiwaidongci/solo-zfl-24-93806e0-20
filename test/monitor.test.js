import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/app.js";

// ---------- 测试辅助 ----------
async function makeApp(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pigeon-mon-"));
  const app = createApp({ dataDir: dir, ...options });
  const port = await app.start(0);
  const base = `http://127.0.0.1:${port}`;
  return {
    app,
    dir,
    base,
    async cleanup() {
      await app.stop();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function api(base, path, { token, method = "GET", body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitFor(fn, { timeout = 4000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error("waitFor 超时");
    await new Promise(r => setTimeout(r, interval));
  }
}

// 建一个棚区 + 温度设备 + 风机 + 棚管员，返回各 id 与 token
async function setupLoft(base, adminToken, { min = 10, max = 30 } = {}) {
  const loft = (await api(base, "/api/admin/lofts", { token: adminToken, method: "POST", body: { name: "测试棚" } })).data;
  const device = (await api(base, "/api/admin/devices", { token: adminToken, method: "POST", body: { loftId: loft.id, type: "temperature", name: "温度1", min, max } })).data;
  const fan = (await api(base, "/api/admin/fans", { token: adminToken, method: "POST", body: { loftId: loft.id, name: "风机1" } })).data;
  return { loft, device, fan };
}

async function login(base, username, password) {
  const res = await api(base, "/api/login", { method: "POST", body: { username, password } });
  assert.equal(res.status, 200, `登录失败: ${JSON.stringify(res.data)}`);
  return res.data.token;
}

async function report(base, device, body, useKey = true) {
  return api(base, `/api/devices/${device.id}/readings`, { method: "POST", body, headers: useKey ? { "X-Device-Key": device.key } : {} });
}

async function overview(base, token, loftId) {
  const res = await api(base, `/api/lofts/${loftId}/overview`, { token });
  assert.equal(res.status, 200);
  return res.data;
}

// ---------- 读数上报：去重与乱序归并 ----------
test("重复上报只算一次（reportId 与采集时间双去重）", async () => {
  const ctx = await makeApp();
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { device } = await setupLoft(ctx.base, admin);
    const t = Date.parse("2026-09-15T10:00:00Z");

    const r1 = await report(ctx.base, device, { value: 20, collectedAt: t, reportId: "r-1" });
    assert.equal(r1.data.stored, true);
    const r2 = await report(ctx.base, device, { value: 20, collectedAt: t, reportId: "r-1" });
    assert.equal(r2.data.deduplicated, true);
    assert.equal(r2.data.reason, "duplicate_report_id");
    const r3 = await report(ctx.base, device, { value: 99, collectedAt: t, reportId: "r-2" });
    assert.equal(r3.data.deduplicated, true);
    assert.equal(r3.data.reason, "duplicate_collected_at");
    assert.equal(r3.data.readingCount, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("迟到乱序数据按采集时间归并，最新值以采集时间为准", async () => {
  const ctx = await makeApp();
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { loft, device } = await setupLoft(ctx.base, admin);
    const t1 = Date.parse("2026-09-15T10:00:00Z");
    const t2 = Date.parse("2026-09-15T10:01:00Z");
    const t3 = Date.parse("2026-09-15T10:02:00Z");

    await report(ctx.base, device, { value: 22, collectedAt: t3 });
    await report(ctx.base, device, { value: 21, collectedAt: t1 }); // 迟到数据
    await report(ctx.base, device, { value: 20, collectedAt: t2 }); // 乱序数据

    const ov = await overview(ctx.base, admin, loft.id);
    const d = ov.devices[0];
    assert.equal(d.readingCount, 3);
    assert.equal(d.lastValue, 22); // 采集时间最新的是 t3
    assert.equal(d.lastCollectedAt, t3);
    assert.deepEqual(d.recentReadings.map(r => r.collectedAt).sort((a, b) => a - b), [t1, t2, t3]);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 告警状态机 ----------
test("连续两次越界才产生告警，单次越界不告警", async () => {
  const ctx = await makeApp();
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { loft, device } = await setupLoft(ctx.base, admin);
    const t = Date.parse("2026-09-15T10:00:00Z");

    const r1 = await report(ctx.base, device, { value: 35, collectedAt: t });
    assert.equal(r1.data.streak, 1);
    assert.equal(r1.data.alarmEvents.length, 0);

    const r2 = await report(ctx.base, device, { value: 36, collectedAt: t + 1000 });
    assert.equal(r2.data.streak, 2);
    assert.equal(r2.data.alarmEvents[0].type, "alarm_created");
    assert.equal(r2.data.alarmEvents[0].level, "warning");

    const ov = await overview(ctx.base, admin, loft.id);
    assert.equal(ov.alarms.length, 1);
    assert.equal(ov.alarms[0].status, "active");
    assert.equal(ov.alarms[0].level, "warning");
  } finally {
    await ctx.cleanup();
  }
});

test("告警升级、确认、解除不可跳级", async () => {
  const ctx = await makeApp();
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { loft, device } = await setupLoft(ctx.base, admin);
    const t = Date.parse("2026-09-15T10:00:00Z");

    for (let i = 0; i < 4; i += 1) await report(ctx.base, device, { value: 40, collectedAt: t + i * 1000 });
    let ov = await overview(ctx.base, admin, loft.id);
    const alarm = ov.alarms[0];
    assert.equal(alarm.level, "critical"); // warning -> critical 自动升级
    assert.equal(alarm.history.map(h => h.event).join(","), "created,escalated");

    // active 不能直接 resolve（跳级）
    let res = await api(ctx.base, `/api/alarms/${alarm.id}/resolve`, { token: admin, method: "POST", body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.data.error, "invalid_transition");

    // confirm 正常
    res = await api(ctx.base, `/api/alarms/${alarm.id}/confirm`, { token: admin, method: "POST", body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.data.alarm.status, "confirmed");

    // 重复 confirm 属于跳级/回退，拒绝
    res = await api(ctx.base, `/api/alarms/${alarm.id}/confirm`, { token: admin, method: "POST", body: {} });
    assert.equal(res.status, 409);

    // resolve 正常
    res = await api(ctx.base, `/api/alarms/${alarm.id}/resolve`, { token: admin, method: "POST", body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.data.alarm.status, "resolved");

    // 已解除再操作，拒绝
    res = await api(ctx.base, `/api/alarms/${alarm.id}/confirm`, { token: admin, method: "POST", body: {} });
    assert.equal(res.status, 409);
    res = await api(ctx.base, `/api/alarms/${alarm.id}/resolve`, { token: admin, method: "POST", body: {} });
    assert.equal(res.status, 409);

    ov = await overview(ctx.base, admin, loft.id);
    assert.deepEqual(ov.alarms[0].history.map(h => h.event), ["created", "escalated", "confirmed", "resolved"]);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 告警联动风机 ----------
test("告警产生时风机启动，全部解除后风机停止", async () => {
  const ctx = await makeApp();
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { loft, device, fan } = await setupLoft(ctx.base, admin);
    const t = Date.parse("2026-09-15T10:00:00Z");

    await report(ctx.base, device, { value: 35, collectedAt: t });
    const r2 = await report(ctx.base, device, { value: 36, collectedAt: t + 1000 });
    assert.equal(r2.data.commands[0].action, "start");

    await waitFor(async () => (await overview(ctx.base, admin, loft.id)).fans[0].state === "on");
    let ov = await overview(ctx.base, admin, loft.id);
    assert.equal(ov.commands[0].status, "acked");
    assert.equal(ov.commands[0].attempts, 1);

    const alarmId = ov.alarms[0].id;
    await api(ctx.base, `/api/alarms/${alarmId}/confirm`, { token: admin, method: "POST", body: {} });
    const resolved = await api(ctx.base, `/api/alarms/${alarmId}/resolve`, { token: admin, method: "POST", body: {} });
    assert.equal(resolved.data.commands[0].action, "stop");

    await waitFor(async () => (await overview(ctx.base, admin, loft.id)).fans[0].state === "off");
    ov = await overview(ctx.base, admin, loft.id);
    assert.equal(ov.commands[0].action, "stop");
    assert.equal(ov.commands[0].status, "acked");
    assert.equal(ov.fans[0].id, fan.id);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 权限隔离 ----------
test("棚管员只能查看和操作本棚，越权返回 403", async () => {
  const ctx = await makeApp();
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const a = await setupLoft(ctx.base, admin);
    const b = await setupLoft(ctx.base, admin);
    await api(ctx.base, "/api/admin/users", { token: admin, method: "POST", body: { username: "keeperA", password: "pw", loftId: a.loft.id } });
    const keeperA = await login(ctx.base, "keeperA", "pw");

    // 棚管员只能看到自己的棚
    const lofts = await api(ctx.base, "/api/lofts", { token: keeperA });
    assert.equal(lofts.data.length, 1);
    assert.equal(lofts.data[0].id, a.loft.id);

    // 查看他棚概览 -> 403
    let res = await api(ctx.base, `/api/lofts/${b.loft.id}/overview`, { token: keeperA });
    assert.equal(res.status, 403);

    // 操作他棚告警 -> 403：先在 B 棚制造告警
    const t = Date.parse("2026-09-15T10:00:00Z");
    await report(ctx.base, b.device, { value: 99, collectedAt: t });
    await report(ctx.base, b.device, { value: 99, collectedAt: t + 1000 });
    const ovB = await overview(ctx.base, admin, b.loft.id);
    const alarmB = ovB.alarms[0];
    res = await api(ctx.base, `/api/alarms/${alarmB.id}/confirm`, { token: keeperA, method: "POST", body: {} });
    assert.equal(res.status, 403);
    res = await api(ctx.base, `/api/alarms/${alarmB.id}/resolve`, { token: keeperA, method: "POST", body: {} });
    assert.equal(res.status, 403);

    // 本棚可以正常操作：在 A 棚制造告警并由 keeperA 确认解除
    await report(ctx.base, a.device, { value: 99, collectedAt: t });
    await report(ctx.base, a.device, { value: 99, collectedAt: t + 1000 });
    const ovA = await overview(ctx.base, keeperA, a.loft.id);
    const alarmA = ovA.alarms[0];
    res = await api(ctx.base, `/api/alarms/${alarmA.id}/confirm`, { token: keeperA, method: "POST", body: {} });
    assert.equal(res.status, 200);
    res = await api(ctx.base, `/api/alarms/${alarmA.id}/resolve`, { token: keeperA, method: "POST", body: {} });
    assert.equal(res.status, 200);

    // 棚管员不能使用管理员接口
    res = await api(ctx.base, "/api/admin/lofts", { token: keeperA, method: "POST", body: { name: "越权棚" } });
    assert.equal(res.status, 403);

    // 未登录 -> 401
    res = await api(ctx.base, `/api/lofts/${a.loft.id}/overview`);
    assert.equal(res.status, 401);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 并发只成功一次 ----------
test("并发确认/解除只有一个成功，并发重复上报只入库一次", async () => {
  const ctx = await makeApp();
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { loft, device } = await setupLoft(ctx.base, admin);
    const t = Date.parse("2026-09-15T10:00:00Z");
    await report(ctx.base, device, { value: 99, collectedAt: t });
    await report(ctx.base, device, { value: 99, collectedAt: t + 1000 });
    const ov = await overview(ctx.base, admin, loft.id);
    const alarmId = ov.alarms[0].id;

    // 5 个并发 confirm：恰好一个 200，其余 409
    const confirms = await Promise.all(Array.from({ length: 5 }, () => api(ctx.base, `/api/alarms/${alarmId}/confirm`, { token: admin, method: "POST", body: {} })));
    assert.equal(confirms.filter(r => r.status === 200).length, 1);
    assert.equal(confirms.filter(r => r.status === 409).length, 4);

    // 5 个并发 resolve：恰好一个 200
    const resolves = await Promise.all(Array.from({ length: 5 }, () => api(ctx.base, `/api/alarms/${alarmId}/resolve`, { token: admin, method: "POST", body: {} })));
    assert.equal(resolves.filter(r => r.status === 200).length, 1);
    assert.equal(resolves.filter(r => r.status === 409).length, 4);

    // 并发重复上报同一 reportId：只入库一次
    const results = await Promise.all(Array.from({ length: 8 }, () => report(ctx.base, device, { value: 25, collectedAt: t + 2000, reportId: "dup-1" })));
    assert.equal(results.filter(r => r.data.stored).length, 1);
    assert.equal(results.filter(r => r.data.deduplicated).length, 7);
    const ov2 = await overview(ctx.base, admin, loft.id);
    assert.equal(ov2.devices[0].readingCount, 3);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 指令回滚重试 ----------
test("网关抖动时指令回滚并重试，最终成功", async () => {
  const ctx = await makeApp();
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { loft, device } = await setupLoft(ctx.base, admin);
    ctx.app.gateway.setMode("flaky", 2); // 前两次失败

    const t = Date.parse("2026-09-15T10:00:00Z");
    await report(ctx.base, device, { value: 99, collectedAt: t });
    await report(ctx.base, device, { value: 99, collectedAt: t + 1000 });

    await waitFor(async () => {
      const ov = await overview(ctx.base, admin, loft.id);
      return ov.commands[0] && ov.commands[0].status === "acked" ? ov.commands[0] : null;
    });
    const ov = await overview(ctx.base, admin, loft.id);
    const cmd = ov.commands[0];
    assert.equal(cmd.attempts, 3);
    assert.equal(ov.fans[0].state, "on");
    const events = cmd.history.map(h => h.event);
    assert.equal(events.filter(e => e === "rollback").length, 2);
    assert.equal(events.filter(e => e === "attempt_failed").length, 2);
    assert.ok(events.includes("retry_scheduled"));
    assert.ok(events.includes("acked"));
  } finally {
    await ctx.cleanup();
  }
});

test("网关持续失败时指令回滚到原状态并标记失败", async () => {
  const ctx = await makeApp();
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { loft, device } = await setupLoft(ctx.base, admin);
    ctx.app.gateway.setMode("fail");

    const t = Date.parse("2026-09-15T10:00:00Z");
    await report(ctx.base, device, { value: 99, collectedAt: t });
    await report(ctx.base, device, { value: 99, collectedAt: t + 1000 });

    await waitFor(async () => {
      const ov = await overview(ctx.base, admin, loft.id);
      return ov.commands[0] && ov.commands[0].status === "failed" ? ov.commands[0] : null;
    });
    const ov = await overview(ctx.base, admin, loft.id);
    const cmd = ov.commands[0];
    assert.equal(cmd.attempts, 3);
    assert.equal(ov.fans[0].state, "off"); // 回滚保持原状态
    assert.equal(cmd.history.filter(h => h.event === "rollback").length, 3);
    assert.ok(cmd.history.some(h => h.event === "failed_final"));
  } finally {
    await ctx.cleanup();
  }
});

test("网关超时时按超时回滚并重试", async () => {
  const ctx = await makeApp({ attemptTimeoutMs: 60 });
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { loft, device } = await setupLoft(ctx.base, admin);
    ctx.app.gateway.setMode("timeout");

    const t = Date.parse("2026-09-15T10:00:00Z");
    await report(ctx.base, device, { value: 99, collectedAt: t });
    await report(ctx.base, device, { value: 99, collectedAt: t + 1000 });

    await waitFor(async () => {
      const ov = await overview(ctx.base, admin, loft.id);
      return ov.commands[0] && ov.commands[0].status === "failed" ? ov.commands[0] : null;
    });
    const ov = await overview(ctx.base, admin, loft.id);
    const cmd = ov.commands[0];
    assert.equal(cmd.attempts, 3);
    assert.ok(cmd.history.filter(h => h.event === "attempt_failed").every(h => h.reason === "timeout"));
    assert.equal(ov.fans[0].state, "off");
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 旧指令不能覆盖新指令 ----------
test("旧指令被新指令取代，不得覆盖执行", async () => {
  const ctx = await makeApp({ autoWorker: false });
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { loft, device } = await setupLoft(ctx.base, admin);
    const t = Date.parse("2026-09-15T10:00:00Z");

    // 告警 -> 产生 start 指令（不自动执行）
    await report(ctx.base, device, { value: 99, collectedAt: t });
    await report(ctx.base, device, { value: 99, collectedAt: t + 1000 });
    let ov = await overview(ctx.base, admin, loft.id);
    const startCmd = ov.commands[0];
    assert.equal(startCmd.action, "start");
    assert.equal(startCmd.status, "pending");
    assert.equal(startCmd.epoch, 1);

    // 确认并解除 -> 产生 stop 指令，start 指令应被取代
    await api(ctx.base, `/api/alarms/${ov.alarms[0].id}/confirm`, { token: admin, method: "POST", body: {} });
    await api(ctx.base, `/api/alarms/${ov.alarms[0].id}/resolve`, { token: admin, method: "POST", body: {} });
    ov = await overview(ctx.base, admin, loft.id);
    const stopCmd = ov.commands.find(c => c.action === "stop");
    const staleCmd = ov.commands.find(c => c.id === startCmd.id);
    assert.equal(staleCmd.status, "superseded");
    assert.equal(stopCmd.epoch, 2);
    assert.equal(ov.fans[0].commandEpoch, 2);

    // 手动驱动 worker：只执行新指令
    await ctx.app.worker.drain();
    ov = await overview(ctx.base, admin, loft.id);
    assert.equal(ov.commands.find(c => c.id === stopCmd.id).status, "acked");
    assert.equal(ov.commands.find(c => c.id === startCmd.id).status, "superseded");
    assert.equal(ov.fans[0].state, "off");
    assert.ok(!ov.commands.find(c => c.id === startCmd.id).history.some(h => h.event === "acked"));
  } finally {
    await ctx.cleanup();
  }
});

test("在途指令被更新指令取代后，迟到的回执不得生效", async () => {
  const ctx = await makeApp({ attemptTimeoutMs: 500 });
  try {
    const admin = await login(ctx.base, "admin", "admin123");
    const { loft, device } = await setupLoft(ctx.base, admin);
    ctx.app.gateway.state.delayMs = 200; // 让指令在途

    const t = Date.parse("2026-09-15T10:00:00Z");
    await report(ctx.base, device, { value: 99, collectedAt: t });
    await report(ctx.base, device, { value: 99, collectedAt: t + 1000 });

    // 等 start 指令进入 sent（在途）
    await waitFor(async () => {
      const ov = await overview(ctx.base, admin, loft.id);
      return ov.commands[0] && ov.commands[0].status === "sent" ? ov.commands[0] : null;
    });

    // 在途期间确认并解除 -> stop 指令取代在途的 start
    let ov = await overview(ctx.base, admin, loft.id);
    await api(ctx.base, `/api/alarms/${ov.alarms[0].id}/confirm`, { token: admin, method: "POST", body: {} });
    await api(ctx.base, `/api/alarms/${ov.alarms[0].id}/resolve`, { token: admin, method: "POST", body: {} });

    await waitFor(async () => {
      const o = await overview(ctx.base, admin, loft.id);
      const stop = o.commands.find(c => c.action === "stop");
      return stop && stop.status === "acked" ? o : null;
    });
    ov = await overview(ctx.base, admin, loft.id);
    const startCmd = ov.commands.find(c => c.action === "start");
    assert.equal(startCmd.status, "superseded"); // 迟到回执未生效
    assert.ok(!startCmd.history.some(h => h.event === "acked"));
    assert.equal(ov.fans[0].state, "off");
  } finally {
    await ctx.cleanup();
  }
});

// ---------- 重启一致性 ----------
test("重启后设备、告警与指令状态一致，未完结指令恢复重试", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pigeon-mon-restart-"));
  try {
    // 第一次启动：制造告警并确认，风机已启动
    const ctx1 = await makeApp({ dataDir: dir });
    const admin1 = await login(ctx1.base, "admin", "admin123");
    const { loft, device } = await setupLoft(ctx1.base, admin1);
    const t = Date.parse("2026-09-15T10:00:00Z");
    await report(ctx1.base, device, { value: 99, collectedAt: t });
    await report(ctx1.base, device, { value: 99, collectedAt: t + 1000 });
    await waitFor(async () => (await overview(ctx1.base, admin1, loft.id)).fans[0].state === "on");
    let ov = await overview(ctx1.base, admin1, loft.id);
    await api(ctx1.base, `/api/alarms/${ov.alarms[0].id}/confirm`, { token: admin1, method: "POST", body: {} });
    const before = await overview(ctx1.base, admin1, loft.id);
    await ctx1.cleanup();

    // 第二次启动（同一数据目录）：状态必须一致
    const ctx2 = await makeApp({ dataDir: dir });
    const admin2 = await login(ctx2.base, "admin", "admin123");
    const after = await overview(ctx2.base, admin2, loft.id);
    assert.deepEqual(after.alarms, before.alarms);
    assert.deepEqual(after.commands, before.commands);
    assert.deepEqual(after.fans, before.fans);
    assert.deepEqual(after.devices, before.devices);
    assert.equal(after.fans[0].state, "on");
    assert.equal(after.alarms[0].status, "confirmed");
    assert.equal(after.devices[0].readingCount, 2);
    assert.equal(after.devices[0].streak, 2);

    // 再模拟“崩溃时指令在途”：手工把指令置为 sent 后重启，应恢复为 pending 并重新执行
    await ctx2.app.stores.monitor.mutate(db => {
      const cmd = db.commands[0];
      cmd.status = "sent";
      cmd.history.push({ event: "sent", attempt: cmd.attempts + 1, at: Date.now() });
    });
    await ctx2.cleanup();

    const ctx3 = await makeApp({ dataDir: dir });
    const admin3 = await login(ctx3.base, "admin", "admin123");
    ov = await overview(ctx3.base, admin3, loft.id);
    const recovered = ov.commands[0];
    assert.ok(recovered.history.some(h => h.event === "recovered_after_restart"));
    // 该指令最终状态一致（acked 或按重试推进），风机仍为开
    assert.equal(ov.fans[0].state, "on");
    await ctx3.cleanup();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- 原有鸽只接口回归 ----------
test("鸽只档案接口保持可用", async () => {
  const ctx = await makeApp();
  try {
    const list = await api(ctx.base, "/api/pigeons");
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.data));
    const created = await api(ctx.base, "/api/pigeons", { method: "POST", body: { ringNo: "CHN-2026-999", owner: "测试", color: "灰", loft: "测试棚" } });
    assert.equal(created.status, 201);
    const dup = await api(ctx.base, "/api/pigeons", { method: "POST", body: { ringNo: "CHN-2026-999", owner: "测试", color: "灰", loft: "测试棚" } });
    assert.equal(dup.status, 409);
    const relation = await api(ctx.base, "/api/pigeons/CHN-2026-999/relation");
    assert.equal(relation.status, 200);
    assert.equal(relation.data.pigeon.ringNo, "CHN-2026-999");
  } finally {
    await ctx.cleanup();
  }
});
