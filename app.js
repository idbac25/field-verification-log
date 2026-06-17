"use strict";
/* Field Verification Log — offline evidence capture. IndexedDB source of truth; photos as Blobs; one-tap jsPDF. */
(function () {
  const NOW = new Date().getFullYear();
  const SCHEMA_VERSION = 1;
  const CONF = ["", "Done, proper", "Done, improper", "Not done", "N/A"];
  const YN = ["", "Yes", "No", "Unsure"];
  const COND = ["", "Good", "Fair", "Poor", "Critical"];
  const PRES = ["", "Absent", "Present"];
  const TYPEMETA = {
    borehole: { n: "Borehole / well", b: "b-borehole", ic: "🛢️" },
    reservoir: { n: "Reservoir / tank", b: "b-reservoir", ic: "🛜" },
    genset: { n: "Engine & generator", b: "b-genset", ic: "⚙️" },
    grid: { n: "Electricity grid", b: "b-grid", ic: "☀️" },
    other: { n: "Other asset", b: "b-other", ic: "➕" },
  };

  // ---- field helpers ----
  const num = (k, l, o = {}) => Object.assign({ k, l, t: "num" }, o);
  const txt = (k, l, o = {}) => Object.assign({ k, l, t: "text" }, o);
  const area = (k, l, o = {}) => Object.assign({ k, l, t: "area" }, o);
  const sel = (k, l, opts, o = {}) => Object.assign({ k, l, t: "sel", o: opts }, o);
  const calc = (k, l, fn, o = {}) => Object.assign({ k, l, t: "calc", fn }, o);
  const head = (l) => ({ t: "head", l });
  const N = (d, k) => { const v = parseFloat(d[k]); return isNaN(v) ? null : v; };
  const r = (x, n = 2) => x == null ? "—" : (Math.round(x * Math.pow(10, n)) / Math.pow(10, n)).toLocaleString();

  const IDENT = [
    txt("assetId", "Asset ID / tag", { hint: "e.g. BH-07, TANK-3, GEN-2" }),
    txt("assetName", "Name / description"),
    txt("location", "Location / area"),
    txt("gps", "GPS or what3words", { hint: "optional" }),
    { k: "dateEval", l: "Date of evaluation", t: "date" },
    txt("observer", "Observer (you)"),
    txt("engCompany", "Engineering company"),
    txt("engineers", "Engineers present"),
    sel("resultsShared", "Did they share results with you?", ["", "Yes, fully", "Partly", "No", "Promised later"]),
    area("equipPresent", "Equipment they brought / used", { hint: "list what you saw on site" }),
  ];
  const ECON = [
    head("Economic condition (depreciation & remaining value)"),
    num("builtYear", "Year built / commissioned"),
    num("designLife", "Design / economic life (years)", { hint: "borehole ~25-30, steel tank ~30-50, concrete tank ~50-80, fiberglass ~25, solar panels ~25, transformer ~30-40, genset ~15-25" }),
    calc("age", "Age now (years)", d => { const b = N(d, "builtYear"); return b ? r(NOW - b, 0) : "—"; }),
    num("conditionScore", "Condition score (0-100)", { hint: "your overall judgement; 100 = as new" }),
    num("deteriorationPct", "Deterioration (%)", { hint: "estimated loss of condition; or 100 minus the condition score" }),
    num("rcn", "Replacement cost new (USD)", { hint: "cost to build/buy the same asset today" }),
    txt("rcnBasis", "Basis / source of that cost", { hint: "optional" }),
    calc("rul", "Remaining useful life (years)", d => { const b = N(d, "builtYear"), li = N(d, "designLife"); if (!li || !b) return "—"; return r(Math.max(0, li - (NOW - b)), 0); }),
    calc("depAge", "Depreciation by age (%)", d => { const b = N(d, "builtYear"), li = N(d, "designLife"); if (!b || !li) return "—"; return r(Math.min(100, (NOW - b) / li * 100), 0) + "%"; }),
    calc("dvAge", "Depreciated value, straight-line (USD)", d => { const b = N(d, "builtYear"), li = N(d, "designLife"), c = N(d, "rcn"); if (!b || !li || c == null) return "—"; return "$" + r(c * (1 - Math.min(1, (NOW - b) / li)), 0); }),
    calc("dvDet", "Depreciated value, by deterioration (USD)", d => { const c = N(d, "rcn"), dt = N(d, "deteriorationPct"); if (c == null || dt == null) return "—"; return "$" + r(c * (1 - dt / 100), 0); }),
    calc("drc", "Depreciated replacement cost, condition-weighted (USD)", d => { const b = N(d, "builtYear"), li = N(d, "designLife"), c = N(d, "rcn"), cs = N(d, "conditionScore"); if (!b || !li || c == null || cs == null) return "—"; return "$" + r(c * (Math.max(0, li - (NOW - b)) / li) * (cs / 100), 0); }),
    num("omCost", "Annual O&M cost (USD/yr)"),
    num("energyCost", "Annual energy cost (USD/yr)", { hint: "pumping / running power" }),
    num("backlog", "Repair backlog to fix defects (USD)"),
    sel("funcAdequacy", "Meets current demand / duty?", ["", "Surplus", "Meets", "Marginal", "Deficit"]),
    area("econNotes", "Economic notes"),
  ];
  const SUMMARY = [
    head("Observer summary"),
    sel("procConform", "Did the procedure follow good practice overall?", ["", "Yes, conforms", "Partly", "No, non-conforming"]),
    area("redflagNotes", "Red flags / shortcomings observed"),
    area("summary", "Overall observer notes", { hint: "tap your keyboard microphone to dictate" }),
  ];

  const TYPES = {
    borehole: { ident: [txt("depth", "Drilled depth (m)"), txt("casing", "Casing material & diameter"), sel("pumpType", "Pump type", ["", "Submersible", "Lineshaft / vertical turbine", "Surface"]), sel("power", "Power", ["", "Grid", "Diesel", "Solar", "Mixed"])],
      secs: [
        { t: "A — Structural integrity", f: [area("structMethod", "Method used", { hint: "CCTV / caliper / visual wellhead / dummy-sounder" }), sel("cctv", "CCTV camera survey", CONF), sel("caliper", "Caliper / diameter check", CONF), sel("seal", "Sanitary seal & headworks", COND), sel("sand", "Sand in pumped water", ["", "None", "Trace", "Noticeable", "Heavy"]), num("accessDepth", "Accessible depth (m)"), area("structNotes", "Structural notes")] },
        { t: "B — Yield & hydraulic", f: [area("yieldMethod", "Method", { hint: "step / constant-rate / recovery / barrel & stopwatch / air-lift only" }), num("barrelVol", "Barrel / container volume (L)", { hint: "a drum is ~200 L; an oil barrel ~159 L" }), num("fillTime", "Time to fill it (seconds)"), calc("flowLs", "Yield", d => { const v = N(d, "barrelVol"), t = N(d, "fillTime"); return (v && t) ? r(v / t) + " L/s" : "—"; }), calc("flowM3d", "Yield", d => { const v = N(d, "barrelVol"), t = N(d, "fillTime"); return (v && t) ? r(v / t * 86.4, 0) + " m³/day" : "—"; }), num("staticLevel", "Static water level (m)"), num("pumpLevel", "Pumping water level (m)"), calc("drawdown", "Drawdown", d => { const s = N(d, "staticLevel"), p = N(d, "pumpLevel"); return (s != null && p != null) ? r(p - s) + " m" : "—"; }), calc("specCap", "Specific capacity", d => { const v = N(d, "barrelVol"), t = N(d, "fillTime"), s = N(d, "staticLevel"), p = N(d, "pumpLevel"); if (!(v && t) || s == null || p == null || (p - s) <= 0) return "—"; return r((v / t) / (p - s)) + " L/s per m"; }), num("constRateH", "Constant-rate duration (h)"), sel("recovery", "Recovery measured?", YN), num("sustainableYield", "Stated sustainable yield (m³/day)"), area("yieldNotes", "Yield notes")] },
        { t: "C — Water quality", f: [area("qualMethod", "Method / equipment", { hint: "field meters / kit / lab" }), sel("coc", "Sampling & chain-of-custody", CONF), num("ec", "Electrical conductivity (µS/cm)"), sel("coastal", "Coastal / seawater-affected?", YN), calc("tds", "Estimated TDS", d => { const e = N(d, "ec"); if (e == null) return "—"; return r(e * (d.coastal === "Yes" ? 0.75 : 0.64), 0) + " mg/L"; }), num("ph", "pH"), num("turbidity", "Turbidity (NTU)"), num("chloride", "Chloride (mg/L)"), num("sodium", "Sodium (mg/L)"), num("sulfate", "Sulfate (mg/L)"), num("nitrate", "Nitrate (mg/L)"), num("fluoride", "Fluoride (mg/L)"), num("arsenic", "Arsenic (mg/L)"), sel("ecoli", "E. coli", PRES), num("samples", "Number of samples"), area("qualNotes", "Quality notes")] },
        { t: "D — Sustainability & salinity trend", f: [sel("levelHistory", "Water-level history available?", YN), sel("levelTrend", "Water-level trend", ["", "Stable / rising", "Slight decline", "Moderate decline", "Steep decline"]), sel("salTrend", "Salinity / EC trend", ["", "Stable", "Slow rise", "Rapid rise", "Unknown"]), sel("interference", "Interference with nearby wells?", YN), area("sustNotes", "Sustainability notes")] },
      ] },
    reservoir: { ident: [sel("tankPos", "Position", ["", "Elevated (on a tower)", "Ground level", "Partly buried"]), sel("material", "Structure material", ["", "Concrete", "Steel (welded)", "Steel (bolted)", "Fiberglass tank on steel frame"]), sel("shape", "Shape", ["", "Vertical cylinder", "Horizontal cylinder", "Rectangular"]), num("diameter", "Diameter (m)"), num("length", "Length (m)"), num("widthM", "Width (m)"), num("waterDepth", "Water depth (m)"), calc("volume", "Computed volume", d => { const di = N(d, "diameter"), le = N(d, "length"), w = N(d, "widthM"), h = N(d, "waterDepth"); let v = null; if (d.shape === "Vertical cylinder" && di && h) v = Math.PI * (di / 2) ** 2 * h; else if (d.shape === "Horizontal cylinder" && di && le) v = Math.PI * (di / 2) ** 2 * le; else if (d.shape === "Rectangular" && le && w && h) v = le * w * h; return v == null ? "—" : r(v, 1) + " m³"; }), num("ratedCap", "Rated capacity (m³)"), num("freeboard", "Freeboard (m)")],
      secs: [
        { t: "A — Structural integrity", f: [head("Steel / fiberglass shell"), num("utAsBuilt", "Steel as-built thickness (mm)"), num("utMeasured", "Steel measured thickness (mm)"), calc("wallLoss", "Wall loss", d => { const a = N(d, "utAsBuilt"), m = N(d, "utMeasured"); return (a && m != null) ? r((a - m) / a * 100, 0) + "%" : "—"; }), num("dft", "Coating DFT (µm)"), sel("coating", "Coating / lining condition", COND), sel("weld", "Weld / seam condition", COND), sel("fiberglass", "Fiberglass tank condition", COND), head("Concrete shell"), sel("cracking", "Cracking", ["", "None", "Minor", "Significant", "Severe"]), sel("spalling", "Spalling", ["", "None", "Minor", "Significant", "Severe"]), num("halfCell", "Half-cell potential (-mV, CSE)", { hint: "more negative than 350 = high risk" }), num("carbonation", "Carbonation depth (mm)"), num("cover", "Cover to rebar (mm)"), sel("sounding", "Sounding / delamination", ["", "Sound", "Some hollow", "Widespread hollow"]), head("Frame / tower & foundation"), txt("frameMat", "Frame material"), sel("columns", "Columns / legs condition", COND), sel("bracing", "Bracing condition", COND), sel("footings", "Footing / settlement", ["", "Level", "Minor settlement", "Tilt / major settlement"]), area("structNotes", "Structural notes")] },
        { t: "B — Watertightness", f: [sel("tightnessTest", "Tightness (drop) test done?", YN), num("dropMM", "Level drop in 24 h (mm)"), sel("evapCorr", "Evaporation corrected?", YN), calc("dropPct", "Loss", d => { const dr = N(d, "dropMM"), h = N(d, "waterDepth"); return (dr != null && h) ? r((dr / 1000) / h * 100, 3) + " % per day" : "—"; }), area("leakObs", "Leak observations")] },
        { t: "C — Capacity & hydraulic", f: [num("deadStorage", "Dead storage below outlet (m³)"), num("head", "Head provided (m)"), sel("turnover", "Turnover", ["", "Good (mixes)", "Poor (stagnant zone)", "Unknown"]), area("levelControls", "Level controls / inlet / outlet / overflow"), area("capNotes", "Capacity notes")] },
        { t: "D — Water quality & sanitary", f: [sel("nsf61", "Lining certified potable (NSF 61)?", YN), sel("roof", "Roof condition", COND), sel("hatch", "Access hatch", ["", "Locked & overlapping", "Unlocked", "Damaged / open"]), sel("vent", "Vent screened?", YN), sel("overflowScr", "Overflow screened / air gap?", YN), sel("ponding", "Ponding on roof?", YN), sel("sediment", "Sediment / biofilm inside?", ["", "None", "Some", "Heavy", "Not inspected"]), sel("disinfected", "Disinfection record (C652)?", YN), area("sanNotes", "Quality & sanitary notes")] },
      ] },
    genset: { ident: [txt("make", "Make / model"), sel("duty", "Duty", ["", "Prime", "Standby"]), num("ratedKva", "Rated output (kVA)")],
      secs: [
        { t: "Diesel engine", f: [num("hours", "Running hours (h)"), num("oilPress", "Oil pressure"), num("oilTemp", "Oil temperature (°C)"), num("coolantTemp", "Coolant temperature (°C)"), sel("oilAnalysis", "Oil analysis sample taken?", YN), sel("oilCondE", "Oil condition", COND), sel("coolant", "Coolant condition", COND), sel("exhaust", "Exhaust smoke", ["", "Clear", "Light", "Black / blue / heavy"]), sel("airFilter", "Air filter / fuel system", COND), sel("leaks", "Oil / fuel / coolant leaks?", YN), area("engNotes", "Engine notes (ISO 3046)")] },
        { t: "Alternator (generator end)", f: [num("voltage", "Output voltage (V)"), num("freq", "Frequency (Hz)"), num("pf", "Power factor"), num("genIns", "Insulation resistance (MΩ)", { hint: "min ~1 MΩ; check polarization index" }), num("pi", "Polarization index"), sel("avr", "AVR / governor condition", COND), sel("winding", "Winding condition", COND), area("altNotes", "Alternator notes (IEEE 43 / ISO 8528)")] },
        { t: "Controls & load test", f: [sel("panel", "Control panel working?", YN), sel("loadBank", "Load-bank test done?", YN), num("testLoadPct", "Test load (% of rating)"), sel("vStab", "Voltage stable under load?", YN), sel("fStab", "Frequency stable under load?", YN), num("fuelLh", "Fuel consumption (L/h)"), sel("startTest", "Starts & runs on test?", YN), area("genNotes", "Genset notes (ISO 8528)")] },
      ] },
    grid: { ident: [txt("siteName", "Grid / site name"), sel("scope", "What this record covers", ["", "Whole grid", "Solar array", "Transformer", "Distribution"])],
      secs: [
        { t: "Solar PV array", f: [num("kwp", "Array rated power (kWp)"), num("panelCount", "Number of panels"), txt("panelType", "Panel type / make"), num("measuredKW", "Measured output now (kW)"), num("irradiance", "Irradiance (W/m²)"), calc("pr", "Output vs rated", d => { const m = N(d, "measuredKW"), k = N(d, "kwp"), ir = N(d, "irradiance"); if (m == null || !k) return "—"; if (ir) return r(m / (k * ir / 1000) * 100, 0) + "% performance ratio"; return r(m / k * 100, 0) + "% of rated"; }), num("voc", "String Voc (V)"), num("isc", "String Isc (A)"), num("insRes", "Insulation resistance (MΩ)"), sel("soiling", "Soiling / dust", ["", "Clean", "Light", "Heavy"]), sel("shading", "Shading", YN), sel("mounting", "Mounting condition", COND), txt("inverter", "Inverter make / model"), sel("inverterStatus", "Inverter status", ["", "Normal", "Faults logged", "Offline"]), area("solarNotes", "Solar notes (IEC 62446 / 61724)")] },
        { t: "Transformer(s)", f: [num("txKva", "Rating (kVA)"), txt("txRatio", "Voltage ratio", { hint: "e.g. 11kV / 415V" }), num("txLoad", "Measured load (kVA)"), calc("txLoadPct", "Loading", d => { const l = N(d, "txLoad"), k = N(d, "txKva"); return (l != null && k) ? r(l / k * 100, 0) + "% of rating" : "—"; }), sel("oilLevel", "Oil level", ["", "Normal", "Low"]), sel("oilCond", "Oil condition", COND), num("windTemp", "Winding / oil temp (°C)"), num("txIns", "Insulation resistance (MΩ)"), sel("bushings", "Bushings condition", COND), txt("tap", "Tap position"), sel("dga", "Oil DGA sample taken?", YN), area("txNotes", "Transformer notes (IEC 60076)")] },
        { t: "Distribution, switchgear & earthing", f: [sel("switchgear", "Switchgear / DB condition", COND), sel("cabling", "Cabling / lines condition", COND), num("earthRes", "Earthing resistance (Ω)"), sel("protection", "Protection devices working?", YN), sel("metering", "Metering present?", YN), area("distNotes", "Distribution notes")] },
      ] },
    other: { ident: [txt("category", "What kind of asset is it?")],
      secs: [
        { t: "General condition", f: [sel("cond", "Overall condition", COND), area("genCondNotes", "Notes")] },
        { t: "Measurements & results", f: [area("measurements", "Measurements / results", { hint: "record figures the team showed you" })] },
        { t: "Findings", f: [area("findings", "Findings / observations")] },
      ] },
  };

  function sections(type) {
    const T = TYPES[type];
    const list = [{ id: "ident", t: "Identification & site", f: IDENT.concat(T.ident || []), open: true }];
    T.secs.forEach((s, i) => list.push({ id: type + "-" + i, t: s.t, f: s.f.filter(Boolean) }));
    list.push({ id: "econ", t: "Economic condition", f: ECON });
    list.push({ id: "summary", t: "Summary & sign-off", f: SUMMARY });
    return list;
  }
  function allFields(type) { return sections(type).flatMap(s => s.f).filter(f => f.t !== "head"); }

  // ---- IndexedDB ----
  let db;
  function openDB() {
    return new Promise((res, rej) => {
      const q = indexedDB.open("evalapp", 1);
      q.onupgradeneeded = (e) => { const d = e.target.result; if (!d.objectStoreNames.contains("assets")) d.createObjectStore("assets", { keyPath: "id" }); if (!d.objectStoreNames.contains("photos")) { const ps = d.createObjectStore("photos", { keyPath: "id" }); ps.createIndex("byAsset", "assetId"); } };
      q.onsuccess = (e) => { db = e.target.result; res(); };
      q.onerror = () => rej(q.error);
    });
  }
  const idbPut = (store, obj) => new Promise((res, rej) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(obj); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  const idbGetAll = (store) => new Promise((res, rej) => { const tx = db.transaction(store, "readonly"); const q = tx.objectStore(store).getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
  const idbByAsset = (assetId) => new Promise((res, rej) => { const tx = db.transaction("photos", "readonly"); const q = tx.objectStore("photos").index("byAsset").getAll(assetId); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });

  // ---- state ----
  let state = { assets: [], meta: {} };
  let openId = null, curPhotos = [], urls = [], viewPhotoId = null, saveT = null;
  const isLive = (x) => x && x.syncState !== "deleted";
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const main = document.getElementById("main");
  const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const setSaved = (t, err) => { const el = document.getElementById("saved"); el.textContent = t; el.style.background = err ? "#9b2d20" : "rgba(255,255,255,.18)"; };
  const revokeUrls = () => { urls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} }); urls = []; };
  const objUrl = (blob) => { const u = URL.createObjectURL(blob); urls.push(u); return u; };
  function saveMeta() { try { localStorage.setItem("evalapp:meta", JSON.stringify(state.meta)); } catch (e) {} }
  function mirror() { try { localStorage.setItem("evalapp:assets", JSON.stringify(state.assets.filter(isLive))); } catch (e) {} }
  function touch(a) { a.updatedAt = new Date().toISOString(); a.syncState = "dirty"; }
  function saveAsset(a) { clearTimeout(saveT); saveT = setTimeout(async () => { try { await idbPut("assets", a); mirror(); setSaved("saved ✓"); } catch (e) { setSaved("SAVE FAILED", true); } }, 300); }

  // ---- boot ----
  async function boot() {
    try { await openDB(); } catch (e) { setSaved("DB error", true); }
    try { state.assets = await idbGetAll("assets"); } catch (e) { state.assets = []; }
    try { state.meta = JSON.parse(localStorage.getItem("evalapp:meta") || "{}"); } catch (e) { state.meta = {}; }
    if (!state.meta.deviceId) { state.meta.deviceId = uuid(); saveMeta(); }
    if (!state.assets.length) { try { const m = JSON.parse(localStorage.getItem("evalapp:assets") || "[]"); if (m.length) { state.assets = m; for (const a of m) await idbPut("assets", a); } } catch (e) {} }
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) {} }
    renderHome(); setSaved("saved ✓");
    if ("serviceWorker" in navigator) { navigator.serviceWorker.register("sw.js").catch(() => {}); }
  }

  // ---- views ----
  async function renderHome() {
    openId = null; revokeUrls();
    const m = state.meta;
    let h = `<div class="note">Tap <b>Add asset</b> for each well, tank, generator or grid you observe. Photos and data are saved on this phone automatically; the thumbnail appearing is your proof it saved. Use <b>Backup</b> often. Build the report with <b>Export PDF</b>.</div>`;
    h += `<h2 class="sec">Report cover</h2><div class="card">`;
    h += metaField("site", "Site / project", m.site) + metaField("evaluator", "Evaluator", m.evaluator) + metaField("reportDate", "Report date", m.reportDate, "date") + `</div>`;
    h += `<div class="row"><button class="btn-primary" style="flex:1" data-action="add">+ Add asset</button></div>`;
    const live = state.assets.filter(isLive);
    if (!live.length) h += `<div class="card" style="text-align:center;color:var(--muted)">No assets yet. Add your first one above.</div>`;
    for (const a of live) {
      const tm = TYPEMETA[a.type], d = a.data || {};
      const det = [d.assetId, d.location, d.dateEval].filter(Boolean).join(" · ") || tm.n;
      const pc = (a.photoCount || 0);
      h += `<div class="card asset-card" data-open="${a.id}"><div class="badge ${tm.b}">${tm.ic}</div><div class="meta"><div class="nm">${esc(d.assetId || d.assetName || tm.n)}</div><div class="det">${esc(det)}</div><div class="pc">${pc ? pc + " photo" + (pc > 1 ? "s" : "") : "no photos yet"}</div></div><div class="chev">›</div></div>`;
    }
    h += `<h2 class="sec">Report & data</h2><div class="row"><button class="btn-teal" data-action="pdf">📄 Export full PDF</button><button class="btn-line" data-action="pdfper">📄 PDF per asset</button></div>`;
    h += `<div class="row" style="margin-top:10px"><button class="btn-line btn-sm" data-action="backup">⤓ Backup (.json)</button><button class="btn-line btn-sm" data-action="restore">⤒ Restore</button></div>`;
    h += `<div class="note" id="storeNote">Assets: <b>${live.length}</b>. For an installable app icon: open in Chrome, menu, <b>Install app</b>.</div>`;
    main.innerHTML = h;
    showStorage();
  }
  const metaField = (k, l, v, t) => `<div class="fld"><label>${esc(l)}</label><input type="${t || "text"}" data-meta="${k}" value="${esc(v || "")}"/></div>`;

  async function showStorage() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    try { const e = await navigator.storage.estimate(); const used = (e.usage / 1048576).toFixed(1); const note = document.getElementById("storeNote"); if (note) note.insertAdjacentHTML("beforeend", ` Storage used: ${used} MB.`); } catch (e) {}
  }

  async function openAsset(id) {
    const a = state.assets.find(x => x.id === id); if (!a) return;
    openId = id; a.data = a.data || {}; revokeUrls();
    try { curPhotos = (await idbByAsset(id)).filter(isLive); } catch (e) { curPhotos = []; }
    const tm = TYPEMETA[a.type], secs = sections(a.type);
    let h = `<div class="row"><button class="btn-line btn-sm" data-action="back">‹ All assets</button><div style="flex:1"></div><button class="btn-danger btn-sm" data-action="delasset" data-id="${id}">Delete</button></div>`;
    h += `<h2 class="sec">${tm.ic} ${esc(tm.n)}</h2>`;
    secs.forEach(s => { h += groupHTML(a, s); });
    main.innerHTML = h; window.scrollTo(0, 0);
    secs.forEach(s => renderStrip(s.id));
  }

  function groupHTML(a, s) {
    const d = a.data;
    const body = s.f.map(f => fieldHTML(a, f)).join("");
    const photoUI = `<div class="photos"><div class="photo-strip" id="strip_${s.id}"></div><button class="photo-add" data-addphoto="${s.id}">📷 Add photo to this section</button></div>`;
    return `<details class="grp" ${s.open ? "open" : ""}><summary>${esc(s.t)}<span class="ar">›</span></summary><div class="body">${body}${photoUI}</div></details>`;
  }
  function fieldHTML(a, f) {
    if (f.t === "head") return `<div class="subhead">${esc(f.l)}</div>`;
    const d = a.data, v = d[f.k] == null ? "" : d[f.k], hint = f.hint ? `<span class="hint"> — ${esc(f.hint)}</span>` : "";
    if (f.t === "calc") {
      const auto = f.fn(d), ov = d[f.k], val = (ov != null && ov !== "") ? ov : auto;
      return `<div class="fld"><label>${esc(f.l)} <span class="hint">— auto, editable</span></label><div class="calc"><input class="calcin" data-calc="${f.k}" id="ci_${f.k}" value="${esc(val)}"/><button type="button" class="calcreset" data-recalc="${f.k}" title="reset to the calculated value">↺ auto</button></div><div class="hint" id="cauto_${f.k}">auto: ${esc(auto)}</div></div>`;
    }
    let inp;
    if (f.t === "area") inp = `<textarea data-k="${f.k}">${esc(v)}</textarea>`;
    else if (f.t === "sel") inp = `<select data-k="${f.k}">` + f.o.map(o => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("") + `</select>`;
    else { const ty = f.t === "num" ? "number" : (f.t === "date" ? "date" : "text"); inp = `<input type="${ty}" inputmode="${f.t === "num" ? "decimal" : "text"}" data-k="${f.k}" value="${esc(v)}"/>`; }
    return `<div class="fld"><label>${esc(f.l)}${hint}</label>${inp}</div>`;
  }
  function renderStrip(sectionId) {
    const el = document.getElementById("strip_" + sectionId); if (!el) return;
    const list = curPhotos.filter(p => p.sectionId === sectionId && isLive(p));
    el.innerHTML = list.map(p => `<div class="photo-wrap"><img class="thumb" data-photoview="${p.id}" src="${p.thumb ? objUrl(p.thumb) : ""}" alt="evidence"/></div>`).join("");
  }

  // ---- updates ----
  function onInput(e) {
    const t = e.target;
    if (t.dataset.meta) { state.meta[t.dataset.meta] = t.value; saveMeta(); return; }
    if (t.dataset.calc && openId) {
      const a = state.assets.find(x => x.id === openId); if (!a) return; a.data = a.data || {};
      a.data[t.dataset.calc] = t.value; touch(a); saveAsset(a); return;
    }
    if (t.dataset.k && openId) {
      const a = state.assets.find(x => x.id === openId); if (!a) return; a.data = a.data || {};
      a.data[t.dataset.k] = t.value; touch(a); saveAsset(a);
      allFields(a.type).forEach(f => {
        if (f.t !== "calc") return;
        const auto = f.fn(a.data);
        const hint = document.getElementById("cauto_" + f.k); if (hint) hint.textContent = "auto: " + auto;
        const inp = document.getElementById("ci_" + f.k), ov = a.data[f.k];
        if (inp && (ov == null || ov === "")) inp.value = auto;
      });
    }
  }

  // ---- photos ----
  let pendingTarget = null;
  const fileIn = document.getElementById("fileIn");
  fileIn.addEventListener("change", async () => { const files = Array.from(fileIn.files || []); fileIn.value = ""; if (files.length && pendingTarget) await addPhotos(pendingTarget.assetId, pendingTarget.sectionId, files); });

  async function downscale(file, max, q) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (e) { try { bmp = await createImageBitmap(file); } catch (e2) { bmp = await imgFallback(file); } }
    const w = bmp.width, h = bmp.height, sc = Math.min(1, max / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
    const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch; cv.getContext("2d").drawImage(bmp, 0, 0, cw, ch);
    const blob = await new Promise(res => cv.toBlob(res, "image/jpeg", q));
    if (bmp.close) bmp.close();
    return { blob, w: cw, h: ch };
  }
  function imgFallback(file) { return new Promise((res, rej) => { const u = URL.createObjectURL(file); const im = new Image(); im.onload = () => { res(im); }; im.onerror = rej; im.src = u; }); }

  async function addPhotos(assetId, sectionId, files) {
    const a = state.assets.find(x => x.id === assetId);
    for (const f of files) {
      try {
        const big = await downscale(f, 1600, 0.72);
        const small = await downscale(big.blob, 220, 0.6);
        const p = { id: uuid(), assetId, sectionId, blob: big.blob, thumb: small.blob, mime: "image/jpeg", w: big.w, h: big.h, caption: "", createdAt: new Date().toISOString(), createdMs: Date.now(), syncState: "dirty" };
        await idbPut("photos", p);
        curPhotos.push(p);
        if (a) { a.photoCount = (a.photoCount || 0) + 1; touch(a); await idbPut("assets", a); mirror(); }
        renderStrip(sectionId); setSaved("photo saved ✓");
      } catch (e) { setSaved("PHOTO SAVE FAILED", true); alert("Could not save a photo. Free up phone storage and try again.\n\n" + (e && e.message ? e.message : e)); }
    }
  }
  function openViewer(photoId) {
    const p = curPhotos.find(x => x.id === photoId); if (!p) return; viewPhotoId = photoId;
    document.getElementById("viewerImg").innerHTML = `<img src="${objUrl(p.blob)}" alt="evidence"/>`;
    document.getElementById("viewerCap").value = p.caption || "";
    document.querySelector("[data-photodel]").dataset.photodel = photoId;
    document.getElementById("viewer").showModal();
  }
  async function deletePhoto(photoId) {
    const p = curPhotos.find(x => x.id === photoId); if (!p) return;
    p.syncState = "deleted"; p.blob = null; p.thumb = null; p.updatedAt = new Date().toISOString();
    try { await idbPut("photos", p); } catch (e) {}
    const a = state.assets.find(x => x.id === openId); if (a && a.photoCount) { a.photoCount--; touch(a); await idbPut("assets", a); mirror(); }
    curPhotos = curPhotos.filter(x => x.id !== photoId);
    document.getElementById("viewer").close();
    sections(a.type).forEach(s => renderStrip(s.id));
  }

  // ---- PDF ----
  function blobToScaledDataURL(blob, max) {
    return new Promise(async (res) => {
      if (!blob) return res(null);
      try { const ds = await downscale(blob, max, 0.72); const fr = new FileReader(); fr.onload = () => res({ url: fr.result, w: ds.w, h: ds.h }); fr.onerror = () => res(null); fr.readAsDataURL(ds.blob); }
      catch (e) { res(null); }
    });
  }
  const tick = () => new Promise(r => setTimeout(r, 0));
  function prog(show, txt, frac) { const p = document.getElementById("prog"); p.style.display = show ? "flex" : "none"; if (txt) document.getElementById("progTxt").textContent = txt; if (frac != null) document.getElementById("progBar").style.width = Math.round(frac * 100) + "%"; }

  async function buildAsset(doc, a, startNewPage) {
    const M = 40, PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight(), CW = PW - 2 * M, maxY = PH - 46;
    let y = M; const d = a.data || {}, tm = TYPEMETA[a.type];
    const ensure = (hh) => { if (y + hh > maxY) { doc.addPage(); y = M; } };
    const H = (txt, sz, col) => { ensure(sz + 10); doc.setFont("helvetica", "bold"); doc.setFontSize(sz); doc.setTextColor(col || "#0e4c5b"); doc.text(txt, M, y); y += sz + 6; doc.setTextColor("#10212a"); };
    const kv = (label, val) => { if (val == null || val === "" || val === "—") return; doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); const lab = label + ":  "; const lw = doc.getTextWidth(lab); doc.setFont("helvetica", "normal"); const lines = doc.splitTextToSize(String(val), CW - lw); ensure(lines.length * 12 + 4); doc.setFont("helvetica", "bold"); doc.text(lab, M, y); doc.setFont("helvetica", "normal"); doc.text(lines, M + lw, y); y += lines.length * 12 + 3; };
    if (startNewPage) { /* already on a fresh page */ }
    H((d.assetId || d.assetName || tm.n) + "   (" + tm.n + ")", 15); y += 2;
    let photos = []; try { photos = (await idbByAsset(a.id)).filter(isLive); } catch (e) {}
    for (const s of sections(a.type)) {
      const rows = s.f.filter(f => f.t !== "head" && f.t !== "calc" && d[f.k] != null && d[f.k] !== "");
      const calcs = s.f.filter(f => f.t === "calc").map(f => { const ov = d[f.k]; return { l: f.l, v: (ov != null && ov !== "") ? ov : f.fn(d) }; }).filter(c => c.v && c.v !== "—");
      const ph = photos.filter(p => p.sectionId === s.id);
      if (!rows.length && !calcs.length && !ph.length) continue;
      H(s.t, 11.5, "#0d6f86");
      rows.forEach(f => kv(f.l, d[f.k]));
      calcs.forEach(c => kv(c.l, c.v));
      for (const p of ph) {
        const im = await blobToScaledDataURL(p.blob, 1100);
        if (!im) { kv("Photo", "[image missing]"); continue; }
        const iw = CW * 0.6, ih = iw * im.h / im.w;
        ensure(ih + 20); doc.addImage(im.url, "JPEG", M, y, iw, ih); y += ih + 3;
        doc.setFont("helvetica", "italic"); doc.setFontSize(8.5); doc.setTextColor("#52646c");
        const cap = "Photo" + (p.caption ? ": " + p.caption : "") + "  (" + new Date(p.createdMs || p.createdAt).toLocaleString() + ")";
        const cl = doc.splitTextToSize(cap, CW); doc.text(cl, M, y); y += cl.length * 10 + 8; doc.setTextColor("#10212a");
      }
      y += 4;
    }
  }
  function cover(doc) {
    const M = 40; let y = 130, m = state.meta;
    doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor("#0e4c5b"); doc.text("Field Verification Log", M, y); y += 28;
    doc.setFontSize(13); doc.setTextColor("#52646c"); doc.text("Independent on-field evidence record, MWSC assets", M, y); y += 40;
    doc.setFontSize(11); doc.setTextColor("#10212a");
    [["Site", m.site], ["Evaluator", m.evaluator], ["Date", m.reportDate], ["Generated", new Date().toLocaleString()], ["Assets", String(state.assets.filter(isLive).length)]].forEach(rw => { if (rw[1]) { doc.setFont("helvetica", "bold"); doc.text(rw[0] + ":", M, y); doc.setFont("helvetica", "normal"); doc.text(String(rw[1]), M + 100, y); y += 20; } });
  }
  function footers(doc) { const n = doc.internal.getNumberOfPages(); for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor("#9aa3ab"); doc.text("Page " + i + " of " + n, doc.internal.pageSize.getWidth() - 90, doc.internal.pageSize.getHeight() - 22); } }
  function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"); }

  async function exportPDF(perAsset) {
    const J = window.jspdf && window.jspdf.jsPDF; if (!J) { alert("PDF engine did not load."); return; }
    const live = state.assets.filter(isLive); if (!live.length) { alert("No assets to export yet."); return; }
    const noPhoto = live.filter(a => !(a.photoCount > 0)).length;
    if (noPhoto && !confirm(noPhoto + " asset(s) have no photos. Export anyway?")) return;
    prog(true, "Building PDF…", 0);
    try {
      if (perAsset) {
        for (let i = 0; i < live.length; i++) { const doc = new J({ unit: "pt", format: "a4" }); await buildAsset(doc, live[i], false); footers(doc); doc.save("asset-" + (live[i].data.assetId || (i + 1)) + "-" + stamp() + ".pdf"); prog(true, "Asset " + (i + 1) + " of " + live.length, (i + 1) / live.length); await tick(); }
      } else {
        const doc = new J({ unit: "pt", format: "a4" }); cover(doc);
        for (let i = 0; i < live.length; i++) { doc.addPage(); await buildAsset(doc, live[i], true); prog(true, "Asset " + (i + 1) + " of " + live.length, (i + 1) / live.length); await tick(); }
        footers(doc); doc.save("field-report-" + stamp() + ".pdf");
      }
    } catch (e) { alert("PDF build failed: " + (e && e.message ? e.message : e)); }
    prog(false);
  }

  // ---- backup / restore (full bundle incl. photos as dataURL) ----
  const blobToDataURL = (b) => new Promise(res => { if (!b) return res(null); const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); });
  const dataURLToBlob = (u) => { const [h, b] = u.split(","); const mime = (h.match(/:(.*?);/) || [])[1] || "image/jpeg"; const bin = atob(b); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: mime }); };
  function dl(name, text, mime) { const b = new Blob([text], { type: mime }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 600); }
  async function backup() {
    prog(true, "Preparing backup…", 0);
    try {
      const assets = state.assets.filter(isLive);
      const allP = (await idbGetAll("photos")).filter(isLive);
      const photos = [];
      for (let i = 0; i < allP.length; i++) { const p = allP[i]; photos.push(Object.assign({}, p, { blob: await blobToDataURL(p.blob), thumb: await blobToDataURL(p.thumb) })); prog(true, "Packing photos…", (i + 1) / Math.max(1, allP.length)); }
      const bundle = { app: "field-verification-log", schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), meta: state.meta, assets, photos };
      dl("field-backup-" + stamp() + ".json", JSON.stringify(bundle), "application/json");
    } catch (e) { alert("Backup failed: " + (e && e.message ? e.message : e)); }
    prog(false);
  }
  function restorePick() { const i = document.createElement("input"); i.type = "file"; i.accept = "application/json"; i.onchange = () => { const f = i.files[0]; if (!f) return; const fr = new FileReader(); fr.onload = () => doRestore(fr.result); fr.readAsText(f); }; i.click(); }
  async function doRestore(text) {
    let o; try { o = JSON.parse(text); } catch (e) { return alert("Not a valid backup file."); }
    if (!o || !o.assets) return alert("This file is not a Field Log backup.");
    if (state.assets.filter(isLive).length && !confirm("Replace the data on this phone with the backup?")) return;
    prog(true, "Restoring…", 0);
    try {
      state.meta = o.meta || state.meta; if (!state.meta.deviceId) state.meta.deviceId = uuid(); saveMeta();
      state.assets = o.assets; for (const a of state.assets) await idbPut("assets", a);
      const ps = o.photos || [];
      for (let i = 0; i < ps.length; i++) { const p = ps[i]; const rec = Object.assign({}, p, { blob: p.blob ? dataURLToBlob(p.blob) : null, thumb: p.thumb ? dataURLToBlob(p.thumb) : null }); await idbPut("photos", rec); prog(true, "Restoring photos…", (i + 1) / Math.max(1, ps.length)); }
      mirror(); prog(false); renderHome(); alert("Restored " + state.assets.length + " assets and " + ps.length + " photos.");
    } catch (e) { prog(false); alert("Restore failed: " + (e && e.message ? e.message : e)); }
  }

  // ---- create / delete asset ----
  function addAsset(type) { const a = { id: uuid(), type, schemaVersion: SCHEMA_VERSION, deviceId: state.meta.deviceId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), syncState: "dirty", photoCount: 0, data: { dateEval: new Date().toISOString().slice(0, 10), observer: state.meta.evaluator || "" } }; state.assets.push(a); idbPut("assets", a).then(mirror); document.getElementById("typeDlg").close(); openAsset(a.id); }
  async function delAsset(id) { if (!confirm("Delete this asset and its photos?")) return; const a = state.assets.find(x => x.id === id); if (!a) return; a.syncState = "deleted"; a.updatedAt = new Date().toISOString(); await idbPut("assets", a); try { const ps = (await idbByAsset(id)); for (const p of ps) { p.syncState = "deleted"; p.blob = null; p.thumb = null; await idbPut("photos", p); } } catch (e) {} mirror(); renderHome(); }

  // ---- event delegation ----
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-action],[data-open],[data-newtype],[data-close],[data-addphoto],[data-photoview],[data-photodel],[data-recalc],[data-id]");
    if (!t) return;
    if (t.dataset.close) { const dlg = document.getElementById(t.dataset.close); if (dlg) dlg.close(); return; }
    if (t.dataset.recalc) { const a = state.assets.find(x => x.id === openId); if (a) { const k = t.dataset.recalc, f = allFields(a.type).find(x => x.k === k); a.data[k] = ""; touch(a); saveAsset(a); const inp = document.getElementById("ci_" + k); if (inp && f) inp.value = f.fn(a.data); } return; }
    if (t.dataset.newtype) return addAsset(t.dataset.newtype);
    if (t.hasAttribute("data-open")) return openAsset(t.getAttribute("data-open"));
    if (t.dataset.addphoto) { pendingTarget = { assetId: openId, sectionId: t.dataset.addphoto }; fileIn.click(); return; }
    if (t.dataset.photoview) return openViewer(t.dataset.photoview);
    if (t.hasAttribute("data-photodel")) { const id = t.getAttribute("data-photodel"); if (id) return deletePhoto(id); }
    const act = t.dataset.action;
    if (act === "add") return document.getElementById("typeDlg").showModal();
    if (act === "back") return renderHome();
    if (act === "delasset") return delAsset(t.dataset.id);
    if (act === "pdf") return exportPDF(false);
    if (act === "pdfper") return exportPDF(true);
    if (act === "backup") return backup();
    if (act === "restore") return restorePick();
  });
  document.addEventListener("input", onInput);
  document.addEventListener("change", (e) => { if (e.target.dataset && (e.target.dataset.k || e.target.dataset.meta)) onInput(e); if (e.target.id === "viewerCap" && viewPhotoId) { const p = curPhotos.find(x => x.id === viewPhotoId); if (p) { p.caption = e.target.value; p.syncState = "dirty"; idbPut("photos", p); } } });

  boot();
})();
