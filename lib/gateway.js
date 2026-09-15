// 风机网关模拟：代表真实的棚舍风机控制器。
// 通过 mode 模拟现场各种情况，用于验证“超时或失败要回滚并重试”：
//   ok      正常执行
//   fail    每次都拒绝（网关故障）
//   timeout 永不响应（指令超时）
//   flaky   先失败 failures 次，之后恢复（验证重试最终成功）
export function createGateway(options = {}) {
  const state = {
    mode: options.mode || "ok",
    delayMs: options.delayMs ?? 20,
    failuresLeft: 0,
    log: []
  };

  return {
    state,
    setMode(mode, failures = 0) {
      state.mode = mode;
      state.failuresLeft = failures;
    },
    async send(fan, command) {
      state.log.push({ fanId: fan.id, commandId: command.id, action: command.action, epoch: command.epoch, at: Date.now() });
      if (state.mode === "timeout") return new Promise(() => {}); // 永不返回，由调用方超时控制
      await new Promise(resolve => setTimeout(resolve, state.delayMs));
      if (state.mode === "fail") throw new Error("gateway_rejected");
      if (state.mode === "flaky" && state.failuresLeft > 0) {
        state.failuresLeft -= 1;
        throw new Error("gateway_flaky_failure");
      }
      return { ok: true };
    }
  };
}
