import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";
import { createClient } from "@supabase/supabase-js";

// Module-level error catcher -- only fires if React fails to mount.
// Once App renders, the ErrorBoundary takes over.
(function setupGlobalErrorHandler() {
  const showError = (title, details) => {
    const root = document.getElementById("root");
    if (root && root.children.length === 0) {
      root.innerHTML = `<div style="background:#0d0f14;color:#ff6b8a;padding:20px;font-family:monospace;min-height:100vh;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all;">
        <div style="font-size:32px;margin-bottom:16px;">💥</div>
        <div style="color:#fff;font-size:18px;margin-bottom:12px;">${title}</div>
        <div style="background:#1a0a0a;padding:14px;border-radius:8px;border:1px solid #5a1a2a;">${details}</div>
      </div>`;
    }
  };
  window.addEventListener("error", (e) =>
    showError("Vaulted failed to load",
      `<strong>Error:</strong> ${e.message || "Unknown"}<br>
       <strong>Source:</strong> ${e.filename || "Unknown"}<br>
       <strong>Line:</strong> ${e.lineno || "?"}:${e.colno || "?"}<br><br>
       <strong>Stack:</strong><br>${(e.error && e.error.stack) || "No stack trace"}`
    )
  );
  window.addEventListener("unhandledrejection", (e) =>
    showError("Vaulted promise rejected",
      `${e.reason && e.reason.message ? e.reason.message : String(e.reason)}<br><br>
       ${e.reason && e.reason.stack ? e.reason.stack : ""}`
    )
  );
})();

// API calls routed through Vercel serverless proxy
const API_PROXY = "/api/claude";

// Supabase client -- real connection
const SUPABASE_URL = "https://yfbarahnwcrwewtpithb.supabase.co";
const SUPABASE_KEY = "sb_publishable_ItUAbr04KIijWuO-JWgDNg_J5YCwaqK";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Headers for /api/claude calls -- include the Supabase login token so the proxy
// can reject anyone who isn't signed in.
async function authHeaders() {
  const h = { "Content-Type": "application/json" };
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session && session.access_token) h.Authorization = "Bearer " + session.access_token;
  } catch (e) {}
  return h;
}

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
  // Returns standard hours for the current pay period (29th -> 28th)
  // and uses the applicable contract hours (8h before May 2026, 8.25h after)
  const now = new Date();
  // Determine current pay period start
  let periodStart, periodEnd;
  if (now.getDate() >= 29) {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 29);
    periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 28);
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 29);
    periodEnd = new Date(now.getFullYear(), now.getMonth(), 28);
  }
  // Count working days in this period (Mon-Fri only)
  let workDays = 0;
  for (let d = new Date(periodStart); d <= periodEnd; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) workDays++;
  }
  // Use the rate config that applies to the pay month (the month containing periodEnd)
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const payMonthStr = months[periodEnd.getMonth()] + " " + periodEnd.getFullYear();
  const rate = (typeof getRateFor === "function") ? getRateFor(payMonthStr) : { stdDayHrs: 8.25 };
  return Math.round(workDays * rate.stdDayHrs * 100) / 100;
}

// Returns a key identifying the current pay period (29th -> 28th),
// e.g. "2026-06" for the period that ends 28 Jun 2026. Used to detect when a
// new pay period has begun so the Pay Calculator can reset.
function payPeriodKeyForDate(date) {
  const d = new Date(date);
  const periodEnd = d.getDate() >= 29
    ? new Date(d.getFullYear(), d.getMonth() + 1, 28)
    : new Date(d.getFullYear(), d.getMonth(), 28);
  return periodEnd.getFullYear() + "-" + String(periodEnd.getMonth() + 1).padStart(2, "0");
}
function getCurrentPayPeriodKey() {
  return payPeriodKeyForDate(new Date());
}

// When a saved set of Pay Calculator inputs belongs to a previous pay period,
// reset the variable fields (OT, weekend OT, holiday) to 0 and recompute the
// standard hours for the new period. Tier settings (bonus, allowance) carry
// forward. Returns the original object unchanged if it is already current.
function applyPeriodRollover(saved) {
  if (!saved) return saved;
  const currentKey = getCurrentPayPeriodKey();
  if (saved.period === currentKey) return saved;
  return {
    ...saved,
    stdHrs: getCurrentMonthHours(),
    otHrs: 0,
    weekendOtHrs: 0,
    holidayHrs: 0,
    period: currentKey,
  };
}

// Historical pay rates -- used for retroactive calculations
// Each entry: { from: "YYYY-MM" (inclusive), baseRate, otRate, weekendOtRate, stdDayHrs, stdMonthlyHrs }
const PAY_HISTORY = [
  // Contract until April 2026: £14/hr base, 8-hour days
  { from: "2022-04", baseRate: 14.00, otRate: 17.50, weekendOtRate: 21.00, stdDayHrs: 8.00, stdMonthlyHrs: 160 },
  // From May 2026 (paid end of May): £14.50/hr base, 8.25-hour days
  { from: "2026-05", baseRate: 14.50, otRate: 18.125, weekendOtRate: 21.75, stdDayHrs: 8.25, stdMonthlyHrs: 165 },
];

// Returns the rate config that applies to a given payslip month
function getRateFor(monthStr) {
  // monthStr like "Apr 2026"
  const [mo, yr] = monthStr.split(" ");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const ymKey = yr + "-" + String(months.indexOf(mo)+1).padStart(2,"0");
  let best = PAY_HISTORY[0];
  for (const r of PAY_HISTORY) if (ymKey >= r.from) best = r;
  return best;
}

const PAY = {
  baseRate: 14.50, otRate: 18.125, weekendOtRate: 21.75,
  taxFreeMonthly: 1047.50, niPrimaryThreshold: 1048, niUpperThreshold: 4189,
  slThreshold: 2372, nestRate: 0.05, taxCode: "C1257L", niCategory: "A",
  bonusTiers: [
    { label: "Tier 1", range: "<80%",      bonus: 0,   allowance: 0.00 },
    { label: "Tier 2", range: "80-84.99%", bonus: 80,  allowance: 0.20 },
    { label: "Tier 3", range: "85-89.99%", bonus: 120, allowance: 0.40 },
    { label: "Tier 4", range: "90-94.99%", bonus: 160, allowance: 0.60 },
    { label: "Tier 5", range: "95-99.99%", bonus: 200, allowance: 0.80 },
    { label: "Tier 6", range: "100%+",     bonus: 240, allowance: 1.00 },
  ],
};

function getAllowanceForBonus(bonus) {
  // Find the matching tier by bonus amount; default to 0 if not found
  const tier = PAY.bonusTiers.slice().reverse().find(t => bonus >= t.bonus && t.bonus > 0);
  return tier ? tier.allowance : 0;
}

function calcPay({ stdHrs, otHrs, weekendOtHrs, holidayHrs, bonus, perfAllowance, _allowanceOverride, _rateOverride }) {
  const allowance = _allowanceOverride !== undefined
    ? _allowanceOverride
    : perfAllowance !== undefined
      ? (perfAllowance ? getAllowanceForBonus(bonus) || 1.00 : 0)
      : getAllowanceForBonus(bonus);
  // Allow historical rate override for accurate retroactive calcs
  const rates = _rateOverride || { baseRate: PAY.baseRate, otRate: PAY.otRate, weekendOtRate: PAY.weekendOtRate };
  const rate = rates.baseRate + allowance;
  // Holiday hours are paid at the same base+allowance rate as worked hours
  const holHrs = holidayHrs || 0;
  const stdPay = (stdHrs + holHrs) * rate;
  const otPay = otHrs * rates.otRate;
  const wkPay = weekendOtHrs * rates.weekendOtRate;
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

// Hollie's pay: £14.71/h, 40h/week, OT at 1.5x, no bonus. Paid last working day of the
// calendar month. Bank holidays count as normal working days; holiday hours are treated
// as worked. Pension (NEST) and student loan (Plan 2) use the same rates/thresholds as Glyn.
const HOLLIE_RATE = 14.71;
function hollieMonthHours(d) {
  const now = d || new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  let wd = 0;
  for (let x = new Date(now.getFullYear(), now.getMonth(), 1); x <= end; x.setDate(x.getDate() + 1)) {
    const dow = x.getDay();
    if (dow !== 0 && dow !== 6) wd++;
  }
  return wd * 8;
}
function calcHolliePay(otHrs) {
  const baseHours = hollieMonthHours();
  const stdPay = baseHours * HOLLIE_RATE;
  const otPay = (Number(otHrs) || 0) * (HOLLIE_RATE * 1.5);
  const gross = stdPay + otPay;
  const tax = Math.max(0, gross - PAY.taxFreeMonthly) * 0.20;
  const niLower = Math.max(0, Math.min(gross, PAY.niUpperThreshold) - PAY.niPrimaryThreshold);
  const niUpper = Math.max(0, gross - PAY.niUpperThreshold);
  const ni = niLower * 0.08 + niUpper * 0.02;
  const nest = Math.max(0, gross - 520) * PAY.nestRate;
  const sl = Math.max(0, gross - PAY.slThreshold) * 0.09;
  const deductions = tax + ni + nest + sl;
  const net = gross - deductions;
  return { baseHours, stdPay, otPay, gross, tax, ni, nest, sl, deductions, net, annualGross: gross*12, annualNet: net*12 };
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
  { month: "Sep 2022", date: "30/09/2022", gross: 2195.26, net: 1746.83, tax: 229.4,  ni: 152.01, nest: 67.02, sl: 0,  bonus: 100, ot: 342.12 },
  { month: "Dec 2022", date: "30/12/2022", gross: 2089.44, net: 1693.29, tax: 208.4,  ni: 124.97, nest: 62.78, sl: 0,  bonus: 100, ot: 149.44 },
  { month: "Jun 2023", date: "30/06/2023", gross: 2339.91, net: 1848.68, tax: 258.4,  ni: 155.03, nest: 72.8,  sl: 5,  bonus: 100, ot: 219.91 },
  { month: "Jan 2025", date: "29/01/2025", gross: 2763.27, net: 2150.31, tax: 343,    ni: 137.22, nest: 89.74, sl: 43, bonus: 200, ot: 96.6   },
  { month: "Feb 2025", date: "28/02/2025", gross: 2899.87, net: 2230.32, tax: 370.2,  ni: 148.15, nest: 95.2,  sl: 56, bonus: 200, ot: 193.2  },
  { month: "Mar 2025", date: "31/03/2025", gross: 2944.13, net: 2256.27, tax: 379.2,  ni: 151.69, nest: 96.97, sl: 60, bonus: 250, ot: 267.46 },
  { month: "Jul 2025", date: "29/07/2025", gross: 2657.41, net: 2096.36, tax: 321.8,  ni: 128.75, nest: 85.5,  sl: 25, bonus: 200, ot: 30.74  },
  { month: "Sep 2025", date: "29/09/2025", gross: 3345.11, net: 2501.93, tax: 459.4,  ni: 183.77, nest: 113.01,sl: 87, bonus: 160, ot: 259.06 },
  { month: "Dec 2025", date: "22/12/2025", gross: 2678.41, net: 2108.44, tax: 326.2,  ni: 130.43, nest: 86.34, sl: 27, bonus: 200, ot: 51.74  },
  { month: "Jan 2026", date: "29/01/2026", gross: 2798.53, net: 2179.34, tax: 350,    ni: 140.04, nest: 91.15, sl: 38, bonus: 200, ot: 85.34  },
  { month: "Feb 2026", date: "27/02/2026", gross: 3212.55, net: 2423.88, tax: 432.8,  ni: 173.16, nest: 107.71,sl: 75, bonus: 160, ot: 328.94 },
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
  { id: 12, name: "Car 🚗",             total: 416.02, isCarGlyn: true  },
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
  { id: 106, name: "Lloyds CC",      total: 91.26 },
  { id: 107, name: "Ocean CC",       total: 26.95 },
];

function billShares(b) {
  if (b.isCarGlyn) return { glyn: Math.max(0, b.total - HOLLIE_CAR), hollie: HOLLIE_CAR };
  return { glyn: b.total / 2, hollie: b.total / 2 };
}

// localStorage keys -- only truly device-local settings (Supabase has the rest)
const SK = {
  timesheets:   "vaulted_timesheets",    // legacy -- for one-time migration on first login
  tsLastUpload: "vaulted_ts_last",       // legacy -- for one-time migration on first login
  notifPerm:    "vaulted_notif_perm",    // browser notification permission (device-specific)
  tsSecret:     "vaulted_ts_secret",     // device-specific (could differ per device)
  tsLastEmail:  "vaulted_ts_last_email", // device-specific dedup tracking
  // Below kept for backward compat - falls back to defaults if missing
  cats:         "vaulted_cats",
  billCats:     "vaulted_billcats",
  glynCats:     "vaulted_gcats",
  glynBillCats: "vaulted_gbillcats",
};

// Supabase DB helpers
const db = {
  async getPayslips(userId) {
    const { data, error } = await supabase.from("payslips").select("*").eq("user_id", userId).order("date", { ascending: false });
    reportDbError("getPayslips", error);
    return (data || []).map(r => ({ month: r.month, date: r.date, gross: r.gross, net: r.net, tax: r.tax, ni: r.ni, nest: r.nest, sl: r.sl, bonus: r.bonus, ot: r.ot, weekendOt: r.weekend_ot, holidayPay: r.holiday_pay, hourlyAllowance: r.hourly_allowance, regularPay: r.regular_pay, note: r.note }));
  },
  async upsertPayslip(userId, p) {
    const { error } = await supabase.from("payslips").upsert({ user_id: userId, month: p.month, date: p.date, gross: p.gross, net: p.net, tax: p.tax, ni: p.ni, nest: p.nest, sl: p.sl, bonus: p.bonus, ot: p.ot, weekend_ot: p.weekendOt || 0, holiday_pay: p.holidayPay || 0, hourly_allowance: p.hourlyAllowance || 0, regular_pay: p.regularPay || 0, note: p.note || null }, { onConflict: "user_id,month" });
    reportDbError("upsertPayslip", error);
  },
  async deletePayslip(userId, month) {
    const { error } = await supabase.from("payslips").delete().eq("user_id", userId).eq("month", month);
    reportDbError("deletePayslip", error);
  },
  async getSharedBills() {
    const { data, error } = await supabase.from("shared_bills").select("*").order("bill_id");
    reportDbError("getSharedBills", error);
    return data || [];
  },
  async upsertSharedBill(b) {
    const { error } = await supabase.from("shared_bills").upsert({ bill_id: b.id, name: b.name, total: b.total, is_car_glyn: b.isCarGlyn || false }, { onConflict: "bill_id" });
    reportDbError("upsertSharedBill", error);
  },
  async deleteSharedBill(billId) {
    const { error } = await supabase.from("shared_bills").delete().eq("bill_id", billId);
    reportDbError("deleteSharedBill", error);
  },
  async getGlynBills(userId) {
    const { data, error } = await supabase.from("glyn_bills").select("*").eq("user_id", userId).order("bill_id");
    reportDbError("getGlynBills", error);
    return data || [];
  },
  async upsertGlynBill(userId, b) {
    const { error } = await supabase.from("glyn_bills").upsert({ user_id: userId, bill_id: b.id, name: b.name, total: b.total }, { onConflict: "user_id,bill_id" });
    reportDbError("upsertGlynBill", error);
  },
  async deleteGlynBill(userId, billId) {
    const { error } = await supabase.from("glyn_bills").delete().eq("user_id", userId).eq("bill_id", billId);
    reportDbError("deleteGlynBill", error);
  },
  async getAllPersonalBills() {
    // RLS: owner sees all personal bills, partner sees only their own. Used for owner backups.
    const { data, error } = await supabase.from("glyn_bills").select("*").order("bill_id");
    reportDbError("getAllPersonalBills", error);
    return data || [];
  },
  async getSharedSettings() {
    const { data, error } = await supabase.from("shared_settings").select("*").eq("id", 1).maybeSingle();
    if (error && error.code !== "PGRST116") reportDbError("getSharedSettings", error);
    return data;
  },
  async saveSharedSettings(cats, billCats) {
    const { error } = await supabase.from("shared_settings").upsert({ id: 1, cats, bill_cats: billCats, updated_at: new Date().toISOString() }, { onConflict: "id" });
    reportDbError("saveSharedSettings", error);
  },
  async getSettlements() {
    const { data, error } = await supabase.from("settlements").select("*").order("created_at", { ascending: false });
    reportDbError("getSettlements", error);
    return data || [];
  },
  async upsertSettlement(s) {
    const { error } = await supabase.from("settlements").upsert({ id: s.id, kind: s.kind, payer: s.payer, amount: s.amount, note: s.note, entry_date: s.entry_date, created_by: s.created_by }, { onConflict: "id" });
    reportDbError("upsertSettlement", error);
  },
  async deleteSettlement(id) {
    const { error } = await supabase.from("settlements").delete().eq("id", id);
    reportDbError("deleteSettlement", error);
  },
  async getGifts() {
    const { data, error } = await supabase.from("gifts").select("*").order("created_at", { ascending: true });
    reportDbError("getGifts", error);
    return data || [];
  },
  async upsertGift(g) {
    const { error } = await supabase.from("gifts").upsert({ id: g.id, name: g.name, dob: g.dob, birthday_year: g.birthday_year, christmas_year: g.christmas_year, notes: g.notes, cost: g.cost }, { onConflict: "id" });
    reportDbError("upsertGift", error);
  },
  async deleteGift(id) {
    const { error } = await supabase.from("gifts").delete().eq("id", id);
    reportDbError("deleteGift", error);
  },
  async getScheduledBills() {
    const { data, error } = await supabase.from("scheduled_bills").select("*").order("created_at", { ascending: true });
    reportDbError("getScheduledBills", error);
    return data || [];
  },
  async upsertScheduledBill(b) {
    const { error } = await supabase.from("scheduled_bills").upsert({ id: b.id, name: b.name, total: b.total, is_car_glyn: b.is_car_glyn, scope: b.scope, owner: b.owner, freq: b.freq, months: b.months, year: b.year }, { onConflict: "id" });
    reportDbError("upsertScheduledBill", error);
  },
  async deleteScheduledBill(id) {
    const { error } = await supabase.from("scheduled_bills").delete().eq("id", id);
    reportDbError("deleteScheduledBill", error);
  },
  async getLeaveLogs(userId) {
    const { data, error } = await supabase.from("leave_logs").select("*").eq("user_id", userId).order("date", { ascending: false });
    reportDbError("getLeaveLogs", error);
    return (data || []).map(r => ({ id: r.id, date: r.date, hours: r.hours, label: r.label }));
  },
  async upsertLeaveLog(userId, entry) {
    const { error } = await supabase.from("leave_logs").upsert({ id: entry.id, user_id: userId, date: entry.date, hours: entry.hours, label: entry.label || null });
    reportDbError("upsertLeaveLog", error);
  },
  async deleteLeaveLog(id) {
    const { error } = await supabase.from("leave_logs").delete().eq("id", id);
    reportDbError("deleteLeaveLog", error);
  },
  async getLeaveSettings(userId) {
    const { data, error } = await supabase.from("leave_settings").select("*").eq("user_id", userId).single();
    if (error && error.code !== "PGRST116") reportDbError("getLeaveSettings", error);
    return data ? { baseEntitlement: data.base_entitlement, serviceDays: data.service_days, startYear: data.start_year } : null;
  },
  async saveLeaveSettings(userId, s) {
    const { error } = await supabase.from("leave_settings").upsert({ user_id: userId, base_entitlement: s.baseEntitlement, service_days: s.serviceDays, start_year: s.startYear, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    reportDbError("saveLeaveSettings", error);
  },
  async getMonthlyTs(userId) {
    const { data, error } = await supabase.from("monthly_timesheets").select("*").eq("user_id", userId).order("saved_at", { ascending: false });
    reportDbError("getMonthlyTs", error);
    return (data || []).map(r => ({ emailId: r.email_id, period: r.period, month: r.month, totalHrs: r.total_hrs, stdHrs: r.std_hrs, otHrs: r.ot_hrs, wkndHrs: r.wknd_hrs, holHrs: r.hol_hrs, days: r.days, savedAt: r.saved_at }));
  },
  async upsertMonthlyTs(userId, entry) {
    const { error } = await supabase.from("monthly_timesheets").upsert({ user_id: userId, email_id: entry.emailId, period: entry.period, month: entry.month, total_hrs: entry.totalHrs, std_hrs: entry.stdHrs, ot_hrs: entry.otHrs, wknd_hrs: entry.wkndHrs, hol_hrs: entry.holHrs, days: entry.days, saved_at: entry.savedAt }, { onConflict: "email_id" });
    reportDbError("upsertMonthlyTs", error);
  },
  async getDiscrepancies(userId) {
    const { data, error } = await supabase.from("discrepancies").select("*").eq("user_id", userId).order("checked_at", { ascending: false });
    reportDbError("getDiscrepancies", error);
    return (data || []).map(r => ({ month: r.month, period: r.period, status: r.status, items: r.items, ts: r.ts_data, payslip: r.payslip_data, expected: r.expected_data, checkedAt: r.checked_at }));
  },
  async upsertDiscrepancy(userId, d) {
    const { error } = await supabase.from("discrepancies").upsert({ user_id: userId, month: d.month, period: d.period, status: d.status, items: d.items, ts_data: d.ts, payslip_data: d.payslip, expected_data: d.expected, checked_at: d.checkedAt }, { onConflict: "user_id,month" });
    reportDbError("upsertDiscrepancy", error);
  },
  async getScenarios(userId) {
    const { data, error } = await supabase.from("scenarios").select("*").eq("user_id", userId).order("created_at");
    reportDbError("getScenarios", error);
    return (data || []).map(r => ({ id: r.id, name: r.name, stdHrs: r.std_hrs, otHrs: r.ot_hrs, weekendOtHrs: r.weekend_ot_hrs, bonus: r.bonus, tierOverride: r.tier_override }));
  },
  async upsertScenario(userId, s) {
    const { error } = await supabase.from("scenarios").upsert({ id: s.id, user_id: userId, name: s.name, std_hrs: s.stdHrs, ot_hrs: s.otHrs, weekend_ot_hrs: s.weekendOtHrs, bonus: s.bonus, tier_override: s.tierOverride }, { onConflict: "user_id,name" });
    reportDbError("upsertScenario", error);
  },
  async deleteScenario(id) {
    const { error } = await supabase.from("scenarios").delete().eq("id", id);
    reportDbError("deleteScenario", error);
  },
  async getAppSettings(userId) {
    const { data, error } = await supabase.from("app_settings").select("*").eq("user_id", userId).single();
    if (error && error.code !== "PGRST116") reportDbError("getAppSettings", error);
    return data || null;
  },
  async saveAppSettings(userId, settings) {
    lastAppSettingsWrite = Date.now();
    const { error } = await supabase.from("app_settings").upsert({ user_id: userId, ...settings, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    reportDbError("saveAppSettings", error);
  },
  async getAccumulator(userId) {
    const { data, error } = await supabase.from("timesheet_accumulator").select("*").eq("user_id", userId).single();
    if (error && error.code !== "PGRST116") reportDbError("getAccumulator", error);
    return data ? { data: data.data, lastUpload: data.last_upload } : null;
  },
  async saveAccumulator(userId, accumulator, lastUpload) {
    const { error } = await supabase.from("timesheet_accumulator").upsert({ user_id: userId, data: accumulator, last_upload: lastUpload, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    reportDbError("saveAccumulator", error);
  },
  // Categories -- part of shared app_settings (bills are shared, so categorisations are too)
  async saveCats(userId, cats) {
    const { error } = await supabase.from("app_settings").upsert({ user_id: userId, cats_data: cats, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    reportDbError("saveCats", error);
  },
  async createBackup(userId, data, trigger = "auto") {
    const json = JSON.stringify(data);
    const { error } = await supabase.from("backups").insert({ user_id: userId, data, size_bytes: json.length, trigger });
    reportDbError("createBackup", error);
    // Prune: keep only the 30 most recent backups so the table doesn't grow forever
    try {
      const { data: old } = await supabase.from("backups").select("id").eq("user_id", userId).order("created_at", { ascending: false }).range(30, 999);
      if (old && old.length) await supabase.from("backups").delete().in("id", old.map(r => r.id));
    } catch (e) {}
  },
  async getBackups(userId, limit = 30) {
    const { data, error } = await supabase.from("backups").select("id, size_bytes, trigger, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);
    reportDbError("getBackups", error);
    return data || [];
  },
  async getBackup(backupId) {
    const { data, error } = await supabase.from("backups").select("*").eq("id", backupId).single();
    if (error && error.code !== "PGRST116") reportDbError("getBackup", error);
    return data;
  },
  async deleteBackup(backupId) {
    const { error } = await supabase.from("backups").delete().eq("id", backupId);
    reportDbError("deleteBackup", error);
  },
};

// UUID generator (browsers support crypto.randomUUID natively in modern versions)
const genUUID = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// -- Sync status tracking -----------------------------------------------------
// Global tracker for outstanding saves
let outstandingSaves = 0;
const syncListeners = new Set();
function notifySyncChange() {
  syncListeners.forEach(fn => fn(outstandingSaves));
}

// -- Supabase error surfacing -------------------------------------------------
// db methods report failures here so they can show on-screen (no devtools on mobile).
let lastDbError = null;
let lastAppSettingsWrite = 0;  // suppress our own app_settings realtime echoes (avoid clobbering live edits)
const dbErrorListeners = new Set();
function reportDbError(where, error) {
  if (!error) return;
  lastDbError = { where, message: (error && error.message) || String(error), at: Date.now() };
  try { console.error("[Supabase] " + where + ":", error.message || error); } catch (e) {}
  dbErrorListeners.forEach(fn => fn(lastDbError));
}
// trackSave accepts either a promise or a function returning a promise
async function trackSave(promiseOrFn) {
  outstandingSaves++;
  notifySyncChange();
  try {
    const p = typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn;
    return await p;
  } finally {
    outstandingSaves--;
    notifySyncChange();
  }
}

// Work out the actual payday for a given month/year (paid on 29th, adjusted)
function getPayday(year, month) {
  // Start with the 29th
  let d = new Date(year, month, 29);
  // If month has fewer than 29 days (Feb), go to last day
  if (d.getMonth() !== month) d = new Date(year, month + 1, 0);
  const dow = d.getDay();
  // Saturday -> Friday
  if (dow === 6) d.setDate(d.getDate() - 1);
  // Sunday -> Friday
  if (dow === 0) d.setDate(d.getDate() - 2);
  // Monday (possible bank holiday) -> check if it's a common UK bank holiday pattern
  // Simple approach: if Monday, shift to Friday just in case
  // (Can be refined later)
  return d;
}

// Check if accumulated timesheet data should be reset (new pay period started)
function getNextPayday() {
  const now = new Date();
  let pd = getPayday(now.getFullYear(), now.getMonth());
  if (pd <= now) pd = getPayday(now.getFullYear(), now.getMonth() + 1);
  return pd;
}

function shouldResetTimesheet(tsLastUpload) {
  // Reset when the accumulator's data belongs to an earlier pay period (29th -> 28th)
  // than the current one. Keyed to the fixed pay-period boundary, not the variable payday.
  if (!tsLastUpload) return false;
  return payPeriodKeyForDate(tsLastUpload) !== getCurrentPayPeriodKey();
}

// Check if a Monday reminder should show
function shouldShowTimesheetReminder(tsLastUpload) {
  const now = new Date();
  const day = now.getDay(); // 0=Sun,1=Mon
  if (!tsLastUpload) return true; // never uploaded
  const last = new Date(tsLastUpload);
  const daysSince = Math.floor((now - last) / (1000 * 60 * 60 * 24));
  return daysSince >= 7;
}

// Legacy key names from older builds -- migrate once then leave
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
const APP_VERSION = "1.13.38";
const PRIMARY_TABS = ["Dashboard","Budget","Pay Calc","Payslips"];
const SECONDARY_TABS = ["Pay Info","Timesheet","Tax Year","Leave","Settle Up","Gifts","Diag"];
const RANGES = ["3M","6M","12M","2Y","All"];
const SL_START_YEAR = 2019;
const SL_WRITEOFF_YEAR = 2049;

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

// Tax-year-to-date totals + a simple full-year projection (avg per payslip x 12).
// fyLabel like "2026/27". Used for the Dashboard "on track" card.
function fyTotals(history) {
  const now = new Date();
  const fyStartYear = now.getMonth()>=3 ? now.getFullYear() : now.getFullYear()-1;
  const fyStart = new Date(fyStartYear,3,1);
  const fy = history.filter(r=>{const[mo,yr]=r.month.split(" ");return new Date(parseInt(yr),MONTHS.indexOf(mo),1)>=fyStart;});
  const count = fy.length;
  const gross = fy.reduce((s,r)=>s+(r.gross||0),0);
  const net = fy.reduce((s,r)=>s+(r.net||0),0);
  return {
    count, gross, net,
    projGross: count>0 ? (gross/count)*12 : 0,
    projNet:   count>0 ? (net/count)*12   : 0,
    fyLabel: fyStartYear + "/" + String((fyStartYear+1)%100).padStart(2,"0"),
  };
}

function getMissingMonths(history) {
  if(history.length<2) return [];
  const sorted = sortH(history);
  const missing = [];
  for(let i=0;i<sorted.length-1;i++){
    const [ma,ya]=sorted[i].month.split(" ");
    const [mb,yb]=sorted[i+1].month.split(" ");
    let mo=MONTHS.indexOf(ma), yr=parseInt(ya);
    while(true){
      mo++; if(mo>11){mo=0;yr++;}
      if(yr===parseInt(yb)&&mo===MONTHS.indexOf(mb)) break;
      missing.push(MONTHS[mo]+" "+yr);
    }
  }
  return missing;
}

function groupByFY(history) {
  // Returns array of {label, months, gross, net, tax, ni, nest, sl, bonus, ot}
  const fyMap = {};
  history.forEach(r=>{
    const [mo,yr]=r.month.split(" ");
    const monthIdx=MONTHS.indexOf(mo);
    const yearNum=parseInt(yr);
    const fyYear = monthIdx>=3 ? yearNum : yearNum-1;
    const key=fyYear+"-"+(fyYear+1);
    if(!fyMap[key]) fyMap[key]={label:"Apr "+fyYear+" - Mar "+(fyYear+1),fyYear,gross:0,net:0,tax:0,ni:0,nest:0,sl:0,bonus:0,ot:0,months:0};
    fyMap[key].gross+=r.gross; fyMap[key].net+=r.net; fyMap[key].tax+=r.tax;
    fyMap[key].ni+=r.ni; fyMap[key].nest+=r.nest; fyMap[key].sl+=r.sl;
    fyMap[key].bonus+=r.bonus; fyMap[key].ot+=r.ot; fyMap[key].months++;
  });
  return Object.values(fyMap).sort((a,b)=>b.fyYear-a.fyYear);
}

function SectionLabel({children}) {
  return <div style={{fontSize:11,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>{children}</div>;
}

function StatRow({label,value,color,last}) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 0",borderBottom:last?"none":"1px solid #1a1f2e"}}>
      <span style={{fontSize:13,color:"#8892b0"}}>{label}</span>
      <span style={{fontSize:13,fontWeight:700,color:color||"#e8eaf0"}}>{value}</span>
    </div>
  );
}

// The allowance is entirely determined by the tier bonus -- they're linked.
// So inferring perfAllowance just means checking if a bonus was paid.
function inferPerfAllowance(r) {
  if (typeof r.perfAllowance === "boolean") return r.perfAllowance;
  return (r.bonus || 0) > 0;
}

function CollapsibleChart({title,data,dataKey,color}) {
  const [open,setOpen]=useState(false);
  return (
    <div style={{border:"1px solid #1e2535",borderRadius:10,overflow:"hidden",marginBottom:8}}>
      <button onClick={()=>setOpen(o=>!o)} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"13px 14px",background:"#141824",border:"none",cursor:"pointer",color:"#e8eaf0"}}>
        <span style={{fontSize:13,fontWeight:600,color:"#8892b0"}}>{title}</span>
        <span style={{fontSize:12,color:"#3a4460"}}>{open?"A":"V"}</span>
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

function BillRow({bill,idx,isGlynOnly,editing,onEditStart,onEditBlur,onDelete,onMove,onDragStart}) {
  const [val,setVal]=useState(String(bill.total));
  const sh=isGlynOnly?null:billShares(bill);
  return (
    <div draggable onDragStart={onDragStart} style={{
      display:"grid",gridTemplateColumns:isGlynOnly?"1fr 80px 26px":"1fr 70px 64px 64px 26px",
      padding:"11px 12px",fontSize:13,alignItems:"center",
      background:idx%2===0?"#161b28":"#11151f",borderBottom:"1px solid #1e2535",cursor:"grab"
    }}>
      <span onClick={onMove} style={{color:"#d8dcea",fontWeight:500,cursor:"pointer"}}>{bill.name}</span>
      {editing?(
        <input autoFocus type="number" value={val} onChange={e=>setVal(e.target.value)}
          onBlur={()=>onEditBlur(val)} onKeyDown={e=>e.key==="Enter"&&onEditBlur(val)}
          style={{background:"#1e2535",border:"1px solid #4a9eff",borderRadius:4,color:"#e8eaf0",fontSize:12,padding:"2px 4px",width:"100%",textAlign:"right"}}/>
      ):(
        <span onClick={onEditStart} style={{textAlign:"right",color:isGlynOnly?"#4a9eff":"#a8b0c4",display:"block",cursor:"pointer",borderBottom:"1px dashed #2a3050",fontWeight:600}}>
          {fmt(bill.total)}
        </span>
      )}
      {!isGlynOnly&&<><span style={{textAlign:"right",color:"#4a9eff",fontWeight:700}}>{fmt(sh.glyn)}</span><span style={{textAlign:"right",color:"#c84aff",fontWeight:700}}>{fmt(sh.hollie)}</span></>}
      <button onClick={onDelete} style={{background:"none",border:"none",color:"#5a6480",fontSize:16,cursor:"pointer",padding:"8px 4px",textAlign:"center",lineHeight:1}}>✕</button>
    </div>
  );
}

function CatSection({cat,bills,billCats,isGlynOnly,editingBill,setEditingBill,onBillBlur,onBillDelete,onBillMove,onCatDelete,onCatRename,dragBill,setDragOver,dragOver,onDrop}) {
  const [renaming,setRenaming]=useState(false);
  const [rv,setRv]=useState(cat.name);
  const cb=bills.filter(b=>billCats[b.id]===cat.id);
  const total=cb.reduce((s,b)=>s+b.total,0);
  const glynTotal=isGlynOnly?total:cb.reduce((s,b)=>s+billShares(b).glyn,0);
  return (
    <div onDragOver={e=>{e.preventDefault();setDragOver(cat.id);}} onDragLeave={()=>setDragOver(null)} onDrop={()=>onDrop(cat.id)}
      style={{border:"1px solid "+(dragOver===cat.id?"#4a9eff":(isGlynOnly?"#ff8c4a":"#1e2535")),borderTop:"none",transition:"border-color 0.15s"}}>
      <div style={{display:"grid",gridTemplateColumns:isGlynOnly?"1fr 80px 26px":"1fr 70px 64px 64px 26px",alignItems:"center",padding:"10px 12px",background:dragOver===cat.id?"#15203a":"#1a1f2e",borderBottom:"1px solid #2a3050"}}>
        {renaming?(
          <input autoFocus value={rv} onChange={e=>setRv(e.target.value)}
            onBlur={()=>{onCatRename(cat.id,rv);setRenaming(false);}}
            onKeyDown={e=>{if(e.key==="Enter"){onCatRename(cat.id,rv);setRenaming(false);}}}
            style={{background:"#1e2535",border:"1px solid #4a9eff",borderRadius:4,color:"#e8eaf0",fontSize:13,padding:"3px 6px",marginRight:8}}/>
        ):(
          <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
            <span onDoubleClick={()=>setRenaming(true)} style={{fontSize:13,fontWeight:800,color:"#fff",cursor:"text",letterSpacing:0.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title="Double-tap to rename">{cat.name}</span>
            <button onClick={()=>setRenaming(true)} style={{background:"none",border:"none",color:"#3a4460",fontSize:11,cursor:"pointer",padding:"2px 4px",flexShrink:0}}>✏️</button>
          </div>
        )}
        <span style={{textAlign:"right",fontSize:13,color:"#fff",fontWeight:800}}>{fmt(total)}</span>
        {!isGlynOnly&&<><span></span><span></span></>}
        <div style={{display:"flex",alignItems:"center",justifyContent:"center"}}>
          <button onClick={()=>onCatDelete(cat.id)} style={{background:"#2a1a1a",border:"1px solid #5a2a2a",borderRadius:4,color:"#ff6b8a",fontSize:13,fontWeight:700,cursor:"pointer",padding:"7px 6px",lineHeight:1}}>✕</button>
        </div>
      </div>
      {cb.length===0&&<div style={{padding:"10px",textAlign:"center",fontSize:11,color:"#2a3050",fontStyle:"italic"}}>Drop bills here</div>}
      {cb.map((b,i)=>(
        <BillRow key={b.id} bill={b} idx={i} isGlynOnly={isGlynOnly}
          editing={editingBill===b.id} onEditStart={()=>setEditingBill(b.id)}
          onEditBlur={v=>onBillBlur(b.id,v)} onDelete={()=>onBillDelete(b.id)}
          onMove={()=>onBillMove(b.id)}
          onDragStart={()=>{dragBill.current=b.id;}}/>
      ))}
    </div>
  );
}


// -- Haptic feedback ----------------------------------------------------------
function haptic(style = "light") {
  if (!navigator.vibrate) return;
  if (style === "light")  navigator.vibrate(8);
  if (style === "medium") navigator.vibrate(20);
  if (style === "heavy")  navigator.vibrate([30, 10, 30]);
  if (style === "success")navigator.vibrate([10, 50, 30]);
  if (style === "error")  navigator.vibrate([40, 20, 40, 20, 40]);
}

// True if the touch is inside a scrollable element that is NOT at its top --
// in that case we must let the list scroll and NOT start pull-to-refresh.
function scrollableAncestorScrolled(el) {
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const oy = getComputedStyle(node).overflowY;
      if ((oy === "auto" || oy === "scroll") && node.scrollTop > 0) return true;
    }
    node = node.parentElement;
  }
  return false;
}

// -- Annual leave helpers ------------------------------------------------------
function getLeaveYear() {
  return new Date().getFullYear(); // Jan-Dec
}

const STD_DAY_HRS = 8.25; // standard working day in hours

// Sum the calculator-relevant hours from only the days that fall in the current
// pay period (29th -> 28th). The accumulator can hold leftover days from a
// previous period, so the calculator always recomputes from in-period days.
function currentPeriodTotals(days) {
  const cur = getCurrentPayPeriodKey();
  const now = new Date();
  const inPeriod = (days || []).filter(d => {
    if (!d || !d.date) return false;
    const [dd, mm] = String(d.date).split("/").map(Number);
    if (!dd || !mm) return false;
    // day.date carries no year; infer it, handling the Dec -> Jan pay-period wrap.
    let yr = now.getFullYear();
    if (now.getMonth() === 0 && mm === 12) yr -= 1;
    else if (now.getMonth() === 11 && mm === 1) yr += 1;
    return payPeriodKeyForDate(new Date(yr, mm - 1, dd)) === cur;
  });
  const otHrs = Math.round(inPeriod.reduce((s, d) => s + (d.otHrs || 0), 0) * 100) / 100;
  const weekendOtHrs = Math.round(inPeriod.reduce((s, d) => s + (d.wkOtHrs || 0), 0) * 100) / 100;
  const holidayHrs = Math.round(inPeriod.reduce((s, d) => s + (d.isHoliday ? (d.isHalf ? STD_DAY_HRS / 2 : STD_DAY_HRS) : 0), 0) * 100) / 100;
  return { otHrs, weekendOtHrs, holidayHrs, days: inPeriod };
}

function effectiveEntitlementDays(baseEntitlement, serviceDays) {
  // Service days accumulate each year up to a cap of 6.
  // The current year's allocation kicks in on June 1st.
  // Before June 1st: only the days earned by the previous June 1st apply.
  // After June 1st: all days up to the cap apply.
  // If already at or past the cap, the cap applies all year.
  const now = new Date();
  const juneFirst = new Date(now.getFullYear(), 5, 1);
  const cap = 6;
  const earned = Math.max(0, serviceDays);
  let serviceAdded;
  if (earned >= cap) {
    serviceAdded = cap; // Capped - all year
  } else if (now >= juneFirst) {
    serviceAdded = earned; // Current year's day already kicked in
  } else {
    serviceAdded = Math.max(0, earned - 1); // Pre-June: this year's day not yet added
  }
  return baseEntitlement + serviceAdded;
}

function effectiveEntitlement(baseEntitlement, serviceDays) {
  // Returns entitlement in hours
  return Math.round(effectiveEntitlementDays(baseEntitlement, serviceDays) * STD_DAY_HRS * 100) / 100;
}

function logsForYear(logs, year) {
  return logs.filter(l => new Date(l.date).getFullYear() === year);
}

function hoursTakenInYear(logs, year) {
  return Math.round(logsForYear(logs, year).reduce((s, l) => s + (l.hours || 0), 0) * 100) / 100;
}

// -- Push notification helpers ------------------------------------------------

async function requestNotifPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  const result = await Notification.requestPermission();
  return result;
}

function sendNotification(title, body, tag) {
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, {
      body,
      tag,
      icon: "/favicon.ico",
      badge: "/favicon.ico",
    });
  } catch {}
}

// Check if tomorrow is payday
function isTomorrowPayday() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const pd = getPayday(tomorrow.getFullYear(), tomorrow.getMonth());
  return pd.toDateString() === tomorrow.toDateString();
}

// Check if a timesheet reminder should fire (Monday or 7+ days since last upload)
function shouldFireTimesheetNotif(tsLastUpload) {
  const now = new Date();
  const isMonday = now.getDay() === 1;
  if (!tsLastUpload) return isMonday;
  const daysSince = Math.floor((now - new Date(tsLastUpload)) / (1000 * 60 * 60 * 24));
  return isMonday && daysSince >= 7;
}

// -- Error Boundary -----------------------------------------------------------
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("Vaulted crash:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{minHeight:"100vh",background:"#0d0f14",color:"#e8eaf0",fontFamily:"'DM Sans',sans-serif",padding:"24px 20px"}}>
          <div style={{fontSize:32,marginBottom:16}}>💥</div>
          <h2 style={{color:"#ff6b8a",marginBottom:12}}>Vaulted crashed</h2>
          <div style={{background:"#1a0a0a",border:"1px solid #5a1a2a",borderRadius:10,padding:"14px",fontSize:12,color:"#ff8c8c",fontFamily:"monospace",wordBreak:"break-all",lineHeight:1.6,marginBottom:16}}>
            {this.state.error.toString()}
          </div>
          <button onClick={()=>this.setState({error:null})} style={{background:"#4a9eff",border:"none",borderRadius:8,color:"#000",fontWeight:700,padding:"12px 24px",cursor:"pointer",fontSize:14}}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// -- Auth helpers -------------------------------------------------------------

function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  const bg = { minHeight:"100vh", background:"#0d0f14", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", fontFamily:"'DM Sans','Segoe UI',sans-serif", padding:"24px 20px" };
  const inp = { width:"100%", boxSizing:"border-box", background:"#141824", border:"1px solid #1e2535", borderRadius:10, color:"#e8eaf0", fontSize:14, padding:"13px 14px", fontFamily:"inherit", outline:"none", marginBottom:10 };

  const handleSubmit = async () => {
    setError(""); setLoading(true);
    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setError("Check your email to confirm your account.");
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onLogin(data.user);
      }
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const handleReset = async () => {
    if (!email) { setError("Enter your email first"); return; }
    await supabase.auth.resetPasswordForEmail(email);
    setResetSent(true);
  };

  return (
    <div style={bg}>
      <div style={{fontSize:48,marginBottom:16}}>🔐</div>
      <h1 style={{margin:"0 0 4px",fontSize:22,fontWeight:800,color:"#fff",letterSpacing:3}}><span style={{color:"#4a9eff"}}>V</span>AULTED</h1>
      <p style={{color:"#5a6480",fontSize:13,marginBottom:32}}>{isSignUp ? "Create your account" : "Sign in to continue"}</p>
      {error && <div style={{color: error.includes("Check") ? "#00c88c" : "#ff6b8a",fontSize:13,marginBottom:14,background: error.includes("Check") ? "#0a1a10" : "#2a0f15",padding:"10px 16px",borderRadius:8,border:"1px solid "+(error.includes("Check")?"#1a4030":"#5a1a2a"),width:"100%",boxSizing:"border-box",textAlign:"center"}}>{error}</div>}
      {resetSent && <div style={{color:"#00c88c",fontSize:13,marginBottom:14,textAlign:"center"}}>Password reset email sent!</div>}
      <div style={{width:"100%",maxWidth:320}}>
        <input type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} style={inp} onKeyDown={e=>e.key==="Enter"&&handleSubmit()}/>
        {!resetSent && <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} style={inp} onKeyDown={e=>e.key==="Enter"&&handleSubmit()}/>}
        <button onClick={handleSubmit} disabled={loading}
          style={{width:"100%",background:"#4a9eff",border:"none",borderRadius:10,color:"#000",fontSize:15,fontWeight:700,padding:"14px",cursor:loading?"not-allowed":"pointer",marginBottom:10,opacity:loading?0.7:1}}>
          {loading ? "Please wait..." : isSignUp ? "Create Account" : "Sign In"}
        </button>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
          <button onClick={()=>{setIsSignUp(!isSignUp);setError("");}} style={{background:"none",border:"none",color:"#4a9eff",cursor:"pointer",fontSize:12}}>
            {isSignUp ? "Already have an account?" : "Create account"}
          </button>
          {!isSignUp && <button onClick={handleReset} style={{background:"none",border:"none",color:"#3a4460",cursor:"pointer",fontSize:12}}>Forgot password?</button>}
        </div>
      </div>
    </div>
  );
}

function SyncIndicator({ onClick }) {
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [dbErr, setDbErr] = useState(lastDbError);

  useEffect(() => {
    const update = (n) => setPending(n);
    syncListeners.add(update);
    setPending(outstandingSaves);
    const onDbErr = (e) => setDbErr(e);
    dbErrorListeners.add(onDbErr);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      syncListeners.delete(update);
      dbErrorListeners.delete(onDbErr);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const color = (!online || dbErr) ? "#ff4a6a" : pending > 0 ? "#ffb84a" : "#00c88c";
  const title = dbErr ? "Sync error -- see Diagnostics" : !online ? "Offline" : pending > 0 ? `Saving ${pending}...` : "Synced";

  return (
    <div onClick={onClick} title={title} style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer",padding:"6px",margin:"-6px"}}>
      <span style={{
        width:10,height:10,borderRadius:"50%",background:color,
        boxShadow:`0 0 6px ${color}`,
        transition:"background 0.3s",
        opacity: pending > 0 ? 0.7 : 1
      }}/>
    </div>
  );
}

// Temporary on-screen PWA diagnostic (no devtools needed). Shows why Chrome
// may not be offering install. Remove once the install issue is resolved.
function DiagProbe({ prompt, user }) {
  const [info, setInfo] = React.useState(null);
  const [backup, setBackup] = React.useState("checking...");
  const run = React.useCallback(async () => {
    const out = {};
    out.secure = window.isSecureContext;
    out.swSupported = "serviceWorker" in navigator;
    out.standalone = window.matchMedia("(display-mode: standalone)").matches;
    out.controller = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    out.online = navigator.onLine;
    out.host = window.location.host;
    if (navigator.serviceWorker) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        out.regCount = regs.length;
        const r = regs[0];
        out.swState = r ? (r.active ? "active" : r.waiting ? "waiting" : r.installing ? "installing" : "none") : "none";
        out.swScope = r ? r.scope : "";
      } catch (e) { out.regErr = String(e.message || e); }
    } else { out.regErr = "serviceWorker unavailable"; }
    try {
      const m = await fetch("/manifest.json", { cache: "no-store" });
      out.manifestStatus = m.status;
      const mj = await m.json();
      out.iconCount = (mj.icons || []).length;
    } catch (e) { out.manifestErr = String(e.message || e); }
    try {
      const s = await fetch("/sw.js", { cache: "no-store" });
      out.swStatus = s.status;
    } catch (e) { out.swFetchErr = String(e.message || e); }
    setInfo(out);
  }, []);
  React.useEffect(() => { run(); }, [run]);
  React.useEffect(() => {
    let alive = true;
    (async () => {
      if (!user) { setBackup("not signed in"); return; }
      try {
        const b = await db.getBackups(user.id, 1);
        if (!alive) return;
        if (b && b.length) {
          const d = new Date(b[0].created_at);
          setBackup(d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }));
        } else { setBackup("none found"); }
      } catch (e) { if (alive) setBackup("error"); }
    })();
    return () => { alive = false; };
  }, [user]);

  const host = info ? info.host : "";
  const isLocal = /localhost|127\.0\.0\.1/.test(host);
  const isProd = /pay-calculator-iota\.vercel\.app/.test(host);
  const urlBad = !!info && !isLocal && !isProd;

  const Row = ({ k, v, warn }) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "3px 0", fontSize: 11.5 }}>
      <span style={{ color: "#5a6480" }}>{k}</span>
      <span style={{ color: warn ? "#ff6b8a" : "#c8cee0", textAlign: "right", wordBreak: "break-all", fontWeight: warn ? 700 : 400 }}>{String(v)}</span>
    </div>
  );

  if (!info) return <div style={{ fontSize: 11, color: "#5a6480" }}>Checking...</div>;
  return (
    <div>
      <Row k="deploy URL" v={info.host} warn={urlBad} />
      {urlBad && <div style={{ fontSize: 10.5, color: "#ff6b8a", padding: "2px 0 4px" }}>This isn't the stable URL. Use pay-calculator-iota.vercel.app so install &amp; updates work.</div>}
      <Row k="install prompt fired" v={prompt ? "YES" : "no"} />
      <Row k="installed (standalone)" v={info.standalone} />
      <Row k="online" v={info.online} warn={!info.online} />
      <Row k="last backup" v={backup} />
      <Row k="secure context" v={info.secure} warn={!info.secure} />
      <Row k="SW state" v={info.swState} warn={info.swState !== "active"} />
      <Row k="controlling page" v={info.controller} warn={!info.controller} />
      <Row k="/sw.js status" v={info.swStatus} warn={info.swStatus !== 200} />
      <Row k="manifest status" v={info.manifestStatus} warn={info.manifestStatus !== 200} />
      <Row k="icon count" v={info.iconCount} warn={!info.iconCount} />
      {info.regErr && <Row k="reg error" v={info.regErr} warn />}
      {info.manifestErr && <Row k="manifest error" v={info.manifestErr} warn />}
      {info.swFetchErr && <Row k="sw fetch error" v={info.swFetchErr} warn />}
      <button onClick={run} style={{ marginTop: 8, width: "100%", background: "#1a2535", border: "1px solid #4a9eff", borderRadius: 6, color: "#4a9eff", fontSize: 11, fontWeight: 700, padding: "8px", cursor: "pointer" }}>Re-check</button>
    </div>
  );
}

export default function App() {
  const [tab,setTab]=useState("Dashboard");
  const [isOwner,setIsOwner]=useState(true);   // false = partner (Hollie): restricted view
  const [user,setUser]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [dataLoading,setDataLoading]=useState(false);
  const [history,setHistory]=useState([]);
  const [sharedBills,setSharedBills]=useState(INITIAL_SHARED_BILLS);
  const [glynBills,setGlynBills]=useState(INITIAL_GLYN_BILLS);
  const [cats,setCats]=useState(()=>load(SK.cats,[]));
  const [billCats,setBillCats]=useState(()=>load(SK.billCats,{}));
  const [glynCats,setGlynCats]=useState(()=>load(SK.glynCats,[]));
  const [glynBillCats,setGlynBillCats]=useState(()=>load(SK.glynBillCats,{}));
  const defCalc={stdHrs:getCurrentMonthHours(),otHrs:0,weekendOtHrs:0,holidayHrs:0,bonus:240,perfAllowance:true,period:getCurrentPayPeriodKey()};
  const [ci,setCi]=useState(defCalc);
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
  const [billSnapshot,setBillSnapshot]=useState(()=>{
    try { return JSON.parse(localStorage.getItem("vaulted_bill_snapshot")||"null"); } catch { return null; }
  });
  const billChanges = useMemo(()=>{
    if (!billSnapshot) return [];
    const changes = [];
    sharedBills.forEach(b => {
      const old = (billSnapshot.shared||[]).find(s=>s.id===b.id);
      if (old && old.total !== b.total) changes.push({name:b.name, old:old.total, new:b.total, type:"shared"});
    });
    glynBills.forEach(b => {
      const old = (billSnapshot.glyn||[]).find(s=>s.id===b.id);
      if (old && old.total !== b.total) changes.push({name:b.name, old:old.total, new:b.total, type:"glyn"});
    });
    return changes;
  },[billSnapshot, sharedBills, glynBills]);
  const dismissBillChanges = () => {
    const snap = {shared:sharedBills.map(b=>({id:b.id,total:b.total})), glyn:glynBills.map(b=>({id:b.id,total:b.total}))};
    localStorage.setItem("vaulted_bill_snapshot", JSON.stringify(snap));
    setBillSnapshot(snap);
  };
  // Auto-snapshot on first load if none exists
  useEffect(()=>{
    if (!billSnapshot && sharedBills.length > 0) {
      const snap = {shared:sharedBills.map(b=>({id:b.id,total:b.total})), glyn:glynBills.map(b=>({id:b.id,total:b.total}))};
      localStorage.setItem("vaulted_bill_snapshot", JSON.stringify(snap));
      setBillSnapshot(snap);
    }
  },[billSnapshot, sharedBills, glynBills]);
  const dragBill=useRef(null);
  const [chartRange,setChartRange]=useState("All");
  const [netTrendOpen,setNetTrendOpen]=useState(false);
  const [dbError,setDbError]=useState(lastDbError);
  const [showMore,setShowMore]=useState(false);            // bottom "More" sheet (secondary tabs)
  const [moveBill,setMoveBill]=useState(null);             // {id,isGlyn} -> move-to-category sheet
  const [settlements,setSettlements]=useState([]);         // shared "settle up" ledger
  const [settleOpen,setSettleOpen]=useState(false);        // add-entry sheet
  const [settleForm,setSettleForm]=useState({kind:"charge",mine:true,amount:"",note:"",date:""});
  const [gifts,setGifts]=useState([]);                     // shared gift tracker
  const [giftSort,setGiftSort]=useState("bday");           // "bday" | "name"
  const [giftOpen,setGiftOpen]=useState(false);            // add/edit sheet
  const [giftForm,setGiftForm]=useState({id:null,name:"",dob:"",notes:"",cost:""});
  const [scheduledBills,setScheduledBills]=useState([]);   // bills active only in certain months
  const [schedOpen,setSchedOpen]=useState(false);          // manage sheet
  const [schedForm,setSchedForm]=useState(null);           // null=list view, object=add/edit form
  const [toast,setToast]=useState(null);                   // {msg,undo} -> undo toast
  const toastTimer=useRef(null);
  const [pullY,setPullY]=useState(0);                      // pull-to-refresh visual distance
  const [refreshing,setRefreshing]=useState(false);
  const pullStart=useRef(null);
  const pullDist=useRef(0);
  const [uploading,setUploading]=useState(false);
  const [pending,setPending]=useState(null);
  const [importMsg,setImportMsg]=useState(null);
  const [multiResults,setMultiResults]=useState([]);
  const [uploadProgress,setUploadProgress]=useState(null);
  const [notes,setNotes]=useState({});
  const [expandedPayslip,setExpandedPayslip]=useState(null);
  const [deleteConfirm,setDeleteConfirm]=useState(null);
  const [payslipSearch,setPayslipSearch]=useState("");
  const [showAllTimeTotals,setShowAllTimeTotals]=useState(false);

  // -- Supabase Auth --------------------------------------------------------
  const [sessionWarning, setSessionWarning] = useState(false);
  React.useEffect(() => {
    const checkExpiry = (session) => {
      if (!session?.expires_at) { setSessionWarning(false); return; }
      const msToExpiry = session.expires_at * 1000 - Date.now();
      // Only warn if expiry is imminent (< 90 seconds) AND auto-refresh hasn't kicked in.
      // Supabase auto-refreshes ~60s before expiry on the supabase-js v2 default,
      // so this warning only appears when refresh has actually failed (e.g. offline).
      setSessionWarning(msToExpiry > 0 && msToExpiry < 90 * 1000);
    };
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user || null);
      setAuthLoading(false);
      checkExpiry(session);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user || null);
      checkExpiry(session);
    });
    // Recheck every 30s when we're close to potential expiry territory
    const interval = setInterval(async () => {
      const { data: { session } } = await supabase.auth.getSession();
      checkExpiry(session);
    }, 30 * 1000);
    return () => { subscription.unsubscribe(); clearInterval(interval); };
  }, []);

  // Partner (Hollie) restricted view: keep her on allowed tabs only
  React.useEffect(() => {
    if (!isOwner) {
      if (!["Budget","Pay Calc","Settle Up","Gifts","Diag"].includes(tab)) setTab("Budget");
    }
  }, [isOwner, tab]);

  // Auto-scroll the page while dragging a bill near the top/bottom edge
  React.useEffect(() => {
    let raf = null, y = 0, running = false;
    const tick = () => {
      if (dragBill.current == null) { running = false; raf = null; return; }
      const h = window.innerHeight, edge = 90;
      if (y < edge) window.scrollBy(0, -Math.ceil((edge - y) / 5));
      else if (y > h - edge) window.scrollBy(0, Math.ceil((y - (h - edge)) / 5));
      raf = requestAnimationFrame(tick);
    };
    const onDragOver = (e) => {
      if (dragBill.current == null) return;
      e.preventDefault();
      y = e.clientY;
      if (!running) { running = true; raf = requestAnimationFrame(tick); }
    };
    const stop = () => { running = false; if (raf) cancelAnimationFrame(raf); raf = null; };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragend", stop);
    document.addEventListener("drop", stop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragend", stop);
      document.removeEventListener("drop", stop);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Load all data from Supabase when user logs in
  React.useEffect(() => {
    if (!user) return;
    setDataLoading(true);
    const loadAll = async () => {
      try {
        const [payslips, sBills, gBills, lLogs, lSettings, mTs, discs, scens, appSettings] = await Promise.all([
          db.getPayslips(user.id),
          db.getSharedBills(),
          db.getGlynBills(user.id),
          db.getLeaveLogs(user.id),
          db.getLeaveSettings(user.id),
          db.getMonthlyTs(user.id),
          db.getDiscrepancies(user.id),
          db.getScenarios(user.id),
          db.getAppSettings(user.id),
        ]);

        // Determine this user's role (owner = Glyn; partner = Hollie)
        let owner = true;
        try {
          const { data: prof } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
          owner = (prof?.role ?? "owner") === "owner";
        } catch (e) { owner = true; }
        setIsOwner(owner);

        // Payslips -- merge with INITIAL_HISTORY for months not yet in DB
        if (payslips.length > 0) {
          setHistory(payslips.sort((a,b)=>{
            const [am,ay]=a.month.split(" ");const [bm,by]=b.month.split(" ");
            return ay!==by?parseInt(ay)-parseInt(by):MONTHS.indexOf(am)-MONTHS.indexOf(bm);
          }));
        } else if (owner) {
          // First login (owner) -- seed DB with INITIAL_HISTORY
          const sorted = [...INITIAL_HISTORY].sort((a,b)=>{
            const [am,ay]=a.month.split(" ");const [bm,by]=b.month.split(" ");
            return ay!==by?parseInt(ay)-parseInt(by):MONTHS.indexOf(am)-MONTHS.indexOf(bm);
          });
          setHistory(sorted);
          for (const p of sorted) await trackSave(() => db.upsertPayslip(user.id, p));
        } else {
          setHistory([]); // partner starts with their own (empty) payslip history
        }

        // Bills -- merge with defaults if DB empty
        if (sBills.length > 0) {
          setSharedBills(sBills.map(b => ({ id: b.bill_id, name: b.name, total: parseFloat(b.total), isCarGlyn: b.is_car_glyn })));
        } else {
          for (const b of INITIAL_SHARED_BILLS) await trackSave(() => db.upsertSharedBill(b));
        }
        if (gBills.length > 0) {
          setGlynBills(gBills.map(b => ({ id: b.bill_id, name: b.name, total: parseFloat(b.total) })));
        } else if (owner) {
          for (const b of INITIAL_GLYN_BILLS) await trackSave(() => db.upsertGlynBill(user.id, b));
        } else {
          setGlynBills([]); // partner has no personal bills (and can't see the owner's)
        }

        if (lLogs.length > 0) setLeaveLogs(lLogs);
        if (lSettings) setLeaveSettings(lSettings);
        if (mTs.length > 0) setMonthlyTs(mTs);
        if (discs.length > 0) setDiscrepancies(discs);
        if (scens.length > 0) setScenarios(scens);
        if (appSettings) {
          if (appSettings.calc_inputs) {
            const rolled = applyPeriodRollover(appSettings.calc_inputs);
            setCi(rolled);
            // New pay period detected: persist the reset so it sticks across reloads.
            if (rolled !== appSettings.calc_inputs) db.saveAppSettings(user.id, { calc_inputs: rolled });
          }
          if (appSettings.tier_override) setTierOverride(appSettings.tier_override);
          if (appSettings.notes) setNotes(appSettings.notes);
          if (appSettings.dismissed_discrepancies) setDismissedDiscs(appSettings.dismissed_discrepancies);
          if (appSettings.cats_data) {
            const cd = appSettings.cats_data;
            if (cd.cats) setCats(cd.cats);
            if (cd.billCats) setBillCats(cd.billCats);
            if (cd.glynCats) setGlynCats(cd.glynCats);
            if (cd.glynBillCats) setGlynBillCats(cd.glynBillCats);
          }
        }

        // Shared bill categories (shared across both users)
        try {
          const ss = await db.getSharedSettings();
          if (ss && (ss.cats || ss.bill_cats)) {
            setCats(ss.cats || []);
            setBillCats(ss.bill_cats || {});
          } else if (owner) {
            const cd = appSettings?.cats_data || {};
            if ((cd.cats && cd.cats.length) || (cd.billCats && Object.keys(cd.billCats).length)) {
              await db.saveSharedSettings(cd.cats || [], cd.billCats || {});
            }
          }
        } catch (e) {}

        try { setSettlements(await db.getSettlements()); } catch (e) {}

        try { setGifts(await db.getGifts()); } catch (e) {}

        try { setScheduledBills(await db.getScheduledBills()); } catch (e) {}

        // Load accumulator from DB - migrate from localStorage if DB is empty
        const accData = await db.getAccumulator(user.id);
        const localAcc = load(SK.timesheets, null);
        const localLastUp = load(SK.tsLastUpload, null);

        if (!accData && localAcc) {
          // Fresh DB but localStorage has data -- migrate it up
          if (shouldResetTimesheet(localAcc.lastUpload)) {
            const empty = {otHrs:0,weekendOtHrs:0,weeks:[],days:[],lastUpload:null};
            setAccumulated(empty);
            await db.saveAccumulator(user.id, empty, null);
          } else {
            setAccumulated(localAcc);
            setTsLastUpload(localLastUp);
            await db.saveAccumulator(user.id, localAcc, localLastUp);
          }
        } else if (accData) {
          if (accData.data && shouldResetTimesheet(accData.lastUpload)) {
            const empty = {otHrs:0,weekendOtHrs:0,weeks:[],days:[],lastUpload:null};
            setAccumulated(empty);
            await db.saveAccumulator(user.id, empty, null);
            // New pay period: clear the calculator's variable hours and recompute standard hours.
            setC("otHrs", 0);
            setC("weekendOtHrs", 0);
            setC("holidayHrs", 0);
            setC("stdHrs", getCurrentMonthHours());
          } else if (accData.data) {
            // Count only the current pay period's days; drop leftovers from a prior period.
            const t = currentPeriodTotals(accData.data.days);
            const cleaned = { ...accData.data, days: t.days, otHrs: t.otHrs, weekendOtHrs: t.weekendOtHrs };
            setAccumulated(cleaned);
            setTsLastUpload(accData.lastUpload);
            setC("otHrs", t.otHrs);
            setC("weekendOtHrs", t.weekendOtHrs);
            setC("holidayHrs", t.holidayHrs);
            // Persist the cleaned accumulator so the stale days don't linger.
            if (t.days.length !== (accData.data.days || []).length) {
              db.saveAccumulator(user.id, cleaned, accData.lastUpload);
            }
          }
        }

        await requestAndSaveNotifPerm();
      } catch(e) { console.error("Data load error:", e); }
      setDataLoading(false);
    };
    loadAll();
  }, [user]);

  // Real-time subscriptions (Supabase v2 syntax)
  React.useEffect(() => {
    if (!user) return;
    const channel = supabase.channel("vaulted-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "payslips" }, () =>
        db.getPayslips(user.id).then(p => setHistory(p.sort((a,b)=>{const [am,ay]=a.month.split(" ");const [bm,by]=b.month.split(" ");return ay!==by?parseInt(ay)-parseInt(by):MONTHS.indexOf(am)-MONTHS.indexOf(bm);})))
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "shared_bills" }, () =>
        db.getSharedBills().then(b => setSharedBills(b.map(r => ({ id: r.bill_id, name: r.name, total: parseFloat(r.total), isCarGlyn: r.is_car_glyn }))))
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "glyn_bills", filter: "user_id=eq."+user.id }, () =>
        db.getGlynBills(user.id).then(b => setGlynBills(b.map(r => ({ id: r.bill_id, name: r.name, total: parseFloat(r.total) }))))
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "leave_logs" }, () =>
        db.getLeaveLogs(user.id).then(setLeaveLogs)
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "timesheet_accumulator", filter: "user_id=eq."+user.id }, () => {
        db.getAccumulator(user.id).then(acc => {
          if (acc && acc.data) {
            const t = currentPeriodTotals(acc.data.days);
            setAccumulated({ ...acc.data, days: t.days, otHrs: t.otHrs, weekendOtHrs: t.weekendOtHrs });
            setTsLastUpload(acc.lastUpload);
            setC("otHrs", t.otHrs);
            setC("weekendOtHrs", t.weekendOtHrs);
            setC("holidayHrs", t.holidayHrs);
          }
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "shared_settings" }, () =>
        db.getSharedSettings().then(ss => { if (ss) { setCats(ss.cats || []); setBillCats(ss.bill_cats || {}); } })
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "settlements" }, () =>
        db.getSettlements().then(setSettlements)
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "gifts" }, () =>
        db.getGifts().then(setGifts)
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "scheduled_bills" }, () =>
        db.getScheduledBills().then(setScheduledBills)
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "leave_settings", filter: "user_id=eq."+user.id }, () =>
        db.getLeaveSettings(user.id).then(ls => { if (ls) setLeaveSettings(ls); })
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "monthly_timesheets", filter: "user_id=eq."+user.id }, () =>
        db.getMonthlyTs(user.id).then(setMonthlyTs)
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "discrepancies", filter: "user_id=eq."+user.id }, () =>
        db.getDiscrepancies(user.id).then(setDiscrepancies)
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings", filter: "user_id=eq."+user.id }, () => {
        if (Date.now() - lastAppSettingsWrite < 4000) return; // ignore our own recent writes (don't clobber live edits)
        db.getAppSettings(user.id).then(as => {
          if (!as) return;
          if (as.calc_inputs) setCi(applyPeriodRollover(as.calc_inputs));
          if (as.tier_override !== undefined && as.tier_override !== null) setTierOverride(as.tier_override);
          if (as.notes) setNotes(as.notes);
          if (as.dismissed_discrepancies) setDismissedDiscs(as.dismissed_discrepancies);
          if (as.cats_data) {
            if (as.cats_data.glynCats) setGlynCats(as.cats_data.glynCats);
            if (as.cats_data.glynBillCats) setGlynBillCats(as.cats_data.glynBillCats);
          }
        });
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [user]);

  const fetchPartnerBills = async () => {
    if (!isOwner || !user) return undefined;
    try {
      const all = await db.getAllPersonalBills();
      return all.filter(b => b.user_id !== user.id).map(b => ({ user_id: b.user_id, id: b.bill_id, name: b.name, total: parseFloat(b.total) }));
    } catch (e) { return undefined; }
  };
  const buildBackupData = async () => {
    const base = {
      history, sharedBills, glynBills,
      cats, billCats, glynCats, glynBillCats,
      calcInputs: ci, notes,
      leaveLogs, leaveSettings,
      monthlyTs, discrepancies, scenarios,
      accumulated, tierOverride,
      settlements, gifts, scheduledBills,
      exportedAt: new Date().toISOString(),
      version: APP_VERSION,
    };
    const partner = await fetchPartnerBills();
    if (partner && partner.length) base.partnerPersonalBills = partner;
    return base;
  };
  const restorePartnerBills = async (partnerBills) => {
    if (!isOwner || !user || !Array.isArray(partnerBills)) return;
    try {
      const current = (await db.getAllPersonalBills()).filter(b => b.user_id !== user.id);
      const keep = new Set(partnerBills.map(b => b.user_id + ":" + b.id));
      for (const b of partnerBills) {
        if (b.user_id && b.user_id !== user.id) await db.upsertGlynBill(b.user_id, { id: b.id, name: b.name, total: b.total });
      }
      for (const b of current) {
        if (!keep.has(b.user_id + ":" + b.bill_id)) await db.deleteGlynBill(b.user_id, b.bill_id);
      }
    } catch (e) { console.error("Partner bills restore failed:", e); }
  };
  const restoreSettlements = async (arr) => {
    if (!user || !Array.isArray(arr)) return;
    try {
      const current = await db.getSettlements();
      const keep = new Set(arr.map(s => s.id));
      for (const s of arr) await db.upsertSettlement(s);
      for (const s of current) if (!keep.has(s.id)) await db.deleteSettlement(s.id);
      setSettlements(await db.getSettlements());
    } catch (e) { console.error("Settlements restore failed:", e); }
  };
  const restoreGifts = async (arr) => {
    if (!user || !Array.isArray(arr)) return;
    try {
      const current = await db.getGifts();
      const keep = new Set(arr.map(g => g.id));
      for (const g of arr) await db.upsertGift(g);
      for (const g of current) if (!keep.has(g.id)) await db.deleteGift(g.id);
      setGifts(await db.getGifts());
    } catch (e) { console.error("Gifts restore failed:", e); }
  };
  const restoreScheduledBills = async (arr) => {
    if (!user || !Array.isArray(arr)) return;
    try {
      const current = await db.getScheduledBills();
      const keep = new Set(arr.map(b => b.id));
      for (const b of arr) await db.upsertScheduledBill(b);
      for (const b of current) if (!keep.has(b.id)) await db.deleteScheduledBill(b.id);
      setScheduledBills(await db.getScheduledBills());
    } catch (e) { console.error("Scheduled bills restore failed:", e); }
  };

  const handleSignOut = async () => {
    // Take a final backup before signing out
    if (user) {
      try {
        const backupData = await buildBackupData();
        await db.createBackup(user.id, backupData, "signout").catch(()=>{});
      } catch(e) {}
    }
    await supabase.auth.signOut();
    setUser(null); setHistory([]);
  };

  // Refresh all data from Supabase
  const refreshAll = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const [payslips, sBills, gBills, lLogs, lSettings, mTs, discs, scens, appSettings, accData] = await Promise.all([
        db.getPayslips(user.id), db.getSharedBills(), db.getGlynBills(user.id),
        db.getLeaveLogs(user.id), db.getLeaveSettings(user.id), db.getMonthlyTs(user.id),
        db.getDiscrepancies(user.id), db.getScenarios(user.id), db.getAppSettings(user.id),
        db.getAccumulator(user.id),
      ]);
      if (payslips.length > 0) setHistory(payslips.sort((a,b)=>{const [am,ay]=a.month.split(" ");const [bm,by]=b.month.split(" ");return ay!==by?parseInt(ay)-parseInt(by):MONTHS.indexOf(am)-MONTHS.indexOf(bm);}));
      if (sBills.length > 0) setSharedBills(sBills.map(b => ({ id: b.bill_id, name: b.name, total: parseFloat(b.total), isCarGlyn: b.is_car_glyn })));
      if (gBills.length > 0) setGlynBills(gBills.map(b => ({ id: b.bill_id, name: b.name, total: parseFloat(b.total) })));
      setLeaveLogs(lLogs);
      if (lSettings) setLeaveSettings(lSettings);
      setMonthlyTs(mTs);
      setDiscrepancies(discs);
      setScenarios(scens);
      if (appSettings) {
        if (appSettings.calc_inputs) {
          const rolled = applyPeriodRollover(appSettings.calc_inputs);
          setCi(rolled);
          // New pay period detected: persist the reset so it sticks across reloads.
          if (rolled !== appSettings.calc_inputs) db.saveAppSettings(user.id, { calc_inputs: rolled });
        }
        if (appSettings.tier_override) setTierOverride(appSettings.tier_override);
        if (appSettings.notes) setNotes(appSettings.notes);
        if (appSettings.dismissed_discrepancies) setDismissedDiscs(appSettings.dismissed_discrepancies);
        if (appSettings.cats_data) {
          const cd = appSettings.cats_data;
          if (cd.cats) setCats(cd.cats);
          if (cd.billCats) setBillCats(cd.billCats);
          if (cd.glynCats) setGlynCats(cd.glynCats);
          if (cd.glynBillCats) setGlynBillCats(cd.glynBillCats);
        }
      }

      // Shared bill categories (shared across both users)
      try {
        const ss = await db.getSharedSettings();
        if (ss && (ss.cats || ss.bill_cats)) {
          setCats(ss.cats || []);
          setBillCats(ss.bill_cats || {});
        } else if (isOwner) {
          const cd = appSettings?.cats_data || {};
          if ((cd.cats && cd.cats.length) || (cd.billCats && Object.keys(cd.billCats).length)) {
            await db.saveSharedSettings(cd.cats || [], cd.billCats || {});
          }
        }
      } catch (e) {}

      try { setSettlements(await db.getSettlements()); } catch (e) {}

      try { setGifts(await db.getGifts()); } catch (e) {}

      try { setScheduledBills(await db.getScheduledBills()); } catch (e) {}

      if (accData && accData.data) {
        setAccumulated(accData.data);
        setTsLastUpload(accData.lastUpload);
      }
    } catch(e) { console.error("Refresh error:", e); }
    setDataLoading(false);
  }, [user]);

  // Surface Supabase errors on-screen (Diagnostics tab + sync dot)
  useEffect(() => {
    const onErr = (e) => setDbError(e);
    dbErrorListeners.add(onErr);
    return () => dbErrorListeners.delete(onErr);
  }, []);

  // Keyboard shortcuts (desktop)
  useEffect(() => {
    const all = [...PRIMARY_TABS, ...SECONDARY_TABS];
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey) {
        const num = parseInt(e.key);
        if (num >= 1 && num <= 9 && num <= all.length) {
          e.preventDefault();
          setTab(all[num-1]);
        }
        if (e.key === "r" && e.shiftKey) {
          e.preventDefault();
          refreshAll();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refreshAll]);

  // Pull-to-refresh on touch devices
  useEffect(() => {
    let startY = 0, pulling = false;
    const onTouchStart = (e) => {
      if (window.scrollY === 0) { startY = e.touches[0].clientY; pulling = true; }
    };
    const onTouchMove = (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 80 && !dataLoading) {
        pulling = false;
        haptic("medium");
        refreshAll();
      }
    };
    const onTouchEnd = () => { pulling = false; };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [refreshAll, dataLoading]);

  // -- Annual Leave ---------------------------------------------------------
  const [leaveSettings, setLeaveSettings] = useState({ baseEntitlement: 29, serviceDays: 4, startYear: 2022 });
  const [leaveLogs, setLeaveLogs] = useState([]);
  const [leaveForm, setLeaveForm] = useState({ date: "", hours: "8.25", label: "" });
  const [leaveEditSettings, setLeaveEditSettings] = useState(false);
  const [leaveDraftSettings, setLeaveDraftSettings] = useState(null);

  const saveLeaveLog = () => {
    if (!leaveForm.date || !leaveForm.hours) return;
    haptic("success");
    const entry = { id: genUUID(), date: leaveForm.date, hours: parseFloat(leaveForm.hours), label: leaveForm.label.trim() };
    // Optimistic update -- UI first, then DB
    setLeaveLogs(prev => [...prev, entry].sort((a,b) => new Date(b.date) - new Date(a.date)));
    setLeaveForm({ date: "", hours: "8.25", label: "" });
    if (user) trackSave(db.upsertLeaveLog(user.id, entry)).catch(e => {
      console.error("Leave save failed:", e);
      setLeaveLogs(prev => prev.filter(l => l.id !== entry.id));
    });
  };

  const deleteLeaveLog = (id) => {
    haptic("medium");
    // Optimistic -- remove from UI first
    const removed = leaveLogs.find(l => l.id === id);
    setLeaveLogs(prev => prev.filter(l => l.id !== id));
    if (user) trackSave(db.deleteLeaveLog(id)).catch(e => {
      console.error("Leave delete failed:", e);
      if (removed) setLeaveLogs(prev => [...prev, removed].sort((a,b) => new Date(b.date) - new Date(a.date)));
    });
  };

  const saveLeaveSettings = async () => {
    haptic("success");
    setLeaveSettings(leaveDraftSettings);
    if (user) await trackSave(() => db.saveLeaveSettings(user.id, leaveDraftSettings));
    setLeaveEditSettings(false);
  };

  // -- Notifications --------------------------------------------------------
  const [notifPerm, setNotifPerm] = useState(() => load(SK.notifPerm, null));

  const requestAndSaveNotifPerm = async () => {
    const result = await requestNotifPermission();
    setNotifPerm(result);
    save(SK.notifPerm, result);
    return result;
  };

  // -- Timesheet auto-import polling ----------------------------------------
  const [tsSecret, setTsSecret] = useState(() => load(SK.tsSecret, ""));
  const [tsLastEmail, setTsLastEmail] = useState(() => load(SK.tsLastEmail, ""));
  const [tsAutoMsg, setTsAutoMsg] = useState(null); // { text, ok } -- brief status toast

  const applyTimesheetDays = React.useCallback((days, emailId, meta = null) => {
    const STD = 8.25;
    const enrichedDays = days.map(d => {
      const { isHoliday, isHalf } = normaliseHoliday(d.holiday);
      const hrs = isHoliday ? 0 : parseHM(d.hours);
      const isWeekend = d.day.toLowerCase().startsWith("sat") || d.day.toLowerCase().startsWith("sun");
      const otHrs = (isHoliday || isWeekend) ? 0 : Math.max(0, Math.round((hrs - STD) * 100) / 100);
      const wkOtHrs = (!isHoliday && isWeekend) ? hrs : 0;
      return { ...d, hrs, otHrs, wkOtHrs, isHoliday, isHalf };
    });

    // Auto-log holidays to leave
    const holidayDays = enrichedDays.filter(d => d.isHoliday);
    if (holidayDays.length > 0) {
      setLeaveLogs(prev => {
        const newEntries = holidayDays.map(d => {
          const [dd, mm] = d.date.split("/").map(Number);
          const year = new Date().getFullYear();
          const dateStr = new Date(year, mm - 1, dd).toISOString().slice(0, 10);
          const hours = d.isHalf ? STD_DAY_HRS / 2 : STD_DAY_HRS;
          return { id: genUUID(), date: dateStr, hours, label: "Annual Leave (auto)" };
        });
        const merged = [...prev, ...newEntries]
          .filter((e, i, arr) => arr.findIndex(x => x.date === e.date) === i)
          .sort((a, b) => new Date(b.date) - new Date(a.date));
        if (user) newEntries.forEach(e => trackSave(db.upsertLeaveLog(user.id, e)));
        return merged;
      });
    }

    // Only merge into accumulator if days fall within current pay period
    const now = new Date();
    const currentPeriodStart = getPayday(now.getMonth() === 0 ? now.getFullYear()-1 : now.getFullYear(), now.getMonth() === 0 ? 11 : now.getMonth()-1);
    const currentPeriodEnd = getPayday(now.getFullYear(), now.getMonth());
    const currentDays = enrichedDays.filter(d => {
      if (!d.date) return false;
      const [dd, mm] = d.date.split("/").map(Number);
      const dayDate = new Date(now.getFullYear(), mm - 1, dd);
      return dayDate >= currentPeriodStart && dayDate <= currentPeriodEnd;
    });

    // Merge into accumulated timesheet
    setAccumulated(prev => {
      const seen = new Set();
      // NEW DATA FIRST so it wins on dedup conflicts (correct values from latest email)
      const merged = [...(currentDays.length > 0 ? currentDays : []), ...(prev.days || [])]
        .sort((a, b) => {
          const [ad, am] = (a.date || "").split("/").map(Number);
          const [bd, bm] = (b.date || "").split("/").map(Number);
          return am !== bm ? am - bm : ad - bd;
        })
        .filter(d => {
          const key = d.date + "_" + d.day;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });

      // Safety check: never reduce days count from a merge (this should only grow or stay equal)
      const prevDayCount = (prev.days || []).length;
      if (merged.length < prevDayCount && currentDays.length > 0) {
        console.warn(`Refusing to reduce days from ${prevDayCount} to ${merged.length}. Keeping previous data.`);
        return prev;
      }

      const totalOtHrs  = Math.round(merged.reduce((s, d) => s + (d.otHrs  || 0), 0) * 100) / 100;
      const totalWkndHrs= Math.round(merged.reduce((s, d) => s + (d.wkOtHrs|| 0), 0) * 100) / 100;
      const now = new Date().toISOString();
      const newAcc = { otHrs: totalOtHrs, weekendOtHrs: totalWkndHrs, weeks: [...(prev.weeks||[]), { uploadedAt: now }], days: merged, lastUpload: now };
      if (user) db.saveAccumulator(user.id, newAcc, now).catch(e => console.error("Acc save failed:", e));
      // Update Pay Calc, counting only the current pay period's days.
      const pt = currentPeriodTotals(merged);
      setC("otHrs", pt.otHrs);
      setC("weekendOtHrs", pt.weekendOtHrs);
      setC("holidayHrs", pt.holidayHrs);
      return newAcc;
    });

    if (currentDays.length > 0) {
      const now = new Date().toISOString();
      setTsLastUpload(now);
    }
    setTsLastEmail(emailId);
    save(SK.tsLastEmail, emailId);

    // If monthly timesheet, save to history and run discrepancy check
    if (meta && meta.isMonthly) {
      const STD = 8.25;
      let stdHrs = 0, otHrs = 0, wkndHrs = 0, holHrs = 0;
      days.forEach(d => {
        if (d.isHoliday) { holHrs += d.isHalf ? STD_DAY_HRS / 2 : STD_DAY_HRS; return; }
        const hrs = parseHM(d.hours);
        const isWknd = d.day.toLowerCase().startsWith("sat") || d.day.toLowerCase().startsWith("sun");
        if (isWknd) { wkndHrs += hrs; }
        else if (hrs <= STD) { stdHrs += hrs; }
        else { stdHrs += STD; otHrs += Math.round((hrs - STD) * 100) / 100; }
      });
      const entry = {
        emailId,
        period: meta.period,
        month: meta.payMonth,
        totalHrs: meta.totalHrs,
        stdHrs: Math.round(stdHrs * 100) / 100,
        otHrs:  Math.round(otHrs  * 100) / 100,
        wkndHrs:Math.round(wkndHrs* 100) / 100,
        holHrs: Math.round(holHrs * 100) / 100,
        days,
        savedAt: new Date().toISOString(),
      };
      saveMonthlyTs(entry);

      // Cross-check: does the monthly timesheet match the accumulated weekly timesheets?
      // Pass enrichedDays so isHoliday/hrs are already normalised, matching the accumulator format
      checkMonthlyVsWeekly(enrichedDays, accumulatedRef.current.days || [], meta);
    }
  }, [user]);



  // Poll /api/timesheet -- 5s when items pending, 60s when empty
  React.useEffect(() => {
    if (!tsSecret || !user) return;
    let intervalMs = 60000;
    let timer = null;

    const poll = async () => {
      try {
        const secret = localStorage.getItem("vaulted_ts_secret") || tsSecret;
        const res = await fetch(`/api/timesheet?token=${encodeURIComponent(secret)}`);
        const data = await res.json();
        if (data.status === "pending" && data.data) {
          const { emailId, days } = data.data;
          const lastEmail = localStorage.getItem("vaulted_ts_last_email") || "";
          if (emailId === lastEmail) {
            // Already applied -- clear from queue and move on
            await fetch(`/api/timesheet?token=${encodeURIComponent(secret)}`, { method: "DELETE" });
          } else {
            applyTimesheetDays(days, emailId, data.data.meta || null);
            await fetch(`/api/timesheet?token=${encodeURIComponent(secret)}`, { method: "DELETE" });
            setTsAutoMsg({ text: "✅ Timesheet auto-imported", ok: true });
            sendNotification("📋 Timesheet imported", "Your JLI timesheet has been automatically added to Vaulted.", "ts-auto");
            setTimeout(() => setTsAutoMsg(null), 4000);
          }
          // More items -- poll again in 5s
          if ((data.remaining || 1) > 1) intervalMs = 5000;
        } else {
          intervalMs = 60000;
        }
      } catch { /* silent */ }
      timer = setTimeout(poll, intervalMs);
    };

    poll();
    return () => { if (timer) clearTimeout(timer); };
  }, [tsSecret, user]);

  // -- Monthly timesheet history + discrepancy checker ---------------------
  const [monthlyTs, setMonthlyTs] = useState([]);
  const [discrepancies, setDiscrepancies] = useState([]);
  const [dismissedDiscs, setDismissedDiscs] = useState([]); // months whose discrepancy alert is dismissed
  const [weeklyCheck, setWeeklyCheck] = useState(null); // monthly-vs-weekly comparison result

  const dismissDisc = (month) => {
    setDismissedDiscs(prev => {
      if (prev.includes(month)) return prev;
      const next = [...prev, month];
      if (user) db.saveAppSettings(user.id, { dismissed_discrepancies: next }).catch(()=>{});
      return next;
    });
  };
  const restoreDisc = (month) => {
    setDismissedDiscs(prev => {
      const next = prev.filter(m => m !== month);
      if (user) db.saveAppSettings(user.id, { dismissed_discrepancies: next }).catch(()=>{});
      return next;
    });
  };

  const saveMonthlyTs = async (entry) => {
    if (user) await trackSave(() => db.upsertMonthlyTs(user.id, entry));
    setMonthlyTs(prev => {
      return [...prev.filter(m => m.emailId !== entry.emailId && m.period !== entry.period), entry]
        .sort((a, b) => new Date(b.period.split(" to ")[0]) - new Date(a.period.split(" to ")[0]));
    });
    checkDiscrepancy(entry, history);
  };

  const checkDiscrepancy = async (tsEntry, hist) => {
    if (!tsEntry || !tsEntry.month) return;
    const payslip = hist.find(h => h.month === tsEntry.month);
    if (!payslip) return; // payslip not yet uploaded -- will recheck when payslip arrives

    // Infer tier allowance from the payslip's actual bonus amount
    let tierIdx = 0;
    for (let i = PAY.bonusTiers.length - 1; i >= 0; i--) {
      if ((payslip.bonus || 0) >= PAY.bonusTiers[i].bonus && PAY.bonusTiers[i].bonus > 0) {
        tierIdx = i;
        break;
      }
    }
    const allowance = PAY.bonusTiers[tierIdx].allowance;
    // Use historical rates for retroactive accuracy
    const rateConfig = (typeof getRateFor === "function") ? getRateFor(tsEntry.month) : null;
    const expected = calcPay({
      stdHrs: tsEntry.stdHrs,
      otHrs: tsEntry.otHrs,
      weekendOtHrs: tsEntry.wkndHrs,
      holidayHrs: tsEntry.holHrs, // include paid holiday hours
      bonus: payslip.bonus, // use actual bonus from payslip
      _allowanceOverride: allowance,
      _rateOverride: rateConfig ? { baseRate: rateConfig.baseRate, otRate: rateConfig.otRate, weekendOtRate: rateConfig.weekendOtRate } : undefined,
    });

    const THRESH = 1.00; // £1 tolerance for rounding
    const items = [];
    const diff = (label, exp, act, unit="£") => {
      const d = Math.abs(exp - act);
      if (d > THRESH) items.push({ label, expected: exp, actual: act, diff: exp - act, unit });
    };

    diff("Gross Pay",   Math.round(expected.gross * 100)/100, payslip.gross);
    diff("Net Pay",     Math.round(expected.net   * 100)/100, payslip.net);
    diff("Income Tax",  Math.round(expected.tax   * 100)/100, payslip.tax);
    diff("NI",          Math.round(expected.ni    * 100)/100, payslip.ni);
    diff("NEST",        Math.round(expected.nest  * 100)/100, payslip.nest);
    diff("Student Loan",Math.round(expected.sl    * 100)/100, payslip.sl);

    const result = {
      month: tsEntry.month,
      period: tsEntry.period,
      status: items.length === 0 ? "ok" : "discrepancy",
      items,
      ts: { stdHrs: tsEntry.stdHrs, otHrs: tsEntry.otHrs, wkndHrs: tsEntry.wkndHrs, totalHrs: tsEntry.totalHrs },
      payslip: { gross: payslip.gross, net: payslip.net, tax: payslip.tax, ni: payslip.ni },
      expected: { gross: Math.round(expected.gross*100)/100, net: Math.round(expected.net*100)/100 },
      checkedAt: new Date().toISOString(),
    };

    if (user) await trackSave(() => db.upsertDiscrepancy(user.id, result));
    setDiscrepancies(prev => {
      return [...prev.filter(d => d.month !== tsEntry.month), result]
        .sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt));
    });

    if (items.length > 0) {
      sendNotification(
        "⚠️ Pay discrepancy -- " + tsEntry.month,
        items.length + " item" + (items.length>1?"s":"") + " don't match your timesheet. Check Vaulted.",
        "discrepancy-" + tsEntry.month
      );
    }
  };

  // Cross-check monthly timesheet against accumulated weekly timesheets (day-by-day)
  const checkMonthlyVsWeekly = async (monthlyDays, weeklyDays, meta) => {
    if (!monthlyDays || monthlyDays.length === 0) return;
    if (!weeklyDays || weeklyDays.length === 0) {
      // No weekly data to compare against
      setWeeklyCheck({
        status: "no_weekly",
        period: meta?.period || "",
        month: meta?.payMonth || "",
        mismatches: [],
        checkedAt: new Date().toISOString(),
      });
      return;
    }

    const pHM = str => {
      const hMatch = (str||"").match(/(\d+)h/);
      const mMatch = (str||"").match(/(\d+)m/);
      return Math.round(((hMatch?parseInt(hMatch[1]):0) + (mMatch?parseInt(mMatch[1]):0)/60) * 100) / 100;
    };

    // Build a lookup of weekly days by date
    const weeklyByDate = {};
    weeklyDays.forEach(d => { weeklyByDate[d.date] = d; });

    const mismatches = [];
    let monthlyTotal = 0, weeklyTotal = 0;

    // Calculate the date threshold: ignore monthly days from the last 8 days
    // (weeklies arrive on Mondays for the previous week, so the current incomplete week
    // and any pending Monday email shouldn't be flagged as missing yet)
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 8);

    monthlyDays.forEach(md => {
      // Use already-enriched hrs/isHoliday if present, else parse from raw fields
      const mh = (md.hrs !== undefined) ? md.hrs : (md.isHoliday ? 0 : pHM(md.hours));
      monthlyTotal += mh;

      // Parse the day's date to see if it's recent enough to skip
      const [dd, mm] = (md.date || "").split("/").map(Number);
      let dayDate = null;
      if (dd && mm) {
        const yr = now.getFullYear();
        // Handle month-end rollover (Dec dates in Jan etc.)
        const guessedYear = (mm > now.getMonth() + 1) ? yr - 1 : yr;
        dayDate = new Date(guessedYear, mm - 1, dd);
      }
      const isRecent = dayDate && dayDate > cutoff;

      const wd = weeklyByDate[md.date];
      if (!wd) {
        // Day in monthly but missing from weekly - only flag if older than the recent window
        // Skip holidays from missing-weekly flagging (they auto-log to leave separately)
        if ((mh > 0 || md.isHoliday) && !isRecent && !md.isHoliday) {
          mismatches.push({ date: md.date, day: md.day, type: "missing_weekly", monthly: md.hours, weekly: "—" });
        }
        return;
      }
      const wh = (wd.hrs !== undefined) ? wd.hrs : (wd.isHoliday ? 0 : pHM(wd.hours));
      weeklyTotal += wh;
      // If either says it's a holiday, skip the comparison (both should match in JLI's data)
      if (md.isHoliday || wd.isHoliday) {
        return;
      }
      // Compare hours (allow 1 minute = 0.02h tolerance for rounding)
      if (Math.abs(mh - wh) > 0.02) {
        mismatches.push({ date: md.date, day: md.day, type: "hours_differ", monthly: md.hours, weekly: wd.hours });
      }
    });

    // Check for days in weekly but missing from monthly
    weeklyDays.forEach(wd => {
      if (!monthlyDays.find(md => md.date === wd.date)) {
        const wh = wd.isHoliday ? 0 : pHM(wd.hours);
        if (wh > 0 || wd.isHoliday) {
          mismatches.push({ date: wd.date, day: wd.day, type: "missing_monthly", monthly: "—", weekly: wd.hours });
        }
      }
    });

    // Sort mismatches by date
    mismatches.sort((a,b) => {
      const [ad,am] = (a.date||"").split("/").map(Number);
      const [bd,bm] = (b.date||"").split("/").map(Number);
      return am !== bm ? am - bm : ad - bd;
    });

    const result = {
      status: mismatches.length === 0 ? "match" : "mismatch",
      period: meta?.period || "",
      month: meta?.payMonth || "",
      mismatches,
      monthlyTotal: Math.round(monthlyTotal * 100) / 100,
      weeklyTotal: Math.round(weeklyTotal * 100) / 100,
      checkedAt: new Date().toISOString(),
    };
    setWeeklyCheck(result);

    if (mismatches.length > 0) {
      sendNotification(
        "Monthly vs Weekly mismatch -- " + (meta?.payMonth || ""),
        mismatches.length + " day" + (mismatches.length>1?"s":"") + " don't match between your monthly and weekly timesheets.",
        "weekly-check-" + (meta?.payMonth || "")
      );
    }
  };

  // Re-run discrepancy check when a new payslip is uploaded for a month we have a timesheet for
  React.useEffect(() => {
    if (!history.length || !monthlyTs.length) return;
    monthlyTs.forEach(ts => {
      if (!ts.month) return;
      const alreadyChecked = discrepancies.find(d => d.month === ts.month);
      if (!alreadyChecked) checkDiscrepancy(ts, history);
    });
  }, [history]);

  // PWA install prompt
  const [pwaPrompt, setPwaPrompt] = React.useState(null);
  const [pwaInstalled, setPwaInstalled] = React.useState(() => window.matchMedia("(display-mode: standalone)").matches);
  React.useEffect(() => {
    const handler = (e) => { e.preventDefault(); setPwaPrompt(e); };
    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", () => setPwaInstalled(true));
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  const triggerInstall = async () => {
    if (!pwaPrompt) return;
    haptic("medium");
    pwaPrompt.prompt();
    const { outcome } = await pwaPrompt.userChoice;
    if (outcome === "accepted") setPwaInstalled(true);
    setPwaPrompt(null);
  };

  // Fire notifications once per session after unlock
  const notifFiredRef = React.useRef(false);
  React.useEffect(() => {
    if (!user || notifFiredRef.current || Notification.permission !== "granted") return;
    notifFiredRef.current = true;
    if (isTomorrowPayday()) {
      sendNotification("💰 Payday tomorrow!", "Your pay should land tomorrow -- check Vaulted for your estimate.", "payday");
    }
    if (shouldFireTimesheetNotif(tsLastUpload)) {
      sendNotification("📋 Timesheet reminder", "It's Monday -- don't forget to upload your weekly timesheet.", "timesheet");
    }
  }, [user]);

  // Onboarding handled by Supabase auth -- no separate state needed

  // -- Named Scenarios ------------------------------------------------------
  const [scenarios, setScenarios] = useState([]);
  const [expandedMonth, setExpandedMonth] = useState(null);

  // Tier override -- initial value loaded from Supabase via app_settings later
  const currentMonthStr = MONTHS[new Date().getMonth()]+" "+new Date().getFullYear();
  const [tierOverride,setTierOverride]=useState(null); // null = auto (inferred from latest payslip)
  const saveTierOverride=(tierIdx)=>{
    const val=tierIdx===null?null:{tierIdx,month:currentMonthStr};
    setTierOverride(tierIdx);

  };

  // Timesheet state
  const [tsUploading,setTsUploading]=useState(false);
  const [tsProgress,setTsProgress]=useState(null);
  const [showManualTs,setShowManualTs]=useState(false);
  const [showPayslipUpload,setShowPayslipUpload]=useState(false);
  const [showQueueDiag,setShowQueueDiag]=useState(false);
  const [showBackups,setShowBackups]=useState(false);
  const [backupList,setBackupList]=useState([]);
  const [backupLoading,setBackupLoading]=useState(false);
  const [tsPending,setTsPending]=useState(null); // extracted data awaiting confirmation
  const [tsLastUpload,setTsLastUpload]=useState(null);
  const [accumulated,setAccumulated]=useState({otHrs:0,weekendOtHrs:0,weeks:[],days:[],lastUpload:null});
  const accumulatedRef = useRef(accumulated);
  useEffect(() => { accumulatedRef.current = accumulated; }, [accumulated]);

  // Silent holiday resync whenever Leave tab is opened
  React.useEffect(() => {
    if (tab !== "Leave" || !user) return;
    if (!accumulated.days || accumulated.days.length === 0) return;
    const holDays = accumulated.days.filter(d=>d.isHoliday);
    if (holDays.length === 0) return;
    const newEntries = holDays.map(d=>{
      const [dd, mm] = d.date.split("/").map(Number);
      const year = new Date().getFullYear();
      const dateStr = new Date(year, mm - 1, dd).toISOString().slice(0, 10);
      return { id: genUUID(), date: dateStr, hours: d.isHalf ? STD_DAY_HRS/2 : STD_DAY_HRS, label: "Annual Leave (auto)" };
    });
    const existing = new Set(leaveLogs.map(l => l.date));
    const toAdd = newEntries.filter(e => !existing.has(e.date));
    if (toAdd.length === 0) return;
    setLeaveLogs(prev => [...prev, ...toAdd].sort((a,b) => new Date(b.date) - new Date(a.date)));
    (async () => {
      for (const e of toAdd) {
        try { await db.upsertLeaveLog(user.id, e); } catch(err) {}
      }
    })();
  }, [tab, user, accumulated.days]);

  // Silent queue drain whenever Timesheet tab is opened
  React.useEffect(() => {
    if (tab !== "Timesheet" || !tsSecret || !user) return;
    let cancelled = false;
    (async () => {
      let processed = 0;
      for (let i = 0; i < 20; i++) {
        if (cancelled) return;
        try {
          const res = await fetch(`/api/timesheet?token=${encodeURIComponent(tsSecret)}`);
          const data = await res.json();
          if (data.status !== "pending" || !data.data) break;
          const { emailId, days } = data.data;
          applyTimesheetDays(days, emailId, data.data.meta || null);
          await fetch(`/api/timesheet?token=${encodeURIComponent(tsSecret)}`, { method: "DELETE" });
          processed++;
        } catch(e) { break; }
      }
      if (processed > 0 && !cancelled) {
        setTsAutoMsg({ text: `✅ ${processed} timesheet${processed!==1?"s":""} imported`, ok: true });
        setTimeout(() => setTsAutoMsg(null), 4000);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, tsSecret, user, applyTimesheetDays]);

  // Auto-backup -- runs after data loads, if last backup was > 24h ago
  React.useEffect(() => {
    if (!user || dataLoading) return;
    let cancelled = false;
    const runBackup = async () => {
      try {
        const backups = await db.getBackups(user.id, 1);
        const lastBackup = backups[0];
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        const shouldBackup = !lastBackup || (now - new Date(lastBackup.created_at).getTime() > dayMs);
        if (!shouldBackup || cancelled) return;
        await new Promise(r => setTimeout(r, 5000));
        if (cancelled) return;
        const backupData = await buildBackupData();
        await db.createBackup(user.id, backupData, "auto");
      } catch(e) { console.error("Auto-backup failed:", e); }
    };
    runBackup();
    return () => { cancelled = true; };
  }, [user, dataLoading]);
  const showTsReminder=shouldShowTimesheetReminder(tsLastUpload);

  const latest=useMemo(()=>sortH(history).slice(-1)[0],[history]);
  const prevMonth=useMemo(()=>sortH(history).slice(-2)[0],[history]);
  const schedNowMonth=new Date().getMonth()+1, schedNowYear=new Date().getFullYear();
  const schedActive=(sb)=>{
    const ms=Array.isArray(sb.months)?sb.months:[];
    if(sb.freq==="once") return sb.year===schedNowYear && ms.includes(schedNowMonth);
    return ms.includes(schedNowMonth);
  };
  const schedShares=(sb)=>billShares({total:Number(sb.total)||0,isCarGlyn:sb.is_car_glyn});
  const myId=user?user.id:null;
  const activeSchedShared=scheduledBills.filter(b=>b.scope==="shared"&&schedActive(b));
  const activeSchedPersonal=scheduledBills.filter(b=>b.scope==="personal"&&b.owner===myId&&schedActive(b));
  const schedShTotal=activeSchedShared.reduce((s,b)=>s+(Number(b.total)||0),0);
  const shGlyn=sharedBills.reduce((s,b)=>s+billShares(b).glyn,0)+activeSchedShared.reduce((s,b)=>s+schedShares(b).glyn,0);
  const shHollie=sharedBills.reduce((s,b)=>s+billShares(b).hollie,0)+activeSchedShared.reduce((s,b)=>s+schedShares(b).hollie,0);
  const glOnly=glynBills.reduce((s,b)=>s+b.total,0)+activeSchedPersonal.reduce((s,b)=>s+(Number(b.total)||0),0);
  const totalOut=shGlyn+glOnly;

  // Effective tier: must be computed before cr
  const effectiveTierIdx=useMemo(()=>{
    if(tierOverride!==null) return tierOverride;
    if(!latest) return 0;
    const bonus=latest.bonus||0;
    for(let i=PAY.bonusTiers.length-1;i>=0;i--){
      if(bonus>=PAY.bonusTiers[i].bonus&&PAY.bonusTiers[i].bonus>0) return i;
    }
    return 0;
  },[tierOverride,latest]);
  const effectiveAllowance=PAY.bonusTiers[effectiveTierIdx].allowance;

  const cr=useMemo(()=>calcPay({...ci, _allowanceOverride: effectiveAllowance}),[ci, effectiveAllowance]);
  const surplus=cr.net-totalOut;

  // Hollie's pay calc (partner view). Her OT is stored inside calc_inputs (survives the
  // 29->28 rollover) and resets each CALENDAR month via a month stamp.
  const hollieCalKey=`${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}`;
  const hollieOtHrs=(ci.hollieOtMonth===hollieCalKey)?(Number(ci.hollieOtHrs)||0):0;
  const setHollieOt=(hrs)=>{
    setCi(p=>{
      const n={...p,hollieOtHrs:hrs,hollieOtMonth:hollieCalKey};
      if(user)trackSave(db.saveAppSettings(user.id,{calc_inputs:n}));
      return n;
    });
  };
  const hollieCalc=calcHolliePay(hollieOtHrs);
  const hollieOut=shHollie+glOnly;
  const hollieSurplus=hollieCalc.net-hollieOut;

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

  const updH=h=>{setHistory(h);};
  // Bills -- write each changed bill to Supabase (bulk reconcile)
  const updSB=async (b)=>{
    setSharedBills(b);
    if (user) {
      // Find changes vs current state - simplest: upsert all, delete missing
      for (const bill of b) trackSave(db.upsertSharedBill(bill));
      const currentIds = new Set(sharedBills.map(x => x.id));
      const newIds = new Set(b.map(x => x.id));
      for (const id of currentIds) if (!newIds.has(id)) trackSave(db.deleteSharedBill(id));
    }
  };
  const updGB=async (b)=>{
    setGlynBills(b);
    if (user) {
      for (const bill of b) trackSave(db.upsertGlynBill(user.id, bill));
      const currentIds = new Set(glynBills.map(x => x.id));
      const newIds = new Set(b.map(x => x.id));
      for (const id of currentIds) if (!newIds.has(id)) trackSave(db.deleteGlynBill(user.id, id));
    }
  };
  // Categories - store in app_settings (shared per user account)
  const saveSharedCats=(nextCats,nextBillCats)=>{ if (user) trackSave(db.saveSharedSettings(nextCats, nextBillCats)); };
  const updC=c=>{
    setCats(c);
    saveSharedCats(c, billCats);
    if (user) trackSave(db.saveAppSettings(user.id, { cats_data: { cats: c, billCats, glynCats, glynBillCats } }));
  };
  const updBC=bc=>{
    setBillCats(bc);
    saveSharedCats(cats, bc);
    if (user) trackSave(db.saveAppSettings(user.id, { cats_data: { cats, billCats: bc, glynCats, glynBillCats } }));
  };
  const updGC=c=>{
    setGlynCats(c);
    if (user) trackSave(db.saveAppSettings(user.id, { cats_data: { cats, billCats, glynCats: c, glynBillCats } }));
  };
  const updGBC=bc=>{
    setGlynBillCats(bc);
    if (user) trackSave(db.saveAppSettings(user.id, { cats_data: { cats, billCats, glynCats, glynBillCats: bc } }));
  };
  // Restore all four category maps from a backup in ONE write, so the saves
  // can't race and overwrite each other (that race stopped restores sticking).
  const restoreCats = d => {
    const cd = {
      cats: d.cats !== undefined ? d.cats : cats,
      billCats: d.billCats !== undefined ? d.billCats : billCats,
      glynCats: d.glynCats !== undefined ? d.glynCats : glynCats,
      glynBillCats: d.glynBillCats !== undefined ? d.glynBillCats : glynBillCats,
    };
    setCats(cd.cats); setBillCats(cd.billCats); setGlynCats(cd.glynCats); setGlynBillCats(cd.glynBillCats);
    saveSharedCats(cd.cats, cd.billCats);
    if (user) db.saveAppSettings(user.id, { cats_data: cd });
  };
  const setC=useCallback((k,v)=>{
    setCi(p=>{
      const n={...p,[k]:v};
      if (user) trackSave(db.saveAppSettings(user.id, { calc_inputs: n }));
      return n;
    });
  },[user]);
  const updNotes=n=>{
    setNotes(n);
    if (user) trackSave(db.saveAppSettings(user.id, { notes: n }));
  };
  const deletePayslip=month=>{updH(history.filter(h=>h.month!==month));setDeleteConfirm(null);setExpandedPayslip(null);};

  const handleUpload=async e=>{
    const files=Array.from(e.target.files);
    if(!files.length) return;
    setUploading(true);
    setMultiResults([]);
    const results=[];
    const successful=[];
    for(let i=0;i<files.length;i++){
      const file=files[i];
      setUploadProgress(`Reading ${i+1} of ${files.length}...`);
      try {
        const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=rej;r.readAsDataURL(file);});
        const resp=await fetch(API_PROXY,{
          method:"POST",
          headers:await authHeaders(),
          body:JSON.stringify({model:"claude-sonnet-4-5",max_tokens:1500,messages:[{role:"user",content:[
            {type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
            {type:"text",text:'Extract payslip data. Return ONLY valid JSON with this exact shape:\n{"month":"Mon YYYY","date":"DD/MM/YYYY","gross":0.00,"net":0.00,"tax":0.00,"ni":0.00,"nest":0.00,"sl":0.00,"bonus":0.00,"ot":0.00,"weekendOt":0.00,"holidayPay":0.00,"hourlyAllowance":0.00,"regularPay":0.00}\n\nField definitions:\n- month: payment month/year (e.g. "May 2026")\n- date: payment date as DD/MM/YYYY\n- gross: TOTAL gross pay (sum of all earnings)\n- net: net pay (gross minus all deductions)\n- tax: PAYE total\n- ni: Employee National Insurance Contribution\n- nest: NEST pension contribution\n- sl: Student Loan deduction\n- bonus: Performance Bonus line only\n- ot: Overtime line ONLY (not weekend hours, not holiday pay)\n- weekendOt: Weekend Hours line (£ amount)\n- holidayPay: SUM of all "Holiday" earning lines (could be multiple, may include "Holiday (Contracted Staff YYYY)")\n- hourlyAllowance: SUM of all "Hourly Allowance" lines including any with brackets like "Hourly Allowance (Hols)"\n- regularPay: Regular Hours line (£ amount only)\nIf a field is not present, use 0.00. Return JSON only, no markdown, no explanation.'}
          ]}]})
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error("API " + resp.status + ": " + text.slice(0, 200));
        }
        const data=await resp.json();
        if(data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        if(!data.content) throw new Error("No content in API response: " + JSON.stringify(data).slice(0, 200));
        const rawText = data.content.map(i=>i.text||"").join("").replace(/```json|```/g,"").trim();
        let parsed;
        try { parsed = JSON.parse(rawText); }
        catch(jsonErr) { throw new Error("Could not parse JSON: " + rawText.slice(0, 200)); }
        if(!parsed.month) throw new Error("Missing 'month' field in extracted data");
        // Allowance is active whenever a performance bonus was paid (they're the same tier)
        parsed.perfAllowance = (parsed.bonus || 0) > 0;
        // Save to Supabase
        if (user) {
          try { await trackSave(db.upsertPayslip(user.id, parsed)); }
          catch(dbErr) { console.error("Supabase save failed:", dbErr); }
        }
        successful.push(parsed);
        results.push({ok:true,parsed});
      } catch(err){
        console.error("Upload error for", file.name, err);
        results.push({ok:false,name:file.name,err:err.message||String(err)||"Unknown error"});
      }
    }
    if(successful.length>0){
      setHistory(prev=>{
        let h=[...prev];
        successful.forEach(p=>{const exists=h.find(x=>x.month===p.month);h=exists?h.map(x=>x.month===p.month?p:x):[...h,p];});
        return sortH(h);
      });
      const last=successful[successful.length-1];
      setC("bonus", last.bonus);
      setC("perfAllowance", last.perfAllowance);
      // A payslip means a pay period has closed. If the accumulator still holds a
      // previous period's hours, reset it and clear the calculator now.
      if (shouldResetTimesheet(accumulatedRef.current.lastUpload)) {
        const empty = {otHrs:0,weekendOtHrs:0,weeks:[],days:[],lastUpload:null};
        setAccumulated(empty);
        if (user) db.saveAccumulator(user.id, empty, null);
        setC("otHrs", 0);
        setC("weekendOtHrs", 0);
        setC("holidayHrs", 0);
        setC("stdHrs", getCurrentMonthHours());
      }
    }
    setMultiResults(results);
    setUploadProgress(null);
    setUploading(false);
    e.target.value="";
  };

  const hSB=(id,v)=>{const n=parseFloat(v);updSB(sharedBills.map(b=>b.id===id?{...b,total:isNaN(n)?b.total:n}:b));setEditSh(null);};
  const hGB=(id,v)=>{const n=parseFloat(v);updGB(glynBills.map(b=>b.id===id?{...b,total:isNaN(n)?b.total:n}:b));setEditGl(null);};
  const delSh=id=>{const bill=sharedBills.find(b=>b.id===id);const prevBills=sharedBills;const prevCats=billCats;updSB(sharedBills.filter(b=>b.id!==id));const bc={...billCats};delete bc[id];updBC(bc);showUndoToast((bill?bill.name:"Bill")+" deleted",()=>{updSB(prevBills);updBC(prevCats);});};
  const delGl=id=>{const bill=glynBills.find(b=>b.id===id);const prevBills=glynBills;const prevCats=glynBillCats;updGB(glynBills.filter(b=>b.id!==id));const bc={...glynBillCats};delete bc[id];updGBC(bc);showUndoToast((bill?bill.name:"Bill")+" deleted",()=>{updGB(prevBills);updGBC(prevCats);});};
  const addShBill=()=>{if(!newSh.name.trim())return;updSB([...sharedBills,{id:Date.now(),name:newSh.name.trim(),total:parseFloat(newSh.total)||0,isCarGlyn:newSh.isCarGlyn}]);setNewSh({name:"",total:"",isCarGlyn:false});setAddSh(false);};
  const addGlBill=()=>{if(!newGl.name.trim())return;updGB([...glynBills,{id:Date.now(),name:newGl.name.trim(),total:parseFloat(newGl.total)||0}]);setNewGl({name:"",total:""});setAddGl(false);};
  const addCategory=(isGlyn)=>{if(!newCat.trim())return;const c={id:Date.now(),name:newCat.trim()};isGlyn?updGC([...glynCats,c]):updC([...cats,c]);setNewCat("");setAddingCat(null);};
  const delCat=(id,isGlyn)=>{
    const cat=(isGlyn?glynCats:cats).find(c=>c.id===id);
    if(isGlyn){
      const prevCats=glynCats;const prevBC=glynBillCats;
      const nc=glynCats.filter(c=>c.id!==id);
      const bc={...glynBillCats};Object.keys(bc).forEach(k=>{if(bc[k]===id)delete bc[k];});
      setGlynCats(nc);setGlynBillCats(bc);
      if(user) db.saveAppSettings(user.id,{cats_data:{cats,billCats,glynCats:nc,glynBillCats:bc}});
      showUndoToast((cat?cat.name:"Category")+" deleted",()=>{setGlynCats(prevCats);setGlynBillCats(prevBC);if(user)db.saveAppSettings(user.id,{cats_data:{cats,billCats,glynCats:prevCats,glynBillCats:prevBC}});});
    } else {
      const prevCats=cats;const prevBC=billCats;
      const nc=cats.filter(c=>c.id!==id);
      const bc={...billCats};Object.keys(bc).forEach(k=>{if(bc[k]===id)delete bc[k];});
      setCats(nc);setBillCats(bc);
      saveSharedCats(nc, bc);
      if(user) db.saveAppSettings(user.id,{cats_data:{cats:nc,billCats:bc,glynCats,glynBillCats}});
      showUndoToast((cat?cat.name:"Category")+" deleted",()=>{setCats(prevCats);setBillCats(prevBC);saveSharedCats(prevCats, prevBC);if(user)db.saveAppSettings(user.id,{cats_data:{cats:prevCats,billCats:prevBC,glynCats,glynBillCats}});});
    }
  };
  const renCat=(id,name,isGlyn)=>{isGlyn?updGC(glynCats.map(c=>c.id===id?{...c,name}:c)):updC(cats.map(c=>c.id===id?{...c,name}:c));};
  const drop=(catId,isGlyn)=>{
    if(dragBill.current==null)return;
    if(isGlyn){const bc={...glynBillCats};catId===null?delete bc[dragBill.current]:(bc[dragBill.current]=catId);updGBC(bc);}
    else{const bc={...billCats};catId===null?delete bc[dragBill.current]:(bc[dragBill.current]=catId);updBC(bc);}
    dragBill.current=null;setDragOver(null);
  };

  const showUndoToast=(msg,undo)=>{
    if(toastTimer.current)clearTimeout(toastTimer.current);
    setToast({msg,undo});
    toastTimer.current=setTimeout(()=>setToast(null),5000);
  };
  const assignCat=(billId,catId,isGlyn)=>{
    if(isGlyn){const bc={...glynBillCats};catId==null?delete bc[billId]:(bc[billId]=catId);updGBC(bc);}
    else{const bc={...billCats};catId==null?delete bc[billId]:(bc[billId]=catId);updBC(bc);}
  };
  const renameBill=(billId,name,isGlyn)=>{
    if(isGlyn) updGB(glynBills.map(b=>b.id===billId?{...b,name}:b));
    else updSB(sharedBills.map(b=>b.id===billId?{...b,name}:b));
  };
  const settleSignedOf=(s)=>s.payer==="glyn"?Number(s.amount):-Number(s.amount);
  const addSettlement=()=>{
    const amt=parseFloat(settleForm.amount);
    if(isNaN(amt)||amt<=0)return;
    const me=isOwner?"glyn":"hollie";
    const them=isOwner?"hollie":"glyn";
    const payer=settleForm.mine?me:them;
    const entry={id:Date.now(),kind:settleForm.kind,payer,amount:amt,note:settleForm.note.trim(),entry_date:settleForm.date||new Date().toISOString().slice(0,10),created_by:user?user.id:null};
    setSettlements([entry,...settlements]);
    if(user)trackSave(db.upsertSettlement(entry));
    haptic();
    setSettleOpen(false);
    setSettleForm({kind:"charge",mine:true,amount:"",note:"",date:""});
  };
  const delSettlement=(id)=>{
    const entry=settlements.find(s=>s.id===id);
    const prev=settlements;
    setSettlements(settlements.filter(s=>s.id!==id));
    if(user)trackSave(db.deleteSettlement(id));
    showUndoToast("Entry deleted",()=>{setSettlements(prev);if(user&&entry)trackSave(db.upsertSettlement(entry));});
  };

  const giftYear=new Date().getFullYear();
  const nextBirthday=(dob)=>{
    if(!dob)return null;
    const d=new Date(dob+"T00:00:00");
    if(isNaN(d.getTime()))return null;
    const today=new Date();today.setHours(0,0,0,0);
    let next=new Date(today.getFullYear(),d.getMonth(),d.getDate());
    if(next<today)next=new Date(today.getFullYear()+1,d.getMonth(),d.getDate());
    const days=Math.round((next-today)/86400000);
    return {days,next,turning:next.getFullYear()-d.getFullYear()};
  };
  const saveGift=()=>{
    const name=giftForm.name.trim();
    if(!name)return;
    const existing=giftForm.id?gifts.find(g=>g.id===giftForm.id):null;
    const g={
      id:giftForm.id||Date.now(),
      name,
      dob:giftForm.dob||null,
      notes:giftForm.notes.trim(),
      cost:parseFloat(giftForm.cost)||0,
      birthday_year:existing?existing.birthday_year:null,
      christmas_year:existing?existing.christmas_year:null,
    };
    setGifts(giftForm.id?gifts.map(x=>x.id===g.id?g:x):[...gifts,g]);
    if(user)trackSave(db.upsertGift(g));
    haptic();
    setGiftOpen(false);
    setGiftForm({id:null,name:"",dob:"",notes:"",cost:""});
  };
  const toggleGift=(id,field)=>{   // field: "birthday_year" | "christmas_year"
    const g=gifts.find(x=>x.id===id);if(!g)return;
    const done=g[field]===giftYear;
    const ng={...g,[field]:done?null:giftYear};
    setGifts(gifts.map(x=>x.id===id?ng:x));
    if(user)trackSave(db.upsertGift(ng));
    haptic();
  };
  const delGift=(id)=>{
    const g=gifts.find(x=>x.id===id);
    const prev=gifts;
    setGifts(gifts.filter(x=>x.id!==id));
    if(user)trackSave(db.deleteGift(id));
    setGiftOpen(false);
    showUndoToast("Person removed",()=>{setGifts(prev);if(user&&g)trackSave(db.upsertGift(g));});
  };

  const MONTH_ABBR=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const lastDayLabel=(m)=>{const d=new Date(schedNowYear,m,0).getDate();return `${d} ${MONTH_ABBR[m-1]}`;};
  const schedWhenLabel=(sb)=>{
    const ms=(Array.isArray(sb.months)?sb.months:[]).slice().sort((a,b)=>a-b);
    const names=ms.map(m=>MONTH_ABBR[m-1]).join(", ");
    return sb.freq==="once"?`One-off · ${names} ${sb.year||""}`:`Every year · ${names||"—"}`;
  };
  const saveSchedBill=()=>{
    if(!schedForm)return;
    const name=(schedForm.name||"").trim();
    if(!name||!schedForm.months.length)return;
    const existing=schedForm.id?scheduledBills.find(b=>b.id===schedForm.id):null;
    const row={
      id:schedForm.id||Date.now(),
      name,
      total:parseFloat(schedForm.total)||0,
      is_car_glyn:schedForm.scope==="shared"?!!schedForm.isCarGlyn:false,
      scope:schedForm.scope,
      owner:existing?existing.owner:myId,
      freq:schedForm.freq,
      months:schedForm.freq==="once"?[schedForm.months[0]]:schedForm.months.slice().sort((a,b)=>a-b),
      year:schedForm.freq==="once"?(schedForm.year||schedNowYear):null,
    };
    setScheduledBills(schedForm.id?scheduledBills.map(b=>b.id===row.id?row:b):[...scheduledBills,row]);
    if(user)trackSave(db.upsertScheduledBill(row));
    haptic();
    setSchedForm(null);
  };
  const delSchedBill=(id)=>{
    const b=scheduledBills.find(x=>x.id===id);
    const prev=scheduledBills;
    setScheduledBills(scheduledBills.filter(x=>x.id!==id));
    if(user)trackSave(db.deleteScheduledBill(id));
    setSchedForm(null);
    showUndoToast("Scheduled bill removed",()=>{setScheduledBills(prev);if(user&&b)trackSave(db.upsertScheduledBill(b));});
  };

  const exportData=async()=>{
    const partnerPersonalBills=await fetchPartnerBills();
    const data={history,sharedBills,glynBills,cats,billCats,glynCats,glynBillCats,calcInputs:ci,notes,partnerPersonalBills,settlements,gifts,scheduledBills,exportedAt:new Date().toISOString()};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download="vaulted-backup-"+new Date().toISOString().slice(0,10)+".json";
    a.click();URL.revokeObjectURL(url);
  };

  const importData=e=>{
    const file=e.target.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=ev=>{
      try {
        const d=JSON.parse(ev.target.result);
        if(d.history){updH(d.history);}
        if(d.sharedBills){updSB(d.sharedBills);}
        if(d.glynBills){updGB(d.glynBills);}
        if(d.partnerPersonalBills){restorePartnerBills(d.partnerPersonalBills);}
        if(d.settlements){restoreSettlements(d.settlements);}
        if(d.gifts){restoreGifts(d.gifts);}
        if(d.scheduledBills){restoreScheduledBills(d.scheduledBills);}
        restoreCats(d);
        if(d.calcInputs){setCi(d.calcInputs);if(user) db.saveAppSettings(user.id,{calc_inputs:d.calcInputs});}
        if(d.notes){updNotes(d.notes);}
        setImportMsg("✓ Data restored successfully");
      } catch{setImportMsg("⚠ Invalid backup file");}
    };
    reader.readAsText(file);
    e.target.value="";
  };

  // Timesheet calculation helpers
  const parseHM = str => {
    // Parse "8h 15m", "9h 19m", "8h", "45m" etc into decimal hours
    const hMatch = str.match(/(\d+)h/);
    const mMatch = str.match(/(\d+)m/);
    const h = hMatch ? parseInt(hMatch[1]) : 0;
    const m = mMatch ? parseInt(mMatch[1]) : 0;
    return Math.round((h + m / 60) * 100) / 100;
  };

  // Normalise whatever JLI puts in the Holiday column into a standard value.
// Returns: { isHoliday: bool, isHalf: bool, rawValue: string }
// Designed to handle format changes without code updates.
function normaliseHoliday(val) {
  if (!val || val.trim() === "" || val.trim() === "-") return { isHoliday: false, isHalf: false, rawValue: val || "" };
  const v = val.trim().toLowerCase();
  // Half day signals
  const isHalf = v.includes("half") || v === "0.5" || v === "4h" || v.includes("am") || v.includes("pm") || v.includes("morning") || v.includes("afternoon");
  return { isHoliday: true, isHalf, rawValue: val.trim() };
}

const calcTimesheetTotals = days => {
    let stdHrs = 0, otHrs = 0, weekendOtHrs = 0;
    const STD = 8.25; // 8h 15m
    days.forEach(d => {
      if (d.holiday && d.holiday !== "") return; // skip holiday rows for hour totals
      const hrs = parseHM(d.hours);
      const dayLower = d.day.toLowerCase();
      const isWeekend = dayLower.startsWith("sat") || dayLower.startsWith("sun");
      if (isWeekend) {
        weekendOtHrs += hrs;
      } else {
        if (hrs <= STD) {
          stdHrs += hrs;
        } else {
          stdHrs += STD;
          otHrs += Math.round((hrs - STD) * 100) / 100;
        }
      }
    });
    return {
      stdHrs: Math.round(stdHrs * 100) / 100,
      otHrs: Math.round(otHrs * 100) / 100,
      weekendOtHrs: Math.round(weekendOtHrs * 100) / 100,
    };
  };

  const handleTimesheetUpload = async e => {
    const files = Array.from(e.target.files); if (!files.length) return;
    setTsUploading(true); setTsResults([]); setTsPending(null);
    const allDays = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setTsProgress(`Reading image ${i + 1} of ${files.length}...`);
      try {
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
        const isPdf = file.type === "application/pdf" || file.name.endsWith(".pdf");
        const mediaType = file.type || "image/jpeg";
        const contentBlock = isPdf
          ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
          : { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } };
        const resp = await fetch(API_PROXY, {
          method: "POST",
          headers: await authHeaders(),
          body: JSON.stringify({
            model: "claude-sonnet-4-5", max_tokens: 1000,
            messages: [{ role: "user", content: [
              contentBlock,
              { type: "text", text: 'This is a JLI work timesheet email. Extract each row as a JSON array. Return ONLY a JSON array, no other text:\n[{"date":"DD/MM","day":"Mon","hours":"8h 15m","holiday":""},{"date":"DD/MM","day":"Mon","hours":"0h 00m","holiday":"Full Day"}]\nRules:\n- Include ALL rows including weekends, holidays, and zero-hour days\n- "holiday" field: copy the EXACT text from the Holiday column. If the column is empty or shows "-", use "" (empty string). Do NOT normalise or reword it -- preserve whatever text JLI put there (e.g. "Full Day", "Half Day", "Annual Leave", "AL", "H", "0.5" etc)\n- Holiday rows typically have "-" for In/Out and "0h 00m" for hours\n- Use the hours column value exactly as shown' }
            ]}]
          })
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message);
        const text = data.content.map(i => i.text || "").join("").replace(/```json|```/g, "").trim();
        const days = JSON.parse(text);
        allDays.push(...days);
        setTsResults(prev => [...prev, { ok: true, file: file.name, days }]);
      } catch (err) {
        setTsResults(prev => [...prev, { ok: false, file: file.name, err: err.message }]);
      }
    }
    if (allDays.length > 0) {
      const totals = calcTimesheetTotals(allDays);
      setTsPending({ days: allDays, totals });
    }
    setTsProgress(null);
    setTsUploading(false);
    e.target.value = "";
  };

  const confirmTimesheet = async () => {
    if (!tsPending) return;
    const now = new Date().toISOString();
    const STD = 8.25;
    const enrichedDays = tsPending.days.map(d => {
      const { isHoliday, isHalf } = normaliseHoliday(d.holiday);
      const hrs = isHoliday ? 0 : parseHM(d.hours);
      const isWeekend = d.day.toLowerCase().startsWith("sat") || d.day.toLowerCase().startsWith("sun");
      const otHrs = (isHoliday || isWeekend) ? 0 : Math.max(0, Math.round((hrs - STD) * 100) / 100);
      const wkOtHrs = (!isHoliday && isWeekend) ? hrs : 0;
      return { ...d, hrs, otHrs, wkOtHrs, isHoliday, isHalf };
    });

    // Auto-log holiday rows to annual leave
    const holidayDays = enrichedDays.filter(d => d.isHoliday);
    if (holidayDays.length > 0) {
      const newLeaveEntries = holidayDays.map(d => {
        const [dd, mm] = d.date.split("/").map(Number);
        const year = new Date().getFullYear();
        const dateStr = new Date(year, mm - 1, dd).toISOString().slice(0, 10);
        const hours = d.isHalf ? STD_DAY_HRS / 2 : STD_DAY_HRS;
        return { id: Date.now() + Math.random(), date: dateStr, hours, label: "Annual Leave (from timesheet)" };
      });
      setLeaveLogs(prev => {
        const merged = [...prev, ...newLeaveEntries].filter((entry, idx, arr) =>
          arr.findIndex(e => e.date === entry.date) === idx
        ).sort((a, b) => new Date(b.date) - new Date(a.date));
        return merged;
      });
    }
    const sortAndDedup = days => {
      const seen = new Set();
      return [...days]
        .sort((a, b) => {
          const [ad, am] = (a.date || "").split("/").map(Number);
          const [bd, bm] = (b.date || "").split("/").map(Number);
          return (am !== bm ? am - bm : ad - bd);
        })
        .filter(d => {
          const key = d.date + "_" + d.day;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const mergedDays = sortAndDedup([...(accumulated.days||[]), ...enrichedDays]);
    // Derive totals from the deduplicated days -- single source of truth
    const totalOtHrs = Math.round(mergedDays.reduce((s,d) => s + (d.otHrs||0), 0) * 100) / 100;
    const totalWkndHrs = Math.round(mergedDays.reduce((s,d) => s + (d.wkOtHrs||0), 0) * 100) / 100;
    const newAcc = {
      otHrs: totalOtHrs,
      weekendOtHrs: totalWkndHrs,
      weeks: [...accumulated.weeks, { uploadedAt: now, ...tsPending.totals }],
      days: mergedDays,
      lastUpload: now,
    };
    setAccumulated(newAcc);
    if (user) await trackSave(() => db.saveAccumulator(user.id, newAcc, now));
    setTsLastUpload(now);
    setC("otHrs", newAcc.otHrs);
    setC("weekendOtHrs", newAcc.weekendOtHrs);
    setTsPending(null);
  };

  const resetTimesheet = () => {
    const empty = { otHrs: 0, weekendOtHrs: 0, weeks: [], days: [], lastUpload: null };
    setAccumulated(empty);
    if (user) db.saveAccumulator(user.id, empty, null).catch(()=>{});
    setTsPending(null);
  };

  const card={background:"#141824",borderRadius:10,border:"1px solid #1e2535",padding:"14px 12px"};
  const hdr={fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:6};
  const inp={background:"#1e2535",border:"1px solid #2a3050",borderRadius:6,color:"#e8eaf0",fontSize:13,padding:"8px 10px",width:"100%",boxSizing:"border-box"};
  const numI={...inp,textAlign:"right",fontWeight:700};
  const row={display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #1a1f2e",fontSize:12};

  const allSorted=useMemo(()=>sortH(history),[history]);
  const missingMonths=useMemo(()=>getMissingMonths(history),[history]);

  const [nowTick, setNowTick] = useState(Date.now());
  React.useEffect(() => {
    // Update every hour to keep the payday countdown accurate
    const timer = setInterval(() => setNowTick(Date.now()), 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  const nextPayday=useMemo(()=>{
    const pd=getNextPayday();
    const days=Math.ceil((pd-new Date(nowTick))/(1000*60*60*24));
    return {date:pd.toLocaleDateString("en-GB",{day:"numeric",month:"short"}),days};
  },[nowTick]);

  const slProgress=useMemo(()=>{
    const elapsed=new Date().getFullYear()-SL_START_YEAR;
    const total=SL_WRITEOFF_YEAR-SL_START_YEAR;
    return {elapsed,total,pct:Math.min(100,Math.round(elapsed/total*100)),yearsLeft:total-elapsed};
  },[]);

  const filteredHistory=useMemo(()=>{
    if(!payslipSearch.trim()) return [...history].reverse();
    const q=payslipSearch.toLowerCase();
    return [...history].reverse().filter(r=>r.month.toLowerCase().includes(q));
  },[history,payslipSearch]);

  // Auth loading
  if (authLoading) {
    return <div style={{minHeight:"100vh",background:"#0d0f14",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
      <div style={{fontSize:42,opacity:0.7}}>🔐</div>
      <h1 style={{margin:0,fontSize:18,fontWeight:800,color:"#fff",letterSpacing:3}}><span style={{color:"#4a9eff"}}>V</span>AULTED</h1>
      <div style={{color:"#3a4460",fontSize:11}}>Checking session...</div>
    </div>;
  }

  // Not logged in
  if (!user) {
    return <LoginScreen onLogin={u => setUser(u)} />;
  }

  // Data loading - show skeleton matching dashboard shape
  if (dataLoading) {
    const skBox = { background:"#141824", borderRadius:12, border:"1px solid #1e2535", animation:"pulse 1.5s ease-in-out infinite" };
    return (
      <div style={{minHeight:"100vh",background:"#0d0f14",color:"#e8eaf0",fontFamily:"'DM Sans','Segoe UI',sans-serif",paddingBottom:80}}>
        <style>{`@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 0.7; } }`}</style>
        <div style={{background:"linear-gradient(135deg,#1a1f2e,#0d1117)",borderBottom:"1px solid #1e2535",padding:"14px 14px 12px",position:"sticky",top:0,zIndex:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <h1 style={{margin:0,fontSize:20,fontWeight:800,color:"#fff",letterSpacing:3}}><span style={{color:"#4a9eff"}}>V</span>AULTED</h1>
            <div style={{color:"#4a9eff",fontSize:11,fontWeight:600}}>Loading...</div>
          </div>
        </div>
        <div style={{padding:"14px 12px"}}>
          <div style={{...skBox, height:80, marginBottom:14}}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
            <div style={{...skBox, height:62}}/>
            <div style={{...skBox, height:62}}/>
            <div style={{...skBox, height:62}}/>
          </div>
          <div style={{...skBox, height:140, marginBottom:14}}/>
          <div style={{...skBox, height:200}}/>
        </div>
      </div>
    );
  }


  const primaryTabs = isOwner ? PRIMARY_TABS : ["Budget","Pay Calc","Settle Up","Gifts"];
  const secondaryTabs = isOwner ? SECONDARY_TABS : ["Diag"];

  return (
    <ErrorBoundary>
    <div
      onTouchStart={e=>{ if(window.scrollY<=0&&!showMore&&!moveBill&&!scrollableAncestorScrolled(e.target)){pullStart.current=e.touches[0].clientY;pullDist.current=0;} else {pullStart.current=null;} }}
      onTouchMove={e=>{ if(pullStart.current==null||refreshing)return; if(window.scrollY>0){pullStart.current=null;pullDist.current=0;if(pullY!==0)setPullY(0);return;} const dy=e.touches[0].clientY-pullStart.current; if(dy>12){const d=Math.min((dy-12)*0.5,90);pullDist.current=d;setPullY(d);} else if(pullDist.current!==0){pullDist.current=0;setPullY(0);} }}
      onTouchEnd={()=>{ if(pullStart.current==null)return; const d=pullDist.current; pullStart.current=null; pullDist.current=0; if(d>70&&!refreshing){setRefreshing(true);setPullY(0);haptic("medium");Promise.resolve(refreshAll&&refreshAll()).finally(()=>setTimeout(()=>setRefreshing(false),600));} else {setPullY(0);} }}
      style={{minHeight:"100vh",background:"#0d0f14",color:"#e8eaf0",fontFamily:"'DM Sans','Segoe UI',sans-serif",paddingBottom:"calc(96px + env(safe-area-inset-bottom))"}}>
      {/* Auto-import toast */}
      {tsAutoMsg && (
        <div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",zIndex:999,background:tsAutoMsg.ok?"#0a1a10":"#1a0a10",border:"1px solid "+(tsAutoMsg.ok?"#00c88c":"#ff4a6a"),borderRadius:10,padding:"10px 18px",fontSize:13,fontWeight:600,color:tsAutoMsg.ok?"#00c88c":"#ff6b8a",boxShadow:"0 4px 20px #000a",whiteSpace:"nowrap"}}>
          {tsAutoMsg.text}
        </div>
      )}

      <div style={{background:"linear-gradient(135deg,#1a1f2e,#0d1117)",borderBottom:"1px solid #1e2535",padding:"14px 14px",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <h1 style={{margin:0,fontSize:20,fontWeight:800,color:"#fff",letterSpacing:3}}>
            <span style={{color:"#4a9eff"}}>V</span>AULTED
          </h1>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <SyncIndicator onClick={()=>{haptic();setShowMore(false);setTab("Diag");}}/>
            <button onClick={()=>{haptic("medium");handleSignOut();}} title="Sign out"
              style={{background:"none",border:"none",color:"#3a4460",fontSize:18,cursor:"pointer",padding:"4px 6px",lineHeight:1}}>🔒</button>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:11,color:"#5a6480"}}>{history.length} payslips</div>
            <div style={{fontSize:11,color:"#3a4460"}}>Paid in <span style={{color:"#ffb84a",fontWeight:700}}>{nextPayday.days}d</span> - {nextPayday.date}</div>
          </div>
        </div>
      </div>

      <div style={{padding:"14px 12px"}}>

        {tab==="Dashboard"&&(
          <div>
            {discrepancies.filter(d=>d.status==="discrepancy"&&!dismissedDiscs.includes(d.month)).length>0&&(
              <div onClick={()=>{haptic();const first=discrepancies.find(d=>d.status==="discrepancy"&&!dismissedDiscs.includes(d.month));if(first)setExpandedMonth(first.month);setTab("Timesheet");}} style={{background:"#1a0a0a",border:"1px solid #ff4a6a",borderRadius:12,padding:"13px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
                <span style={{fontSize:20}}>⚠️</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#ff6b8a"}}>Pay discrepancy detected</div>
                  <div style={{fontSize:11,color:"#8a3040",marginTop:2}}>
                    {discrepancies.filter(d=>d.status==="discrepancy"&&!dismissedDiscs.includes(d.month)).map(d=>d.month).join(", ")} - Tap to review
                  </div>
                </div>
                <span style={{fontSize:11,color:"#ff6b8a",fontWeight:700}}>Review -></span>
              </div>
            )}

            {sessionWarning && (
              <div style={{background:"#1a1500",border:"1px solid #ffb84a",borderRadius:12,padding:"13px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:20}}>⏰</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#ffb84a"}}>Session expiring soon</div>
                  <div style={{fontSize:11,color:"#7a6030",marginTop:2}}>You'\''ll be signed out shortly. Refresh data or sign in again to extend.</div>
                </div>
                <button onClick={async () => {
                  haptic("medium");
                  const { error } = await supabase.auth.refreshSession();
                  if (!error) { setSessionWarning(false); refreshAll(); }
                }} style={{background:"#ffb84a22",border:"1px solid #ffb84a",borderRadius:6,color:"#ffb84a",fontSize:11,fontWeight:700,padding:"6px 10px",cursor:"pointer"}}>Refresh</button>
              </div>
            )}

            {!pwaInstalled && pwaPrompt && (
              <div onClick={triggerInstall} style={{background:"#0a1520",border:"1px solid #4a9eff44",borderRadius:12,padding:"13px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
                <span style={{fontSize:20}}>📲</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#4a9eff"}}>Add Vaulted to Home Screen</div>
                  <div style={{fontSize:11,color:"#3a4460",marginTop:2}}>Install for quick access -- works offline</div>
                </div>
                <span style={{fontSize:11,color:"#4a9eff",fontWeight:700}}>Install -></span>
              </div>
            )}
            {showTsReminder&&(
              <div onClick={()=>{setShowPayslipUpload(true);setTab("Diag");}} style={{background:"#1a1500",border:"1px solid #ffb84a",borderRadius:12,padding:"13px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
                <span style={{fontSize:20}}>⚠️</span>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:"#ffb84a"}}>Timesheet due</div>
                  <div style={{fontSize:12,color:"#8a7040",marginTop:2}}>{tsLastUpload?`Last uploaded ${Math.floor((new Date()-new Date(tsLastUpload))/(1000*60*60*24))} days ago`:"No timesheet uploaded yet"} - Tap to upload</div>
                </div>
              </div>
            )}
            {missingMonths.length>0&&(
              <div style={{background:"#1a0f1a",border:"1px solid #c84aff",borderRadius:12,padding:"13px 14px",marginBottom:12}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                  <span style={{fontSize:16}}>📭</span>
                  <span style={{fontSize:13,fontWeight:700,color:"#c84aff"}}>Missing payslips detected</span>
                </div>
                <div style={{fontSize:12,color:"#8a5080",lineHeight:1.8}}>{missingMonths.join(", ")}</div>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              {[
                {label:"Est. Net Pay",    value:fmt(cr.net),      sub:"from Pay Calc",   accent:"#4a9eff"},
                {label:"Monthly Surplus", value:fmt(surplus),     sub:"after all bills", accent:surplus>=0?"#00c88c":"#ff4a6a"},
                {label:"Latest Net",      value:fmt(latest?.net), sub:latest?.month,     accent:"#7c6fff"},
                {label:"FY Avg Net",      value:fmt(ts.avgNet),   sub:"Apr to now",      accent:"#ffb84a"},
              ].map(k=>(
                <div key={k.label} style={{...card,textAlign:"center",padding:"14px 10px"}}>
                  <div style={{fontSize:11,color:"#5a6480",fontWeight:600,letterSpacing:0.5,textTransform:"uppercase",marginBottom:6}}>{k.label}</div>
                  <div style={{fontSize:22,fontWeight:700,color:k.accent,letterSpacing:-0.5}}>{k.value}</div>
                  <div style={{fontSize:11,color:"#3a4460",marginTop:4}}>{k.sub}</div>
                </div>
              ))}
            </div>

            {history.length>0&&(()=>{
              const fyt=fyTotals(history);
              if(fyt.count===0) return null;
              return(
                <div style={{...card,marginBottom:12}}>
                  <SectionLabel>Tax Year {fyt.fyLabel} — On Track</SectionLabel>
                  <div style={{fontSize:10,color:"#3a4460",marginBottom:8}}>Projected full year · based on {fyt.count}/12 payslips</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div style={{background:"#0d1117",borderRadius:8,padding:"10px",textAlign:"center"}}>
                      <div style={{fontSize:11,color:"#5a6480",marginBottom:4}}>Gross</div>
                      <div style={{fontSize:16,fontWeight:700,color:"#7c6fff"}}>{fmt(fyt.projGross)}</div>
                      <div style={{fontSize:10,color:"#3a4460",marginTop:3}}>{fmt(fyt.gross)} so far</div>
                    </div>
                    <div style={{background:"#0d1117",borderRadius:8,padding:"10px",textAlign:"center"}}>
                      <div style={{fontSize:11,color:"#5a6480",marginBottom:4}}>Net</div>
                      <div style={{fontSize:16,fontWeight:700,color:"#4a9eff"}}>{fmt(fyt.projNet)}</div>
                      <div style={{fontSize:10,color:"#3a4460",marginTop:3}}>{fmt(fyt.net)} so far</div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {latest&&prevMonth&&(()=>{
              return(
                <div style={{...card,marginBottom:12}}>
                  <SectionLabel>Latest vs Previous Month</SectionLabel>
                  <div style={{fontSize:10,color:"#3a4460",marginBottom:8}}>{latest.month} vs {prevMonth.month}</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                    {[
                      {label:"Gross",diff:latest.gross-prevMonth.gross,prev:prevMonth.gross,val:fmt(latest.gross)},
                      {label:"Net",  diff:latest.net-prevMonth.net,    prev:prevMonth.net,  val:fmt(latest.net)},
                      {label:"Bonus",diff:latest.bonus-prevMonth.bonus,prev:prevMonth.bonus,val:fmt(latest.bonus)},
                    ].map(k=>{
                      const pct = k.prev > 0 ? Math.round((k.diff/k.prev)*1000)/10 : null;
                      return (
                        <div key={k.label} style={{background:"#0d1117",borderRadius:8,padding:"10px",textAlign:"center"}}>
                          <div style={{fontSize:11,color:"#5a6480",marginBottom:4}}>{k.label}</div>
                          <div style={{fontSize:14,fontWeight:700,color:"#e8eaf0"}}>{k.val}</div>
                          <div style={{fontSize:11,fontWeight:600,color:k.diff>=0?"#00c88c":"#ff6b8a",marginTop:3}}>
                            {k.diff>=0?"+":""}{fmt(Math.abs(k.diff))}
                            {pct !== null && <span style={{fontSize:9,marginLeft:4,opacity:0.7}}>({pct>=0?"+":""}{pct}%)</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            <div style={{...card,marginBottom:12}}>
              <SectionLabel>Monthly Budget</SectionLabel>
              {[
                ["Est. Net Pay",          fmt(cr.net),   "#4a9eff"],
                ["Shared Bills (my half)",fmt(shGlyn),   "#ff6b8a"],
                ["My Personal Bills",     fmt(glOnly),   "#ff8c4a"],
                ["Total Outgoings",       fmt(totalOut), "#ff4a6a"],
                ["Monthly Surplus",       fmt(surplus),  surplus>=0?"#00c88c":"#ff4a6a"],
              ].map(([l,v,c],i,arr)=>(
                <StatRow key={l} label={l} value={v} color={c} last={i===arr.length-1}/>
              ))}
            </div>

            <div style={{...card,marginBottom:12}}>
              <SectionLabel>Student Loan -- Plan 2</SectionLabel>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                <span style={{fontSize:13,color:"#8892b0"}}>{slProgress.elapsed} of {slProgress.total} years</span>
                <span style={{fontSize:13,fontWeight:700,color:"#c84aff"}}>{slProgress.pct}% complete</span>
              </div>
              <div style={{background:"#1e2535",borderRadius:99,height:8,overflow:"hidden",marginBottom:6}}>
                <div style={{width:slProgress.pct+"%",height:"100%",background:"linear-gradient(90deg,#7c6fff,#c84aff)",borderRadius:99}}/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#3a4460"}}>
                <span>Started {SL_START_YEAR}</span>
                <span style={{color:"#5a6480"}}>{slProgress.yearsLeft} years to write-off</span>
                <span>Write-off {SL_WRITEOFF_YEAR}</span>
              </div>
            </div>

            <div style={{...card,marginBottom:12}}>
              <button onClick={()=>setShowAllTimeTotals(o=>!o)} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",background:"none",border:"none",cursor:"pointer",padding:0,marginBottom:showAllTimeTotals?12:0}}>
                <SectionLabel>All-Time Totals</SectionLabel>
                <span style={{fontSize:12,color:"#3a4460",marginTop:-10}}>{showAllTimeTotals?"A":"V"}</span>
              </button>
              {showAllTimeTotals&&[
                ["Total Earned (Gross)", fmt(ts.gross), "#7c6fff"],
                ["Total Net Received",   fmt(ts.net),   "#4a9eff"],
                ["Total Tax Paid",       fmt(ts.tax),   "#ff6b8a"],
                ["Total NI Paid",        fmt(ts.ni),    "#ff8c4a"],
                ["Total NEST",           fmt(ts.nest),  "#00c88c"],
                ["Total Student Loan",   fmt(ts.sl),    "#ffb84a"],
                ["Total Bonuses",        fmt(ts.bonus), "#c84aff"],
                ["Total Overtime Pay",   fmt(ts.ot),    "#4affd4"],
              ].map(([l,v,c],i,arr)=>(
                <StatRow key={l} label={l} value={v} color={c} last={i===arr.length-1}/>
              ))}
            </div>

            <div style={{fontSize:12,color:"#5a6480",fontWeight:600,marginBottom:8}}>Historical Charts</div>
            <div style={{border:"1px solid #1e2535",borderRadius:10,overflow:"hidden",marginBottom:8}}>
              <button onClick={()=>{haptic();setNetTrendOpen(o=>!o);}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"13px 14px",background:"#141824",border:"none",cursor:"pointer",color:"#e8eaf0"}}>
                <span style={{fontSize:13,fontWeight:600,color:"#8892b0"}}>Net Pay Trend</span>
                <span style={{fontSize:12,color:"#3a4460"}}>{netTrendOpen?"A":"V"}</span>
              </button>
              {netTrendOpen&&(
                <div style={{padding:"12px",background:"#111520"}}>
                  <div style={{display:"flex",justifyContent:"flex-end",gap:3,marginBottom:10}}>
                    {RANGES.map(r=>(
                      <button key={r} onClick={()=>setChartRange(r)} style={{
                        background:chartRange===r?"#4a9eff":"#1e2535",color:chartRange===r?"#fff":"#3a4460",
                        border:"none",borderRadius:4,padding:"3px 7px",fontSize:10,fontWeight:600,cursor:"pointer"
                      }}>{r}</button>
                    ))}
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
              )}
            </div>
            {[
              {title:"Gross Pay",    key:"gross", color:"#7c6fff"},
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
            {isOwner && (()=>{
              const savingsRate = cr.net > 0 ? Math.round((cr.net - totalOut) / cr.net * 100) : 0;
              const srColor = savingsRate >= 20 ? "#00c88c" : savingsRate >= 10 ? "#ffb84a" : "#ff4a6a";
              return (
                <div style={{...card,marginBottom:12,background:"linear-gradient(135deg,#0a1520,#0d1117)",border:"1px solid #1e2535"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <span style={{fontSize:11,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>Monthly Surplus</span>
                    <span style={{fontSize:22,fontWeight:800,color:srColor}}>{savingsRate}%</span>
                  </div>
                  <div style={{background:"#1e2535",borderRadius:99,height:8,overflow:"hidden",marginBottom:6}}>
                    <div style={{width:Math.max(0,Math.min(100,savingsRate))+"%",height:"100%",background:`linear-gradient(90deg,${srColor}88,${srColor})`,borderRadius:99,transition:"width 0.3s"}}/>
                  </div>
                  <div style={{fontSize:10,color:"#3a4460",textAlign:"center"}}>
                    (Net Pay - Total Bills) / Net Pay - <span style={{color:savingsRate>=0?"#00c88c":"#ff4a6a"}}>{fmt(Math.abs(surplus))} {surplus>=0?"saved":"overspent"}</span> per month
                  </div>
                </div>
              );
            })()}
            {billChanges.length > 0 && (
              <div style={{background:"#0a1525",border:"1px solid #4a9eff44",borderRadius:12,padding:"12px 14px",marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:13,fontWeight:700,color:"#4a9eff"}}>📊 Bills changed</span>
                  <button onClick={dismissBillChanges} style={{background:"none",border:"none",color:"#3a4460",fontSize:11,cursor:"pointer"}}>Dismiss</button>
                </div>
                {billChanges.map((c,i)=>{
                  const diff = c.new - c.old;
                  const up = diff > 0;
                  return (
                    <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:11}}>
                      <span style={{color:"#8892b0"}}>{c.name}</span>
                      <span>
                        <span style={{color:"#5a6480"}}>{fmt(c.old)} -> </span>
                        <span style={{color:"#e8eaf0",fontWeight:600}}>{fmt(c.new)}</span>
                        <span style={{color:up?"#ff8c4a":"#00c88c",marginLeft:6,fontWeight:700}}>
                          {up?"+":""}{fmt(diff)}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {isOwner ? (
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
            ) : (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
              {[
                {label:"Your share of shared bills",value:fmt(shHollie),accent:"#c84aff"},
                {label:"Your personal bills",       value:fmt(glOnly), accent:"#ff8c4a"},
              ].map(k=>(
                <div key={k.label} style={{...card,textAlign:"center",padding:"12px 6px"}}>
                  <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>{k.label}</div>
                  <div style={{fontSize:16,fontWeight:800,color:k.accent}}>{k.value}</div>
                </div>
              ))}
            </div>
            )}

            <div style={{display:"flex",gap:4,marginBottom:12}}>
              {[["shared","Shared Bills"],["glyn","My Bills"]].map(([v,l])=>(
                <button key={v} onClick={()=>setBudTab(v)} style={{
                  flex:1,background:budTab===v?"#4a9eff":"#141824",color:budTab===v?"#fff":"#5a6480",
                  border:"1px solid "+(budTab===v?"#4a9eff":"#1e2535"),borderRadius:8,padding:"9px",fontSize:12,fontWeight:600,cursor:"pointer"
                }}>{l}</button>
              ))}
            </div>

            {(()=>{
              const activeCount=(budTab==="shared"?activeSchedShared:activeSchedPersonal).length;
              return (
                <button onClick={()=>{haptic();setSchedForm(null);setSchedOpen(true);}}
                  style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"#161b28",border:"1px dashed #2a3a55",borderRadius:8,color:"#8ec5ff",fontSize:12,fontWeight:600,padding:"10px",cursor:"pointer",marginBottom:12}}>
                  📅 Scheduled bills{activeCount?` · ${activeCount} due this month`:""}
                </button>
              );
            })()}

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
                <div style={{display:"grid",gridTemplateColumns:"1fr 70px 64px 64px 26px",padding:"10px 12px",background:"#0d1117",borderRadius:"8px 8px 0 0",fontSize:10,fontWeight:700,color:"#7a8499",letterSpacing:1.5,textTransform:"uppercase",border:"1px solid #1e2535",borderBottom:"none"}}>
                  <span>Bill</span><span style={{textAlign:"right"}}>Total</span><span style={{textAlign:"right",color:"#4a9eff"}}>Glyn</span><span style={{textAlign:"right",color:"#c84aff"}}>Hollie</span><span></span>
                </div>
                {cats.map(cat=>(
                  <CatSection key={cat.id} cat={cat} bills={sharedBills} billCats={billCats} isGlynOnly={false}
                    editingBill={editSh} setEditingBill={setEditSh} onBillBlur={hSB} onBillDelete={delSh}
                    onCatDelete={id=>delCat(id,false)} onCatRename={(id,n)=>renCat(id,n,false)}
                    onBillMove={id=>setMoveBill({id,isGlyn:false})}
                    dragBill={dragBill} setDragOver={setDragOver} dragOver={dragOver} onDrop={id=>drop(id,false)}/>
                ))}
                {(()=>{const u=sharedBills.filter(b=>!billCats[b.id]);if(!u.length)return null;return(
                  <div onDragOver={e=>{e.preventDefault();setDragOver("ush");}} onDragLeave={()=>setDragOver(null)} onDrop={()=>drop(null,false)}
                    style={{border:"1px solid "+(dragOver==="ush"?"#4a9eff":"#1e2535"),borderTop:"none"}}>
                    <div style={{padding:"8px 10px",background:dragOver==="ush"?"#0d1525":"#0f1520"}}><span style={{fontSize:10,fontWeight:700,color:"#3a4460",textTransform:"uppercase",letterSpacing:1}}>Uncategorised</span></div>
                    {u.map((b,i)=><BillRow key={b.id} bill={b} idx={i} isGlynOnly={false} editing={editSh===b.id} onEditStart={()=>setEditSh(b.id)} onEditBlur={v=>hSB(b.id,v)} onDelete={()=>delSh(b.id)} onMove={()=>setMoveBill({id:b.id,isGlyn:false})} onDragStart={()=>{dragBill.current=b.id;}}/>)}
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
                {activeSchedShared.length>0&&(
                  <div style={{border:"1px solid #2a3a55",borderTop:"none"}}>
                    <div style={{padding:"8px 10px",background:"#0e1726"}}><span style={{fontSize:10,fontWeight:700,color:"#8ec5ff",textTransform:"uppercase",letterSpacing:1}}>📅 Due this month</span></div>
                    {activeSchedShared.map(b=>{
                      const sh=schedShares(b);
                      return (
                        <div key={b.id} onClick={()=>{haptic();setSchedForm({id:b.id,name:b.name,total:b.total!=null?String(b.total):"",isCarGlyn:!!b.is_car_glyn,scope:b.scope,freq:b.freq,months:Array.isArray(b.months)?b.months:[],year:b.year||schedNowYear});setSchedOpen(true);}}
                          style={{display:"grid",gridTemplateColumns:"1fr 70px 64px 64px 26px",alignItems:"center",padding:"10px",fontSize:12,borderTop:"1px solid #141824",background:"#0c1320",cursor:"pointer"}}>
                          <span style={{minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}><span style={{color:"#e8eaf0",fontWeight:600}}>{b.name}</span><span style={{display:"block",fontSize:9,color:"#5a6480"}}>ends {lastDayLabel(schedNowMonth)}</span></span>
                          <span style={{textAlign:"right",color:"#8892b0"}}>{fmt(b.total)}</span>
                          <span style={{textAlign:"right",color:"#4a9eff"}}>{fmt(sh.glyn)}</span>
                          <span style={{textAlign:"right",color:"#c84aff"}}>{fmt(sh.hollie)}</span>
                          <span style={{textAlign:"center",color:"#3a4460",fontSize:13}}>›</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div style={{display:"grid",gridTemplateColumns:"1fr 70px 64px 64px 26px",padding:"10px 10px",fontSize:11,fontWeight:700,background:"#141824",border:"1px solid #1e2535",borderTop:"1px solid #2a3050"}}>
                  <span style={{color:"#5a6480"}}>TOTAL</span>
                  <span style={{textAlign:"right",color:"#5a6480"}}>{fmt(sharedBills.reduce((s,b)=>s+b.total,0)+schedShTotal)}</span>
                  <span style={{textAlign:"right",color:"#4a9eff"}}>{fmt(shGlyn)}</span>
                  <span style={{textAlign:"right",color:"#c84aff"}}>{fmt(shHollie)}</span>
                  <span></span>
                </div>
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  <button onClick={()=>setAddSh(true)} style={{flex:1,background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#00c88c",fontSize:12,fontWeight:600,padding:"10px",cursor:"pointer"}}>+ Add Bill</button>
                  {isOwner && <button onClick={()=>{if(!window.confirm("Reset all shared bills to defaults? This cannot be undone."))return;updSB(INITIAL_SHARED_BILLS);updC([]);updBC({});}} style={{background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#3a4460",fontSize:11,padding:"10px 12px",cursor:"pointer"}}>Reset</button>}
                </div>
                <p style={{fontSize:10,color:"#3a4460",marginTop:8,textAlign:"center"}}>Tap total to edit · tap a bill to rename or move it · double-tap a category to rename</p>
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
                <div style={{display:"grid",gridTemplateColumns:"1fr 80px 26px",padding:"10px 12px",background:"#0d1117",borderRadius:"8px 8px 0 0",fontSize:10,fontWeight:700,color:"#7a8499",letterSpacing:1.5,textTransform:"uppercase",border:"1px solid #ff8c4a",borderBottom:"none"}}>
                  <span>Bill</span><span style={{textAlign:"right",color:"#ff8c4a"}}>Amount</span><span></span>
                </div>
                {glynCats.map(cat=>(
                  <CatSection key={cat.id} cat={cat} bills={glynBills} billCats={glynBillCats} isGlynOnly={true}
                    editingBill={editGl} setEditingBill={setEditGl} onBillBlur={hGB} onBillDelete={delGl}
                    onCatDelete={id=>delCat(id,true)} onCatRename={(id,n)=>renCat(id,n,true)}
                    onBillMove={id=>setMoveBill({id,isGlyn:true})}
                    dragBill={dragBill} setDragOver={setDragOver} dragOver={dragOver} onDrop={id=>drop(id,true)}/>
                ))}
                {(()=>{const u=glynBills.filter(b=>!glynBillCats[b.id]);if(!u.length)return null;return(
                  <div onDragOver={e=>{e.preventDefault();setDragOver("ugl");}} onDragLeave={()=>setDragOver(null)} onDrop={()=>drop(null,true)}
                    style={{border:"1px solid "+(dragOver==="ugl"?"#4a9eff":"#ff8c4a"),borderTop:"none"}}>
                    <div style={{padding:"8px 10px",background:dragOver==="ugl"?"#0d1525":"#0f1520"}}><span style={{fontSize:10,fontWeight:700,color:"#ff8c4a",textTransform:"uppercase",letterSpacing:1}}>Uncategorised</span></div>
                    {u.map((b,i)=><BillRow key={b.id} bill={b} idx={i} isGlynOnly={true} editing={editGl===b.id} onEditStart={()=>setEditGl(b.id)} onEditBlur={v=>hGB(b.id,v)} onDelete={()=>delGl(b.id)} onMove={()=>setMoveBill({id:b.id,isGlyn:true})} onDragStart={()=>{dragBill.current=b.id;}}/>)}
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
                {activeSchedPersonal.length>0&&(
                  <div style={{border:"1px solid #2a3a55",borderTop:"none"}}>
                    <div style={{padding:"8px 10px",background:"#0e1726"}}><span style={{fontSize:10,fontWeight:700,color:"#8ec5ff",textTransform:"uppercase",letterSpacing:1}}>📅 Due this month</span></div>
                    {activeSchedPersonal.map(b=>(
                      <div key={b.id} onClick={()=>{haptic();setSchedForm({id:b.id,name:b.name,total:b.total!=null?String(b.total):"",isCarGlyn:!!b.is_car_glyn,scope:b.scope,freq:b.freq,months:Array.isArray(b.months)?b.months:[],year:b.year||schedNowYear});setSchedOpen(true);}}
                        style={{display:"grid",gridTemplateColumns:"1fr 80px 26px",alignItems:"center",padding:"10px",fontSize:12,borderTop:"1px solid #141824",background:"#0c1320",cursor:"pointer"}}>
                        <span style={{minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}><span style={{color:"#e8eaf0",fontWeight:600}}>{b.name}</span><span style={{display:"block",fontSize:9,color:"#5a6480"}}>ends {lastDayLabel(schedNowMonth)}</span></span>
                        <span style={{textAlign:"right",color:"#ff8c4a"}}>{fmt(b.total)}</span>
                        <span style={{textAlign:"center",color:"#3a4460",fontSize:13}}>›</span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{display:"grid",gridTemplateColumns:"1fr 80px 26px",padding:"10px 10px",fontSize:11,fontWeight:700,background:"#141824",border:"1px solid #ff8c4a",borderTop:"1px solid #2a3050"}}>
                  <span style={{color:"#5a6480"}}>TOTAL</span>
                  <span style={{textAlign:"right",color:"#ff8c4a"}}>{fmt(glOnly)}</span>
                  <span></span>
                </div>
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  <button onClick={()=>setAddGl(true)} style={{flex:1,background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#00c88c",fontSize:12,fontWeight:600,padding:"10px",cursor:"pointer"}}>+ Add Bill</button>
                  {isOwner && <button onClick={()=>{if(!window.confirm("Reset all personal bills to defaults? This cannot be undone."))return;updGB(INITIAL_GLYN_BILLS);updGC([]);updGBC({});}} style={{background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#3a4460",fontSize:11,padding:"10px 12px",cursor:"pointer"}}>Reset</button>}
                </div>
                <p style={{fontSize:10,color:"#3a4460",marginTop:8,textAlign:"center"}}>Tap amount to edit · tap a bill to rename or move it · double-tap a category to rename</p>
              </div>
            )}
          </div>
        )}

        {tab==="Pay Calc"&&!isOwner&&(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div style={{...card,background:"linear-gradient(135deg,#1a0a25,#0d1117)",border:"1px solid #c84aff"}}>
              <div style={{textAlign:"center",marginBottom:14}}>
                <div style={{fontSize:11,color:"#c84aff",fontWeight:700,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>Estimated Net Pay</div>
                <div style={{fontSize:38,fontWeight:700,color:"#c84aff"}}>{fmt(hollieCalc.net)}</div>
                <div style={{fontSize:11,color:"#3a4460",marginTop:4}}>Surplus after bills: <span style={{color:hollieSurplus>=0?"#00c88c":"#ff4a6a",fontWeight:700}}>{fmt(hollieSurplus)}</span></div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                {[["Annual Gross",fmt(hollieCalc.annualGross)],["Annual Net",fmt(hollieCalc.annualNet)]].map(([l,v])=>(
                  <div key={l} style={{background:"#0d1117",borderRadius:8,padding:"10px",textAlign:"center"}}>
                    <div style={{fontSize:9,color:"#5a6480",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>{l}</div>
                    <div style={{fontSize:14,fontWeight:700,color:"#c8cee0"}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={card}>
              <SectionLabel>Overtime this month</SectionLabel>
              <label style={{fontSize:11,color:"#5a6480",display:"flex",justifyContent:"space-between",marginBottom:5}}>
                <span>Overtime hours <span style={{color:"#3a4460"}}>@ £{(HOLLIE_RATE*1.5).toFixed(2)}/h</span></span><span style={{color:"#c84aff",fontWeight:700}}>{hollieOtHrs}h</span>
              </label>
              <input type="number" inputMode="decimal" value={hollieOtHrs} onChange={e=>setHollieOt(parseFloat(e.target.value)||0)} style={numI}/>
              <div style={{fontSize:10,color:"#3a4460",marginTop:6}}>Paid at 1.5× your £{HOLLIE_RATE}/h rate. Resets at the start of each month.</div>
            </div>

            <div style={card}>
              <SectionLabel>This month</SectionLabel>
              {[
                [`Base pay (${hollieCalc.baseHours}h × £${HOLLIE_RATE})`, fmt(hollieCalc.stdPay), "#c8cee0", false],
                ["Overtime", fmt(hollieCalc.otPay), "#c84aff", false],
                ["Gross", fmt(hollieCalc.gross), "#e8eaf0", true],
                ["Tax", "−"+fmt(hollieCalc.tax), "#ff6b8a", false],
                ["NI", "−"+fmt(hollieCalc.ni), "#ff8c4a", false],
                ["Pension (NEST)", "−"+fmt(hollieCalc.nest), "#00c88c", false],
                ["Student loan (Plan 2)", "−"+fmt(hollieCalc.sl), "#ffb84a", false],
                ["Net pay", fmt(hollieCalc.net), "#c84aff", true],
              ].map(([l,v,c,bold],i)=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderTop:i?"1px solid #161b28":"none",fontSize:13}}>
                  <span style={{color:"#8892b0"}}>{l}</span><span style={{color:c,fontWeight:bold?800:600}}>{v}</span>
                </div>
              ))}
            </div>

            <div style={card}>
              <SectionLabel>Surplus</SectionLabel>
              {[
                ["Net pay", fmt(hollieCalc.net), "#c8cee0", false],
                ["Your share of shared bills", "−"+fmt(shHollie), "#ff6b8a", false],
                ["Your personal bills", "−"+fmt(glOnly), "#ff8c4a", false],
                ["Left over", fmt(hollieSurplus), hollieSurplus>=0?"#00c88c":"#ff4a6a", true],
              ].map(([l,v,c,bold],i)=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderTop:i?"1px solid #161b28":"none",fontSize:13}}>
                  <span style={{color:"#8892b0"}}>{l}</span><span style={{color:c,fontWeight:bold?800:600}}>{v}</span>
                </div>
              ))}
            </div>

            <p style={{fontSize:10,color:"#3a4460",textAlign:"center"}}>Estimate based on £{HOLLIE_RATE}/h, 40h/week (bank holidays counted), tax &amp; NI at standard rates, NEST pension and Plan 2 student loan.</p>
          </div>
        )}

        {tab==="Pay Calc"&&isOwner&&(
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
              <SectionLabel>Inputs</SectionLabel>
              <div style={{marginBottom:10}}>
                <label style={{fontSize:11,color:"#5a6480",display:"flex",justifyContent:"space-between",marginBottom:5}}>
                  <span>Standard Hours</span><span style={{color:"#3a4460"}}>{getCurrentMonthHours()}hrs this month</span>
                </label>
                <input type="number" value={ci.stdHrs} onChange={e=>setC("stdHrs",parseFloat(e.target.value)||0)} style={numI}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                <div>
                  <label style={{fontSize:11,color:"#5a6480",display:"flex",justifyContent:"space-between",marginBottom:5}}><span>Overtime Hrs <span style={{color:"#3a4460"}}>@£{PAY.otRate}</span></span><span style={{color:"#4affd4",fontWeight:700}}>{ci.otHrs}h</span></label>
                  <input type="range" min={0} max={80} step={0.25} value={ci.otHrs}
                    onChange={e=>setC("otHrs",parseFloat(e.target.value))}
                    style={{width:"100%",accentColor:"#4affd4",marginBottom:6,cursor:"pointer"}}/>
                  <input type="number" value={ci.otHrs} onChange={e=>setC("otHrs",parseFloat(e.target.value)||0)} style={numI}/>
                </div>
                <div>
                  <label style={{fontSize:11,color:"#5a6480",display:"flex",justifyContent:"space-between",marginBottom:5}}><span>Weekend OT <span style={{color:"#3a4460"}}>@£{PAY.weekendOtRate}</span></span><span style={{color:"#00c88c",fontWeight:700}}>{ci.weekendOtHrs}h</span></label>
                  <input type="range" min={0} max={40} step={0.25} value={ci.weekendOtHrs}
                    onChange={e=>setC("weekendOtHrs",parseFloat(e.target.value))}
                    style={{width:"100%",accentColor:"#00c88c",marginBottom:6,cursor:"pointer"}}/>
                  <input type="number" value={ci.weekendOtHrs} onChange={e=>setC("weekendOtHrs",parseFloat(e.target.value)||0)} style={numI}/>
                </div>
                <div>
                  <label style={{fontSize:11,color:"#5a6480",display:"flex",justifyContent:"space-between",marginBottom:5}}><span>Holiday Hrs <span style={{color:"#3a4460"}}>paid @ base rate</span></span><span style={{color:"#ffb84a",fontWeight:700}}>{ci.holidayHrs||0}h</span></label>
                  <input type="range" min={0} max={80} step={0.25} value={ci.holidayHrs||0}
                    onChange={e=>setC("holidayHrs",parseFloat(e.target.value))}
                    style={{width:"100%",accentColor:"#ffb84a",marginBottom:6,cursor:"pointer"}}/>
                  <input type="number" value={ci.holidayHrs||0} onChange={e=>setC("holidayHrs",parseFloat(e.target.value)||0)} style={numI}/>
                </div>
              </div>
              <div style={{marginBottom:10}}>
                <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>Performance Bonus</label>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
                  {PAY.bonusTiers.map(t=>(
                    <button key={t.bonus} onClick={()=>setC("bonus",t.bonus)} style={{
                      background:ci.bonus===t.bonus?"#4a9eff":"#1e2535",color:ci.bonus===t.bonus?"#fff":"#5a6480",
                      border:"1px solid "+(ci.bonus===t.bonus?"#4a9eff":"#2a3050"),borderRadius:6,padding:"5px 10px",fontSize:11,fontWeight:600,cursor:"pointer"
                    }}>{t.bonus===0?"None":fmt(t.bonus)}</button>
                  ))}
                </div>
                <input type="number" value={ci.bonus} onChange={e=>setC("bonus",parseFloat(e.target.value)||0)} style={numI}/>
              </div>
              <div style={{marginTop:4}}>
                <label style={{fontSize:13,color:"#5a6480",display:"block",marginBottom:8}}>Performance Tier</label>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:8}}>
                  {PAY.bonusTiers.map((tier,i)=>{
                    const isActive=effectiveTierIdx===i;
                    const isAuto=tierOverride===null&&isActive;
                    const colors=["#3a4460","#4a9eff","#7c6fff","#c84aff","#ffb84a","#00c88c"];
                    return(
                      <button key={i} onClick={()=>saveTierOverride(tierOverride===i&&i===effectiveTierIdx?null:i)} style={{
                        background:isActive?colors[i]+"22":"#1e2535",
                        border:"1px solid "+(isActive?colors[i]:"#2a3050"),
                        borderRadius:8,padding:"8px 4px",cursor:"pointer",textAlign:"center"
                      }}>
                        <div style={{fontSize:11,fontWeight:700,color:isActive?colors[i]:"#5a6480"}}>{tier.label}</div>
                        <div style={{fontSize:10,color:isActive?colors[i]:"#3a4460",marginTop:2}}>+£{tier.allowance.toFixed(2)}/hr</div>
                        {isAuto&&<div style={{fontSize:9,color:colors[i],marginTop:2,opacity:0.8}}>auto</div>}
                      </button>
                    );
                  })}
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:12,color:"#5a6480"}}>
                  <span>Effective rate: <span style={{color:"#e8eaf0",fontWeight:700}}>£{(PAY.baseRate+effectiveAllowance).toFixed(2)}/hr</span></span>
                  {tierOverride!==null&&(
                    <button onClick={()=>saveTierOverride(null)} style={{background:"none",border:"none",color:"#3a4460",fontSize:11,cursor:"pointer",textDecoration:"underline"}}>
                      Reset to auto
                    </button>
                  )}
                </div>
                {tierOverride!==null&&(
                  <div style={{fontSize:11,color:"#ffb84a",marginTop:6}}>⚠ Manual override active -- resets next month</div>
                )}
              </div>
            </div>
            <div style={card}>
              <SectionLabel>Gross Breakdown</SectionLabel>
              {[
                ["Standard Pay", ci.stdHrs+"hrs x £"+(PAY.baseRate+effectiveAllowance).toFixed(2), fmt(cr.stdPay), "#e8eaf0"],
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
              <SectionLabel>Deductions</SectionLabel>
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
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {latest&&prevMonth&&(
              <div style={card}>
                <SectionLabel>This Month vs Last</SectionLabel>
                {[
                  ["Gross",  latest.gross,  prevMonth.gross,  "#7c6fff"],
                  ["Net",    latest.net,    prevMonth.net,    "#4a9eff"],
                  ["Tax",    latest.tax,    prevMonth.tax,    "#ff6b8a"],
                  ["NI",     latest.ni,     prevMonth.ni,     "#ff8c4a"],
                  ["NEST",   latest.nest,   prevMonth.nest,   "#00c88c"],
                  ["Bonus",  latest.bonus,  prevMonth.bonus,  "#c84aff"],
                  ["OT Pay", latest.ot,     prevMonth.ot,     "#4affd4"],
                ].map(([l,cur,prev,c],i,arr)=>{
                  const diff=cur-prev;
                  return(
                    <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:i<arr.length-1?"1px solid #1a1f2e":"none"}}>
                      <span style={{fontSize:13,color:"#8892b0",width:60}}>{l}</span>
                      <span style={{fontSize:13,fontWeight:700,color:c}}>{fmt(cur)}</span>
                      <span style={{fontSize:12,fontWeight:600,color:diff===0?"#3a4460":diff>0?"#00c88c":"#ff6b8a",width:80,textAlign:"right"}}>{diff===0?"--":(diff>0?"+":"")+fmt(Math.abs(diff))}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={card}>
              <SectionLabel>Pay Rates</SectionLabel>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                {[
                  {label:"Base Rate",  value:"£"+PAY.baseRate+"/hr",      sub:"Standard hours",    accent:"#4a9eff"},
                  {label:"OTE Rate",   value:"£"+(PAY.baseRate+effectiveAllowance).toFixed(2)+"/hr", sub:"base + tier allowance", accent:"#00c88c"},
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
            </div>
            <div style={card}>
              <SectionLabel>Employment Details</SectionLabel>
              {[
                ["Employer",           "JLI Trading Limited"],
                ["Tax Code",           PAY.taxCode],
                ["NI Category",        PAY.niCategory],
                ["NEST Pension",       "5% employee contribution"],
                ["Student Loan",       "Plan 2 (30-year write-off)"],
                ["Tax-Free Allowance", fmt(PAY.taxFreeMonthly)+"/mo"],
                ["Standard Day",       (typeof getRateFor === "function" ? (() => { const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; const now = new Date(); const monthStr = months[now.getMonth()] + " " + now.getFullYear(); const rate = getRateFor(monthStr); const h = Math.floor(rate.stdDayHrs); const m = Math.round((rate.stdDayHrs - h) * 60); return h + "hrs" + (m > 0 ? " " + m + "min" : ""); })() : "8hrs 15min")],
                ["This Month's Hours", getCurrentMonthHours()+"hrs"],
              ].map(([l,v],i,arr)=>(
                <StatRow key={l} label={l} value={v} last={i===arr.length-1}/>
              ))}
            </div>
            <div style={card}>
              <SectionLabel>Performance Bonus Tiers</SectionLabel>
              <p style={{fontSize:12,color:"#3a4460",marginBottom:14,marginTop:0}}>Based on team average performance % each month</p>
              {PAY.bonusTiers.map((tier,i)=>{
                const colors=["#3a4460","#4a9eff","#7c6fff","#c84aff","#ffb84a","#00c88c"];
                return(
                  <div key={tier.label} style={{background:"#0d1117",borderRadius:8,padding:"10px 14px",borderLeft:"3px solid "+colors[i],marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:tier.bonus===0?"#3a4460":colors[i]}}>{tier.label} - {tier.range}</div>
                      <div style={{fontSize:11,color:"#5a6480",marginTop:3}}>{tier.bonus===0?"No bonus":"Bonus: "+fmt(tier.bonus)}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:13,fontWeight:700,color:tier.allowance>0?colors[i]:"#3a4460"}}>+£{tier.allowance.toFixed(2)}/hr</div>
                      <div style={{fontSize:10,color:"#3a4460",marginTop:2}}>allowance</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={card}>
              <SectionLabel>Recent Bonus History</SectionLabel>
              {allSorted.slice(-10).reverse().map((r,i,arr)=>(
                <StatRow key={r.month} label={r.month} color={r.bonus>=240?"#00c88c":r.bonus>=200?"#ffb84a":r.bonus>=160?"#7c6fff":r.bonus>0?"#4a9eff":"#3a4460"} value={r.bonus>0?fmt(r.bonus):"--"} last={i===arr.length-1}/>
              ))}
            </div>
          </div>
        )}

        {tab==="Payslips"&&(
          <div>
            <div style={{marginBottom:12,position:"relative"}}>
              <input placeholder="Search e.g. Jan 2025..." value={payslipSearch} onChange={e=>setPayslipSearch(e.target.value)}
                style={{...inp,paddingLeft:36,background:"#141824"}}/>
              <span style={{position:"absolute",top:"50%",left:12,transform:"translateY(-50%)",fontSize:14,pointerEvents:"none"}}>🔍</span>
            </div>
              <div style={{background:"#2a0f15",border:"1px solid #ff4a6a",borderRadius:10,padding:"16px 14px",marginBottom:14,display:deleteConfirm?"block":"none"}}>
                <div style={{fontSize:13,fontWeight:700,color:"#ff4a6a",marginBottom:8}}>Delete {deleteConfirm}?</div>
                <div style={{fontSize:11,color:"#8a4050",marginBottom:14}}>This will permanently remove this payslip from your history.</div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>deletePayslip(deleteConfirm)} style={{flex:1,background:"#ff4a6a",border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,padding:"10px",cursor:"pointer"}}>Delete</button>
                  <button onClick={()=>setDeleteConfirm(null)} style={{flex:1,background:"#1e2535",border:"none",borderRadius:8,color:"#8892b0",fontSize:13,padding:"10px",cursor:"pointer"}}>Cancel</button>
                </div>
              </div>
            <div style={{...card,padding:0,overflow:"hidden",marginBottom:10}}>
              <div style={{display:"grid",gridTemplateColumns:"68px 1fr 1fr 26px",padding:"9px 10px",background:"#0d1117",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:0.5,textTransform:"uppercase"}}>
                <span>Month</span>
                <span style={{textAlign:"right"}}>Gross / Net</span>
                <span style={{textAlign:"right"}}>Tax / NI</span>
                <span></span>
              </div>
              <div style={{maxHeight:"60vh",overflowY:"auto"}}>
                {filteredHistory.map((r,i)=>(
                  <div key={r.month}>
                    <div onClick={()=>setExpandedPayslip(expandedPayslip===r.month?null:r.month)}
                      style={{display:"grid",gridTemplateColumns:"68px 1fr 1fr 26px",padding:"10px",fontSize:11,background:i%2===0?"#141824":"#111520",borderBottom:"1px solid #1a1f2e",cursor:"pointer",alignItems:"center"}}>
                      <span style={{fontSize:12,fontWeight:600,color:"#8892b0"}}>{r.month}</span>
                      <span style={{textAlign:"right"}}>
                        <div style={{color:"#7c6fff",fontSize:11}}>{fmt(r.gross)}</div>
                        <div style={{color:"#4a9eff",fontWeight:700,fontSize:12}}>{fmt(r.net)}</div>
                      </span>
                      <span style={{textAlign:"right"}}>
                        <div style={{color:"#ff6b8a",fontSize:11}}>{fmt(r.tax)}</div>
                        <div style={{color:"#ff8c4a",fontSize:11}}>{fmt(r.ni)}</div>
                      </span>
                      <button onClick={e=>{e.stopPropagation();setDeleteConfirm(r.month);}}
                        style={{background:"none",border:"none",color:"#3a4460",fontSize:14,cursor:"pointer",padding:0,textAlign:"center"}}>🗑</button>
                    </div>
                    {expandedPayslip===r.month&&(
                      <div style={{background:"#0d1525",borderBottom:"1px solid #1e2535",padding:"12px 14px"}}>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:8}}>
                          {[
                            ["Gross",    fmt(r.gross),               "#7c6fff"],
                            ["Net",      fmt(r.net),                 "#4a9eff"],
                            ["Tax",      fmt(r.tax),                 "#ff6b8a"],
                            ["NI",       fmt(r.ni),                  "#ff8c4a"],
                            ["NEST",     r.nest>0?fmt(r.nest):"--",   "#00c88c"],
                            ["Bonus",    r.bonus>0?fmt(r.bonus):"--", "#c84aff"],
                            ["OT Pay",   r.ot>0?fmt(r.ot):"--",      "#4affd4"],
                            ["St. Loan", r.sl>0?fmt(r.sl):"--",      "#ffb84a"],
                            ["Date",     r.date||"--",                "#5a6480"],
                          ].map(([l,v,c])=>(
                            <div key={l} style={{background:"#111827",borderRadius:8,padding:"8px",textAlign:"center"}}>
                              <div style={{fontSize:9,color:"#5a6480",marginBottom:3,textTransform:"uppercase",letterSpacing:0.5}}>{l}</div>
                              <div style={{fontSize:12,fontWeight:700,color:c}}>{v}</div>
                            </div>
                          ))}
                        </div>
                        <textarea placeholder="Add a note for this month..." value={notes[r.month]||""}
                          onChange={e=>{const n={...notes,[r.month]:e.target.value};updNotes(n);}}
                          style={{width:"100%",boxSizing:"border-box",background:"#111827",border:"1px solid #2a3050",borderRadius:8,color:"#8892b0",fontSize:12,padding:"10px",resize:"vertical",minHeight:60,fontFamily:"inherit",lineHeight:1.5}}/>
                      </div>
                    )}
                  </div>
                ))}
                {filteredHistory.length===0&&(
                  history.length === 0 ? (
                    <div style={{padding:"40px 20px",textAlign:"center"}}>
                      <div style={{fontSize:36,marginBottom:8}}>💼</div>
                      <div style={{fontSize:14,color:"#8892b0",fontWeight:600,marginBottom:6}}>No payslips yet</div>
                      <div style={{fontSize:12,color:"#3a4460",marginBottom:14}}>Upload your first payslip PDF to start tracking</div>
                      <button onClick={()=>{haptic();setShowPayslipUpload(true);setTab("Diag");}} style={{background:"#4a9eff",border:"none",borderRadius:8,color:"#000",fontSize:12,fontWeight:700,padding:"10px 18px",cursor:"pointer"}}>Go to Upload</button>
                    </div>
                  ) : (
                    <div style={{padding:"32px",textAlign:"center",color:"#3a4460",fontSize:13}}>No payslips match "{payslipSearch}"</div>
                  )
                )}
                <div style={{display:"grid",gridTemplateColumns:"68px 1fr 1fr 26px",padding:"10px",fontSize:11,fontWeight:700,background:"#0d1117",borderTop:"2px solid #2a3050"}}>
                  <span style={{color:"#5a6480",fontSize:10,textTransform:"uppercase",letterSpacing:0.5}}>Totals</span>
                  <span style={{textAlign:"right"}}>
                    <div style={{color:"#7c6fff"}}>{fmt(ts.gross)}</div>
                    <div style={{color:"#4a9eff"}}>{fmt(ts.net)}</div>
                  </span>
                  <span style={{textAlign:"right"}}>
                    <div style={{color:"#ff6b8a"}}>{fmt(ts.tax)}</div>
                    <div style={{color:"#ff8c4a"}}>{fmt(ts.ni)}</div>
                  </span>
                  <span></span>
                </div>
              </div>
            </div>
            <p style={{fontSize:10,color:"#3a4460",textAlign:"center",marginTop:4,marginBottom:12}}>Tap a row to expand full detail - add notes or delete</p>

            {latest&&(()=>{
              const active = inferPerfAllowance(latest);
              const allowanceRate = getAllowanceForBonus(latest.bonus||0);
              const [mo,yr] = latest.month.split(" ");
              const moIdx = MONTHS.indexOf(mo);
              const nextMo = MONTHS[(moIdx+1)%12];
              const nextYr = moIdx===11 ? parseInt(yr)+1 : parseInt(yr);
              const tier = PAY.bonusTiers.slice().reverse().find(t=>(latest.bonus||0)>=t.bonus&&t.bonus>0)||PAY.bonusTiers[0];
              return(
                <div style={{marginTop:12,background:active?"#0a1a10":"#1a0f0a",border:"1px solid "+(active?"#00c88c":"#ff8c4a"),borderRadius:12,padding:"14px 16px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <span style={{fontSize:18}}>{active?"✅":"❌"}</span>
                    <span style={{fontSize:13,fontWeight:700,color:active?"#00c88c":"#ff8c4a"}}>
                      Performance Allowance -- {nextMo} {nextYr}
                    </span>
                  </div>
                  <div style={{fontSize:12,color:"#8892b0",lineHeight:1.7}}>
                    Your <span style={{color:"#e8eaf0",fontWeight:600}}>{latest.month}</span> payslip shows a <span style={{color:"#c84aff",fontWeight:700}}>{fmt(latest.bonus||0)}</span> bonus
                    {" "}(<span style={{color:"#e8eaf0"}}>{tier.label} - {tier.range}</span>).
                    {active
                      ? <> The <span style={{color:"#00c88c",fontWeight:700}}>+£{allowanceRate.toFixed(2)}/hr</span> allowance will apply to every hour worked in <span style={{color:"#e8eaf0",fontWeight:600}}>{nextMo} {nextYr}</span>. Pay Calc updated.</>
                      : <> No performance allowance applies for <span style={{color:"#e8eaf0",fontWeight:600}}>{nextMo} {nextYr}</span> -- a bonus is needed to unlock the hourly allowance.</>
                    }
                  </div>
                  <button onClick={()=>setC("perfAllowance",!ci.perfAllowance)}
                    style={{marginTop:10,background:"#1e2535",border:"1px solid #2a3050",borderRadius:8,color:"#5a6480",fontSize:12,padding:"7px 14px",cursor:"pointer"}}>
                    Override in Pay Calc: mark as {ci.perfAllowance?"inactive":"active"}
                  </button>
                </div>
              );
            })()}
          </div>
        )}

        {tab==="Tax Year"&&(
          <div>
            <div style={{...card,marginBottom:14,background:"linear-gradient(135deg,#0f1a10,#0d1117)",border:"1px solid #00c88c"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#00c88c",letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>Tax Year Summaries</div>
              <p style={{fontSize:11,color:"#3a4460",margin:0}}>Apr - Mar breakdown from your payslip history</p>
            </div>

            {groupByFY(history).map((fy,i)=>{
              const isCurrent=i===0;
              return(
                <div key={fy.label} style={{...card,marginBottom:12,border:"1px solid "+(isCurrent?"#00c88c":"#1e2535")}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:700,color:isCurrent?"#00c88c":"#8892b0"}}>{fy.label}</div>
                      <div style={{fontSize:10,color:"#3a4460",marginTop:2}}>{fy.months} month{fy.months!==1?"s":""} recorded{isCurrent?" - current year":""}</div>
                    </div>
                    {isCurrent&&<span style={{background:"#0a2a15",border:"1px solid #00c88c",borderRadius:12,fontSize:9,fontWeight:700,color:"#00c88c",padding:"3px 8px",letterSpacing:1}}>CURRENT</span>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:10}}>
                    {[
                      {label:"Total Gross",value:fmt(fy.gross),accent:"#7c6fff"},
                      {label:"Total Net",  value:fmt(fy.net),  accent:"#4a9eff"},
                      {label:"Avg Net/Mo", value:fmt(fy.net/fy.months),accent:"#00c88c"},
                      {label:"Total Bonus",value:fmt(fy.bonus),accent:"#c84aff"},
                    ].map(k=>(
                      <div key={k.label} style={{background:"#0d1117",borderRadius:8,padding:"9px",textAlign:"center"}}>
                        <div style={{fontSize:9,color:"#5a6480",textTransform:"uppercase",letterSpacing:1,marginBottom:3}}>{k.label}</div>
                        <div style={{fontSize:14,fontWeight:700,color:k.accent}}>{k.value}</div>
                      </div>
                    ))}
                  </div>
                  <SectionLabel>Deductions</SectionLabel>
                  {[
                    ["Income Tax",         fmt(fy.tax),  "#ff6b8a"],
                    ["National Insurance", fmt(fy.ni),   "#ff8c4a"],
                    ["NEST Pension",       fmt(fy.nest), "#ffb84a"],
                    ["Student Loan",       fmt(fy.sl),   "#c84aff"],
                    ["Overtime Pay",       fmt(fy.ot),   "#4affd4"],
                  ].map(([l,v,c],i,arr)=>(
                    <StatRow key={l} label={l} value={v} color={c} last={i===arr.length-1}/>
                  ))}
                  <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0 0",fontSize:12,fontWeight:700}}>
                    <span style={{color:"#8892b0"}}>Total Deductions</span>
                    <span style={{color:"#ff4a6a"}}>{fmt(fy.tax+fy.ni+fy.nest+fy.sl)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab==="Leave"&&(()=>{
          const year = getLeaveYear();
          const entitlement = effectiveEntitlement(leaveSettings.baseEntitlement, leaveSettings.serviceDays);
          const taken = hoursTakenInYear(leaveLogs, year);
          const remaining = Math.round((entitlement - taken) * 100) / 100;
          const pct = Math.min(100, Math.round((taken / entitlement) * 100));
          const yearLogs = logsForYear(leaveLogs, year);
          const inp2 = {background:"#141824",border:"1px solid #1e2535",borderRadius:8,color:"#e8eaf0",fontSize:13,padding:"10px 12px",width:"100%",boxSizing:"border-box",fontFamily:"inherit"};

          return (
            <div style={{padding:"14px 14px 0"}}>

              {/* Settings toggle */}
              {leaveEditSettings && leaveDraftSettings ? (
                <div style={{...card,marginBottom:14,border:"1px solid #4a9eff44"}}>
                  <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Leave Settings</div>
                  {[
                    ["Base Entitlement (days)", "baseEntitlement", "number"],
                    ["Service Days (0-6)", "serviceDays", "number"],
                    ["Start Year at JLI", "startYear", "number"],
                  ].map(([label, key, type]) => (
                    <div key={key} style={{marginBottom:10}}>
                      <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>{label}</label>
                      <input type={type} value={leaveDraftSettings[key]}
                        onChange={e=>setLeaveDraftSettings(s=>({...s,[key]:parseInt(e.target.value)||0}))}
                        style={inp2}/>
                    </div>
                  ))}
                  <div style={{fontSize:11,color:"#3a4460",marginBottom:12,lineHeight:1.6}}>
                    Service days are added on June 1st each year. Current effective entitlement after June 1st: <span style={{color:"#4a9eff",fontWeight:700}}>{Math.round((leaveDraftSettings.baseEntitlement + Math.min(leaveDraftSettings.serviceDays,6)) * STD_DAY_HRS * 100)/100}h ({leaveDraftSettings.baseEntitlement + Math.min(leaveDraftSettings.serviceDays,6)} days x {STD_DAY_HRS}h)</span>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{haptic();setLeaveEditSettings(false);}} style={{flex:1,background:"#1e2535",border:"none",borderRadius:8,color:"#5a6480",fontSize:13,fontWeight:600,padding:"11px",cursor:"pointer"}}>Cancel</button>
                    <button onClick={saveLeaveSettings} style={{flex:2,background:"#4a9eff",border:"none",borderRadius:8,color:"#000",fontSize:13,fontWeight:700,padding:"11px",cursor:"pointer"}}>Save Settings</button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Summary cards */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
                    {[
                      {label:"Entitlement", value:entitlement+"h", sub:"~ "+Math.round(entitlement/STD_DAY_HRS*10)/10+"d", accent:"#4a9eff"},
                      {label:"Taken",        value:taken+"h",       sub:"~ "+Math.round(taken/STD_DAY_HRS*10)/10+"d", accent:"#ff8c4a"},
                      {label:"Remaining",    value:remaining+"h",   sub:"~ "+Math.round(remaining/STD_DAY_HRS*10)/10+"d", accent:remaining>STD_DAY_HRS?"#00c88c":remaining>0?"#ffb84a":"#ff4a6a"},
                    ].map(k=>(
                      <div key={k.label} style={{...card,textAlign:"center",padding:"12px 6px"}}>
                        <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:5}}>{k.label}</div>
                        <div style={{fontSize:16,fontWeight:800,color:k.accent}}>{k.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Progress bar */}
                  <div style={{...card,marginBottom:14}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#5a6480",marginBottom:8}}>
                      <span>{year} Leave Year</span>
                      <span style={{color:"#4a9eff",fontWeight:700}}>{pct}% used</span>
                    </div>
                    <div style={{background:"#1e2535",borderRadius:99,height:10,overflow:"hidden",marginBottom:8}}>
                      <div style={{width:pct+"%",height:"100%",background:"linear-gradient(90deg,#ff8c4a88,#ff8c4a)",borderRadius:99,transition:"width 0.4s"}}/>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#3a4460"}}>
                      <span>{taken}h taken</span>
                      <span>{remaining}h remaining of {entitlement}h</span>
                    </div>
                    <button onClick={()=>{haptic();setLeaveDraftSettings({...leaveSettings});setLeaveEditSettings(true);}}
                      style={{marginTop:12,background:"none",border:"1px solid #1e2535",borderRadius:8,color:"#3a4460",fontSize:11,padding:"7px 14px",cursor:"pointer",width:"100%"}}>
                      ⚙️ Edit entitlement settings
                    </button>
                  </div>
                </>
              )}

              {/* Estimate leave from historical payslips */}
              {history.length > 0 && (
                <button onClick={async ()=>{
                  haptic("medium");
                  if(!window.confirm("This will estimate leave taken from your payslip history and add entries. Existing manual entries won'\''t be overwritten. Continue?")) return;

                  setImportMsg("Calculating from payslips...");
                  const newEntries = [];
                  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

                  history.forEach(p => {
                    const rate = getRateFor(p.month);
                    if (!rate) return;
                    let leaveHrs = 0;
                    if (p.holidayPay && p.holidayPay > 0) {
                      // New payslip format: direct holiday pay -> hours
                      leaveHrs = p.holidayPay / rate.baseRate;
                    } else {
                      // Legacy fallback: estimate from gross minus everything else
                      const ot = (p.ot || 0);
                      const wknd = (p.weekendOt || 0);
                      const hrlyAllowance = (p.hourlyAllowance || 0);
                      const bonus = (p.bonus || 0);
                      const baseLeavePay = p.gross - ot - wknd - hrlyAllowance - bonus;
                      const totalPaidHrs = baseLeavePay / rate.baseRate;
                      leaveHrs = Math.max(0, totalPaidHrs - rate.stdMonthlyHrs);
                    }

                    if (leaveHrs >= 0.5) {
                      // Round to nearest 0.25 (quarter hour)
                      const roundedHrs = Math.round(leaveHrs * 4) / 4;
                      // Use middle of the month as a placeholder date
                      const [mo, yr] = p.month.split(" ");
                      const monthIdx = months.indexOf(mo);
                      const dateStr = new Date(parseInt(yr), monthIdx, 15).toISOString().slice(0, 10);
                      newEntries.push({
                        id: genUUID(),
                        date: dateStr,
                        hours: roundedHrs,
                        label: "Estimated from " + p.month + " payslip"
                      });
                    }
                  });

                  // Filter out months that already have leave logged (any entry in same month)
                  const existingMonths = new Set(leaveLogs.map(l => l.date.slice(0,7)));
                  const toAdd = newEntries.filter(e => !existingMonths.has(e.date.slice(0,7)));

                  if (toAdd.length === 0) {
                    setImportMsg("✓ No new leave to estimate");
                    setTimeout(()=>setImportMsg(""),3000);
                    return;
                  }

                  setLeaveLogs(prev => [...prev, ...toAdd].sort((a,b) => new Date(b.date) - new Date(a.date)));
                  if (user) {
                    for (const e of toAdd) {
                      try { await db.upsertLeaveLog(user.id, e); } catch(err) { console.error(err); }
                    }
                  }
                  setImportMsg(`✓ Estimated ${toAdd.length} month${toAdd.length!==1?"s":""} of leave`);
                  setTimeout(()=>setImportMsg(""),5000);
                }} style={{width:"100%",marginBottom:8,background:"#1a1a0a",border:"1px solid #ffb84a",borderRadius:8,color:"#ffb84a",fontSize:12,fontWeight:700,padding:"10px",cursor:"pointer"}}>
                  📊 Estimate Leave from Payslip History
                </button>
              )}

              {/* Log leave form */}
              <div style={{...card,marginBottom:14}}>
                <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Log Leave</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 80px",gap:8,marginBottom:8}}>
                  <div>
                    <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>Date</label>
                    <input type="date" value={leaveForm.date} onChange={e=>setLeaveForm(f=>({...f,date:e.target.value}))} style={inp2}/>
                  </div>
                  <div>
                    <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>Hours</label>
                    <input type="number" min="0.25" max="240" step="0.25" value={leaveForm.hours}
                      onChange={e=>setLeaveForm(f=>({...f,hours:e.target.value}))} style={inp2}/>
                  </div>
                </div>
                <div style={{marginBottom:10}}>
                  <label style={{fontSize:11,color:"#5a6480",display:"block",marginBottom:5}}>Label (optional)</label>
                  <input type="text" placeholder="e.g. Christmas week, bank holiday..." value={leaveForm.label}
                    onChange={e=>setLeaveForm(f=>({...f,label:e.target.value}))}
                    onKeyDown={e=>e.key==="Enter"&&saveLeaveLog()}
                    style={inp2}/>
                </div>
                <button onClick={saveLeaveLog} disabled={!leaveForm.date||!leaveForm.hours}
                  style={{width:"100%",background:leaveForm.date&&leaveForm.hours?"#00c88c":"#1e2535",border:"none",borderRadius:8,color:leaveForm.date&&leaveForm.hours?"#000":"#3a4460",fontSize:13,fontWeight:700,padding:"12px",cursor:leaveForm.date&&leaveForm.hours?"pointer":"default",transition:"background 0.2s"}}>
                  + Log Leave
                </button>
              </div>

              {/* Leave log for this year */}
              {yearLogs.length > 0 && (
                <div style={{...card,padding:0,overflow:"hidden",marginBottom:14}}>
                  <div style={{padding:"10px 12px",background:"#0d1117",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:0.5,textTransform:"uppercase",display:"grid",gridTemplateColumns:"80px 48px 1fr 28px"}}>
                    <span>Date</span><span style={{textAlign:"center"}}>Days</span><span>Label</span><span></span>
                  </div>
                  {yearLogs.map((l,i)=>(
                    <div key={l.id} style={{display:"grid",gridTemplateColumns:"80px 48px 1fr 28px",padding:"10px 12px",fontSize:12,background:i%2===0?"#141824":"#111520",borderBottom:"1px solid #1a1f2e",alignItems:"center"}}>
                      <span style={{color:"#8892b0"}}>{new Date(l.date).toLocaleDateString("en-GB",{day:"2-digit",month:"short"})}</span>
                      <span style={{textAlign:"center",color:"#ff8c4a",fontWeight:700}}>{l.hours}h</span>
                      <span style={{color:"#5a6480",fontSize:11}}>{l.label||"--"}</span>
                      <button onClick={()=>deleteLeaveLog(l.id)} style={{background:"none",border:"none",color:"#3a4460",fontSize:14,cursor:"pointer",padding:0,textAlign:"center"}}>🗑</button>
                    </div>
                  ))}
                  <div style={{display:"grid",gridTemplateColumns:"80px 48px 1fr 28px",padding:"10px 12px",fontSize:12,fontWeight:700,background:"#0d1117",borderTop:"2px solid #2a3050"}}>
                    <span style={{color:"#5a6480",fontSize:10,textTransform:"uppercase",letterSpacing:0.5}}>Total</span>
                    <span style={{textAlign:"center",color:"#ff8c4a"}}>{taken}h</span>
                    <span></span><span></span>
                  </div>
                </div>
              )}

              {yearLogs.length === 0 && (
                <div style={{textAlign:"center",padding:"32px 20px"}}>
                  <div style={{fontSize:36,marginBottom:8}}>🏖️</div>
                  <div style={{fontSize:14,color:"#8892b0",fontWeight:600,marginBottom:6}}>No leave logged for {year} yet</div>
                  <div style={{fontSize:12,color:"#3a4460"}}>Log leave above or it'\''ll auto-import from your monthly timesheets</div>
                </div>
              )}

            </div>
          );
        })()}


        {tab==="Timesheet"&&(
          <div>
            {/* Summary cards */}
            {(()=>{
              const holDays=(accumulated.days||[]).filter(d=>d.isHoliday);
              const holCount=Math.round(holDays.reduce((s,d)=>s+(d.isHalf?STD_DAY_HRS/2:STD_DAY_HRS),0)*100)/100;
              return(
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
                  {[
                    {label:"Weekday OT",value:(accumulated.otHrs||0)+"h",accent:"#4affd4"},
                    {label:"Weekend OT",value:(accumulated.weekendOtHrs||0)+"h",accent:"#ffb84a"},
                    {label:"Holiday",value:holCount+"h",accent:"#00c88c"},
                  ].map(k=>(
                    <div key={k.label} style={{...card,textAlign:"center",padding:"12px 6px"}}>
                      <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>{k.label}</div>
                      <div style={{fontSize:20,fontWeight:700,color:k.accent}}>{k.value}</div>
                      <div style={{fontSize:10,color:"#3a4460",marginTop:2}}>this period</div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Monthly vs Weekly cross-check result */}
            {weeklyCheck && (
              <div style={{...card,marginBottom:14,borderLeft:"3px solid "+(weeklyCheck.status==="match"?"#00c88c":weeklyCheck.status==="no_weekly"?"#5a6480":"#ff6b8a")}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:weeklyCheck.status==="mismatch"?10:0}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:weeklyCheck.status==="match"?"#00c88c":weeklyCheck.status==="no_weekly"?"#8892b0":"#ff6b8a"}}>
                      {weeklyCheck.status==="match" ? "✓ Monthly matches weekly" : weeklyCheck.status==="no_weekly" ? "No weekly data to compare" : "⚠ Monthly vs Weekly mismatch"}
                    </div>
                    <div style={{fontSize:11,color:"#5a6480",marginTop:2}}>{weeklyCheck.month}{weeklyCheck.status==="match"?" · totals reconcile":""}</div>
                  </div>
                  <button onClick={()=>setWeeklyCheck(null)} style={{background:"none",border:"none",color:"#3a4460",fontSize:16,cursor:"pointer"}}>✕</button>
                </div>
                {weeklyCheck.status==="mismatch" && (
                  <>
                    <div style={{fontSize:11,color:"#8892b0",marginBottom:8}}>
                      Monthly total: {weeklyCheck.monthlyTotal}h · Weekly total: {weeklyCheck.weeklyTotal}h
                      {Math.abs(weeklyCheck.monthlyTotal-weeklyCheck.weeklyTotal)>0.02 && <span style={{color:"#ff6b8a"}}> (off by {Math.round(Math.abs(weeklyCheck.monthlyTotal-weeklyCheck.weeklyTotal)*100)/100}h)</span>}
                    </div>
                    <div style={{background:"#0d1117",borderRadius:8,overflow:"hidden"}}>
                      <div style={{display:"grid",gridTemplateColumns:"60px 40px 1fr 1fr",padding:"8px 10px",background:"#1a0a0a",fontSize:9,fontWeight:700,color:"#8a5a5a",letterSpacing:1,textTransform:"uppercase"}}>
                        <span>Date</span><span>Day</span><span style={{textAlign:"right"}}>Monthly</span><span style={{textAlign:"right"}}>Weekly</span>
                      </div>
                      {weeklyCheck.mismatches.map((m,i)=>(
                        <div key={i} style={{display:"grid",gridTemplateColumns:"60px 40px 1fr 1fr",padding:"8px 10px",fontSize:11,borderBottom:"1px solid #1a1f2e",alignItems:"center"}}>
                          <span style={{color:"#8892b0",fontWeight:600}}>{m.date}</span>
                          <span style={{color:"#5a6480"}}>{m.day}</span>
                          <span style={{textAlign:"right",color:m.type==="missing_monthly"?"#ff6b8a":"#e8eaf0",fontWeight:600}}>{m.monthly}</span>
                          <span style={{textAlign:"right",color:m.type==="missing_weekly"?"#ff6b8a":"#e8eaf0",fontWeight:600}}>{m.weekly}</span>
                        </div>
                      ))}
                    </div>
                    <p style={{fontSize:10,color:"#5a6480",marginTop:8,lineHeight:1.5}}>These days differ between JLI's monthly summary and the weekly emails. Worth querying with JLI if the monthly total is wrong.</p>
                  </>
                )}
              </div>
            )}

            {/* Daily breakdown */}
            {accumulated.days&&accumulated.days.length>0?(
              <div style={{...card,padding:0,overflow:"hidden",marginBottom:14}}>
                <div style={{display:"grid",gridTemplateColumns:"60px 44px 1fr 60px 60px",padding:"10px",background:"#0d1117",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:1,textTransform:"uppercase"}}>
                  <span>Date</span><span>Day</span><span style={{textAlign:"right"}}>Hours</span><span style={{textAlign:"right"}}>Wkdy OT</span><span style={{textAlign:"right"}}>Wknd OT</span>
                </div>
                <div style={{maxHeight:"60vh",overflowY:"auto"}}>
                  {accumulated.days
                    .map((d,i)=>{
                    const isWeekend=d.day.toLowerCase().startsWith("sat")||d.day.toLowerCase().startsWith("sun");
                    const isHol=d.isHoliday||false;
                    if(isHol) return(
                      <div key={i} style={{display:"grid",gridTemplateColumns:"60px 44px 1fr 60px 60px",padding:"10px",fontSize:12,background:"#0d1a10",borderBottom:"1px solid #1a2e1a",alignItems:"center",borderLeft:"3px solid #00c88c"}}>
                        <span style={{color:"#8892b0",fontWeight:600}}>{d.date}</span>
                        <span style={{color:"#00c88c",fontWeight:700}}>{d.day}</span>
                        <span style={{textAlign:"right",color:"#00c88c",fontWeight:700,fontSize:11}}>{d.holiday}</span>
                        <span style={{textAlign:"right",color:"#3a6040",fontSize:10}}>leave</span>
                        <span style={{textAlign:"right",color:"#3a6040"}}>--</span>
                      </div>
                    );
                    return(
                      <div key={i} style={{display:"grid",gridTemplateColumns:"60px 44px 1fr 60px 60px",padding:"10px 10px",fontSize:12,background:i%2===0?"#141824":"#111520",borderBottom:"1px solid #1a1f2e",alignItems:"center"}}>
                        <span style={{color:"#8892b0",fontWeight:600}}>{d.date}</span>
                        <span style={{color:isWeekend?"#ffb84a":"#5a6480",fontWeight:isWeekend?700:400}}>{d.day}</span>
                        <span style={{textAlign:"right",color:"#e8eaf0",fontWeight:600}}>{d.hours}</span>
                        <span style={{textAlign:"right",color:"#4affd4",fontWeight:600}}>{d.otHrs>0?"+"+d.otHrs+"h":"--"}</span>
                        <span style={{textAlign:"right",color:"#ffb84a",fontWeight:600}}>{d.wkOtHrs>0?d.wkOtHrs+"h":"--"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ):(
              <div style={{...card,textAlign:"center",padding:"32px 16px",marginBottom:14}}>
                <div style={{fontSize:32,marginBottom:10}}>📋</div>
                <div style={{fontSize:13,color:"#5a6480"}}>No timesheets uploaded yet this month</div>
                <div style={{fontSize:11,color:"#3a4460",marginTop:6}}>Go to Upload tab to add your weekly timesheet</div>
              </div>
            )}

            {/* Monthly timesheet history */}
            {monthlyTs.length > 0 && (()=>{
              return (
                <div style={{...card,padding:0,overflow:"hidden",marginBottom:14}}>
                  <div style={{padding:"10px 12px",background:"#0d1117",fontSize:9,fontWeight:700,color:"#3a4460",letterSpacing:0.5,textTransform:"uppercase",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span>Monthly Timesheet History</span>
                    <span style={{color:"#7c6fff"}}>{monthlyTs.length} months</span>
                  </div>
                  {monthlyTs.map((m, i) => {
                    const disc = discrepancies.find(d => d.month === m.month);
                    const isOk = disc && disc.status === "ok";
                    const hasIssue = disc && disc.status === "discrepancy";
                    const dismissed = hasIssue && dismissedDiscs.includes(m.month);
                    const expanded = expandedMonth === m.month;
                    return (
                      <div key={m.emailId||i}>
                        <div onClick={()=>{haptic();setExpandedMonth(expanded?null:m.month);}}
                          style={{display:"grid",gridTemplateColumns:"80px 1fr 60px 28px",padding:"10px 12px",fontSize:12,background:i%2===0?"#141824":"#111520",borderBottom:"1px solid #1a1f2e",alignItems:"center",cursor:"pointer"}}>
                          <span style={{color:"#8892b0",fontWeight:600,fontSize:11}}>{m.month||m.period.slice(0,5)}</span>
                          <span style={{color:"#5a6480",fontSize:10}}>{m.totalHrs} - {m.otHrs}h OT - {m.wkndHrs}h wknd</span>
                          <span style={{textAlign:"right",fontSize:11,fontWeight:700,color:dismissed?"#5a6480":hasIssue?"#ff6b8a":isOk?"#00c88c":"#3a4460"}}>
                            {hasIssue?(dismissed?"hidden":"⚠️ "+disc.items.length+" issue"+(disc.items.length>1?"s":"")):isOk?"✅ OK":"--"}
                          </span>
                          <span style={{textAlign:"right",color:"#3a4460",fontSize:12}}>{expanded?"A":"V"}</span>
                        </div>
                        {expanded && (
                          <div style={{background:"#0d1117",borderBottom:"1px solid #1e2535",padding:"12px 14px"}}>
                            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:10}}>
                              {[
                                ["Std Hrs",  m.stdHrs+"h",  "#e8eaf0"],
                                ["OT Hrs",   m.otHrs+"h",   "#4affd4"],
                                ["Wknd Hrs", m.wkndHrs+"h", "#ffb84a"],
                                ["Hol Hrs",  m.holHrs+"h",  "#00c88c"],
                                ["Total",    m.totalHrs,    "#7c6fff"],
                                ["Period",   m.period ? m.period.replace("2026-","").replace(/-/g,"/") : "--", "#5a6480"],
                              ].map(([l,v,c])=>(
                                <div key={l} style={{background:"#111827",borderRadius:6,padding:"7px",textAlign:"center"}}>
                                  <div style={{fontSize:9,color:"#3a4460",textTransform:"uppercase",letterSpacing:0.5,marginBottom:3}}>{l}</div>
                                  <div style={{fontSize:12,fontWeight:700,color:c}}>{v}</div>
                                </div>
                              ))}
                            </div>
                            {disc && disc.status === "discrepancy" && (
                              <div style={{background:"#1a0a0a",borderRadius:8,padding:"10px 12px",border:"1px solid #3a1a1a"}}>
                                <div style={{fontSize:11,fontWeight:700,color:"#ff6b8a",marginBottom:8}}>⚠️ Pay discrepancies found</div>
                                {disc.items.map((item,j)=>(
                                  <div key={j} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid #2a1a1a",fontSize:11}}>
                                    <span style={{color:"#8892b0"}}>{item.label}</span>
                                    <span>
                                      <span style={{color:"#5a6480"}}>exp </span>
                                      <span style={{color:"#e8eaf0",fontWeight:600}}>{fmt(item.expected)}</span>
                                      <span style={{color:"#3a4460"}}> - got </span>
                                      <span style={{color:item.diff>0?"#ff6b8a":"#4affd4",fontWeight:700}}>{fmt(item.actual)}</span>
                                      <span style={{color:item.diff>0?"#ff4a6a":"#00c88c",fontSize:10,marginLeft:4}}>{item.diff>0?"v":"^"}{fmt(Math.abs(item.diff))}</span>
                                    </span>
                                  </div>
                                ))}
                                <div style={{fontSize:10,color:"#5a3030",marginTop:8,lineHeight:1.6}}>
                                  These are estimates based on your stored rates. Rounding differences under £1 are ignored. If a gap is large, raise it with payroll.
                                </div>
                                {dismissed ? (
                                  <button onClick={()=>{haptic();restoreDisc(m.month);}} style={{marginTop:10,width:"100%",background:"#141824",border:"1px solid #2a3050",borderRadius:6,color:"#8892b0",fontSize:11,fontWeight:600,padding:"9px",cursor:"pointer"}}>↩ Restore alert</button>
                                ) : (
                                  <button onClick={()=>{haptic();dismissDisc(m.month);}} style={{marginTop:10,width:"100%",background:"#141824",border:"1px solid #3a1a1a",borderRadius:6,color:"#ff6b8a",fontSize:11,fontWeight:600,padding:"9px",cursor:"pointer"}}>Dismiss alert</button>
                                )}
                              </div>
                            )}
                            {disc && disc.status === "ok" && (
                              <div style={{background:"#0a1a10",borderRadius:8,padding:"10px 12px",border:"1px solid #1a3a1a",fontSize:11,color:"#00c88c"}}>
                                ✅ Pay matches timesheet within tolerance -- no issues found
                              </div>
                            )}
                            {!disc && (
                              <div style={{fontSize:11,color:"#3a4460",textAlign:"center",padding:"6px 0"}}>
                                Payslip for {m.month||"this period"} not yet uploaded -- discrepancy check will run automatically once it arrives
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {(()=>{
              // OT trend chart - last 12 months
              if (history.length < 3) return null;
              const sorted = sortH(history);
              const recent = sorted.slice(-12);
              const otData = recent.map(r => ({
                month: r.month.split(" ")[0],
                ot: r.ot || 0,
                bonus: r.bonus || 0,
              }));
              const maxOt = Math.max(...otData.map(d => d.ot), 1);
              const avgOt = otData.reduce((s,d) => s + d.ot, 0) / otData.length;

              return (
                <div style={{...card,marginBottom:14}}>
                  <SectionLabel>OT Pay Trend -- Last {otData.length} Months</SectionLabel>
                  <div style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",gap:3,height:80,marginTop:8,marginBottom:8}}>
                    {otData.map((d,i)=>{
                      const h = Math.max(3, (d.ot / maxOt) * 70);
                      const isAbove = d.ot > avgOt;
                      return (
                        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                          <div style={{
                            width:"100%", height:h+"px",
                            background:isAbove?"linear-gradient(180deg,#4affd4,#00c88c)":"#3a4460",
                            borderRadius:"3px 3px 0 0",
                            transition:"height 0.4s"
                          }} title={d.month+": "+fmt(d.ot)}/>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#3a4460",marginTop:4}}>
                    {otData.map((d,i)=><span key={i} style={{flex:1,textAlign:"center"}}>{d.month}</span>)}
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#5a6480",marginTop:10,paddingTop:8,borderTop:"1px solid #1a1f2e"}}>
                    <span>Avg: <span style={{color:"#4affd4",fontWeight:700}}>{fmt(avgOt)}</span></span>
                    <span>Peak: <span style={{color:"#00c88c",fontWeight:700}}>{fmt(maxOt)}</span></span>
                    <span>Total: <span style={{color:"#e8eaf0",fontWeight:700}}>{fmt(otData.reduce((s,d)=>s+d.ot,0))}</span></span>
                  </div>
                </div>
              );
            })()}

            {(()=>{
              // FY OT tracker from payslip history
              const now=new Date();
              const fyStart=now.getMonth()>=3?new Date(now.getFullYear(),3,1):new Date(now.getFullYear()-1,3,1);
              const fyYear=fyStart.getFullYear();
              const fyLabel="Apr "+fyYear+" - Mar "+(fyYear+1);
              const fyRows=history.filter(r=>{const[mo,yr]=r.month.split(" ");return new Date(parseInt(yr),MONTHS.indexOf(mo),1)>=fyStart;});
              const fyOTPay=fyRows.reduce((s,r)=>s+(r.ot||0),0);
              const fyOTHrsEst=Math.round(fyOTPay/PAY.otRate*100)/100;
              if(fyRows.length===0) return null;
              return(
                <div style={{...card,marginBottom:14,border:"1px solid #2a4a4a"}}>
                  <SectionLabel>FY Overtime Tracker -- {fyLabel}</SectionLabel>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
                    {[
                      {label:"Total OT Pay",value:fmt(fyOTPay),accent:"#4affd4"},
                      {label:"Est. OT Hours",value:fyOTHrsEst+"h",accent:"#00c88c",sub:"at £"+PAY.otRate+"/hr avg"},
                      {label:"Months Tracked",value:fyRows.length,accent:"#7c6fff"},
                      {label:"Avg OT/Month",value:fmt(fyOTPay/fyRows.length),accent:"#ffb84a"},
                    ].map(k=>(
                      <div key={k.label} style={{background:"#0d1117",borderRadius:8,padding:"10px",textAlign:"center"}}>
                        <div style={{fontSize:9,color:"#5a6480",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>{k.label}</div>
                        <div style={{fontSize:16,fontWeight:700,color:k.accent}}>{k.value}</div>
                        {k.sub&&<div style={{fontSize:9,color:"#3a4460",marginTop:2}}>{k.sub}</div>}
                      </div>
                    ))}
                  </div>
                  <SectionLabel>Month by Month</SectionLabel>
                  {fyRows.map((r,i,arr)=>(
                    <StatRow key={r.month} label={r.month} value={r.ot>0?fmt(r.ot):"--"} color={r.ot>0?"#4affd4":"#3a4460"} last={i===arr.length-1}/>
                  ))}
                </div>
              );
            })()}

            <button onClick={()=>{if(window.confirm("Reset timesheet data for new month? This clears the current accumulator."))resetTimesheet();}} style={{width:"100%",background:"#2a1a1a",border:"1px solid #5a2a2a",borderRadius:8,color:"#ff6b8a",fontSize:12,fontWeight:600,padding:"12px",cursor:"pointer"}}>
              Reset for New Month
            </button>
          </div>
        )}

        {tab==="Gifts"&&(()=>{
          const totalCost=gifts.reduce((a,g)=>a+(Number(g.cost)||0),0);
          const bDone=gifts.filter(g=>g.birthday_year===giftYear).length;
          const cDone=gifts.filter(g=>g.christmas_year===giftYear).length;
          const sorted=[...gifts].sort((a,b)=>{
            if(giftSort==="name")return (a.name||"").localeCompare(b.name||"");
            const na=nextBirthday(a.dob),nb=nextBirthday(b.dob);
            if(na&&nb)return na.days-nb.days;
            if(na)return -1; if(nb)return 1;
            return (a.name||"").localeCompare(b.name||"");
          });
          const chip=(on,emoji,label,onClick)=>(
            <button onClick={e=>{e.stopPropagation();onClick();}} style={{
              flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,
              background:on?"#13301f":"#0d1117",border:"1px solid "+(on?"#2f7d4f":"#2a3050"),borderRadius:8,
              color:on?"#4ad07a":"#8892b0",fontSize:13,fontWeight:700,padding:"11px",cursor:"pointer"
            }}>{emoji} {label} {on?"✓":""}</button>
          );
          return (
          <div>
            <div style={{...card,marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-around",textAlign:"center",padding:"14px 8px"}}>
              <div><div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>Total</div><div style={{fontSize:18,fontWeight:800,color:"#e8eaf0",marginTop:2}}>{fmt(totalCost)}</div></div>
              <div><div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>🎂 Sorted</div><div style={{fontSize:18,fontWeight:800,color:"#c8cee0",marginTop:2}}>{bDone}/{gifts.length}</div></div>
              <div><div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>🎄 Sorted</div><div style={{fontSize:18,fontWeight:800,color:"#c8cee0",marginTop:2}}>{cDone}/{gifts.length}</div></div>
            </div>

            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button onClick={()=>{haptic();setGiftForm({id:null,name:"",dob:"",notes:"",cost:""});setGiftOpen(true);}}
                style={{flex:1,background:"#1a3a5a",border:"1px solid #2a5a8a",borderRadius:10,color:"#8ec5ff",fontSize:15,fontWeight:700,padding:"13px",cursor:"pointer"}}>
                ＋ Add person
              </button>
              <button onClick={()=>{haptic();setGiftSort(giftSort==="bday"?"name":"bday");}}
                style={{background:"#161b28",border:"1px solid #2a3050",borderRadius:10,color:"#8892b0",fontSize:12,fontWeight:700,padding:"0 14px",cursor:"pointer"}}>
                {giftSort==="bday"?"🎂 Birthday":"A–Z"}
              </button>
            </div>

            {gifts.length===0&&<div style={{...card,fontSize:13,color:"#5a6480",textAlign:"center",padding:"20px 12px"}}>No one added yet. Tap “Add person” to start your gift list.</div>}

            {sorted.map(g=>{
              const bd=nextBirthday(g.dob);
              const bDoneG=g.birthday_year===giftYear, cDoneG=g.christmas_year===giftYear;
              const dobStr=g.dob?new Date(g.dob+"T00:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}):"";
              const badge=bd?(bd.days===0?"🎂 today!":bd.days===1?"🎂 tomorrow":`🎂 in ${bd.days}d`):"";
              return (
                <div key={g.id} onClick={()=>{haptic();setGiftForm({id:g.id,name:g.name,dob:g.dob||"",notes:g.notes||"",cost:g.cost!=null?String(g.cost):""});setGiftOpen(true);}}
                  style={{...card,marginBottom:8,cursor:"pointer"}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,marginBottom:10}}>
                    <div style={{minWidth:0,flex:1}}>
                      <div style={{fontSize:16,fontWeight:700,color:"#e8eaf0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{g.name}</div>
                      {dobStr&&<div style={{fontSize:12,color:"#5a6480",marginTop:2}}>{dobStr}{bd?` · turning ${bd.turning}`:""}</div>}
                    </div>
                    {badge&&<div style={{fontSize:11,fontWeight:700,color:bd&&bd.days<=14?"#ffb84a":"#5a6480",whiteSpace:"nowrap",paddingTop:2}}>{badge}</div>}
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:(g.notes||Number(g.cost))?10:0}}>
                    {chip(bDoneG,"🎂","Birthday",()=>toggleGift(g.id,"birthday_year"))}
                    {chip(cDoneG,"🎄","Christmas",()=>toggleGift(g.id,"christmas_year"))}
                  </div>
                  {(g.notes||Number(g.cost)>0)&&(
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
                      <div style={{fontSize:13,color:"#8892b0",minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{g.notes||""}</div>
                      {Number(g.cost)>0&&<div style={{fontSize:14,fontWeight:700,color:"#c8cee0",whiteSpace:"nowrap"}}>{fmt(g.cost)}</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          );
        })()}

        {tab==="Settle Up"&&(()=>{
          const me=isOwner?"glyn":"hollie";
          const themName=isOwner?"Hollie":"Glyn";
          const net=settlements.reduce((a,s)=>a+settleSignedOf(s),0);
          const owedToMe=me==="glyn"?net:-net;            // >0 they owe me, <0 I owe them
          const r=Math.round(owedToMe*100)/100;
          return (
          <div>
            <div style={{...card,marginBottom:12,textAlign:"center",padding:"22px 12px"}}>
              {Math.abs(r)<0.005?(
                <>
                  <div style={{fontSize:30,marginBottom:6}}>🤝</div>
                  <div style={{fontSize:18,fontWeight:800,color:"#4ad07a"}}>All settled up</div>
                  <div style={{fontSize:12,color:"#5a6480",marginTop:4}}>Nobody owes anybody</div>
                </>
              ):(
                <>
                  <div style={{fontSize:11,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>
                    {r>0?`${themName} owes you`:`You owe ${themName}`}
                  </div>
                  <div style={{fontSize:38,fontWeight:800,color:r>0?"#4ad07a":"#ff6b8a",lineHeight:1}}>{fmt(r)}</div>
                </>
              )}
            </div>

            <button onClick={()=>{haptic();setSettleForm({kind:"charge",mine:true,amount:"",note:"",date:new Date().toISOString().slice(0,10)});setSettleOpen(true);}}
              style={{width:"100%",background:"#1a3a5a",border:"1px solid #2a5a8a",borderRadius:10,color:"#8ec5ff",fontSize:15,fontWeight:700,padding:"15px",cursor:"pointer",marginBottom:14}}>
              ＋ Add entry
            </button>

            <div style={hdr}>History</div>
            {settlements.length===0&&<div style={{...card,fontSize:13,color:"#5a6480",textAlign:"center",padding:"20px 12px"}}>No entries yet. Tap “Add entry” to log a cost someone covered, or a repayment.</div>}
            {settlements.map(s=>{
              const signed=settleSignedOf(s);
              const effectOnMe=me==="glyn"?signed:-signed;   // + increases what I'm owed
              const desc=s.kind==="repayment"
                ? (s.payer===me?`You paid ${themName} back`:`${themName} paid you back`)
                : (s.payer===me?`You covered${s.note?` ${s.note}`:" a cost"}`:`${themName} covered${s.note?` ${s.note}`:" a cost"}`);
              const dstr=s.entry_date?new Date(s.entry_date+"T00:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}):"";
              return (
                <div key={s.id} style={{...card,marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:600,color:"#e8eaf0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{desc}</div>
                    <div style={{fontSize:11,color:"#5a6480",marginTop:2}}>{s.kind==="repayment"?"Repayment":"Cost covered"}{dstr?` · ${dstr}`:""}</div>
                  </div>
                  <div style={{fontSize:15,fontWeight:800,color:effectOnMe>=0?"#4ad07a":"#ff6b8a",whiteSpace:"nowrap"}}>{effectOnMe>=0?"+":"−"}{fmt(s.amount)}</div>
                  <button onClick={()=>{haptic();delSettlement(s.id);}} style={{background:"transparent",border:"none",color:"#5a6480",fontSize:18,cursor:"pointer",padding:"0 2px",lineHeight:1}}>✕</button>
                </div>
              );
            })}
          </div>
          );
        })()}

        {tab==="Diag"&&(
          <div>
            <div style={{...card,marginBottom:12}}>
              <div style={hdr}>App</div>
              {(()=>{
                const now=new Date();
                let ps,pe;
                if(now.getDate()>=29){ps=new Date(now.getFullYear(),now.getMonth(),29);pe=new Date(now.getFullYear(),now.getMonth()+1,28);}
                else{ps=new Date(now.getFullYear(),now.getMonth()-1,29);pe=new Date(now.getFullYear(),now.getMonth(),28);}
                const fmt=(d)=>d.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
                return (
                  <>
                    <div style={row}><span style={{color:"#5a6480"}}>Version</span><span style={{color:"#c8cee0",fontWeight:700}}>v{APP_VERSION}</span></div>
                    <div style={row}><span style={{color:"#5a6480"}}>Signed in</span><span style={{color:"#c8cee0",wordBreak:"break-all"}}>{user?user.email:"no"}</span></div>
                    <div style={row}><span style={{color:"#5a6480"}}>Pay period</span><span style={{color:"#c8cee0"}}>{fmt(ps)} – {fmt(pe)}</span></div>
                    <div style={{...row,borderBottom:"none"}}><span style={{color:"#5a6480"}}>Standard hours</span><span style={{color:"#c8cee0",fontWeight:700}}>{getCurrentMonthHours()}h</span></div>
                  </>
                );
              })()}
            </div>

            <div style={{...card,marginBottom:12}}>
              <div style={hdr}>Data</div>
              {[
                ["Payslips",history.length],
                ["Shared bills",sharedBills.length],
                ["Glyn bills",glynBills.length],
                ["Categories",cats.length+glynCats.length],
                ["Monthly timesheets",monthlyTs.length],
                ["Leave logs",leaveLogs.length],
                ["Accumulator days",(accumulated.days||[]).length],
              ].map((pair,i,a)=>(
                <div key={pair[0]} style={i===a.length-1?{...row,borderBottom:"none"}:row}>
                  <span style={{color:"#5a6480"}}>{pair[0]}</span>
                  <span style={{color:"#c8cee0",fontWeight:700}}>{pair[1]}</span>
                </div>
              ))}
              <div style={{fontSize:11,color:"#3a4460",marginTop:8,paddingTop:8,borderTop:"1px solid #1a1f2e"}}>
                Accumulator OT {accumulated.otHrs||0}h · weekend {accumulated.weekendOtHrs||0}h
              </div>
            </div>

            <div style={{...card,marginBottom:12}}>
              <div style={hdr}>PWA / Sync</div>
              <DiagProbe prompt={pwaPrompt} user={user}/>
              <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid #1a1f2e"}}>
                {dbError ? (
                  <div style={{background:"#1a0a0a",border:"1px solid #3a1a1a",borderRadius:8,padding:"10px 12px"}}>
                    <div style={{fontSize:11,fontWeight:700,color:"#ff6b8a",marginBottom:4}}>⚠ Last sync error</div>
                    <div style={{fontSize:11,color:"#e8eaf0",wordBreak:"break-all"}}>{dbError.where}: {dbError.message}</div>
                    <div style={{fontSize:10,color:"#5a6480",marginTop:4}}>{new Date(dbError.at).toLocaleString("en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</div>
                    <button onClick={()=>{haptic();lastDbError=null;dbErrorListeners.forEach(fn=>fn(null));}} style={{marginTop:8,width:"100%",background:"#141824",border:"1px solid #2a3050",borderRadius:6,color:"#8892b0",fontSize:11,fontWeight:600,padding:"7px",cursor:"pointer"}}>Clear</button>
                  </div>
                ) : (
                  <div style={{fontSize:11,color:"#3a4460"}}>No sync errors logged.</div>
                )}
              </div>
            </div>

          <div style={{...card,marginBottom:14,padding:0}}>
            <div onClick={()=>{haptic();setShowPayslipUpload(v=>!v);}} style={{padding:"14px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>📄 Upload Payslips</div>
              <span style={{color:"#3a4460",fontSize:14}}>{showPayslipUpload?"⌃":"⌄"}</span>
            </div>
            {showPayslipUpload && (<div style={{padding:"0 14px 14px",textAlign:"center"}}>
            <p style={{fontSize:12,color:"#5a6480",marginBottom:16}}>Select one or more payslip PDFs. They'll be read and added to your history automatically.</p>
            <label htmlFor="payslip-upload-input" style={{display:"block",background:"#0d1117",border:"2px dashed #2a3050",borderRadius:10,padding:"24px 16px",cursor:uploading?"not-allowed":"pointer",position:"relative"}}>
              <input id="payslip-upload-input" type="file" accept=".pdf,application/pdf" multiple onChange={handleUpload} disabled={uploading}
                style={{position:"absolute",left:0,top:0,width:"100%",height:"100%",opacity:0,cursor:uploading?"not-allowed":"pointer"}}/>
              {uploading
                ?<div style={{textAlign:"center"}}><div style={{fontSize:20,marginBottom:6}}>⏳</div><div style={{color:"#4a9eff",fontSize:13}}>{uploadProgress||"Processing..."}</div></div>
                :<div style={{textAlign:"center"}}><div style={{fontSize:20,marginBottom:6}}>☁️</div><div style={{color:"#4a9eff",fontSize:13,fontWeight:600}}>Tap to select PDFs</div><div style={{color:"#3a4460",fontSize:11,marginTop:4}}>You can select multiple files at once</div></div>
              }
            </label>
            {multiResults.length>0&&(
              <div style={{marginTop:16,textAlign:"left"}}>
                <div style={{fontSize:11,fontWeight:700,color:"#00c88c",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>
                  ✓ {multiResults.filter(r=>r.ok).length} of {multiResults.length} added
                </div>
                {multiResults.map((r,i)=>(
                  <div key={i} style={{padding:"8px 10px",borderRadius:6,marginBottom:6,background:r.ok?"#0a1a10":"#2a0f15",border:"1px solid "+(r.ok?"#1a4030":"#5a1a2a"),fontSize:12}}>
                    {r.ok
                      ?<div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:"#00c88c",fontWeight:600}}>{r.parsed.month}</span><span style={{color:"#8892b0"}}>Gross {fmt(r.parsed.gross)} - Net {fmt(r.parsed.net)}</span></div>
                      :<div style={{color:"#ff6b8a"}}>⚠ {r.name} -- {r.err}</div>
                    }
                  </div>
                ))}
              </div>
            )}
            </div>)}
          </div>

          <div style={{...card,marginBottom:14,padding:0}}>
            <div onClick={()=>{haptic();setShowManualTs(v=>!v);}} style={{padding:"14px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div>
                <div style={{fontSize:9,color:"#ffb84a",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Weekly Timesheet (Manual)</div>
                <p style={{fontSize:11,color:"#5a6480",margin:0}}>Backup option -- auto-import handles this automatically</p>
              </div>
              <span style={{color:"#3a4460",fontSize:14}}>{showManualTs?"A":"V"}</span>
            </div>
            {showManualTs && (<div style={{padding:"0 14px 14px"}}>
            <label style={{display:"block",background:"#0d1117",border:"2px dashed "+(showTsReminder?"#ffb84a":"#2a3050"),borderRadius:10,padding:"20px 16px",cursor:tsUploading?"not-allowed":"pointer",marginBottom:12}}>
              <input type="file" accept="image/*,application/pdf" multiple onChange={handleTimesheetUpload} style={{display:"none"}} disabled={tsUploading}/>
              {tsUploading
                ?<div style={{textAlign:"center"}}><div style={{fontSize:20,marginBottom:6}}>⏳</div><div style={{color:"#ffb84a",fontSize:13}}>{tsProgress||"Processing..."}</div></div>
                :<div style={{textAlign:"center"}}><div style={{fontSize:20,marginBottom:6}}>📸</div><div style={{color:"#ffb84a",fontSize:13,fontWeight:600}}>Tap to upload timesheet screenshot</div><div style={{color:"#3a4460",fontSize:11,marginTop:4}}>Select multiple images if timesheet is long</div></div>
              }
            </label>
            {tsPending&&(()=>{
              // Calculate what the totals will be after merge+dedup
              const STD = 8.25;
              const enrichedNew = tsPending.days.map(d => {
                const hrs = parseHM(d.hours);
                const isWeekend = d.day.toLowerCase().startsWith("sat") || d.day.toLowerCase().startsWith("sun");
                return { ...d, hrs, otHrs: isWeekend ? 0 : Math.max(0, Math.round((hrs-STD)*100)/100), wkOtHrs: isWeekend ? hrs : 0 };
              });
              const seen = new Set();
              const merged = [...(accumulated.days||[]), ...enrichedNew]
                .sort((a,b)=>{const[ad,am]=(a.date||"").split("/").map(Number);const[bd,bm]=(b.date||"").split("/").map(Number);return am!==bm?am-bm:ad-bd;})
                .filter(d=>{const k=d.date+"_"+d.day;if(seen.has(k))return false;seen.add(k);return true;});
              const projOT = Math.round(merged.reduce((s,d)=>s+(d.otHrs||0),0)*100)/100;
              const projWknd = Math.round(merged.reduce((s,d)=>s+(d.wkOtHrs||0),0)*100)/100;
              return(
                <div style={{background:"#0d1a10",border:"1px solid #1a4030",borderRadius:10,padding:14,marginBottom:12}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#00c88c",letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>✓ Extracted -- {tsPending.days.length} days</div>
                  <div style={{maxHeight:200,overflowY:"auto",marginBottom:12}}>
                    {tsPending.days.map((d,i)=>(
                      <div key={i} style={{display:"grid",gridTemplateColumns:"60px 50px 1fr",padding:"5px 0",borderBottom:"1px solid #1a2a20",fontSize:11}}>
                        <span style={{color:"#5a8070"}}>{d.date}</span>
                        <span style={{color:"#8892b0"}}>{d.day}</span>
                        <span style={{color:"#e8eaf0",textAlign:"right",fontWeight:600}}>{d.hours}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{fontSize:9,color:"#5a6480",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Month total after applying</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:12}}>
                    {[["Weekday OT",projOT,"#4affd4"],["Weekend OT",projWknd,"#ffb84a"]].map(([l,v,c])=>(
                      <div key={l} style={{background:"#0a1a10",borderRadius:6,padding:"8px",textAlign:"center"}}>
                        <div style={{fontSize:9,color:"#5a6480",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>{l}</div>
                        <div style={{fontSize:14,fontWeight:700,color:c}}>{v}h</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={confirmTimesheet} style={{flex:1,background:"#00c88c",border:"none",borderRadius:8,color:"#000",fontSize:13,fontWeight:700,padding:"10px",cursor:"pointer"}}>Apply to Pay Calc</button>
                    <button onClick={()=>setTsPending(null)} style={{background:"#1e2535",border:"none",borderRadius:8,color:"#8892b0",fontSize:13,padding:"10px 14px",cursor:"pointer"}}>Discard</button>
                  </div>
                </div>
              );
            })()}
          </div>)}
          </div>

          <div style={{...card,marginBottom:14}}>
            <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Account</div>
            <div style={{padding:"10px 12px",background:"#111520",borderRadius:8,border:"1px solid #1e2535",marginBottom:10}}>
              <div style={{fontSize:11,color:"#5a6480",marginBottom:4}}>Signed in as</div>
              <div style={{fontSize:13,color:"#e8eaf0",fontWeight:600,wordBreak:"break-all"}}>{user?.email || "--"}</div>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button onClick={()=>{haptic("medium");refreshAll();}}
                style={{flex:"1 1 100px",background:"#1e2535",border:"none",borderRadius:8,color:"#4a9eff",fontSize:12,fontWeight:600,padding:"10px",cursor:"pointer"}}>
                🔄 Refresh data
              </button>
              <button onClick={async()=>{
                const partnerPersonalBills=await fetchPartnerBills();
                const data={history,sharedBills,glynBills,cats,billCats,glynCats,glynBillCats,calcInputs:ci,notes,leaveLogs,monthlyTs,scenarios,partnerPersonalBills,settlements,gifts,scheduledBills,exportedAt:new Date().toISOString()};
                const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
                const url=URL.createObjectURL(blob);
                const a=document.createElement("a");
                a.href=url;a.download=`vaulted-backup-${new Date().toISOString().slice(0,10)}.json`;
                a.click();URL.revokeObjectURL(url);
              }}
                style={{flex:"1 1 100px",background:"#1e2535",border:"none",borderRadius:8,color:"#00c88c",fontSize:12,fontWeight:600,padding:"10px",cursor:"pointer"}}>
                📥 Export backup
              </button>
              <button onClick={async ()=>{
                if(!window.confirm("Sign out? You'\''ll need to log in again to access your data.")) return;
                haptic("heavy");await handleSignOut();
              }}
                style={{flex:"1 1 100px",background:"#1e2535",border:"none",borderRadius:8,color:"#ff6b8a",fontSize:12,fontWeight:600,padding:"10px",cursor:"pointer"}}>
                🚪 Sign out
              </button>
            </div>
          </div>

          <div style={{...card,marginBottom:14}}>
            <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Auto Timesheet Import</div>
            <div style={{fontSize:12,color:"#8892b0",marginBottom:10,lineHeight:1.6}}>
              Paste your <span style={{color:"#4affd4",fontWeight:600}}>TIMESHEET_SECRET</span> from Vercel to enable automatic timesheet import from Gmail.
            </div>
            <input
              type="password"
              placeholder="Paste secret here..."
              value={tsSecret}
              onChange={e=>{setTsSecret(e.target.value);save(SK.tsSecret,e.target.value);}}
              style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #1e2535",borderRadius:8,color:"#e8eaf0",fontSize:13,padding:"10px 12px",fontFamily:"inherit",marginBottom:8}}
            />
            {tsSecret ? (
              <div style={{fontSize:11,color:"#00c88c"}}>✅ Secret saved -- polling every 60s</div>
            ) : (
              <div style={{fontSize:11,color:"#3a4460"}}>No secret set -- auto-import disabled</div>
            )}
            {tsLastEmail && <div style={{fontSize:10,color:"#3a4460",marginTop:4}}>Last email ID: {tsLastEmail.slice(0,12)}...</div>}

            {/* Queue diagnostics - collapsed by default */}
            {tsSecret && (
              <div style={{marginTop:12,background:"#0d1117",border:"1px solid #1e2535",borderRadius:8,overflow:"hidden"}}>
                <div onClick={()=>{haptic();setShowQueueDiag(v=>!v);}} style={{padding:"10px 12px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontSize:10,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>Queue Diagnostics</div>
                  <span style={{color:"#3a4460",fontSize:11}}>{showQueueDiag?"A":"V"}</span>
                </div>
                {showQueueDiag && (<div style={{padding:"0 10px 10px"}}>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={async ()=>{
                    haptic("medium");
                    try {
                      const r = await fetch(`/api/timesheet?token=${encodeURIComponent(tsSecret)}`);
                      const d = await r.json();
                      const cnt = d.remaining || (d.status==="pending"?1:0);
                      setImportMsg(`Queue: ${cnt} item${cnt!==1?"s":""} waiting`);
                      setTimeout(()=>setImportMsg(""),4000);
                    } catch(e) { setImportMsg("⚠️ Check failed"); }
                  }} style={{flex:1,background:"#1a2535",border:"1px solid #4a9eff",borderRadius:6,color:"#4a9eff",fontSize:11,fontWeight:700,padding:"8px",cursor:"pointer"}}>Check Queue</button>
                  <button onClick={async ()=>{
                    haptic("medium");
                    if(!window.confirm("Clear ALL queued timesheets? This deletes them from the server queue.")) return;
                    let cleared = 0;
                    for (let i = 0; i < 50; i++) {
                      const r = await fetch(`/api/timesheet?token=${encodeURIComponent(tsSecret)}`, { method: "DELETE" });
                      const d = await r.json();
                      cleared++;
                      if ((d.remaining || 0) === 0) break;
                    }
                    setImportMsg(`✓ Cleared ${cleared} item${cleared!==1?"s":""}`);
                    setTimeout(()=>setImportMsg(""),4000);
                  }} style={{flex:1,background:"#2a1a1a",border:"1px solid #ff6b8a",borderRadius:6,color:"#ff6b8a",fontSize:11,fontWeight:700,padding:"8px",cursor:"pointer"}}>Clear Queue</button>
                </div>
                <button onClick={()=>{
                  haptic("medium");
                  localStorage.removeItem(SK.tsLastEmail);
                  setTsLastEmail("");
                  setImportMsg("✓ Last email cleared -- will re-poll");
                  setTimeout(()=>setImportMsg(""),4000);
                }} style={{marginTop:6,width:"100%",background:"#1a1500",border:"1px solid #ffb84a",borderRadius:6,color:"#ffb84a",fontSize:11,fontWeight:700,padding:"8px",cursor:"pointer"}}>Reset Last Email ID</button>
                </div>)}
              </div>
            )}
          </div>

          <div style={{...card,marginBottom:14}}>
            <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Notifications</div>
            {notifPerm === "granted" ? (
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:"#0a1a10",borderRadius:8,border:"1px solid #1a4030"}}>
                <span style={{fontSize:18}}>🔔</span>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#00c88c"}}>Notifications enabled</div>
                  <div style={{fontSize:11,color:"#3a6040",marginTop:2}}>You'll be notified the day before payday and on timesheet Mondays</div>
                </div>
              </div>
            ) : notifPerm === "denied" ? (
              <div style={{padding:"10px 12px",background:"#1a1a0a",borderRadius:8,border:"1px solid #3a3a10"}}>
                <div style={{fontSize:13,fontWeight:600,color:"#ffb84a",marginBottom:4}}>Notifications blocked</div>
                <div style={{fontSize:11,color:"#5a5030",lineHeight:1.6}}>You've blocked notifications for this site. To enable, go to your browser's site settings and allow notifications for this page, then tap below.</div>
                <button onClick={requestAndSaveNotifPerm} style={{marginTop:10,background:"#ffb84a22",border:"1px solid #ffb84a",borderRadius:8,color:"#ffb84a",fontSize:12,fontWeight:700,padding:"8px 14px",cursor:"pointer"}}>Check again</button>
              </div>
            ) : (
              <div style={{padding:"10px 12px",background:"#111520",borderRadius:8,border:"1px solid #1e2535"}}>
                <div style={{fontSize:13,color:"#8892b0",marginBottom:10}}>Enable browser notifications for payday reminders and weekly timesheet alerts.</div>
                <button onClick={requestAndSaveNotifPerm} style={{width:"100%",background:"#4a9eff",border:"none",borderRadius:8,color:"#000",fontSize:13,fontWeight:700,padding:"11px",cursor:"pointer"}}>🔔 Enable Notifications</button>
              </div>
            )}
          </div>

          <div style={{...card}}>
            <div style={{fontSize:9,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:12}}>Backup & Restore</div>
            <p style={{fontSize:12,color:"#5a6480",marginBottom:10,lineHeight:1.6}}>Your data is auto-backed up daily to the cloud. You can also export a JSON file for offline storage.</p>

            {/* Cloud backups section */}
            <div style={{background:"#0d1117",border:"1px solid #1e2535",borderRadius:8,marginBottom:10,overflow:"hidden"}}>
              <div onClick={async ()=>{
                haptic();
                if(!showBackups && user) {
                  setBackupLoading(true);
                  try { setBackupList(await db.getBackups(user.id)); } catch(e) {}
                  setBackupLoading(false);
                }
                setShowBackups(v=>!v);
              }} style={{padding:"10px 12px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:11,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>☁️ Cloud Backups</div>
                <span style={{color:"#3a4460",fontSize:11}}>{showBackups?"A":"V"}</span>
              </div>
              {showBackups && (
                <div style={{padding:"0 10px 10px"}}>
                  <button onClick={async ()=>{
                    haptic("medium");
                    if (!user) return;
                    setBackupLoading(true);
                    try {
                      const backupData = await buildBackupData();
                      await db.createBackup(user.id, backupData, "manual");
                      setBackupList(await db.getBackups(user.id));
                      setImportMsg("✓ Backup saved to cloud");
                    } catch(e) { setImportMsg("⚠ Backup failed"); }
                    setBackupLoading(false);
                    setTimeout(()=>setImportMsg(""),3000);
                  }} style={{width:"100%",background:"#0a1a10",border:"1px solid #00c88c",borderRadius:6,color:"#00c88c",fontSize:12,fontWeight:700,padding:"10px",cursor:"pointer",marginBottom:8}}>
                    + Backup Now
                  </button>
                  {backupLoading && <div style={{fontSize:11,color:"#5a6480",textAlign:"center",padding:8}}>Loading...</div>}
                  {!backupLoading && backupList.length === 0 && <div style={{fontSize:11,color:"#3a4460",textAlign:"center",padding:8}}>No cloud backups yet</div>}
                  {!backupLoading && backupList.map(b => (
                    <div key={b.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px",background:"#141824",borderRadius:6,marginBottom:4,fontSize:11}}>
                      <div>
                        <div style={{color:"#e8eaf0",fontWeight:600}}>{new Date(b.created_at).toLocaleString("en-GB",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}</div>
                        <div style={{color:"#3a4460",fontSize:10}}>{(b.size_bytes/1024).toFixed(1)}KB - {b.trigger}</div>
                      </div>
                      <div style={{display:"flex",gap:4}}>
                        <button onClick={async ()=>{
                          haptic("medium");
                          if(!window.confirm("Restore this backup? Your current data will be replaced.")) return;
                          try {
                            const full = await db.getBackup(b.id);
                            const d = full.data;
                            if(d.history){updH(d.history);}
                            if(d.sharedBills){updSB(d.sharedBills);}
                            if(d.glynBills){updGB(d.glynBills);}
                            if(d.partnerPersonalBills){await restorePartnerBills(d.partnerPersonalBills);}
                            if(d.settlements){await restoreSettlements(d.settlements);}
                            if(d.gifts){await restoreGifts(d.gifts);}
                            if(d.scheduledBills){await restoreScheduledBills(d.scheduledBills);}
                            restoreCats(d);
                            if(d.calcInputs){setCi(d.calcInputs);if(user)db.saveAppSettings(user.id,{calc_inputs:d.calcInputs});}
                            if(d.notes){updNotes(d.notes);}
                            if(d.leaveLogs){setLeaveLogs(d.leaveLogs);}
                            if(d.leaveSettings){setLeaveSettings(d.leaveSettings);}
                            if(d.scenarios){setScenarios(d.scenarios);}
                            if(d.tierOverride!==undefined){setTierOverride(d.tierOverride);}
                            setImportMsg("✓ Backup restored");
                          } catch(e) { setImportMsg("⚠ Restore failed"); }
                          setTimeout(()=>setImportMsg(""),3000);
                        }} style={{background:"#1a2535",border:"1px solid #4a9eff",borderRadius:4,color:"#4a9eff",fontSize:10,fontWeight:700,padding:"5px 8px",cursor:"pointer"}}>Restore</button>
                        <button onClick={async ()=>{
                          if(!window.confirm("Delete this backup?")) return;
                          haptic("medium");
                          try {
                            await db.deleteBackup(b.id);
                            setBackupList(await db.getBackups(user.id));
                          } catch(e) {}
                        }} style={{background:"none",border:"none",color:"#3a4460",fontSize:14,cursor:"pointer",padding:"2px 4px"}}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <p style={{fontSize:11,color:"#5a6480",marginBottom:10,lineHeight:1.5}}>Or export a local JSON file (useful before major changes):</p>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button onClick={exportData} style={{flex:1,background:"#1a2535",border:"1px solid #4a9eff",borderRadius:8,color:"#4a9eff",fontSize:13,fontWeight:700,padding:"12px",cursor:"pointer"}}>⬇ Export Backup</button>
              <label style={{flex:1,background:"#1a2535",border:"1px solid #00c88c",borderRadius:8,color:"#00c88c",fontSize:13,fontWeight:700,padding:"12px",cursor:"pointer",textAlign:"center"}}>
                ⬆ Import Backup
                <input type="file" accept=".json" onChange={importData} style={{display:"none"}}/>
              </label>
            </div>
            {importMsg&&(
              <div style={{padding:"10px 12px",borderRadius:8,background:importMsg.startsWith("✓")?"#0a1a10":"#2a0f15",border:"1px solid "+(importMsg.startsWith("✓")?"#1a4030":"#5a1a2a"),color:importMsg.startsWith("✓")?"#00c88c":"#ff6b8a",fontSize:12,textAlign:"center"}}>
                {importMsg}
              </div>
            )}
          </div>
          </div>
        )}

      </div>

      <div style={{textAlign:"center",padding:"16px 0 24px",borderTop:"1px solid #1a1f2e",marginTop:8}}>
        <span style={{fontSize:10,color:"#2a3050",letterSpacing:2,fontWeight:600}}>{`VAULTED v${APP_VERSION}`}</span>
      </div>

      {/* Pull-to-refresh indicator */}
      {(pullY>0||refreshing)&&(
        <div style={{position:"fixed",top:0,left:0,right:0,zIndex:105,display:"flex",justifyContent:"center",alignItems:"flex-end",height:refreshing?40:Math.max(0,Math.min(pullY,80)),background:"#0d0f14",color:"#5a6480",fontSize:12,fontWeight:600,paddingBottom:6,pointerEvents:"none",transition:refreshing?"height 0.2s":"none"}}>
          {refreshing?"Refreshing…":pullY>70?"Release to refresh":"Pull to refresh"}
        </div>
      )}

      {/* Undo toast */}
      {toast&&(
        <div style={{position:"fixed",left:12,right:12,bottom:"calc(80px + env(safe-area-inset-bottom))",zIndex:220,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,background:"#1a1f2e",border:"1px solid #2a3050",borderRadius:10,padding:"12px 14px",boxShadow:"0 4px 20px #000a"}}>
          <span style={{fontSize:13,color:"#e8eaf0"}}>{toast.msg}</span>
          <button onClick={()=>{haptic();if(toast.undo)toast.undo();if(toastTimer.current)clearTimeout(toastTimer.current);setToast(null);}} style={{background:"none",border:"none",color:"#4a9eff",fontSize:13,fontWeight:700,cursor:"pointer",padding:"4px 8px"}}>Undo</button>
        </div>
      )}

      {/* Bottom navigation */}
      <div style={{position:"fixed",left:0,right:0,bottom:0,zIndex:200,display:"flex",background:"#0d1117",borderTop:"1px solid #1e2535",paddingBottom:"env(safe-area-inset-bottom)"}}>
        {primaryTabs.map(t=>(
          <button key={t} onClick={()=>{haptic();setShowMore(false);setTab(t);window.scrollTo(0,0);}} style={{
            flex:1,background:"none",border:"none",cursor:"pointer",padding:"11px 2px 13px",
            color:tab===t?"#4a9eff":"#5a6480",fontSize:11,fontWeight:700,
            borderTop:"2px solid "+(tab===t?"#4a9eff":"transparent")
          }}>{t}</button>
        ))}
        <button onClick={()=>{haptic();setShowMore(s=>!s);}} style={{
          flex:1,background:"none",border:"none",cursor:"pointer",padding:"11px 2px 13px",
          color:(showMore||secondaryTabs.includes(tab))?"#a0c0ff":"#5a6480",fontSize:11,fontWeight:700,
          borderTop:"2px solid "+((showMore||secondaryTabs.includes(tab))?"#a0c0ff":"transparent")
        }}>More ⋯</button>
      </div>

      {/* "More" sheet -- secondary tabs */}
      {showMore&&(
        <div onClick={()=>setShowMore(false)} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:210,background:"rgba(0,0,0,0.6)"}}>
          <div onClick={e=>e.stopPropagation()} style={{position:"absolute",left:0,right:0,bottom:0,background:"#141824",borderTop:"1px solid #2a3050",borderRadius:"16px 16px 0 0",padding:"8px 12px",paddingBottom:"calc(16px + env(safe-area-inset-bottom))"}}>
            <div style={{width:40,height:4,background:"#2a3050",borderRadius:2,margin:"6px auto 10px"}}/>
            <div style={{fontSize:10,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",padding:"0 4px 6px"}}>More</div>
            {secondaryTabs.map(t=>(
              <button key={t} onClick={()=>{haptic();setTab(t);setShowMore(false);window.scrollTo(0,0);}} style={{
                display:"block",width:"100%",textAlign:"left",background:tab===t?"#1a2535":"transparent",
                border:"none",borderRadius:8,color:tab===t?"#a0c0ff":"#c8cee0",fontSize:15,fontWeight:600,padding:"15px 14px",cursor:"pointer",marginBottom:2
              }}>{t}</button>
            ))}
          </div>
        </div>
      )}

      {/* Move-to-category sheet */}
      {moveBill&&(()=>{
        const isG=moveBill.isGlyn;
        const list=isG?glynCats:cats;
        const curCat=(isG?glynBillCats:billCats)[moveBill.id];
        const bill=(isG?glynBills:sharedBills).find(b=>b.id===moveBill.id);
        return(
          <div onClick={()=>setMoveBill(null)} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:210,background:"rgba(0,0,0,0.6)"}}>
            <div onClick={e=>e.stopPropagation()} style={{position:"absolute",left:0,right:0,bottom:0,background:"#141824",borderTop:"1px solid #2a3050",borderRadius:"16px 16px 0 0",padding:"8px 12px",paddingBottom:"calc(16px + env(safe-area-inset-bottom))",maxHeight:"72vh",overflowY:"auto"}}>
              <div style={{width:40,height:4,background:"#2a3050",borderRadius:2,margin:"6px auto 10px"}}/>
              <div style={{fontSize:13,color:"#e8eaf0",fontWeight:700,padding:"0 4px 8px"}}>Edit bill</div>
              <input key={moveBill.id} defaultValue={bill?bill.name:""} placeholder="Bill name"
                onBlur={e=>{const v=e.target.value.trim();if(v&&bill&&v!==bill.name)renameBill(moveBill.id,v,isG);}}
                style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:15,fontWeight:600,padding:"12px 14px",marginBottom:14}}/>
              <div style={{fontSize:10,color:"#5a6480",fontWeight:700,letterSpacing:1,textTransform:"uppercase",padding:"0 4px 8px"}}>Move to category</div>
              {list.map(c=>(
                <button key={c.id} onClick={()=>{haptic();assignCat(moveBill.id,c.id,isG);setMoveBill(null);}} style={{
                  display:"flex",justifyContent:"space-between",alignItems:"center",width:"100%",textAlign:"left",background:curCat===c.id?"#1a2535":"transparent",
                  border:"none",borderRadius:8,color:curCat===c.id?"#a0c0ff":"#c8cee0",fontSize:15,fontWeight:600,padding:"15px 14px",cursor:"pointer",marginBottom:2
                }}><span>{c.name}</span>{curCat===c.id&&<span style={{color:"#4a9eff"}}>✓</span>}</button>
              ))}
              {list.length===0&&<div style={{fontSize:12,color:"#5a6480",padding:"8px 14px"}}>No categories yet — add one first.</div>}
              <button onClick={()=>{haptic();assignCat(moveBill.id,null,isG);setMoveBill(null);}} style={{
                display:"flex",justifyContent:"space-between",alignItems:"center",width:"100%",textAlign:"left",background:!curCat?"#1a2535":"transparent",
                border:"none",borderRadius:8,color:"#8892b0",fontSize:14,fontWeight:600,padding:"15px 14px",cursor:"pointer",marginTop:4
              }}><span>Uncategorised</span>{!curCat&&<span style={{color:"#8892b0"}}>✓</span>}</button>
            </div>
          </div>
        );
      })()}

      {schedOpen&&(()=>{
        const themName=isOwner?"Hollie":"Glyn";
        const sheet={position:"absolute",left:0,right:0,bottom:0,background:"#141824",borderTop:"1px solid #2a3050",borderRadius:"16px 16px 0 0",padding:"8px 14px",paddingBottom:"calc(16px + env(safe-area-inset-bottom))",maxHeight:"90vh",overflowY:"auto"};
        const grab=<div style={{width:40,height:4,background:"#2a3050",borderRadius:2,margin:"6px auto 12px"}}/>;
        const mine=scheduledBills.filter(b=>b.scope==="shared"||b.owner===myId);
        const isPast=(b)=>b.freq==="once"&&!schedActive(b)&&(((b.year||0)<schedNowYear)||((b.year||0)===schedNowYear&&Math.max(0,...(Array.isArray(b.months)?b.months:[0]))<schedNowMonth));
        const tag=(b)=>b.scope==="shared"?"Shared":"Personal";
        if(schedForm){
          const f=schedForm;
          const setF=(patch)=>setSchedForm(p=>({...p,...patch}));
          const editing=!!f.id;
          const valid=(f.name||"").trim().length>0 && f.months.length>0 && (f.freq!=="once"||!!f.year);
          const seg=(active)=>({flex:1,background:active?"#1a3a5a":"transparent",border:active?"1px solid #2a5a8a":"1px solid #2a3050",borderRadius:8,color:active?"#8ec5ff":"#8892b0",fontSize:13,fontWeight:700,padding:"11px",cursor:"pointer"});
          return (
            <div onClick={()=>setSchedOpen(false)} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:210,background:"rgba(0,0,0,0.6)"}}>
              <div onClick={e=>e.stopPropagation()} style={sheet}>
                {grab}
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                  <button onClick={()=>setSchedForm(null)} style={{background:"transparent",border:"none",color:"#8ec5ff",fontSize:13,fontWeight:700,cursor:"pointer",padding:0}}>‹ Back</button>
                  <div style={{fontSize:14,color:"#e8eaf0",fontWeight:800,flex:1,textAlign:"center",marginRight:40}}>{editing?"Edit scheduled bill":"New scheduled bill"}</div>
                </div>

                <div style={{...hdr,marginBottom:6}}>Name</div>
                <input value={f.name} onChange={e=>setF({name:e.target.value})} placeholder="e.g. Car tax"
                  style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:15,fontWeight:600,padding:"12px 14px",marginBottom:14}}/>

                <div style={{...hdr,marginBottom:6}}>Amount (£)</div>
                <input value={f.total} onChange={e=>setF({total:e.target.value.replace(/[^0-9.]/g,"")})} inputMode="decimal" placeholder="0.00"
                  style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:15,fontWeight:600,padding:"12px 14px",marginBottom:14}}/>

                <div style={{...hdr,marginBottom:6}}>Show under</div>
                <div style={{display:"flex",gap:8,marginBottom:f.scope==="shared"?10:14}}>
                  <button onClick={()=>setF({scope:"shared"})} style={seg(f.scope==="shared")}>Shared bills</button>
                  <button onClick={()=>setF({scope:"personal"})} style={seg(f.scope==="personal")}>My bills</button>
                </div>
                {f.scope==="shared"&&(
                  <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#8892b0",marginBottom:14,cursor:"pointer"}}>
                    <input type="checkbox" checked={!!f.isCarGlyn} onChange={e=>setF({isCarGlyn:e.target.checked})}/>
                    Car split ({themName} pays £{HOLLIE_CAR}, rest is yours)
                  </label>
                )}

                <div style={{...hdr,marginBottom:6}}>When</div>
                <div style={{display:"flex",gap:8,marginBottom:12}}>
                  <button onClick={()=>setF({freq:"annual"})} style={seg(f.freq==="annual")}>Every year</button>
                  <button onClick={()=>setF({freq:"once",months:f.months.slice(0,1)})} style={seg(f.freq==="once")}>One-off</button>
                </div>

                <div style={{fontSize:11,color:"#5a6480",marginBottom:8}}>{f.freq==="once"?"Pick the month it's due":"Pick the month(s) it's due each year"}</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:14}}>
                  {MONTH_ABBR.map((mn,i)=>{const m=i+1;const on=f.months.includes(m);return (
                    <button key={m} onClick={()=>{ if(f.freq==="once")setF({months:[m]}); else setF({months:on?f.months.filter(x=>x!==m):[...f.months,m]}); }}
                      style={{width:"calc(25% - 6px)",background:on?"#1a3a5a":"#0d1117",border:"1px solid "+(on?"#2a5a8a":"#2a3050"),borderRadius:8,color:on?"#8ec5ff":"#8892b0",fontSize:13,fontWeight:700,padding:"10px 0",cursor:"pointer"}}>{mn}</button>
                  );})}
                </div>

                {f.freq==="once"&&(<>
                  <div style={{...hdr,marginBottom:6}}>Year</div>
                  <input value={f.year||""} onChange={e=>setF({year:parseInt(e.target.value.replace(/[^0-9]/g,""))||""})} inputMode="numeric" placeholder={String(schedNowYear)}
                    style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:15,fontWeight:600,padding:"12px 14px",marginBottom:16}}/>
                </>)}

                <button onClick={saveSchedBill} disabled={!valid}
                  style={{width:"100%",background:valid?"#1a3a5a":"#161b28",border:"1px solid "+(valid?"#2a5a8a":"#222a3d"),borderRadius:10,color:valid?"#8ec5ff":"#3a4360",fontSize:15,fontWeight:700,padding:"15px",cursor:valid?"pointer":"default",marginTop:f.freq==="once"?0:2,marginBottom:editing?8:6}}>
                  {editing?"Save changes":"Add scheduled bill"}
                </button>
                {editing&&<button onClick={()=>delSchedBill(f.id)} style={{width:"100%",background:"#2a1a1a",border:"1px solid #5a2a2a",borderRadius:10,color:"#ff6b8a",fontSize:13,fontWeight:600,padding:"12px",cursor:"pointer",marginBottom:6}}>Remove</button>}
                <button onClick={()=>setSchedForm(null)} style={{width:"100%",background:"transparent",border:"none",color:"#8892b0",fontSize:13,fontWeight:600,padding:"8px",cursor:"pointer"}}>Cancel</button>
              </div>
            </div>
          );
        }
        const row=(b)=>(
          <div key={b.id} onClick={()=>{haptic();setSchedForm({id:b.id,name:b.name,total:b.total!=null?String(b.total):"",isCarGlyn:!!b.is_car_glyn,scope:b.scope,freq:b.freq,months:Array.isArray(b.months)?b.months:[],year:b.year||schedNowYear});}}
            style={{...card,marginBottom:8,display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:14,fontWeight:600,color:"#e8eaf0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.name} <span style={{fontSize:10,color:"#5a6480",fontWeight:700}}>· {tag(b)}</span></div>
              <div style={{fontSize:11,color:"#5a6480",marginTop:2}}>{schedWhenLabel(b)}</div>
            </div>
            <div style={{fontSize:14,fontWeight:700,color:"#c8cee0",whiteSpace:"nowrap"}}>{fmt(b.total)}</div>
            <span style={{color:"#3a4460",fontSize:14}}>›</span>
          </div>
        );
        const active=mine.filter(b=>schedActive(b));
        const past=mine.filter(b=>isPast(b));
        const upcoming=mine.filter(b=>!schedActive(b)&&!isPast(b));
        return (
          <div onClick={()=>setSchedOpen(false)} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:210,background:"rgba(0,0,0,0.6)"}}>
            <div onClick={e=>e.stopPropagation()} style={sheet}>
              {grab}
              <div style={{fontSize:14,color:"#e8eaf0",fontWeight:800,marginBottom:4}}>Scheduled bills</div>
              <div style={{fontSize:11,color:"#5a6480",marginBottom:12}}>Bills that appear in Budget only during the month(s) they're due.</div>
              <button onClick={()=>setSchedForm({id:null,name:"",total:"",isCarGlyn:false,scope:budTab==="glyn"?"personal":"shared",freq:"annual",months:[],year:schedNowYear})}
                style={{width:"100%",background:"#1a3a5a",border:"1px solid #2a5a8a",borderRadius:10,color:"#8ec5ff",fontSize:15,fontWeight:700,padding:"13px",cursor:"pointer",marginBottom:14}}>
                ＋ Add scheduled bill
              </button>
              {mine.length===0&&<div style={{...card,fontSize:13,color:"#5a6480",textAlign:"center",padding:"18px 12px"}}>None yet. Add one above — e.g. car tax every June, or a one-off for this month.</div>}
              {active.length>0&&<><div style={{...hdr,color:"#8ec5ff",marginBottom:6}}>📅 Due this month</div>{active.map(row)}</>}
              {upcoming.length>0&&<><div style={{...hdr,marginTop:6,marginBottom:6}}>Upcoming</div>{upcoming.map(row)}</>}
              {past.length>0&&<><div style={{...hdr,marginTop:6,marginBottom:6}}>Past one-offs</div>{past.map(row)}</>}
              <button onClick={()=>setSchedOpen(false)} style={{width:"100%",background:"transparent",border:"none",color:"#8892b0",fontSize:13,fontWeight:600,padding:"12px 8px 4px",cursor:"pointer"}}>Close</button>
            </div>
          </div>
        );
      })()}

      {giftOpen&&(()=>{
        const editing=!!giftForm.id;
        const set=(patch)=>setGiftForm(f=>({...f,...patch}));
        const valid=giftForm.name.trim().length>0;
        return (
          <div onClick={()=>setGiftOpen(false)} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:210,background:"rgba(0,0,0,0.6)"}}>
            <div onClick={e=>e.stopPropagation()} style={{position:"absolute",left:0,right:0,bottom:0,background:"#141824",borderTop:"1px solid #2a3050",borderRadius:"16px 16px 0 0",padding:"8px 14px",paddingBottom:"calc(16px + env(safe-area-inset-bottom))",maxHeight:"90vh",overflowY:"auto"}}>
              <div style={{width:40,height:4,background:"#2a3050",borderRadius:2,margin:"6px auto 12px"}}/>
              <div style={{fontSize:14,color:"#e8eaf0",fontWeight:800,marginBottom:12}}>{editing?"Edit person":"Add person"}</div>

              <div style={{...hdr,marginBottom:6}}>Name</div>
              <input value={giftForm.name} onChange={e=>set({name:e.target.value})} placeholder="e.g. Mum"
                style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:15,fontWeight:600,padding:"12px 14px",marginBottom:14}}/>

              <div style={{...hdr,marginBottom:6}}>Date of birth</div>
              <input type="date" value={giftForm.dob} onChange={e=>set({dob:e.target.value})}
                style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:15,padding:"12px 14px",marginBottom:14}}/>

              <div style={{...hdr,marginBottom:6}}>Notes</div>
              <textarea value={giftForm.notes} onChange={e=>set({notes:e.target.value})} placeholder="Gift ideas, sizes, etc." rows={2}
                style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:15,padding:"12px 14px",marginBottom:14,resize:"vertical",fontFamily:"inherit"}}/>

              <div style={{...hdr,marginBottom:6}}>Cost (£)</div>
              <input value={giftForm.cost} onChange={e=>set({cost:e.target.value.replace(/[^0-9.]/g,"")})} inputMode="decimal" placeholder="0.00"
                style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:15,fontWeight:600,padding:"12px 14px",marginBottom:16}}/>

              <button onClick={saveGift} disabled={!valid}
                style={{width:"100%",background:valid?"#1a3a5a":"#161b28",border:"1px solid "+(valid?"#2a5a8a":"#222a3d"),borderRadius:10,color:valid?"#8ec5ff":"#3a4360",fontSize:15,fontWeight:700,padding:"15px",cursor:valid?"pointer":"default",marginBottom:editing?8:6}}>
                {editing?"Save changes":"Add person"}
              </button>
              {editing&&<button onClick={()=>delGift(giftForm.id)} style={{width:"100%",background:"#2a1a1a",border:"1px solid #5a2a2a",borderRadius:10,color:"#ff6b8a",fontSize:13,fontWeight:600,padding:"12px",cursor:"pointer",marginBottom:6}}>Remove person</button>}
              <button onClick={()=>setGiftOpen(false)} style={{width:"100%",background:"transparent",border:"none",color:"#8892b0",fontSize:13,fontWeight:600,padding:"8px",cursor:"pointer"}}>Cancel</button>
            </div>
          </div>
        );
      })()}

      {settleOpen&&(()=>{
        const themName=isOwner?"Hollie":"Glyn";
        const isCharge=settleForm.kind==="charge";
        const set=(patch)=>setSettleForm(f=>({...f,...patch}));
        const valid=parseFloat(settleForm.amount)>0;
        const seg=(active)=>({flex:1,background:active?"#1a3a5a":"transparent",border:active?"1px solid #2a5a8a":"1px solid #2a3050",borderRadius:8,color:active?"#8ec5ff":"#8892b0",fontSize:13,fontWeight:700,padding:"11px",cursor:"pointer"});
        return (
          <div onClick={()=>setSettleOpen(false)} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:210,background:"rgba(0,0,0,0.6)"}}>
            <div onClick={e=>e.stopPropagation()} style={{position:"absolute",left:0,right:0,bottom:0,background:"#141824",borderTop:"1px solid #2a3050",borderRadius:"16px 16px 0 0",padding:"8px 14px",paddingBottom:"calc(16px + env(safe-area-inset-bottom))",maxHeight:"88vh",overflowY:"auto"}}>
              <div style={{width:40,height:4,background:"#2a3050",borderRadius:2,margin:"6px auto 12px"}}/>
              <div style={{fontSize:14,color:"#e8eaf0",fontWeight:800,marginBottom:12}}>Add entry</div>

              <div style={{display:"flex",gap:8,marginBottom:14}}>
                <button onClick={()=>set({kind:"charge"})} style={seg(isCharge)}>Covered a cost</button>
                <button onClick={()=>set({kind:"repayment"})} style={seg(!isCharge)}>Repayment</button>
              </div>

              <div style={{...hdr,marginBottom:6}}>{isCharge?"Who paid?":"Who paid who back?"}</div>
              <div style={{display:"flex",gap:8,marginBottom:14}}>
                <button onClick={()=>set({mine:true})} style={seg(settleForm.mine)}>{isCharge?"I covered it":`I paid ${themName}`}</button>
                <button onClick={()=>set({mine:false})} style={seg(!settleForm.mine)}>{isCharge?`${themName} covered it`:`${themName} paid me`}</button>
              </div>

              <div style={{...hdr,marginBottom:6}}>{isCharge?(settleForm.mine?`${themName}'s share`:"My share"):"Amount"}</div>
              <div style={{display:"flex",gap:8,marginBottom:isCharge?6:14}}>
                <input value={settleForm.amount} onChange={e=>set({amount:e.target.value.replace(/[^0-9.]/g,"")})} inputMode="decimal" placeholder="0.00"
                  style={{flex:1,boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:17,fontWeight:700,padding:"12px 14px"}}/>
                <button onClick={()=>{const v=parseFloat(settleForm.amount);if(!isNaN(v))set({amount:(Math.round(v*50)/100).toString()});}}
                  style={{background:"#1a2535",border:"1px solid #2a3050",borderRadius:8,color:"#8ec5ff",fontSize:15,fontWeight:700,padding:"0 18px",cursor:"pointer"}}>½</button>
              </div>
              {isCharge&&<div style={{fontSize:11,color:"#5a6480",marginBottom:14}}>Enter the other person’s share. Tap ½ to halve a total.</div>}

              {isCharge&&(<>
                <div style={{...hdr,marginBottom:6}}>What for? (optional)</div>
                <input value={settleForm.note} onChange={e=>set({note:e.target.value})} placeholder="e.g. Council tax"
                  style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:15,padding:"12px 14px",marginBottom:14}}/>
              </>)}

              <div style={{...hdr,marginBottom:6}}>Date</div>
              <input type="date" value={settleForm.date} onChange={e=>set({date:e.target.value})}
                style={{width:"100%",boxSizing:"border-box",background:"#0d1117",border:"1px solid #2a3050",borderRadius:8,color:"#e8eaf0",fontSize:15,padding:"12px 14px",marginBottom:16}}/>

              <button onClick={addSettlement} disabled={!valid}
                style={{width:"100%",background:valid?"#1a3a5a":"#161b28",border:"1px solid "+(valid?"#2a5a8a":"#222a3d"),borderRadius:10,color:valid?"#8ec5ff":"#3a4360",fontSize:15,fontWeight:700,padding:"15px",cursor:valid?"pointer":"default",marginBottom:6}}>
                Save
              </button>
              <button onClick={()=>setSettleOpen(false)} style={{width:"100%",background:"transparent",border:"none",color:"#8892b0",fontSize:13,fontWeight:600,padding:"8px",cursor:"pointer"}}>Cancel</button>
            </div>
          </div>
        );
      })()}

    </div>
    </ErrorBoundary>
  );
}
