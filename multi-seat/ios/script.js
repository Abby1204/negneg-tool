(function(){
  // ════════════════════════════════════════════════
  //  NOL / Interpark 多區搶票工具 — iOS bookmarklet 版
  //  - 由 bookmarklet 載入，讀 window.NEGNEG_CONFIG 當參數
  //  - autoClick / frontFirst 固定為 true（此版專用於自動卡位）
  //  - 不顯示完整面板，僅極簡狀態列 + 停止鈕
  //  - 核心邏輯沿用桌機版：最前排優先、失敗退回換區、CAPTCHA 等待
  // ════════════════════════════════════════════════

  if(window.__negSeatRunning){
    // 已在跑：再次點書籤視為「停止」
    try{ window.__negSeatStop && window.__negSeatStop(); }catch(e){}
    return;
  }
  window.__negSeatRunning = true;

  // ── 參數：以 NEGNEG_CONFIG 覆蓋預設 ───────────────
  const C = Object.assign({
    concurrent: 2,        // 同時掃幾區（iOS 預設 2）
    interval: 4000,       // 每輪間隔 ms（iOS 預設 4000）
    areas: ['012','117','118','119','120','226','227','228','229','230','231','306','408','409','410','411','412'],
    adWait: 30,           // Access Denied 罰等秒
  }, (window.NEGNEG_CONFIG||{}));

  // 此版固定行為
  const AUTO_CLICK = true;
  const FRONT_FIRST = true;

  // areas 兩種格式都吃：陣列，或 "004,005" 字串
  let blockList = [];
  if(Array.isArray(C.areas)){
    blockList = C.areas.map(s=>String(s).trim()).filter(Boolean);
  }else{
    blockList = String(C.areas||'').replace(/[\[\]'"]/g,'').split(',').map(s=>s.trim()).filter(Boolean);
  }

  // ── 動態抓請求參數 ──────────────────────────────
  function detectParams(){
    const p = { GoodsCode:'',PlaceCode:'',LanguageType:'G2001',MemBizCode:'',
      PlaySeq:'001',SeatGrade:'',TmgsOrNot:'D2003',Tiki:'N',
      SessionId:'',BizCode:'',GoodsBizCode:'',GlobalSportsYN:'N' };
    const urls = [location.href];
    try{
      const f = document.getElementById('ifrmSeat');
      if(f){ urls.push(f.src); try{ urls.push(f.contentWindow.location.href); }catch(e){}
        try{ const f2=f.contentDocument.getElementById('ifrmSeatDetail');
          if(f2){ urls.push(f2.src); try{ urls.push(f2.contentWindow.location.href); }catch(e){} } }catch(e){}
      }
    }catch(e){}
    try{ urls.push(document.documentElement.innerHTML.slice(0,200000)); }catch(e){}
    const grab=(k)=>{ for(const u of urls){ if(!u)continue;
      const m=u.match(new RegExp(k+'=([^&"\'\\s]+)','i')); if(m&&m[1])return decodeURIComponent(m[1]); } return ''; };
    for(const k of Object.keys(p)){ const v=grab(k); if(v)p[k]=v; }
    return p;
  }

  function rowToNum(rowLabel){
    const m = rowLabel.match(/([A-Z])\uC5F4/);
    if(!m) return 999;
    let c = m[1].charCodeAt(0)-64;
    if(m[1]>'I') c-=1;
    return c;
  }
  function parseSeats(html, block){
    const seats=[]; const re=/SelectSeat\(this,'([^']*)','([^']*)','([^']*)','([^']*)','([^']*)'\)/g; let m;
    while((m=re.exec(html))){
      seats.push({ block:m[5]||block, rowFull:m[3], rowNum:rowToNum(m[3]),
        seatNo:parseInt(m[4],10)||999, grade:m[1] });
    }
    return seats;
  }

  // ── 狀態 ──
  let running=false, paused=false, params={}, cursor=0;
  let currentInterval=C.interval, loopTimer=null;
  const WHITEPAGE_TRIES=20, CAPTCHA_GRACE=100;

  async function queryBlock(block){
    const qp=new URLSearchParams({
      GoodsCode:params.GoodsCode, PlaceCode:params.PlaceCode,
      LanguageType:params.LanguageType||'G2001', MemBizCode:params.MemBizCode,
      PlaySeq:params.PlaySeq||'001', SeatGrade:params.SeatGrade||'', Block:block,
      TmgsOrNot:params.TmgsOrNot||'D2003', LocOfImage:'', Tiki:params.Tiki||'N',
      UILock:'Y', SessionId:params.SessionId, BizCode:params.BizCode,
      GoodsBizCode:params.GoodsBizCode, GlobalSportsYN:params.GlobalSportsYN||'N',
      SeatCheckCnt:'0', InterlockingGoods:'' });
    const res=await fetch('/Global/Play/Book/BookSeatDetail.asp?'+qp.toString(),{credentials:'include'});
    const html=await res.text();
    if(/Access Denied|Forbidden/i.test(html)) throw new Error('ACCESS_DENIED');
    return parseSeats(html, block);
  }

  function handleAD(){
    if(paused)return; paused=true; clearTimeout(loopTimer);
    currentInterval=Math.min(currentInterval+1000,12000);
    setBar(`🚫 AD 罰等`,'#8e44ad'); beep();
    let cd=C.adWait;
    const t=setInterval(()=>{ cd--; setBar(`🚫 AD ${cd}s`,'#8e44ad');
      if(cd<=0){ clearInterval(t); paused=false; if(running){ setBar('▶ 掃描中','#27ae60'); scanLoop(); } } },1000);
  }

  function resumeScan(reason){
    if(running){ setBar('▶ 掃描中','#27ae60'); loopTimer=setTimeout(scanLoop,600); }
  }

  function attemptClick(target){
    paused=true; clearTimeout(loopTimer);
    setBar('⏳ 卡位中','#f39c12');
    try{ document.getElementById('ifrmSeat').contentDocument.defaultView.fnBlockSeatUpdate('','',target.block); }
    catch(e){ paused=false; resumeScan(); return; }

    let tries=0, captchaSeen=false, captchaWaited=0;
    const ct=setInterval(()=>{
      tries++;
      try{
        const f=document.getElementById('ifrmSeat').contentDocument;
        const f2=f.getElementById('ifrmSeatDetail').contentDocument;
        const body=f2?.body?.innerText||'';
        if(/Access Denied|Forbidden/i.test(body)){ clearInterval(ct); handleAD(); return; }

        const isCaptcha=/captcha|보안|verif|로봇|robot|퍼즐|puzzle|slider|drag/i.test(body)
          || f2.querySelector('img[src*="captcha"],canvas,[class*="captcha"],[id*="captcha"]');
        if(isCaptcha){
          if(!captchaSeen){ captchaSeen=true; setBar('🧩 請手動解驗證','#e67e22'); beep(); }
          captchaWaited++;
          if(captchaWaited>CAPTCHA_GRACE){ clearInterval(ct); paused=false; resumeScan(); }
          return;
        }

        const spans=f2.querySelectorAll('span[onclick*="SelectSeat"]');
        let hit=null;
        for(const s of spans){ const oc=s.getAttribute('onclick')||'';
          if(oc.includes(`'${target.rowFull}'`)&&oc.includes(`'${target.seatNo}'`)){ hit=s; break; } }
        if(!hit&&spans.length) hit=spans[0];

        if(hit){
          clearInterval(ct); hit.click();
          setTimeout(()=>{ try{ f.defaultView.fnSelect(); }catch(e){}
            setTimeout(()=>{
              if(document.querySelector('div.buy_info')){
                running=false; paused=false; setBar('🎉 進入下一頁！','#27ae60'); beep();
              }else{ paused=false; resumeScan(); }
            },800);
          },300);
          return;
        }
        if(captchaSeen&&spans.length===0){
          if(tries>WHITEPAGE_TRIES+30){ clearInterval(ct); paused=false; resumeScan(); }
          return;
        }
        if(tries>WHITEPAGE_TRIES){ clearInterval(ct); paused=false; resumeScan(); }
      }catch(e){
        if(tries>WHITEPAGE_TRIES+10){ clearInterval(ct); paused=false; resumeScan(); }
      }
    },300);
  }

  async function scanLoop(){
    if(!running||paused)return;
    const batch=[];
    for(let i=0;i<C.concurrent&&i<blockList.length;i++) batch.push(blockList[(cursor+i)%blockList.length]);
    cursor=(cursor+C.concurrent)%blockList.length;
    setBar(`▶ ${batch.join(',')}`,'#27ae60');

    let adHit=false; const allFound=[];
    await Promise.all(batch.map(async(blk)=>{
      try{ const s=await queryBlock(blk); s.forEach(x=>allFound.push(x)); }
      catch(e){ if(e.message==='ACCESS_DENIED') adHit=true; }
    }));
    if(adHit){ handleAD(); return; }

    if(allFound.length){
      if(FRONT_FIRST){ allFound.sort((a,b)=> a.rowNum!==b.rowNum ? a.rowNum-b.rowNum : Math.abs(a.seatNo-12)-Math.abs(b.seatNo-12)); }
      const best=allFound[0];
      setBar(`🎉 ${best.rowFull}${best.seatNo}`,'#27ae60'); beep();
      attemptClick(best); // AUTO_CLICK 恆為 true
      return;
    }
    loopTimer=setTimeout(scanLoop,currentInterval);
  }

  // ── 極簡狀態列 ──────────────────────────────────
  const bar=document.createElement('div');
  bar.style.cssText='position:fixed;top:8px;left:8px;right:8px;z-index:2147483647;'
    +'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;'
    +'background:#1e1e2e;color:#fff;font-family:-apple-system,sans-serif;font-size:13px;'
    +'box-shadow:0 4px 16px rgba(0,0,0,.4)';
  const barText=document.createElement('span');
  barText.style.cssText='flex:1;font-weight:600'; barText.textContent='待命';
  const stopBtn=document.createElement('button');
  stopBtn.textContent='⏹'; 
  stopBtn.style.cssText='padding:4px 12px;background:#f38ba8;color:#1e1e2e;border:none;border-radius:6px;font-weight:700;font-size:14px';
  bar.appendChild(barText); bar.appendChild(stopBtn);
  document.body.appendChild(bar);
  function setBar(t,c){ barText.textContent=t; bar.style.background=c||'#1e1e2e'; }

  function beep(){
    try{ const ctx=new(window.AudioContext||window.webkitAudioContext)();
      const o=ctx.createOscillator(); o.type='square'; o.frequency.setValueAtTime(1200,ctx.currentTime);
      o.connect(ctx.destination); o.start(); setTimeout(()=>o.stop(),1000);
      // iOS 需使用者互動才解鎖音訊；點書籤算互動，這裡盡力而為
    }catch(e){}
  }

  // 攔截 1 分鐘提示
  const _a=window.alert;
  window.alert=(m)=>{ if(m&&(String(m).includes('1 minute')||String(m).includes('minute left')))return; _a(m); };

  // ── 停止 ──
  window.__negSeatStop=function(){
    running=false; paused=false; clearTimeout(loopTimer);
    setBar('⏸ 已停止','#313244');
    setTimeout(()=>{ try{ bar.remove(); }catch(e){} window.__negSeatRunning=false; },1500);
  };
  stopBtn.onclick=window.__negSeatStop;

  // ── 啟動 ──
  if(!blockList.length){ setBar('⚠ 未設定區域','#f38ba8'); return; }
  params=detectParams();
  if(!params.GoodsCode||!params.SessionId){ setBar('⚠ 請在座位頁執行','#f38ba8'); }
  running=true; cursor=0; currentInterval=C.interval;
  setBar(`▶ 啟動 ${blockList.length}區/同時${C.concurrent}`,'#27ae60');
  scanLoop();
})();
