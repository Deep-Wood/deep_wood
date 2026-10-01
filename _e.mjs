
import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless:'new', args:['--no-sandbox','--disable-setuid-sandbox','--use-gl=swiftshader','--enable-webgl']});
const run = async (doResize) => {
  const p = await b.newPage();
  await p.setViewport({width:1280,height:800});
  const errs=[];
  p.on('pageerror', e=>errs.push(e.message.slice(0,70)+' || '+(String(e.stack||'').split('\n')[1]||'').trim().slice(0,90)));
  await p.goto('http://localhost:5173/', {waitUntil:'domcontentloaded', timeout:45000});
  await p.waitForSelector('#game canvas',{timeout:25000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,5000));
  const before = errs.length;
  if (doResize) {
    await p.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    await new Promise(r=>setTimeout(r,6000));
  }
  await p.close();
  return {doResize, errsBefore: before, errsAfter: errs.length, errs: errs.slice(0,2)};
};
console.log(JSON.stringify([await run(false), await run(true)], null, 1));
await b.close();
