import json, urllib.request, time
from Crypto.Hash import keccak
def topic(sig):
    k=keccak.new(digest_bits=256); k.update(sig.encode()); return '0x'+k.hexdigest()
t=topic('BatchSettled(address,uint16,uint256)')
URL="https://rpc.testnet.chain.robinhood.com"
V7='0x6bb69514fa74957bf3f8492c52f29cd4ea22d4ce'
pad='0x'+'d1bd8e3d34b5f8ed38a56aa804a45b15a3fe848d'.rjust(64,'0')
def rpc(method, params):
    body=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    req=urllib.request.Request(URL,data=body,headers={"Content-Type":"application/json","User-Agent":"curl/8.0"})
    r=json.loads(urllib.request.urlopen(req,timeout=20).read())
    if 'error' in r: raise RuntimeError(str(r['error'])[:120])
    return r['result']
lb=int(rpc('eth_blockNumber',[]),16)
print('latest', lb, flush=True)
t0=time.time(); found=0
for lo in range(lb-300000, lb, 8000):
    if time.time()-t0 > 500: print('budget hit at', lo, flush=True); break
    hi=min(lo+7999, lb)
    for attempt in range(8):
        try:
            logs=rpc('eth_getLogs',[{"address":V7,"topics":[t,pad],"fromBlock":hex(lo),"toBlock":hex(hi)}])
            for l in logs:
                found+=1
                d=l['data'][2:]
                n=int(d[0:64],16); total=int(d[64:128],16)
                print(f"  blk {int(l['blockNumber'],16)}: batch n={n} totalGems={total} tx={l['transactionHash']}", flush=True)
            break
        except Exception as e:
            if attempt==7: print(f"  range {lo}: ERR {str(e)[:40]}", flush=True)
            time.sleep(7)
print('BatchSettled found:', found, flush=True)
