import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/app.js";

async function makeApp(options = {}) {
  const dir = options.dataDir || (await mkdtemp(join(tmpdir(), "pigeon-persist-")));
  const app = createApp({ dataDir: dir, ...options });
  const port = await app.start(0);
  return {
    app,
    dir,
    base: `http://127.0.0.1:${port}`,
    async cleanup() {
      await app.stop();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function api(base, path, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function login(base) {
  const res = await api(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin123" } });
  return res.data.token;
}

test("写盘失败返回500后变更回滚，并发请求也看不到未落盘数据", async () => {
  let failWrites = false;
  const ctx = await makeApp({
    monitorStoreHooks: {
      beforePersist: async () => {
        if (failWrites) {
          await new Promise(r => setTimeout(r, 60)); // 让失败写保持在途，便于观察并发读
          throw new Error("disk_full");
        }
      }
    }
  });
  try {
    const admin = await login(ctx.base);

    // 先正常落盘一条
    const ok1 = await api(ctx.base, "/api/admin/lofts", { token: admin, method: "POST", body: { name: "甲棚" } });
    assert.equal(ok1.status, 201);

    failWrites = true;
    // 失败写进行中，并发查询不应看到未落盘记录
    const pending = api(ctx.base, "/api/admin/lofts", { token: admin, method: "POST", body: { name: "幻影棚" } });
    const during = await api(ctx.base, "/api/lofts", { token: admin });
    assert.deepEqual(during.data.map(l => l.name), ["甲棚"]);

    const failed = await pending;
    assert.equal(failed.status, 500);
    assert.equal(failed.data.error, "disk_full");

    // 写失败后：内存与查询均不出现该记录
    const after = await api(ctx.base, "/api/lofts", { token: admin });
    assert.deepEqual(after.data.map(l => l.name), ["甲棚"]);

    // 设备上报路径同样回滚：先登记设备，再在写盘失败时上报读数
    failWrites = false;
    const device = (await api(ctx.base, "/api/admin/devices", { token: admin, method: "POST", body: { loftId: ok1.data.id, type: "temperature", name: "温度1", min: 5, max: 30 } })).data;
    failWrites = true;
    const badReport = await api(ctx.base, `/api/devices/${device.id}/readings`, { method: "POST", body: { value: 99, collectedAt: "2026-09-15T10:00:00Z" }, token: admin });
    assert.equal(badReport.status, 500);
    failWrites = false;
    const ov = await api(ctx.base, `/api/lofts/${ok1.data.id}/overview`, { token: admin });
    assert.equal(ov.data.devices[0].readingCount, 0); // 未落盘的读数不可见
    assert.equal(ov.data.devices[0].streak, 0);

    // 失败变更不影响后续成功变更
    const ok2 = await api(ctx.base, "/api/admin/lofts", { token: admin, method: "POST", body: { name: "乙棚" } });
    assert.equal(ok2.status, 201);
    const final = await api(ctx.base, "/api/lofts", { token: admin });
    assert.deepEqual(final.data.map(l => l.name).sort(), ["乙棚", "甲棚"].sort());

    // 重启后磁盘上也只有成功落盘的记录
    await ctx.app.stop();
    const ctx2 = await makeApp({ dataDir: ctx.dir });
    try {
      const admin2 = await login(ctx2.base);
      const lofts = await api(ctx2.base, "/api/lofts", { token: admin2 });
      assert.deepEqual(lofts.data.map(l => l.name).sort(), ["乙棚", "甲棚"].sort());
    } finally {
      await ctx2.app.stop();
    }
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});
