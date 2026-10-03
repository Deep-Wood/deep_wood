import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless:"new", args:["--no-sandbox","--disable-setuid-sandbox","--use-gl=swiftshader","--enable-webgl"] });
const pg = await b.newPage(); await pg.setViewport({ width:1280, height:800 });
await pg.goto("http://127.0.0.1:5173/", { waitUntil:"domcontentloaded", timeout:45000 });
await new Promise(r=>setTimeout(r,9000));
const r = await pg.evaluate(async () => {
  const s = window.__scene;
  const snap = (tag) => {
    const all=[...document.querySelectorAll("#belt-claim, #belt-shop button, #belt-tools .belt-tool")];
    return { tag,
      totalClaim: document.querySelectorAll("#belt-claim").length,
      toolRows: document.querySelectorAll("#belt-tools .belt-tool").length,
      shopButtons: document.querySelectorAll("#belt-shop button").length,
      firstDisabled: document.querySelector("#belt-claim")?.disabled,
      lastDisabled: [...document.querySelectorAll("#belt-claim")].pop()?.disabled,
    };
  };
  const out=[];
  out.push(snap("boot"));
  s.belt.common = 5000;
  s.syncBeltDom();
  await new Promise(r=>setTimeout(r,200));
  out.push(snap("afterSync1"));
  s.syncBeltDom(); s.syncBeltDom();
  await new Promise(r=>setTimeout(r,200));
  out.push(snap("afterSync3"));
  // click the LAST one (the live one)
  const all=[...document.querySelectorAll("#belt-claim")];
  all[all.length-1].click();
  await new Promise(r=>setTimeout(r,900));
  out.push({ stage:"afterClickLast", common:s.belt.common, tools:s.belt.tools.map(t=>t.tier),
             msg: document.getElementById("belt-msg").textContent });
  return out;
});
console.log(JSON.stringify(r,null,1));
await b.close();