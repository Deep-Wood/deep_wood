import json, urllib.request, time
URL="https://rpc.testnet.chain.robinhood.com"
V7='0x6bb69514fa74957bf3f8492c52f29cd4ea22d4ce'
from Crypto.Hash import keccak
def sel(sig):
    k=keccak.new(digest_bits=256); k.update(sig.encode()); return k.hexdigest()[:8]
def arg(n): return hex(n)[2:].rjust(64,'0')
def call(sig,args=''):
    data='0x'+sel(sig)+args
    body=json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":V7,"data":data},"latest"]}).encode()
    req=urllib.request.Request(URL,data=body,headers={"Content-Type":"application/json","User-Agent":"curl/8.0"})
    r=json.loads(urllib.request.urlopen(req,timeout=20).read())
    if 'error' in r: return 'ERR '+str(r['error'])[:80]
    return r['result'][2:]
pairs=[
  ('dropTableTiers(tier1, quartz)', ('dropTableTiers(uint256,uint256)', arg(0)+arg(0))),
  ('dropTableTiers(tier1, amber)', ('dropTableTiers(uint256,uint256)', arg(0)+arg(1))),
  ('dropTableTiers(tier1, sapphire)', ('dropTableTiers(uint256,uint256)', arg(0)+arg(2))),
  ('skillCostTable(level0->1)', ('skillCostTable(uint256)', arg(0))),
  ('repairCostTable(t1, quartz)', ('repairCostTable(uint256,uint256)', arg(0)+arg(0))),
]
time.sleep(5)
for name,(sig,a) in pairs:
    for attempt in range(6):
        try:
            res=call(sig,a)
            print(name, 'ERR '+res if res.startswith('ERR') else int(res,16), flush=True)
            break
        except Exception as e:
            if attempt==5: print(name, 'HTTP FAIL', str(e)[:60], flush=True)
            time.sleep(8)
    time.sleep(2)
print('DONE', flush=True)
