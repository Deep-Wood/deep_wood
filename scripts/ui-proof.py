import json, urllib.request, time
from Crypto.Hash import keccak
URL="https://rpc.testnet.chain.robinhood.com"
V7='0x6bb69514fa74957bf3f8492c52f29cd4ea22d4ce'
V3='0xed5851671fe003f5f8c21cccd49cd7c18a45324e'  # old live contract (V3-era)
ADDR='d1bd8e3d34b5f8ed38a56aa804a45b15a3fe848d'
pad=ADDR.rjust(64,'0')
def sel(sig):
    k=keccak.new(digest_bits=256); k.update(sig.encode()); return k.hexdigest()[:8]
def top(sig):
    k=keccak.new(digest_bits=256); k.update(sig.encode()); return k.hexdigest()
def call(to,sig,arg=None):
    time.sleep(1.5)
    data='0x'+sel(sig)+(arg or '')
    body=json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":to,"data":data},"latest"]}).encode()
    for attempt in range(8):
        try:
            req=urllib.request.Request(URL,data=body,headers={"Content-Type":"application/json","User-Agent":"curl/8.0"})
            r=json.loads(urllib.request.urlopen(req,timeout=20).read())
            if 'error' in r: return {'err': str(r['error'])[:100]}
            res=r['result'][2:]
            return [int(res[i:i+64],16) for i in range(0,len(res),64)]
        except Exception as e:
            if attempt==7: return {'err': str(e)[:100]}
            time.sleep(8)
def logs(address, topics, lo, hi):
    body=json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"address":address,"topics":topics,"fromBlock":hex(lo),"toBlock":hex(hi)}]}).encode()
    req=urllib.request.Request(URL,data=body,headers={"Content-Type":"application/json","User-Agent":"curl/8.0"})
    r=json.loads(urllib.request.urlopen(req,timeout=20).read())
    if 'error' in r: raise RuntimeError(str(r['error'])[:100])
    return r['result']
DEPLOY=136752430
print('=== V7 gemsOf(trader2, 0..4) ===', flush=True)
for i in range(5):
    print(f'  rarity {i}:', call(V7,'gemsOf(address,uint8)',pad+f'{i:064x}'), flush=True)
    time.sleep(2)
print('=== V7 playerStats (earned, tokenSpent, burned, bestWei, leq, hunts) ===', flush=True)
print(' ', call(V7,'playerStats(address)',pad), flush=True)
time.sleep(2)
print('=== V7 huntIndexOf / toolOf ===', flush=True)
print('  huntIndexOf:', call(V7,'huntIndexOf(address)',pad), flush=True)
time.sleep(2)
print('  toolOf:', call(V7,'toolOf(address)',pad), flush=True)
time.sleep(2)
print('=== V3 gemsOf(trader2, 0) for comparison ===', flush=True)
print(' ', call(V3,'gemsOf(address,uint8)',pad+'0'*64), flush=True)
print('=== V7 early-block scan: all events w/ trader2 (deploy..+100k) ===', flush=True)
found=0
for lo in range(DEPLOY, DEPLOY+100000, 8000):
    hi=min(lo+7999, DEPLOY+100000)
    for attempt in range(6):
        try:
            ls=logs(V7,[None,'0x'+pad],lo,hi)
            for l in ls:
                found+=1
                d=l['data'][2:]
                words=[int(d[i:i+64],16) if len(d)>=i+64 else None for i in range(0,min(len(d),256),64)]
                print(f"  blk {int(l['blockNumber'],16)} topic0={l['topics'][0][:16]} words={words} tx={l['transactionHash']}", flush=True)
            break
        except Exception as e:
            if attempt==5: print(f'  range {lo}: ERR {str(e)[:60]}', flush=True)
            time.sleep(6)
print('early events:', found, flush=True)
