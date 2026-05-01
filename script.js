(function(){
  const AREAS=['201','202','203','204','205','206','207','208','209','210','211','212','213','214','215','001','002','003','004','005','308','309','310','311','312','313','314'];
  const SCANS_PER_AREA=2;      // 同區掃幾次再換區
  const QUICK_SCAN_INTERVAL=300;
  const NO_SEAT_ATTEMPTS=3;    // 每次掃描等幾次找不到座位就算沒座位
  const WHITEPAGE_ATTEMPTS=16; // 白屏超時次數（約5秒）
  const ACCESS_DENIED_WAIT=30; // Access Denied 等待秒數

  let currentIndex=0;
  let areaScanCount=0;
  let running=true;
  let submitted=false;
  let areaTimer;
  let quickScan;
  const startTime=Date.now();

  // 計時顯示
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

  const playAlert=()=>{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator();
    osc.type='square';
    osc.frequency.setValueAtTime(1200,ctx.currentTime);
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(()=>osc.stop(),1500);
  };

  const handleAccessDenied=()=>{
    console.log(`Access Denied！暫停${ACCESS_DENIED_WAIT}秒...`);
    running=false;
    clearInterval(quickScan);
    clearTimeout(areaTimer);
    stopBtn.style.background='#8e44ad';
    let countdown=ACCESS_DENIED_WAIT;
    const cdTimer=setInterval(()=>{
      countdown--;
      stopBtn.innerText=`🚫 Access Denied (${countdown}s)`;
      if(countdown<=0){
        clearInterval(cdTimer);
        console.log('恢復掃描！');
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
      console.log(`同區再掃：${AREAS[currentIndex]} Side (${areaScanCount+1}/${SCANS_PER_AREA})`);
      goToAreaScan(currentIndex);
    } else {
      areaScanCount=0;
      const delay=3000+Math.random()*2000;
      console.log(`換區等待中...`);
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
            alert('🎉 座位已送出！趕快去付款！');
            stopBtn.innerText='🎉 已送出！';
            stopBtn.style.background='#27ae60';
          },1000);
          return;
        }
        const fCheck=document.getElementById('ifrmSeat').contentDocument;
        const dialog=fCheck.querySelector('.popup_wrap, .layer_wrap, [class*="popup"], [class*="layer"]');
        if(dialog&&dialog.offsetParent!==null){
          clearInterval(checkResult);
          const closeBtn=dialog.querySelector('a, button');
          if(closeBtn)closeBtn.click();
          console.log('座位被搶走，繼續同區...');
          submitted=false;
          areaScanCount=0;
          setTimeout(()=>{
            running=true;
            goToAreaScan(currentIndex);
          },500);
        }
      },300);

      setTimeout(()=>clearInterval(checkResult),5000);
    },300);
  };

  // 只掃描不換區
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
        if(seat){
          clearInterval(quickScan);
          foundSeat(seat,f);
          return;
        }

        // 沒座位換區
        if(attempts>NO_SEAT_ATTEMPTS){
          clearInterval(quickScan);
          nextArea();
          return;
        }

        // 白屏換區
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

  // 換區並掃描
  const goToArea=(index)=>{
    if(!running||submitted)return;
    currentIndex=index%AREAS.length;
    const area=AREAS[currentIndex];
    console.log(`換區：${area} Side (${currentIndex+1}/${AREAS.length})`);
    try{
      const f=document.getElementById('ifrmSeat').contentDocument;
      f.defaultView.fnBlockSeatUpdate('','',area);
    }catch(e){console.log('換區錯誤:',e);}
    goToAreaScan(currentIndex);
  };

  goToArea(0);
  console.log('✅ 掃描啟動！同區掃${SCANS_PER_AREA}次，無座位約1秒換區，白屏5秒換區');
})();