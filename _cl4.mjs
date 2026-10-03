import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless:"new", args:["--no-sandbox","--disable-setuid-sandbox","--use-gl=swiftshader","--enable-webgl"] });
const pg = await b.newPage(); await pg.setViewport({ width:1280, height:800 });
const errs=[]; pg.on("pageerror", e=>errs.push(e.message));
await pg.goto("http://127.0.0.1:5173/", { waitUntil:"domcontentloaded", timeout:45000 });
await new Promise(r=>setTimeout(r,9000));
const r = await pg.evaluate(async () => {
  const s = window.__scene;
  const n = () => document.querySelectorAll("#belt-claim").length;
  const out=[{ stage:"boot", claims:n() }];
  // hammer it the way gameplay does: many belt refreshes
  for (let i=0;i<12;i++){ s.refreshBelt(); }
  await new Promise(r=>setTimeout(r,300));
  out.push({ stage:"after12Refreshes", claims:n() });
  // fund it and check the SINGLE visible card enables
  s.belt.common = 5000; s.refreshBelt();
  await new Promise(r=>setTimeout(r,250));
  const btn=document.getElementById("belt-claim");
  out.push({ stage:"funded", claims:n(), label:btn.textContent, disabled:btn.disabled });
  btn.click();
  await new Promise(r=>setTimeout(r,900));
  out.push({ stage:"afterClick", claims:n(), common:s.belt.common,
             tools:s.belt.tools.map(t=>t.tier),
             msg:document.getElementById("belt-msg").textContent,
             label:document.getElementById("belt-claim").textContent });
  return out;
});
console.log(JSON.stringify(r,null,1));
console.log("ERRORS", JSON.stringify(errs.slice(0,3)));
await b.close();