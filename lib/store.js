import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// JSON 文件存储：原子写入（tmp + rename）+ 串行变更队列。
// 变更先在副本上执行，落盘成功后才替换内存中的 db：
// 写盘失败时内存状态回到写前，并发读永远看不到未落盘的数据。
export function createStore(path, seed, hooks = {}) {
  let db = null;
  let queue = Promise.resolve();

  async function persist(data) {
    if (hooks.beforePersist) await hooks.beforePersist(data); // 测试注入点：模拟写盘失败
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
  }

  async function load() {
    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true });
      await persist(seed);
    }
    db = JSON.parse(await readFile(path, "utf8"));
    return db;
  }

  async function save() {
    await persist(db);
  }

  // fn(working) 在队列中独占执行；只有 persist 成功后 working 才成为当前状态。
  // fn 或 persist 抛错时，内存 db 保持写前状态，队列继续处理后续变更。
  function mutate(fn) {
    const run = queue.then(async () => {
      const working = structuredClone(db);
      const result = await fn(working);
      await persist(working);
      db = working;
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    load,
    save,
    mutate,
    get: () => db
  };
}
