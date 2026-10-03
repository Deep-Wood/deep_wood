import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless:"new", args:["--no-sandbox","--disable-setuid-sandbox","--use-gl=swiftshader","--enable-webgl"] });
const pg = await b.newPage(); await pg.setViewport({ width:1280, height:800 });
const errs=[]; pg.on("pageerror", e=>errs.push(e.message));
await pg.goto("http://127.0.0.1:5173/", { waitUntil:"domcontentloaded", timeout:45000 });
await new Promise(r=>setTimeout(r,9000));
const r = await pg.evaluate(async () => {
  const s = window.__scene;
  const msg = () => document.getElementById("belt-msg").textContent;
  const btn = document.getElementById("belt-claim");
  const out=[];
  out.push({ stage:"boot", label: btn?btn.textContent:"NO BUTTON", disabled: btn?btn.disabled:null,
             common: s.belt.common, msg: msg(),
             claimBtnUndefined: s.claimBtn === undefined });
  // give enough Common to make it affordable, then click the real card
  s.belt.common = 5000; s.syncBeltDom();
  await new Promise(r=>setTimeout(r,200));
  const b2 = document.getElementById("belt-claim");
  out.push({ stage:"funded", label:b2.textContent, disabled:b2.disabled,
             hasOnclick: typeof b2.onclick === "function" });
  b2.click();
  await new Promise(r=>setTimeout(r,900));
  out.push({ stage:"afterClick", msg: msg(), common: s.belt.common,
             tools: s.belt.tools.map(t=>t.tier), busy: s.busy });
  return out;
});
console.log(JSON.stringify(r,null,1));
console.log("ERRORS", JSON.stringify(errs.slice(0,3)));
await b.close();