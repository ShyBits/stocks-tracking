// ===================== Utilities & State =====================
const $ = (q, el=document)=> el.querySelector(q);
const $$ = (q, el=document)=> [...el.querySelectorAll(q)];
const round = (x,n=2)=> x==null ? "" : Math.round(x*10**n)/10**n;
const LS = { WATCH:"ml_watch", EUR:"ml_eur", VIEW:"ml_view", PROV:"ml_provider", KEY:"ml_api_key" };

let watch = JSON.parse(localStorage.getItem(LS.WATCH)||"[]");
let preferEUR = JSON.parse(localStorage.getItem(LS.EUR)||"true");
let viewMode = localStorage.getItem(LS.VIEW) || "grid";
let provider = localStorage.getItem(LS.PROV) || "finnhub";
let apiKey = localStorage.getItem(LS.KEY) || "d2m7g61r01qq6fopb5ggd2m7g61r01qq6fopb5h0";
localStorage.setItem(LS.PROV, provider);
localStorage.setItem(LS.KEY, apiKey);

let data = {};                // sym -> { last, prevClose, t, ccy, history:[{t,p}], logo }
let usdEur = 0.9;
const REFRESH_MS = 30_000;
let backoffUntil = 0;

// Dom-Refs für schnelle Live-Updates
const domIndex = new Map();   // sym -> { priceEl, deltaEl, chart }

// WS
let ws = null;
let wsReconnectT = null;

// Chart.js Default-Farben (damit auf Dark sichtbar)
if (window.Chart) {
  Chart.defaults.color = "#97a3b6";
  Chart.defaults.borderColor = "rgba(255,255,255,.06)";
}

// ===================== Fetch helpers =====================
async function fetchJSON(url, opts = {}){
  const r = await fetch(url, {
    ...opts, cache: "no-store",
    headers: { "accept": "application/json", ...(opts.headers||{}) }
  });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok){
    const txt = await r.text().catch(()=> "");
    if (ct.includes("text/html") || txt.startsWith("<")) throw new Error(`HTTP ${r.status} (HTML)`);
    try { const j = JSON.parse(txt); throw new Error(j.error || j.message || `HTTP ${r.status}`); }
    catch { throw new Error(`HTTP ${r.status}`); }
  }
  if (!ct.includes("application/json")) {
    const txt = await r.text().catch(()=> "");
    if (txt.startsWith("<")) throw new Error("HTML response");
    try { return JSON.parse(txt); } catch { throw new Error("Bad JSON"); }
  }
  return r.json();
}

async function withRetry(fn, {tries=3, delays=[250, 600, 1200]} = {}){
  let lastErr;
  for (let i=0; i<tries; i++){
    try { return await fn(); }
    catch (e){ if (e?.name === "AbortError") throw e; lastErr=e; if (i<tries-1) await new Promise(r=>setTimeout(r, delays[i]||800)); }
  }
  throw lastErr;
}

function cryptoFallback(sym){
  const m = sym.match(/^([A-Z0-9_]+):([A-Z0-9-]+)$/i);
  if (!m) return null;
  const ex = m[1].toUpperCase(), pair = m[2].toUpperCase();
  if (ex==="COINBASE" && pair==="BTC-USD") return "BINANCE:BTCUSDT";
  if (ex==="COINBASE" && pair==="ETH-USD") return "BINANCE:ETHUSDT";
  return null;
}

function mapToTwelveDataSymbol(sym){
  if (/\.DE$/i.test(sym)) return sym.replace(/\.DE$/i, ":XETRA");
  if (/\.F$/i.test(sym))  return sym.replace(/\.F$/i, ":FRA");
  if (/\.L$/i.test(sym))  return sym.replace(/\.L$/i, ":LSE");
  if (/\.HK$/i.test(sym)) return sym.replace(/\.HK$/i, ":HKEX");
  if (/\.SZ$/i.test(sym)) return sym.replace(/\.SZ$/i, ":SZSE");
  if (/\.SS$/i.test(sym)) return sym.replace(/\.SS$/i, ":SSE");
  return sym;
}

// ===================== Providers =====================
const Providers = {
  twelvedata: {
    name: "Twelve Data",
    async search(q, opts = {}){
      if (!apiKey || !q) return [];
      const url = `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(q)}&apikey=${apiKey}`;
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const list = (j.data||[]).slice(0,10).map(x=>({
        symbol: x.symbol,
        name: x.instrument_name || x.name || x.symbol,
        type: (x.instrument_type || x.exchange || "").toLowerCase(),
        display: `${x.symbol} — ${x.instrument_name || x.name || ""}`.trim()
      }));
      if (/^xau/i.test(q) || /gold/i.test(q)) list.unshift({symbol:"XAU/USD", name:"Gold Spot", type:"forex", display:"XAU/USD — Gold Spot"});
      return dedupeBy(list, i=>i.symbol);
    },
    async quote(sym){
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${apiKey}`;
      const j = await fetchJSON(url);
      if (j.status==="error") throw new Error(j.message||"TD error");
      return { last:+j.price, prevClose:+j.previous_close, t: Date.parse(j.datetime||Date.now()), ccy:(j.currency||"USD").toUpperCase() };
    },
    async history(sym, interval="15min", points=200){
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${points}&order=ASC&apikey=${apiKey}`;
      const j = await fetchJSON(url);
      if (j.status==="error") throw new Error(j.message||"TD error");
      const arr = (j.values||j.data||[]).map(d=>({ t: Date.parse(d.datetime), p: +d.close }));
      return arr.sort((a,b)=>a.t-b.t);
    }
  },

  finnhub: {
    name: "Finnhub",
    async search(q, opts = {}){
      if (!apiKey || !q) return [];
      const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${apiKey}`;
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const items = (j.result||[])
        .filter(x=>x.symbol && (x.description||"").length)
        .map(x=>{
          const type=(x.type||"").toLowerCase();
          return {
            symbol:x.symbol,
            name:x.description,
            type: type.includes("forex")?"forex": type.includes("crypto")?"crypto": type.includes("etf")?"etf":"stock",
            display:`${x.symbol} — ${x.description}`
          };
        });
      if (/^xau/i.test(q) || /gold/i.test(q)) items.unshift({symbol:"OANDA:XAU_USD", name:"Gold Spot", type:"forex", display:"OANDA:XAU_USD — Gold Spot"});
      const Q=q.toUpperCase();
      items.sort((a,b)=>{ const sa=a.symbol.toUpperCase(), sb=b.symbol.toUpperCase(); const s=S=>S===Q?0:S.startsWith(Q)?1:S.includes(Q)?2:3; return s(sa)-s(sb); });
      const seen=new Set(), out=[]; for (const it of items){ if(!seen.has(it.symbol)){ seen.add(it.symbol); out.push(it);} if(out.length>=10) break; }
      return out;
    },

    async quote(sym){
      const isFx = sym.startsWith("OANDA:");
      const isCrypto = !isFx && sym.includes(":");

      if (isFx){
        const j = await withRetry(()=> fetchJSON(`https://finnhub.io/api/v1/forex/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`));
        const last = +(j.c ?? j.ask ?? j.bid);
        const prev = +(j.pc ?? last);
        return { last, prevClose: prev, t: Date.now(), ccy:"USD" };
      }

      if (isCrypto){
        const to = Math.floor(Date.now()/1000), from = to - 86400;
        const get = s=>fetchJSON(`https://finnhub.io/api/v1/crypto/candle?symbol=${encodeURIComponent(s)}&resolution=1&from=${from}&to=${to}&token=${apiKey}`);
        let j = await withRetry(()=> get(sym));
        if (j.s!=="ok" || !j.c?.length){
          const alt = cryptoFallback(sym);
          if (alt){ j = await withRetry(()=> get(alt)); }
          if (j.s!=="ok" || !j.c?.length) throw new Error("No crypto data");
        }
        const n=j.c.length, last=+j.c[n-1], prev=n>1?+j.c[n-2]:last, t=(j.t?.[n-1] ?? to)*1000;
        return { last, prevClose: prev, t, ccy:"USD" };
      }

      const j = await withRetry(()=> fetchJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`));
      const last = +((j.c ?? j.price) || j.ask || j.bid);
      const prev = +(j.pc ?? j.prevClose ?? last);
      const t = (j.t ? j.t*1000 : Date.now());
      return { last, prevClose: prev, t, ccy:"USD" };
    },

    async history(sym, resolution="15"){
      const to = Math.floor(Date.now()/1000);
      const from = to - 60*60*24*14;
      const base = sym.startsWith("OANDA:") ? "forex/candle" : (sym.includes(":") ? "crypto/candle" : "stock/candle");
      const j = await withRetry(()=> fetchJSON(`https://finnhub.io/api/v1/${base}?symbol=${encodeURIComponent(sym)}&resolution=${resolution}&from=${from}&to=${to}&token=${apiKey}`));
      if (j.s!=="ok") return [];
      return j.t.map((t,i)=>({ t: t*1000, p: j.c[i] }));
    }
  }
};

// ===================== DOM & small helpers =====================
const q = $("#q"), suggest = $("#suggest"), board = $("#board");
const eurLabel = $("#eurLabel"), btnEUR=$("#btnEUR"), btnToggleView=$("#btnToggleView");
const btnSettings=$("#btnSettings"), settingsDlg=$("#settingsDlg"), ddProvider=$("#provider"), inKey=$("#apiKey");

function toast(msg, type="info", timeout=4200){
  const el = document.createElement("div"); el.className="card"; el.textContent = msg;
  $("#toasts").appendChild(el); setTimeout(()=> el.remove(), timeout);
}
function dedupeBy(arr, keyFn){ const s=new Set(); return arr.filter(x=>{ const k=keyFn(x); if(s.has(k))return false; s.add(k); return true; }); }
function fmtTimeShort(t){ try { return new Intl.DateTimeFormat([], {hour:'2-digit', minute:'2-digit'}).format(t); } catch{ return new Date(t).toLocaleTimeString(); } }
async function fetchUsdEur(){ try{ const j = await fetchJSON("https://api.exchangerate.host/latest?base=USD&symbols=EUR"); if (j?.rates?.EUR) usdEur=j.rates.EUR; }catch{} }
function formatCCY(ccy,val,showEuro){ return showEuro ? `€ ${round(val,4)}` : `${ccy||""} ${round(val,4)}`; }

// ===================== Logos (cache) =====================
const LS_LOGOS = "ml_logos";
let logoCache = JSON.parse(localStorage.getItem(LS_LOGOS) || "{}"); // { TICKER: url }

async function fetchLogo(symbol){
  if (logoCache[symbol]) return logoCache[symbol];
  try{
    const j = await fetchJSON(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`);
    let logo = j.logo || null;
    if (!logo && j.weburl){ try{ const domain = new URL(j.weburl).hostname; logo = `https://logo.clearbit.com/${domain}`; }catch{} }
    logoCache[symbol] = logo || null;
    localStorage.setItem(LS_LOGOS, JSON.stringify(logoCache));
    return logoCache[symbol];
  }catch{ return null; }
}

// ===================== Rendering =====================
function render(){
  board.className = `board ${viewMode}`;
  board.innerHTML = "";
  watch.forEach(sym=>{
    const d = data[sym.symbol] || {};
    const change = (d.last!=null && d.prevClose!=null) ? d.last - d.prevClose : null;
    const pct = (change!=null && d.prevClose) ? (change/d.prevClose*100) : null;
    const showInEUR = preferEUR && (d.ccy||"USD")==="USD";
    const lastDisp = d.last!=null ? (showInEUR ? d.last*usdEur : d.last) : null;

    const tile = document.createElement("div");
    tile.className="tile card";
    const logoEl = d.logo
      ? `<img src="${d.logo}" class="logo" alt="${sym.symbol} logo" onerror="this.style.display='none'">`
      : `<div class="logo ph">${(sym.name||sym.symbol).slice(0,1).toUpperCase()}</div>`;

    tile.innerHTML = `
      <div class="tile__head">
        ${logoEl}
        <span class="tag">${sym.symbol}</span>
        <span class="name">${sym.name||""}</span>
        <span class="grow"></span>
        <span class="price">${lastDisp!=null ? formatCCY(showInEUR?"EUR":d.ccy, lastDisp, showInEUR) : "—"}</span>
        <span class="delta ${pct>0?"up":pct<0?"down":""}">${pct!=null ? (pct>0?"+":"")+round(pct,2)+"%" : ""}</span>
        <div class="actions">
          <button class="iconbtn" title="Remove"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
      <div class="meta" style="color:var(--muted);font-size:12px;margin-top:4px">
        <span>${sym.type||""}</span> • <span>${d.t? "Updated "+fmtTimeShort(d.t): "—"}</span>
      </div>
      <div class="chartWrap"><canvas></canvas></div>
    `;

    // Remove + WS unsubscribe
    tile.querySelector(".iconbtn").onclick = ()=>{
      watch = watch.filter(x=>x.symbol!==sym.symbol);
      localStorage.setItem(LS.WATCH, JSON.stringify(watch));
      if (ws && ws.readyState===WebSocket.OPEN){ try{ ws.send(JSON.stringify({type:"unsubscribe", symbol:sym.symbol})); }catch{} }
      render();
    };

    board.appendChild(tile);
    window.lucide?.createIcons?.({attrs:{}});

    // Chart
    const ctx = tile.querySelector("canvas").getContext("2d");
    const hist = (d.history||[]).slice(-120);
    let chart = null;
    if (hist.length){
      const labels = hist.map(p=>new Date(p.t));
      const prices = hist.map(p=> showInEUR ? p.p*usdEur : p.p);
      chart = new Chart(ctx, {
        type:"line",
        data:{ labels, datasets:[{
          data: prices, tension:.25, pointRadius:0,
          borderWidth:2,
          borderColor:"rgba(52,211,153,.9)",
          backgroundColor:"rgba(52,211,153,.15)",
          fill:true
        }]},
        options:{
          animation:false, responsive:true, maintainAspectRatio:false,
          scales:{ x:{display:false}, y:{display:false} },
          plugins:{ legend:{display:false}, tooltip:{enabled:true} }
        }
      });
    }

    domIndex.set(sym.symbol, { priceEl: tile.querySelector(".price"), deltaEl: tile.querySelector(".delta"), chart });
  });
}

// ===================== Data fetch + fallback =====================
async function updateOne(sym){
  const P = Providers[provider]; if (!P) return;
  try{
    const [q,h] = await Promise.all([ P.quote(sym.symbol), P.history(sym.symbol) ]);
    const logo = (data[sym.symbol]?.logo) ?? await fetchLogo(sym.symbol);
    data[sym.symbol] = { ...q, history:h, logo };
  }catch(e){
    const msg = (e?.message||"").toLowerCase();
    if (provider==="finnhub" && (msg.includes("don't have access") || msg.includes("access to this resource"))){
      try{
        const tdSym = mapToTwelveDataSymbol(sym.symbol);
        const [q2,h2] = await Promise.all([ Providers.twelvedata.quote(tdSym), Providers.twelvedata.history(tdSym) ]);
        const logo = (data[sym.symbol]?.logo) ?? await fetchLogo(sym.symbol);
        data[sym.symbol] = { ...q2, history:h2, logo };
        return;
      }catch(e2){ toast(`Failed: ${sym.symbol} (${e2.message||e2})`); return; }
    }
    toast(`Failed: ${sym.symbol} (${e.message||e})`);
  }
}
async function refreshAll(){
  await fetchUsdEur();
  await Promise.all(watch.map(updateOne));
  render();
}

// ===================== Search with "Add" =====================
let searchAbort=null, kbIndex=-1, debounceT=null;

function addSymbolToWatch(symbol, name="", type=""){
  if (!watch.find(w=>w.symbol===symbol)){
    watch.unshift({symbol, name, type});
    localStorage.setItem(LS.WATCH, JSON.stringify(watch));
    // live subscribe
    if (ws && ws.readyState===WebSocket.OPEN){ try{ ws.send(JSON.stringify({type:"subscribe", symbol})); }catch{} }
    refreshAll();
  }
}
function renderSuggest(list){
  if (!list.length){ suggest.style.display="none"; suggest.innerHTML=""; kbIndex=-1; return; }
  suggest.innerHTML = list.map((item,i)=>`
    <div class="item${i===kbIndex?' active':''}" data-sym="${item.symbol}" data-name="${item.name||""}" data-type="${item.type||''}">
      <div class="left">
        <div class="sym">${item.symbol}</div>
        <div class="name">${item.name||""}</div>
        <div class="meta">${item.type}</div>
      </div>
      <button class="addbtn">Add</button>
    </div>`).join("");
  suggest.style.display="block";
  $$(".item", suggest).forEach((el,i)=>{
    el.onmouseenter = ()=>{ kbIndex=i; highlightSuggest(); };
    el.onclick = (e)=>{ if (e.target.classList.contains("addbtn")) return; pickSuggest(el); };
    el.querySelector(".addbtn").onclick = (e)=>{ e.stopPropagation(); addSymbolToWatch(el.dataset.sym, el.dataset.name, el.dataset.type); suggest.style.display="none"; q.value=""; kbIndex=-1; };
  });
}
function highlightSuggest(){ $$(".item", suggest).forEach((el,i)=> el.classList.toggle("active", i===kbIndex)); }
function pickSuggest(el){ addSymbolToWatch(el.dataset.sym, el.dataset.name, el.dataset.type); suggest.style.display="none"; q.value=""; kbIndex=-1; }

q?.addEventListener("input", ()=>{
  const val=q.value.trim();
  if (debounceT) clearTimeout(debounceT);
  debounceT=setTimeout(async ()=>{
    if (searchAbort) searchAbort.abort();
    if (!val){ suggest.style.display="none"; suggest.innerHTML=""; return; }
    const P = Providers[provider]; if (!P) return;
    try{
      searchAbort = new AbortController();
      const list = await P.search(val, { signal: searchAbort.signal });
      kbIndex=0; renderSuggest(list);
    }catch(e){ if (e.name!=="AbortError"){ console.error("Search failed:",e); renderSuggest([]); } }
  }, 200);
});
q?.addEventListener("keydown",(e)=>{
  if (suggest.style.display!=="block") return;
  const items=$$(".item",suggest); if (!items.length) return;
  if (e.key==="ArrowDown"){ e.preventDefault(); kbIndex=(kbIndex+1)%items.length; highlightSuggest(); }
  else if (e.key==="ArrowUp"){ e.preventDefault(); kbIndex=(kbIndex-1+items.length)%items.length; highlightSuggest(); }
  else if (e.key==="Enter"){ e.preventDefault(); pickSuggest(items[Math.max(0,kbIndex)]); }
  else if (e.key==="Escape"){ suggest.style.display="none"; kbIndex=-1; }
});
document.addEventListener("click",(e)=>{ if (!suggest.contains(e.target) && e.target!==q){ suggest.style.display="none"; kbIndex=-1; } });

// ===================== Controls =====================
btnEUR?.addEventListener("click", ()=>{ preferEUR=!preferEUR; localStorage.setItem(LS.EUR, JSON.stringify(preferEUR)); if (eurLabel) eurLabel.textContent = preferEUR ? "EUR" : "USD"; render(); });
btnToggleView?.addEventListener("click", ()=>{ viewMode = viewMode==="grid" ? "list" : "grid"; localStorage.setItem(LS.VIEW, viewMode); render(); });
btnSettings?.addEventListener("click", ()=>{
  if (!settingsDlg) return;
  if (ddProvider) ddProvider.value = provider;
  if (inKey) inKey.value = apiKey;
  try { settingsDlg.showModal(); } catch { settingsDlg.show(); }
});
$("#saveSettings")?.addEventListener("click",(e)=>{
  e.preventDefault();
  const oldKey = apiKey, oldProv = provider;
  if (ddProvider) provider = ddProvider.value;
  if (inKey) apiKey = inKey.value.trim();
  localStorage.setItem(LS.PROV, provider);
  localStorage.setItem(LS.KEY, apiKey);
  toast(`Saved provider: ${Providers[provider].name}`);

  // WS neu verbinden falls Key gewechselt wurde
  if (oldKey !== apiKey){
    try { ws?.close(); } catch {}
    ws = null;
    ensureWS();
  }
  settingsDlg?.close();
  if (watch.length) refreshAll();
});

// ===================== WS live =====================
function wsSubscribeAll(){
  if (!ws || ws.readyState!==WebSocket.OPEN) return;
  for (const w of watch){ try{ ws.send(JSON.stringify({type:"subscribe", symbol:w.symbol})); }catch{} }
}
function ensureWS(){
  // nur für Finnhub sinnvoll
  if (provider!=="finnhub") return;
  if (ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)) return;
  try{ ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`); }catch{ return; }

  ws.onopen = ()=> wsSubscribeAll();
  ws.onmessage = (ev)=>{
    try{
      const msg = JSON.parse(ev.data);
      if (msg.type!=="trade" || !Array.isArray(msg.data)) return;
      const lastBySym = {};
      for (const t of msg.data){ lastBySym[t.s] = { p:t.p, t:t.t }; }

      for (const [sym,{p,t}] of Object.entries(lastBySym)){
        const d = data[sym]; if (!d) continue;
        d.last = p; d.t = t;

        const refs = domIndex.get(sym);
        if (refs){
          const showInEUR = preferEUR && (d.ccy||"USD")==="USD";
          const disp = showInEUR ? p*usdEur : p;
          const pct = d.prevClose ? ((p-d.prevClose)/d.prevClose*100) : null;

          if (refs.priceEl) refs.priceEl.textContent = formatCCY(showInEUR?"EUR":d.ccy, disp, showInEUR);
          if (refs.deltaEl){
            refs.deltaEl.textContent = pct!=null ? `${pct>0?"+":""}${round(pct,2)}%` : "";
            refs.deltaEl.classList.toggle("up", pct>0);
            refs.deltaEl.classList.toggle("down", pct<0);
          }
          if (refs.chart){
            const ch=refs.chart, L=ch.data.labels.length, lastL=L?ch.data.labels[L-1]:null, ts=new Date(t);
            const pushNew = !lastL || (ts-lastL>60*1000);
            const val = showInEUR ? p*usdEur : p;
            if (pushNew){
              ch.data.labels.push(ts);
              ch.data.datasets[0].data.push(val);
              if (ch.data.labels.length>180){ ch.data.labels.shift(); ch.data.datasets[0].data.shift(); }
            }else{
              ch.data.labels[L-1] = ts;
              ch.data.datasets[0].data[ch.data.datasets[0].data.length-1] = val;
            }
            ch.update("none");
          }
        }
      }
    }catch{}
  };
  ws.onclose = ws.onerror = ()=>{ if (wsReconnectT) clearTimeout(wsReconnectT); wsReconnectT=setTimeout(()=>ensureWS(), 3000); };
}

// ===================== Boot =====================
async function boot(){
  if (eurLabel) eurLabel.textContent = preferEUR ? "EUR" : "USD";
  if (board) board.className = `board ${viewMode}`;

  if (!watch.length){
    watch = [
      {symbol:"AAPL", name:"Apple Inc.", type:"stock"},
      {symbol:"BINANCE:BTCUSDT", name:"Bitcoin", type:"crypto"},
      {symbol: provider==="twelvedata" ? "XAU/USD" : "OANDA:XAU_USD", name:"Gold Spot", type:"forex"},
      {symbol:"MSFT", name:"Microsoft", type:"stock"},
    ];
    localStorage.setItem(LS.WATCH, JSON.stringify(watch));
  }

  window.lucide?.createIcons?.();
  await refreshAll();
  ensureWS();

  setInterval(async ()=>{
    if (Date.now()<backoffUntil) return;
    try{ await refreshAll(); }
    catch(e){ const msg = (e?.message||""); if (msg.includes("429")){ backoffUntil=Date.now()+60_000; toast("Rate limited — pausing updates for 60s"); } }
  }, REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", boot);