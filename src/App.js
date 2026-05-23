import React, { useState, useMemo, useRef, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";
import ANTHROPIC_API_KEY from "./apikey";

function getWorkingDaysInMonth(year, month) {
  const days = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= days; d++) {
    const day = new Date(year, month, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}
function getCurrentMonthHours() {
  const now = new Date();
  return Math.round(getWorkingDaysInMonth(now.getFullYear(), now.getMonth()) * 8.25 * 100) / 100;
}

const PAY = {
  baseRate: 14.50, oteRate: 15.50, otRate: 17.40, weekendOtRate: 21.75,
  taxFreeMonthly: 1047.50, niPrimaryThreshold: 1048, niUpperThreshold: 4189,
  slThreshold: 2372, nestRate: 0.05, taxCode: "C1257L", niCategory: "A",
  additionalAllowance: 1.00,
  bonusTiers: [
    { label: "Tier 1", range: "<80%",   bonus: 0   },
    { label: "Tier 2", range: "80-84%", bonus: 0   },
    { label: "Tier 3", range: "85-89%", bonus: 0   },
    { label: "Tier 4", range: "90-94%", bonus: 0   },
    { label: "Tier 5", range: "95-99%", bonus: 160 },
    { label: "Tier 6", range: "100%+",  bonus: 240 },
  ],
};

function calcPay({ stdHrs, otHrs, weekendOtHrs, bonus, perfAllowance }) {
  const rate = PAY.baseRate + (perfAllowance ? PAY.additionalAllowance : 0);
  const stdPay = stdHrs * rate;
  const otPay = otHrs * PAY.otRate;
  const wkPay = weekendOtHrs * PAY.weekendOtRate;
  const gross = stdPay + otPay + wkPay + bonus;
  const taxable = Math.max(0, gross - PAY.taxFreeMonthly);
  const tax = taxable * 0.20;
  const niLower = Math.max(0, Math.min(gross, PAY.niUpperThreshold) - PAY.niPrimaryThreshold);
  const niUpper = Math.max(0, gross - PAY.niUpperThreshold);
  const ni = niLower * 0.08 + niUpper * 0.02;
  const nest = Math.max(0, gross - 520) * PAY.nestRate;
  const sl = Math.max(0, gross - PAY.slThreshold) * 0.09;
  const deductions = tax + ni + nest + sl;
  const net = gross - deductions;
  return { stdPay, otPay, wkPay, bonus, gross, tax, ni, nest, sl, deductions, net,
    annualGross: gross*12, annualNet: net*12, annualTax: tax*12, annualNI: ni*12 };
}

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
  { month: "Aug 2023", date: "30/08/2023", gross: 2226.87, net: 1781.33, tax: 235.8,  ni: 141.46, nest: 68.28, sl: 5,  bonus: 100, ot: 90.87  },
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

const HOLLIE_CAR = 100;
const INITIAL_SHARED_BILLS = [
  { id: 1,  name: "Food",               total: 300,    isCarGlyn: false },
  { id: 2,  name: "Petrol",             total: 160,    isCarGlyn: false },
  { id: 3,  name: "Gaia",               total: 100,    isCarGlyn: false },
  { id: 4,  name: "Mortgage",           total: 501.59, isCarGlyn: false },
  { id: 5,  name: "Council Tax",        total: 161,    isCarGlyn: false },
  { id: 6,  name: "UW Gas & Electric",  total: 126.31, isCarGlyn: false },
  { id: 7,  name: "Dwr Cymru",          total: 31.5,   isCarGlyn: false },
  { id: 8,  name: "Sky (TV+Broadband)", total: 60,     isCarGlyn: false },
  { id: 9,  name: "Netflix",            total: 12.99,  isCarGlyn: false },
  { id: 10, name: "Disney+",            total: 9.99,   isCarGlyn: false },
  { id: 11, name: "Spotify",            total: 17.99,  isCarGlyn: false },
  { id: 12, name: "Car 🚗",             total: 316.02, isCarGlyn: true  },
  { id: 13, name: "Barclays Hoover",    total: 100.64, isCarGlyn: false },
  { id: 14, name: "Medivet",            total: 17.5,   isCarGlyn: false },
  { id: 15, name: "Pet Insurance",      total: 4.97,   isCarGlyn: false },
  { id: 16, name: "Head Room",          total: 100,    isCarGlyn: false },
  { id: 17, name: "Angie",              total: 7,      isCarGlyn: false },
];
const INITIAL_GLYN_BILLS = [
  { id: 101, name: "Barclays Phone", total: 38.08 },
  { id: 102, name: "L&G Insurance",  total: 16.7  },
  { id: 103, name: "Tesco",          total: 15    },
  { id: 104, name: "Julia",          total: 15.5  },
  { id: 105, name: "Google One",     total: 1.59  },
  { id: 106, name: "Lloyds CC",      total: 67.87 },
  { id: 107, name: "Ocean CC",       total: 26.95 },
];

function billShares(b) {
  if (b.isCarGlyn) return { glyn: Math.max(0, b.total - HOLLIE_CAR), hollie: HOLLIE_CAR };
  return { glyn: b.total / 2, hollie: b.total / 2 };
}

// Storage keys — NEVER change these, doing so will lose user data
const SK = {
  history:     "vaulted_history",
  sharedBills: "vaulted_shared_bills",
  glynBills:   "vaulted_glyn_bills",
  cats:        "vaulted_cats",
  billCats:    "vaulted_billcats",
  glynCats:    "vaulted_gcats",
  glynBillCats:"vaulted_gbillcats",
  calcInputs:  "vaulted_calc",
};

// Legacy key names from older builds — migrate once then leave
const LEGACY = {
  "jli_history": "vaulted_history", "jli_bills": "vaulted_shared_bills",
  "jli_shared_bills": "vaulted_shared_bills", "jli_glyn_bills": "vaulted_glyn_bills",
  "jli_categories": "vaulted_cats", "jli_billcats": "vaulted_billcats",
  "jli_glyn_categories": "vaulted_gcats", "jli_glyn_billcats": "vaulted_gbillcats",
  "v_history": "vaulted_history", "v_shared_bills": "vaulted_shared_bills",
  "v_glyn_bills": "vaulted_glyn_bills", "v_cats": "vaulted_cats",
  "v_billcats": "vaulted_billcats", "v_gcats": "vaulted_gcats",
  "v_gbillcats": "vaulted_gbillcats", "v_calc": "vaulted_calc",
};

// Run migration once on load
(function migrate() {
  try {
    Object.entries(LEGACY).forEach(([oldKey, newKey]) => {
      if (localStorage.getItem(newKey)) return; // already migrated
      const old = localStorage.getItem(oldKey);
      if (old) { localStorage.setItem(newKey, old); localStorage.removeItem(oldKey); }
    });
  } catch {}
})();

const load = (key, fb) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const save = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

const fmt = n => "£" + Math.abs(Number(n)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const TABS = ["Dashboard","Budget","Pay Calc","Pay Info","Payslips","Upload"];
const RANGES = ["3M","6M","12M","2Y","All"];

function sortH(arr) {
  return [...arr].sort((a,b)=>{
    const[ma,ya]=a.month.split(" ");const[mb,yb]=b.month.split(" ");
    return ya!==yb?ya-yb:MONTHS.indexOf(ma)-MONTHS.indexOf(mb);
  });
}

function fyAvgNet(history) {
  const now = new Date();
  const fyStart = now.getMonth()>=3 ? new Date(now.getFullYear(),3,1) : new Date(now.getFullYear()-1,3,1);
  const fy = history.filter(r=>{const[mo,yr]=r.month.split(" ");return new Date(parseInt(yr),MONTHS.indexOf(mo),1)>=fyStart;});
  return fy.length>0 ? fy.reduce((s,r)=>s+r.net,0)/fy.length : 0;
}

function CollapsibleChart({title,data,dataKey,color}) {
  const [open,setOpen]=useState(false);
  return (
    <div style={{border:"1px solid #1e2535",borderRadius:10,overflow:"hidden",marginBottom:8}}>
      <button onClick={()=>setOpen(o=>!o)} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 14px",background:"#141824",border:"none",cursor:"pointer",color:"#e8eaf0"}}>
        <span style={{fontSize:12,fontWeight:600,color:"#8892b0"}}>{title}</span>
        <span style={{fontSize:12,color:"#3a4460"}}>{open?"▲":"▼"}</span>
      </button>
      {open&&(
        <div style={{padding:"12px",background:"#111520"}}>
          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={data} margin={{top:4,right:4,left:0,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e2535"/>
              <XAxis dataKey="month" tick={{fill:"#3a4460",fontSize:8}} tickLine={false} interval={Math.max(0,Math.floor(data.length/6)-1)}/>
              <YAxis tick={{fill:"#3a4460",fontSize:8}} tickLine={false} tickFormatter={v=>"£"+v}/>
              <Tooltip contentStyle={{background:"#1a1f2e",border:"1px solid #2a3050",borderRadius:6,color:"#e8eaf0",fontSize:11}} formatter={v=>fmt(v)}/>
              <Bar dataKey={dataKey} fill={color} radius={[2,2,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function BillRow({bill,idx,isGlynOnly,editing,onEditStart,onEditBlur,onDelete,onDragStart}) {
  const [val,setVal]=useState(String(bill.total));
  const sh=isGlynOnly?null:billShares(bill);
  return (
    <div draggable onDragStart={onDragStart} style={{
      display:"grid",gridTemplateColumns:isGlynOnly?"1fr 80px 26px":"1fr 70px 64px 64px 26px",
      padding:"8px 10px",fontSize:11,alignItems:"center",
      background:idx%2===0?"#141824":"#111520",borderBottom:"1px solid #1a1f2e",cursor:"grab"
    }}>
      <span style={{color:"#8892b0"}}>{bill.name}</span>
      {editing?(
        <input autoFocus type="number" value={val} onChange={e=>setVal(e.target.value)}
          onBlur={()=>onEditBlur(val)} onKeyDown={e=>e.key==="Enter"&&onEditBlur(val)}
          style={{background:"#1e2535",border:"1px solid #4a9eff",borderRadius:4,color:"#e8eaf0",fontSize:11,padding:"2px 4px",width:"100%",textAlign:"right"}}/>
      ):(
        <span onClick={onEditStart} style={{textAlign:"right",color:isGlynOnly?"#4a9eff":"#5a6480",display:"block",cursor:"pointer",borderBottom:"1px dashed #2a3050",fontWeight:isGlynOnly?600:400}}>
          {fmt(bill.total)}
        </span>
      )}
      {!isGlynOnly&&<><span style={{textAlign:"right",color:"#4a9eff",fontWeight:600}}>{fmt(sh.glyn)}</span><span style={{textAlign:"right",color:"#c84aff",fontWeight:600}}>{fmt(sh.hollie)}</span></>}
      <button onClick={onDelete} style={{background:"none",border:"none",color:"#3a4460",fontSize:12,cursor:"pointer",padding:0,textAlign:"center"}}>✕</button>
    </div>
  );
}

function CatSection({cat,bills,billCats,isGlynOnly,editingBill,setEditingBill,onBillBlur,onBillDelete,onCatDelete,onCatRename,dragBill,setDragOver,dragOver,onDrop}) {
  const [renaming,setRenaming]=useState(false);
  const [rv,setRv]=useState(cat.name);
  const cb=bills.filter(b=>billCats[b.id]===cat.id);
  const total=cb.reduce((s,b)=>s+b.total,0);
  const glynTotal=isGlynOnly?total:cb.reduce((s,b)=>s+billShares(b).glyn,0);
  return (
    <div onDragOver={e=>{e.preventDefault();setDragOver(cat.id);}} onDragLeave={()=>setDragOver(null)} onDrop={()=>onDrop(cat.id)}
      style={{border:"1px solid "+(dragOver===cat.id?"#4a9eff":"#1e2535"),borderTop:"none",transition:"border-color 0.15s"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",background:dragOver===cat.id?"#0d1525":"#0f1520"}}>
        {renaming?(
          <input autoFocus value={rv} onChange={e=>setRv(e.target.value)}
            onBlur={()=>{onCatRename(cat.id,rv);setRenaming(false);}}
            onKeyDown={e=>{if(e.key==="Enter"){onCatRename(cat.id,rv);setRenaming(false);}}}
            style={{background:"#1e2535",border:"1px solid #4a9eff",borderRadius:4,color:"#e8eaf0",fontSize:12,padding:"3px 6px",flex:1,marginRight:8}}/>
        ):(
          <span onDoubleClick={()=>setRenaming(true)} style={{fontSize:11,fontWeight:700,color:"#8892b0",cursor:"text",flex:1,minWidth:0}} title="Double-tap to rename">{cat.name}</span>
        )}
        <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
          <span style={{fontSize:11,color:"#e8eaf0",fontWeight:700}}>{fmt(total)}</span>
          <button onClick={()=>setRenaming(true)} style={{background:"none",border:"none",color:"#3a4460",fontSize:11,cursor:"pointer",padding:"2px 4px"}}>✏️</button>
          <button onClick={()=>onCatDelete(cat.id)} style={{background:"#2a1a1a",border:"1px solid #5a2a2a",borderRadius:4,color:"#ff6b8a",fontSize:10,fontWeight:700,cursor:"pointer",padding:"2px 7px"}}>✕ Delete</button>
        </div>
      </div>
      {cb.length===0&&<div style={{padding:"10px",textAlign:"center",fontSize:11,color:"#2a3050",fontStyle:"italic"}}>Drop bills here</div>}
      {cb.map((b,i)=>(
        <BillRow key={b.id} bill={b} idx={i} isGlynOnly={isGlynOnly}
          editing={editingBill===b.id} onEditStart={()=>setEditingBill(b.id)}
          onEditBlur={v=>onBillBlur(b.id,v)} onDelete={()=>onBillDelete(b.id)}
          onDragStart={()=>{dragBill.current=b.id;}}/>
      ))}
    </div>
  );
}

export default function App() {
  const [tab,setTab]=useState("Dashboard");
  const [history,setHistory]=useState(()=>load(SK.history,INITIAL_HISTORY));
  const [sharedBills,setSharedBills]=useState(()=>load(SK.sharedBills,INITIAL_SHARED_BILLS));
  const [glynBills,setGlynBills]=useState(()=>load(SK.glynBills,INITIAL_GLYN_BILLS));
  const [cats,setCats]=useState(()=>load(SK.cats,[]));
  const [billCats,setBillCats]=useState(()=>load(SK.billCats,{}));
  const [glynCats,setGlynCats]=useState(()=>load(SK.glynCats,[]));
  const [glynBillCats,setGlynBillCats]=useState(()=>load(SK.glynBillCats,{}));
  const defCalc={stdHrs:getCurrentMonthHours(),otHrs:0,weekendOtHrs:0,bonus:240,perfAllowance:true};
  const [ci,setCi]=useState(()=>load(SK.calcInputs,defCalc));
  const [editSh,setEditSh]=useState(null);
  const [editGl,setEditGl]=useState(null);
  const [addSh,setAddSh]=useState(false);
  const [addGl,setAddGl]=useState(false);
  const [newSh,setNewSh]=useState({name:"",total:"",isCarGlyn:false});
  const [newGl,setNewGl]=useState({name:"",total:""});
  const [addingCat,setAddingCat]=useState(null);
  const [newCat,setNewCat]=useState("");
  const [dragOver,setDragOver]=useState(null);
  const [budTab,setBudTab]=useState("shared");
  const dragBill=useRef(null);
  const [chartRange,setChartRange]=useState("All");
  const [uploading,setUploading]=useState(false);
  const [uploadRes,setUploadRes]=useState(null);
  const [uploadErr,setUploadErr]=useState(null);
  const [pending,setPending]=useState(null);

  const latest=history[history.length-1];
  const shGlyn=sharedBills.reduce((s,b)=>s+billShares(b).glyn,0);
  const shHollie=sharedBills.reduce((s,b)=>s+billShares(b).hollie,0);
  const glOnly=glynBills.reduce((s,b)=>s+b.total,0);
  const totalOut=shGlyn+glOnly;
  const cr=useMemo(()=>calcPay(ci),[ci]);
  const surplus=cr.net-totalOut;

  const chartData=useMemo(()=>{
    const s=sortH(history);
    const m={"3M":3,"6M":6,"12M":12,"2Y":24}[chartRange];
    return m?s.slice(-m):s;
  },[history,chartRange]);

  const ts=useMemo(()=>({
    gross:history.reduce((s,r)=>s+r.gross,0),net:history.reduce((s,r)=>s+r.net,0),
    tax:history.reduce((s,r)=>s+r.tax,0),ni:history.reduce((s,r)=>s+r.ni,0),
    nest:history.reduce((s,r)=>s+r.nest,0),sl:history.reduce((s,r)=>s+r.sl,0),
    bonus:history.reduce((s,r)=>s+r.bonus,0),ot:history.reduce((s,r)=>s+r.ot,0),
    avgNet:fyAvgNet(history),
  }),[history]);

  const updH=h=>{setHistory(h);save(SK.history,h);};
  const updSB=b=>{setSharedBills(b);save(SK.sharedBills,b);};
  const updGB=b=>{setGlynBills(b);save(SK.glynBills,b);};
  const updC=c=>{setCats(c);save(SK.cats,c);};
  const updBC=bc=>{setBillCats(bc);save(SK.billCats,bc);};
  const updGC=c=>{setGlynCats(c);save(SK.glynCats,c);};
  const updGBC=bc=>{setGlynBillCats(bc);save(SK.glynBillCats,bc);};
  const setC=useCallback((k,v)=>{setCi(p=>{const n={...p,[k]:v};save(SK.calcInputs,n);return n;});},[]);

  const handleUpload=async e=>{
    const file=e.target.files[0];if(!file)return;
    setUploading(true);setUploadRes(null);setUploadErr(null);setPending(null);
    try {
      const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=rej;r.readAsDataURL(file);});
      const resp=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:1000,messages:[{role:"user",content:[
          {type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
          {type:"text",text:'Extract payslip data. Return ONLY JSON:\n{"month":"Mon YYYY","date":"DD/MM/YYYY","gross":0.00,"net":0.00,"tax":0.00,"ni":0.00,"nest":0.00,"sl":0.00,"bonus":0.00,"ot":0.00}\nmonth=payment month/year, ot=total overtime, sl=student loan, nest=pension, bonus=performance bonus.'}
        ]}]})
      });
      const data=await resp.json();
      if(data.error) throw new Error("API error: "+data.error.type+" - "+data.error.message);
      const parsed=JSON.parse(data.content.map(i=>i.text||"").join("").replace(/```json|```/g,"").trim());
      setC("bonus",parsed.bonus);
      setC("perfAllowance",parsed.bonus>=160);
      setPending(parsed);
      setUploadRes(parsed.month+" - Gross "+fmt(parsed.gross)+", Net "+fmt(parsed.net));
    } catch(err){setUploadErr(err.message||"Unknown error");}
    setUploading(false);e.target.value="";
  };

  const confirmAdd=()=>{
    if(!pending)return;
    const exists=history.find(h=>h.month===pending.month);
    updH(exists?history.map(h=>h.month===pending.month?pending:h):sortH([...history,pending]));
    setPending(null);setUploadRes(null);setTab("Payslips");
  };

  const hSB=(id,v)=>{const n=parseFloat(v);updSB(sharedBills.map(b=>b.id===id?{...b,total:isNaN(n)?b.total:n}:b));setEditSh(null);};
  const hGB=(id,v)=>{const n=parseFloat(v);updGB(glynBills.map(b=>b.id===id?{...b,total:isNaN(n)?b.total:n}:b));setEditGl(null);};
  const delSh=id=>{updSB(sharedBills.filter(b=>b.id!==id));const bc={...billCats};delete bc[id];updBC(bc);};
  const delGl=id=>{updGB(glynBills.filter(b=>b.id!==id));const bc={...glynBillCats};delete bc[id];updGBC(bc);};
  const addShBill=()=>{if(!newSh.name.trim())return;updSB([...sharedBills,{id:Date.now(),name:newSh.name.trim(),total:parseFloat(newSh.total)||0,isCarGlyn:newSh.isCarGlyn}]);setNewSh({name:"",total:"",isCarGlyn:false});setAddSh(false);};
  const addGlBill=()=>{if(!newGl.name.trim())return;updGB([...glynBills,{id:Date.now(),name:newGl.name.trim(),total:parseFloat(newGl.total)||0}]);setNewGl({name:"",total:""});setAddGl(false);};
  const addCategory=(isGlyn)=>{if(!newCat.trim())return;const c={id:Date.now(),name:newCat.trim()};isGlyn?updGC([...glynCats,c]):updC([...cats,c]);setNewCat("");setAddingCat(null);};
  const delCat=(id,isGlyn)=>{
    if(isGlyn){updGC(glynCats.filter(c=>c.id!==id));const bc={...glynBillCats};Object.keys(bc).forEach(k=>{if(bc[k]===id)delete bc[k];});updGBC(bc);}
    else{updC(cats.filter(c=>c.id!==id));const bc={...billCats};Object.keys(bc).forEach(k=>{if(bc[k]===id)delete bc[k];});updBC(bc);}
  };
  const renCat=(id,name,isGlyn)=>{isGlyn?updGC(glynCats.map(c=>c.id===id?{...c,name}:c)):updC(cats.map(c=>c.id===id?{...c,name}:c));};
  const drop=(catId,isGlyn)=>{
    if(dragBill.current==null)return;
    if(isGlyn){const bc={...glynBillCats};catId===null?delete bc[dragBill.current]:(bc[dragBill.current]=catId);updGBC(bc);}
    else{const bc={...billCats};catId===null?delete bc[dragBill.current]:(bc[dragBill.current]=catId);updBC(bc);}
    dragBill.current=null;setDragOver(null);
  };

  const card={background:"#141824",borderRadius:10,border:"1px solid #1e2535",padding:"14px 12px"};
  const hdr={fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:6};
  const inp={background:"#1e2535",border:"1px solid #2a3050",borderRadius:6,color:"#e8eaf0",fontSize:13,padding:"8px 10px",width:"100%",boxSizing:"border-box"};
  const numI={...inp,textAlign:"right",fontWeight:700};
  const row={display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #1a1f2e",fontSize:12};

  const allSorted=useMemo(()=>sortH(history),[history]);

  return (
    <div style={{minHeight:"100vh",background:"#0d0f14",color:"#e8eaf0",fontFamily:"'DM Sans','Segoe UI',sans-serif",paddingBottom:80}}>

      <div style={{background:"linear-gradient(135deg,#1a1f2e,#0d1117)",borderBottom:"1px solid #1e2535",padding:"16px 14px 0",position:"sticky",top:0,zIndex:100}}>
        <div style={{textAlign:"center",marginBottom:2}}>
          <h1 style={{margin:0,fontSize:22,fontWeight:800,color:"#fff",letterSpacing:3}}>
            <span style={{color:"#4a9eff"}}>V</span>AULTED
          </h1>
          <p style={{margin:"2px 0 12px",fontSize:10,color:"#5a6480"}}>{history.length} payslips tracked</p>
        </div>
        <div style={{display:"flex",gap:2,overflowX:"auto",justifyContent:"center"}}>
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

        {tab==="Dashboard"&&(
          <div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              {[
                {label:"Est. Net Pay",    value:fmt(cr.net),      sub:"from Pay Calc",      accent:"#4a9eff"},
                {label:"Monthly Surplus", value:fmt(surplus),     sub:"after all bills",    accent:surplus>=0?"#00c88c":"#ff4a6a"},
                {label:"Latest Gross",    value:fmt(latest?.gross),sub:latest?.month,       accent:"#7c6fff"},
                {label:"FY Avg Net",      value:fmt(ts.avgNet),   sub:"Apr to now",         accent:"#ffb84a"},
              ].map(k=>(
                <div key={k.label} style={{...card,textAlign:"center"}}>
                  <div style={hdr}>{k.label}</div>
                  <div style={{fontSize:20,fontWeight:700,color:k.accent}}>{k.value}</div>
                  <div style={{fontSize:10,color:"#3a4460",marginTop:2}}>{k.sub}</div>
                </div>
              ))}
            </div>

            <div style={{...card,marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <span style={{fontSize:11,fontWeight:600,color:"#8892b0"}}>Net Pay Trend</span>
                <div style={{display:"flex",gap:3}}>
                  {RANGES.map(r=>(
                    <button key={r} onClick={()=>setChartRange(r)} style={{
                      background:chartRange===r?"#4a9eff":"#1e2535",color:chartRange===r?"#fff":"#3a4460",
                      border:"none",borderRadius:4,padding:"3px 7px",fontSize:10,fontWeight:600,cursor:"pointer"
                    }}>{r}</button>
                  ))}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2535"/>
                  <XAxis dataKey="month" tick={{fill:"#3a4460",fontSize:8}} tickLine={false} interval={Math.max(0,Math.floor(chartData.length/7)-1)}/>
                  <YAxis tick={{fill:"#3a4460",fontSize:8}} tickLine={false} tickFormatter={v=>"£"+v}/>
                  <Tooltip contentStyle={{background:"#1a1f2e",border:"1px solid #2a3050",borderRadius:6,color:"#e8eaf0",fontSize:11}} formatter={v=>fmt(v)}/>
                  <Line type="monotone" dataKey="net" stroke="#4a9eff" strokeWidth={2} dot={false} name="Net Pay"/>
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{...card,marginBottom:14}}>
              <div style={{...hdr,marginBottom:12}}>Monthly Budget Summary</div>
              {[
                ["Est. Net Pay",          fmt(cr.net),      "#4a9eff"],
                ["Shared Bills (my half)",fmt(shGlyn),      "#ff6b8a"],
                ["My Personal Bills",     fmt(glOnly),      "#ff8c4a"],
                ["Total Outgoings",       fmt(totalOut),    "#ff4a6a"],
                ["Monthly Surplus",       fmt(surplus),     surplus>=0?"#00c88c":"#ff4a6a"],
              ].map(([l,v,c])=>(
                <div key={l} style={row}><span style={{color:"#8892b0"}}>{l}</span><span style={{fontWeight:700,color:c}}>{v}</span></div>
              ))}
            </div>

            <div style={{...card,marginBottom:14}}>
              <div style={{...hdr,marginBottom:12}}>All-Time Totals</div>
              {[
                ["Total Earned (Gross)", fmt(ts.gross), "#7c6fff"],
                ["Total Net Received",   fmt(ts.net),   "#4a9eff"],
                ["Total Tax Paid",       fmt(ts.tax),   "#ff6b8a"],
                ["Total NI Paid",        fmt(ts.ni),    "#ff8c4a"],
                ["Total NEST",           fmt(ts.nest),  "#00c88c"],
                ["Total Student Loan",   fmt(ts.sl),    "#ffb84a"],
                ["Total Bonuses",        fmt(ts.bonus), "#c84aff"],
                ["Total Overtime Pay",   fmt(ts.ot),    "#4affd4"],
              ].map(([l,v,c])=>(
                <div key={l} style={row}><span style={{color:"#8892b0"}}>{l}</span><span style={{fontSize:12,fontWeight:700,color:c}}>{v}</span></div>
              ))}
            </div>

            <div style={{...hdr,marginBottom:8}}>Historical Charts — tap to expand</div>
            {[
              {title:"Gross Pay",    key:"gross", color:"#7c6fff"},
              {title:"Net Pay",      key:"net",   color:"#4a9eff"},
              {title:"Tax Paid",     key:"tax",   color:"#ff6b8a"},
              {title:"NI Paid",      key:"ni",    color:"#ff8c4a"},
              {title:"NEST Pension", key:"nest",  color:"#00c88c"},
              {title:"Student Loan", key:"sl",    color:"#ffb84a"},
              {title:"Bonus",        key:"bonus", color:"#c84aff"},
              {title:"Overtime Pay", key:"ot",    color:"#4affd4"},
            ].map(c=>(
              <CollapsibleChart key={c.key} title={c.title} data={allSorted} dataKey={c.key} color={c.color}/>
            ))}
          </div>
        )}

        {tab==="Budget"&&(
          <div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
              {[
                {label:"Shared (my half)",value:fmt(shGlyn),  accent:"#4a9eff"},
                {label:"My Bills",         value:fmt(glOnly), accent:"#ff8c4a"},
                {label:"Surplus",          value:fmt(surplus),accent:surplus>=0?"#00c88c":"#ff4a6a"},
              ].map(k=>(
                <div key={k.label} style={{...card,textAlign:"center",padding:"10px 6px"}}>
                  <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>{k.label}</div>
                  <div style={{fontSize:15,fontWeight:700,color:k.accent}}>{k.value}</div>
                </div>
              ))}
            </div>

            <div style={{display:"flex",gap:4,marginBottom:12}}>
              {[["shared","Shared Bills"],["glyn","My Bills"]].map(([v,l])=>(
                <button key={v} onClick={()=>setBudTab(v)} style={{
                  flex:1,background:budTab===v?"#4a9eff":"#141824",color:budTab===v?"#fff":"#5a6480",
                  border:"1px solid "+(budTab===v?"#4a9eff":"#1e2535"),borderRadius:8,padding:"9px",fontSize:12,fontWeight:600,cursor:"pointer"
                }}>{l}</button>
              ))}
            </div>

            {budTab==="shared"&&(
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:10,color:"#3a4460",fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Categories</span>
                  <button onClick={()=>setAddingCat("shared")} style={{background:"#141824",border:"1px solid #1e2535",borderRadius:6,color:"#00c88c",fontSize:11,fontWeight:600,padding:"5px 10px",cursor:"pointer"}}>+ New</button>
                </div>
                {addingCat==="shared"&&(
                  <div style={{display:"flex",gap:6,marginBottom:10}}>
                    <input autoFocus placeholder="Category name..." value={newCat} onChange={e=>setNewCat(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCategory(false)} style={{...inp,flex:1,padding:"6px 8px",fontSize:12}}/>
                    <button onClick={()=>addCategory(false)} style={{background:"#00c88c",border:"none",borderRadius:6,color:"#000",fontWeight:700,fontSize:12,padding:"6px 12px",cursor:"pointer"}}>Add</button>
                    <button onClick={()=>{setAddingCat(null);setNewCat("");}} style={{background:"#1e2535",border:"none",borderRadius:6,color:"#5a6480",fontSize:12,padding:"6px 10px",cursor:"pointer"}}>✕</button>
                  </div>
                )}
                <div style={{display:"grid",gridTemplateColumns:"1fr 70px 64px 64px 26px",padding:"8px 10px",background:"#0d1117",borderRadius:"8px 8px 0 0",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:1,textTransform:"uppercase",border:"1px solid #1e2535",borderBottom:"none"}}>
                  <span>Bill</span><span style={{textAlign:"right"}}>Total</span><span style={{textAlign:"right"}}>Glyn</span><span style={{textAlign:"right"}}>Hollie</span><span></span>
                </div>
                {cats.map(cat=>(
                  <CatSection key={cat.id} cat={cat} bills={sharedBills} billCats={billCats} isGlynOnly={false}
                    editingBill={editSh} setEditingBill={setEditSh} onBillBlur={hSB} onBillDelete={delSh}
                    onCatDelete={id=>delCat(id,false)} onCatRename={(id,n)=>renCat(id,n,false)}
                    dragBill={dragBill} setDragOver={setDragOver} dragOver={dragOver} onDrop={id=>drop(id,false)}/>
                ))}
                {(()=>{const u=sharedBills.filter(b=>!billCats[b.id]);if(!u.length)return null;return(
                  <div onDragOver={e=>{e.preventDefault();setDragOver("ush");}} onDragLeave={()=>setDragOver(null)} onDrop={()=>drop(null,false)}
                    style={{border:"1px solid "+(dragOver==="ush"?"#4a9eff":"#1e2535"),borderTop:"none"}}>
                    <div style={{padding:"8px 10px",background:dragOver==="ush"?"#0d1525":"#0f1520"}}><span style={{fontSize:10,fontWeight:700,color:"#3a4460",textTransform:"uppercase",letterSpacing:1}}>Uncategorised</span></div>
                    {u.map((b,i)=><BillRow key={b.id} bill={b} idx={i} isGlynOnly={false} editing={editSh===b.id} onEditStart={()=>setEditSh(b.id)} onEditBlur={v=>hSB(b.id,v)} onDelete={()=>delSh(b.id)} onDragStart={()=>{dragBill.current=b.id;}}/>)}
                  </div>
                );})()}
                {addSh&&(
                  <div style={{border:"1px solid #00c88c",borderTop:"none",background:"#0a1a10",padding:12}}>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 90px",gap:6,marginBottom:6}}>
                      <input autoFocus placeholder="Bill name" value={newSh.name} onChange={e=>setNewSh(r=>({...r,name:e.target.value}))} style={{...inp,padding:"6px 8px",fontSize:12}}/>
                      <input placeholder="£ Total" type="number" value={newSh.total} onChange={e=>setNewSh(r=>({...r,total:e.target.value}))} style={{...inp,padding:"6px 8px",fontSize:12,textAlign:"right"}}/>
                    </div>
                    <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"#8892b0",marginBottom:10,cursor:"pointer"}}>
                      <input type="checkbox" checked={newSh.isCarGlyn} onChange={e=>setNewSh(r=>({...r,isCarGlyn:e.target.checked}))}/>
                      Car exception (Hollie pays £{HOLLIE_CAR}, Glyn pays rest)
                    </label>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={addShBill} style={{flex:1,background:"#00c88c",border:"none",borderRadius:6,color:"#000",fontWeight:700,fontSize:12,padding:"8px",cursor:"pointer"}}>Add Bill</button>
                      <button onClick={()=>setAddSh(false)} style={{background:"#1e2535",border:"none",borderRadius:6,color:"#5a6480",fontSize:12,padding:"8px 12px",cursor:"pointer"}}>Cancel</button>
                    </div>
                  </div>
                )}
                <div style={{display:"grid",gridTemplateColumns:"1fr 70px 64px 64px 26px",padding:"10px 10px",fontSize:11,fontWeight:700,background:"#141824",border:"1px solid #1e2535",borderTop:"1px solid #2a3050"}}>
                  <span style={{color:"#5a6480"}}>TOTAL</span>
                  <span style={{textAlign:"right",color:"#5a6480"}}>{fmt(sharedBills.reduce((s,b)=>s+b.total,0))}</span>
                  <span style={{textAlign:"right",color:"#4a9eff"}}>{fmt(shGlyn)}</span>
                  <span style={{textAlign:"right",color:"#c84aff"}}>{fmt(shHollie)}</span>
                  <span></span>
                </div>
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  <button onClick={()=>setAddSh(true)} style={{flex:1,background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#00c88c",fontSize:12,fontWeight:600,padding:"10px",cursor:"pointer"}}>+ Add Bill</button>
                  <button onClick={()=>{updSB(INITIAL_SHARED_BILLS);updC([]);updBC({});}} style={{background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#3a4460",fontSize:11,padding:"10px 12px",cursor:"pointer"}}>Reset</button>
                </div>
                <p style={{fontSize:10,color:"#3a4460",marginTop:8,textAlign:"center"}}>Tap Total to edit · Drag to categorise · Double-tap category to rename</p>
              </div>
            )}

            {budTab==="glyn"&&(
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:10,color:"#3a4460",fontWeight:700,textTransform:"uppercase",letterSpacing:1}}>Categories</span>
                  <button onClick={()=>setAddingCat("glyn")} style={{background:"#141824",border:"1px solid #1e2535",borderRadius:6,color:"#00c88c",fontSize:11,fontWeight:600,padding:"5px 10px",cursor:"pointer"}}>+ New</button>
                </div>
                {addingCat==="glyn"&&(
                  <div style={{display:"flex",gap:6,marginBottom:10}}>
                    <input autoFocus placeholder="Category name..." value={newCat} onChange={e=>setNewCat(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCategory(true)} style={{...inp,flex:1,padding:"6px 8px",fontSize:12}}/>
                    <button onClick={()=>addCategory(true)} style={{background:"#00c88c",border:"none",borderRadius:6,color:"#000",fontWeight:700,fontSize:12,padding:"6px 12px",cursor:"pointer"}}>Add</button>
                    <button onClick={()=>{setAddingCat(null);setNewCat("");}} style={{background:"#1e2535",border:"none",borderRadius:6,color:"#5a6480",fontSize:12,padding:"6px 10px",cursor:"pointer"}}>✕</button>
                  </div>
                )}
                <div style={{display:"grid",gridTemplateColumns:"1fr 80px 26px",padding:"8px 10px",background:"#0d1117",borderRadius:"8px 8px 0 0",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:1,textTransform:"uppercase",border:"1px solid #ff8c4a",borderBottom:"none"}}>
                  <span>Bill</span><span style={{textAlign:"right"}}>Amount</span><span></span>
                </div>
                {glynCats.map(cat=>(
                  <CatSection key={cat.id} cat={cat} bills={glynBills} billCats={glynBillCats} isGlynOnly={true}
                    editingBill={editGl} setEditingBill={setEditGl} onBillBlur={hGB} onBillDelete={delGl}
                    onCatDelete={id=>delCat(id,true)} onCatRename={(id,n)=>renCat(id,n,true)}
                    dragBill={dragBill} setDragOver={setDragOver} dragOver={dragOver} onDrop={id=>drop(id,true)}/>
                ))}
                {(()=>{const u=glynBills.filter(b=>!glynBillCats[b.id]);if(!u.length)return null;return(
                  <div onDragOver={e=>{e.preventDefault();setDragOver("ugl");}} onDragLeave={()=>setDragOver(null)} onDrop={()=>drop(null,true)}
                    style={{border:"1px solid "+(dragOver==="ugl"?"#4a9eff":"#ff8c4a"),borderTop:"none"}}>
                    <div style={{padding:"8px 10px",background:dragOver==="ugl"?"#0d1525":"#0f1520"}}><span style={{fontSize:10,fontWeight:700,color:"#ff8c4a",textTransform:"uppercase",letterSpacing:1}}>Uncategorised</span></div>
                    {u.map((b,i)=><BillRow key={b.id} bill={b} idx={i} isGlynOnly={true} editing={editGl===b.id} onEditStart={()=>setEditGl(b.id)} onEditBlur={v=>hGB(b.id,v)} onDelete={()=>delGl(b.id)} onDragStart={()=>{dragBill.current=b.id;}}/>)}
                  </div>
                );})()}
                {addGl&&(
                  <div style={{border:"1px solid #00c88c",borderTop:"none",background:"#0a1a10",padding:12}}>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 90px",gap:6,marginBottom:10}}>
                      <input autoFocus placeholder="Bill name" value={newGl.name} onChange={e=>setNewGl(r=>({...r,name:e.target.value}))} style={{...inp,padding:"6px 8px",fontSize:12}}/>
                      <input placeholder="£ Total" type="number" value={newGl.total} onChange={e=>setNewGl(r=>({...r,total:e.target.value}))} style={{...inp,padding:"6px 8px",fontSize:12,textAlign:"right"}}/>
                    </div>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={addGlBill} style={{flex:1,background:"#00c88c",border:"none",borderRadius:6,color:"#000",fontWeight:700,fontSize:12,padding:"8px",cursor:"pointer"}}>Add Bill</button>
                      <button onClick={()=>setAddGl(false)} style={{background:"#1e2535",border:"none",borderRadius:6,color:"#5a6480",fontSize:12,padding:"8px 12px",cursor:"pointer"}}>Cancel</button>
                    </div>
                  </div>
                )}
                <div style={{display:"grid",gridTemplateColumns:"1fr 80px 26px",padding:"10px 10px",fontSize:11,fontWeight:700,background:"#141824",border:"1px solid #ff8c4a",borderTop:"1px solid #2a3050"}}>
                  <span style={{color:"#5a6480"}}>TOTAL</span>
                  <span style={{textAlign:"right",color:"#ff8c4a"}}>{fmt(glOnly)}</span>
                  <span></span>
                </div>
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  <button onClick={()=>setAddGl(true)} style={{flex:1,background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#00c88c",fontSize:12,fontWeight:600,padding:"10px",cursor:"pointer"}}>+ Add Bill</button>
                  <button onClick={()=>{updGB(INITIAL_GLYN_BILLS);updGC([]);updGBC({});}} style={{background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#3a4460",fontSize:11,padding:"10px 12px",cursor:"pointer"}}>Reset</button>
                </div>
                <p style={{fontSize:10,color:"#3a4460",marginTop:8,textAlign:"center"}}>Tap amount to edit · Drag to categorise · Double-tap category to rename</p>
              </div>
            )}
          </div>
        )}

        {tab==="Pay Calc"&&(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div style={{...card,background:"linear-gradient(135deg,#0a1525,#0d1117)",border:"1px solid #4a9eff"}}>
              <div style={{textAlign:"center",marginBottom:14}}>
                <div style={{fontSize:11,color:"#4a9eff",fontWeight:700,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>Estimated Net Pay</div>
                <div style={{fontSize:38,fontWeight:700,color:"#4a9eff"}}>{fmt(cr.net)}</div>
                <div style={{fontSize:11,color:"#3a4460",marginTop:4}}>Surplus after bills: <span style={{color:surplus>=0?"#00c88c":"#ff4a6a",fontWeight:700}}>{fmt(surplus)}</span></div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                {[["Annual Gross",fmt(cr.annualGross),"#7c6fff"],["Annual Net",fmt(cr.annualNet),"#4a9eff"],["Annual Tax",fmt(cr.annualTax),"#ff6b8a"],["Annual NI",fmt(cr.annualNI),"#ff8c4a"]].map(([l,v,c])=>(
                  <div key={l} style={{background:"#0d1117",borderRadius:8,padding:"10px",textAlign:"center"}}>
                    <div style={{fontSize:9,color:"#5a6480",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>{l}</div>
                    <div style={{fontSize:14,fontWeight:700,color:c}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={card}>
              <div style={{...hdr,marginBottom:14}}>Inputs</div>
              <div style={{marginBottom:10}}>
                <label style={{fontSize:11,color:"#5a6480",display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <span>Standard Hours</span><span style={{color:"#3a4460"}}>{getCurrentMonthHours()}hrs this month</span>
                </label>
                <input type="number" value={ci.stdHrs} onChange={e=>setC("stdHrs",parseFloat(e.target.value)||0)} style={numI}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                <div>
                  <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>Overtime Hrs <span style={{color:"#3a4460"}}>@£{PAY.otRate}</span></label>
                  <input type="number" value={ci.otHrs} onChange={e=>setC("otHrs",parseFloat(e.target.value)||0)} style={numI}/>
                </div>
                <div>
                  <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>Weekend OT <span style={{color:"#3a4460"}}>@£{PAY.weekendOtRate}</span></label>
                  <input type="number" value={ci.weekendOtHrs} onChange={e=>setC("weekendOtHrs",parseFloat(e.target.value)||0)} style={numI}/>
                </div>
              </div>
              <div style={{marginBottom:10}}>
                <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>Performance Bonus</label>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
                  {[0,100,160,240].map(b=>(
                    <button key={b} onClick={()=>setC("bonus",b)} style={{
                      background:ci.bonus===b?"#4a9eff":"#1e2535",color:ci.bonus===b?"#fff":"#5a6480",
                      border:"1px solid "+(ci.bonus===b?"#4a9eff":"#2a3050"),borderRadius:6,padding:"5px 12px",fontSize:12,fontWeight:600,cursor:"pointer"
                    }}>{b===0?"None":fmt(b)}</button>
                  ))}
                </div>
                <input type="number" value={ci.bonus} onChange={e=>setC("bonus",parseFloat(e.target.value)||0)} style={numI}/>
              </div>
              <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#8892b0",cursor:"pointer",padding:"8px 0"}}>
                <input type="checkbox" checked={ci.perfAllowance} onChange={e=>setC("perfAllowance",e.target.checked)} style={{width:16,height:16}}/>
                Performance allowance active (+£{PAY.additionalAllowance}/hr)
              </label>
            </div>
            <div style={card}>
              <div style={{...hdr,marginBottom:12}}>Gross Breakdown</div>
              {[
                ["Standard Pay", ci.stdHrs+"hrs x £"+(ci.perfAllowance?PAY.oteRate:PAY.baseRate), fmt(cr.stdPay), "#e8eaf0"],
                ["Overtime Pay", ci.otHrs+"hrs x £"+PAY.otRate, fmt(cr.otPay), "#4affd4"],
                ["Weekend OT",   ci.weekendOtHrs+"hrs x £"+PAY.weekendOtRate, fmt(cr.wkPay), "#00c88c"],
                ["Perf. Bonus",  "", fmt(cr.bonus), "#ffb84a"],
              ].map(([l,sub,v,c])=>(
                <div key={l} style={{...row,flexDirection:"column",gap:2}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:"#8892b0"}}>{l}</span><span style={{fontWeight:700,color:c}}>{v}</span></div>
                  {sub&&<span style={{fontSize:10,color:"#3a4460"}}>{sub}</span>}
                </div>
              ))}
              <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",borderTop:"1px solid #2a3050",marginTop:4}}>
                <span style={{color:"#e8eaf0",fontWeight:700}}>Total Gross</span>
                <span style={{fontSize:16,fontWeight:700,color:"#7c6fff"}}>{fmt(cr.gross)}</span>
              </div>
            </div>
            <div style={card}>
              <div style={{...hdr,marginBottom:12}}>Deductions</div>
              {[
                ["Income Tax (20%)",  "Tax-free: "+fmt(PAY.taxFreeMonthly)+"/mo", fmt(cr.tax),  "#ff6b8a"],
                ["National Insurance","8% to £4,189 | 2% above",                  fmt(cr.ni),   "#ff8c4a"],
                ["NEST Pension (5%)", "On qualifying earnings",                    fmt(cr.nest), "#ffb84a"],
                ["Student Loan P2",   "9% above £2,372/mo",                        fmt(cr.sl),   "#c84aff"],
              ].map(([l,sub,v,c])=>(
                <div key={l} style={{...row,flexDirection:"column",gap:2}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:"#8892b0"}}>{l}</span><span style={{fontWeight:700,color:c}}>-{v}</span></div>
                  <span style={{fontSize:10,color:"#3a4460"}}>{sub}</span>
                </div>
              ))}
              <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",borderTop:"1px solid #2a3050",marginTop:4}}>
                <span style={{color:"#e8eaf0",fontWeight:700}}>Total Deductions</span>
                <span style={{fontSize:16,fontWeight:700,color:"#ff4a6a"}}>-{fmt(cr.deductions)}</span>
              </div>
            </div>
          </div>
        )}

        {tab==="Pay Info"&&(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div style={card}>
              <div style={{...hdr,marginBottom:14}}>Pay Rates</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                {[
                  {label:"Base Rate",  value:"£"+PAY.baseRate+"/hr",      sub:"Standard hours",    accent:"#4a9eff"},
                  {label:"OTE Rate",   value:"£"+PAY.oteRate+"/hr",        sub:"+ perf. allowance", accent:"#00c88c"},
                  {label:"Overtime",   value:"£"+PAY.otRate+"/hr",         sub:"Weekday OT",        accent:"#4affd4"},
                  {label:"Weekend OT", value:"£"+PAY.weekendOtRate+"/hr",  sub:"Weekend OT",        accent:"#ffb84a"},
                ].map(k=>(
                  <div key={k.label} style={{background:"#0d1117",borderRadius:8,padding:"10px",textAlign:"center"}}>
                    <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:5}}>{k.label}</div>
                    <div style={{fontSize:18,fontWeight:700,color:k.accent}}>{k.value}</div>
                    <div style={{fontSize:10,color:"#3a4460",marginTop:2}}>{k.sub}</div>
                  </div>
                ))}
              </div>
              <div style={{background:"#0d1117",borderRadius:8,padding:"10px 12px",display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:12,color:"#5a6480"}}>This Month's Hours</span>
                <span style={{fontSize:12,fontWeight:700,color:"#e8eaf0"}}>{getCurrentMonthHours()}hrs</span>
              </div>
            </div>
            <div style={card}>
              <div style={{...hdr,marginBottom:12}}>Employment Details</div>
              {[
                ["Employer",           "JLI Trading Limited"],
                ["Tax Code",           PAY.taxCode],
                ["NI Category",        PAY.niCategory],
                ["NEST Pension",       "5% employee contribution"],
                ["Student Loan",       "Plan 2 (30-year write-off)"],
                ["Tax-Free Allowance", fmt(PAY.taxFreeMonthly)+"/mo"],
              ].map(([l,v])=>(
                <div key={l} style={row}><span style={{color:"#5a6480"}}>{l}</span><span style={{color:"#e8eaf0",fontWeight:600,textAlign:"right",maxWidth:"55%"}}>{v}</span></div>
              ))}
            </div>
            <div style={card}>
              <div style={{...hdr,marginBottom:4}}>Performance Bonus Tiers</div>
              <p style={{fontSize:11,color:"#3a4460",marginBottom:14}}>Based on team average performance % each month</p>
              {PAY.bonusTiers.map((tier,i)=>{
                const colors=["#3a4460","#4a9eff","#7c6fff","#c84aff","#ffb84a","#00c88c"];
                return(
                  <div key={tier.label} style={{background:"#0d1117",borderRadius:8,padding:"10px 14px",borderLeft:"3px solid "+colors[i],marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
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
                <div style={{fontSize:12,color:"#8892b0",lineHeight:1.6}}>When team hits <span style={{color:"#e8eaf0",fontWeight:600}}>99.96%+</span>, an extra <span style={{color:"#00c88c",fontWeight:700}}>£{PAY.additionalAllowance}/hr</span> is added the following month.</div>
              </div>
            </div>
            <div style={card}>
              <div style={{...hdr,marginBottom:12}}>Recent Bonus History</div>
              {history.slice(-10).reverse().map(r=>(
                <div key={r.month} style={row}>
                  <span style={{color:"#5a6480"}}>{r.month}</span>
                  <span style={{fontWeight:600,color:r.bonus>=240?"#00c88c":r.bonus>=200?"#ffb84a":r.bonus>=160?"#7c6fff":r.bonus>0?"#4a9eff":"#3a4460"}}>{r.bonus>0?fmt(r.bonus):"—"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab==="Payslips"&&(
          <div>
            <div style={{...card,padding:0,overflow:"hidden",marginBottom:10}}>
              <div style={{display:"grid",gridTemplateColumns:"70px 1fr 1fr 1fr 1fr 1fr",padding:"10px",background:"#0d1117",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:1,textTransform:"uppercase"}}>
                <span>Month</span>
                <span style={{textAlign:"right"}}>Gross</span><span style={{textAlign:"right"}}>Net</span>
                <span style={{textAlign:"right"}}>Tax</span><span style={{textAlign:"right"}}>NI</span><span style={{textAlign:"right"}}>NEST</span>
              </div>
              <div style={{maxHeight:"50vh",overflowY:"auto"}}>
                {[...history].reverse().map((r,i)=>(
                  <div key={r.month} style={{display:"grid",gridTemplateColumns:"70px 1fr 1fr 1fr 1fr 1fr",padding:"8px 10px",fontSize:10,background:i%2===0?"#141824":"#111520",borderBottom:"1px solid #1a1f2e"}}>
                    <span style={{fontWeight:600,color:"#8892b0"}}>{r.month}</span>
                    <span style={{textAlign:"right",color:"#7c6fff"}}>{fmt(r.gross)}</span>
                    <span style={{textAlign:"right",color:"#4a9eff",fontWeight:700}}>{fmt(r.net)}</span>
                    <span style={{textAlign:"right",color:"#ff6b8a"}}>{fmt(r.tax)}</span>
                    <span style={{textAlign:"right",color:"#ff8c4a"}}>{fmt(r.ni)}</span>
                    <span style={{textAlign:"right",color:"#00c88c"}}>{fmt(r.nest)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{...card,padding:0,overflow:"hidden",marginBottom:10}}>
              <div style={{display:"grid",gridTemplateColumns:"70px 1fr 1fr 1fr",padding:"10px",background:"#0d1117",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:1,textTransform:"uppercase"}}>
                <span>Month</span><span style={{textAlign:"right"}}>St. Loan</span><span style={{textAlign:"right"}}>Bonus</span><span style={{textAlign:"right"}}>Overtime</span>
              </div>
              <div style={{maxHeight:"50vh",overflowY:"auto"}}>
                {[...history].reverse().map((r,i)=>(
                  <div key={r.month} style={{display:"grid",gridTemplateColumns:"70px 1fr 1fr 1fr",padding:"8px 10px",fontSize:10,background:i%2===0?"#141824":"#111520",borderBottom:"1px solid #1a1f2e"}}>
                    <span style={{fontWeight:600,color:"#8892b0"}}>{r.month}</span>
                    <span style={{textAlign:"right",color:"#ffb84a"}}>{r.sl>0?fmt(r.sl):"—"}</span>
                    <span style={{textAlign:"right",color:"#c84aff"}}>{r.bonus>0?fmt(r.bonus):"—"}</span>
                    <span style={{textAlign:"right",color:"#4affd4"}}>{r.ot>0?fmt(r.ot):"—"}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{...card,display:"grid",gridTemplateColumns:"70px 1fr 1fr 1fr 1fr 1fr",fontSize:10,fontWeight:700}}>
              <span style={{color:"#5a6480"}}>TOTALS</span>
              <span style={{textAlign:"right",color:"#7c6fff"}}>{fmt(ts.gross)}</span>
              <span style={{textAlign:"right",color:"#4a9eff"}}>{fmt(ts.net)}</span>
              <span style={{textAlign:"right",color:"#ff6b8a"}}>{fmt(ts.tax)}</span>
              <span style={{textAlign:"right",color:"#ff8c4a"}}>{fmt(ts.ni)}</span>
              <span style={{textAlign:"right",color:"#00c88c"}}>{fmt(ts.nest)}</span>
            </div>
          </div>
        )}

        {tab==="Upload"&&(
          <div style={{...card,textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:10}}>📄</div>
            <h2 style={{margin:"0 0 6px",fontSize:16,color:"#e8eaf0"}}>Upload Payslip</h2>
            <p style={{fontSize:12,color:"#5a6480",marginBottom:24}}>Select a payslip PDF. Pay Calc will update automatically with the latest bonus and allowance.</p>
            <label style={{display:"block",background:"#0d1117",border:"2px dashed #2a3050",borderRadius:10,padding:"24px 16px",cursor:"pointer"}}>
              <input type="file" accept=".pdf" onChange={handleUpload} style={{display:"none"}} disabled={uploading}/>
              {uploading
                ?<div><div style={{fontSize:20,marginBottom:6}}>⏳</div><div style={{color:"#4a9eff",fontSize:13}}>Reading payslip…</div></div>
                :<div><div style={{fontSize:20,marginBottom:6}}>☁️</div><div style={{color:"#4a9eff",fontSize:13,fontWeight:600}}>Tap to select PDF</div></div>
              }
            </label>
            {uploadErr&&<div style={{marginTop:16,padding:"12px",background:"#2a0f15",border:"1px solid #5a1a2a",borderRadius:8,color:"#ff6b8a",fontSize:12}}>⚠ {uploadErr}</div>}
            {uploadRes&&pending&&(
              <div style={{marginTop:16,padding:16,background:"#0a1a10",border:"1px solid #1a4030",borderRadius:10,textAlign:"left"}}>
                <div style={{fontSize:11,fontWeight:700,color:"#00c88c",letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>✓ Extracted</div>
                {[["Month",pending.month],["Date",pending.date],["Gross",fmt(pending.gross)],["Net",fmt(pending.net)],["Tax",fmt(pending.tax)],["NI",fmt(pending.ni)],["NEST",fmt(pending.nest)],["Student Loan",fmt(pending.sl)],["Bonus",fmt(pending.bonus)],["Overtime",fmt(pending.ot)]].map(([l,v])=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid #1a2a20",fontSize:12}}>
                    <span style={{color:"#5a8070"}}>{l}</span><span style={{color:"#e8eaf0",fontWeight:600}}>{v}</span>
                  </div>
                ))}
                <div style={{display:"flex",gap:8,marginTop:14}}>
                  <button onClick={confirmAdd} style={{flex:1,background:"#00c88c",color:"#000",border:"none",borderRadius:8,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer"}}>Add to History</button>
                  <button onClick={()=>{setPending(null);setUploadRes(null);}} style={{flex:1,background:"#1e2535",color:"#8892b0",border:"none",borderRadius:8,padding:"10px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Discard</button>
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
