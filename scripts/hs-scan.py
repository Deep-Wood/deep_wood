import json, urllib.request, time
from Crypto.Hash import keccak
def topic(sig):
    k=keccak.new(digest_bits=256); k.update(sig.encode()); return '0x'+k.hexdigest()
t=topic('HuntSettled(address,uint256,uint256,uint256)')
pad='0x'+'d1bd8e3d34b5f8ed38a56aa804a45b15a3fe848d'.rjust(64,'0')
V7='0x6bb69514fa74957bf3f8492c52f29cd4ea22d4ce'
def rpc(url, method, params):
    body=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    req=urllib.request.Request(url,data=body,headers={"Content-Type":"application/json","User-Agent":"curl/8.0"})
    r=json.loads(urllib.request.urlopen(req,timeout=20).read())
    if 'error' in r: raise RuntimeError(str(r['error'])[:150])
    return r['result']
URL="https://rpc.testnet.chain.robinhood.com"
lb=int(rpc(URL,'eth_blockNumber',[]),16)
print('latest', lb, flush=True)
hits=0
for lo in range(lb-240000, lb, 8000):
    hi=min(lo+2999, lb)
    for attempt in range(5):
        try:
            logs=rpc(URL,'eth_getLogs',[{"address":V7,"topics":[t,pad],"fromBlock":hex(lo),"toBlock":hex(hi)}])
            if logs:
                hits+=len(logs)
                for l in logs:
                    d=l['data'][2:]
                    print(f"  blk {int(l['blockNumber'],16)}: totalGems={int(d[0:64],16)} valueWei={int(d[64:128],16)}", flush=True)
            break
        except Exception as e:
            if attempt==2: print(f"range {lo}-{hi}: ERR {str(e)[:50]}", flush=True)
            time.sleep(9)
print('total HuntSettled found:', hits, flush=True)
