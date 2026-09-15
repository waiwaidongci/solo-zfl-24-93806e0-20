import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// JSON 文件存储：原子写入（tmp + rename）+ 串行变更队列。
// 所有写操作经 mutate() 排队执行，保证并发请求下状态变更逐个生效、
// 每次变更落盘后才返回，重启后从磁盘恢复的状态与已响应的请求一致。
export function createStore(path, seed) {
  let db = null;
  let queue = Promise.resolve();

  async function atomicWrite(data) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
  }

  async function load() {
    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(seed);
    }
    db = JSON.parse(await readFile(path, "utf8"));
    return db;
  }

  async function save() {
    await atomicWrite(db);
  }

  // fn(db) 在队列中独占执行；fn 的返回值作为 mutate 的结果。
  // fn 抛错时状态不落盘，队列继续。
  function mutate(fn) {
    const run = queue.then(async () => {
      const result = await fn(db);
      await save();
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
