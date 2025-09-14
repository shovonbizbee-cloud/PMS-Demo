// server.js — BSC-PMS full-stack demo (v2) for Render/Railway
// Roles: super_admin, business_admin, manager, hrbp, hod, employee, exec_viewer
// Start: npm install && npm start

const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));

// Email -> logs (safe for demos). Swap to SMTP later if you want.
const mailer = nodemailer.createTransport({ jsonTransport: true });
async function sendMail({ to, subject, text }) {
  try { await mailer.sendMail({ from: "pms@example.com", to, subject, text }); }
  catch (e) { console.warn("Mail error:", e.message); }
}

// ---------- DB ----------
const db = new Database("pms_demo_v2.db");
db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL, role TEXT NOT NULL, business TEXT, dept TEXT, manager_id TEXT
);
CREATE TABLE IF NOT EXISTS businesses ( id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL );
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, business_id TEXT NOT NULL, head_user_id TEXT,
  FOREIGN KEY(business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY(head_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS kpis (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, perspective TEXT NOT NULL,
  uom TEXT NOT NULL, frequency TEXT NOT NULL, weight REAL NOT NULL,
  formula TEXT NOT NULL, owner_role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY, kpi_id TEXT NOT NULL, assignee_type TEXT NOT NULL,
  assignee_id TEXT NOT NULL, target REAL NOT NULL, weight REAL NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(kpi_id) REFERENCES kpis(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS kpi_settings (
  id TEXT PRIMARY KEY, initiator_user_id TEXT NOT NULL, for_user_id TEXT NOT NULL,
  period TEXT NOT NULL, items TEXT NOT NULL, status TEXT NOT NULL,
  history TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, period TEXT NOT NULL,
  value REAL NOT NULL, submitted_by TEXT NOT NULL, status TEXT NOT NULL, submitted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, period TEXT NOT NULL,
  self_comment TEXT, manager_comment TEXT, hrbp_comment TEXT, hod_comment TEXT,
  score REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, history TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit ( id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, meta TEXT NOT NULL );
`);
const uuid = () => (global.crypto?.randomUUID?.() || require("crypto").randomBytes(16).toString("hex"));
const nowISO = () => new Date().toISOString();
const monthKey = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
const yearKey = (d=new Date()) => String(d.getFullYear());
function audit(userId,action,meta={}){ db.prepare(`INSERT INTO audit (id,at,user_id,action,meta) VALUES (?,?,?,?,?)`).run(uuid(),nowISO(),userId||null,action,JSON.stringify(meta)); }
function notify(userId,title,body){ db.prepare(`INSERT INTO notifications (id,user_id,title,body,read,at) VALUES (?,?,?,?,?,?)`).run(uuid(),userId,title,body,0,nowISO()); }

// Seed once
if (db.prepare(`SELECT COUNT(*) c FROM users`).get().c === 0) {
  const insU = db.prepare(`INSERT INTO users (id,name,email,password,role,business,dept,manager_id) VALUES (?,?,?,?,?,?,?,?)`);
  const insB = db.prepare(`INSERT INTO businesses (id,name) VALUES (?,?)`);
  const insD = db.prepare(`INSERT INTO departments (id,name,business_id,head_user_id) VALUES (?,?,?,?)`);
  const insK = db.prepare(`INSERT INTO kpis (id,title,perspective,uom,frequency,weight,formula,owner_role) VALUES (?,?,?,?,?,?,?,?)`);
  const insA = db.prepare(`INSERT INTO assignments (id,kpi_id,assignee_type,assignee_id,target,weight,status,created_at) VALUES (?,?,?,?,?,?,?,?)`);

  insU.run("u1","Sara Super","superadmin@pms","123456","super_admin",null,null,null);
  insU.run("u2","Ben BizAdmin","bizadmin@pms","123456","business_admin","Renewable Energy",null,null);
  insU.run("u3","Eva Employee","employee@pms","123456","employee",null,"Sales","u6");
  insU.run("u4","Hridoy HRBP","hrbp@pms","123456","hrbp","Renewable Energy",null,null);
  insU.run("u5","Hassan HOD","hod@pms","123456","hod","Renewable Energy","Sales",null);
  insU.run("u6","Mona Manager","manager@pms","123456","manager","Renewable Energy","Sales",null);
  insU.run("u7","Esha Exec","exec@pms","123456","exec_viewer","Renewable Energy",null,null);

  insB.run("b3","Renewable Energy");
  insD.run("d1","Sales","b3","u5");

  insK.run("k1","Monthly Revenue","Financial","BDT","Monthly",30,"sum","business_admin");
  insK.run("k2","Customer Acquisition","Customer","Count","Monthly",20,"sum","business_admin");
  insK.run("k3","On-time Delivery","Internal Process","%","Monthly",25,"percent","employee");

  insA.run("a1","k1","business","b3",500000,30,"approved",nowISO());
  insA.run("a2","k2","department","d1",120,20,"approved",nowISO());
  insA.run("a3","k3","user","u3",95,25,"approved",nowISO());
  console.log("Seeded demo data.");
}

// -------- Auth & helpers
function requireAuth(req,res,next){
  const token = req.headers["x-demo-token"];
  if(!token) return res.status(401).json({error:"Unauthenticated"});
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(token);
  if(!user) return res.status(401).json({error:"Invalid token"});
  req._user=user; next();
}
const can = (u, roles)=> !!u && roles.includes(u.role);

app.post("/auth/login",(req,res)=>{
  const { email, password } = req.body||{};
  const user = db.prepare(`SELECT * FROM users WHERE email=? AND password=?`).get(email,password);
  if(!user) return res.status(401).json({error:"Invalid credentials"});
  audit(user.id,"login",{});
  notify(user.id,`Welcome ${user.name}`,"Login successful.");
  res.json({ token:user.id, user });
});
app.get("/me", requireAuth, (req,res)=> res.json({ user:req._user }));

// -------- Org & library
app.get("/org", requireAuth, (req,res)=>{
  const businesses = db.prepare(`SELECT * FROM businesses`).all();
  const departments = db.prepare(`SELECT * FROM departments`).all();
  res.json({ businesses, departments });
});
app.get("/kpis", requireAuth, (req,res)=> res.json(db.prepare(`SELECT * FROM kpis`).all()));
app.post("/kpis", requireAuth, (req,res)=>{
  const u=req._user; if(!can(u,["super_admin","business_admin"])) return res.status(403).json({error:"Forbidden"});
  const { title,perspective,uom,frequency,weight=10,formula="sum",owner_role="business_admin"} = req.body||{};
  const id = uuid();
  db.prepare(`INSERT INTO kpis (id,title,perspective,uom,frequency,weight,formula,owner_role) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id,title,perspective,uom,frequency,weight,formula,owner_role);
  audit(u.id,"create_kpi",{id,title});
  res.json({ id });
});

// -------- Assignments
app.get("/assignments", requireAuth, (req,res)=>{
  const u=req._user; const all=db.prepare(`SELECT * FROM assignments`).all();
  if(u.role==="super_admin"||u.role==="business_admin") return res.json(all);
  if(u.role==="manager"){
    const myUsers = db.prepare(`SELECT id FROM users WHERE manager_id=?`).all(u.id).map(x=>x.id).concat([u.id]);
    return res.json(all.filter(a=> (a.assignee_type==="user" && myUsers.includes(a.assignee_id)) || (a.assignee_type==="department" && u.dept==="Sales")));
  }
  if(["hrbp","hod","exec_viewer"].includes(u.role)){
    return res.json(all.filter(a=> a.assignee_type!=="business" ? true : true)); // simple visibility for demo
  }
  res.json(all.filter(a=> (a.assignee_type==="user" && a.assignee_id===u.id) || (a.assignee_type==="department" && u.dept==="Sales")));
});
app.post("/assignments", requireAuth, (req,res)=>{
  const u=req._user; if(!can(u,["super_admin","business_admin"])) return res.status(403).json({error:"Forbidden"});
  const { kpi_id, assignee_type, assignee_id, target, weight=10 } = req.body||{};
  const id = uuid();
  db.prepare(`INSERT INTO assignments (id,kpi_id,assignee_type,assignee_id,target,weight,status,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id,kpi_id,assignee_type,assignee_id,target,weight,"pending",nowISO());
  audit(u.id,"assign_kpi",{id,kpi_id,assignee_type,assignee_id});
  res.json({ id,status:"pending" });
});
app.put("/assignments/:id/status", requireAuth, (req,res)=>{
  const u=req._user; if(!can(u,["super_admin","business_admin"])) return res.status(403).json({error:"Forbidden"});
  const { status } = req.body||{};
  db.prepare(`UPDATE assignments SET status=? WHERE id=?`).run(status,req.params.id);
  audit(u.id,"change_assignment_status",{id:req.params.id,status});
  res.json({ ok:true });
});

// -------- KPI Setting approvals (Employee→Manager→HRBP→HOD)
app.post("/kpi-settings/draft", requireAuth, (req,res)=>{
  const u=req._user; if(!can(u,["employee","manager","super_admin","business_admin"])) return res.status(403).json({error:"Forbidden"});
  const { for_user_id=u.id, period=yearKey(), items=[] } = req.body||{};
  const id=uuid();
  const hist=[{at:nowISO(),by:u.id,action:"create_draft"}];
  db.prepare(`INSERT INTO kpi_settings (id,initiator_user_id,for_user_id,period,items,status,history,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id,u.id,for_user_id,period,JSON.stringify(items),"draft",JSON.stringify(hist),nowISO());
  audit(u.id,"kpi_draft_create",{id,for_user_id,period});
  notify(u.id,"KPI Draft saved","Submit to Manager when ready.");
  res.json({ id,status:"draft" });
});
app.post("/kpi-settings/:id/submit", requireAuth, (req,res)=>{
  const u=req._user;
  const row=db.prepare(`SELECT * FROM kpi_settings WHERE id=?`).get(req.params.id);
  if(!row) return res.status(404).json({error:"Not found"});
  const hist=JSON.parse(row.history||"[]"); hist.push({at:nowISO(),by:u.id,action:"submit_to_manager"});
  db.prepare(`UPDATE kpi_settings SET status='submitted_to_manager', history=? WHERE id=?`).run(JSON.stringify(hist),row.id);
  audit(u.id,"kpi_submit_mgr",{id:row.id});
  res.json({ ok:true });
});
app.post("/kpi-settings/:id/manager-decision", requireAuth, (req,res)=>{
  const u=req._user; if(!can(u,["manager","super_admin","business_admin"])) return res.status(403).json({error:"Forbidden"});
  const { decision, comment="" } = req.body||{};
  const row=db.prepare(`SELECT * FROM kpi_settings WHERE id=?`).get(req.params.id);
  if(!row) return res.status(404).json({error:"Not found"});
  const hist=JSON.parse(row.history||"[]"); hist.push({at:nowISO(),by:u.id,action:"manager_"+decision,comment});
  db.prepare(`UPDATE kpi_settings SET status=?, history=? WHERE id=?`).run(decision==="approve"?"mgr_approved":"rejected", JSON.stringify(hist), row.id);
  audit(u.id,"kpi_mgr_"+decision,{id:row.id});
  res.json({ ok:true });
});
app.post("/kpi-settings/:id/hrbp-decision", requireAuth, (req,res)=>{
  const u=req._user; if(!can(u,["hrbp","super_admin","business_admin"])) return res.status(403).json({error:"Forbidden"});
  const { decision, comment="" } = req.body||{};
  const row=db.prepare(`SELECT * FROM kpi_settings WHERE id=?`).get(req.params.id);
  if(!row || row.status!=="mgr_approved") return res.status(400).json({error:"Invalid state"});
  const hist=JSON.parse(row.history||"[]"); hist.push({at:nowISO(),by:u.id,action:"hrbp_"+decision,comment});
  db.prepare(`UPDATE kpi_settings SET status=?, history=? WHERE id=?`).run(decision==="approve"?"hrbp_approved":"rejected", JSON.stringify(hist), row.id);
  audit(u.id,"kpi_hrbp_"+decision,{id:row.id});
  res.json({ ok:true });
});
app.post("/kpi-settings/:id/hod-decision", requireAuth, (req,res)=>{
  const u=req._user; if(!can(u,["hod","super_admin","business_admin"])) return res.status(403).json({error:"Forbidden"});
  const { decision, comment="" } = req.body||{};
  const row=db.prepare(`SELECT * FROM kpi_settings WHERE id=?`).get(req.params.id);
  if(!row || row.status!=="hrbp_approved") return res.status(400).json({error:"Invalid state"});
  const hist=JSON.parse(row.history||"[]"); hist.push({at:nowISO(),by:u.id,action:"hod_"+decision,comment});
  if(decision==="approve"){
    const items = JSON.parse(row.items||"[]");
    const insA = db.prepare(`INSERT INTO assignments (id,kpi_id,assignee_type,assignee_id,target,weight,status,created_at) VALUES (?,?,?,?,?,?,?,?)`);
    items.forEach(it=>{
      const asnId=uuid();
      const kpiId=it.kpi_id || uuid();
      if(!it.kpi_id){
        db.prepare(`INSERT INTO kpis (id,title,perspective,uom,frequency,weight,formula,owner_role) VALUES (?,?,?,?,?,?,?,?)`)
          .run(kpiId,it.title||"Custom KPI",it.perspective||"Financial",it.uom||"%",it.frequency||"Monthly",it.weight||10,"sum","employee");
      }
      insA.run(asnId,kpiId,"user",row.for_user_id,Number(it.target||0),Number(it.weight||10),"approved",nowISO());
    });
  }
  db.prepare(`UPDATE kpi_settings SET status=?, history=? WHERE id=?`).run(decision==="approve"?"hod_final":"rejected", JSON.stringify(hist), row.id);
  audit(u.id,"kpi_hod_"+decision,{id:row.id});
  res.json({ ok:true });
});

// -------- Achievements & Reports
app.post("/achievements", requireAuth, (req,res)=>{
  const u=req._user; const { assignment_id, value, period=monthKey() } = req.body||{};
  const id=uuid();
  db.prepare(`INSERT INTO achievements (id,assignment_id,period,value,submitted_by,status,submitted_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id,assignment_id,period,value,u.id,"submitted",nowISO());
  audit(u.id,"submit_achievement",{assignment_id,value,period});
  notify(u.id,"Achievement submitted",`Your ${period} entry is pending approval.`);
  res.json({ id,status:"submitted" });
});
app.get("/reports/kpi-variance", requireAuth, (req,res)=>{
  const { period=monthKey() } = req.query||{};
  const asn=db.prepare(`SELECT * FROM assignments WHERE status='approved'`).all();
  const kpis=Object.fromEntries(db.prepare(`SELECT * FROM kpis`).all().map(k=>[k.id,k]));
  const achieved=db.prepare(`SELECT assignment_id, SUM(value) s FROM achievements WHERE status!='rejected' AND period=? GROUP BY assignment_id`).all(period);
  const map=Object.fromEntries(achieved.map(r=>[r.assignment_id, r.s||0]));
  const rows=asn.map(a=>{
    const k=kpis[a.kpi_id]; const got=map[a.id]||0;
    const pct=a.target?Math.min(120,(got/a.target)*100):0;
    const weighted=pct*(a.weight/100);
    return {kpi:k.title, assignee:a.assignee_type+":"+a.assignee_id, target:a.target, achieved:got, pct, weighted};
  });
  res.json(rows);
});

// -------- Minimal UI
const FRONTEND = `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BSC-PMS</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>body{background:#f8fafc}</style>
</head><body class="min-h-screen text-slate-800">
<div class="p-4 max-w-5xl mx-auto">
  <div id="login" class="max-w-md mx-auto mt-10 border rounded-xl bg-white p-6 shadow">
    <h1 class="text-2xl font-semibold mb-2">BSC-PMS Login</h1>
    <p class="text-sm text-slate-500 mb-4">Use demo accounts below</p>
    <input id="email" class="w-full border rounded px-3 py-2 mb-2" placeholder="Email (e.g., superadmin@pms)">
    <input id="pass" class="w-full border rounded px-3 py-2 mb-3" type="password" placeholder="Password (e.g., 123456)">
    <button onclick="login()" class="w-full bg-indigo-600 text-white rounded px-4 py-2">Sign in</button>
    <div class="text-xs text-slate-500 mt-3">superadmin@pms · bizadmin@pms · manager@pms · hrbp@pms · hod@pms · exec@pms · employee@pms (all 123456)</div>
  </div>

  <div id="app" class="hidden">
    <div class="flex items-center justify-between mb-4">
      <div><div class="text-xl font-semibold">BSC-PMS</div><div class="text-xs text-slate-500">Full-stack demo</div></div>
      <div class="flex items-center gap-2">
        <button class="border rounded px-3 py-2" onclick="showNotifs()">Notifications <span id="n" class="text-xs"></span></button>
        <button class="border rounded px-3 py-2" onclick="logout()">Log out</button>
      </div>
    </div>
    <nav class="flex flex-wrap gap-2 mb-4">
      <button class="border rounded px-3 py-2" onclick="nav('dashboard')">Dashboard</button>
      <button class="border rounded px-3 py-2" onclick="nav('kpis')">KPIs</button>
      <button class="border rounded px-3 py-2" onclick="nav('ach')">Monthly Achievements</button>
      <button class="border rounded px-3 py-2" onclick="nav('reviews')">Appraisals</button>
      <button id="approvalsTab" class="border rounded px-3 py-2 hidden" onclick="nav('approvals')">Approvals</button>
      <button class="border rounded px-3 py-2" onclick="nav('reports')">Reports</button>
    </nav>
    <section id="page" class="border rounded bg-white p-4 shadow"></section>
  </div>
</div>
<script>
let TOKEN=null,ME=null;
const API=(p,opt={})=>fetch(p,{...opt,headers:{'Content-Type':'application/json','X-Demo-Token':TOKEN,...(opt.headers||{})}}).then(r=>r.json());
const monthKey=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')};
const yearKey=()=>String(new Date().getFullYear());
async function login(){
  const email=document.getElementById('email').value.trim();
  const password=document.getElementById('pass').value.trim();
  const r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})}).then(r=>r.json());
  if(r.error){alert(r.error);return;}
  TOKEN=r.token; ME=r.user;
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  if(['manager','hrbp','hod','super_admin','business_admin'].includes(ME.role)) document.getElementById('approvalsTab').classList.remove('hidden');
  nav('dashboard'); refreshN();
}
function logout(){ location.reload(); }
async function refreshN(){ const list=await API('/notifications'); const unread=(list||[]).filter(n=>!n.read).length; document.getElementById('n').textContent=unread?('('+unread+')'):''; }
function nav(p){ if(p==='dashboard')dash(); if(p==='kpis')kpis(); if(p==='ach')ach(); if(p==='reviews')reviews(); if(p==='approvals')approvals(); if(p==='reports')reports(); }

async function dash(){
  const page=document.getElementById('page'); const asn=await API('/assignments'); const per=monthKey();
  const rows=await API('/reports/kpi-variance?period='+per);
  const totalW=asn.reduce((s,a)=>s+(a.weight||0),0)||1; const tot=rows.reduce((s,r)=>s+(r.weighted||0),0);
  const score=(tot/(totalW/100));
  page.innerHTML=\`
    <div class="grid md:grid-cols-3 gap-4">
      <div class="p-4 border rounded"><div class="text-sm text-slate-500">Overall Score (\${per})</div><div class="text-3xl font-semibold">\${score.toFixed(1)}%</div></div>
      <div class="p-4 border rounded"><div class="text-sm text-slate-500">Assignments</div><div class="text-3xl font-semibold">\${asn.length}</div></div>
      <div class="p-4 border rounded"><div class="text-sm text-slate-500">Role</div><div class="text-3xl font-semibold">\${ME.role}</div></div>
    </div>\`;
}

async function kpis(){
  const page=document.getElementById('page'); const k=await API('/kpis'); const asn=await API('/assignments');
  page.innerHTML=\`
    <div class="font-medium mb-2">KPI Library</div>
    <div class="overflow-auto mb-4"><table class="min-w-full text-sm"><thead><tr class="border-b"><th class="py-2 pr-3 text-left">Title</th><th class="py-2 pr-3 text-left">Perspective</th><th class="py-2 pr-3 text-left">UoM</th><th class="py-2 pr-3 text-left">Freq</th><th class="py-2 pr-3 text-left">Weight</th></tr></thead><tbody>\${k.map(x=>\`<tr class='border-b'><td class='py-2 pr-3'>\${x.title}</td><td class='py-2 pr-3'>\${x.perspective}</td><td class='py-2 pr-3'>\${x.uom}</td><td class='py-2 pr-3'>\${x.frequency}</td><td class='py-2 pr-3'>\${x.weight}%</td></tr>\`).join('')}</tbody></table></div>
    <div class="font-medium mb-2">Assignments</div>
    <div class="grid gap-2">\${asn.map(a=>\`<div class='border rounded p-3 flex items-center justify-between'><div>Assignee: \${a.assignee_type}:\${a.assignee_id} · Target \${a.target} · Weight \${a.weight}%</div></div>\`).join('')}</div>\`;
}

async function ach(){
  const page=document.getElementById('page'); const asn=await API('/assignments'); const per=monthKey();
  page.innerHTML=\`<div class="font-medium mb-2">Monthly Achievement (\${per})</div>\` + asn.map(a=>\`
    <div class="border rounded p-3 flex items-center justify-between">
      <div>\${a.assignee_type}:\${a.assignee_id} · Target \${a.target} · Weight \${a.weight}%</div>
      <div><input id="v-\${a.id}" class="border rounded px-2 py-1 w-28 mr-2" type="number" placeholder="value"><button class="bg-indigo-600 text-white rounded px-3 py-1" onclick="sub('\${a.id}')">Submit</button></div>
    </div>\`).join('');
}
async function sub(id){
  const v=Number(document.getElementById('v-'+id).value||0); if(!v) return alert('Enter a value');
  await API('/achievements',{method:'POST',body:JSON.stringify({assignment_id:id,value:v})});
  alert('Submitted');
}

async function reviews(){
  const page=document.getElementById('page'); const period=yearKey();
  let r=await API('/reviews/mine?period='+period);
  if(!r){ await API('/reviews/draft',{method:'POST',body:JSON.stringify({period,self_comment:'',score:0})}); r=await API('/reviews/mine?period='+period); }
  page.innerHTML=\`
    <div class="grid md:grid-cols-2 gap-4">
      <div class="border rounded p-4"><div class="font-medium mb-2">Self Assessment (\${period})</div>
        <textarea id="selfc" class="w-full border rounded px-3 py-2 h-32">\${r?.self_comment||""}</textarea>
        <div class="mt-2 flex gap-2">
          <button class="bg-indigo-600 text-white rounded px-3 py-2" onclick="save()">Save</button>
          <button class="border rounded px-3 py-2" onclick="submitR()">Submit</button>
          <div class="text-xs text-slate-500">Status: \${r?.status}</div>
        </div>
      </div>
      <div class="border rounded p-4"><div class="font-medium mb-2">Calculated KPI Score</div><div class="text-3xl font-semibold">\${r?.score||0}%</div></div>
    </div>\`;
}
async function save(){ await API('/reviews/draft',{method:'POST',body:JSON.stringify({period:yearKey(),self_comment:document.getElementById('selfc').value,score:0})}); alert('Saved'); }
async function submitR(){ await API('/reviews/submit',{method:'POST',body:JSON.stringify({period:yearKey()})}); alert('Submitted'); reviews(); }

async function approvals(){
  const page=document.getElementById('page');
  const k=await API('/kpi-settings/pending').catch(()=>[]);
  const r=await API('/reviews/pending').catch(()=>[]);
  page.innerHTML=\`
    <div class="font-medium mb-2">KPI Settings Pending</div>
    <div class="grid gap-2">\${(k||[]).map(x=>\`<div class='border rounded p-3 flex items-center justify-between'><div>For: \${x.for_user_id} · \${x.period} · \${x.status}</div><div class='flex gap-2'><button class='border rounded px-3 py-1 text-xs' onclick="kpi('\${x.id}','approve')">Approve</button><button class='border rounded px-3 py-1 text-xs' onclick="kpi('\${x.id}','reject')">Reject</button></div></div>\`).join('')||'<div class="text-sm text-slate-500">Nothing pending</div>'}</div>
    <div class="font-medium mt-6 mb-2">Appraisals Pending</div>
    <div class="grid gap-2">\${(r||[]).map(x=>\`<div class='border rounded p-3 flex items-center justify-between'><div>User: \${x.user_id} · \${x.period} · \${x.status}</div><div class='flex gap-2'><button class='border rounded px-3 py-1 text-xs' onclick="rev('\${x.id}','approve')">Approve</button><button class='border rounded px-3 py-1 text-xs' onclick="rev('\${x.id}','reject')">Reject</button></div></div>\`).join('')||'<div class="text-sm text-slate-500">Nothing pending</div>'}</div>\`;
}
async function kpi(id,decision){
  let ok=false;
  try { await API('/kpi-settings/'+id+'/manager-decision',{method:'POST',body:JSON.stringify({decision})}); ok=true; } catch(e){}
  try { await API('/kpi-settings/'+id+'/hrbp-decision',{method:'POST',body:JSON.stringify({decision})}); ok=true; } catch(e){}
  try { await API('/kpi-settings/'+id+'/hod-decision',{method:'POST',body:JSON.stringify({decision})}); ok=true; } catch(e){}
  if(!ok) alert('Your role cannot decide this step');
  approvals();
}
async function rev(id,decision){ await API('/reviews/'+id+'/decision',{method:'POST',body:JSON.stringify({decision})}); approvals(); }

async function showNotifs(){ const list=await API('/notifications'); alert((list||[]).map(n=>\`\${n.read?'[read] ':'[new] '}\${n.title} — \${n.body}\`).join('\\n')||'No notifications'); }
</script>
</body></html>`;
app.get("/", (req,res)=> res.type("html").send(FRONTEND));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("BSC-PMS running on http://localhost:"+PORT));
