(function(){
  const SCAN_INTERVAL = 300; // 掃描間隔 ms

  const _origAlert = window.alert;
  window.alert = (msg) => {
    if(msg && (msg.includes('1 minute') || msg.includes('minute left'))) return;
    _origAlert(msg);
  };

  _origAlert('⚡ 閃電模式啟動！點確定開始');

  let running = true;
  let submitted = false;
  const startTime = Date.now();

  // 計時器
  const timerDisplay = document.createElement('div');
  timerDisplay.style.cssText = 'position:fixed;bottom:60px;right:20px;z-index:99999;padding:6px 12px;background:rgba(0,0,0,0.7);color:white;border-radius:8px;font-size:13px;font-family:monospace';
  timerDisplay.innerText = '⏱ 00:00';
  document.body.appendChild(timerDisplay);
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    timerDisplay.innerText = `⏱ ${m}:${s}`;
  }, 1000);

  // 停止按鈕
  const stopBtn = document.createElement('button');
  stopBtn.innerText = '⏹ 停止';
  stopBtn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;padding:10px 16px;background:#e74c3c;color:white;border:none;border-radius:8px;font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
  stopBtn.onclick = () => {
    running = false;
    clearInterval(scanner);
    stopBtn.innerText = '✅ 已停止';
    stopBtn.style.background = '#888';
  };
  document.body.appendChild(stopBtn);

  // 掃描
  const scanner = setInterval(() => {
    if (!running || submitted) return;
    try {
      const f  = document.getElementById('ifrmSeat').contentDocument;
      const f2 = f.getElementById('ifrmSeatDetail').contentDocument;
      const seat = f2?.querySelector('span[onclick*="SelectSeat"]');
      if (seat) {
        submitted = true;
        running = false;
        clearInterval(scanner);
        console.log('🎯 找到座位！點擊送出！');
        seat.click();
        setTimeout(() => {
          f.defaultView.fnSelect();
          stopBtn.innerText = '⏳ 送出中...';
          stopBtn.style.background = '#f39c12';
          const check = setInterval(() => {
            if (document.querySelector('div.buy_info')) {
              clearInterval(check);
              _origAlert('🎉 座位已送出！趕快去付款！');
              stopBtn.innerText = '🎉 已送出！';
              stopBtn.style.background = '#27ae60';
            }
          }, 300);
          setTimeout(() => clearInterval(check), 5000);
        }, 300);
      }
    } catch(e) {}
  }, SCAN_INTERVAL);

  console.log('⚡ 閃電模式啟動！');
})();
