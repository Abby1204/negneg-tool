(function(){
  // ════════════════════════════════════════════════
  //  NOL / Interpark 多區平行搶票工具
  //  - 多區同時掃描（並發打 BookSeatDetail.asp）
  //  - 找到空位：最前排優先，自動點擊卡位
  //  - 自適應退避防 Access Denied
  //  - 設定記憶（localStorage）
  // ════════════════════════════════════════════════

  if(window.__mbScannerRunning){ alert('工具已經在執行中，請先停止舊的。'); return; }
  window.__mbScannerRunning = true;

  // ── 預設參數 ──────────────────────────────────
  const DEFAULTS = {
    areas: '004,005,009,010,011,023,024,028,029,042,045,050,051,063,064,068,069,313',
    concurrent: 3,        // 同時掃幾區
    interval: 3500,       // 每一輪之間等待 (ms)
    adWait: 30,           // Access Denied 罰等秒數
    autoClick: true,      // 找到自動點擊
    frontFirst: true,     // 最前排優先
  };

  // ── 每次都用 code 預設，不讀舊記憶 ──────────────
  let cfg = Object.assign({}, DEFAULTS);
  // 順手清掉舊版可能殘留的記憶，避免下次又被讀到
  try{ localStorage.removeItem('mbScannerCfg'); }catch(e){}

  const saveCfg = ()=>{ /* 已停用記憶：刻意不儲存 */ };

  // ── 從目前頁面動態抓出請求所需參數 ──────────────
  // BookSeatDetail.asp 需要的 query 參數，盡量從現有頁面 URL / iframe 推斷
  function detectParams(){
    const p = {
      GoodsCode:'', PlaceCode:'', LanguageType:'G2001', MemBizCode:'',
      PlaySeq:'001', SeatGrade:'', TmgsOrNot:'D2003', Tiki:'N',
      SessionId:'', BizCode:'', GoodsBizCode:'', GlobalSportsYN:'N',
    };
    // 嘗試從所有 iframe 的 location / src 收集
    const urls = [location.href];
    try{
      const f = document.getElementById('ifrmSeat');
      if(f){ urls.push(f.src); try{ urls.push(f.contentWindow.location.href); }catch(e){} 
        try{
          const f2 = f.contentDocument.getElementById('ifrmSeatDetail');
          if(f2){ urls.push(f2.src); try{ urls.push(f2.contentWindow.location.href); }catch(e){} }
        }catch(e){}
      }
    }catch(e){}
    // 也掃整頁原始碼裡可能出現的 SessionId
    try{ urls.push(document.documentElement.innerHTML.slice(0,200000)); }catch(e){}

    const grab = (key)=>{
      for(const u of urls){
        if(!u) continue;
        const m = u.match(new RegExp(key+'=([^&"\'\\s]+)', 'i'));
        if(m && m[1]) return decodeURIComponent(m[1]);
      }
      return '';
    };
    for(const k of Object.keys(p)){
      const v = grab(k);
      if(v) p[k] = v;
    }
    return p;
  }

  // ── 排號 → 數字（用於最前排排序）──
  // 兩種格式都吃：
  //   1. 純數字열 "S10구역 14열" → 14   ← 正式場（票券 Row 18 / 釜山 BTS）
  //   2. 字母열   "313구역 G열"  → 7    ← 舊測試場（韓文場館慣例略過 I）
  // 座位 title 形如 "[지정석] -S10구역 14열-5"
  // onclick 形如 SelectSeat(this,'1','','S10구역 14열','5','410')
  function rowToNum(rowLabel){
    // 先試純數字열
    const n = rowLabel.match(/(\d+)\uC5F4/);
    if(n) return parseInt(n[1],10);
    // 退而求其次：字母열
    const a = rowLabel.match(/([A-Z])\uC5F4/);
    if(a){
      let c = a[1].charCodeAt(0) - 64; // A=1
      if(a[1] > 'I') c -= 1;           // 場館常略過 I 排
      return c;
    }
    return 999;
  }

  // ── 解析一段 BookSeatDetail 回傳 HTML，回傳可選座位陣列 ──
  function parseSeats(html, block){
    const seats = [];
    // 比對所有 SelectSeat(...) 呼叫
    const re = /SelectSeat\(this,'([^']*)','([^']*)','([^']*)','([^']*)','([^']*)'\)/g;
    let m;
    while((m = re.exec(html))){
      const grade = m[1];
      const rowFull = m[3]; // 例 "313구역 G열"
      const seatNo = m[4];  // 例 "5"
      const blk = m[5] || block;
      seats.push({
        block: blk,
        rowFull,
        rowNum: rowToNum(rowFull),
        seatNo: parseInt(seatNo,10)||999,
        grade,
        raw: m[0],
      });
    }
    return seats;
  }

  // ── 狀態 ──────────────────────────────────────
  let running = false;
  let paused = false;
  let params = {};
  let blockList = [];
  let cursor = 0;            // 輪掃指標
  let currentInterval = cfg.interval;
  let loopTimer = null;
  const startTime = Date.now();
  const stats = {}; // block -> {avail, total, lastSeats}

  // ── 發出單一區塊查詢 ──────────────────────────
  async function queryBlock(block){
    const qp = new URLSearchParams({
      GoodsCode: params.GoodsCode,
      PlaceCode: params.PlaceCode,
      LanguageType: params.LanguageType||'G2001',
      MemBizCode: params.MemBizCode,
      PlaySeq: params.PlaySeq||'001',
      SeatGrade: params.SeatGrade||'',
      Block: block,
      TmgsOrNot: params.TmgsOrNot||'D2003',
      LocOfImage:'',
      Tiki: params.Tiki||'N',
      UILock:'Y',
      SessionId: params.SessionId,
      BizCode: params.BizCode,
      GoodsBizCode: params.GoodsBizCode,
      GlobalSportsYN: params.GlobalSportsYN||'N',
      SeatCheckCnt:'0',
      InterlockingGoods:'',
    });
    const url = '/Global/Play/Book/BookSeatDetail.asp?'+qp.toString();
    // 加 8 秒 timeout，網路慢直接視為 NETERR（不算可疑）
    const ctl = new AbortController();
    const tm = setTimeout(()=>ctl.abort(), 8000);
    let html;
    try{
      const res = await fetch(url, { credentials:'include', signal:ctl.signal });
      html = await res.text();
    }catch(e){
      clearTimeout(tm);
      throw new Error('NETERR');
    }
    clearTimeout(tm);
    if(/Access Denied|Forbidden/i.test(html)) throw new Error('ACCESS_DENIED');
    // 收緊：不到 2000 字 + 沒任何 Seat 標籤才算 SUSPICIOUS（排除網路抖動雜訊）
    if(html.length < 2000 && !/class=['"]?Seat[RNB]['"]?/i.test(html)) throw new Error('SUSPICIOUS');
    return parseSeats(html, block);
  }

  // ── Access Denied 處理：全體暫停、罰等、間隔拉長 ──
  function handleAD(){
    if(paused) return;
    paused = true;
    clearTimeout(loopTimer);
    currentInterval = Math.min(currentInterval + 1000, 12000); // 主動退避
    log(`🚫 Access Denied！暫停 ${cfg.adWait}s，間隔調為 ${currentInterval}ms`, 'ad');
    let cd = cfg.adWait;
    setStatus(`🚫 AD 罰等 ${cd}s`, '#8e44ad');
    const t = setInterval(()=>{
      cd--;
      setStatus(`🚫 AD 罰等 ${cd}s`, '#8e44ad');
      if(cd<=0){
        clearInterval(t);
        paused = false;
        if(running){ setStatus('▶ 掃描中', '#27ae60'); scanLoop(); }
      }
    },1000);
  }

  // ── 找到空位：依設定點擊最前排 ──────────────────
  function onSeatsFound(allFound){
    // allFound: 跨區的可選座位，已合併
    // 排序：最前排優先 → 同排靠中間
    if(cfg.frontFirst){
      // 估算各區每排中心，用於「靠中間」次要排序（這裡簡化為座號接近中位）
      allFound.sort((a,b)=>{
        if(a.rowNum !== b.rowNum) return a.rowNum - b.rowNum;
        return Math.abs(a.seatNo-12) - Math.abs(b.seatNo-12);
      });
    }
    const best = allFound[0];
    playAlert();
    log(`🎉 找到 ${allFound.length} 個空位！最佳：${best.rowFull} ${best.seatNo}號 (區${best.block})`, 'hit');
    notify(`找到座位！${best.rowFull} ${best.seatNo}號`, `區 ${best.block}，共 ${allFound.length} 個空位`);
    renderSeatList(allFound, best);

    if(cfg.autoClick){
      attemptClick(best);
    }else{
      // 手動模式：響鈴通知後繼續掃，萬一沒及時點、位子被搶走還能繼續找
      log('手動模式：請自己點選上方標 ⭐ 的座位；工具持續掃描中', 'info');
      loopTimer = setTimeout(scanLoop, currentInterval);
    }
  }

  // ── 嘗試在真實 iframe 裡點擊指定座位 ──────────────
  // 並發 fetch 只能「發現」座位；要真正卡位仍須操作頁面的 iframe。
  // 流程：先用 fnBlockSeatUpdate 把畫面切到該區，等座位圖出來後點對應 onclick。
  // 重點：若白屏/逾時/CAPTCHA 後沒成功，不停止 → 自動恢復掃描繼續換區（比照原腳本）。
  const WHITEPAGE_TRIES = 20;   // 約 6 秒（300ms x 20）；夠你手解 CAPTCHA
  const CAPTCHA_GRACE   = 100;  // 偵測到疑似驗證頁時，最多再多等這麼多輪（給你手解時間）

  function resumeScan(reason){
    log(`${reason} → 繼續換區掃描`, 'info');
    if(running){ // 還在執行狀態才接回
      setStatus('▶ 掃描中', '#27ae60');
      // 從下一批區繼續，不要卡在同一區
      loopTimer = setTimeout(scanLoop, 600);
    }
  }

  function attemptClick(target){
    // 注意：這裡「不」把 running 設 false。我們要讓它失敗後能自己接回掃描。
    paused = true;            // 暫時擋住 scanLoop 重入，卡位流程結束後再放開
    clearTimeout(loopTimer);
    setStatus('⏳ 卡位中...', '#f39c12');
    log(`嘗試自動點擊：區${target.block} ${target.rowFull} ${target.seatNo}號`, 'info');

    try{
      const f = document.getElementById('ifrmSeat').contentDocument;
      f.defaultView.fnBlockSeatUpdate('','',target.block);
    }catch(e){
      log('切區失敗：'+e.message, 'ad');
      paused = false;
      resumeScan('切區失敗');
      return;
    }

    let tries = 0;
    let captchaSeen = false;
    let captchaWaited = 0;
    const clickTimer = setInterval(()=>{
      tries++;
      try{
        const f = document.getElementById('ifrmSeat').contentDocument;
        const f2 = f.getElementById('ifrmSeatDetail').contentDocument;
        const body = f2?.body?.innerText || '';

        if(/Access Denied|Forbidden/i.test(body)){
          clearInterval(clickTimer);
          handleAD();   // handleAD 結束後自己會接回掃描
          return;
        }

        // 偵測疑似 CAPTCHA / 驗證頁（拼圖、驗證、보안문자 之類關鍵字）
        const isCaptcha = /captcha|보안|verif|로봇|robot|퍼즐|puzzle|slider|drag/i.test(body)
                          || f2.querySelector('img[src*="captcha"], canvas, [class*="captcha"], [id*="captcha"]');
        if(isCaptcha){
          if(!captchaSeen){
            captchaSeen = true;
            log('偵測到驗證（拼圖）— 請手動完成，完成後我會自動繼續', 'ad');
            setStatus('🧩 請手動解驗證', '#e67e22');
            playAlert();
            notify('需要手動驗證', '請完成拼圖，工具會自動接手');
          }
          captchaWaited++;
          // 驗證期間耐心等，不計入逾時；超過寬限才放棄
          if(captchaWaited > CAPTCHA_GRACE){
            clearInterval(clickTimer);
            paused = false;
            resumeScan('驗證等待逾時');
          }
          return; // 還在驗證，先不做其他事
        }

        // 找到與 target 相符的座位
        const spans = f2.querySelectorAll('span[onclick*="SelectSeat"]');
        let hit = null;
        for(const s of spans){
          const oc = s.getAttribute('onclick') || '';
          if(oc.includes(`'${target.rowFull}'`) && oc.includes(`'${target.seatNo}'`)){ hit = s; break; }
        }
        // 找不到完全相符 → 退而求其次點該區任何座位（座位可能已被搶走）
        if(!hit && spans.length){ hit = spans[0]; }

        if(hit){
          clearInterval(clickTimer);
          hit.click();
          log('已點擊座位，嘗試送出選位...', 'hit');
          setTimeout(()=>{
            try{ f.defaultView.fnSelect(); }catch(e){}
            // 確認是否真的進到下一頁（價格/確認步驟）
            setTimeout(()=>{
              const done = document.querySelector('div.buy_info');
              if(done){
                running = false; paused = false;  // 真的成功了才整個停
                setStatus('🎉 已進入下一頁！', '#27ae60');
                notify('搶到了！', '已進入確認頁，快去完成');
                playAlert();
              }else{
                // 沒進下一頁（被搶走或又跳驗證）→ 繼續掃
                paused = false;
                resumeScan('未進下一頁（可能被搶走）');
              }
            }, 800);
          }, 300);
          return;
        }

        // 這一輪沒找到可點座位
        if(captchaSeen && spans.length===0){
          // 剛解完驗證但座位圖還沒回來，多給幾輪
          if(tries > WHITEPAGE_TRIES + 30){
            clearInterval(clickTimer);
            paused = false;
            resumeScan('驗證後座位圖未載入');
          }
          return;
        }

        if(tries > WHITEPAGE_TRIES){
          clearInterval(clickTimer);
          paused = false;
          resumeScan('白屏/座位圖載入逾時');
        }
      }catch(e){
        // iframe 還在重載入時讀取會丟錯，視為白屏，繼續等
        if(tries > WHITEPAGE_TRIES + 10){
          clearInterval(clickTimer);
          paused = false;
          resumeScan('iframe 讀取逾時');
        }
      }
    }, 300);
  }

  // ── 主掃描迴圈：每輪並發查 concurrent 個區 ─────────
  async function scanLoop(){
    if(!running || paused) return;
    // 取本輪要掃的區
    const batch = [];
    for(let i=0;i<cfg.concurrent && i<blockList.length;i++){
      batch.push(blockList[(cursor+i)%blockList.length]);
    }
    cursor = (cursor + cfg.concurrent) % blockList.length;

    setStatus(`▶ 掃描中：${batch.join(', ')}`, '#27ae60');

    let adHit = false; let suspiciousCnt = 0; const susBlocks = [];
    const results = await Promise.all(batch.map(async (blk)=>{
      try{
        const seats = await queryBlock(blk);
        stats[blk] = { avail: seats.length, seats, status: 'ok' };
        return { blk, seats };
      }catch(e){
        if(e.message==='ACCESS_DENIED'){
          adHit = true;
          stats[blk] = { avail: 0, seats: [], status: 'ad' };
        }else if(e.message==='SUSPICIOUS'){
          suspiciousCnt++; susBlocks.push(blk);
          stats[blk] = { avail: 0, seats: [], status: 'sus' };
        }else if(e.message==='NETERR'){
          // 網路抖動 / timeout：不計可疑，保持上一輪狀態
          if(!stats[blk]) stats[blk] = { avail: 0, seats: [], status: 'neterr' };
          // 已有先前狀態就不動
        }else{
          if(!stats[blk]) stats[blk] = { avail: 0, seats: [], status: 'neterr' };
        }
        return { blk, seats: [] };
      }
    }));

    renderStats();

    if(adHit){ handleAD(); return; }

    // SUSPICIOUS 分兩種處理（NETERR 完全不報）
    if(suspiciousCnt>0){
      const allSus = suspiciousCnt===batch.length;
      if(allSus){
        // 整批異常 — 多半是 CAPTCHA/失效。自動切到第一區觸發拼圖，等你按繼續才恢復
        const target = susBlocks[0];
        log(`⚠ 整批異常（${susBlocks.join(',')}）— 自動切到 ${target}，解完按「▶ 繼續」`, 'ad');
        setStatus(`🧩 解驗證 → 按 ▶ 繼續`, '#e67e22');
        playAlert();
        try{
          document.getElementById('ifrmSeat').contentDocument.defaultView.fnBlockSeatUpdate('','',target);
        }catch(e){ log('切區失敗：'+(e.message||e), 'ad'); }
        enterResumeMode();
        return;
      }
      // 單區異常 — 只在面板顯示橘色 ?，不寫 log，不打擾
    }

    // 合併所有找到的空位
    const allFound = [];
    for(const r of results){ for(const s of r.seats) allFound.push(s); }

    if(allFound.length){
      onSeatsFound(allFound);
      return; // 找到就停掃（交給卡位流程）
    }

    // 沒找到，排下一輪
    loopTimer = setTimeout(scanLoop, currentInterval);
  }

  // ════════════════════════════════════════════════
  //  UI
  // ════════════════════════════════════════════════
  const panel = document.createElement('div');
  panel.style.cssText = `position:fixed;top:20px;right:20px;z-index:2147483647;width:300px;
    background:#1e1e2e;color:#cdd6f4;border-radius:12px;padding:14px;
    font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;
    box-shadow:0 8px 32px rgba(0,0,0,0.5);border:1px solid #45475a;max-height:90vh;overflow-y:auto`;

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <strong style="font-size:14px;color:#cba6f7">🎫 多區搶票工具</strong>
      <span id="mbTimer" style="font-family:monospace;font-size:12px;color:#a6adc8">00:00</span>
    </div>
    <div id="mbStatus" style="padding:6px 10px;border-radius:6px;background:#313244;text-align:center;margin-bottom:10px;font-weight:600">⏸ 待命</div>

    <label style="display:block;margin:8px 0 3px;color:#a6adc8">掃描區域 (逗號分隔)</label>
    <textarea id="mbAreas" style="width:100%;box-sizing:border-box;height:48px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px;font-size:11px;font-family:monospace;resize:vertical">${cfg.areas}</textarea>

    <div style="display:flex;gap:8px;margin-top:8px">
      <div style="flex:1">
        <label style="display:block;margin-bottom:3px;color:#a6adc8">同時掃</label>
        <input id="mbConc" type="number" min="1" max="6" value="${cfg.concurrent}" style="width:100%;box-sizing:border-box;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px">
      </div>
      <div style="flex:1">
        <label style="display:block;margin-bottom:3px;color:#a6adc8">間隔(ms)</label>
        <input id="mbInt" type="number" min="500" step="500" value="${cfg.interval}" style="width:100%;box-sizing:border-box;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px">
      </div>
    </div>

    <label style="display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer">
      <input id="mbAuto" type="checkbox" ${cfg.autoClick?'checked':''}> 找到自動點擊卡位
    </label>
    <label style="display:flex;align-items:center;gap:6px;margin-top:6px;cursor:pointer">
      <input id="mbFront" type="checkbox" ${cfg.frontFirst?'checked':''}> 最前排優先
    </label>

    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="mbStart" style="flex:1;padding:10px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:6px;font-weight:700;cursor:pointer">▶ 開始</button>
      <button id="mbStop" style="flex:1;padding:10px;background:#f38ba8;color:#1e1e2e;border:none;border-radius:6px;font-weight:700;cursor:pointer">⏹ 停止</button>
    </div>

    <div style="margin-top:10px">
      <div style="color:#a6adc8;margin-bottom:4px">各區狀態</div>
      <div id="mbStatsGrid" style="display:flex;flex-wrap:wrap;gap:4px;font-size:10px;font-family:monospace"></div>
    </div>

    <div id="mbSeatList" style="margin-top:8px"></div>

    <div style="color:#a6adc8;margin:8px 0 4px">Log</div>
    <div id="mbLog" style="background:#11111b;border-radius:6px;padding:6px;height:90px;overflow-y:auto;font-size:10px;font-family:monospace;line-height:1.5"></div>
  `;
  document.body.appendChild(panel);

  const $ = (id)=>panel.querySelector(id);
  const statusEl = $('#mbStatus');
  const logEl = $('#mbLog');
  const statsGrid = $('#mbStatsGrid');
  const seatListEl = $('#mbSeatList');

  function setStatus(text, color){ statusEl.textContent = text; statusEl.style.background = color||'#313244'; statusEl.style.color = color?'#1e1e2e':'#cdd6f4'; }
  function log(msg, type){
    const colors = {ad:'#f38ba8', hit:'#a6e3a1', info:'#89b4fa'};
    const t = new Date().toLocaleTimeString('zh-TW',{hour12:false});
    const div = document.createElement('div');
    div.style.color = colors[type]||'#cdd6f4';
    div.textContent = `[${t}] ${msg}`;
    logEl.insertBefore(div, logEl.firstChild);
    while(logEl.children.length>50) logEl.removeChild(logEl.lastChild);
  }
  function renderStats(){
    statsGrid.innerHTML = '';
    for(const blk of blockList){
      const s = stats[blk];
      const has = s && s.avail>0;
      const ad  = s && s.status==='ad';
      const sus = s && s.status==='sus';
      // 顏色：綠=有位 / 紅=AD / 橘=疑似異常 / 灰=未掃或真0
      let bg='#313244', fg='#6c7086';
      if(has)      { bg='#a6e3a1'; fg='#1e1e2e'; }
      else if(ad)  { bg='#f38ba8'; fg='#1e1e2e'; }
      else if(sus) { bg='#fab387'; fg='#1e1e2e'; }
      const label = !s ? '-' : ad ? 'AD' : sus ? '?' : s.avail;
      const span = document.createElement('span');
      span.style.cssText = `padding:2px 5px;border-radius:4px;background:${bg};color:${fg}`;
      span.textContent = `${blk}:${label}`;
      statsGrid.appendChild(span);
    }
  }
  function renderSeatList(found, best){
    seatListEl.innerHTML = '<div style="color:#a6adc8;margin-bottom:4px">找到的空位</div>';
    const box = document.createElement('div');
    box.style.cssText = 'background:#11111b;border-radius:6px;padding:6px;max-height:120px;overflow-y:auto;font-size:11px';
    found.slice(0,30).forEach(s=>{
      const d = document.createElement('div');
      const isBest = s===best;
      d.style.cssText = `padding:2px 4px;${isBest?'background:#a6e3a1;color:#1e1e2e;border-radius:4px;font-weight:700':''}`;
      d.textContent = `${isBest?'⭐ ':''}區${s.block} ${s.rowFull} ${s.seatNo}號`;
      box.appendChild(d);
    });
    seatListEl.appendChild(box);
  }

  function playAlert(){
    try{
      const ctx = new (window.AudioContext||window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      osc.type='square'; osc.frequency.setValueAtTime(1200, ctx.currentTime);
      osc.connect(ctx.destination); osc.start();
      setTimeout(()=>osc.stop(), 1200);
    }catch(e){}
  }
  function notify(title, body){
    try{
      if(Notification.permission==='granted') new Notification(title,{body});
      else if(Notification.permission!=='denied') Notification.requestPermission().then(p=>{ if(p==='granted') new Notification(title,{body}); });
    }catch(e){}
  }

  // 攔截 1 分鐘提示（沿用你原本腳本）
  const _origAlert = window.alert;
  window.alert = (msg)=>{
    if(msg && (String(msg).includes('1 minute')||String(msg).includes('minute left'))) return;
    _origAlert(msg);
  };

  // ── 計時器 ──
  setInterval(()=>{
    const e = Math.floor((Date.now()-startTime)/1000);
    $('#mbTimer').textContent = `${String(Math.floor(e/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
  },1000);

  // ── 按鈕 ──
  $('#mbStart').onclick = ()=>{
    cfg.areas = $('#mbAreas').value.trim();
    cfg.concurrent = Math.max(1, parseInt($('#mbConc').value)||3);
    cfg.interval = Math.max(500, parseInt($('#mbInt').value)||3500);
    cfg.autoClick = $('#mbAuto').checked;
    cfg.frontFirst = $('#mbFront').checked;
    saveCfg();

    // 兩種格式都吃：純文字 "201,202,314" 或陣列寫法 ['201','202','314']
    // 做法：把方括號、單雙引號、空白全部清掉，只留數字和逗號，再 split
    blockList = cfg.areas
      .replace(/[\[\]'"]/g, '')   // 去掉 [ ] ' "
      .split(',')
      .map(s=>s.trim())
      .filter(Boolean);
    if(!blockList.length){ log('請先填入要掃的區域','ad'); return; }

    params = detectParams();
    if(!params.GoodsCode || !params.SessionId){
      log('⚠ 抓不到 GoodsCode / SessionId，請確認你正在座位選擇頁面執行','ad');
      log('偵測到：Goods='+params.GoodsCode+' Session='+(params.SessionId?'有':'無'),'info');
    }else{
      log('參數偵測成功 Goods='+params.GoodsCode,'info');
    }

    currentInterval = cfg.interval;
    cursor = 0;
    running = true; paused = false;
    notify && Notification.requestPermission && Notification.requestPermission();
    log(`啟動：${blockList.length}區，同時${cfg.concurrent}，間隔${cfg.interval}ms`,'info');
    setStatus('▶ 掃描中','#27ae60');
    scanLoop();
  };

  // ── 等候模式（整批異常時用）──
  let waitingResume = false;
  function enterResumeMode(){
    waitingResume = true;
    paused = true;
    clearTimeout(loopTimer);
    const btn = $('#mbStop');
    btn.textContent = '▶ 繼續';
    btn.style.background = '#a6e3a1';
    btn.style.color = '#1e1e2e';
  }
  function exitResumeMode(){
    waitingResume = false;
    const btn = $('#mbStop');
    btn.textContent = '⏹ 停止';
    btn.style.background = '#f38ba8';
    btn.style.color = '#1e1e2e';
    if(running){
      paused = false;
      setStatus('▶ 掃描中', '#27ae60');
      log('▶ 繼續掃描', 'info');
      scanLoop();
    }
  }

  $('#mbStop').onclick = ()=>{
    // 等候模式 → 點繼續；其他 → 點停止
    if(waitingResume){ exitResumeMode(); return; }
    running = false; paused = false;
    clearTimeout(loopTimer);
    setStatus('⏸ 已停止','#313244');
    log('已停止','info');
  };

  renderStats();
  log('工具載入完成，請在座位選擇頁面按「開始」','info');
  log('提示：先測小範圍、間隔別太短，觀察是否會 AD','info');
})();
