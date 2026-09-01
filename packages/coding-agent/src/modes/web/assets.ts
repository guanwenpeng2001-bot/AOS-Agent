export interface WebAsset {
	readonly contentType: string;
	readonly body: string;
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>AOS Agent Web Surface</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">AOS Agent</p>
      <h1>Run observer</h1>
    </div>
    <div class="connection"><span id="connection-dot"></span><span id="connection-label">Connecting</span></div>
  </header>
  <main>
    <section class="panel runs-panel">
      <div class="panel-heading"><h2>Runs</h2><span id="run-count" class="count">0</span></div>
      <div id="runs" class="list empty">No runs recorded.</div>
    </section>
    <section class="panel detail-panel">
      <div class="panel-heading"><h2>Run detail</h2><span id="poll-time" class="muted"></span></div>
      <div id="run-detail" class="empty-state">Select a run to inspect its status, usage, and terminal receipt.</div>
    </section>
    <section class="panel graph-panel">
      <div class="panel-heading"><h2>Task graphs</h2><span id="graph-count" class="count">0</span></div>
      <div id="graphs" class="graph-list empty">No task graphs recorded.</div>
    </section>
    <section class="panel audit-panel">
      <div class="panel-heading"><h2>Audit query</h2><span class="readonly">read only</span></div>
      <form id="audit-form">
        <label>Run ID<input id="audit-run" name="runId" autocomplete="off" placeholder="Optional run ID"></label>
        <label>Event type<select id="audit-type" name="type"><option value="">All events</option><option>run.accepted</option><option>run.started</option><option>run.completed</option><option>run.failed</option><option>run.cancelled</option><option>run.interrupted</option><option>task.graph</option></select></label>
        <button type="submit">Query audit</button>
      </form>
      <div id="audit-results" class="audit-results empty">Submit a query to inspect safe audit events.</div>
    </section>
  </main>
  <footer>Loopback only · Read-only RPC proxy · No external resources</footer>
  <script src="/app.js" defer></script>
</body>
</html>
`;

const APP_CSS = `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8edf4;background:#0a0d12;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 80% -10%,#183148 0,transparent 34%),#0a0d12;color:#e8edf4}header{height:92px;padding:20px 28px;border-bottom:1px solid #27303b;display:flex;align-items:center;justify-content:space-between;background:#0d1118cc;backdrop-filter:blur(16px);position:sticky;top:0;z-index:2}h1,h2,p{margin:0}h1{font-size:24px;letter-spacing:-.03em}.eyebrow{text-transform:uppercase;letter-spacing:.16em;color:#7f91a6;font-size:10px;font-weight:700;margin-bottom:5px}.connection{display:flex;gap:9px;align-items:center;color:#aeb9c7;font-size:13px}#connection-dot{width:8px;height:8px;border-radius:50%;background:#d59a4a;box-shadow:0 0 14px #d59a4a}.connection.online #connection-dot{background:#49c58b;box-shadow:0 0 14px #49c58b}.connection.error #connection-dot{background:#e76969;box-shadow:0 0 14px #e76969}main{display:grid;grid-template-columns:minmax(250px,.75fr) minmax(380px,1.4fr);gap:16px;padding:18px 28px;max-width:1500px;margin:auto}.panel{background:#111720d9;border:1px solid #27303b;border-radius:12px;min-height:240px;overflow:hidden;box-shadow:0 18px 50px #0004}.panel-heading{height:52px;padding:0 16px;border-bottom:1px solid #27303b;display:flex;align-items:center;justify-content:space-between}.panel-heading h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:#aeb9c7}.count,.readonly{font-size:11px;color:#75869a;border:1px solid #303b48;border-radius:999px;padding:3px 8px}.readonly{text-transform:uppercase;letter-spacing:.08em}.runs-panel{grid-row:span 2}.detail-panel{min-height:320px}.list{display:flex;flex-direction:column}.run-row{appearance:none;border:0;border-bottom:1px solid #222b35;background:transparent;color:inherit;text-align:left;padding:14px 16px;cursor:pointer;display:grid;gap:7px}.run-row:hover,.run-row.selected{background:#19222d}.run-row-top{display:flex;justify-content:space-between;gap:10px}.run-id{font:600 12px ui-monospace,SFMono-Regular,Consolas,monospace;color:#d6e0eb;overflow:hidden;text-overflow:ellipsis}.status{font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:3px 7px;border-radius:999px;background:#293441;color:#aeb9c7}.status.completed,.status.succeeded{color:#66d9a3;background:#17372c}.status.failed,.status.cancelled{color:#ff9292;background:#3a2024}.status.running,.status.accepted,.status.active{color:#7fc6ff;background:#183248}.run-meta,.muted{font-size:11px;color:#75869a}.empty,.empty-state{padding:22px 16px;color:#75869a;font-size:13px}.detail-grid{padding:18px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.metric{background:#0b1017;border:1px solid #222c37;border-radius:9px;padding:12px}.metric-label{display:block;color:#718296;font-size:10px;text-transform:uppercase;letter-spacing:.09em;margin-bottom:7px}.metric-value{display:block;font-size:13px;word-break:break-word}.detail-json{margin:0 18px 18px;padding:14px;background:#090d12;border:1px solid #222c37;border-radius:9px;overflow:auto;max-height:210px;color:#9fb2c7;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.graph-list{padding:14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.graph-card{border:1px solid #293541;border-radius:10px;background:#0c1219;padding:13px}.graph-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.graph-title strong{font:600 12px ui-monospace,SFMono-Regular,Consolas,monospace}.nodes{display:flex;flex-direction:column;gap:6px}.node{border-left:2px solid #415065;padding:6px 8px;background:#121a23}.node-head{display:flex;justify-content:space-between;font-size:11px}.deps{font-size:10px;color:#718296;margin-top:4px}form{padding:14px 16px;display:grid;grid-template-columns:1fr 180px auto;gap:10px;align-items:end;border-bottom:1px solid #27303b}label{display:grid;gap:6px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#75869a}input,select,button{height:36px;border:1px solid #344252;border-radius:7px;background:#0a1017;color:#dce5ef;padding:0 10px;font:12px inherit}button{background:#dce8f4;color:#0a0d12;font-weight:700;cursor:pointer;padding:0 16px}button:hover{background:#fff}.audit-results{max-height:300px;overflow:auto}.audit-row{display:grid;grid-template-columns:150px 130px 1fr;gap:10px;padding:10px 16px;border-bottom:1px solid #222b35;font-size:11px}.audit-type{color:#8fcaff}.audit-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#9fafc0;overflow:hidden;text-overflow:ellipsis}.audit-summary{color:#7f91a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}footer{text-align:center;color:#5f7083;font-size:11px;padding:4px 20px 24px}@media(max-width:850px){header{padding:18px}main{grid-template-columns:1fr;padding:14px 18px}.runs-panel{grid-row:auto}form{grid-template-columns:1fr}.audit-row{grid-template-columns:1fr}.detail-grid{grid-template-columns:1fr 1fr}}
`;

const APP_JS = `"use strict";
const state={runs:[],selectedRunId:null};
const el=(id)=>document.getElementById(id);
async function rpc(method,params){const response=await fetch("/api/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({method:method,params:params})});const payload=await response.json();if(!response.ok)throw new Error(payload.error&&payload.error.message?payload.error.message:"RPC request failed");return payload.data}
function statusClass(value){return "status "+String(value||"unknown").replace(/[^a-z-]/g,"")}
function setConnection(kind,label){const box=document.querySelector(".connection");box.className="connection "+kind;el("connection-label").textContent=label}
function renderRuns(){const root=el("runs");el("run-count").textContent=String(state.runs.length);root.replaceChildren();root.className="list";if(state.runs.length===0){root.className="list empty";root.textContent="No runs recorded.";return}state.runs.forEach((entry)=>{const run=entry.run;const button=document.createElement("button");button.type="button";button.className="run-row"+(run.id===state.selectedRunId?" selected":"");const top=document.createElement("div");top.className="run-row-top";const id=document.createElement("span");id.className="run-id";id.textContent=run.id;const badge=document.createElement("span");badge.className=statusClass(run.status);badge.textContent=run.status;top.append(id,badge);const meta=document.createElement("div");meta.className="run-meta";meta.textContent="Attempt "+run.attempt+" · "+(run.model?run.model.provider+" / "+run.model.id:"No model");button.append(top,meta);button.addEventListener("click",()=>{state.selectedRunId=run.id;renderRuns();renderRunDetail()});root.append(button)})}
function metric(label,value){const box=document.createElement("div");box.className="metric";const a=document.createElement("span");a.className="metric-label";a.textContent=label;const b=document.createElement("span");b.className="metric-value";b.textContent=value===undefined||value===null?"—":String(value);box.append(a,b);return box}
function renderRunDetail(){const root=el("run-detail");const entry=state.runs.find((item)=>item.run.id===state.selectedRunId);root.replaceChildren();if(!entry){root.className="empty-state";root.textContent="Select a run to inspect its status, usage, and terminal receipt.";return}root.className="";const grid=document.createElement("div");grid.className="detail-grid";const usage=entry.receipt&&entry.receipt.usage?entry.receipt.usage:{};grid.append(metric("Status",entry.run.status),metric("Attempt",entry.run.attempt),metric("Total tokens",usage.totalTokens||usage.total),metric("Input",usage.inputTokens||usage.input),metric("Output",usage.outputTokens||usage.output),metric("Terminal",entry.receipt?entry.receipt.status:"Pending"));const pre=document.createElement("pre");pre.className="detail-json";pre.textContent=JSON.stringify(entry,null,2);root.append(grid,pre)}
function renderGraphs(graphs){const root=el("graphs");el("graph-count").textContent=String(graphs.length);root.replaceChildren();root.className="graph-list";if(graphs.length===0){root.className="graph-list empty";root.textContent="No task graphs recorded.";return}graphs.forEach((graph)=>{const card=document.createElement("article");card.className="graph-card";const title=document.createElement("div");title.className="graph-title";const name=document.createElement("strong");name.textContent=graph.taskId+" · r"+graph.graphRevision;const badge=document.createElement("span");badge.className=statusClass(graph.summary.status);badge.textContent=graph.summary.status;title.append(name,badge);const nodes=document.createElement("div");nodes.className="nodes";graph.nodes.forEach((item)=>{const node=document.createElement("div");node.className="node";const head=document.createElement("div");head.className="node-head";const nodeId=document.createElement("span");nodeId.textContent=item.nodeId;const nodeStatus=document.createElement("span");nodeStatus.className=statusClass(item.status);nodeStatus.textContent=item.status;head.append(nodeId,nodeStatus);const deps=document.createElement("div");deps.className="deps";deps.textContent=item.dependsOn.length?"depends on "+item.dependsOn.join(", "):"root node";node.append(head,deps);nodes.append(node)});card.append(title,nodes);root.append(card)})}
function auditRunIds(events){const ids=[];events.forEach((event)=>{if(event.runId&&!ids.includes(event.runId))ids.push(event.runId)});return ids}
async function refresh(){try{const audit=await rpc("audit.query",{scope:"current-session",types:["run.accepted","run.started","run.completed","run.failed","run.cancelled","run.interrupted"],limit:100});const ids=auditRunIds(audit.events);state.runs=await Promise.all(ids.map((id)=>rpc("run.get",{runId:id})));if(!state.selectedRunId&&state.runs.length)state.selectedRunId=state.runs[0].run.id;const graphData=await rpc("task.graph.list",{limit:100});renderRuns();renderRunDetail();renderGraphs(graphData.graphs);el("poll-time").textContent="Updated "+new Date().toLocaleTimeString();setConnection("online","Connected")}catch(error){setConnection("error",error instanceof Error?error.message:"Connection failed")}}
function renderAudit(result){const root=el("audit-results");root.replaceChildren();root.className="audit-results";if(result.events.length===0){root.className="audit-results empty";root.textContent="No matching audit events.";return}result.events.forEach((event)=>{const row=document.createElement("div");row.className="audit-row";const type=document.createElement("span");type.className="audit-type";type.textContent=event.type;const id=document.createElement("span");id.className="audit-id";id.textContent=event.runId||event.eventId;const summary=document.createElement("span");summary.className="audit-summary";summary.textContent=JSON.stringify(event.summary||{});row.append(type,id,summary);root.append(row)})}
el("audit-form").addEventListener("submit",async(event)=>{event.preventDefault();const query={scope:"current-session",limit:100};const runId=el("audit-run").value.trim();const type=el("audit-type").value;if(runId)query.runId=runId;if(type)query.types=[type];try{renderAudit(await rpc("audit.query",query))}catch(error){el("audit-results").textContent=error instanceof Error?error.message:"Audit query failed"}});
refresh();setInterval(refresh,3000);
`;

export const WEB_ASSETS: Readonly<Record<string, WebAsset>> = Object.freeze({
	"/": { contentType: "text/html; charset=utf-8", body: INDEX_HTML },
	"/index.html": { contentType: "text/html; charset=utf-8", body: INDEX_HTML },
	"/app.css": { contentType: "text/css; charset=utf-8", body: APP_CSS },
	"/app.js": { contentType: "text/javascript; charset=utf-8", body: APP_JS },
});
