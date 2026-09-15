// 鸽舍环境监测领域逻辑：读数归并、告警状态机、风机指令与重试。
//
// 关键规则：
// - 读数按采集时间（collectedAt）归并排序，迟到/乱序数据插入正确位置后重算连续越界数；
// - 重复上报（同 reportId 或同设备同采集时间）只算一次；
// - 连续 2 次越界产生 warning 告警，连续 4 次升级为 critical；
// - 告警级别只能 warning -> critical，状态只能 active -> confirmed -> resolved，均不可跳级；
// - 告警存在时风机应为开，全部解除后风机应为关；指令带单调递增 epoch，旧指令不得覆盖新指令；
// - 指令超时/失败回滚到原状态并重试，超过次数标记失败。

export const METRICS = ["temperature", "humidity", "ammonia"];
export const METRIC_LABELS = { temperature: "温度", humidity: "湿度", ammonia: "氨气" };
export const WARNING_STREAK = 2;
export const CRITICAL_STREAK = 4;
export const MAX_READINGS = 500;
export const MAX_REPORT_IDS = 1000;

const ID_PREFIX = { user: "U", loft: "L", device: "D", fan: "F", alarm: "A", command: "C" };

export class DomainError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function nextId(db, kind) {
  db.counters[kind] = (db.counters[kind] || 0) + 1;
  return `${ID_PREFIX[kind] || "X"}${String(db.counters[kind]).padStart(4, "0")}`;
}

export function isOutOfBounds(device, value) {
  return value < device.thresholds.min || value > device.thresholds.max;
}

// 按采集时间顺序从尾部重算连续越界次数
export function recomputeStreak(device) {
  let streak = 0;
  for (let i = device.readings.length - 1; i >= 0; i -= 1) {
    if (isOutOfBounds(device, device.readings[i].value)) streak += 1;
    else break;
  }
  device.streak = streak;
  return streak;
}

// 设备上报读数：去重 + 按采集时间归并 + 重算越界 streak。
// 返回 { stored, deduplicated, streak, collectedAt }。
export function ingestReading(device, input, now = Date.now()) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) throw new DomainError(400, "invalid_value");

  let collectedAt = now;
  if (input.collectedAt !== undefined && input.collectedAt !== null && input.collectedAt !== "") {
    collectedAt = typeof input.collectedAt === "number" ? input.collectedAt : Date.parse(input.collectedAt);
    if (!Number.isFinite(collectedAt)) throw new DomainError(400, "invalid_collected_at");
  }
  const reportId = input.reportId !== undefined && input.reportId !== null && input.reportId !== "" ? String(input.reportId) : null;

  if (reportId && device.reportIds.includes(reportId)) {
    return { stored: false, deduplicated: true, reason: "duplicate_report_id", streak: device.streak, collectedAt };
  }
  if (device.readings.some(r => r.collectedAt === collectedAt)) {
    return { stored: false, deduplicated: true, reason: "duplicate_collected_at", streak: device.streak, collectedAt };
  }

  device.readings.push({ value, collectedAt, receivedAt: now, reportId });
  device.readings.sort((a, b) => a.collectedAt - b.collectedAt);
  if (device.readings.length > MAX_READINGS) device.readings.splice(0, device.readings.length - MAX_READINGS);
  if (reportId) {
    device.reportIds.push(reportId);
    if (device.reportIds.length > MAX_REPORT_IDS) device.reportIds.splice(0, device.reportIds.length - MAX_REPORT_IDS);
  }

  const streak = recomputeStreak(device);
  const latest = device.readings[device.readings.length - 1];
  device.lastValue = latest.value;
  device.lastCollectedAt = latest.collectedAt;
  device.lastReceivedAt = now;
  return { stored: true, deduplicated: false, streak, collectedAt };
}

export function openAlarmFor(db, deviceId) {
  return db.alarms.find(a => a.deviceId === deviceId && a.status !== "resolved") || null;
}

// 根据最新 streak 驱动告警：连续 2 次越界建 warning，连续 4 次升 critical。
// 已解除的告警不影响新告警产生；读数恢复正常不自动解除（需人工确认后解除）。
export function evaluateDeviceAlarms(db, device, now = Date.now()) {
  const events = [];
  let alarm = openAlarmFor(db, device.id);
  if (!alarm && device.streak >= WARNING_STREAK) {
    alarm = {
      id: nextId(db, "alarm"),
      loftId: device.loftId,
      deviceId: device.id,
      metric: device.type,
      level: "warning",
      status: "active",
      version: 1,
      streak: device.streak,
      createdAt: now,
      updatedAt: now,
      history: [{ event: "created", level: "warning", streak: device.streak, at: now }]
    };
    db.alarms.unshift(alarm);
    events.push({ type: "alarm_created", alarm });
  } else if (alarm) {
    alarm.streak = device.streak;
    alarm.updatedAt = now;
    if (device.streak >= CRITICAL_STREAK && alarm.level === "warning") {
      alarm.level = "critical";
      alarm.version += 1;
      alarm.history.push({ event: "escalated", from: "warning", to: "critical", streak: device.streak, at: now });
      events.push({ type: "alarm_escalated", alarm });
    }
  }
  return events;
}

// 状态机：active -> confirmed -> resolved，其余跳转一律 409。
export function confirmAlarm(alarm, username, now = Date.now()) {
  if (alarm.status !== "active") throw new DomainError(409, "invalid_transition");
  alarm.status = "confirmed";
  alarm.version += 1;
  alarm.updatedAt = now;
  alarm.history.push({ event: "confirmed", by: username, at: now });
  return alarm;
}

export function resolveAlarm(alarm, username, now = Date.now()) {
  if (alarm.status !== "confirmed") throw new DomainError(409, "invalid_transition");
  alarm.status = "resolved";
  alarm.version += 1;
  alarm.updatedAt = now;
  alarm.history.push({ event: "resolved", by: username, at: now });
  return alarm;
}

// 下发风机指令：同风机未完结的旧指令全部作废（superseded），epoch 单调递增。
export function issueCommand(db, fan, action, reason, now = Date.now()) {
  for (const cmd of db.commands) {
    if (cmd.fanId === fan.id && (cmd.status === "pending" || cmd.status === "sent")) {
      cmd.status = "superseded";
      cmd.updatedAt = now;
      cmd.history.push({ event: "superseded", at: now });
    }
  }
  fan.commandEpoch += 1;
  const command = {
    id: nextId(db, "command"),
    fanId: fan.id,
    loftId: fan.loftId,
    action,
    targetState: action === "start" ? "on" : "off",
    previousState: fan.state,
    epoch: fan.commandEpoch,
    attempts: 0,
    maxAttempts: 3,
    status: "pending",
    reason,
    createdAt: now,
    updatedAt: now,
    history: [{ event: "created", action, epoch: fan.commandEpoch, reason, at: now }]
  };
  db.commands.unshift(command);
  return command;
}

// 告警联动：棚内有未解除告警 -> 风机开；全部解除 -> 风机关。
// 以“在途指令目标态”为有效状态，避免重复下发。
export function syncFansWithAlarms(db, loftId, now = Date.now()) {
  const issued = [];
  const hasOpenAlarm = db.alarms.some(a => a.loftId === loftId && a.status !== "resolved");
  for (const fan of db.fans.filter(f => f.loftId === loftId)) {
    const inflight = db.commands.find(c => c.fanId === fan.id && (c.status === "pending" || c.status === "sent"));
    const effectiveState = inflight ? inflight.targetState : fan.state;
    if (hasOpenAlarm && effectiveState !== "on") issued.push(issueCommand(db, fan, "start", "alarm_active", now));
    if (!hasOpenAlarm && effectiveState !== "off") issued.push(issueCommand(db, fan, "stop", "alarms_resolved", now));
  }
  return issued;
}

// 指令执行器：取 pending 指令逐条下发，成功置 acked 并应用目标状态；
// 超时/失败回滚到 previousState 后重试，超过 maxAttempts 标记 failed；
// 应用结果前再校验 epoch，过期指令（含在途被取代的）不得生效。
export function createCommandWorker({ store, gateway, attemptTimeoutMs = 1500, auto = true }) {
  let draining = false;
  let scheduled = false;
  let stopped = false;

  async function recoverAfterBoot() {
    await store.mutate(db => {
      const now = Date.now();
      for (const cmd of db.commands || []) {
        if (cmd.status === "sent") {
          cmd.status = "pending";
          cmd.updatedAt = now;
          cmd.history.push({ event: "recovered_after_restart", at: now });
        }
      }
    });
  }

  function schedule() {
    if (!auto || stopped || scheduled) return;
    scheduled = true;
    const timer = setTimeout(() => {
      scheduled = false;
      if (!stopped) drain().catch(() => {});
    }, 5);
    if (timer.unref) timer.unref();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        if (stopped) return;
        const db = store.get();
        const next = db && db.commands ? db.commands.find(c => c.status === "pending") : null;
        if (!next) return;
        await processOne(next.id);
      }
    } finally {
      draining = false;
    }
  }

  async function processOne(id) {
    const sent = await store.mutate(db => {
      const cmd = db.commands.find(c => c.id === id);
      if (!cmd || cmd.status !== "pending") return null;
      const fan = db.fans.find(f => f.id === cmd.fanId);
      const now = Date.now();
      if (!fan) {
        cmd.status = "failed";
        cmd.updatedAt = now;
        cmd.history.push({ event: "failed_final", reason: "fan_missing", at: now });
        return null;
      }
      if (cmd.epoch !== fan.commandEpoch) {
        cmd.status = "superseded";
        cmd.updatedAt = now;
        cmd.history.push({ event: "superseded", at: now });
        return null;
      }
      cmd.status = "sent";
      cmd.attempts += 1;
      cmd.sentAt = now;
      cmd.updatedAt = now;
      cmd.history.push({ event: "sent", attempt: cmd.attempts, at: now });
      return {
        fan: { id: fan.id, name: fan.name, loftId: fan.loftId },
        command: { id: cmd.id, action: cmd.action, epoch: cmd.epoch }
      };
    });
    if (!sent) return;

    let outcome;
    let timer;
    try {
      await Promise.race([
        gateway.send(sent.fan, sent.command),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), attemptTimeoutMs);
          if (timer.unref) timer.unref();
        })
      ]);
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, reason: error.message === "timeout" ? "timeout" : "failure" };
    } finally {
      clearTimeout(timer);
    }

    await store.mutate(db => {
      const cmd = db.commands.find(c => c.id === id);
      if (!cmd || cmd.status !== "sent") return; // 在途期间已被取代
      const fan = db.fans.find(f => f.id === cmd.fanId);
      const now = Date.now();
      if (fan && cmd.epoch !== fan.commandEpoch) {
        cmd.status = "superseded";
        cmd.updatedAt = now;
        cmd.history.push({ event: "superseded", at: now });
        return;
      }
      if (outcome.ok) {
        if (fan) fan.state = cmd.targetState;
        cmd.status = "acked";
        cmd.ackedAt = now;
        cmd.updatedAt = now;
        cmd.history.push({ event: "acked", attempt: cmd.attempts, at: now });
        return;
      }
      cmd.history.push({ event: "attempt_failed", attempt: cmd.attempts, reason: outcome.reason, at: now });
      if (fan) fan.state = cmd.previousState; // 回滚到指令前状态
      cmd.history.push({ event: "rollback", restoredState: cmd.previousState, at: now });
      if (cmd.attempts < cmd.maxAttempts) {
        cmd.status = "pending";
        cmd.history.push({ event: "retry_scheduled", attempt: cmd.attempts + 1, at: now });
      } else {
        cmd.status = "failed";
        cmd.history.push({ event: "failed_final", at: now });
      }
      cmd.updatedAt = now;
    });
  }

  function stop() {
    stopped = true;
  }

  return { drain, schedule, recoverAfterBoot, stop, isDraining: () => draining };
}
