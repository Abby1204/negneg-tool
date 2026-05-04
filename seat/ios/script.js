(function(){
  const cfg=window.NEGNEG_CONFIG||{};
  const AREAS=cfg.areas||['002','003','004','005'];
  const SCANS_PER_AREA=cfg.scans_per_area||2;
  const QUICK_SCAN_INTERVAL=cfg.scan_interval||300;
  const NO_SEAT_ATTEMPTS=cfg.no_seat_attempts||3;
  const WHITEPAGE_ATTEMPTS=cfg.whitepage_attempts||16;
  const ACCESS_DENIED_WAIT=cfg.access_denied_wait||30;

  // 攔截1分鐘提示
  const _origAlert=window.alert;
  window.alert=(msg)=>{
    if(msg&&(msg.includes('1 minute')||msg.includes('minute left'))){
      console.log('自動關閉1分鐘提示');
      return;
    }
    _origAlert(msg);
  };

  // 預先建立 AudioContext（必須在用戶互動時建立）
  const AC=window.AudioContext||window.webkitAudioContext;
  const audioCtx=AC?new AC():null;

  const playAlert=()=>{
    try{
      if(!audioCtx)return;
      if(audioCtx.state==='suspended')audioCtx.resume();
      const osc=audioCtx.createOscillator();
      const gain=audioCtx.createGain();
      osc.type='square';
      osc.frequency.setValueAtTime(1200,audioCtx.currentTime);
      gain.gain.setValueAtTime(1.0,audioCtx.currentTime);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      setTimeout(()=>osc.stop(),1500);
    }catch(e){console.log('Audio Error');}
  };

  let currentIndex=0;
  let areaScanCount=0;
  let running=true;
  let submitted=false;
  let areaTimer;
  let quickScan;
  const startTime=Date.now();

  const timerDisplay=document.createElement('div');
  timerDisplay.style.cssText='position:fixed;bottom:60px;right:20px;z-index:99999;padding:6px 12px;background:rgba(0,0,0,0.7);color:white;border-radius:8px;font-size:13px;font-family:monospace';
  timerDisplay.innerText='⏱ 00:00';
  document.body.appendChild(timerDisplay);
  setInterval(()=>{
    const elapsed=Math.floor((Date.now()-startTime)/1000);
    const m=String(Math.floor(elapsed/60)).padStart(2,'0');
    const s=String(elapsed%60).padStart(2,'0');
    timerDisplay.innerText=`⏱ ${m}:${s}`;
  },1000);

  const stopBtn=document.createElement('button');
  stopBtn.innerText='⏹ 停止';
  stopBtn.style.cssText='position:fixed;bottom:20px;right:20px;z-index:99999;padding:10px 16px;background:#e74c3c;color:white;border:none;border-radius:8px;font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
  stopBtn.onclick=()=>{running=false;clearTimeout(areaTimer);clearInterval(quickScan);stopBtn.innerText='✅ 已停止';stopBtn.style.background='#888';};
  document.body.appendChild(stopBtn);

  const handleAccessDenied=()=>{
    console.log(`Access Denied！暫停${ACCESS_DENIED_WAIT}秒...`);
    running=false;
    clearInterval(quickScan);
    clearTimeout(areaTimer);
    stopBtn.style.background='#8e44ad';
    let countdown=ACCESS_DENIED_WAIT;
    const cdTimer=setInterval(()=>{
      countdown--;
      stopBtn.innerText=`🚫 AD (${countdown}s)`;
      if(countdown<=0){
        clearInterval(cdTimer);
        running=true;
        stopBtn.innerText='⏹ 停止';
        stopBtn.style.background='#e74c3c';
        areaScanCount=0;
        goToArea(currentIndex);
      }
    },1000);
  };

  const nextArea=()=>{
    if(!running||submitted)return;
    areaScanCount++;
    if(areaScanCount<SCANS_PER_AREA){
      goToAreaScan(currentIndex);
    }else{
      areaScanCount=0;
      const delay=3000+Math.random()*2000;
      setTimeout(()=>goToArea(currentIndex+1),delay);
    }
  };

  const foundSeat=(seat,f)=>{
    console.log('找到座位！立刻點擊！');
    clearInterval(quickScan);
    clearTimeout(areaTimer);
    seat.click();
    setTimeout(()=>{
      submitted=true;
      running=false;
      f.defaultView.fnSelect();
      stopBtn.innerText='⏳ 送出中...';
      stopBtn.style.background='#f39c12';
      const checkResult=setInterval(()=>{
        const priceStep=document.querySelector('div.buy_info');
        if(priceStep){
          clearInterval(checkResult);
          setTimeout(()=>{
            playAlert();
            _origAlert('🎉 座位已送出！趕快去付款！');
            stopBtn.innerText='🎉 已送出！';
            stopBtn.style.background='#27ae60';
          },1000);
          return;
        }
        const fCheck=document.getElementById('ifrmSeat').contentDocument;
        const dialog=fCheck.querySelector('.popup_wrap,.layer_wrap,[class*="popup"],[class*="layer"]');
        if(dialog&&dialog.offsetParent!==null){
          clearInterval(checkResult);
          const closeBtn=dialog.querySelector('a, button');
          if(closeBtn)closeBtn.click();
          console.log('座位被搶走，繼續同區...');
          submitted=false;
          areaScanCount=0;
          setTimeout(()=>{running=true;goToAreaScan(currentIndex);},500);
        }
      },300);
      setTimeout(()=>clearInterval(checkResult),5000);
    },300);
  };

  const goToAreaScan=(index)=>{
    if(!running||submitted)return;
    clearInterval(quickScan);
    clearTimeout(areaTimer);
    let attempts=0;
    quickScan=setInterval(()=>{
      if(!running||submitted){clearInterval(quickScan);return;}
      attempts++;
      try{
        const f=document.getElementById('ifrmSeat').contentDocument;
        const f2=f.getElementById('ifrmSeatDetail').contentDocument;
        const bodyText=f2?.body?.innerText||'';
        if(bodyText.includes('Access Denied')||bodyText.includes('Forbidden')){
          clearInterval(quickScan);
          handleAccessDenied();
          return;
        }
        const seat=f2?.querySelector('span[onclick*="SelectSeat"]');
        if(seat){clearInterval(quickScan);foundSeat(seat,f);return;}
        if(attempts>NO_SEAT_ATTEMPTS){clearInterval(quickScan);nextArea();return;}
        if(attempts>WHITEPAGE_ATTEMPTS){
          clearInterval(quickScan);
          console.log('白屏超時，換區...');
          areaScanCount=0;
          nextArea();
          return;
        }
      }catch(e){}
    },QUICK_SCAN_INTERVAL);
  };

  const goToArea=(index)=>{
    if(!running||submitted)return;
    currentIndex=index%AREAS.length;
    const area=AREAS[currentIndex];
    console.log(`換區：${area} Side (${currentIndex+1}/${AREAS.length})`);
    try{
      const f=document.getElementById('ifrmSeat').contentDocument;
      if(typeof f.defaultView.fnBlockSeatUpdate!=='function'){
        console.log('頁面尚未就緒，等待500ms...');
        setTimeout(()=>goToArea(index),500);
        return;
      }
      f.defaultView.fnBlockSeatUpdate('','',area);
    }catch(e){console.log('換區錯誤:',e);}
    goToAreaScan(currentIndex);
  };

  goToArea(0);
  console.log(`✅ 掃描啟動！同區掃${SCANS_PER_AREA}次，無座位約1秒換區，白屏5秒換區`);
})();
