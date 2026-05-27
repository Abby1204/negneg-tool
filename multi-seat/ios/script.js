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
    areas: ['004','005','009','010','011'],
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
    setBar(`🚫 AD 罰等`,'#8e44ad'); beepSoft();
    log(`🚫 Access Denied，暫停${C.adWait}s，間隔→${currentInterval}ms`);
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
          if(!captchaSeen){ captchaSeen=true; setBar('🧩 請手動解驗證','#e67e22'); beepSoft(); log('🧩 偵測到驗證，請手動完成'); }
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
                running=false; paused=false; setBar('🎉 進入下一頁！','#27ae60'); beepWin();
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

    let adHit=false; const allFound=[]; const batchCount={};
    await Promise.all(batch.map(async(blk)=>{
      try{ const s=await queryBlock(blk); batchCount[blk]=s.length; s.forEach(x=>allFound.push(x)); }
      catch(e){ if(e.message==='ACCESS_DENIED') adHit=true; batchCount[blk]=-1; }
    }));
    // 更新各區狀態並重繪
    for(const blk of batch){ stats[blk]=batchCount[blk]; }
    renderStats();
    if(adHit){ handleAD(); return; }

    if(allFound.length){
      if(FRONT_FIRST){ allFound.sort((a,b)=> a.rowNum!==b.rowNum ? a.rowNum-b.rowNum : Math.abs(a.seatNo-12)-Math.abs(b.seatNo-12)); }
      const best=allFound[0];
      setBar(`🎉 ${best.rowFull}${best.seatNo}`,'#27ae60'); beepAlert();
      log(`找到 ${allFound.length} 位！最佳 ${best.rowFull}${best.seatNo}號(區${best.block})`);
      attemptClick(best); // AUTO_CLICK 恆為 true
      return;
    }
    loopTimer=setTimeout(scanLoop,currentInterval);
  }

  // ── 下方可收合面板 ──────────────────────────────
  const stats={};            // block -> 空位數（-1 表示該區這輪 AD/錯誤）
  const logLines=[];         // 最近 log
  const startTime=Date.now();

  const wrap=document.createElement('div');
  wrap.style.cssText='position:fixed;bottom:8px;left:8px;right:8px;z-index:2147483647;'
    +'font-family:-apple-system,sans-serif;font-size:13px;color:#fff;'
    +'background:#1e1e2e;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);overflow:hidden';

  // 詳細區（可收合）：各區空位 + log
  const detail=document.createElement('div');
  detail.style.cssText='padding:10px 12px 4px;border-bottom:1px solid #313244';
  const gridLabel=document.createElement('div');
  gridLabel.style.cssText='color:#a6adc8;font-size:11px;margin-bottom:4px'; gridLabel.textContent='各區空位';
  const grid=document.createElement('div');
  grid.style.cssText='display:flex;flex-wrap:wrap;gap:4px;font-size:11px;font-family:monospace;margin-bottom:8px';
  const logLabel=document.createElement('div');
  logLabel.style.cssText='color:#a6adc8;font-size:11px;margin-bottom:4px'; logLabel.textContent='記錄';
  const logBox=document.createElement('div');
  logBox.style.cssText='background:#11111b;border-radius:6px;padding:6px;height:72px;overflow-y:auto;font-size:10px;font-family:monospace;line-height:1.5';
  detail.appendChild(gridLabel); detail.appendChild(grid); detail.appendChild(logLabel); detail.appendChild(logBox);

  // 主狀態列：展開鈕 + 狀態 + 計時 + 停止
  const main=document.createElement('div');
  main.style.cssText='display:flex;align-items:center;gap:8px;padding:10px 12px';
  const toggle=document.createElement('button');
  toggle.textContent='▾';
  toggle.style.cssText='width:28px;height:28px;background:#313244;color:#fff;border:none;border-radius:6px;font-size:14px';
  const barText=document.createElement('span');
  barText.style.cssText='flex:1;font-weight:600'; barText.textContent='待命';
  const timer=document.createElement('span');
  timer.style.cssText='font-family:monospace;font-size:12px;color:#a6adc8'; timer.textContent='00:00';
  const stopBtn=document.createElement('button');
  stopBtn.textContent='⏹';
  stopBtn.style.cssText='width:36px;height:28px;background:#313244;color:#f38ba8;border:1px solid #45475a;border-radius:6px;font-weight:700;font-size:15px';
  main.appendChild(toggle); main.appendChild(barText); main.appendChild(timer); main.appendChild(stopBtn);

  wrap.appendChild(detail); wrap.appendChild(main);
  document.body.appendChild(wrap);

  let expanded=true;
  toggle.onclick=()=>{ expanded=!expanded; detail.style.display=expanded?'block':'none'; toggle.textContent=expanded?'▾':'▴'; };

  // 依背景色亮度自動選對比文字色（亮底→黑字，深底→白字）
  function pickTextColor(bg){
    if(!bg||bg==='transparent') return '#fff';
    const m=bg.match(/^#?([0-9a-f]{6})$/i);
    if(!m) return '#fff';
    const n=parseInt(m[1],16);
    const r=(n>>16)&255, g=(n>>8)&255, b=n&255;
    // 相對亮度（YIQ）
    const yiq=(r*299+g*587+b*114)/1000;
    return yiq>115 ? '#1a1a1a' : '#fff';
  }
  function setBar(t,c){
    barText.textContent=t;
    const bg=c||'#1e1e2e';
    main.style.background=bg;
    const fg=pickTextColor(bg);
    barText.style.color=fg;
    timer.style.color = fg==='#fff' ? '#a6adc8' : '#333';  // 深字配深灰、白字配淺灰
    toggle.style.color=fg;
  }
  function renderStats(){
    grid.innerHTML='';
    for(const blk of blockList){
      const v=stats[blk];
      const has=v>0, ad=v===-1;
      const s=document.createElement('span');
      s.style.cssText='padding:2px 5px;border-radius:4px;background:'
        +(has?'#a6e3a1':ad?'#f38ba8':'#313244')+';color:'+(has?'#1e1e2e':ad?'#1e1e2e':'#6c7086');
      s.textContent=blk+':'+(v===undefined?'-':ad?'AD':v);
      grid.appendChild(s);
    }
  }
  function log(msg){
    const t=new Date().toLocaleTimeString('zh-TW',{hour12:false});
    logLines.unshift('['+t+'] '+msg);
    while(logLines.length>30) logLines.pop();
    logBox.innerHTML=logLines.map(l=>'<div>'+l.replace(/</g,'&lt;')+'</div>').join('');
  }
  setInterval(()=>{ const e=Math.floor((Date.now()-startTime)/1000);
    timer.textContent=String(Math.floor(e/60)).padStart(2,'0')+':'+String(e%60).padStart(2,'0'); },1000);

  // 找到票/搶到：響亮尖銳警報（高頻 + 重複，明顯）
  // 找到空位：三短音急促警報（中等緊迫）
  function beepAlert(){
    try{ const ctx=new(window.AudioContext||window.webkitAudioContext)();
      const burst=(t,f)=>{ const o=ctx.createOscillator(); const g=ctx.createGain();
        o.type='square'; o.frequency.setValueAtTime(f,ctx.currentTime+t);
        g.gain.setValueAtTime(0.5,ctx.currentTime+t);
        o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime+t); o.stop(ctx.currentTime+t+0.18); };
      burst(0,1400); burst(0.22,1400); burst(0.44,1600);
    }catch(e){}
  }
  // 進入下一頁（搶到了！）：上升音階 + 結尾長音，最緊迫
  function beepWin(){
    try{ const ctx=new(window.AudioContext||window.webkitAudioContext)();
      const burst=(t,f,dur)=>{ const o=ctx.createOscillator(); const g=ctx.createGain();
        o.type='square'; o.frequency.setValueAtTime(f,ctx.currentTime+t);
        g.gain.setValueAtTime(0.6,ctx.currentTime+t);
        o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime+t); o.stop(ctx.currentTime+t+dur); };
      // 上升音階 ── 四音越來越高，最後一音拉長
      burst(0,    1400, 0.14);
      burst(0.16, 1700, 0.14);
      burst(0.32, 2000, 0.14);
      burst(0.48, 2200, 0.45);   // 結尾長音
      // 重複一輪強化「搶到了」的勝利感
      burst(1.00, 2200, 0.18);
      burst(1.22, 2200, 0.40);
    }catch(e){}
  }
  // AD / CAPTCHA：溫柔低頻單音（不嚇人，僅提示）
  function beepSoft(){
    try{ const ctx=new(window.AudioContext||window.webkitAudioContext)();
      const o=ctx.createOscillator(); const g=ctx.createGain();
      o.type='sine'; o.frequency.setValueAtTime(440,ctx.currentTime);
      g.gain.setValueAtTime(0.0001,ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25,ctx.currentTime+0.05);
      g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.5);
      o.connect(g); g.connect(ctx.destination); o.start(); setTimeout(()=>o.stop(),550);
    }catch(e){}
  }

  // 攔截 1 分鐘提示
  const _a=window.alert;
  window.alert=(m)=>{ if(m&&(String(m).includes('1 minute')||String(m).includes('minute left')))return; _a(m); };

  // ── 停止 ──
  window.__negSeatStop=function(){
    running=false; paused=false; clearTimeout(loopTimer);
    setBar('⏸ 已停止','#313244'); log('已停止');
    setTimeout(()=>{ try{ wrap.remove(); }catch(e){} window.__negSeatRunning=false; },1500);
  };
  stopBtn.onclick=window.__negSeatStop;

  // ── 啟動 ──
  renderStats();
  if(!blockList.length){ setBar('⚠ 未設定區域','#f38ba8'); log('未設定區域，停止'); return; }
  params=detectParams();
  if(!params.GoodsCode||!params.SessionId){ setBar('⚠ 請在座位頁執行','#f38ba8'); log('⚠ 抓不到參數，請在座位選擇頁執行'); }
  else { log('參數OK Goods='+params.GoodsCode); }
  running=true; cursor=0; currentInterval=C.interval;
  setBar(`▶ 啟動 ${blockList.length}區`,'#27ae60');
  log(`啟動：${blockList.length}區，同時${C.concurrent}，間隔${C.interval}ms`);
  scanLoop();
})();
