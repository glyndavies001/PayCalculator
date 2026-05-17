import React, { useState, useMemo, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import ANTHROPIC_API_KEY from "./apikey";

// ─── PAY CONSTANTS ────────────────────────────────────────────────────────────
const PAY = {
  baseRate: 14.50,
  oteRate: 15.50,          // includes performance allowance
  otRate: 17.40,
  weekendOtRate: 21.75,
  contractedHrsWeek: 41.25,
  contractedHrsMonth: 173.25,
  taxFreeMonthly: 1047.50,
  niPrimaryThreshold: 1048,
  niUpperThreshold: 4189,
  slThreshold: 2372,
  nestRate: 0.05,
  taxCode: "C1257L",
  niCategory: "A",
  bonusTiers: [
    { label: "Tier 1", range: "<80%",    bonus: 0,   netEst: 2232.94 },
    { label: "Tier 2", range: "80–84%",  bonus: 0,   netEst: 2400.00 },
    { label: "Tier 3", range: "85–89%",  bonus: 0,   netEst: 2560.00 },
    { label: "Tier 4", range: "90–94%",  bonus: 0,   netEst: 2720.00 },
    { label: "Tier 5", range: "95–99%",  bonus: 160, netEst: 3007.85 },
    { label: "Tier 6", range: "100%+",   bonus: 240, netEst: 3170.00 },
  ],
  additionalAllowance: 1.00,
};

// ─── PAY CALCULATOR ───────────────────────────────────────────────────────────
function calcPay({ stdHrs, otHrs, weekendOtHrs, bonus, perfAllowance }) {
  const oteRate   = PAY.baseRate + (perfAllowance ? PAY.additionalAllowance : 0);
  const stdPay    = stdHrs * oteRate;
  const otPay     = otHrs * PAY.otRate;
  const wkendPay  = weekendOtHrs * PAY.weekendOtRate;
  const gross     = stdPay + otPay + wkendPay + bonus;

  // Tax (Welsh basic rate 20% above monthly allowance)
  const taxable   = Math.max(0, gross - PAY.taxFreeMonthly);
  const tax       = taxable * 0.20;

  // NI (8% between thresholds, 2% above upper)
  const niLower   = Math.max(0, Math.min(gross, PAY.niUpperThreshold) - PAY.niPrimaryThreshold);
  const niUpper   = Math.max(0, gross - PAY.niUpperThreshold);
  const ni        = niLower * 0.08 + niUpper * 0.02;

  // NEST (5% on qualifying earnings above lower threshold ~£520/mo)
  const nestQual  = Math.max(0, gross - 520);
  const nest      = nestQual * PAY.nestRate;

  // Student Loan Plan 2 (9% above £2,372/mo)
  const sl        = Math.max(0, gross - PAY.slThreshold) * 0.09;

  const deductions = tax + ni + nest + sl;
  const net        = gross - deductions;

  return {
    stdPay, otPay, wkendPay, bonus, gross,
    tax, ni, nest, sl, deductions, net,
    annualGross: gross * 12, annualNet: net * 12,
    annualTax: tax * 12, annualNI: ni * 12,
    annualNEST: nest * 12, annualSL: sl * 12,
  };
}

// ─── HISTORY ─────────────────────────────────────────────────────────────────
const INITIAL_HISTORY = [
  { month: "Apr 2022", date: "29/04/2022", gross: 1669.82, net: 1432.82, tax: 124.8,  ni: 112.2,  nest: 0,     sl: 0,  bonus: 0,   ot: 60.38  },
  { month: "May 2022", date: "30/05/2022", gross: 1719.62, net: 1418.23, tax: 134.6,  ni: 118.8,  nest: 47.99, sl: 0,  bonus: 0,   ot: 43.12  },
  { month: "Jun 2022", date: "30/06/2022", gross: 2019.89, net: 1606.3,  tax: 195,    ni: 158.59, nest: 60,    sl: 0,  bonus: 100, ot: 166.75 },
  { month: "Jul 2022", date: "30/07/2022", gross: 1595.06, net: 1369.77, tax: 109.8,  ni: 72.48,  nest: 43.01, sl: 0,  bonus: 0,   ot: 0      },
  { month: "Aug 2022", date: "30/08/2022", gross: 1781.29, net: 1489.07, tax: 144.6,  ni: 97.16,  nest: 50.46, sl: 0,  bonus: 100, ot: 0      },
  { month: "Oct 2022", date: "30/10/2022", gross: 2036.24, net: 1647.05, tax: 197.6,  ni: 130.94, nest: 60.65, sl: 0,  bonus: 100, ot: 336.38 },
  { month: "Nov 2022", date: "30/11/2022", gross: 2089.44, net: 1693.29, tax: 208.4,  ni: 124.97, nest: 62.78, sl: 0,  bonus: 100, ot: 149.44 },
  { month: "Jan 2023", date: "30/01/2023", gross: 2697.37, net: 2044.55, tax: 329.8,  ni: 197.92, nest: 87.1,  sl: 38, bonus: 100, ot: 577.37 },
  { month: "Feb 2023", date: "28/02/2023", gross: 2246.17, net: 1793.74, tax: 239.6,  ni: 143.78, nest: 69.05, sl: 38, bonus: 100, ot: 51.17  },
  { month: "Mar 2023", date: "30/03/2023", gross: 2254.26, net: 1798.93, tax: 241.2,  ni: 144.75, nest: 69.38, sl: 38, bonus: 70,  ot: 164.26 },
  { month: "Apr 2023", date: "30/04/2023", gross: 2218.62, net: 1776.2,  tax: 234,    ni: 140.47, nest: 67.95, sl: 0,  bonus: 100, ot: 82.62  },
  { month: "May 2023", date: "30/05/2023", gross: 2203.52, net: 1766.51, tax: 231,    ni: 138.66, nest: 67.35, sl: 0,  bonus: 100, ot: 67.52  },
  { month: "Jul 2023", date: "30/07/2023", gross: 2193.74, net: 1760.3,  tax: 229,    ni: 137.49, nest: 66.95, sl: 5,  bonus: 100, ot: 57.74  },
  { month: "Sep 2023", date: "30/09/2023", gross: 2331.86, net: 1843.72, tax: 256.6,  ni: 154.06, nest: 72.48, sl: 5,  bonus: 100, ot: 195.86 },
  { month: "Oct 2023", date: "30/10/2023", gross: 2148.58, net: 1731.16, tax: 220.2,  ni: 132.07, nest: 65.15, sl: 10, bonus: 100, ot: 12.58  },
  { month: "Nov 2023", date: "30/11/2023", gross: 2209.89, net: 1770.66, tax: 232.2,  ni: 139.43, nest: 67.6,  sl: 10, bonus: 100, ot: 63.89  },
  { month: "Dec 2023", date: "28/12/2023", gross: 2138.01, net: 1724.48, tax: 218,    ni: 130.8,  nest: 64.73, sl: 10, bonus: 100, ot: 0      },
  { month: "Jan 2024", date: "31/01/2024", gross: 2528.32, net: 1981.95, tax: 296,    ni: 148.03, nest: 80.34, sl: 22, bonus: 100, ot: 192.32 },
  { month: "Feb 2024", date: "29/02/2024", gross: 2532.14, net: 1983.44, tax: 296.8,  ni: 148.41, nest: 80.49, sl: 23, bonus: 100, ot: 170.14 },
  { month: "Mar 2024", date: "28/03/2024", gross: 2362.01, net: 1887.12, tax: 262.8,  ni: 131.4,  nest: 73.69, sl: 7,  bonus: 100, ot: 0      },
  { month: "Apr 2024", date: "30/04/2024", gross: 2368.6,  net: 1917,    tax: 264,    ni: 105.65, nest: 73.95, sl: 8,  bonus: 100, ot: 32.59  },
  { month: "May 2024", date: "01/06/2024", gross: 2494.34, net: 1991.45, tax: 289.2,  ni: 115.71, nest: 78.98, sl: 19, bonus: 100, ot: 158.36 },
  { month: "Jun 2024", date: "28/06/2024", gross: 2336,    net: 1897.72, tax: 257.6,  ni: 103.04, nest: 72.64, sl: 5,  bonus: 100, ot: 0      },
  { month: "Jul 2024", date: "31/07/2024", gross: 2662.03, net: 2090.62, tax: 322.6,  ni: 129.12, nest: 85.69, sl: 34, bonus: 100, ot: 300.03 },
  { month: "Aug 2024", date: "31/08/2024", gross: 2527.56, net: 2010.89, tax: 296,    ni: 118.36, nest: 80.31, sl: 22, bonus: 100, ot: 191.56 },
  { month: "Sep 2024", date: "30/09/2024", gross: 2531.86, net: 2013.07, tax: 296.6,  ni: 118.71, nest: 80.48, sl: 23, bonus: 160, ot: 81.86  },
  { month: "Oct 2024", date: "30/10/2024", gross: 2667.57, net: 2093.1,  tax: 324,    ni: 129.56, nest: 85.91, sl: 35, bonus: 160, ot: 217.57 },
  { month: "Nov 2024", date: "29/11/2024", gross: 2482.59, net: 1984.51, tax: 286.8,  ni: 114.77, nest: 78.51, sl: 18, bonus: 200, ot: 32.59  },
  { month: "Dec 2024", date: "24/12/2024", gross: 2450,    net: 1965.24, tax: 280.4,  ni: 112.16, nest: 77.2,  sl: 15, bonus: 200, ot: 0      },
  { month: "Apr 2025", date: "29/04/2025", gross: 2669.33, net: 2103.44, tax: 324.2,  ni: 129.71, nest: 85.98, sl: 26, bonus: 160, ot: 82.66  },
  { month: "May 2025", date: "29/05/2025", gross: 2748.21, net: 2150.06, tax: 340,    ni: 136.02, nest: 89.13, sl: 33, bonus: 160, ot: 131.54 },
  { month: "Jun 2025", date: "30/06/2025", gross: 2728.63, net: 2137.83, tax: 336,    ni: 134.45, nest: 88.35, sl: 32, bonus: 160, ot: 141.96 },
  { month: "Aug 2025", date: "29/08/2025", gross: 2760.96, net: 2157.68, tax: 342.6,  ni: 137.04, nest: 89.64, sl: 34, bonus: 160, ot: 120.29 },
  { month: "Oct 2025", date: "29/10/2025", gross: 3125.28, net: 2372.48, tax: 415.4,  ni: 166.18, nest: 104.22,sl: 67, bonus: 160, ot: 158.09 },
  { month: "Nov 2025", date: "28/11/2025", gross: 2794.04, net: 2177.39, tax: 349,    ni: 139.68, nest: 90.97, sl: 37, bonus: 200, ot: 88.2   },
  { month: "Jan 2026", date: "29/01/2026", gross: 2798.53, net: 2179.34, tax: 350,    ni: 140.04, nest: 91.15, sl: 38, bonus: 200, ot: 85.34  },
  { month: "Mar 2026", date: "30/03/2026", gross: 2860.71, net: 2216.46, tax: 362.6,  ni: 145.02, nest: 93.63, sl: 43, bonus: 240, ot: 83.16  },
  { month: "Apr 2026", date: "29/04/2026", gross: 2957.36, net: 2280.31, tax: 381.8,  ni: 152.75, nest: 97.5,  sl: 45, bonus: 240, ot: 117.48 },
];

// ─── BILLS ────────────────────────────────────────────────────────────────────
const HOLLIE_CAR = 100;

// type: "shared" | "glyn"
const INITIAL_SHARED_BILLS = [
  { id: 1,  name: "Food",              total: 300,    isCarGlyn: false, contractEnd: null },
  { id: 2,  name: "Petrol",            total: 160,    isCarGlyn: false, contractEnd: null },
  { id: 3,  name: "Gaia",              total: 100,    isCarGlyn: false, contractEnd: null },
  { id: 4,  name: "Mortgage",          total: 501.59, isCarGlyn: false, contractEnd: null },
  { id: 5,  name: "Council Tax",       total: 161,    isCarGlyn: false, contractEnd: null },
  { id: 6,  name: "UW Gas & Electric", total: 126.31, isCarGlyn: false, contractEnd: null },
  { id: 7,  name: "Dwr Cymru",         total: 31.5,   isCarGlyn: false, contractEnd: null },
  { id: 8,  name: "Sky (TV+Broadband)",total: 60,     isCarGlyn: false, contractEnd: "2028-01-31" },
  { id: 9,  name: "Netflix",           total: 12.99,  isCarGlyn: false, contractEnd: null },
  { id: 10, name: "Disney+",           total: 9.99,   isCarGlyn: false, contractEnd: null },
  { id: 11, name: "Spotify",           total: 17.99,  isCarGlyn: false, contractEnd: null },
  { id: 12, name: "Car - Glyn",        total: 316.02, isCarGlyn: true,  contractEnd: "2031-02-28" },
  { id: 13, name: "Barclays Hoover",   total: 100.64, isCarGlyn: false, contractEnd: "2025-09-30" },
  { id: 14, name: "Medivet",           total: 17.5,   isCarGlyn: false, contractEnd: null },
  { id: 15, name: "Pet Insurance",     total: 4.97,   isCarGlyn: false, contractEnd: "2026-05-16" },
  { id: 16, name: "Head Room",         total: 100,    isCarGlyn: false, contractEnd: null },
  { id: 17, name: "Angie",             total: 7,      isCarGlyn: false, contractEnd: null },
];

const INITIAL_GLYN_BILLS = [
  { id: 101, name: "Barclays Phone",   total: 38.08,  contractEnd: "2026-06-30" },
  { id: 102, name: "L&G Insurance",    total: 16.7,   contractEnd: null },
  { id: 103, name: "Tesco",            total: 15,     contractEnd: null },
  { id: 104, name: "Julia",            total: 15.5,   contractEnd: null },
  { id: 105, name: "Google One",       total: 1.59,   contractEnd: null },
  { id: 106, name: "Lloyds CC",        total: 67.87,  contractEnd: null },
  { id: 107, name: "Ocean CC",         total: 26.95,  contractEnd: null },
];

function billShares(b) {
  if (b.isCarGlyn) return { glyn: Math.max(0, b.total - HOLLIE_CAR), hollie: HOLLIE_CAR };
  const half = b.total / 2;
  return { glyn: half, hollie: half };
}

function daysLeft(dateStr) {
  if (!dateStr) return null;
  const diff = new Date(dateStr) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// ─── STORAGE ─────────────────────────────────────────────────────────────────
const SK = {
  history: "jli_history", sharedBills: "jli_shared_bills", glynBills: "jli_glyn_bills",
  cats: "jli_categories", billCats: "jli_billcats", glynCats: "jli_glyn_categories", glynBillCats: "jli_glyn_billcats"
};
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// ─── UTILS ───────────────────────────────────────────────────────────────────
const fmt  = n => `£${Math.abs(Number(n)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const f2   = n => Number(n).toFixed(2);

const TABS = ["Dashboard", "Pay Calc", "Payslips", "Pay Info", "Budget", "Upload"];
const MONTH_SORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ─── BILL ROW ────────────────────────────────────────────────────────────────
function BillRow({ bill, idx, isGlynOnly, editing, onEditStart, onEditBlur, onDelete, onDragStart }) {
  const [val, setVal] = useState(String(bill.total));
  const shares = isGlynOnly ? null : billShares(bill);
  const days = daysLeft(bill.contractEnd);

  return (
    <div draggable onDragStart={onDragStart} style={{
      display: "grid",
      gridTemplateColumns: isGlynOnly ? "1fr 80px 26px" : "1fr 70px 64px 64px 26px",
      padding: "8px 10px", fontSize: 11, alignItems: "center",
      background: idx % 2 === 0 ? "#141824" : "#111520",
      borderBottom: "1px solid #1a1f2e", cursor: "grab",
    }}>
      <span style={{ color: "#8892b0" }}>
        {bill.name}
        {bill.isCarGlyn && <span style={{ fontSize: 9, color: "#3a4460", marginLeft: 4 }}>★</span>}
        {days !== null && days <= 60 && (
          <span style={{ fontSize: 9, color: days <= 30 ? "#ff6b8a" : "#ffb84a", marginLeft: 6 }}>
            ({days}d left)
          </span>
        )}
      </span>

      {editing ? (
        <input autoFocus type="number" value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={() => onEditBlur(val)}
          onKeyDown={e => e.key === "Enter" && onEditBlur(val)}
          style={{ background: "#1e2535", border: "1px solid #4a9eff", borderRadius: 4, color: "#e8eaf0", fontSize: 11, padding: "2px 4px", width: "100%", textAlign: "right" }}
        />
      ) : (
        <span onClick={onEditStart} style={{ textAlign: "right", color: isGlynOnly ? "#4a9eff" : "#5a6480", display: "block", cursor: "pointer", borderBottom: "1px dashed #2a3050", fontWeight: isGlynOnly ? 600 : 400 }}>
          {fmt(bill.total)}
        </span>
      )}

      {!isGlynOnly && (
        <>
          <span style={{ textAlign: "right", color: "#4a9eff", fontWeight: 600 }}>{fmt(shares.glyn)}</span>
          <span style={{ textAlign: "right", color: "#c84aff", fontWeight: 600 }}>{fmt(shares.hollie)}</span>
        </>
      )}
      <button onClick={onDelete} style={{ background: "none", border: "none", color: "#3a4460", fontSize: 12, cursor: "pointer", padding: 0, textAlign: "center" }}>✕</button>
    </div>
  );
}

// ─── CATEGORY SECTION ────────────────────────────────────────────────────────
function CatSection({ cat, bills, billCats, isGlynOnly, editingBill, setEditingBill, onBillBlur, onBillDelete, dragBill, setDragOver, dragOver, onDrop }) {
  const catBills = bills.filter(b => billCats[b.id] === cat.id);
  const catTotal = isGlynOnly
    ? catBills.reduce((s, b) => s + b.total, 0)
    : catBills.reduce((s, b) => s + billShares(b).glyn, 0);

  return (
    <div onDragOver={e => { e.preventDefault(); setDragOver(cat.id); }}
      onDragLeave={() => setDragOver(null)}
      onDrop={() => onDrop(cat.id)}
      style={{ border: "1px solid " + (dragOver === cat.id ? "#4a9eff" : "#1e2535"), borderTop: "none", transition: "border-color 0.15s" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: dragOver === cat.id ? "#0d1525" : "#0f1520" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#8892b0" }}>{cat.name}</span>
        <span style={{ fontSize: 11, color: isGlynOnly ? "#4a9eff" : "#4a9eff" }}>{fmt(catTotal)}</span>
      </div>
      {catBills.length === 0 && <div style={{ padding: "10px", textAlign: "center", fontSize: 11, color: "#2a3050", fontStyle: "italic" }}>Drop bills here</div>}
      {catBills.map((b, i) => (
        <BillRow key={b.id} bill={b} idx={i} isGlynOnly={isGlynOnly}
          editing={editingBill === b.id}
          onEditStart={() => setEditingBill(b.id)}
          onEditBlur={val => onBillBlur(b.id, val)}
          onDelete={() => onBillDelete(b.id)}
          onDragStart={() => { dragBill.current = b.id; }}
        />
      ))}
    </div>
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("Dashboard");

  // Data
  const [history, setHistory]         = useState(() => load(SK.history, INITIAL_HISTORY));
  const [sharedBills, setSharedBills] = useState(() => load(SK.sharedBills, INITIAL_SHARED_BILLS));
  const [glynBills, setGlynBills]     = useState(() => load(SK.glynBills, INITIAL_GLYN_BILLS));
  const [cats, setCats]               = useState(() => load(SK.cats, []));
  const [billCats, setBillCats]       = useState(() => load(SK.billCats, {}));
  const [glynCats, setGlynCats]       = useState(() => load(SK.glynCats, []));
  const [glynBillCats, setGlynBillCats] = useState(() => load(SK.glynBillCats, {}));

  // Pay calculator inputs
  const [calcInputs, setCalcInputs] = useState({
    stdHrs: PAY.contractedHrsMonth,
    otHrs: 0,
    weekendOtHrs: 0,
    bonus: 240,
    perfAllowance: true,
  });

  // Budget UI
  const [editingShared, setEditingShared] = useState(null);
  const [editingGlyn, setEditingGlyn]     = useState(null);
  const [addingShared, setAddingShared]   = useState(false);
  const [addingGlyn, setAddingGlyn]       = useState(false);
  const [newShared, setNewShared]         = useState({ name: "", total: "", isCarGlyn: false });
  const [newGlyn, setNewGlyn]             = useState({ name: "", total: "" });
  const [addingCat, setAddingCat]         = useState(null); // "shared" | "glyn" | null
  const [newCatName, setNewCatName]       = useState("");
  const [dragOver, setDragOver]           = useState(null);
  const [budgetTab, setBudgetTab]         = useState("shared"); // "shared" | "glyn"
  const dragBill = useRef(null);

  // Chart
  const [chartView, setChartView] = useState("net");

  // Upload
  const [uploading, setUploading]         = useState(false);
  const [uploadResult, setUploadResult]   = useState(null);
  const [uploadError, setUploadError]     = useState(null);
  const [pendingEntry, setPendingEntry]   = useState(null);

  // ── Derived ──
  const latest = history[history.length - 1];
  const recentHistory = history.slice(-18);

  const sharedGlynTotal  = sharedBills.reduce((s, b) => s + billShares(b).glyn, 0);
  const sharedHollieTotal= sharedBills.reduce((s, b) => s + billShares(b).hollie, 0);
  const glynOnlyTotal    = glynBills.reduce((s, b) => s + b.total, 0);
  const totalGlynOutgoings = sharedGlynTotal + glynOnlyTotal;
  const surplus = latest ? latest.net - totalGlynOutgoings : 0;

  const calcResult = useMemo(() => calcPay(calcInputs), [calcInputs]);

  const totalStats = useMemo(() => {
    const n = history.length || 1;
    return {
      gross: history.reduce((s,r)=>s+r.gross,0),
      net:   history.reduce((s,r)=>s+r.net,0),
      tax:   history.reduce((s,r)=>s+r.tax,0),
      ni:    history.reduce((s,r)=>s+r.ni,0),
      nest:  history.reduce((s,r)=>s+r.nest,0),
      sl:    history.reduce((s,r)=>s+r.sl,0),
      bonus: history.reduce((s,r)=>s+r.bonus,0),
      ot:    history.reduce((s,r)=>s+r.ot,0),
      avgNet:   history.reduce((s,r)=>s+r.net,0) / n,
      avgGross: history.reduce((s,r)=>s+r.gross,0) / n,
    };
  }, [history]);

  // ── Updaters ──
  const updH  = h  => { setHistory(h);        save(SK.history, h);       };
  const updSB = b  => { setSharedBills(b);    save(SK.sharedBills, b);   };
  const updGB = b  => { setGlynBills(b);      save(SK.glynBills, b);     };
  const updC  = c  => { setCats(c);           save(SK.cats, c);          };
  const updBC = bc => { setBillCats(bc);      save(SK.billCats, bc);     };
  const updGC = c  => { setGlynCats(c);       save(SK.glynCats, c);      };
  const updGBC= bc => { setGlynBillCats(bc);  save(SK.glynBillCats, bc); };

  // ── Calc input helper ──
  const setCalc = (key, val) => setCalcInputs(p => ({ ...p, [key]: val }));

  // ── Budget helpers ──
  const handleSharedBlur = (id, val) => {
    const num = parseFloat(val);
    updSB(sharedBills.map(b => b.id===id ? {...b, total: isNaN(num)?b.total:num} : b));
    setEditingShared(null);
  };
  const handleGlynBlur = (id, val) => {
    const num = parseFloat(val);
    updGB(glynBills.map(b => b.id===id ? {...b, total: isNaN(num)?b.total:num} : b));
    setEditingGlyn(null);
  };
  const deleteShared = id => { updSB(sharedBills.filter(b=>b.id!==id)); const bc={...billCats};delete bc[id];updBC(bc); };
  const deleteGlyn   = id => { updGB(glynBills.filter(b=>b.id!==id));   const bc={...glynBillCats};delete bc[id];updGBC(bc); };
  const addSharedBill = () => {
    if (!newShared.name.trim()) return;
    updSB([...sharedBills, {id:Date.now(), name:newShared.name.trim(), total:parseFloat(newShared.total)||0, isCarGlyn:newShared.isCarGlyn, contractEnd:null}]);
    setNewShared({name:"",total:"",isCarGlyn:false}); setAddingShared(false);
  };
  const addGlynBill = () => {
    if (!newGlyn.name.trim()) return;
    updGB([...glynBills, {id:Date.now(), name:newGlyn.name.trim(), total:parseFloat(newGlyn.total)||0, contractEnd:null}]);
    setNewGlyn({name:"",total:""}); setAddingGlyn(false);
  };
  const addCat = (isGlyn) => {
    if (!newCatName.trim()) return;
    const cat = {id:Date.now(), name:newCatName.trim()};
    if (isGlyn) updGC([...glynCats, cat]); else updC([...cats, cat]);
    setNewCatName(""); setAddingCat(null);
  };
  const deleteCat = (id, isGlyn) => {
    if (isGlyn) {
      updGC(glynCats.filter(c=>c.id!==id));
      const bc={...glynBillCats}; Object.keys(bc).forEach(k=>{if(bc[k]===id)delete bc[k];}); updGBC(bc);
    } else {
      updC(cats.filter(c=>c.id!==id));
      const bc={...billCats}; Object.keys(bc).forEach(k=>{if(bc[k]===id)delete bc[k];}); updBC(bc);
    }
  };
  const onDrop = (catId, isGlyn) => {
    if (dragBill.current==null) return;
    if (isGlyn) {
      const bc={...glynBillCats}; catId===null ? delete bc[dragBill.current] : (bc[dragBill.current]=catId); updGBC(bc);
    } else {
      const bc={...billCats}; catId===null ? delete bc[dragBill.current] : (bc[dragBill.current]=catId); updBC(bc);
    }
    dragBill.current=null; setDragOver(null);
  };

  // ── Upload ──
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true); setUploadResult(null); setUploadError(null); setPendingEntry(null);
    try {
      const b64 = await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=rej;r.readAsDataURL(file);});
      const resp = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,messages:[{role:"user",content:[
          {type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
          {type:"text",text:`Extract payslip data. Return ONLY JSON:\n{"month":"Mon YYYY","date":"DD/MM/YYYY","gross":0.00,"net":0.00,"tax":0.00,"ni":0.00,"nest":0.00,"sl":0.00,"bonus":0.00,"ot":0.00}\nmonth=payment month/year, ot=total overtime, sl=student loan, nest=pension, bonus=performance bonus.`}
        ]}]})
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);
      const parsed = JSON.parse(data.content.map(i=>i.text||"").join("").replace(/```json|```/g,"").trim());
      setPendingEntry(parsed); setUploadResult(`${parsed.month} — Gross ${fmt(parsed.gross)}, Net ${fmt(parsed.net)}`);
    } catch { setUploadError("Could not read payslip. Please check it's a valid JLI payslip PDF."); }
    setUploading(false); e.target.value="";
  };

  const confirmAdd = () => {
    if (!pendingEntry) return;
    const sortFn=(a,b)=>{const[ma,ya]=a.month.split(" ");const[mb,yb]=b.month.split(" ");return ya!==yb?ya-yb:MONTH_SORT.indexOf(ma)-MONTH_SORT.indexOf(mb);};
    const exists=history.find(h=>h.month===pendingEntry.month);
    updH(exists?history.map(h=>h.month===pendingEntry.month?pendingEntry:h):[...history,pendingEntry].sort(sortFn));
    setPendingEntry(null);setUploadResult(null);setTab("Payslips");
  };

  // ── Styles ──
  const card = {background:"#141824",borderRadius:10,border:"1px solid #1e2535",padding:"14px 12px"};
  const hdr  = {fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:6};
  const inp  = {background:"#1e2535",border:"1px solid #2a3050",borderRadius:6,color:"#e8eaf0",fontSize:13,padding:"8px 10px",width:"100%",boxSizing:"border-box"};
  const numInp = {...inp, textAlign:"right", fontWeight:700};
  const row  = {display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #1a1f2e",fontSize:12};

  // ── Render ──
  return (
    <div style={{minHeight:"100vh",background:"#0d0f14",color:"#e8eaf0",fontFamily:"'DM Sans','Segoe UI',sans-serif",paddingBottom:80}}>

      {/* Header */}
      <div style={{background:"linear-gradient(135deg,#1a1f2e,#0d1117)",borderBottom:"1px solid #1e2535",padding:"16px 14px 0",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:2}}>
          <span style={{fontSize:10,fontWeight:700,letterSpacing:3,color:"#4a9eff",textTransform:"uppercase"}}>JLI</span>
          <h1 style={{margin:0,fontSize:17,fontWeight:700,color:"#fff"}}>Pay Tracker</h1>
        </div>
        <p style={{margin:"0 0 12px",fontSize:10,color:"#5a6480"}}>Glyn Davies · {history.length} payslips</p>
        <div style={{display:"flex",gap:2,overflowX:"auto"}}>
          {TABS.map(t=>(
            <button key={t} onClick={()=>setTab(t)} style={{
              flexShrink:0,background:tab===t?"#4a9eff":"transparent",
              color:tab===t?"#fff":"#5a6480",border:"none",
              borderRadius:"6px 6px 0 0",padding:"7px 10px",fontSize:11,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"
            }}>{t}</button>
          ))}
        </div>
      </div>

      <div style={{padding:"14px 12px"}}>

        {/* ══ DASHBOARD ══ */}
        {tab==="Dashboard" && (
          <div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              {[
                {label:"Latest Net Pay",  value:fmt(latest?.net),      sub:latest?.month,              accent:"#4a9eff"},
                {label:"Monthly Surplus", value:fmt(surplus),           sub:"after all bills",          accent:surplus>=0?"#00c88c":"#ff4a6a"},
                {label:"Latest Gross",    value:fmt(latest?.gross),     sub:latest?.month,              accent:"#7c6fff"},
                {label:"Avg Monthly Net", value:fmt(totalStats.avgNet), sub:`${history.length} months`, accent:"#ffb84a"},
              ].map(k=>(
                <div key={k.label} style={{...card,textAlign:"center"}}>
                  <div style={hdr}>{k.label}</div>
                  <div style={{fontSize:20,fontWeight:700,color:k.accent}}>{k.value}</div>
                  <div style={{fontSize:10,color:"#3a4460",marginTop:2}}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* Chart */}
            <div style={{...card,marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <span style={{fontSize:11,fontWeight:600,color:"#8892b0"}}>Pay Trend (last 18 months)</span>
                <div style={{display:"flex",gap:4}}>
                  {["net","gross","bonus","ot"].map(v=>(
                    <button key={v} onClick={()=>setChartView(v)} style={{
                      background:chartView===v?"#1e2535":"transparent",
                      color:chartView===v?"#4a9eff":"#3a4460",
                      border:"1px solid "+(chartView===v?"#4a9eff":"#1e2535"),
                      borderRadius:4,padding:"3px 7px",fontSize:10,fontWeight:600,cursor:"pointer",textTransform:"capitalize"
                    }}>{v}</button>
                  ))}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={recentHistory}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2535"/>
                  <XAxis dataKey="month" tick={{fill:"#3a4460",fontSize:8}} tickLine={false} interval={2}/>
                  <YAxis tick={{fill:"#3a4460",fontSize:8}} tickLine={false} tickFormatter={v=>`£${v}`}/>
                  <Tooltip contentStyle={{background:"#1a1f2e",border:"1px solid #2a3050",borderRadius:6,color:"#e8eaf0",fontSize:11}} formatter={v=>fmt(v)}/>
                  {chartView==="net"   && <Line type="monotone" dataKey="net"   stroke="#4a9eff" strokeWidth={2} dot={false} name="Net Pay"/>}
                  {chartView==="gross" && <Line type="monotone" dataKey="gross" stroke="#7c6fff" strokeWidth={2} dot={false} name="Gross"/>}
                  {chartView==="bonus" && <Line type="monotone" dataKey="bonus" stroke="#ffb84a" strokeWidth={2} dot={false} name="Bonus"/>}
                  {chartView==="ot"    && <Line type="monotone" dataKey="ot"    stroke="#4affd4" strokeWidth={2} dot={false} name="Overtime"/>}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Budget summary */}
            <div style={{...card,marginBottom:14}}>
              <div style={{...hdr,marginBottom:12}}>Monthly Budget Summary</div>
              {[
                ["Latest Net Pay",        fmt(latest?.net),          "#4a9eff"],
                ["Shared Bills (my half)",fmt(sharedGlynTotal),      "#ff6b8a"],
                ["My Personal Bills",     fmt(glynOnlyTotal),        "#ff8c4a"],
                ["Total Outgoings",       fmt(totalGlynOutgoings),   "#ff4a6a"],
                ["Monthly Surplus",       fmt(surplus),              surplus>=0?"#00c88c":"#ff4a6a"],
              ].map(([l,v,c])=>(
                <div key={l} style={row}>
                  <span style={{color:"#8892b0"}}>{l}</span>
                  <span style={{fontWeight:700,color:c}}>{v}</span>
                </div>
              ))}
            </div>

            {/* All-time totals */}
            <div style={card}>
              <div style={{...hdr,marginBottom:12}}>All-Time Totals</div>
              {[
                ["Total Earned (Gross)", fmt(totalStats.gross), "#7c6fff"],
                ["Total Net Received",   fmt(totalStats.net),   "#4a9eff"],
                ["Total Tax Paid",       fmt(totalStats.tax),   "#ff6b8a"],
                ["Total NI Paid",        fmt(totalStats.ni),    "#ff8c4a"],
                ["Total NEST",           fmt(totalStats.nest),  "#00c88c"],
                ["Total Student Loan",   fmt(totalStats.sl),    "#ffb84a"],
                ["Total Bonuses",        fmt(totalStats.bonus), "#c84aff"],
                ["Total Overtime Pay",   fmt(totalStats.ot),    "#4affd4"],
              ].map(([l,v,c])=>(
                <div key={l} style={row}>
                  <span style={{color:"#8892b0"}}>{l}</span>
                  <span style={{fontSize:12,fontWeight:700,color:c}}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ PAY CALCULATOR ══ */}
        {tab==="Pay Calc" && (
          <div style={{display:"flex",flexDirection:"column",gap:14}}>

            {/* Inputs */}
            <div style={card}>
              <div style={{...hdr,marginBottom:14}}>💰 Monthly Pay Calculator</div>

              {/* Standard hours */}
              <div style={{marginBottom:10}}>
                <label style={{fontSize:11,color:"#5a6480",display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <span>Standard Hours</span>
                  <span style={{color:"#3a4460"}}>{PAY.contractedHrsMonth}hrs contracted</span>
                </label>
                <input type="number" value={calcInputs.stdHrs}
                  onChange={e=>setCalc("stdHrs",parseFloat(e.target.value)||0)}
                  style={numInp}/>
              </div>

              {/* OT hours */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                <div>
                  <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>
                    Overtime Hrs <span style={{color:"#3a4460"}}>@£{PAY.otRate}</span>
                  </label>
                  <input type="number" value={calcInputs.otHrs}
                    onChange={e=>setCalc("otHrs",parseFloat(e.target.value)||0)}
                    style={numInp}/>
                </div>
                <div>
                  <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>
                    Weekend OT Hrs <span style={{color:"#3a4460"}}>@£{PAY.weekendOtRate}</span>
                  </label>
                  <input type="number" value={calcInputs.weekendOtHrs}
                    onChange={e=>setCalc("weekendOtHrs",parseFloat(e.target.value)||0)}
                    style={numInp}/>
                </div>
              </div>

              {/* Bonus */}
              <div style={{marginBottom:10}}>
                <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>Performance Bonus (£)</label>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
                  {[0,100,160,240].map(b=>(
                    <button key={b} onClick={()=>setCalc("bonus",b)} style={{
                      background:calcInputs.bonus===b?"#4a9eff":"#1e2535",
                      color:calcInputs.bonus===b?"#fff":"#5a6480",
                      border:"1px solid "+(calcInputs.bonus===b?"#4a9eff":"#2a3050"),
                      borderRadius:6,padding:"5px 12px",fontSize:12,fontWeight:600,cursor:"pointer"
                    }}>{b===0?"None":fmt(b)}</button>
                  ))}
                </div>
                <input type="number" value={calcInputs.bonus}
                  onChange={e=>setCalc("bonus",parseFloat(e.target.value)||0)}
                  style={numInp}/>
              </div>

              {/* Performance allowance */}
              <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#8892b0",cursor:"pointer",padding:"8px 0"}}>
                <input type="checkbox" checked={calcInputs.perfAllowance}
                  onChange={e=>setCalc("perfAllowance",e.target.checked)}
                  style={{width:16,height:16}}/>
                Performance allowance active (+£{PAY.additionalAllowance}/hr)
              </label>
            </div>

            {/* Results */}
            <div style={card}>
              <div style={{...hdr,marginBottom:12}}>Gross Pay Breakdown</div>
              {[
                ["Standard Pay",    `${calcInputs.stdHrs}hrs × £${calcInputs.perfAllowance?PAY.oteRate:PAY.baseRate}`, fmt(calcResult.stdPay),  "#e8eaf0"],
                ["Overtime Pay",    `${calcInputs.otHrs}hrs × £${PAY.otRate}`,                                          fmt(calcResult.otPay),   "#4affd4"],
                ["Weekend OT Pay",  `${calcInputs.weekendOtHrs}hrs × £${PAY.weekendOtRate}`,                            fmt(calcResult.wkendPay),"#00c88c"],
                ["Performance Bonus","",                                                                                 fmt(calcResult.bonus),   "#ffb84a"],
              ].map(([l,sub,v,c])=>(
                <div key={l} style={{...row,flexDirection:"column",gap:2}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{color:"#8892b0"}}>{l}</span>
                    <span style={{fontWeight:700,color:c}}>{v}</span>
                  </div>
                  {sub&&<span style={{fontSize:10,color:"#3a4460"}}>{sub}</span>}
                </div>
              ))}
              <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",borderTop:"1px solid #2a3050",marginTop:4}}>
                <span style={{color:"#e8eaf0",fontWeight:700}}>Total Gross</span>
                <span style={{fontSize:16,fontWeight:700,color:"#7c6fff"}}>{fmt(calcResult.gross)}</span>
              </div>
            </div>

            <div style={card}>
              <div style={{...hdr,marginBottom:12}}>Deductions</div>
              {[
                ["Income Tax (20%)",   `Tax-free: ${fmt(PAY.taxFreeMonthly)}/mo`,fmt(calcResult.tax),  "#ff6b8a"],
                ["National Insurance", "8% to £4,189 | 2% above",               fmt(calcResult.ni),   "#ff8c4a"],
                ["NEST Pension (5%)",  "On qualifying earnings",                 fmt(calcResult.nest), "#ffb84a"],
                ["Student Loan P2",    "9% above £2,372/mo",                     fmt(calcResult.sl),   "#c84aff"],
              ].map(([l,sub,v,c])=>(
                <div key={l} style={{...row,flexDirection:"column",gap:2}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{color:"#8892b0"}}>{l}</span>
                    <span style={{fontWeight:700,color:c}}>−{v}</span>
                  </div>
                  <span style={{fontSize:10,color:"#3a4460"}}>{sub}</span>
                </div>
              ))}
              <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",borderTop:"1px solid #2a3050",marginTop:4}}>
                <span style={{color:"#e8eaf0",fontWeight:700}}>Total Deductions</span>
                <span style={{fontSize:16,fontWeight:700,color:"#ff4a6a"}}>−{fmt(calcResult.deductions)}</span>
              </div>
            </div>

            {/* Estimated net */}
            <div style={{...card,background:"linear-gradient(135deg,#0a1525,#0d1117)",border:"1px solid #4a9eff"}}>
              <div style={{textAlign:"center",marginBottom:16}}>
                <div style={{fontSize:11,color:"#4a9eff",fontWeight:700,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>Estimated Net Pay</div>
                <div style={{fontSize:36,fontWeight:700,color:"#4a9eff"}}>{fmt(calcResult.net)}</div>
                <div style={{fontSize:11,color:"#3a4460",marginTop:4}}>Surplus after bills: <span style={{color:calcResult.net-totalGlynOutgoings>=0?"#00c88c":"#ff4a6a",fontWeight:700}}>{fmt(calcResult.net-totalGlynOutgoings)}</span></div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                {[
                  ["Annual Gross", fmt(calcResult.annualGross), "#7c6fff"],
                  ["Annual Net",   fmt(calcResult.annualNet),   "#4a9eff"],
                  ["Annual Tax",   fmt(calcResult.annualTax),   "#ff6b8a"],
                  ["Annual NI",    fmt(calcResult.annualNI),    "#ff8c4a"],
                ].map(([l,v,c])=>(
                  <div key={l} style={{background:"#0d1117",borderRadius:8,padding:"10px",textAlign:"center"}}>
                    <div style={{fontSize:9,color:"#5a6480",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>{l}</div>
                    <div style={{fontSize:14,fontWeight:700,color:c}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* What-if tier table */}
            <div style={card}>
              <div style={{...hdr,marginBottom:4}}>What-If — Performance Tier Impact</div>
              <p style={{fontSize:11,color:"#3a4460",marginBottom:12}}>Based on current overtime inputs</p>
              <div style={{display:"grid",gridTemplateColumns:"60px 70px 1fr 1fr",padding:"6px 0",fontSize:9,color:"#3a4460",fontWeight:700,letterSpacing:1,textTransform:"uppercase",borderBottom:"1px solid #1e2535",marginBottom:4}}>
                <span>Tier</span><span>Range</span><span style={{textAlign:"right"}}>Est. Net</span><span style={{textAlign:"right"}}>Surplus</span>
              </div>
              {PAY.bonusTiers.map((tier,i)=>{
                const res = calcPay({...calcInputs, bonus:tier.bonus, perfAllowance: i>=5});
                const surp = res.net - totalGlynOutgoings;
                const isCurrent = calcInputs.bonus===tier.bonus;
                return (
                  <div key={tier.label} style={{display:"grid",gridTemplateColumns:"60px 70px 1fr 1fr",padding:"8px 0",borderBottom:"1px solid #1a1f2e",fontSize:11,background:isCurrent?"#0d1525":"transparent",borderRadius:isCurrent?4:0}}>
                    <span style={{color:isCurrent?"#4a9eff":"#5a6480",fontWeight:isCurrent?700:400}}>{tier.label}{isCurrent?" ★":""}</span>
                    <span style={{color:"#3a4460"}}>{tier.range}</span>
                    <span style={{textAlign:"right",color:"#4a9eff",fontWeight:600}}>{fmt(res.net)}</span>
                    <span style={{textAlign:"right",color:surp>=0?"#00c88c":"#ff4a6a",fontWeight:600}}>{fmt(surp)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ══ PAYSLIPS ══ */}
        {tab==="Payslips" && (
          <div>
            <div style={{...card,padding:0,overflow:"hidden",marginBottom:10}}>
              <div style={{display:"grid",gridTemplateColumns:"82px 1fr 1fr 1fr 58px",padding:"10px 10px",background:"#0d1117",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:1,textTransform:"uppercase"}}>
                <span>Month</span>
                <span style={{textAlign:"right"}}>Gross</span>
                <span style={{textAlign:"right"}}>Net</span>
                <span style={{textAlign:"right"}}>Tax</span>
                <span style={{textAlign:"right"}}>OT</span>
              </div>
              <div style={{maxHeight:"62vh",overflowY:"auto"}}>
                {[...history].reverse().map((row,i)=>(
                  <div key={row.month} style={{display:"grid",gridTemplateColumns:"82px 1fr 1fr 1fr 58px",padding:"9px 10px",fontSize:11,background:i%2===0?"#141824":"#111520",borderBottom:"1px solid #1a1f2e"}}>
                    <span style={{fontWeight:600,color:"#8892b0"}}>{row.month}</span>
                    <span style={{textAlign:"right",color:"#7c6fff"}}>{fmt(row.gross)}</span>
                    <span style={{textAlign:"right",color:"#4a9eff",fontWeight:700}}>{fmt(row.net)}</span>
                    <span style={{textAlign:"right",color:"#ff6b8a"}}>{fmt(row.tax)}</span>
                    <span style={{textAlign:"right",color:"#4affd4"}}>{row.ot>0?fmt(row.ot):"—"}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{...card,display:"grid",gridTemplateColumns:"82px 1fr 1fr 1fr 58px",fontSize:11,fontWeight:700}}>
              <span style={{color:"#5a6480"}}>TOTALS</span>
              <span style={{textAlign:"right",color:"#7c6fff"}}>{fmt(totalStats.gross)}</span>
              <span style={{textAlign:"right",color:"#4a9eff"}}>{fmt(totalStats.net)}</span>
              <span style={{textAlign:"right",color:"#ff6b8a"}}>{fmt(totalStats.tax)}</span>
              <span style={{textAlign:"right",color:"#4affd4"}}>{fmt(totalStats.ot)}</span>
            </div>
          </div>
        )}

        {/* ══ PAY INFO ══ */}
        {tab==="Pay Info" && (
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div style={card}>
              <div style={{...hdr,marginBottom:14}}>💷 Pay Rates</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                {[
                  {label:"Base Rate",      value:`£${PAY.baseRate}/hr`,       sub:"Standard hours",       accent:"#4a9eff"},
                  {label:"OTE Rate",       value:`£${PAY.oteRate}/hr`,         sub:"+ perf. allowance",   accent:"#00c88c"},
                  {label:"Overtime Rate",  value:`£${PAY.otRate}/hr`,          sub:"Weekday OT",          accent:"#4affd4"},
                  {label:"Weekend OT",     value:`£${PAY.weekendOtRate}/hr`,   sub:"Weekend OT",          accent:"#ffb84a"},
                ].map(k=>(
                  <div key={k.label} style={{background:"#0d1117",borderRadius:8,padding:"10px",textAlign:"center"}}>
                    <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:5}}>{k.label}</div>
                    <div style={{fontSize:18,fontWeight:700,color:k.accent}}>{k.value}</div>
                    <div style={{fontSize:10,color:"#3a4460",marginTop:2}}>{k.sub}</div>
                  </div>
                ))}
              </div>
              <div style={{background:"#0d1117",borderRadius:8,padding:"10px 12px",display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:12,color:"#5a6480"}}>Contracted Hours / Month</span>
                <span style={{fontSize:12,fontWeight:700,color:"#e8eaf0"}}>{PAY.contractedHrsMonth}hrs</span>
              </div>
            </div>

            <div style={card}>
              <div style={{...hdr,marginBottom:12}}>📋 Employment Details</div>
              {[
                ["Employer",          "JLI Trading Limited"],
                ["Tax Code",          PAY.taxCode],
                ["NI Category",       PAY.niCategory],
                ["NEST Pension",      "5% employee contribution"],
                ["Student Loan",      "Plan 2 (30-year write-off)"],
                ["Tax-Free Allowance",`${fmt(PAY.taxFreeMonthly)}/mo · ${fmt(PAY.taxFreeMonthly*12)}/yr`],
              ].map(([l,v])=>(
                <div key={l} style={row}>
                  <span style={{color:"#5a6480"}}>{l}</span>
                  <span style={{color:"#e8eaf0",fontWeight:600,textAlign:"right",maxWidth:"55%"}}>{v}</span>
                </div>
              ))}
            </div>

            <div style={card}>
              <div style={{...hdr,marginBottom:4}}>🏆 Performance Bonus Tiers</div>
              <p style={{fontSize:11,color:"#3a4460",marginBottom:14}}>Based on team average performance % each month</p>
              {PAY.bonusTiers.map((tier,i)=>{
                const colors=["#3a4460","#4a9eff","#7c6fff","#c84aff","#ffb84a","#00c88c"];
                return (
                  <div key={tier.label} style={{background:"#0d1117",borderRadius:8,padding:"10px 14px",borderLeft:`3px solid ${colors[i]}`,marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:tier.bonus===0?"#3a4460":colors[i]}}>{tier.bonus===0?"No Bonus":fmt(tier.bonus)}</div>
                      <div style={{fontSize:11,color:"#5a6480",marginTop:2}}>{tier.label}</div>
                    </div>
                    <div style={{background:"#1a1f2e",borderRadius:6,padding:"4px 10px",fontSize:11,fontWeight:700,color:colors[i]}}>{tier.range}</div>
                  </div>
                );
              })}
              <div style={{background:"#0d1117",borderRadius:8,padding:12,borderLeft:"3px solid #00c88c",marginTop:8}}>
                <div style={{fontSize:11,fontWeight:700,color:"#00c88c",marginBottom:4}}>Additional Hourly Allowance</div>
                <div style={{fontSize:12,color:"#8892b0",lineHeight:1.6}}>When team hits <span style={{color:"#e8eaf0",fontWeight:600}}>99.96%+</span>, an extra <span style={{color:"#00c88c",fontWeight:700}}>£{PAY.additionalAllowance}/hr</span> is added the following month (reflected in OTE rate).</div>
              </div>
            </div>

            <div style={card}>
              <div style={{...hdr,marginBottom:12}}>📈 Recent Bonus History</div>
              {history.slice(-10).reverse().map(r=>(
                <div key={r.month} style={row}>
                  <span style={{color:"#5a6480"}}>{r.month}</span>
                  <span style={{fontWeight:600,color:r.bonus>=240?"#00c88c":r.bonus>=200?"#ffb84a":r.bonus>=160?"#7c6fff":r.bonus>0?"#4a9eff":"#3a4460"}}>
                    {r.bonus>0?fmt(r.bonus):"—"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ BUDGET ══ */}
        {tab==="Budget" && (
          <div>
            {/* KPI row */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
              {[
                {label:"Shared (my half)", value:fmt(sharedGlynTotal),  accent:"#4a9eff"},
                {label:"My Personal Bills",value:fmt(glynOnlyTotal),    accent:"#ff8c4a"},
                {label:"Surplus",          value:fmt(surplus),           accent:surplus>=0?"#00c88c":"#ff4a6a"},
              ].map(k=>(
                <div key={k.label} style={{...card,textAlign:"center",padding:"10px 6px"}}>
                  <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>{k.label}</div>
                  <div style={{fontSize:15,fontWeight:700,color:k.accent}}>{k.value}</div>
                </div>
              ))}
            </div>

            {/* Sub-tabs */}
            <div style={{display:"flex",gap:4,marginBottom:12}}>
              {[["shared","Shared Bills"],["glyn","My Bills"]].map(([v,l])=>(
                <button key={v} onClick={()=>setBudgetTab(v)} style={{
                  flex:1,background:budgetTab===v?"#4a9eff":"#141824",
                  color:budgetTab===v?"#fff":"#5a6480",
                  border:"1px solid "+(budgetTab===v?"#4a9eff":"#1e2535"),
                  borderRadius:8,padding:"9px",fontSize:12,fontWeight:600,cursor:"pointer"
                }}>{l}</button>
              ))}
            </div>

            {/* ─ SHARED BILLS ─ */}
            {budgetTab==="shared" && (() => {
              const activeBills = sharedBills;
              const activeCats  = cats;
              const activeBillCats = billCats;
              return (
                <div>
                  {/* Add category */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <span style={{fontSize:10,color:"#3a4460",fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Categories</span>
                    <button onClick={()=>setAddingCat("shared")} style={{background:"#141824",border:"1px solid #1e2535",borderRadius:6,color:"#00c88c",fontSize:11,fontWeight:600,padding:"5px 10px",cursor:"pointer"}}>+ New</button>
                  </div>
                  {addingCat==="shared" && (
                    <div style={{display:"flex",gap:6,marginBottom:10}}>
                      <input autoFocus placeholder="Category name..." value={newCatName} onChange={e=>setNewCatName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCat(false)}
                        style={{...inp,flex:1,padding:"6px 8px",fontSize:12}}/>
                      <button onClick={()=>addCat(false)} style={{background:"#00c88c",border:"none",borderRadius:6,color:"#000",fontWeight:700,fontSize:12,padding:"6px 12px",cursor:"pointer"}}>Add</button>
                      <button onClick={()=>{setAddingCat(null);setNewCatName("");}} style={{background:"#1e2535",border:"none",borderRadius:6,color:"#5a6480",fontSize:12,padding:"6px 10px",cursor:"pointer"}}>✕</button>
                    </div>
                  )}

                  {/* Table header */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 70px 64px 64px 26px",padding:"8px 10px",background:"#0d1117",borderRadius:"8px 8px 0 0",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:1,textTransform:"uppercase",border:"1px solid #1e2535",borderBottom:"none"}}>
                    <span>Bill</span><span style={{textAlign:"right"}}>Total</span><span style={{textAlign:"right"}}>Glyn</span><span style={{textAlign:"right"}}>Hollie</span><span></span>
                  </div>

                  {/* Categories */}
                  {activeCats.map(cat=>(
                    <CatSection key={cat.id} cat={cat} bills={activeBills} billCats={activeBillCats} isGlynOnly={false}
                      editingBill={editingShared} setEditingBill={setEditingShared}
                      onBillBlur={handleSharedBlur} onBillDelete={deleteShared}
                      dragBill={dragBill} setDragOver={setDragOver} dragOver={dragOver}
                      onDrop={id=>onDrop(id,false)}
                    />
                  ))}

                  {/* Uncategorised shared */}
                  {(()=>{
                    const uncat=activeBills.filter(b=>!activeBillCats[b.id]);
                    return (
                      <div onDragOver={e=>{e.preventDefault();setDragOver("uncat-shared");}} onDragLeave={()=>setDragOver(null)} onDrop={()=>onDrop(null,false)}
                        style={{border:"1px solid "+(dragOver==="uncat-shared"?"#4a9eff":"#1e2535"),borderTop:"none",transition:"border-color 0.15s"}}>
                        <div style={{padding:"8px 10px",background:dragOver==="uncat-shared"?"#0d1525":"#0f1520"}}>
                          <span style={{fontSize:10,fontWeight:700,color:"#3a4460",textTransform:"uppercase",letterSpacing:1}}>Uncategorised</span>
                        </div>
                        {uncat.map((b,i)=>(
                          <BillRow key={b.id} bill={b} idx={i} isGlynOnly={false}
                            editing={editingShared===b.id} onEditStart={()=>setEditingShared(b.id)}
                            onEditBlur={val=>handleSharedBlur(b.id,val)} onDelete={()=>deleteShared(b.id)}
                            onDragStart={()=>{dragBill.current=b.id;}}
                          />
                        ))}
                        {uncat.length===0&&activeCats.length>0&&<div style={{padding:"10px",textAlign:"center",fontSize:11,color:"#2a3050",fontStyle:"italic"}}>All bills categorised</div>}
                      </div>
                    );
                  })()}

                  {/* Add shared bill */}
                  {addingShared&&(
                    <div style={{border:"1px solid #00c88c",borderTop:"none",background:"#0a1a10",padding:12}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 90px",gap:6,marginBottom:6}}>
                        <input autoFocus placeholder="Bill name" value={newShared.name} onChange={e=>setNewShared(r=>({...r,name:e.target.value}))} style={{...inp,padding:"6px 8px",fontSize:12}}/>
                        <input placeholder="£ Total" type="number" value={newShared.total} onChange={e=>setNewShared(r=>({...r,total:e.target.value}))} style={{...inp,padding:"6px 8px",fontSize:12,textAlign:"right"}}/>
                      </div>
                      <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"#8892b0",marginBottom:10,cursor:"pointer"}}>
                        <input type="checkbox" checked={newShared.isCarGlyn} onChange={e=>setNewShared(r=>({...r,isCarGlyn:e.target.checked}))}/>
                        Car exception (Hollie pays £{HOLLIE_CAR}, Glyn pays rest)
                      </label>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={addSharedBill} style={{flex:1,background:"#00c88c",border:"none",borderRadius:6,color:"#000",fontWeight:700,fontSize:12,padding:"8px",cursor:"pointer"}}>Add Bill</button>
                        <button onClick={()=>setAddingShared(false)} style={{background:"#1e2535",border:"none",borderRadius:6,color:"#5a6480",fontSize:12,padding:"8px 12px",cursor:"pointer"}}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {/* Shared totals */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 70px 64px 64px 26px",padding:"10px 10px",fontSize:11,fontWeight:700,background:"#141824",border:"1px solid #1e2535",borderTop:"1px solid #2a3050"}}>
                    <span style={{color:"#5a6480"}}>TOTAL</span>
                    <span style={{textAlign:"right",color:"#5a6480"}}>{fmt(activeBills.reduce((s,b)=>s+b.total,0))}</span>
                    <span style={{textAlign:"right",color:"#4a9eff"}}>{fmt(sharedGlynTotal)}</span>
                    <span style={{textAlign:"right",color:"#c84aff"}}>{fmt(sharedHollieTotal)}</span>
                    <span></span>
                  </div>

                  <div style={{display:"flex",gap:8,marginTop:10}}>
                    <button onClick={()=>setAddingShared(true)} style={{flex:1,background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#00c88c",fontSize:12,fontWeight:600,padding:"10px",cursor:"pointer"}}>+ Add Bill</button>
                    <button onClick={()=>{updSB(INITIAL_SHARED_BILLS);updC([]);updBC({});}} style={{background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#3a4460",fontSize:11,padding:"10px 12px",cursor:"pointer"}}>Reset</button>
                  </div>
                  <p style={{fontSize:10,color:"#3a4460",marginTop:8,textAlign:"center"}}>Tap Total to edit · Drag bills between categories · ★ = car rule</p>
                </div>
              );
            })()}

            {/* ─ GLYN ONLY BILLS ─ */}
            {budgetTab==="glyn" && (() => {
              return (
                <div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <span style={{fontSize:10,color:"#3a4460",fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Categories</span>
                    <button onClick={()=>setAddingCat("glyn")} style={{background:"#141824",border:"1px solid #1e2535",borderRadius:6,color:"#00c88c",fontSize:11,fontWeight:600,padding:"5px 10px",cursor:"pointer"}}>+ New</button>
                  </div>
                  {addingCat==="glyn" && (
                    <div style={{display:"flex",gap:6,marginBottom:10}}>
                      <input autoFocus placeholder="Category name..." value={newCatName} onChange={e=>setNewCatName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCat(true)}
                        style={{...inp,flex:1,padding:"6px 8px",fontSize:12}}/>
                      <button onClick={()=>addCat(true)} style={{background:"#00c88c",border:"none",borderRadius:6,color:"#000",fontWeight:700,fontSize:12,padding:"6px 12px",cursor:"pointer"}}>Add</button>
                      <button onClick={()=>{setAddingCat(null);setNewCatName("");}} style={{background:"#1e2535",border:"none",borderRadius:6,color:"#5a6480",fontSize:12,padding:"6px 10px",cursor:"pointer"}}>✕</button>
                    </div>
                  )}

                  {/* Table header — glyn only, no Hollie column */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 80px 26px",padding:"8px 10px",background:"#0d1117",borderRadius:"8px 8px 0 0",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:1,textTransform:"uppercase",border:"1px solid #ff8c4a",borderBottom:"none"}}>
                    <span>Bill</span><span style={{textAlign:"right"}}>Amount</span><span></span>
                  </div>

                  {/* Glyn categories */}
                  {glynCats.map(cat=>(
                    <CatSection key={cat.id} cat={cat} bills={glynBills} billCats={glynBillCats} isGlynOnly={true}
                      editingBill={editingGlyn} setEditingBill={setEditingGlyn}
                      onBillBlur={handleGlynBlur} onBillDelete={deleteGlyn}
                      dragBill={dragBill} setDragOver={setDragOver} dragOver={dragOver}
                      onDrop={id=>onDrop(id,true)}
                    />
                  ))}

                  {/* Uncategorised glyn */}
                  {(()=>{
                    const uncat=glynBills.filter(b=>!glynBillCats[b.id]);
                    return (
                      <div onDragOver={e=>{e.preventDefault();setDragOver("uncat-glyn");}} onDragLeave={()=>setDragOver(null)} onDrop={()=>onDrop(null,true)}
                        style={{border:"1px solid "+(dragOver==="uncat-glyn"?"#4a9eff":"#ff8c4a"),borderTop:"none",transition:"border-color 0.15s"}}>
                        <div style={{padding:"8px 10px",background:dragOver==="uncat-glyn"?"#0d1525":"#0f1520"}}>
                          <span style={{fontSize:10,fontWeight:700,color:"#ff8c4a",textTransform:"uppercase",letterSpacing:1}}>Uncategorised</span>
                        </div>
                        {uncat.map((b,i)=>(
                          <BillRow key={b.id} bill={b} idx={i} isGlynOnly={true}
                            editing={editingGlyn===b.id} onEditStart={()=>setEditingGlyn(b.id)}
                            onEditBlur={val=>handleGlynBlur(b.id,val)} onDelete={()=>deleteGlyn(b.id)}
                            onDragStart={()=>{dragBill.current=b.id;}}
                          />
                        ))}
                        {uncat.length===0&&glynCats.length>0&&<div style={{padding:"10px",textAlign:"center",fontSize:11,color:"#2a3050",fontStyle:"italic"}}>All bills categorised</div>}
                      </div>
                    );
                  })()}

                  {/* Add glyn bill */}
                  {addingGlyn&&(
                    <div style={{border:"1px solid #00c88c",borderTop:"none",background:"#0a1a10",padding:12}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 90px",gap:6,marginBottom:10}}>
                        <input autoFocus placeholder="Bill name" value={newGlyn.name} onChange={e=>setNewGlyn(r=>({...r,name:e.target.value}))} style={{...inp,padding:"6px 8px",fontSize:12}}/>
                        <input placeholder="£ Total" type="number" value={newGlyn.total} onChange={e=>setNewGlyn(r=>({...r,total:e.target.value}))} style={{...inp,padding:"6px 8px",fontSize:12,textAlign:"right"}}/>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={addGlynBill} style={{flex:1,background:"#00c88c",border:"none",borderRadius:6,color:"#000",fontWeight:700,fontSize:12,padding:"8px",cursor:"pointer"}}>Add Bill</button>
                        <button onClick={()=>setAddingGlyn(false)} style={{background:"#1e2535",border:"none",borderRadius:6,color:"#5a6480",fontSize:12,padding:"8px 12px",cursor:"pointer"}}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {/* Glyn total */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 80px 26px",padding:"10px 10px",fontSize:11,fontWeight:700,background:"#141824",border:"1px solid #ff8c4a",borderTop:"1px solid #2a3050"}}>
                    <span style={{color:"#5a6480"}}>TOTAL</span>
                    <span style={{textAlign:"right",color:"#ff8c4a"}}>{fmt(glynOnlyTotal)}</span>
                    <span></span>
                  </div>

                  <div style={{display:"flex",gap:8,marginTop:10}}>
                    <button onClick={()=>setAddingGlyn(true)} style={{flex:1,background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#00c88c",fontSize:12,fontWeight:600,padding:"10px",cursor:"pointer"}}>+ Add Bill</button>
                    <button onClick={()=>{updGB(INITIAL_GLYN_BILLS);updGC([]);updGBC({});}} style={{background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#3a4460",fontSize:11,padding:"10px 12px",cursor:"pointer"}}>Reset</button>
                  </div>
                  <p style={{fontSize:10,color:"#3a4460",marginTop:8,textAlign:"center"}}>Tap amount to edit · Drag bills between categories</p>
                </div>
              );
            })()}
          </div>
        )}

        {/* ══ UPLOAD ══ */}
        {tab==="Upload" && (
          <div style={{...card,textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:10}}>📄</div>
            <h2 style={{margin:"0 0 6px",fontSize:16,color:"#e8eaf0"}}>Upload Payslip</h2>
            <p style={{fontSize:12,color:"#5a6480",marginBottom:24}}>Select a JLI payslip PDF and the AI will extract all the figures automatically.</p>
            <label style={{display:"block",background:"#0d1117",border:"2px dashed #2a3050",borderRadius:10,padding:"24px 16px",cursor:"pointer"}}>
              <input type="file" accept=".pdf" onChange={handleFileUpload} style={{display:"none"}} disabled={uploading}/>
              {uploading
                ?<div><div style={{fontSize:20,marginBottom:6}}>⏳</div><div style={{color:"#4a9eff",fontSize:13}}>Reading payslip…</div></div>
                :<div><div style={{fontSize:20,marginBottom:6}}>☁️</div><div style={{color:"#4a9eff",fontSize:13,fontWeight:600}}>Tap to select PDF</div><div style={{color:"#3a4460",fontSize:11,marginTop:3}}>JLI payslips only</div></div>
              }
            </label>
            {uploadError&&<div style={{marginTop:16,padding:"12px",background:"#2a0f15",border:"1px solid #5a1a2a",borderRadius:8,color:"#ff6b8a",fontSize:12}}>⚠ {uploadError}</div>}
            {uploadResult&&pendingEntry&&(
              <div style={{marginTop:16,padding:16,background:"#0a1a10",border:"1px solid #1a4030",borderRadius:10,textAlign:"left"}}>
                <div style={{fontSize:11,fontWeight:700,color:"#00c88c",letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>✓ Extracted</div>
                {[["Month",pendingEntry.month],["Payment Date",pendingEntry.date],["Gross Pay",fmt(pendingEntry.gross)],["Net Pay",fmt(pendingEntry.net)],["Income Tax",fmt(pendingEntry.tax)],["National Insurance",fmt(pendingEntry.ni)],["NEST Pension",fmt(pendingEntry.nest)],["Student Loan",fmt(pendingEntry.sl)],["Bonus",fmt(pendingEntry.bonus)],["Overtime",fmt(pendingEntry.ot)]].map(([l,v])=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid #1a2a20",fontSize:12}}>
                    <span style={{color:"#5a8070"}}>{l}</span>
                    <span style={{color:"#e8eaf0",fontWeight:600}}>{v}</span>
                  </div>
                ))}
                <div style={{display:"flex",gap:8,marginTop:14}}>
                  <button onClick={confirmAdd} style={{flex:1,background:"#00c88c",color:"#000",border:"none",borderRadius:8,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer"}}>Add to History</button>
                  <button onClick={()=>{setPendingEntry(null);setUploadResult(null);}} style={{flex:1,background:"#1e2535",color:"#8892b0",border:"none",borderRadius:8,padding:"10px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Discard</button>
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
