
(function(){
"use strict";

var APP_VERSION="12.0.0";
var RECORD_KEY="rss_records_v3";
var CONFIG_KEY="rss_config_v3";

var UNIT_OPTIONS={
  "OSN6800/9800 UPS":["12DCP","13DCP","12LSX","14LSX","15LSC","17LSC","19LSC","15LTX","17LTX","12LOG","11LOA","12TMX"],
  "OSN9800 M12":["G2DCP","G1M504","G2M504","G1M520","G1M210","G3MA08G1","G3MA08GU"]
};
function populateUnitNames(selected){
  var category=clean($("unitCategory").value),unit=$("unitName"),items=UNIT_OPTIONS[category]||[];
  unit.innerHTML="";
  var first=document.createElement("option");first.value="";first.textContent=category?"유니트명을 선택하세요":"먼저 장비 카테고리를 선택하세요";unit.appendChild(first);
  items.forEach(function(name){var opt=document.createElement("option");opt.value=name;opt.textContent=name;unit.appendChild(opt);});
  unit.disabled=!category;
  if(selected&&items.indexOf(selected)>=0)unit.value=selected;
}

var state={
  started:false, ring:"", office:"", skipRack:false, skipShelf:false,
  rack:"", shelf:"", slot:"", stage:"rack", records:[],
  scanner:null, stream:null, scanning:false, scanMode:"auto", torchOn:false, cameraCapabilities:null, editingStage:null,
  decodeBusy:false, animationId:0, frameIndex:0, lastDecodeAt:0,
  scanLocked:false, lastDecodedValue:"", lastDecodedAt:0,
  zxingReadyPromise:null, nativeDetector:null, detectorFormats:[], decodeAttempts:0, decodeErrors:0, lastDecodeError:"",
  regionIndex:0, variantIndex:0,
  videoDevices:[], selectedCameraId:"", candidateVotes:{}, candidateWindowMs:1800, requiredVotes:2,
  quality:{brightness:0,sharpness:0,lastChecked:0}, qualityCanvas:null, focusPending:false,
  performanceProfile:"balanced", scanStartedAt:0, fastMissSince:0, decodeTimes:[], lastFrameSignature:null, lastFrameSignatureAt:0, nativeHit:null, zxingHit:null
};

function $(id){return document.getElementById(id);}
function show(id){$(id).classList.remove("hidden");}
function hide(id){$(id).classList.add("hidden");}
function text(id,v){$(id).textContent=v;}
function clean(v){return String(v||"").trim();}
function esc(v){return String(v||"").replace(/[&<>"']/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c];});}
function toast(msg){
  text("toast",msg);show("toast");
  clearTimeout(toast.t);toast.t=setTimeout(function(){hide("toast");},2600);
}
function vibrate(){if(navigator.vibrate)navigator.vibrate([60,40,60]);}

function normalizeDecodedValue(v){
  return clean(v).replace(/[\u0000-\u001F\u007F]/g,"").trim();
}
function candidateKey(value,format){return normalizeDecodedValue(value)+"|"+String(format||"");}
function resetCandidates(){state.candidateVotes={};text("candidateStatus","동일한 값이 반복 인식되면 자동 확정합니다.");$("candidateStatus").className="candidate-status";}
function registerCandidate(result){
  var value=normalizeDecodedValue(result&&result.text),format=result&&result.format||"Barcode/QR";
  if(!value)return false;
  var now=Date.now(),key=candidateKey(value,format),cfg=profileConfig(),votes=state.candidateVotes[key]||[];
  votes=votes.filter(function(ts){return now-ts<=cfg.confirmWindow;});votes.push(now);state.candidateVotes[key]=votes;
  Object.keys(state.candidateVotes).forEach(function(k){state.candidateVotes[k]=state.candidateVotes[k].filter(function(ts){return now-ts<=cfg.confirmWindow;});if(!state.candidateVotes[k].length)delete state.candidateVotes[k];});
  var dual=state.nativeHit&&state.zxingHit&&state.nativeHit.value===value&&state.zxingHit.value===value&&Math.abs(state.nativeHit.at-state.zxingHit.at)<1000;
  var checksumTrusted=/ean|upc/i.test(format);
  var required=dual?1:(checksumTrusted&&state.performanceProfile!=="accurate"?1:2);
  text("candidateStatus",dual?"네이티브·ZXing 교차 확인 · 즉시 확정":"후보 "+value+" · "+votes.length+"/"+required+"회 일치");$("candidateStatus").className="candidate-status confirming";
  if(votes.length>=required){$("candidateStatus").className="candidate-status confirmed";return true;}
  return false;
}

function analyzeFrameQuality(video){
  var now=performance.now();if(now-state.quality.lastChecked<500)return;state.quality.lastChecked=now;
  var c=state.qualityCanvas||(state.qualityCanvas=document.createElement("canvas")),w=160,h=120;c.width=w;c.height=h;
  var x=c.getContext("2d",{willReadFrequently:true});x.drawImage(video,0,0,w,h);var d=x.getImageData(0,0,w,h).data;
  var sum=0,edge=0,count=w*h;for(var i=0;i<d.length;i+=4)sum=(sum+d[i]+d[i+1]+d[i+2]);
  var brightness=sum/(count*3);for(var yy=1;yy<h;yy++){for(var xx=1;xx<w;xx++){var a=(yy*w+xx)*4,b=(yy*w+xx-1)*4,u=((yy-1)*w+xx)*4;var g=(d[a]+d[a+1]+d[a+2])/3;edge+=Math.abs(g-(d[b]+d[b+1]+d[b+2])/3)+Math.abs(g-(d[u]+d[u+1]+d[u+2])/3);}}
  var sharpness=edge/(count*2);state.quality={brightness:brightness,sharpness:sharpness,lastChecked:now};
  var msg,cls="quality-status good";
  if(brightness<55){msg="조명이 부족합니다. 조명을 켜거나 밝은 방향으로 이동하세요.";cls="quality-status warn";}
  else if(brightness>225){msg="반사가 강합니다. 단말을 약간 기울여 주세요.";cls="quality-status warn";}
  else if(sharpness<7){msg="초점이 흐립니다. 잠시 고정하거나 초점 다시 맞춤을 누르세요.";cls="quality-status warn";}
  else msg="영상 품질 양호 · 밝기 "+Math.round(brightness)+" · 선명도 "+sharpness.toFixed(1);
  text("qualityStatus",msg);$("qualityStatus").className=cls;
}

function openScannerModal(){
  show("scannerModal");
  document.documentElement.classList.add("scan-open");
  document.body.classList.add("scan-open");
  text("scannerStage",stageLabel(state.stage)+" 스캔");
}
function closeScannerModal(){
  hide("scannerModal");
  document.documentElement.classList.remove("scan-open");
  document.body.classList.remove("scan-open");
  state.torchOn=false;
}
function setScannerStatus(message,type){
  var el=$("scannerStatus");
  el.textContent=message;
  el.className="scanner-status"+(type?" "+type:"");
}
function fastFormats(){
  if(state.scanMode==="barcode")return ["Code128","Code39","Code93","ITF","EAN13","EAN8","UPCA","UPCE"];
  if(state.scanMode==="qr")return ["QRCode","DataMatrix"];
  if(state.scanMode==="small")return ["QRCode","MicroQRCode","RMQRCode","DataMatrix","Code128","Code39"];
  return ["Code128","Code39","QRCode","DataMatrix"];
}
function preciseFormats(){
  if(state.scanMode==="barcode")return [
    "Codabar","Code39","Code39Std","Code39Ext","Code32","PZN","Code93","Code128",
    "ITF","ITF14","DataBar","DataBarOmni","DataBarStk","DataBarStkOmni","DataBarLtd",
    "DataBarExp","DataBarExpStk","EANUPC","EAN13","EAN8","EAN5","EAN2","ISBN","UPCA","UPCE",
    "Telepen","TelepenAlpha","TelepenNumeric","DXFilmEdge"
  ];
  if(state.scanMode==="qr")return [
    "QRCode","QRCodeModel1","QRCodeModel2","MicroQRCode","RMQRCode","DataMatrix",
    "Aztec","AztecCode","AztecRune","PDF417","CompactPDF417","MicroPDF417","MaxiCode"
  ];
  return [];
}
function activeFormats(){return preciseFormats();}
function profileConfig(){
  if(state.performanceProfile==="fast")return {interval:75,preciseAfter:950,qualitySkip:false,maxFastWidth:900,confirmWindow:1200};
  if(state.performanceProfile==="accurate")return {interval:140,preciseAfter:350,qualitySkip:true,maxFastWidth:1200,confirmWindow:2200};
  return {interval:100,preciseAfter:650,qualitySkip:true,maxFastWidth:1024,confirmWindow:1700};
}

function nativeFormatsForMode(){
  var all=state.detectorFormats||[];
  if(state.scanMode==="barcode")return all.filter(function(f){return !/qr|aztec|data_matrix|pdf417/i.test(f);});
  if(state.scanMode==="qr")return all.filter(function(f){return /qr|aztec|data_matrix|pdf417/i.test(f);});
  return all.slice();
}

function scanRegion(width,height){
  if(state.scanMode==="barcode"){
    return {width:Math.floor(width*.94),height:Math.max(120,Math.floor(height*.28))};
  }
  if(state.scanMode==="qr"){
    var side=Math.floor(Math.min(width*.86,height*.66));
    return {width:side,height:side};
  }
  if(state.scanMode==="small"){
    return {width:Math.floor(width*.54),height:Math.floor(height*.36)};
  }
  /* 자동 모드는 넓은 영역을 검사해 QR와 1D를 모두 포착 */
  return {width:Math.floor(width*.94),height:Math.floor(height*.62)};
}
function updateModeUI(){
  document.querySelectorAll(".scan-mode").forEach(function(btn){
    btn.classList.toggle("active",btn.dataset.mode===state.scanMode);
  });
  var overlay=$("scanOverlay");
  overlay.className="scan-overlay "+state.scanMode+"-mode";
  text("scanGuideText",state.scanMode==="barcode"
    ?"바코드 막대가 수평이 되도록 가로 프레임에 크게 맞춰 주세요."
    :state.scanMode==="qr"
      ?"QR 코드 전체 모서리가 사각 프레임 안에 들어오게 맞춰 주세요."
      :state.scanMode==="small"
        ?"작은 코드가 중앙 프레임을 가득 채우도록 확대하고 초점을 기다려 주세요."
        :"코드 하나를 화면 중앙에 크게 맞춰 주세요.");
}
function setupCameraControls(){
  hide("torchBtn");hide("zoomWrap");hide("quickZoom");state.cameraCapabilities=null;
  try{
    var track=state.stream&&state.stream.getVideoTracks()[0];
    if(!track)return;
    var caps=track.getCapabilities?track.getCapabilities():{};
    var settings=track.getSettings?track.getSettings():{};
    state.cameraCapabilities={track:track,caps:caps};
    if(caps.torch)show("torchBtn");
    if(caps.zoom){
      var min=caps.zoom.min||1,max=caps.zoom.max||1,step=caps.zoom.step||0.1;
      var initial=settings.zoom||min;
      if(state.scanMode==="small")initial=Math.min(max,Math.max(min,min+(max-min)*0.65));
      $("zoomSlider").min=min;$("zoomSlider").max=max;$("zoomSlider").step=step;$("zoomSlider").value=initial;
      text("zoomValue",Number(initial).toFixed(1)+"×");show("zoomWrap");show("quickZoom");
      if(initial!==(settings.zoom||min))track.applyConstraints({advanced:[{zoom:initial}]}).catch(function(){});
    }
  }catch(e){console.warn("카메라 제어 미지원",e);}
}

function ensureScannerLibrary(){
  if(state.zxingReadyPromise)return state.zxingReadyPromise;
  state.zxingReadyPromise=(async function(){
    if(!window.ZXingWASM||typeof window.ZXingWASM.readBarcodes!=="function"){
      throw new Error("ZXing-C++ WASM JavaScript를 불러오지 못했습니다.");
    }
    /* 모듈은 한 번만 초기화하고 실제 WASM 인스턴스 생성 완료까지 기다린다. */
    if(typeof window.ZXingWASM.prepareZXingModule==="function"){
      await window.ZXingWASM.prepareZXingModule({fireImmediately:true});
    }
    if("BarcodeDetector" in window){
      try{
        state.detectorFormats=await BarcodeDetector.getSupportedFormats();
        if(state.detectorFormats.length)state.nativeDetector=new BarcodeDetector({formats:state.detectorFormats});
      }catch(e){console.warn("BarcodeDetector 초기화 실패",e);}
    }
    return true;
  })().catch(function(err){state.zxingReadyPromise=null;throw err;});
  return state.zxingReadyPromise;
}

function determineStage(){
  if(!state.skipRack && !state.rack)return "rack";
  if(!state.skipShelf && !state.shelf)return "shelf";
  return "slot";
}
function stageLabel(s){return s==="rack"?"Rack":s==="shelf"?"Shelf":"Slot";}
function setStage(s){
  state.stage=s;state.scanLocked=false;
  updateUI();
}
function saveLocal(){
  localStorage.setItem(RECORD_KEY,JSON.stringify(state.records));
  localStorage.setItem(CONFIG_KEY,JSON.stringify({
    ring:state.ring,office:state.office,skipRack:state.skipRack,skipShelf:state.skipShelf,
    rack:state.rack,shelf:state.shelf
  }));
}
function restoreLocal(){
  try{state.records=JSON.parse(localStorage.getItem(RECORD_KEY)||"[]");if(!Array.isArray(state.records))state.records=[];}catch(e){state.records=[];}
  try{
    var c=JSON.parse(localStorage.getItem(CONFIG_KEY)||"{}");
    if(c.ring&&c.office){
      state.ring=c.ring;state.office=c.office;state.skipRack=!!c.skipRack;state.skipShelf=!!c.skipShelf;
      state.rack=c.rack||"";state.shelf=c.shelf||"";
      $("ringName").value=state.ring;$("officeName").value=state.office;
      $("skipRack").checked=state.skipRack;$("skipShelf").checked=state.skipShelf;
    }
  }catch(e){}
}

function updateUI(){
  text("ringView",state.ring||"-");text("officeView",state.office||"-");
  text("rackView",state.skipRack?"생략":(state.rack||"미등록"));
  text("shelfView",state.skipShelf?"생략":(state.shelf||"미등록"));
  text("slotView",state.slot||"미등록");
  text("stageView",stageLabel(state.stage));
  text("stageNotice",stageLabel(state.stage)+" 바코드 또는 QR 코드를 스캔하세요.");
      if(state.started){show("workflowSection");show("dataSection");show("editWorkBtn");hide("startWorkBtn");}
  else{hide("workflowSection");hide("slotSection");hide("editWorkBtn");show("startWorkBtn");}
  renderRecords();
}
function renderRecords(){
  text("recordCount",String(state.records.length));
  var body=$("recordBody"),html="";
  state.records.forEach(function(r,i){
    html+="<tr><td>"+(i+1)+"</td><td>"+esc(r.ring)+"</td><td>"+esc(r.office)+"</td><td>"+esc(r.rack)+"</td><td>"+esc(r.shelf)+"</td><td>"+esc(r.slot)+"</td><td>"+esc(r.wavelength)+"</td><td>"+esc(r.slotNumber)+"</td><td>"+esc(r.unitCategory||"")+"</td><td>"+esc(r.unitName)+"</td><td>"+esc(r.memo)+"</td><td>"+esc(r.createdAt)+"</td><td><button class='delete-row' data-index='"+i+"' type='button'>삭제</button></td></tr>";
  });
  body.innerHTML=html;
  body.querySelectorAll(".delete-row").forEach(function(btn){
    btn.addEventListener("click",function(){
      state.records.splice(Number(btn.dataset.index),1);saveLocal();renderRecords();toast("삭제했습니다.");
    });
  });
}

function startWork(){
  var ring=clean($("ringName").value),office=clean($("officeName").value);
  if(!ring||!office){toast("링명과 국사명을 모두 입력하세요.");return;}
  state.ring=ring;state.office=office;
  state.skipRack=$("skipRack").checked;state.skipShelf=$("skipShelf").checked;
  if(state.skipRack)state.rack="";
  if(state.skipShelf)state.shelf="";
  state.started=true;setStage(determineStage());saveLocal();toast("작업을 시작합니다.");
}
function editWork(){
  stopScanner();
  state.started=false;state.slot="";
  updateUI();window.scrollTo({top:0,behavior:"smooth"});
}
function applyCode(value,format,manual){
  value=clean(value);
  if(!value){toast("빈 값은 반영할 수 없습니다.");return;}

  var appliedStage=state.stage;
  if(appliedStage==="rack"){
    state.rack=value;
    state.shelf=state.skipShelf?"":state.shelf;
    state.slot="";
    setStage(state.skipShelf?"slot":"shelf");
  }else if(appliedStage==="shelf"){
    state.shelf=value;
    state.slot="";
    setStage("slot");
  }else{
    state.slot=value;
    $("slotCode").value=value;
    show("slotSection");
    window.setTimeout(function(){$("wavelength").focus();},120);
  }

  saveLocal();
  updateUI();
  vibrate();
  toast(stageLabel(appliedStage)+" 값이 반영되었습니다.");
}

function cancelSlot(){
  state.slot="";$("slotCode").value="";$("wavelength").value="";$("slotNumber").value="";$("unitCategory").value="";populateUnitNames();$("memo").value="";
  hide("slotSection");setStage("slot");
}
function saveSlot(){
  var slotNo=clean($("slotNumber").value);
  var unitCategory=clean($("unitCategory").value),unitName=clean($("unitName").value);
  if(!state.slot){toast("Slot 코드를 먼저 등록하세요.");return;}
  if(!/^[0-9A-F][0-9]{2}$/.test(slotNo)){toast("Slot Number는 첫 글자 0~9 또는 A~F, 뒤 두 자리는 숫자여야 합니다.");return;}
  if(!unitCategory){toast("장비 카테고리를 선택하세요.");return;}
  if(!unitName){toast("유니트명을 선택하세요.");return;}
  state.records.push({
    id:String(Date.now())+"-"+Math.random().toString(16).slice(2),
    ring:state.ring,office:state.office,
    rack:state.skipRack?"생략":state.rack,
    shelf:state.skipShelf?"생략":state.shelf,
    slot:state.slot,wavelength:clean($("wavelength").value),
    slotNumber:slotNo,unitCategory:unitCategory,unitName:unitName,
    memo:clean($("memo").value),createdAt:new Date().toLocaleString()
  });
  cancelSlot();saveLocal();renderRecords();toast("저장했습니다. 다음 Slot을 스캔하세요.");
}

function onScan(decodedText,decodedResult){
  var value=normalizeDecodedValue(decodedText);if(!value||state.scanLocked)return;
  var fmt=(decodedResult&&decodedResult.format)||"Barcode/QR";
  var result={text:value,format:fmt,engine:decodedResult&&decodedResult.engine};
  if(!registerCandidate(result))return;
  state.scanLocked=true;vibrate();setScannerStatus(value+" · 반복 확인 완료","success");
  stopScanner(true).then(function(){applyCode(value,fmt,false);setTimeout(function(){state.scanLocked=false;},400);});
}

function openCodeEdit(stage){
  if(stage==="rack"&&state.skipRack){toast("Rack 스캔 생략 상태입니다.");return;}
  if(stage==="shelf"&&state.skipShelf){toast("Shelf 스캔 생략 상태입니다.");return;}
  state.editingStage=stage;
  var current=stage==="rack"?state.rack:stage==="shelf"?state.shelf:state.slot;
  text("codeEditTitle",stageLabel(stage)+" 바코드 수정");
  text("codeEditCurrent","현재 값: "+(current||"미등록"));
  $("editManualCode").value=current||"";
  show("codeEditModal");
  document.documentElement.classList.add("edit-open");
  document.body.classList.add("edit-open");
}
function closeCodeEdit(){
  hide("codeEditModal");
  document.documentElement.classList.remove("edit-open");
  document.body.classList.remove("edit-open");
}
function beginEditRescan(){
  var stage=state.editingStage;
  closeCodeEdit();
  if(!stage)return;
  setStage(stage);
  startScanner();
}
function applyEditedManual(){
  var value=clean($("editManualCode").value).toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(!value){toast("영문 대문자와 숫자만 입력하세요.");return;}
  var stage=state.editingStage;
  if(stage==="rack"){
    state.rack=value;
  }else if(stage==="shelf"){
    state.shelf=value;
  }else if(stage==="slot"){
    state.slot=value;
    $("slotCode").value=value;
    show("slotSection");
  }
  saveLocal();updateUI();closeCodeEdit();toast(stageLabel(stage)+" 값을 수정했습니다.");
}
function resetCurrentInput(){
  if(!confirm("입력 중인 기본정보와 Rack·Shelf·Slot 값을 모두 초기화하시겠습니까?\\n저장된 CSV 데이터는 삭제되지 않습니다."))return;
  stopScanner(true).then(function(){
    state.ring="";state.office="";state.rack="";state.shelf="";state.slot="";
    state.skipRack=false;state.skipShelf=false;state.stage="rack";state.started=false;
    ["ringName","officeName","manualCode","slotCode","wavelength","slotNumber","unitCategory","memo"].forEach(function(id){
      if($(id))$(id).value="";
    });
    populateUnitNames();
    $("skipRack").checked=false;$("skipShelf").checked=false;
    hide("workflowSection");hide("slotSection");
    show("siteSection");show("startWorkBtn");hide("editWorkBtn");
    saveLocal();updateUI();toast("입력 중인 정보를 초기화했습니다.");
    window.scrollTo({top:0,behavior:"smooth"});
  });
}
function scanPhotoFile(file){
  if(!file)return;
  ensureScannerLibrary().then(async function(){
    setScannerStatus("고해상도 사진을 ZXing-C++로 분석하고 있습니다.");
    var direct=await window.ZXingWASM.readBarcodes(file,{formats:activeFormats(),tryHarder:true,tryRotate:true,tryInvert:true,tryDenoise:true,tryDownscale:true,maxNumberOfSymbols:4,minLineCount:1,textMode:"Plain"});
    if(direct&&direct.length)return direct.find(function(x){return x.text&&!x.error;})||direct[0];
    var bmp=await createImageBitmap(file),max=3600,scale=Math.min(1,max/Math.max(bmp.width,bmp.height));
    var c=$("scanCanvas"),ctx=c.getContext("2d",{willReadFrequently:true});c.width=Math.floor(bmp.width*scale);c.height=Math.floor(bmp.height*scale);
    ctx.drawImage(bmp,0,0,c.width,c.height);
    var nativeResult=await decodeWithNative(c);if(nativeResult){bmp.close&&bmp.close();return nativeResult;}
    var img=ctx.getImageData(0,0,c.width,c.height),z=await decodeWithZXing(img);bmp.close&&bmp.close();return z;
  }).then(function(result){
    if(!result||!result.text)throw new Error("not found");
    return stopScanner(true).then(function(){applyCode(result.text,result.format||"ZXing-C++ 사진",false);});
  }).catch(function(err){console.error(err);setScannerStatus("사진에서 코드를 찾지 못했습니다.","error");toast("사진에서 코드를 인식하지 못했습니다.");})
  .finally(function(){$("photoScanInput").value="";});
}
function getRegionRects(video){
  var vw=video.videoWidth,vh=video.videoHeight;
  var regions=[{name:"전체",x:0,y:0,w:vw,h:vh}];
  function centered(name,wr,hr){
    var w=Math.max(80,Math.floor(vw*wr)),h=Math.max(80,Math.floor(vh*hr));
    regions.push({name:name,x:Math.floor((vw-w)/2),y:Math.floor((vh-h)/2),w:w,h:h});
  }
  if(state.scanMode==="barcode"){
    centered("1D-넓게",0.96,0.38);centered("1D-중앙",0.78,0.24);
  }else if(state.scanMode==="qr"){
    centered("2D-넓게",0.82,0.82);centered("2D-중앙",0.56,0.56);
  }else if(state.scanMode==="small"){
    centered("소형-넓게",0.58,0.58);centered("소형-중앙",0.34,0.34);centered("소형-가로",0.56,0.24);
  }else{
    centered("자동-중앙",0.82,0.68);centered("자동-소형",0.48,0.48);centered("자동-가로",0.90,0.30);
  }
  return regions;
}
function renderRegion(video,rect,variant){
  var canvas=$("scanCanvas"),ctx=canvas.getContext("2d",{willReadFrequently:true});
  var maxW=state.scanMode==="small"?2200:1800,maxH=state.scanMode==="small"?1600:1350;
  var scale=Math.min(maxW/rect.w,maxH/rect.h);
  if(rect.name==="전체")scale=Math.min(1.35,scale);
  else scale=Math.max(1,Math.min(state.scanMode==="small"?4.5:2.6,scale));
  var tw=Math.max(240,Math.round(rect.w*scale)),th=Math.max(160,Math.round(rect.h*scale));
  canvas.width=tw;canvas.height=th;ctx.imageSmoothingEnabled=variant===0;ctx.imageSmoothingQuality="high";
  ctx.drawImage(video,rect.x,rect.y,rect.w,rect.h,0,0,tw,th);
  if(variant===0)return {canvas:canvas,imageData:ctx.getImageData(0,0,tw,th),label:rect.name+"/원본"};
  var image=ctx.getImageData(0,0,tw,th),d=image.data;
  var hist=new Uint32Array(256),sum=0;
  for(var i=0;i<d.length;i+=4){var g=Math.round(d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114);hist[g]++;sum+=g;d[i]=d[i+1]=d[i+2]=g;}
  var mean=sum/(d.length/4),threshold=mean;
  if(variant===2){
    var total=d.length/4,sumB=0,wB=0,maxV=0,t=0;for(i=0;i<256;i++)sumB+=i*hist[i];
    for(i=0;i<256;i++){wB+=hist[i];if(!wB)continue;var wF=total-wB;if(!wF)break;sumB-=i*hist[i];var mB=sumB/wB,mF=(sum-sumB)/wF,v=wB*wF*(mB-mF)*(mB-mF);if(v>maxV){maxV=v;t=i;}}threshold=t||mean;
  }
  for(i=0;i<d.length;i+=4){
    var v=d[i];
    if(variant===1)v=Math.max(0,Math.min(255,(v-mean)*1.9+128));
    else if(variant===2)v=v>threshold?255:0;
    else if(variant===3)v=255-v;
    d[i]=d[i+1]=d[i+2]=v;
  }
  ctx.putImageData(image,0,0);
  return {canvas:canvas,imageData:image,label:rect.name+"/"+(variant===1?"대비":variant===2?"이진화":"반전")};
}
async function decodeWithNative(source){
  if(!state.nativeDetector)return null;
  try{
    var formats=nativeFormatsForMode();
    var detector=formats.length?new BarcodeDetector({formats:formats}):state.nativeDetector;
    var found=await detector.detect(source);
    if(found&&found.length)return {text:found[0].rawValue,format:found[0].format||"BarcodeDetector",engine:"Native"};
  }catch(e){console.debug("native miss",e);}
  return null;
}
async function decodeWithZXing(imageData,precise){
  var options={
    formats:precise?preciseFormats():fastFormats(),
    tryHarder:!!precise,tryRotate:!!precise,tryInvert:!!precise,tryDenoise:!!precise,
    tryDownscale:true,downscaleFactor:precise?2:1.6,downscaleThreshold:precise?700:500,
    maxNumberOfSymbols:precise?4:1,minLineCount:1,returnErrors:false,textMode:"Plain",eanAddOnSymbol:"Read"
  };
  var results=await window.ZXingWASM.readBarcodes(imageData,options);
  if(!results||!results.length)return null;
  var r=results.find(function(x){return x&&x.text&&!x.error;})||results[0];
  return r&&r.text?{text:r.text,format:r.format||r.symbology||"ZXing",symbology:r.symbology,engine:"ZXing-C++"}:null;
}
function renderFastRegion(video){
  var vw=video.videoWidth,vh=video.videoHeight,cfg=profileConfig();
  var wr=state.scanMode==="barcode"?.92:state.scanMode==="small"?.54:.78;
  var hr=state.scanMode==="barcode"?.30:state.scanMode==="small"?.46:.62;
  var rw=Math.floor(vw*wr),rh=Math.floor(vh*hr),rx=Math.floor((vw-rw)/2),ry=Math.floor((vh-rh)/2);
  var scale=Math.min(1,cfg.maxFastWidth/rw),tw=Math.max(320,Math.floor(rw*scale)),th=Math.max(180,Math.floor(rh*scale));
  var canvas=$("scanCanvas"),ctx=canvas.getContext("2d",{willReadFrequently:true});canvas.width=tw;canvas.height=th;ctx.drawImage(video,rx,ry,rw,rh,0,0,tw,th);
  return {canvas:canvas,imageData:ctx.getImageData(0,0,tw,th),label:"고속 중앙/원본"};
}
function frameSignature(video){
  var now=performance.now();if(now-state.lastFrameSignatureAt<180)return null;state.lastFrameSignatureAt=now;
  var c=state.qualityCanvas||(state.qualityCanvas=document.createElement("canvas"));c.width=24;c.height=18;var x=c.getContext("2d",{willReadFrequently:true});x.drawImage(video,0,0,24,18);var d=x.getImageData(0,0,24,18).data,sum=0;
  for(var i=0;i<d.length;i+=16)sum+=(d[i]+d[i+1]+d[i+2]);return Math.round(sum/100);
}
function recordDecodeTime(ms){
  state.decodeTimes.push(ms);if(state.decodeTimes.length>20)state.decodeTimes.shift();
  var avg=state.decodeTimes.reduce(function(a,b){return a+b;},0)/state.decodeTimes.length;
  text("performanceStatus","프로필 "+({fast:"고속",balanced:"균형",accurate:"정밀"}[state.performanceProfile])+" · 평균 판독 "+Math.round(avg)+"ms");
}
async function decodeFrame(){
  if(!state.scanning||state.decodeBusy||state.scanLocked)return;
  var video=$("scannerVideo");if(!video.videoWidth||video.readyState<2)return;analyzeFrameQuality(video);if(state.focusPending)return;
  var cfg=profileConfig(),now=performance.now();if(now-state.lastDecodeAt<cfg.interval)return;
  if(cfg.qualitySkip&&(state.quality.brightness<35||state.quality.sharpness<3.5))return;
  var sig=frameSignature(video);if(sig!==null&&state.lastFrameSignature!==null&&Math.abs(sig-state.lastFrameSignature)<2&&now-state.lastDecodeAt<260)return;if(sig!==null)state.lastFrameSignature=sig;
  state.lastDecodeAt=now;state.decodeBusy=true;state.decodeAttempts++;var started=performance.now();
  try{
    var nativeResult=await decodeWithNative(video);
    if(nativeResult){state.nativeHit={value:normalizeDecodedValue(nativeResult.text),at:Date.now()};onScan(nativeResult.text,nativeResult);return;}
    var elapsed=now-state.scanStartedAt,precise=elapsed>=cfg.preciseAfter;
    var frame;
    if(!precise)frame=renderFastRegion(video);
    else{
      var regions=getRegionRects(video),rect=regions[state.regionIndex++%regions.length],variant=state.variantIndex++%4;
      frame=renderRegion(video,rect,variant);
    }
    setScannerStatus(stageLabel(state.stage)+" 인식 대기 · "+frame.label+" · 시도 "+state.decodeAttempts,"ready");
    var result=await decodeWithZXing(frame.imageData,precise);
    if(result){state.zxingHit={value:normalizeDecodedValue(result.text),at:Date.now()};onScan(result.text,result);}
  }catch(e){
    state.decodeErrors++;state.lastDecodeError=e&&e.message?e.message:String(e);console.warn("decode error",e);
    setScannerStatus("디코더 오류: "+state.lastDecodeError,"error");
  }finally{recordDecodeTime(performance.now()-started);state.decodeBusy=false;}
}
function scanningLoop(){if(!state.scanning)return;decodeFrame();state.animationId=requestAnimationFrame(scanningLoop);}

function chooseRearCamera(devices){
  var videos=devices.filter(function(d){return d.kind==="videoinput";});
  var rear=videos.find(function(d){return /back|rear|environment|후면|후방|camera 0/i.test(d.label||"");});
  return rear||videos[videos.length-1]||null;
}
function populateCameraSelect(devices,selectedId){
  state.videoDevices=devices.filter(function(d){return d.kind==="videoinput";});var sel=$("cameraSelect");sel.innerHTML="";
  var auto=document.createElement("option");auto.value="";auto.textContent="후면 카메라 자동 선택";sel.appendChild(auto);
  state.videoDevices.forEach(function(d,i){var o=document.createElement("option");o.value=d.deviceId;o.textContent=d.label||("카메라 "+(i+1));sel.appendChild(o);});
  sel.value=selectedId||"";
}
async function requestFocus(){
  var info=state.cameraCapabilities;if(!info||!info.track)return false;var caps=info.caps||{};
  try{
    var advanced=[];
    if(caps.focusMode&&Array.isArray(caps.focusMode)){if(caps.focusMode.indexOf("continuous")>=0)advanced.push({focusMode:"continuous"});else if(caps.focusMode.indexOf("single-shot")>=0)advanced.push({focusMode:"single-shot"});}
    if(advanced.length)await info.track.applyConstraints({advanced:advanced});
    state.focusPending=true;text("qualityStatus","초점을 다시 맞추는 중입니다. 1초간 고정하세요.");$("qualityStatus").className="quality-status warn";
    setTimeout(function(){state.focusPending=false;},900);return advanced.length>0;
  }catch(e){console.warn("focus unsupported",e);return false;}
}
async function startScanner(){
  if(state.scanning)return;
  openScannerModal();updateModeUI();resetCandidates();setScannerStatus("ZXing-C++ WASM 엔진을 준비하고 있습니다.");
  try{
    await ensureScannerLibrary();if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error("카메라 API 미지원");
    if(!state.videoDevices.length){var permission=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});permission.getTracks().forEach(function(t){t.stop();});}
    var devices=await navigator.mediaDevices.enumerateDevices();populateCameraSelect(devices,state.selectedCameraId);
    var chosen=state.selectedCameraId?state.videoDevices.find(function(d){return d.deviceId===state.selectedCameraId;}):chooseRearCamera(devices);
    var constraints={audio:false,video:{deviceId:chosen?{exact:chosen.deviceId}:undefined,facingMode:chosen?undefined:{ideal:"environment"},width:{ideal:3840,min:1280},height:{ideal:2160,min:720},frameRate:{ideal:30,min:15}}};
    state.stream=await navigator.mediaDevices.getUserMedia(constraints);var video=$("scannerVideo");video.srcObject=state.stream;await video.play();
    state.scanning=true;state.scanLocked=false;state.decodeBusy=false;state.frameIndex=0;state.decodeAttempts=0;state.decodeErrors=0;state.regionIndex=0;state.variantIndex=0;state.lastDecodeError="";state.scanStartedAt=performance.now();state.decodeTimes=[];state.lastFrameSignature=null;state.nativeHit=null;state.zxingHit=null;
    setScannerStatus(stageLabel(state.stage)+" 인식 대기 · 다중 프레임 검증 활성","ready");setupCameraControls();await requestFocus();scanningLoop();
  }catch(err){console.error(err);state.scanning=false;setScannerStatus("카메라 또는 WASM 엔진을 실행하지 못했습니다: "+(err.message||err),"error");}
}
function stopScanner(closeModal){
  if(state.animationId)cancelAnimationFrame(state.animationId);
  state.animationId=0;state.scanning=false;state.decodeBusy=false;state.scanLocked=false;resetCandidates();
  if(state.stream){state.stream.getTracks().forEach(function(t){t.stop();});state.stream=null;}
  var video=$("scannerVideo");if(video)video.srcObject=null;
  hide("torchBtn");hide("zoomWrap");
  if(closeModal!==false)closeScannerModal();
  return Promise.resolve();
}

function csvEscape(v){return '"'+String(v==null?"":v).replace(/"/g,'""')+'"';}
function download(name,content,type){
  var blob=new Blob([content],{type:type}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
function exportCSV(){
  if(!state.records.length){toast("내보낼 데이터가 없습니다.");return;}
  var heads=["No","링명","국사명","Rack","Shelf","Slot","Wavelength","Slot Number","장비 카테고리","유니트명","비고","등록시각"];
  var lines=[heads.map(csvEscape).join(",")];
  state.records.forEach(function(r,i){
    lines.push([i+1,r.ring,r.office,r.rack,r.shelf,r.slot,r.wavelength,r.slotNumber,r.unitCategory||"",r.unitName,r.memo,r.createdAt].map(csvEscape).join(","));
  });
  download("rack_shelf_slot_"+new Date().toISOString().slice(0,10)+".csv","\ufeff"+lines.join("\r\n"),"text/csv;charset=utf-8");
}




$("startWorkBtn").addEventListener("click",startWork);
$("editWorkBtn").addEventListener("click",editWork);
$("scanBtn").addEventListener("click",startScanner);
$("rackSelectBtn").addEventListener("click",function(){openCodeEdit("rack");});
$("shelfSelectBtn").addEventListener("click",function(){openCodeEdit("shelf");});
$("slotSelectBtn").addEventListener("click",function(){openCodeEdit("slot");});
$("editRescanBtn").addEventListener("click",beginEditRescan);
$("editManualApplyBtn").addEventListener("click",applyEditedManual);
$("closeCodeEditBtn").addEventListener("click",closeCodeEdit);
$("editManualCode").addEventListener("input",function(){
  this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,64);
});
$("resetCurrentBtn").addEventListener("click",resetCurrentInput);
$("photoScanInput").addEventListener("change",function(){
  if(this.files&&this.files[0])scanPhotoFile(this.files[0]);
});
$("stopScannerBtn").addEventListener("click",function(){stopScanner(true);});
$("closeScannerBtn").addEventListener("click",function(){stopScanner(true);});
document.querySelectorAll(".scan-mode").forEach(function(btn){
  btn.addEventListener("click",function(){
    var next=btn.dataset.mode;
    if(next===state.scanMode)return;
    state.scanMode=next;resetCandidates();
    updateModeUI();
    setScannerStatus("스캔 모드를 변경하고 카메라를 다시 시작합니다.");
    stopScanner(false).then(startScanner);
  });
});
$("performanceProfile").addEventListener("change",function(){state.performanceProfile=this.value;resetCandidates();state.scanStartedAt=performance.now();state.decodeTimes=[];text("performanceStatus","프로필 변경 적용 중");});
$("cameraSelect").addEventListener("change",function(){state.selectedCameraId=this.value;stopScanner(false).then(startScanner);});
$("focusBtn").addEventListener("click",function(){requestFocus().then(function(ok){toast(ok?"초점을 다시 맞춥니다.":"이 단말은 웹 초점 제어를 지원하지 않습니다.");});});
document.querySelectorAll("#quickZoom button").forEach(function(btn){btn.addEventListener("click",function(){
  if(!state.cameraCapabilities||!state.cameraCapabilities.track)return;var caps=state.cameraCapabilities.caps.zoom||{},v=Math.max(caps.min||1,Math.min(caps.max||1,Number(btn.dataset.zoom)));
  $("zoomSlider").value=v;text("zoomValue",v.toFixed(1)+"×");state.cameraCapabilities.track.applyConstraints({advanced:[{zoom:v}]}).catch(function(){});
});});
$("torchBtn").addEventListener("click",function(){
  if(!state.cameraCapabilities||!state.cameraCapabilities.track)return;
  state.torchOn=!state.torchOn;
  state.cameraCapabilities.track.applyConstraints({advanced:[{torch:state.torchOn}]}).then(function(){
    $("torchBtn").textContent=state.torchOn?"조명 끄기":"조명 켜기";
  }).catch(function(){state.torchOn=false;toast("이 기기에서는 조명을 제어할 수 없습니다.");});
});
$("zoomSlider").addEventListener("input",function(){
  var value=Number(this.value);
  text("zoomValue",value.toFixed(1)+"×");
  if(state.cameraCapabilities&&state.cameraCapabilities.track){
    state.cameraCapabilities.track.applyConstraints({advanced:[{zoom:value}]}).catch(function(){});
  }
});
$("manualBtn").addEventListener("click",function(){
  var v=clean($("manualCode").value).toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(!v){toast("영문 대문자와 숫자만 입력하세요.");return;}
  applyCode(v,"수동 입력",true);
  $("manualCode").value="";
});
$("manualCode").addEventListener("input",function(){
  this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,64);
});
$("unitCategory").addEventListener("change",function(){populateUnitNames();});
$("slotNumber").addEventListener("input",function(){
  this.value=this.value.toUpperCase().replace(/[^0-9A-F]/g,"").slice(0,3);
  if(this.value.length>1){
    this.value=this.value.charAt(0)+this.value.slice(1).replace(/\D/g,"");
  }
});
$("saveSlotBtn").addEventListener("click",saveSlot);
$("cancelSlotBtn").addEventListener("click",cancelSlot);
$("csvBtn").addEventListener("click",exportCSV);

function environmentCheck(){
  var okSecure=location.protocol==="https:"||location.hostname==="localhost";
  var okCamera=!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia);
  if(okSecure&&okCamera){text("envStatus","HTTPS 및 카메라 API 사용 가능");$("envStatus").className="status ok";}
  else if(!okSecure){text("envStatus","HTTPS가 아니므로 카메라가 차단될 수 있습니다.");$("envStatus").className="status bad";}
  else{text("envStatus","현재 브라우저에서 카메라 API를 사용할 수 없습니다.");$("envStatus").className="status bad";}
}
if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("./sw.js").catch(console.error);});}
document.addEventListener("visibilitychange",function(){if(document.hidden)stopScanner(true);});
window.addEventListener("pagehide",function(){stopScanner(true);});

populateUnitNames();restoreLocal();environmentCheck();updateUI();
ensureScannerLibrary().catch(function(){});
})();
