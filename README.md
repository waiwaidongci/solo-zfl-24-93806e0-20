# 赛鸽血统环号登记站 · 鸽舍环境监测与应急联动

在原有鸽只档案、血统、转让、归巢成绩功能之上，新增鸽舍环境监测与应急联动：

- **棚区与设备登记**：总站管理员登记棚区、温度/湿度/氨气监测设备及上下限阈值、风机，并为每个棚区创建棚管员账号。
- **读数上报**：设备凭 `X-Device-Key` 上报读数；迟到/乱序数据按采集时间归并，重复上报（同 `reportId` 或同采集时间）只算一次。
- **告警状态机**：连续 2 次越界产生 `warning` 告警，连续 4 次升级为 `critical`；级别只能 `warning→critical`，状态只能 `active→confirmed→resolved`，不可跳级；恢复需本棚管理员确认后解除。
- **应急联动**：棚内存在未解除告警时自动下发风机启动指令，全部解除后下发停止指令；指令超时/失败自动回滚到原状态并重试（默认 3 次）；指令带单调递增 epoch，旧指令不能覆盖新指令。
- **权限隔离**：棚管员只能查看和操作本棚（越权 403），总站管理员可管理全部。
- **并发与一致性**：所有状态变更串行落盘（原子写 + 变更队列），并发上报/确认/指令处理只有一次生效；重启后设备、告警、指令状态与停机前一致，在途指令自动恢复重试。

## 运行

```bash
npm start          # http://localhost:3024
```

默认账号：总站管理员 `admin / admin123`（棚管员由管理员在页面或 API 创建）。

## 测试

```bash
npm test           # node:test，覆盖去重/乱序/告警/状态机/越权/并发/回滚重试/重启一致性
```

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 登录，返回 Bearer token |
| POST | `/api/admin/lofts` | 登记棚区（管理员） |
| POST | `/api/admin/users` | 新增棚管员并绑定棚区（管理员） |
| POST | `/api/admin/devices` | 登记监测设备与阈值（管理员），返回设备 `key` |
| PUT | `/api/admin/devices/:id` | 修改设备阈值（管理员） |
| POST | `/api/admin/fans` | 登记风机（管理员） |
| POST | `/api/admin/gateway` | 设置风机网关模拟模式 `ok/flaky/fail/timeout`（管理员，故障演练用） |
| POST | `/api/devices/:id/readings` | 设备上报读数（`X-Device-Key` 或管理员），体：`{value, collectedAt?, reportId?}` |
| GET | `/api/lofts` / `/api/lofts/:id/overview` | 棚区列表 / 棚区监控总览（棚管员仅限本棚） |
| POST | `/api/alarms/:id/confirm` | 确认告警（active→confirmed） |
| POST | `/api/alarms/:id/resolve` | 解除告警（confirmed→resolved），联动风机停止 |
| GET | `/api/alarms` `/api/commands` | 告警 / 联动指令查询 |

## 故障演练示例

```bash
# 网关设为“先失败 2 次后恢复”，观察指令回滚重试最终成功
curl -X POST http://localhost:3024/api/admin/gateway \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"mode":"flaky","failures":2}'
```
