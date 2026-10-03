import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless:"new", args:["--no-sandbox","--disable-setuid-sandbox","--use-gl=swiftshader","--enable-webgl"] });
const pg = await b.newPage(); await pg.setViewport({ width:1280, height:800 });
await pg.goto("http://127.0.0.1:5173/", { waitUntil:"domcontentloaded", timeout:45000 });
await new Promise(r=>setTimeout(r,9000));
const r = await pg.evaluate(async () => {
  const s = window.__scene;
  s.belt.common = 5000;
  const mod = await import("/src/tools.js");
  const out=[];
  out.push({ common: s.belt.common, tools: s.belt.tools.map(t=>t.tier),
             ownsI: mod.ownsTier(s.belt,1), ownsII: mod.ownsTier(s.belt,2),
             canClaim: mod.canClaim(s.belt,2), cost: mod.toolCost(2) });
  s.syncBeltDom();
  await new Promise(r=>setTimeout(r,200));
  const btn=document.getElementById("belt-claim");
  out.push({ label: btn.textContent, disabled: btn.disabled });
  return out;
});
console.log(JSON.stringify(r,null,1));
await b.close();