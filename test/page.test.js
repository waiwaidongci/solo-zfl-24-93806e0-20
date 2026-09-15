import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadPageScript() {
  const html = await readFile(join(__dirname, "..", "lib", "page.js"), "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "页面中应包含内联脚本");
  return { html, script: match[1] };
}

// 带真实 hidden/innerHTML 状态的元素桩，querySelectorAll 记录调用选择器
function makeDom({ onQueryAll } = {}) {
  const elements = new Map();
  const makeEl = () => ({
    hidden: false,
    classList: { toggle() {}, add() {}, remove() {} },
    style: {},
    dataset: {},
    value: "",
    textContent: "",
    innerHTML: "",
    onclick: null,
    onsubmit: null,
    onchange: null
  });
  const get = sel => {
    if (!elements.has(sel)) elements.set(sel, makeEl());
    return elements.get(sel);
  };
  return {
    elements: new Proxy(elements, { get: (map, sel) => map.get(sel) }),
    document: {
      querySelector: get,
      querySelectorAll: sel => {
        if (onQueryAll) onQueryAll(sel);
        return [];
      },
      addEventListener() {}
    }
  };
}

function makeSandbox(dom, { token = null, fetchImpl } = {}) {
  const sandbox = {
    console,
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => token, setItem() {}, removeItem() {} },
    CSS: { escape: s => s },
    FormData: class { entries() { return [][Symbol.iterator](); } },
    document: dom.document,
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => [] }))
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

test("首页内联脚本在模拟 DOM 下加载无错误", async () => {
  const { script } = await loadPageScript();
  const dom = makeDom();
  const sandbox = makeSandbox(dom);
  vm.runInContext(script, sandbox, { filename: "page-inline.js" });
  await new Promise(resolve => setTimeout(resolve, 100));
});

test("两个标签页互斥：切换到环境监测时鸽只档案隐藏", async () => {
  const { html, script } = await loadPageScript();
  assert.match(html, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/, "CSS 应保证 hidden 属性生效");

  const dom = makeDom();
  const sandbox = makeSandbox(dom);
  vm.runInContext(script, sandbox, { filename: "page-inline.js" });
  await new Promise(resolve => setTimeout(resolve, 50));

  dom.elements["#tabBtnMonitor"].onclick();
  assert.equal(dom.elements["#pigeonMain"].hidden, true, "切到监测页时鸽只档案应隐藏");
  assert.equal(dom.elements["#monitorMain"].hidden, false);

  dom.elements["#tabBtnPigeons"].onclick();
  assert.equal(dom.elements["#pigeonMain"].hidden, false);
  assert.equal(dom.elements["#monitorMain"].hidden, true, "切回档案页时监测页应隐藏");
});

test("创建棚区后设备监测项下拉框不被棚区列表覆盖", async () => {
  const { html, script } = await loadPageScript();
  // 三种监测项在页面中存在
  for (const metric of ["temperature", "humidity", "ammonia"]) {
    assert.ok(html.includes(`<option value="${metric}">`), `缺少监测项 ${metric}`);
  }

  const selectors = [];
  const dom = makeDom({ onQueryAll: sel => selectors.push(sel) });
  const fetchImpl = async path => {
    const json = async () => {
      if (path === "/api/me") return { user: { id: "U1", username: "admin", role: "admin", loftId: null } };
      if (path === "/api/lofts") return [{ id: "L1", name: "甲棚" }];
      if (path === "/api/admin/gateway") return { mode: "ok", failuresLeft: 0 };
      if (path.startsWith("/api/lofts/")) return { loft: { id: "L1", name: "甲棚" }, devices: [], fans: [], alarms: [], commands: [] };
      return [];
    };
    return { ok: true, status: 200, json };
  };
  const sandbox = makeSandbox(dom, { token: "tok", fetchImpl });
  vm.runInContext(script, sandbox, { filename: "page-inline.js" });
  await new Promise(resolve => setTimeout(resolve, 100));

  // 管理员加载棚区列表时会填充下拉框，选择器必须只针对 name="loftId" 的棚区下拉
  const fillSelectors = selectors.filter(s => s.includes("select"));
  assert.ok(fillSelectors.length > 0, "应当有填充下拉框的操作");
  for (const sel of fillSelectors) {
    assert.ok(sel.includes("[name='loftId']") || sel.includes('[name="loftId"]'), `下拉填充选择器不应波及监测项: ${sel}`);
  }
});
