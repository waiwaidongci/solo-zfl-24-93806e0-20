export const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站 · 鸽舍环境监测</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2f7d4f; --orange:#b26a21; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    [hidden] { display:none !important; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
    h1 { margin:0; font-size:26px; } main { padding:22px 28px; }
    nav { display:flex; gap:8px; padding:12px 28px 0; background:#fff; border-bottom:1px solid var(--line); }
    nav button { border:1px solid var(--line); background:#f6f8fa; color:var(--ink); border-radius:8px 8px 0 0; padding:9px 18px; font-weight:700; cursor:pointer; }
    nav button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.ghost { background:#eef2f5; color:var(--ink); border:1px solid var(--line); }
    button.danger { background:var(--red); } button:disabled { opacity:.45; cursor:not-allowed; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; align-content:start; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.warn { background:#fdf3e3; border-color:#e8c98f; color:var(--orange); } .pill.crit { background:#fbe7e4; border-color:#e2a49d; color:var(--red); }
    .pill.ok { background:#e6f4ec; border-color:#9fd3b4; color:var(--green); } .pill.info { background:#e8f0f7; border-color:#a9c4da; color:var(--accent); }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:14px; }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { border-bottom:1px solid var(--line); padding:7px 8px; text-align:left; vertical-align:top; }
    th { color:var(--muted); font-weight:600; } .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; } .row > * { flex:1; } .row > button { flex:0 0 auto; }
    .err { color:var(--red); font-size:13px; min-height:16px; } .mono { font-family:ui-monospace,Menlo,monospace; font-size:12px; }
    #pigeonMain { display:grid; grid-template-columns:380px 1fr; gap:22px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{padding:16px;} #pigeonMain{grid-template-columns:1fr;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>赛鸽血统环号登记站</h1><div class="meta">档案血统 · 鸽舍环境监测与应急联动</div></div>
    <div class="row" style="align-items:center">
      <span id="whoami" class="meta"></span>
      <button class="ghost" id="reload">刷新</button>
    </div>
  </header>
  <nav>
    <button id="tabBtnPigeons" class="active">鸽只档案</button>
    <button id="tabBtnMonitor">环境监测</button>
  </nav>

  <main id="pigeonMain">
    <form id="form">
      <h2>创建鸽只档案</h2>
      <label>足环号</label><input name="ringNo" required>
      <label>鸽主</label><input name="owner" required>
      <label>父鸽足环号</label><input name="fatherRing">
      <label>母鸽足环号</label><input name="motherRing">
      <label>羽色</label><input name="color" required>
      <label>出生棚号</label><input name="loft" required>
      <button>保存档案</button>
    </form>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>

  <main id="monitorMain" hidden>
    <div id="loginBox" class="panel" style="max-width:420px">
      <h2>监测控制台登录</h2>
      <p class="meta">总站管理员可登记棚区、设备阈值与棚管员；棚管员只能查看和操作本棚。</p>
      <label>账号</label><input id="loginUser" value="admin">
      <label>密码</label><input id="loginPass" type="password" value="admin123">
      <div style="margin-top:12px"><button id="loginBtn">登录</button></div>
      <div class="err" id="loginErr"></div>
    </div>

    <div id="console" hidden>
      <div class="panel row" style="align-items:center">
        <div>当前用户：<b id="meName"></b> <span class="pill info" id="meRole"></span> <span class="meta" id="meLoft"></span></div>
        <button class="ghost" id="logoutBtn" style="flex:0 0 auto">退出登录</button>
      </div>

      <div id="adminPanel" class="section" hidden>
        <div class="cols">
          <form id="loftForm" class="panel"><h2>登记棚区</h2><label>棚区名称</label><input name="name" required placeholder="如：北岸A棚"><button>创建棚区</button></form>
          <form id="keeperForm" class="panel"><h2>新增棚管员</h2><label>账号</label><input name="username" required><label>密码</label><input name="password" required><label>所属棚区</label><select name="loftId" required></select><button>创建棚管员</button></form>
          <form id="deviceForm" class="panel"><h2>登记监测设备与阈值</h2>
            <label>所属棚区</label><select name="loftId" required></select>
            <label>监测项</label><select name="type"><option value="temperature">温度(℃)</option><option value="humidity">湿度(%RH)</option><option value="ammonia">氨气(ppm)</option></select>
            <label>设备名称</label><input name="name" required>
            <div class="row"><div><label>下限</label><input name="min" type="number" step="any" required></div><div><label>上限</label><input name="max" type="number" step="any" required></div></div>
            <button>登记设备</button>
          </form>
          <form id="fanForm" class="panel"><h2>登记风机</h2><label>所属棚区</label><select name="loftId" required></select><label>风机名称</label><input name="name" required><button>登记风机</button></form>
          <form id="gatewayForm" class="panel"><h2>风机网关模拟（故障演练）</h2>
            <label>网关模式</label><select name="mode"><option value="ok">正常</option><option value="flaky">先失败后恢复</option><option value="fail">持续失败</option><option value="timeout">超时无响应</option></select>
            <label>先失败次数（flaky）</label><input name="failures" type="number" value="2" min="0">
            <button>应用模式</button><div class="meta" id="gatewayState"></div>
          </form>
        </div>
      </div>

      <div class="section panel">
        <div class="row" style="align-items:center">
          <h2 style="margin:0">棚区监控</h2>
          <select id="loftSelect" style="max-width:260px"></select>
        </div>
        <div class="section cols">
          <div class="panel"><h2>设备读数</h2><div id="devices"></div></div>
          <div class="panel"><h2>告警</h2><div id="alarms"></div></div>
        </div>
        <div class="section cols">
          <div class="panel"><h2>风机状态</h2><div id="fans"></div></div>
          <div class="panel"><h2>联动指令</h2><div id="commands"></div></div>
        </div>
      </div>
      <div class="err" id="monErr"></div>
    </div>
  </main>

  <script>
    // ---------------- 公共 ----------------
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
    const fmtTime = ts => ts ? new Date(ts).toLocaleString("zh-CN", { hour12:false }) : "-";

    // ---------------- 鸽只档案 ----------------
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    let pigeons = [];
    function renderCards() {
      cards.innerHTML = pigeons.map(p => '<article class="card"><h3>'+esc(p.ringNo)+'</h3><span class="pill">'+esc(p.owner)+'</span><div class="meta">'+esc(p.color)+' · '+esc(p.loft)+'</div><div>父：'+esc(p.fatherRing || "未登记")+'</div><div>母：'+esc(p.motherRing || "未登记")+'</div><label>录入转让</label><input data-to="'+esc(p.ringNo)+'" placeholder="新归属人"><button data-transfer="'+esc(p.ringNo)+'">保存转让</button><label>归巢成绩</label><input data-race="'+esc(p.ringNo)+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+esc(p.ringNo)+'">保存成绩</button></article>').join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+CSS.escape(ringNo)+'"]').value;
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await loadPigeons();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+CSS.escape(ringNo)+'"]').value.split("/");
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); await loadPigeons();
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>'+esc(p.ringNo)+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+esc(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+esc(p.owner)+' · '+esc(p.color)+'</div><div class="small"><b>母鸽</b><br>'+esc(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+esc(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="meta">转让：'+esc(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div><div class="meta">归巢：'+esc(p.races.map(r => r.event+" 第"+r.rank+"名").join(" / ") || "暂无")+'</div>';
    }
    async function loadPigeons(){ pigeons = await api("/api/pigeons"); renderCards(); renderRelation(null); }
    document.querySelector("#searchBtn").onclick = async () => renderRelation(await api('/api/pigeons/'+encodeURIComponent(search.value)+'/relation'));
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await loadPigeons();
    };

    // ---------------- 环境监测 ----------------
    const mon = { token: localStorage.getItem("monToken") || "", me: null, lofts: [], loftId: localStorage.getItem("monLoft") || "", overview: null };
    const METRIC_LABEL = { temperature: "温度", humidity: "湿度", ammonia: "氨气" };
    const METRIC_UNIT = { temperature: "℃", humidity: "%RH", ammonia: "ppm" };
    const LEVEL_LABEL = { warning: "提示告警", critical: "严重告警" };
    const STATUS_LABEL = { active: "待确认", confirmed: "已确认待解除", resolved: "已解除" };
    const CMD_STATUS = { pending: "待下发", sent: "已下发待回执", acked: "已执行", failed: "失败(已回滚)", superseded: "已被新指令取代" };

    async function mapi(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (mon.token) headers.Authorization = "Bearer " + mon.token;
      if (options.body) headers["Content-Type"] = "application/json";
      const res = await fetch(path, { ...options, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const err = new Error(data.error || "请求失败"); err.status = res.status; throw err; }
      return data;
    }
    function monError(e){ document.querySelector("#monErr").textContent = e.message || String(e); setTimeout(() => { document.querySelector("#monErr").textContent = ""; }, 5000); }

    async function refreshMe() {
      if (!mon.token) { mon.me = null; return renderMonitor(); }
      try { const data = await mapi("/api/me"); mon.me = data.user; if (!mon.me) throw new Error("会话已过期"); }
      catch { mon.token = ""; localStorage.removeItem("monToken"); mon.me = null; }
      renderMonitor();
      if (mon.me) await loadMonitor();
    }
    function renderMonitor() {
      document.querySelector("#loginBox").hidden = !!mon.me;
      document.querySelector("#console").hidden = !mon.me;
      document.querySelector("#whoami").textContent = mon.me ? ("监测台：" + mon.me.username) : "";
      if (!mon.me) return;
      document.querySelector("#meName").textContent = mon.me.username;
      document.querySelector("#meRole").textContent = mon.me.role === "admin" ? "总站管理员" : "棚管员";
      document.querySelector("#meLoft").textContent = mon.me.role === "admin" ? "可管理全部棚区" : ("本棚：" + (mon.lofts.find(l => l.id === mon.me.loftId)?.name || mon.me.loftId || "未分配"));
      document.querySelector("#adminPanel").hidden = mon.me.role !== "admin";
    }
    async function loadMonitor() {
      mon.lofts = await mapi("/api/lofts");
      if (!mon.lofts.some(l => l.id === mon.loftId)) mon.loftId = mon.lofts[0]?.id || "";
      localStorage.setItem("monLoft", mon.loftId);
      const sel = document.querySelector("#loftSelect");
      sel.innerHTML = mon.lofts.map(l => '<option value="'+esc(l.id)+'"'+(l.id===mon.loftId?" selected":"")+'>'+esc(l.name)+'</option>').join("");
      if (mon.me.role === "admin") {
        document.querySelectorAll("#adminPanel select[name='loftId']").forEach(s => {
          s.innerHTML = mon.lofts.map(l => '<option value="'+esc(l.id)+'">'+esc(l.name)+'</option>').join("");
        });
        const gw = await mapi("/api/admin/gateway");
        document.querySelector("#gatewayState").textContent = "当前模式：" + gw.mode + (gw.failuresLeft ? "（剩余失败 " + gw.failuresLeft + " 次）" : "");
      }
      renderMonitor();
      if (mon.loftId) await loadOverview();
    }
    async function loadOverview() {
      if (!mon.loftId) return;
      mon.overview = await mapi("/api/lofts/" + encodeURIComponent(mon.loftId) + "/overview");
      renderOverview();
    }
    function renderOverview() {
      const ov = mon.overview; if (!ov) return;
      const isAdmin = mon.me.role === "admin";
      document.querySelector("#devices").innerHTML = ov.devices.length ? ov.devices.map(d => {
        const oob = d.lastValue != null && (d.lastValue < d.thresholds.min || d.lastValue > d.thresholds.max);
        return '<div class="small" style="margin-bottom:10px"><div class="row"><b>'+esc(d.name)+'</b><span class="pill info">'+METRIC_LABEL[d.type]+'</span>'+(oob?'<span class="pill crit">越界</span>':'<span class="pill ok">正常</span>')+'</div>'
          + '<div class="meta">阈值 '+d.thresholds.min+' ~ '+d.thresholds.max+' '+METRIC_UNIT[d.type]+' · 连续越界 '+d.streak+' 次</div>'
          + '<div>最新读数：<b>'+(d.lastValue ?? "-")+'</b> '+METRIC_UNIT[d.type]+' <span class="meta">采集于 '+fmtTime(d.lastCollectedAt)+'</span></div>'
          + (isAdmin ? '<div class="meta mono">key: '+esc(d.key)+'</div><div class="row"><input placeholder="读数" type="number" step="any" data-rv="'+d.id+'"><input placeholder="采集时间(可空)" data-rt="'+d.id+'"><button data-report="'+d.id+'">模拟上报</button></div>' : '')
          + '</div>';
      }).join("") : '<p class="meta">暂无设备</p>';
      document.querySelectorAll("[data-report]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.report;
        const value = document.querySelector('[data-rv="'+id+'"]').value;
        const collectedAt = document.querySelector('[data-rt="'+id+'"]').value;
        try {
          await mapi("/api/devices/" + id + "/readings", { method: "POST", body: JSON.stringify({ value: Number(value), collectedAt: collectedAt || undefined, reportId: "ui-" + Date.now() }) });
          await loadOverview();
        } catch (e) { monError(e); }
      });
      document.querySelector("#alarms").innerHTML = ov.alarms.length ? ov.alarms.map(a => {
        const dev = ov.devices.find(d => d.id === a.deviceId);
        const cls = a.status === "resolved" ? "ok" : (a.level === "critical" ? "crit" : "warn");
        const canConfirm = a.status === "active";
        const canResolve = a.status === "confirmed";
        return '<div class="small" style="margin-bottom:10px"><div class="row"><b>'+a.id+'</b><span class="pill '+cls+'">'+LEVEL_LABEL[a.level]+' · '+STATUS_LABEL[a.status]+'</span></div>'
          + '<div class="meta">'+METRIC_LABEL[a.metric]+' · '+esc(dev ? dev.name : a.deviceId)+' · 连续越界 '+a.streak+' 次 · '+fmtTime(a.createdAt)+'</div>'
          + '<div class="row"><button data-confirm="'+a.id+'" '+(!canConfirm?"disabled":"")+'>确认</button><button class="danger" data-resolve="'+a.id+'" '+(!canResolve?"disabled":"")+'>解除</button></div>'
          + '<div class="meta mono">'+a.history.map(h => esc(h.event)).join(" → ")+'</div></div>';
      }).join("") : '<p class="meta">暂无告警</p>';
      document.querySelectorAll("[data-confirm]").forEach(btn => btn.onclick = async () => { try { await mapi("/api/alarms/" + btn.dataset.confirm + "/confirm", { method: "POST", body: "{}" }); await loadOverview(); } catch (e) { monError(e); } });
      document.querySelectorAll("[data-resolve]").forEach(btn => btn.onclick = async () => { try { await mapi("/api/alarms/" + btn.dataset.resolve + "/resolve", { method: "POST", body: "{}" }); await loadOverview(); } catch (e) { monError(e); } });
      document.querySelector("#fans").innerHTML = ov.fans.length ? ov.fans.map(f =>
        '<div class="small" style="margin-bottom:10px"><div class="row"><b>'+esc(f.name)+'</b><span class="pill '+(f.state==="on"?"ok":"")+'">'+(f.state==="on"?"运行中":"已停止")+'</span></div><div class="meta">指令纪元 epoch='+f.commandEpoch+'</div></div>'
      ).join("") : '<p class="meta">暂无风机</p>';
      document.querySelector("#commands").innerHTML = ov.commands.length ? '<table><tr><th>指令</th><th>动作</th><th>状态</th><th>尝试</th><th>epoch</th></tr>' + ov.commands.map(c =>
        '<tr><td class="mono">'+c.id+'</td><td>'+(c.action==="start"?"启动风机":"停止风机")+'</td><td>'+(CMD_STATUS[c.status]||c.status)+'</td><td>'+c.attempts+'/'+c.maxAttempts+'</td><td>'+c.epoch+'</td></tr>'
      ).join("") + '</table>' : '<p class="meta">暂无指令</p>';
    }

    document.querySelector("#loginBtn").onclick = async () => {
      try {
        const data = await mapi("/api/login", { method: "POST", body: JSON.stringify({ username: document.querySelector("#loginUser").value, password: document.querySelector("#loginPass").value }) });
        mon.token = data.token; mon.me = data.user;
        localStorage.setItem("monToken", mon.token);
        document.querySelector("#loginErr").textContent = "";
        renderMonitor(); await loadMonitor();
      } catch (e) { document.querySelector("#loginErr").textContent = "登录失败：" + e.message; }
    };
    document.querySelector("#logoutBtn").onclick = async () => {
      try { await mapi("/api/logout", { method: "POST", body: "{}" }); } catch {}
      mon.token = ""; mon.me = null; mon.overview = null;
      localStorage.removeItem("monToken");
      renderMonitor();
    };
    document.querySelector("#loftSelect").onchange = async e => { mon.loftId = e.target.value; localStorage.setItem("monLoft", mon.loftId); await loadOverview(); };
    document.querySelector("#loftForm").onsubmit = async e => { e.preventDefault(); try { await mapi("/api/admin/lofts", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }); e.target.reset(); await loadMonitor(); } catch (err) { monError(err); } };
    document.querySelector("#keeperForm").onsubmit = async e => { e.preventDefault(); try { await mapi("/api/admin/users", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }); e.target.reset(); await loadMonitor(); } catch (err) { monError(err); } };
    document.querySelector("#deviceForm").onsubmit = async e => { e.preventDefault(); try { await mapi("/api/admin/devices", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }); e.target.reset(); await loadMonitor(); } catch (err) { monError(err); } };
    document.querySelector("#fanForm").onsubmit = async e => { e.preventDefault(); try { await mapi("/api/admin/fans", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) }); e.target.reset(); await loadMonitor(); } catch (err) { monError(err); } };
    document.querySelector("#gatewayForm").onsubmit = async e => { e.preventDefault(); const v = Object.fromEntries(new FormData(e.target).entries()); try { await mapi("/api/admin/gateway", { method: "POST", body: JSON.stringify({ mode: v.mode, failures: Number(v.failures || 0) }) }); await loadMonitor(); } catch (err) { monError(err); } };

    // ---------------- 标签页与刷新 ----------------
    const pigeonMain = document.querySelector("#pigeonMain");
    const monitorMain = document.querySelector("#monitorMain");
    const tabBtnPigeons = document.querySelector("#tabBtnPigeons");
    const tabBtnMonitor = document.querySelector("#tabBtnMonitor");
    function switchTab(which) {
      pigeonMain.hidden = which !== "pigeons";
      monitorMain.hidden = which !== "monitor";
      tabBtnPigeons.classList.toggle("active", which === "pigeons");
      tabBtnMonitor.classList.toggle("active", which === "monitor");
    }
    tabBtnPigeons.onclick = () => switchTab("pigeons");
    tabBtnMonitor.onclick = () => switchTab("monitor");
    document.querySelector("#reload").onclick = async () => { await loadPigeons(); if (mon.me) await loadMonitor(); };
    setInterval(() => { if (mon.me && mon.loftId && !monitorMain.hidden) loadOverview().catch(() => {}); }, 3000);

    loadPigeons();
    refreshMe();
  </script>
</body>
</html>`;
