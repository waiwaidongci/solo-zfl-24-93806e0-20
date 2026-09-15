import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 浏览器侧冒烟：在 node:vm 中以代理 DOM 执行首页内联脚本，
// 验证脚本在加载路径（渲染、事件绑定、登录检查、轮询注册）上无语法/引用错误。
test("首页内联脚本在模拟 DOM 下加载无错误", async () => {
  const html = await readFile(join(__dirname, "..", "lib", "page.js"), "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "页面中应包含内联脚本");

  function makeElement() {
    const el = new Proxy(function () {}, {
      get(target, prop) {
        if (prop === "classList") return { toggle() {}, add() {}, remove() {} };
        if (prop === "dataset") return {};
        if (prop === "style") return {};
        if (prop === "value") return "";
        if (prop === "hidden") return false;
        if (prop === Symbol.toPrimitive) return () => "";
        return el;
      },
      set() { return true; },
      apply() { return el; }
    });
    return el;
  }

  const sandbox = {
    console,
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CSS: { escape: s => s },
    FormData: class { entries() { return [][Symbol.iterator](); } },
    document: {
      querySelector: () => makeElement(),
      querySelectorAll: () => [],
      addEventListener() {}
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => [] })
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox, { filename: "page-inline.js" });
  await new Promise(resolve => setTimeout(resolve, 100));
});
