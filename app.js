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

let data = {};          // sym -> { last, prevClose, t, ccy, history:[{t, p}] }
let usdEur = 0.9;       // live-updated below
const REFRESH_MS = 30_000;
let dynamicRefresh = REFRESH_MS;
let backoffUntil = 0;

async function fetchJSON(url, opts = {}){
  const r = await fetch(url, {
    ...opts,
    cache: "no-store",
    headers: { "accept": "application/json", ...(opts.headers||{}) }
  });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok){
    const txt = await r.text().catch(()=> "");
    // If we got HTML back, surface a readable hint
    if (ct.includes("text/html") || txt.startsWith("<")) {
      throw new Error(`HTTP ${r.status} (HTML)`);
    }
    // Try to include JSON error
    try { const j = JSON.parse(txt); throw new Error(j.error || j.message || `HTTP ${r.status}`); }
    catch { throw new Error(`HTTP ${r.status}`); }
  }
  // Non-JSON body (rare)
  if (!ct.includes("application/json")) {
    const txt = await r.text().catch(()=> "");
    if (txt.startsWith("<")) throw new Error("HTML response");
    try { return JSON.parse(txt); } catch { throw new Error("Bad JSON"); }
  }
  return r.json();
}
function cryptoFallback(sym){
  // COINBASE:BTC-USD -> BINANCE:BTCUSDT
  const m = sym.match(/^([A-Z0-9_]+):([A-Z0-9-]+)$/i);
  if (!m) return null;
  const ex = m[1].toUpperCase(), pair = m[2].toUpperCase();
  if (ex === "COINBASE" && pair === "BTC-USD") return "BINANCE:BTCUSDT";
  if (ex === "COINBASE" && pair === "ETH-USD") return "BINANCE:ETHUSDT";
  return null;
}
// basic retry with backoff for transient errors (429/5xx/HTML)
async function withRetry(fn, {tries=3, delays=[250, 600, 1200]} = {}){
  let lastErr;
  for (let i=0; i<tries; i++){
    try { return await fn(); } 
    catch (e){
      lastErr = e;
      // don’t retry AbortError
      if (e?.name === "AbortError") throw e;
      if (i < tries-1) await new Promise(r=>setTimeout(r, delays[i] || 800));
    }
  }
  throw lastErr;
}
// ===================== Providers =====================
/** Provider interface: { search(q, {signal}), quote(sym), history(sym) } */
const Providers = {
  // -------- TWELVE DATA --------
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
      if (/^xau/i.test(q) || /gold/i.test(q)) {
        list.unshift({symbol:"XAU/USD", name:"Gold Spot", type:"forex", display:"XAU/USD — Gold Spot"});
      }
      return dedupeBy(list, i=>i.symbol);
    },
    async quote(sym){
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${apiKey}`;
      const r = await fetch(url); const j = await r.json();
      if (j.status==="error") throw new Error(j.message||"TD error");
      return { last:+j.price, prevClose:+j.previous_close, t: Date.parse(j.datetime||Date.now()), ccy:(j.currency||"USD").toUpperCase() };
    },
    async history(sym, interval="15min", points=200){
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${points}&order=ASC&apikey=${apiKey}`;
      const r = await fetch(url); const j = await r.json();
      if (j.status==="error") throw new Error(j.message||"TD error");
      const arr = (j.values||j.data||[]).map(d=>({ t: Date.parse(d.datetime), p: +d.close }));
      return arr.sort((a,b)=>a.t-b.t);
    }
  },

  // -------- FINNHUB --------
  finnhub: {
    name: "Finnhub",

    async search(q, opts = {}){
      if (!apiKey || !q) return [];
      const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${apiKey}`;
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();

      const items = (j.result || [])
        .filter(x => x.symbol && (x.description || "").length)
        .map(x => {
          const type = (x.type || "").toLowerCase();
          return {
            symbol: x.symbol,
            name: x.description,
            type: type.includes("forex") ? "forex"
               : type.includes("crypto") ? "crypto"
               : type.includes("etf")   ? "etf"   : "stock",
            display: `${x.symbol} — ${x.description}`
          };
        });

      if (/^xau/i.test(q) || /gold/i.test(q)) {
        items.unshift({ symbol:"OANDA:XAU_USD", name:"Gold Spot", type:"forex", display:"OANDA:XAU_USD — Gold Spot" });
      }

      const Q = q.toUpperCase();
      items.sort((a,b)=>{
        const aS=a.symbol.toUpperCase(), bS=b.symbol.toUpperCase();
        const score = S => S===Q ? 0 : S.startsWith(Q) ? 1 : S.includes(Q) ? 2 : 3;
        return score(aS)-score(bS);
      });

      const seen=new Set(), out=[];
      for (const it of items){ if(!seen.has(it.symbol)){ seen.add(it.symbol); out.push(it); } if(out.length>=10) break; }
      return out;
    },

    async quote(sym){
        const isFx = sym.startsWith("OANDA:");
        const isCrypto = !isFx && sym.includes(":");

        if (isFx){
            const url = `https://finnhub.io/api/v1/forex/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`;
            const j = await withRetry(()=> fetchJSON(url));
            const last = +(j.c ?? j.ask ?? j.bid);
            const prev = +(j.pc ?? last);
            return { last, prevClose: prev, t: Date.now(), ccy: "USD" };
        }

        if (isCrypto){
            // derive last from latest candle; try fallback exchange if no_data
            const to = Math.floor(Date.now()/1000);
            const from = to - 60*60*24; // last 24h
            const doFetch = (symbol)=>
            fetchJSON(`https://finnhub.io/api/v1/crypto/candle?symbol=${encodeURIComponent(symbol)}&resolution=1&from=${from}&to=${to}&token=${apiKey}`);
            let j = await withRetry(()=> doFetch(sym));
            if (j.s !== "ok" || !j.c?.length){
            const alt = cryptoFallback(sym);
            if (alt){
                j = await withRetry(()=> doFetch(alt));
                if (j.s !== "ok" || !j.c?.length) throw new Error("No crypto data");
            }else{
                throw new Error("No crypto data");
            }
            }
            const n = j.c.length;
            const last = +j.c[n-1];
            const prev = n>1 ? +j.c[n-2] : last;
            const t = (j.t?.[n-1] ?? to)*1000;
            return { last, prevClose: prev, t, ccy: "USD" };
        }

        // stocks/ETFs
        const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`;
        const j = await withRetry(()=> fetchJSON(url));
        const last = +((j.c ?? j.price) || j.ask || j.bid);
        const prev = +(j.pc ?? j.prevClose ?? last);
        const t = (j.t ? j.t*1000 : Date.now());
        return { last, prevClose: prev, t, ccy:"USD" };
        },

    async history(sym, resolution="15"){
        const to = Math.floor(Date.now()/1000);
        const from = to - 60*60*24*14;
        const isFx = sym.startsWith("OANDA:");
        const isCrypto = !isFx && sym.includes(":");

        const fetchCandle = (symbol, base)=>
            fetchJSON(`https://finnhub.io/api/v1/${base}?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${apiKey}`);

        if (isFx){
            const j = await withRetry(()=> fetchCandle(sym, "forex/candle"));
            if (j.s!=="ok") return [];
            return j.t.map((t,i)=>({ t: t*1000, p: j.c[i] }));
        }

        if (isCrypto){
            let j = await withRetry(()=> fetchCandle(sym, "crypto/candle"));
            if (j.s!=="ok" || !j.c?.length){
            const alt = cryptoFallback(sym);
            if (alt){
                j = await withRetry(()=> fetchCandle(alt, "crypto/candle"));
            }
            }
            if (j.s!=="ok") return [];
            return j.t.map((t,i)=>({ t: t*1000, p: j.c[i] }));
        }

        // stocks
        const j = await withRetry(()=> fetchCandle(sym, "stock/candle"));
        if (j.s!=="ok") return [];
        return j.t.map((t,i)=>({ t: t*1000, p: j.c[i] }));
    }
  }
};

// ===================== DOM elements =====================
const q = $("#q");
const suggest = $("#suggest");
const board = $("#board");
const eurLabel = $("#eurLabel");
const btnEUR = $("#btnEUR");
const btnToggleView = $("#btnToggleView");
const btnSettings = $("#btnSettings");
const settingsDlg = $("#settingsDlg");
const ddProvider = $("#provider");
const inKey = $("#apiKey");

// ===================== Helpers =====================
function toast(msg, type="info", timeout=4200){
  const el = document.createElement('div'); el.className = 'card';
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(()=> el.remove(), timeout);
}
function dedupeBy(arr, keyFn){ const s=new Set(); return arr.filter(x=>{ const k=keyFn(x); if(s.has(k))return false; s.add(k); return true; }); }
function fmtTimeShort(t){
  try { return new Intl.DateTimeFormat([], {hour:'2-digit', minute:'2-digit'}).format(t); } catch(e){ return new Date(t).toLocaleTimeString(); }
}
async function fetchUsdEur(){
  try{
    const r = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=EUR");
    const j = await r.json();
    if (j && j.rates && j.rates.EUR) usdEur = j.rates.EUR;
  }catch(e){}
}

// ===================== UI rendering =====================
function render(){
  board.className = `board ${viewMode}`;
  board.innerHTML = "";
  watch.forEach(sym=>{
    const d = data[sym.symbol] || {};
    const change = d.last!=null && d.prevClose!=null ? d.last - d.prevClose : null;
    const pct = change!=null && d.prevClose ? (change/d.prevClose*100) : null;
    const showInEUR = preferEUR && (d.ccy||"USD") === "USD";
    const lastDisp = d.last!=null ? (showInEUR ? d.last*usdEur : d.last) : null;

    const tile = document.createElement("div");
    tile.className = "tile card";
    tile.innerHTML = `
      <div class="tile__head">
        <span class="tag">${sym.symbol}</span>
        <span class="name">${sym.name || ""}</span>
        <span class="grow"></span>
        <span class="price">${lastDisp!=null ? (showInEUR ? "€" : (d.ccy||"")) + " " + round(lastDisp, 4) : "—"}</span>
        <span class="delta ${pct>0?"up":pct<0?"down":""}">${pct!=null ? (pct>0?"+":"") + round(pct,2) + "%" : ""}</span>
        <div class="actions">
          <button class="iconbtn" title="Remove"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
      <div class="meta" style="color:var(--muted);font-size:12px;margin-top:4px">
        <span>${sym.type||""}</span> • <span>${d.t? "Updated " + fmtTimeShort(d.t): "—"}</span>
      </div>
      <div class="chartWrap"><canvas></canvas></div>
    `;
    const delBtn = tile.querySelector(".iconbtn");
    if (delBtn) {
      delBtn.onclick = ()=>{
        watch = watch.filter(x=>x.symbol!==sym.symbol);
        localStorage.setItem(LS.WATCH, JSON.stringify(watch));
        render();
      };
    }
    board.appendChild(tile);

    // icons
    if (window.lucide?.createIcons) lucide.createIcons({attrs:{}});

    // chart
    const ctx = tile.querySelector("canvas").getContext("2d");
    const hist = (d.history||[]).slice(-120);
    if (hist.length){
      const prices = hist.map(p=>{
        if (preferEUR && (d.ccy||"USD")==="USD") return p.p*usdEur;
        return p.p;
      });
      new Chart(ctx, {
        type: 'line',
        data: { labels: hist.map(p=>new Date(p.t)), datasets: [{ data: prices, tension:.25, pointRadius:0 }]},
        options: {
          responsive:true, maintainAspectRatio:false,
          scales:{ x:{ display:false }, y:{ display:false } },
          plugins:{ legend:{ display:false }, tooltip:{ enabled:true } }
        }
      });
    }
  });
}

// ===================== Fetch loop =====================
async function updateOne(sym){
  const P = Providers[provider];
  if (!P) return;
  try{
    const [q, h] = await Promise.all([ P.quote(sym.symbol), P.history(sym.symbol) ]);
    data[sym.symbol] = {...q, history: h};
  }catch(e){
    toast(`Failed: ${sym.symbol} (${e.message||e})`);
  }
}
async function refreshAll(){
  await fetchUsdEur();
  await Promise.all(watch.map(updateOne));
  render();
}

// ===================== Search (with suggestions) =====================
let searchAbort = null;
let kbIndex = -1;
let debounceT = null;

function inferMarket(symbol){
  if (symbol.includes(":")) {
    const [ex] = symbol.split(":");
    return ex; // e.g. COINBASE, BINANCE, OANDA
  }
  if (/\.(SZ|SS)/i.test(symbol)) return symbol.endsWith(".SZ") ? "SZSE" : "SSE";
  if (/\.HK$/i.test(symbol)) return "HKEX";
  if (/\.L$/i.test(symbol))  return "LSE";
  if (/\.TO$/i.test(symbol)) return "TSX";
  // fallback US
  return "US";
}

function addSymbolToWatch(symbol, name="", type=""){
  if (!watch.find(w=>w.symbol===symbol)){
    watch.unshift({symbol, name, type});
    localStorage.setItem(LS.WATCH, JSON.stringify(watch));
    refreshAll();
  }
}
function renderSuggest(list){
  if (!list.length){
    suggest.style.display="none"; suggest.innerHTML=""; kbIndex=-1; return;
  }

  suggest.innerHTML = list.map((item,i)=>{
    return `
      <div class="item${i===kbIndex?' active':''}"
           data-sym="${item.symbol}"
           data-name="${item.name||""}"
           data-type="${item.type||""}">
        <div class="left">
          <div class="sym">${item.symbol}</div>
          <div class="name">${item.name||""}</div>
          <div class="meta">${item.type}</div>
        </div>
        <button class="addbtn">Add</button>
      </div>`;
  }).join("");

  suggest.style.display="block";

  $$(".item", suggest).forEach((el,i)=>{
    el.onmouseenter = ()=>{ kbIndex=i; highlightSuggest(); };

    // click anywhere (except button) picks
    el.onclick = (e)=>{
      if (e.target.classList.contains("addbtn")) return;
      pickSuggest(el);
    };

    // button click
    el.querySelector(".addbtn").onclick = (e)=>{
      e.stopPropagation();
      addSymbolToWatch(el.dataset.sym, el.dataset.name, el.dataset.type);
      suggest.style.display="none"; q.value=""; kbIndex=-1;
    };
  });
}
function highlightSuggest(){ $$(".item", suggest).forEach((el,i)=> el.classList.toggle("active", i===kbIndex)); }
function pickSuggest(el){
  const symbol = el.dataset.sym;
  const name = el.dataset.name;
  const type = el.dataset.type;
  addSymbolToWatch(symbol, name, type);
  suggest.style.display="none"; q.value=""; kbIndex=-1;
}

q?.addEventListener("input", ()=>{
  const val = q.value.trim();
  if (debounceT) clearTimeout(debounceT);
  debounceT = setTimeout(async ()=>{
    if (searchAbort) searchAbort.abort();
    if (!val){ suggest.style.display="none"; suggest.innerHTML=""; return; }
    const P = Providers[provider]; if (!P) return;

    try{
      searchAbort = new AbortController();
      const list = await P.search(val, { signal: searchAbort.signal });
      kbIndex = 0;
      renderSuggest(list, `No matches for "${val}"`);
    }catch(e){
      if (e.name === 'AbortError') return;
      console.error('Search failed:', e);
      renderSuggest([], `Search error: ${e.message || e}`);
    }
  }, 200);
});

q?.addEventListener("keydown", (e)=>{
  if (suggest.style.display!=="block") return;
  const items = $$(".item", suggest);
  if (!items.length) return;
  if (e.key==="ArrowDown"){ e.preventDefault(); kbIndex = (kbIndex+1) % items.length; highlightSuggest(); }
  else if (e.key==="ArrowUp"){ e.preventDefault(); kbIndex = (kbIndex-1+items.length) % items.length; highlightSuggest(); }
  else if (e.key==="Enter"){ e.preventDefault(); pickSuggest(items[Math.max(0,kbIndex)]); }
  else if (e.key==="Escape"){ suggest.style.display="none"; kbIndex=-1; }
});

document.addEventListener("click",(e)=>{
  if (!suggest.contains(e.target) && e.target!==q) { suggest.style.display="none"; kbIndex=-1; }
});

// ===================== Controls =====================
btnEUR?.addEventListener('click', ()=>{
  preferEUR = !preferEUR;
  localStorage.setItem(LS.EUR, JSON.stringify(preferEUR));
  if (eurLabel) eurLabel.textContent = preferEUR ? "EUR" : "USD";
  render();
});

btnToggleView?.addEventListener('click', ()=>{
  viewMode = viewMode==="grid" ? "list" : "grid";
  localStorage.setItem(LS.VIEW, viewMode);
  render();
});

btnSettings?.addEventListener('click', ()=>{
  if (!settingsDlg) return;
  if (ddProvider) ddProvider.value = provider;
  if (inKey) inKey.value = apiKey;
  try { settingsDlg.showModal(); } catch { settingsDlg.show(); }
});

$("#saveSettings")?.addEventListener('click', (e)=>{
  e.preventDefault();
  if (ddProvider) provider = ddProvider.value;
  if (inKey) apiKey = inKey.value.trim();
  localStorage.setItem(LS.PROV, provider);
  localStorage.setItem(LS.KEY, apiKey);
  toast(`Saved provider: ${Providers[provider].name}`);
  settingsDlg?.close();
  if (watch.length) refreshAll();
});

// ===================== Boot =====================
document.addEventListener("DOMContentLoaded", async ()=>{
  if (eurLabel) eurLabel.textContent = preferEUR ? "EUR" : "USD";
  if (board) board.className = `board ${viewMode}`;

  // first-run demo
  if (!watch.length){
    watch = [
      {symbol: "AAPL", name: "Apple Inc.", type:"stock"},
      {symbol: "COINBASE:BTC-USD", name:"Bitcoin", type:"crypto"},
      {symbol: provider==="twelvedata" ? "XAU/USD" : "OANDA:XAU_USD", name:"Gold Spot", type:"forex"},
      {symbol: "MSFT", name:"Microsoft", type:"stock"},
    ];
    localStorage.setItem(LS.WATCH, JSON.stringify(watch));
  }

  // hydrate icons once
  if (window.lucide?.createIcons) lucide.createIcons();

  await refreshAll();
  setInterval(refreshAll, REFRESH_MS);
});
