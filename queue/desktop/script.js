(function(){
  const CONFIG={scanInterval:10000, threshold:300};
  let scanning=true;
  const history=[];
  let startOrder=null;
  const startTime=Date.now();
  let smoothedRate=null;

  const display=document.createElement('div');
  display.style.cssText='position:fixed;bottom:20px;left:20px;z-index:99999;padding:10px 14px;background:rgba(0,0,0,0.75);color:white;border-radius:8px;font-size:13px;font-family:monospace;line-height:1.8;pointer-events:none;';
  display.innerText='⏳ 計算中...';
  document.body.appendChild(display);

  const btn=document.createElement('button');
  btn.innerText='⏹ 停止監控';
  btn.style.cssText='position:fixed;bottom:20px;right:20px;z-index:99999;padding:10px 16px;background:#e74c3c;color:white;border:none;border-radius:8px;font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
  btn.onclick=()=>{scanning=false;clearInterval(timer);btn.innerText='✅ 已停止';btn.style.background='#888';};
  document.body.appendChild(btn);

  const playAlert=()=>{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator();
    osc.type='square';
    osc.frequency.setValueAtTime(1200,ctx.currentTime);
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(()=>osc.stop(),1000);
  };

  const linearRegression=(data)=>{
    const n=data.length;
    if(n<2) return null;
    const t0=data[0].time;
    const xs=data.map(d=>(d.time-t0)/1000);
    const ys=data.map(d=>d.order);
    const sumX=xs.reduce((a,b)=>a+b,0);
    const sumY=ys.reduce((a,b)=>a+b,0);
    const sumXY=xs.reduce((a,b,i)=>a+b*ys[i],0);
    const sumX2=xs.reduce((a,b)=>a+b*b,0);
    const slope=(n*sumXY-sumX*sumY)/(n*sumX2-sumX*sumX);
    return Math.abs(slope);
  };

  const updateDisplay=(foundOrder)=>{
    if(foundOrder===null){display.innerText='⏳ 找不到號碼';return;}

    const startInfo=startOrder!==null
      ?`🎫 入場號碼：${startOrder}\n🕐 入場時間：${new Date(startTime).toLocaleTimeString()}`
      :'🎫 入場號碼：計算中';

    let rateText='⚡ 平均每分鐘：計算中';
    let etaText='🎯 預計進場：計算中';

    if(history.length>=10){
      const rate=linearRegression(history);
      if(rate>0){
        smoothedRate=smoothedRate===null ? rate : smoothedRate*0.7+rate*0.3;
        const perMin=Math.round(smoothedRate*60);
        rateText=`⚡ 平均每分鐘：${perMin} 號`;
        const etaSecs=foundOrder/smoothedRate;
        const etaTime=new Date(Date.now()+etaSecs*1000);
        const mm=String(etaTime.getMonth()+1).padStart(2,'0');
        const dd=String(etaTime.getDate()).padStart(2,'0');
        const hh=String(etaTime.getHours()).padStart(2,'0');
        const min=String(etaTime.getMinutes()).padStart(2,'0');
        etaText=`🎯 預計進場：${mm}/${dd} ${hh}:${min}`;
      } else {
        rateText='⚡ 平均每分鐘：隊伍暫停';
        etaText='🎯 預計進場：暫停中';
      }
    }

    display.innerText=`${startInfo}\n${rateText}\n${etaText}`;
  };

  const scan=()=>{
    if(!scanning)return;
    const strongs=Array.from(document.querySelectorAll('strong'));
    let foundOrder=null;
    for(let el of strongs){
      let text=el.innerText.trim().replace(/,/g,'');
      if(/^\d+$/.test(text)){foundOrder=parseInt(text);break;}
    }
    console.log('掃描中... 目前號碼：'+(foundOrder??'找不到'));

    if(foundOrder!==null){
      if(startOrder===null) startOrder=foundOrder;
      history.push({time:Date.now(),order:foundOrder});
      if(history.length>30) history.shift();
    }

    updateDisplay(foundOrder);

    if(foundOrder!==null&&foundOrder<=CONFIG.threshold){
      scanning=false;
      clearInterval(timer);
      btn.innerText='🚨 已觸發';
      btn.style.background='#e67e22';
      playAlert();
      alert('🚨 RING ALARM！號碼：'+foundOrder);
    }
  };

  const timer=setInterval(scan,CONFIG.scanInterval);
  scan();
  alert('✅ 監控已啟動！每'+(CONFIG.scanInterval/1000)+'秒掃描一次');
})();
