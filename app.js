
(function(){
"use strict";

var APP_VERSION="1.0.19";
var pendingServiceWorker=null;
var updateReloading=false;
var RECORD_KEY="rss_records_v3";
var CONFIG_KEY="rss_config_v4";

var UNIT_OPTIONS={
  "OSN6800/9800 UPS":["12DCP","13DCP","12LSX","14LSX","15LSC","17LSC","19LSC","15LTX","17LTX","12LOG","11LOA","12TMX"],
  "OSN9800 M12":["G2DCP","G1M504","G2M504","G1M520","G1M210","G3MA08G1","G3MA08GU"]
};
function fillUnitSelect(categoryId,unitId,selected){
  var category=clean($(categoryId).value),unit=$(unitId),items=UNIT_OPTIONS[category]||[];
  unit.innerHTML="";
  var first=document.createElement("option");first.value="";first.textContent=category?"유니트명을 선택하세요":"먼저 장비 카테고리를 선택하세요";unit.appendChild(first);
  items.forEach(function(name){var opt=document.createElement("option");opt.value=name;opt.textContent=name;unit.appendChild(opt);});
  unit.disabled=!category;if(selected&&items.indexOf(selected)>=0)unit.value=selected;
}
function populateUnitNames(selected){fillUnitSelect("unitCategory","unitName",selected);}
function populateRelocationUnitNames(selected){fillUnitSelect("relocationUnitCategory","relocationUnitName",selected);}

var state={
  workMode:"", started:false, ring:"", office:"", skipRack:false, skipShelf:false,
  rack:"", shelf:"", slot:"", stage:"rack", records:[],
  scanner:null, stream:null, scanning:false, scanMode:"auto", torchOn:false, cameraCapabilities:null, editingStage:null,
  decodeBusy:false, animationId:0, frameIndex:0, lastDecodeAt:0,
  scanLocked:false, lastDecodedValue:"", lastDecodedAt:0,
  zxingReadyPromise:null, nativeDetector:null, nativeDetectors:{}, detectorFormats:[], decodeAttempts:0, decodeErrors:0, lastDecodeError:"",
  regionIndex:0, variantIndex:0,
  videoDevices:[], selectedCameraId:"", autoSelectedCameraId:"", candidateVotes:{}, candidateWindowMs:1800, requiredVotes:2,
  quality:{brightness:0,sharpness:0,lastChecked:0}, qualityCanvas:null, focusPending:false, autoFocusTimer:0, autoFocusSupported:false, autoFocusEnabled:true,
  androidBlurCount:0, androidFocusKickCount:0, lastAndroidFocusKick:0,
  performanceProfile:"balanced", scanStartedAt:0, fastMissSince:0, decodeTimes:[], lastFrameSignature:null, lastFrameSignatureAt:0, nativeHit:null, zxingHit:null, autoCanvases:{}, preciseCopyCanvas:null
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
function formatFamily(format){
  var f=String(format||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  if(/qr/.test(f))return "qr";
  if(/datamatrix/.test(f))return "datamatrix";
  if(/code128/.test(f))return "code128";
  if(/code39/.test(f))return "code39";
  if(/code93/.test(f))return "code93";
  if(/ean|upc|isbn/.test(f))return "eanupc";
  if(/itf/.test(f))return "itf";
  return f||"unknown";
}
function candidateKey(value,format){return normalizeDecodedValue(value)+"|"+formatFamily(format);}
function resetCandidates(){state.candidateVotes={};text("candidateStatus","동일한 값이 반복 인식되면 자동 확정합니다.");$("candidateStatus").className="candidate-status";}
function registerCandidate(result){
  var value=normalizeDecodedValue(result&&result.text),format=result&&result.format||"Barcode/QR";
  if(!value)return false;
  var now=Date.now(),key=candidateKey(value,format),cfg=profileConfig(),votes=state.candidateVotes[key]||[];
  votes=votes.filter(function(v){return now-v.at<=cfg.confirmWindow;});
  if(!votes.some(function(v){return v.attempt===state.decodeAttempts;}))votes.push({at:now,attempt:state.decodeAttempts,engine:result.engine||""});
  state.candidateVotes[key]=votes;
  Object.keys(state.candidateVotes).forEach(function(k){state.candidateVotes[k]=state.candidateVotes[k].filter(function(v){return now-v.at<=cfg.confirmWindow;});if(!state.candidateVotes[k].length)delete state.candidateVotes[k];});
  var dual=state.nativeHit&&state.zxingHit&&state.nativeHit.value===value&&state.zxingHit.value===value&&Math.abs(state.nativeHit.at-state.zxingHit.at)<750;
  var required=dual?1:2;
  text("candidateStatus",dual?"네이티브·ZXing 교차 확인 · 즉시 확정":"후보 "+value+" · "+votes.length+"/"+required+"프레임 일치");$("candidateStatus").className="candidate-status confirming";
  if(dual||votes.length>=required){$("candidateStatus").className="candidate-status confirmed";return true;}
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
  if(brightness<55){
    msg="조명이 부족합니다. 조명을 켜거나 밝은 방향으로 이동하세요.";cls="quality-status warn";
    text("shootingTipText",state.cameraCapabilities&&state.cameraCapabilities.caps&&state.cameraCapabilities.caps.torch?"조명이 너무 어둡습니다. 카메라 조명을 켜주세요.":"조명이 너무 어둡습니다. 밝은 곳으로 이동해 주세요.");show("shootingTip");
  }
  else if(brightness>225){msg="반사가 강합니다. 단말을 약간 기울여 주세요.";cls="quality-status warn";}
  else if(sharpness<7){msg="초점이 흐립니다. 잠시 고정하거나 초점 다시 맞춤을 누르세요.";cls="quality-status warn";}
  else msg="영상 품질 양호 · 밝기 "+Math.round(brightness)+" · 선명도 "+sharpness.toFixed(1);
  if(brightness>=55)hide("shootingTip");
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
  hide("shootingTip");
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
  if(state.scanMode==="small")return [
    "QRCode","QRCodeModel1","QRCodeModel2","MicroQRCode","RMQRCode","DataMatrix",
    "Code128","Code39","Code93","ITF","EAN13","EAN8","UPCA","UPCE"
  ];
  return [
    "QRCode","QRCodeModel1","QRCodeModel2","MicroQRCode","RMQRCode","DataMatrix",
    "Code128","Code39","Code93","ITF","ITF14","EANUPC","EAN13","EAN8","UPCA","UPCE"
  ];
}
function activeFormats(){return preciseFormats();}
function profileConfig(){
  if(state.performanceProfile==="fast")return {interval:42,preciseAfter:260,preciseEvery:3,qualitySkip:false,maxFastWidth:1024,confirmWindow:1250};
  if(state.performanceProfile==="accurate")return {interval:78,preciseAfter:140,preciseEvery:1,qualitySkip:true,maxFastWidth:1280,confirmWindow:1800};
  return {interval:52,preciseAfter:190,preciseEvery:2,qualitySkip:false,maxFastWidth:1152,confirmWindow:1450};
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
function activeScanRect(video){
  var vw=video.videoWidth,vh=video.videoHeight,frame=$("scanOverlay")&&$("scanOverlay").querySelector(".scan-frame");
  try{
    var videoBox=video.getBoundingClientRect(),frameBox=frame&&frame.getBoundingClientRect();
    if(videoBox.width>0&&videoBox.height>0&&frameBox&&frameBox.width>0&&frameBox.height>0){
      var coverScale=Math.max(videoBox.width/vw,videoBox.height/vh);
      var visibleWidth=videoBox.width/coverScale,visibleHeight=videoBox.height/coverScale;
      var cropX=(vw-visibleWidth)/2,cropY=(vh-visibleHeight)/2;
      var x=cropX+(frameBox.left-videoBox.left)/coverScale;
      var y=cropY+(frameBox.top-videoBox.top)/coverScale;
      var w=frameBox.width/coverScale,h=frameBox.height/coverScale;
      var inset=Math.max(2,Math.min(w,h)*.015);
      x+=inset;y+=inset;w-=inset*2;h-=inset*2;
      x=Math.max(0,Math.min(vw-1,x));y=Math.max(0,Math.min(vh-1,y));
      w=Math.max(40,Math.min(vw-x,w));h=Math.max(40,Math.min(vh-y,h));
      return {name:"스캔영역",x:Math.floor(x),y:Math.floor(y),w:Math.floor(w),h:Math.floor(h)};
    }
  }catch(e){console.warn("scan frame mapping fallback",e);}
  var size=scanRegion(vw,vh);
  return {name:"스캔영역",x:Math.floor((vw-size.width)/2),y:Math.floor((vh-size.height)/2),w:size.width,h:size.height};
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
function updateFocusControl(supported,busy){
  var btn=$("focusBtn");if(!btn)return;
  var enabled=!!state.autoFocusEnabled;
  btn.classList.toggle("control-active",enabled);btn.classList.toggle("control-busy",!!busy);
  btn.setAttribute("aria-pressed",enabled?"true":"false");
  btn.innerHTML='<span class="toggle-icon" aria-hidden="true">'+(busy?"◌":"◎")+'</span><b>'+(busy?"초점 설정 중":"자동 초점")+'</b><span class="control-switch" aria-hidden="true"><i></i></span>';
}
function updateTorchControl(){
  var btn=$("torchBtn");if(!btn)return;
  btn.classList.toggle("torch-active",!!state.torchOn);btn.setAttribute("aria-pressed",state.torchOn?"true":"false");
  btn.innerHTML='<span class="toggle-icon" aria-hidden="true">ϟ</span><b>카메라 조명</b><span class="control-switch" aria-hidden="true"><i></i></span>';
}
function setupCameraControls(){
  hide("torchBtn");hide("zoomWrap");hide("quickZoom");state.cameraCapabilities=null;
  try{
    var track=state.stream&&state.stream.getVideoTracks()[0];
    if(!track)return;
    var caps=track.getCapabilities?track.getCapabilities():{};
    var settings=track.getSettings?track.getSettings():{};
    state.cameraCapabilities={track:track,caps:caps};
    state.torchOn=false;updateTorchControl();if(caps.torch)show("torchBtn");
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
        state.nativeDetectors={};
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
function stageLabel(s){return s==="rack"?"Rack":s==="shelf"?"Shelf":s==="unitBarcode"?"유니트바코드":"Slot";}
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
  text("rackView",state.skipRack?"생략":(state.rack||"미등록"));text("shelfView",state.skipShelf?"생략":(state.shelf||"미등록"));
  text("slotView",state.slot||"미등록");text("stageView",stageLabel(state.stage));text("stageNotice",stageLabel(state.stage)+" 바코드 또는 QR 코드를 스캔하세요.");
  if(state.workMode==="new"){show("siteSection");hide("relocationSection");if(state.started){show("workflowSection");show("dataSection");show("editWorkBtn");hide("startWorkBtn");}else{hide("workflowSection");hide("slotSection");hide("editWorkBtn");show("startWorkBtn");}}
  else if(state.workMode==="relocation"){hide("siteSection");hide("workflowSection");hide("slotSection");show("relocationSection");show("dataSection");}
  else{hide("siteSection");hide("workflowSection");hide("slotSection");hide("relocationSection");hide("dataSection");}
  renderRecords();
}
function locationText(office,ring,slot,wavelength){return [office,ring,slot,wavelength].filter(Boolean).join(" / ");}
function renderRecords(){
  var newRows=[],relocationRows=[];
  state.records.forEach(function(r,originalIndex){
    var type=r.workType||"신규 증설";
    if(type==="재배치")relocationRows.push({r:r,index:originalIndex});else newRows.push({r:r,index:originalIndex});
  });
  text("newRecordCount",String(newRows.length));text("relocationRecordCount",String(relocationRows.length));
  $("newRecordBody").innerHTML=newRows.map(function(item,i){var r=item.r;return "<tr><td>"+(i+1)+"</td><td>"+esc(locationText(r.office,r.ring,"",""))+"</td><td>"+esc(r.rack||"")+"</td><td>"+esc(r.shelf||"")+"</td><td>"+esc(r.slotNumber||r.slot||"")+"</td><td>"+esc(r.wavelength||"")+"</td><td>"+esc(r.unitCategory||"")+"</td><td>"+esc(r.unitName||"")+"</td><td>"+esc(r.memo||"")+"</td><td>"+esc(r.createdAt||"")+"</td><td><button class='delete-row' data-index='"+item.index+"' type='button'>삭제</button></td></tr>";}).join("");
  $("relocationRecordBody").innerHTML=relocationRows.map(function(item,i){var r=item.r;return "<tr><td>"+(i+1)+"</td><td class='before-cell'>"+esc(locationText(r.beforeOffice,r.beforeRing,r.beforeSlot,r.beforeWavelength))+"</td><td>"+esc(r.unitCategory||"")+"</td><td>"+esc(r.unitName||"")+"</td><td>"+esc(r.unitBarcode||"")+"</td><td class='after-cell'>"+esc(locationText(r.afterOffice,r.afterRing,r.afterSlot,r.afterWavelength))+"</td><td>"+esc(r.memo||"")+"</td><td>"+esc(r.createdAt||"")+"</td><td><button class='delete-row' data-index='"+item.index+"' type='button'>삭제</button></td></tr>";}).join("");
  document.querySelectorAll(".delete-row").forEach(function(btn){btn.addEventListener("click",function(){state.records.splice(Number(btn.dataset.index),1);saveLocal();renderRecords();toast("삭제했습니다.");});});
}
function showRecordPanel(kind){
  var isNew=kind==="new";$("newRecordsTab").classList.toggle("active",isNew);$("relocationRecordsTab").classList.toggle("active",!isNew);$("newRecordsPanel").classList.toggle("hidden",!isNew);$("relocationRecordsPanel").classList.toggle("hidden",isNew);
}


var previewFilterType="신규 증설";
function previewValue(value){
  var v=clean(value||"");
  return v?esc(v):'<span class="empty">미입력</span>';
}
function previewField(label,value){
  var v=clean(value||"");
  return '<dt>'+esc(label)+'</dt><dd'+(v?'':' class="empty"')+'>'+ (v?esc(v):'미입력') +'</dd>';
}
function buildPreviewCard(r,index){
  var type=r.workType||"신규 증설";
  var top='<div class="preview-record-top"><strong>No. '+(index+1)+' · '+esc(type)+'</strong><time>'+previewValue(r.createdAt||"")+'</time></div>';
  if(type==="재배치"){
    return '<article class="preview-record-card">'+top+
      '<section class="preview-section before"><h3>재배치 전</h3><dl class="preview-fields">'+previewField("국사",r.beforeOffice)+previewField("링명",r.beforeRing)+previewField("슬롯",r.beforeSlot)+previewField("파장",r.beforeWavelength)+'</dl></section>'+
      '<dl class="preview-fields">'+previewField("장비 카테고리",r.unitCategory)+previewField("유니트명",r.unitName)+previewField("유니트바코드",r.unitBarcode)+previewField("비고",r.memo)+'</dl>'+
      '<section class="preview-section after"><h3>재배치 후</h3><dl class="preview-fields">'+previewField("국사",r.afterOffice)+previewField("링명",r.afterRing)+previewField("슬롯",r.afterSlot)+previewField("파장",r.afterWavelength)+'</dl></section></article>';
  }
  return '<article class="preview-record-card">'+top+'<dl class="preview-fields">'+
    previewField("국사명",r.office)+previewField("링명",r.ring)+previewField("Rack 바코드",r.rack)+previewField("Shelf 바코드",r.shelf)+previewField("Slot 바코드",r.slot)+previewField("Slot Number",r.slotNumber)+previewField("파장",r.wavelength)+previewField("장비 카테고리",r.unitCategory)+previewField("유니트명",r.unitName)+previewField("비고",r.memo)+'</dl></article>';
}
function openRecordsPreview(filterType){
  previewFilterType=filterType;
  var rows=state.records.filter(function(r){return (r.workType||"신규 증설")===filterType;});
  text("recordsPreviewTitle",filterType+" 저장 데이터 미리보기");
  text("recordsPreviewSummary","총 "+rows.length+"건 · 실물 바코드와 비교한 뒤 XLSX 저장 또는 공유하세요.");
  $("recordsPreviewList").innerHTML=rows.length?rows.map(buildPreviewCard).join(""):'<div class="preview-empty">미리보기할 저장 데이터가 없습니다.</div>';
  $("previewCsvBtn").disabled=!rows.length;$("previewShareBtn").disabled=!rows.length;
  show("recordsPreviewModal");document.documentElement.classList.add("preview-open");document.body.classList.add("preview-open");
  $("recordsPreviewList").scrollTop=0;
}
function closeRecordsPreview(){hide("recordsPreviewModal");document.documentElement.classList.remove("preview-open");document.body.classList.remove("preview-open");}

function selectWorkMode(mode){
  stopScanner(true);state.workMode=mode;state.started=false;state.stage=mode==="relocation"?"unitBarcode":"rack";
  document.querySelectorAll(".mode-choice").forEach(function(b){b.classList.toggle("active",(mode==="new"&&b.id==="newInstallModeBtn")||(mode==="relocation"&&b.id==="relocationModeBtn"));});
  hide("modeGateSection");updateUI();window.scrollTo({top:0,behavior:"smooth"});
}
function changeWorkMode(){stopScanner(true);state.workMode="";state.started=false;show("modeGateSection");updateUI();window.scrollTo({top:0,behavior:"smooth"});}
function clearRelocationForm(){["beforeOffice","beforeRing","beforeSlot","beforeWavelength","afterOffice","afterRing","afterSlot","afterWavelength","unitBarcode","relocationMemo","relocationUnitCategory"].forEach(function(id){$(id).value="";});populateRelocationUnitNames();}
function prepareNextRelocation(){
  ["beforeSlot","afterSlot","unitBarcode"].forEach(function(id){$(id).value="";});
  state.stage="unitBarcode";
  $("beforeSlot").focus();
}
function saveRelocation(){
  state.records.push({id:String(Date.now())+"-"+Math.random().toString(16).slice(2),workType:"재배치",beforeOffice:clean($("beforeOffice").value),beforeRing:clean($("beforeRing").value),beforeSlot:clean($("beforeSlot").value),beforeWavelength:clean($("beforeWavelength").value),unitCategory:clean($("relocationUnitCategory").value),unitName:clean($("relocationUnitName").value),unitBarcode:clean($("unitBarcode").value),afterOffice:clean($("afterOffice").value),afterRing:clean($("afterRing").value),afterSlot:clean($("afterSlot").value),afterWavelength:clean($("afterWavelength").value),memo:clean($("relocationMemo").value),createdAt:new Date().toLocaleString(),ring:"",office:"",rack:"",shelf:"",slot:"",wavelength:"",slotNumber:""});
  prepareNextRelocation();saveLocal();renderRecords();toast("저장했습니다. 국사·링 정보는 유지되며 Slot과 바코드만 새로 입력하세요.");
}
function startUnitBarcodeScan(){state.stage="unitBarcode";startScanner();}

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
  if(state.workMode==="relocation"||appliedStage==="unitBarcode"){
    $("unitBarcode").value=value;
    vibrate();toast("유니트바코드가 반영되었습니다.");return;
  }
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
    id:String(Date.now())+"-"+Math.random().toString(16).slice(2),workType:"신규 증설",
    ring:state.ring,office:state.office,
    rack:state.skipRack?"생략":state.rack,
    shelf:state.skipShelf?"생략":state.shelf,
    slot:state.slot,wavelength:clean($("wavelength").value),
    slotNumber:slotNo,unitCategory:unitCategory,unitName:unitName,unitBarcode:"",
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
  if(!confirm("입력 중인 기본정보와 Rack·Shelf·Slot 값을 모두 초기화하시겠습니까?\\n저장된 XLSX 데이터는 삭제되지 않습니다."))return;
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
  var base=activeScanRect(video),regions=[base];
  function centered(name,wr,hr){
    var w=Math.max(80,Math.floor(base.w*wr)),h=Math.max(80,Math.floor(base.h*hr));
    regions.push({name:name,x:Math.floor(base.x+(base.w-w)/2),y:Math.floor(base.y+(base.h-h)/2),w:w,h:h});
  }
  if(state.scanMode==="barcode"){
    centered("1D-중앙",0.88,0.78);centered("1D-소형확대",0.62,0.68);
  }else if(state.scanMode==="qr"){
    centered("2D-중앙",0.78,0.78);centered("2D-소형확대",0.52,0.52);
  }else if(state.scanMode==="small"){
    centered("소형-중앙",0.72,0.72);centered("소형-강화",0.48,0.48);centered("소형-가로",0.78,0.42);
  }else{
    centered("자동-중앙",0.82,0.78);centered("자동-소형",0.54,0.58);centered("자동-가로",0.92,0.46);
  }
  return regions;
}
function renderRegion(video,rect,variant){
  var canvas=$("scanCanvas"),ctx=canvas.getContext("2d",{willReadFrequently:true});
  var maxW=state.scanMode==="small"?2200:1800,maxH=state.scanMode==="small"?1600:1350;
  var scale=Math.max(.55,Math.min(state.scanMode==="small"?4.8:3.2,Math.min(maxW/rect.w,maxH/rect.h)));
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
    var key=state.scanMode+"|"+formats.join(",");
    var detector=formats.length?(state.nativeDetectors[key]||(state.nativeDetectors[key]=new BarcodeDetector({formats:formats}))):state.nativeDetector;
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
  return r&&r.text&&r.isValid!==false?{text:r.text,format:r.format||r.symbology||"ZXing",symbology:r.symbology,engine:"ZXing-C++",isValid:r.isValid!==false,orientation:r.orientation}:null;
}
function renderFastRegion(video){
  var cfg=profileConfig(),rect=activeScanRect(video),maxWidth=isAndroidDevice()?Math.max(1600,cfg.maxFastWidth):cfg.maxFastWidth;
  var scale=Math.max(.45,Math.min(state.scanMode==="small"?3.2:2.2,maxWidth/rect.w));
  var tw=Math.max(480,Math.floor(rect.w*scale)),th=Math.max(240,Math.floor(rect.h*scale));
  var canvas=$("scanCanvas"),ctx=canvas.getContext("2d",{willReadFrequently:true});canvas.width=tw;canvas.height=th;ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";ctx.drawImage(video,rect.x,rect.y,rect.w,rect.h,0,0,tw,th);
  return {canvas:canvas,imageData:ctx.getImageData(0,0,tw,th),label:"고속 중앙/원본"};
}
function renderAutoFastRegions(video){
  var cfg=profileConfig(),base=activeScanRect(video);
  function capture(key,rx,ry,rw,rh,minW,minH){
    var maxWidth=isAndroidDevice()?Math.max(1600,cfg.maxFastWidth):cfg.maxFastWidth;
    var scale=Math.max(.45,Math.min(2.8,maxWidth/rw)),tw=Math.max(minW,Math.floor(rw*scale)),th=Math.max(minH,Math.floor(rh*scale));
    var c=state.autoCanvases[key]||(state.autoCanvases[key]=document.createElement("canvas")),x=c.getContext("2d",{willReadFrequently:true});c.width=tw;c.height=th;
    x.imageSmoothingEnabled=true;x.imageSmoothingQuality="high";x.drawImage(video,rx,ry,rw,rh,0,0,tw,th);return {canvas:c,imageData:x.getImageData(0,0,tw,th)};
  }
  var bw=base.w,bh=state.scanMode==="auto"?Math.max(120,Math.floor(base.h*.52)):base.h,bx=base.x,by=Math.floor(base.y+(base.h-bh)/2);
  var qs=Math.floor(Math.min(base.w,base.h)),qx=Math.floor(base.x+(base.w-qs)/2),qy=Math.floor(base.y+(base.h-qs)/2);
  var full=capture("full",base.x,base.y,base.w,base.h,480,280);
  var barcode=capture("barcode",bx,by,bw,bh,640,240);
  var verticalCanvas=state.autoCanvases.barcodeVertical||(state.autoCanvases.barcodeVertical=document.createElement("canvas"));
  var verticalContext=verticalCanvas.getContext("2d",{willReadFrequently:true});
  verticalCanvas.width=full.canvas.height;verticalCanvas.height=full.canvas.width;
  verticalContext.setTransform(0,1,-1,0,verticalCanvas.width,0);
  verticalContext.drawImage(full.canvas,0,0);
  verticalContext.setTransform(1,0,0,1,0,0);
  var vertical={canvas:verticalCanvas,imageData:verticalContext.getImageData(0,0,verticalCanvas.width,verticalCanvas.height)};
  return {full:full,barcode:barcode,barcodeVertical:vertical,qr:capture("qr",qx,qy,qs,qs,420,420)};
}
function rotateFastFrame(frame,key){
  var canvas=state.autoCanvases[key]||(state.autoCanvases[key]=document.createElement("canvas")),ctx=canvas.getContext("2d",{willReadFrequently:true});
  canvas.width=frame.canvas.height;canvas.height=frame.canvas.width;
  ctx.setTransform(0,1,-1,0,canvas.width,0);ctx.drawImage(frame.canvas,0,0);ctx.setTransform(1,0,0,1,0,0);
  return {canvas:canvas,imageData:ctx.getImageData(0,0,canvas.width,canvas.height)};
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
  if(cfg.qualitySkip&&(state.quality.brightness<30||state.quality.sharpness<3))return;
  state.lastDecodeAt=now;state.decodeBusy=true;state.decodeAttempts++;var started=performance.now();
  try{
    setScannerStatus(stageLabel(state.stage)+" 인식 대기 · 고속 병렬 판독 · 시도 "+state.decodeAttempts,"ready");
    var fastResults;
    if(state.scanMode==="auto"){
      var autoFrames=renderAutoFastRegions(video);
      var oneDOptions={formats:["Code128","Code93","Code39","ITF","EAN13","EAN8","UPCA","UPCE"],tryHarder:true,tryRotate:false,tryInvert:false,tryDenoise:false,tryDownscale:true,downscaleFactor:1.35,downscaleThreshold:720,maxNumberOfSymbols:1,minLineCount:1,returnErrors:false,textMode:"Plain",eanAddOnSymbol:"Read"};
      function firstZXing(rs,engine){var r=rs&&rs.find(function(x){return x&&x.text&&!x.error&&x.isValid!==false;});return r?{text:r.text,format:r.format||r.symbology||"ZXing",engine:engine,isValid:r.isValid!==false,orientation:r.orientation}:null;}
      fastResults=await Promise.all([
        decodeWithNative(autoFrames.full.canvas),
        window.ZXingWASM.readBarcodes(autoFrames.barcode.imageData,oneDOptions).then(function(rs){return firstZXing(rs,"ZXing-1D-H");}),
        window.ZXingWASM.readBarcodes(autoFrames.barcodeVertical.imageData,oneDOptions).then(function(rs){return firstZXing(rs,"ZXing-1D-V");}),
        window.ZXingWASM.readBarcodes(autoFrames.qr.imageData,{formats:["QRCode","DataMatrix","MicroQRCode","RMQRCode"],tryHarder:true,tryRotate:true,tryInvert:true,tryDenoise:true,tryDownscale:true,downscaleFactor:1.35,downscaleThreshold:720,maxNumberOfSymbols:1,minLineCount:1,returnErrors:false,textMode:"Plain"}).then(function(rs){return firstZXing(rs,"ZXing-2D");})
      ]);
    }else{
      var fastFrame=renderFastRegion(video);
      if(state.scanMode==="barcode"){
        var rotatedFastFrame=rotateFastFrame(fastFrame,"barcodeModeVertical");
        fastResults=await Promise.all([decodeWithNative(fastFrame.canvas),decodeWithZXing(fastFrame.imageData,false),decodeWithZXing(rotatedFastFrame.imageData,false)]);
      }else fastResults=await Promise.all([decodeWithNative(fastFrame.canvas),decodeWithZXing(fastFrame.imageData,false)]);
    }
    var fastHits=0;
    for(var fr=0;fr<fastResults.length&&!state.scanLocked;fr++){
      var fastResult=fastResults[fr];if(!fastResult)continue;fastHits++;
      if(fastResult.engine==="Native")state.nativeHit={value:normalizeDecodedValue(fastResult.text),at:Date.now()};else state.zxingHit={value:normalizeDecodedValue(fastResult.text),at:Date.now()};
      onScan(fastResult.text,fastResult);
    }
    if(fastHits){
      state.fastMissSince=performance.now();
    }else if(now-state.fastMissSince>=cfg.preciseAfter&&state.decodeAttempts%cfg.preciseEvery===0){
      var regions=getRegionRects(video),rect1=regions[state.regionIndex++%regions.length],rect2=regions[state.regionIndex++%regions.length],variant=state.variantIndex++%4;
      var f1=renderRegion(video,rect1,variant),copy=state.preciseCopyCanvas||(state.preciseCopyCanvas=document.createElement("canvas")),cx=copy.getContext("2d",{willReadFrequently:true});copy.width=f1.canvas.width;copy.height=f1.canvas.height;cx.drawImage(f1.canvas,0,0);var img1=cx.getImageData(0,0,copy.width,copy.height);
      var f2=renderRegion(video,rect2,(variant+1)%4);
      setScannerStatus(stageLabel(state.stage)+" 정밀 보강 탐색 · 2영역 병렬 · 시도 "+state.decodeAttempts,"ready");
      var results=await Promise.all([decodeWithZXing(img1,true),decodeWithZXing(f2.imageData,true)]);
      for(var i=0;i<results.length&&!state.scanLocked;i++){var result=results[i];if(result){state.zxingHit={value:normalizeDecodedValue(result.text),at:Date.now()};onScan(result.text,result);}}
    }
  }catch(e){state.decodeErrors++;state.lastDecodeError=e&&e.message||String(e);if(state.decodeErrors<4||state.decodeErrors%20===0)console.warn("decode error",e);}
  finally{recordDecodeTime(performance.now()-started);state.decodeBusy=false;}
}

function scanningLoop(){if(!state.scanning)return;decodeFrame();state.animationId=requestAnimationFrame(scanningLoop);}

function chooseRearCamera(devices){
  var videos=devices.filter(function(d){return d.kind==="videoinput";});
  var rear=videos.find(function(d){
    var label=d.label||"";
    return /back|rear|environment|후면|후방/i.test(label)&&!/ultra|macro|tele|depth|wide angle|초광각|망원|접사/i.test(label);
  });
  if(!rear)rear=videos.find(function(d){return /back|rear|environment|후면|후방/i.test(d.label||"");});
  return rear||videos[videos.length-1]||null;
}
function cameraLabelScore(label){
  var value=String(label||"");
  var score=0;
  if(/back|rear|environment|후면|후방/i.test(value))score+=80;
  if(/front|user|전면|셀피/i.test(value))score-=1000;
  if(/main|primary|기본|주 카메라/i.test(value))score+=45;
  if(/ultra|macro|tele|depth|wide angle|초광각|망원|접사|심도/i.test(value))score-=80;
  return score;
}
function waitMs(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});}
async function measureCameraPreview(stream){
  var video=null;
  try{
    video=document.createElement("video");
    video.muted=true;video.playsInline=true;video.autoplay=true;video.srcObject=stream;
    await video.play();
    var started=Date.now();
    while((!video.videoWidth||video.readyState<2)&&Date.now()-started<900)await waitMs(60);
    if(!video.videoWidth)return {sharpness:0,brightness:0};
    await waitMs(380);
    var canvas=document.createElement("canvas"),w=180,h=120;canvas.width=w;canvas.height=h;
    var ctx=canvas.getContext("2d",{willReadFrequently:true}),scores=[],brightnessValues=[];
    for(var sample=0;sample<3;sample++){
      var sourceWidth=video.videoWidth*.62,sourceHeight=video.videoHeight*.62;
      var sourceX=(video.videoWidth-sourceWidth)/2,sourceY=(video.videoHeight-sourceHeight)/2;
      ctx.drawImage(video,sourceX,sourceY,sourceWidth,sourceHeight,0,0,w,h);
      var data=ctx.getImageData(0,0,w,h).data,sum=0,edge=0,count=w*h;
      for(var i=0;i<data.length;i+=4)sum+=data[i]+data[i+1]+data[i+2];
      for(var y=1;y<h;y++)for(var x=1;x<w;x++){
        var a=(y*w+x)*4,left=(y*w+x-1)*4,up=((y-1)*w+x)*4;
        var gray=(data[a]+data[a+1]+data[a+2])/3;
        edge+=Math.abs(gray-(data[left]+data[left+1]+data[left+2])/3)+Math.abs(gray-(data[up]+data[up+1]+data[up+2])/3);
      }
      scores.push(edge/(count*2));brightnessValues.push(sum/(count*3));
      await waitMs(110);
    }
    scores.sort(function(a,b){return a-b;});brightnessValues.sort(function(a,b){return a-b;});
    return {sharpness:scores[1]||0,brightness:brightnessValues[1]||0};
  }catch(e){
    console.warn("camera preview measurement failed",e);
    return {sharpness:0,brightness:0};
  }finally{
    if(video){video.pause();video.srcObject=null;}
  }
}
async function inspectRearCamera(device){
  var stream=null;
  try{
    stream=await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{deviceId:{exact:device.deviceId},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}}
    });
    var track=stream.getVideoTracks()[0];
    if(!track)return null;
    var caps=track.getCapabilities?track.getCapabilities():{};
    var settings=track.getSettings?track.getSettings():{};
    var modes=Array.isArray(caps.focusMode)?caps.focusMode:[];
    var supported=navigator.mediaDevices.getSupportedConstraints?navigator.mediaDevices.getSupportedConstraints():{};
    if(supported.pointsOfInterest){
      try{await track.applyConstraints({advanced:[{pointsOfInterest:[{x:.5,y:.5}]}]});}catch(e){}
    }
    if(modes.indexOf("continuous")>=0){
      try{await track.applyConstraints({advanced:[{focusMode:"continuous"}]});}catch(e){}
    }else if(modes.indexOf("single-shot")>=0){
      try{await track.applyConstraints({advanced:[{focusMode:"single-shot"}]});}catch(e){}
    }
    var measured=await measureCameraPreview(stream);
    var score=cameraLabelScore(device.label);
    if(settings.facingMode==="environment")score+=120;
    if(settings.facingMode==="user")score-=1000;
    if(modes.indexOf("continuous")>=0)score+=260;
    if(modes.indexOf("single-shot")>=0)score+=100;
    if(caps.focusDistance&&Number(caps.focusDistance.max)>Number(caps.focusDistance.min))score+=70;
    if(caps.torch===true||Array.isArray(caps.torch)&&caps.torch.indexOf(true)>=0)score+=35;
    if(caps.zoom&&Number(caps.zoom.max)>1)score+=Math.min(35,Math.round(Number(caps.zoom.max)*3));
    if(measured.brightness>=25&&measured.brightness<=235)score+=Math.min(300,Math.round(measured.sharpness*18));
    return {device:device,score:score,focusModes:modes,sharpness:measured.sharpness,brightness:measured.brightness};
  }catch(e){
    console.warn("camera probe failed",device.label||device.deviceId,e);
    return null;
  }finally{
    if(stream)stream.getTracks().forEach(function(track){track.stop();});
  }
}
async function selectBestRearCamera(devices){
  var videos=devices.filter(function(d){return d.kind==="videoinput";});
  if(!isAndroidDevice()||videos.length<2)return null;
  var cached=videos.find(function(d){return d.deviceId===state.autoSelectedCameraId;});
  if(cached)return cached;
  var candidates=videos.filter(function(d){return !/front|user|전면|셀피/i.test(d.label||"");});
  if(!candidates.length)candidates=videos;
  setScannerStatus("자동초점이 지원되는 기본 후면 카메라를 찾고 있습니다.");
  var best=null;
  for(var i=0;i<candidates.length;i++){
    setScannerStatus("기본 후면 카메라 자동 점검 중 · "+(i+1)+"/"+candidates.length);
    var result=await inspectRearCamera(candidates[i]);
    if(result&&(!best||result.score>best.score))best=result;
    await waitMs(90);
  }
  if(best&&best.score>-500){
    state.autoSelectedCameraId=best.device.deviceId;
    console.info("auto rear camera selected",best.device.label||best.device.deviceId,best.focusModes,best.score,best.sharpness);
    return best.device;
  }
  return chooseRearCamera(devices);
}
function populateCameraSelect(devices,selectedId){
  state.videoDevices=devices.filter(function(d){return d.kind==="videoinput";});var sel=$("cameraSelect");sel.innerHTML="";
  var auto=document.createElement("option");auto.value="";auto.textContent="후면 카메라 자동 선택";sel.appendChild(auto);
  state.videoDevices.forEach(function(d,i){var o=document.createElement("option");o.value=d.deviceId;o.textContent=d.label||("카메라 "+(i+1));sel.appendChild(o);});
  sel.value=selectedId||"";
}
function focusPointFromPointer(event){
  var video=$("scannerVideo"),wrap=$("readerWrap");
  if(!video||!wrap||!video.videoWidth||!video.videoHeight)return null;
  var rect=wrap.getBoundingClientRect(),scale=Math.max(rect.width/video.videoWidth,rect.height/video.videoHeight);
  var renderedWidth=video.videoWidth*scale,renderedHeight=video.videoHeight*scale;
  var cropX=(renderedWidth-rect.width)/2,cropY=(renderedHeight-rect.height)/2;
  return {
    x:Math.max(0,Math.min(1,((event.clientX-rect.left)+cropX)/renderedWidth)),
    y:Math.max(0,Math.min(1,((event.clientY-rect.top)+cropY)/renderedHeight)),
    left:Math.max(0,Math.min(rect.width,event.clientX-rect.left)),
    top:Math.max(0,Math.min(rect.height,event.clientY-rect.top))
  };
}
function showFocusPoint(point){
  var marker=$("tapFocusMarker");if(!marker||!point)return;
  marker.style.left=point.left+"px";marker.style.top=point.top+"px";
  marker.classList.remove("focus-visible");void marker.offsetWidth;marker.classList.add("focus-visible");
  clearTimeout(showFocusPoint.t);showFocusPoint.t=setTimeout(function(){marker.classList.remove("focus-visible");},900);
}
async function requestFocus(point){
  var info=state.cameraCapabilities;if(!info||!info.track)return false;var caps=info.caps||{};
  try{
    var modes=Array.isArray(caps.focusMode)?caps.focusMode:[];
    var supported=navigator.mediaDevices&&navigator.mediaDevices.getSupportedConstraints?navigator.mediaDevices.getSupportedConstraints():{};
    var pointApplied=false;
    if(supported.pointsOfInterest){
      try{await info.track.applyConstraints({advanced:[{pointsOfInterest:[{x:point&&Number.isFinite(point.x)?point.x:.5,y:point&&Number.isFinite(point.y)?point.y:.5}]}]});pointApplied=true;}catch(e){}
    }
    var canTryFocus=modes.length||supported.focusMode||pointApplied;
    if(!canTryFocus)return false;
    if(modes.indexOf("single-shot")>=0){
      await info.track.applyConstraints({advanced:[{focusMode:"single-shot"}]});
      if(modes.indexOf("continuous")>=0)setTimeout(function(){
        if(info.track.readyState==="live")info.track.applyConstraints({advanced:[{focusMode:"continuous"}]}).catch(function(){});
      },450);
    }else if(modes.indexOf("continuous")>=0||supported.focusMode){
      await info.track.applyConstraints({advanced:[{focusMode:"continuous"}]});
    }
    state.focusPending=true;text("qualityStatus","초점을 빠르게 맞추는 중입니다. 잠시 고정하세요.");$("qualityStatus").className="quality-status warn";
    setTimeout(function(){state.focusPending=false;},650);return true;
  }catch(e){console.warn("focus unsupported",e);return false;}
}
function clearAutoFocusMonitor(){
  if(state.autoFocusTimer)clearInterval(state.autoFocusTimer);
  state.autoFocusTimer=0;state.autoFocusSupported=false;state.focusPending=false;state.androidBlurCount=0;state.androidFocusKickCount=0;state.lastAndroidFocusKick=0;
}
async function maintainContinuousFocus(force){
  if(!state.autoFocusEnabled)return false;
  var info=state.cameraCapabilities;if(!info||!info.track||info.track.readyState==="ended")return false;
  var caps=info.caps||{},settings=info.track.getSettings?info.track.getSettings():{},focusModes=Array.isArray(caps.focusMode)?caps.focusMode:[];
  var supported=navigator.mediaDevices&&navigator.mediaDevices.getSupportedConstraints?navigator.mediaDevices.getSupportedConstraints():{};
  state.autoFocusSupported=focusModes.indexOf("continuous")>=0||(!focusModes.length&&!!supported.focusMode);
  async function applyOne(name,value){
    try{var item={};item[name]=value;await info.track.applyConstraints({advanced:[item]});return true;}
    catch(e){console.warn(name+" camera control unsupported",e);return false;}
  }
  if(state.autoFocusSupported&&(force||settings.focusMode!=="continuous")){
    state.autoFocusSupported=await applyOne("focusMode","continuous");
  }
  if(Array.isArray(caps.exposureMode)&&caps.exposureMode.indexOf("continuous")>=0&&(force||settings.exposureMode!=="continuous"))await applyOne("exposureMode","continuous");
  if(Array.isArray(caps.whiteBalanceMode)&&caps.whiteBalanceMode.indexOf("continuous")>=0&&(force||settings.whiteBalanceMode!=="continuous"))await applyOne("whiteBalanceMode","continuous");
  return state.autoFocusSupported;
}
async function disableAutomaticFocus(){
  clearAutoFocusMonitor();
  var info=state.cameraCapabilities;if(!info||!info.track||info.track.readyState==="ended")return false;
  var modes=Array.isArray((info.caps||{}).focusMode)?info.caps.focusMode:[];
  var mode=modes.indexOf("manual")>=0?"manual":modes.indexOf("fixed")>=0?"fixed":"";
  if(!mode)return false;
  try{await info.track.applyConstraints({advanced:[{focusMode:mode}]});return true;}catch(e){console.warn("focus off unsupported",e);return false;}
}
function isAndroidDevice(){return /Android/i.test(navigator.userAgent||"");}
async function startAutoFocusMonitor(){
  clearAutoFocusMonitor();
  if(!state.autoFocusEnabled){updateFocusControl(false,false);return false;}
  var supported=await maintainContinuousFocus(true);
  updateFocusControl(supported,false);
  text("qualityStatus",supported?"연속 자동초점 활성 · 코드를 중앙에 맞춰 주세요.":"기기 기본 자동초점 활성 · 코드를 중앙에 맞춰 주세요.");
  $("qualityStatus").className="quality-status good";
  if(isAndroidDevice()){
    setTimeout(function(){if(state.scanning&&state.autoFocusEnabled)requestFocus();},450);
    setTimeout(function(){if(state.scanning&&state.autoFocusEnabled)maintainContinuousFocus(true);},1300);
  }
  state.autoFocusTimer=setInterval(function(){
    if(!state.scanning||!state.autoFocusEnabled)return;
    maintainContinuousFocus(false);
    if(isAndroidDevice()){
      var quality=state.quality||{},usableLight=quality.brightness>=35&&quality.brightness<=230;
      if(usableLight&&quality.sharpness>0&&quality.sharpness<7)state.androidBlurCount++;
      else state.androidBlurCount=0;
      var now=Date.now();
      if(state.androidBlurCount>=2&&state.androidFocusKickCount<6&&now-state.lastAndroidFocusKick>2200){
        state.androidBlurCount=0;state.androidFocusKickCount++;state.lastAndroidFocusKick=now;requestFocus();
      }
    }
  },1200);
}
async function startScanner(){
  if(state.scanning)return;
  openScannerModal();updateModeUI();resetCandidates();setScannerStatus("ZXing-C++ WASM 엔진을 준비하고 있습니다.");
  try{
    await ensureScannerLibrary();if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error("카메라 API 미지원");
    if(!state.videoDevices.length){var permission=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});permission.getTracks().forEach(function(t){t.stop();});await waitMs(120);}
    var devices=await navigator.mediaDevices.enumerateDevices();populateCameraSelect(devices,state.selectedCameraId);
    var chosen=state.selectedCameraId
      ?state.videoDevices.find(function(d){return d.deviceId===state.selectedCameraId;})
      :await selectBestRearCamera(devices);
    var videoConstraints=chosen
      ?{deviceId:{exact:chosen.deviceId},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}}
      :{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}};
    var constraints={audio:false,video:videoConstraints};
    try{
      state.stream=await navigator.mediaDevices.getUserMedia(constraints);
    }catch(cameraError){
      if(state.selectedCameraId||!chosen)throw cameraError;
      state.autoSelectedCameraId="";
      state.stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}}});
    }
    var video=$("scannerVideo");video.srcObject=state.stream;await video.play();
    state.scanning=true;state.scanLocked=false;state.decodeBusy=false;state.frameIndex=0;state.decodeAttempts=0;state.decodeErrors=0;state.regionIndex=0;state.variantIndex=0;state.lastDecodeError="";state.scanStartedAt=performance.now();state.fastMissSince=state.scanStartedAt;state.decodeTimes=[];state.lastFrameSignature=null;state.nativeHit=null;state.zxingHit=null;
    setScannerStatus(stageLabel(state.stage)+" 인식 대기 · "+(state.autoFocusEnabled?"자동초점":"자동초점 OFF")+" · 다중 프레임 검증","ready");setupCameraControls();await startAutoFocusMonitor();scanningLoop();
  }catch(err){console.error(err);state.scanning=false;setScannerStatus("카메라 또는 WASM 엔진을 실행하지 못했습니다: "+(err.message||err),"error");}
}
function stopScanner(closeModal){
  if(state.animationId)cancelAnimationFrame(state.animationId);
  clearAutoFocusMonitor();state.animationId=0;state.scanning=false;state.decodeBusy=false;state.scanLocked=false;resetCandidates();
  if(state.stream){state.stream.getTracks().forEach(function(t){t.stop();});state.stream=null;}
  var video=$("scannerVideo");if(video)video.srcObject=null;
  hide("torchBtn");hide("zoomWrap");
  if(closeModal!==false){state.autoFocusEnabled=true;closeScannerModal();}
  return Promise.resolve();
}

function download(name,content,type){
  var blob=new Blob([content],{type:type}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
function buildXlsxPackage(filterType){
  var exportRecords=state.records.filter(function(r){return !filterType||(r.workType||"신규 증설")===filterType;});
  if(!exportRecords.length){toast("선택한 작업유형에 내보낼 데이터가 없습니다.");return null;}
  if(!window.XLSX||!XLSX.utils||typeof XLSX.write!=="function"){toast("XLSX 저장 모듈을 불러오지 못했습니다. 인터넷 연결 후 다시 시도해 주세요.");return null;}
  var relocation=filterType==="재배치";
  var heads=relocation
    ?["인프라","설치국사","적용망","실장슬롯","파장","모듈","(인계지역→인수지역)","바코드","(인계지역→인수지역)","인프라","설치국사","적용망","실장슬롯","파장 (CH)","구축일시"]
    :["링명","설치국사","인프라","공사번호","국사바코드","TID","랙 바코드","셀프 바코드","실장슬롯","파장","실장 품목","부속바코드번호","구축일시","작업자","비고"];
  var rows=relocation
    ?[["재배치 전 사용 내역","","","","","","LG CNS 실적 자산인계 내역","","LG U+ 원 요청내역","재배치 후 사용 내역","","","","",""],heads]
    :[heads];
  exportRecords.forEach(function(r,i){
    rows.push(relocation
      ?[
        "",r.beforeOffice||"",r.beforeRing||"",r.beforeSlot||"",r.beforeWavelength||"",r.unitName||"",
        "",r.unitBarcode||"","",
        "",r.afterOffice||"",r.afterRing||"",r.afterSlot||"",r.afterWavelength||"",r.createdAt||""
      ]
      :[
        r.ring||"",r.office||"",
        "","","","",
        r.rack||"",r.shelf||"",r.slotNumber||"",r.wavelength||"",r.unitName||"",r.slot||"",
        r.createdAt||"","",r.memo||""
      ]);
  });
  var sheet=XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"]=(relocation
    ?[12,16,24,12,12,16,24,22,24,12,16,24,12,13,18]
    :[18,16,12,14,16,18,18,18,12,10,28,20,18,12,28]).map(function(width){return {wch:width};});
  sheet["!rows"]=relocation?[{hpt:24},{hpt:30}]:[{hpt:30}];
  if(relocation){
    sheet["!merges"]=[
      XLSX.utils.decode_range("A1:F1"),
      XLSX.utils.decode_range("G1:H1"),
      XLSX.utils.decode_range("J1:O1")
    ];
  }
  var headerRow=relocation?1:0;
  sheet["!autofilter"]={ref:XLSX.utils.encode_range({s:{r:headerRow,c:0},e:{r:rows.length-1,c:heads.length-1}})};
  var thin={style:"thin",color:{rgb:"404040"}};
  var baseStyle={
    font:{name:"맑은 고딕",sz:10},
    alignment:{horizontal:"center",vertical:"center",wrapText:true},
    border:{top:thin,bottom:thin,left:thin,right:thin}
  };
  var palette={
    grey:"D9E1F2",yellow:"FFFF00",
    blueHeader:"9DC3E6",blueBody:"DDEBF7",
    pinkHeader:"E6B8B7",pinkBody:"FCE4D6",white:"FFFFFF"
  };
  function styled(fill,bold){
    return {
      font:{name:"맑은 고딕",sz:10,bold:!!bold},
      alignment:baseStyle.alignment,
      border:baseStyle.border,
      fill:{patternType:"solid",fgColor:{rgb:fill}}
    };
  }
  for(var rowIndex=0;rowIndex<rows.length;rowIndex++){
    for(var columnIndex=0;columnIndex<heads.length;columnIndex++){
      var address=XLSX.utils.encode_cell({r:rowIndex,c:columnIndex});
      if(!sheet[address])sheet[address]={t:"s",v:""};
      if(!relocation){
        sheet[address].s=styled(columnIndex===11?palette.yellow:palette.grey,rowIndex===0);
        if(rowIndex>0&&columnIndex!==11)sheet[address].s=Object.assign({},baseStyle);
      }else{
        var isHeader=rowIndex<2;
        var fill=columnIndex<=5?(isHeader?palette.blueHeader:palette.blueBody)
          :columnIndex===7&&rowIndex>1?palette.yellow
          :columnIndex>=9?(isHeader?palette.pinkHeader:palette.pinkBody)
          :palette.white;
        sheet[address].s=styled(fill,isHeader);
      }
    }
  }
  var workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,sheet,relocation?"재배치":"신규증설");
  var content=XLSX.write(workbook,{bookType:"xlsx",type:"array",compression:true,cellStyles:true});
  var fileType=filterType==="재배치"?"재배치":"신규증설";
  var now=new Date();
  var dateText=String(now.getFullYear())+String(now.getMonth()+1).padStart(2,"0")+String(now.getDate()).padStart(2,"0");
  var seqKey="assetBarcodeXlsxSeq:"+fileType+":"+dateText;
  var sequence=parseInt(localStorage.getItem(seqKey)||"0",10)+1;
  return {fileType:fileType,dateText:dateText,seqKey:seqKey,sequence:sequence,fileName:fileType+"_자산바코드_"+dateText+"-"+sequence+".xlsx",content:content};
}
function commitXlsxSequence(pkg){localStorage.setItem(pkg.seqKey,String(pkg.sequence));}
function exportXLSX(filterType){
  var pkg=buildXlsxPackage(filterType);if(!pkg)return;
  download(pkg.fileName,pkg.content,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  commitXlsxSequence(pkg);
}
function shareValue(value){return clean(value)||"-";}
function buildShareText(filterType){
  var relocation=filterType==="재배치";
  var records=state.records.filter(function(r){return (r.workType||"신규 증설")===(relocation?"재배치":"신규 증설");});
  if(!records.length){toast("선택한 작업유형에 공유할 데이터가 없습니다.");return "";}
  var lines=["["+(relocation?"재배치":"신규 증설")+" 자산바코드]","총 "+records.length+"건"];
  records.forEach(function(r,i){
    lines.push("","No. "+(i+1));
    if(relocation){
      lines.push(
        "재배치 전 국사: "+shareValue(r.beforeOffice),
        "재배치 전 링명: "+shareValue(r.beforeRing),
        "재배치 전 슬롯: "+shareValue(r.beforeSlot),
        "재배치 전 파장: "+shareValue(r.beforeWavelength),
        "장비 카테고리: "+shareValue(r.unitCategory),
        "유니트명: "+shareValue(r.unitName),
        "유니트바코드: "+shareValue(r.unitBarcode),
        "재배치 후 국사: "+shareValue(r.afterOffice),
        "재배치 후 링명: "+shareValue(r.afterRing),
        "재배치 후 슬롯: "+shareValue(r.afterSlot),
        "재배치 후 파장: "+shareValue(r.afterWavelength),
        "비고: "+shareValue(r.memo),
        "등록시각: "+shareValue(r.createdAt)
      );
    }else{
      lines.push(
        "링명: "+shareValue(r.ring),
        "국사명: "+shareValue(r.office),
        "Rack: "+shareValue(r.rack),
        "Shelf: "+shareValue(r.shelf),
        "Slot 바코드: "+shareValue(r.slot),
        "Slot Number: "+shareValue(r.slotNumber),
        "파장: "+shareValue(r.wavelength),
        "장비 카테고리: "+shareValue(r.unitCategory),
        "유니트명: "+shareValue(r.unitName),
        "비고: "+shareValue(r.memo),
        "등록시각: "+shareValue(r.createdAt)
      );
    }
  });
  return lines.join("\n");
}
async function copyShareText(content){
  try{
    if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(content);return true;}
  }catch(e){console.warn("clipboard API unavailable",e);}
  try{
    var area=document.createElement("textarea");area.value=content;area.setAttribute("readonly","");area.style.position="fixed";area.style.opacity="0";
    document.body.appendChild(area);area.select();area.setSelectionRange(0,area.value.length);
    var copied=document.execCommand&&document.execCommand("copy");area.remove();return !!copied;
  }catch(err){console.warn("clipboard fallback unavailable",err);return false;}
}
function copyShareTextSync(content){
  try{
    var area=document.createElement("textarea");area.value=content;area.setAttribute("readonly","");
    area.style.position="fixed";area.style.left="-9999px";area.style.opacity="0";
    document.body.appendChild(area);area.focus();area.select();area.setSelectionRange(0,area.value.length);
    var copied=document.execCommand&&document.execCommand("copy");area.remove();return !!copied;
  }catch(err){console.warn("synchronous clipboard fallback unavailable",err);return false;}
}
function canShareData(data){
  try{return !navigator.canShare||navigator.canShare(data);}
  catch(e){console.warn("share capability check failed",e);return false;}
}
function updateShareButtonLabels(){
  var android=isAndroidDevice();
  document.querySelectorAll(".kakao-share").forEach(function(button){
    button.textContent=android?"카카오톡 XLSX 공유+내용 복사":"카카오톡 파일+내용 공유";
  });
}
async function shareRecordText(filterType){
  var content=buildShareText(filterType);if(!content)return;
  var title=(filterType==="재배치"?"재배치":"신규 증설")+" 자산바코드";
  var pkg=buildXlsxPackage(filterType);
  var mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",file=null;
  if(pkg){
    try{file=new File([pkg.content],pkg.fileName,{type:mime});}
    catch(e){console.warn("XLSX share file unavailable",e);}
  }
  if(isAndroidDevice()){
    var androidCopied=copyShareTextSync(content);
    if(file&&navigator.share&&canShareData({files:[file]})){
      try{
        await navigator.share({files:[file]});
        if(!androidCopied)androidCopied=await copyShareText(content);
        commitXlsxSequence(pkg);
        toast(androidCopied?"XLSX를 공유했습니다. 카카오톡 채팅창에 내용을 붙여넣어 주세요.":"XLSX를 공유했지만 내용 복사는 제한되었습니다.");
        return;
      }catch(androidShareError){
        console.warn("Android XLSX file share unavailable",androidShareError);
      }
    }
    if(!androidCopied)androidCopied=await copyShareText(content);
    if(pkg){download(pkg.fileName,pkg.content,mime);commitXlsxSequence(pkg);}
    toast(androidCopied?"XLSX를 저장하고 내용을 복사했습니다. 카카오톡에 파일을 첨부한 뒤 내용을 붙여넣어 주세요.":"XLSX를 저장했지만 내용 복사는 제한되었습니다.");
    return;
  }
  if(!navigator.share){
    var copied=await copyShareText(content);
    if(pkg){download(pkg.fileName,pkg.content,mime);commitXlsxSequence(pkg);}
    toast(copied?"내용을 복사하고 XLSX를 저장했습니다. 카카오톡에 붙여넣어 주세요.":"XLSX를 저장했지만 이 브라우저에서는 내용 공유를 지원하지 않습니다.");
    return;
  }
  var combinedData=file?{title:title,text:content,files:[file]}:null;
  if(combinedData&&canShareData(combinedData)){
    try{
      await navigator.share(combinedData);
      commitXlsxSequence(pkg);
      toast("카카오톡으로 XLSX 파일과 저장 내용을 함께 전달했습니다.");
      return;
    }catch(fileShareError){
      if(fileShareError&&fileShareError.name==="AbortError"){toast("공유를 취소했습니다.");return;}
      console.warn("combined file and text share unavailable",fileShareError);
    }
  }
  try{
    await navigator.share({title:title,text:content});
    if(pkg){download(pkg.fileName,pkg.content,mime);commitXlsxSequence(pkg);}
    toast(pkg?"파일 결합 공유가 제한되어 내용은 공유하고 XLSX는 저장했습니다.":"카카오톡으로 저장 내용을 전달했습니다.");
  }catch(err){
    if(err&&err.name==="AbortError")return;
    console.error(err);
    var copied=await copyShareText(content);
    if(pkg){download(pkg.fileName,pkg.content,mime);commitXlsxSequence(pkg);}
    toast(copied?"공유가 제한되어 내용을 복사하고 XLSX를 저장했습니다. 카카오톡에 붙여넣어 주세요.":"카카오톡 공유를 실행하지 못해 XLSX만 저장했습니다.");
  }
}


$("newInstallModeBtn").addEventListener("click",function(){selectWorkMode("new");});
$("relocationModeBtn").addEventListener("click",function(){selectWorkMode("relocation");});
$("changeModeBtn").addEventListener("click",changeWorkMode);
$("newChangeModeBtn").addEventListener("click",changeWorkMode);
$("scanUnitBarcodeBtn").addEventListener("click",startUnitBarcodeScan);
$("saveRelocationBtn").addEventListener("click",saveRelocation);
$("resetRelocationBtn").addEventListener("click",function(){clearRelocationForm();toast("재배치 입력값을 초기화했습니다.");});
$("relocationUnitCategory").addEventListener("change",function(){populateRelocationUnitNames();});
$("unitBarcode").addEventListener("input",function(){this.value=this.value.toUpperCase().replace(/[\u0000-\u001F\u007F]/g,"").slice(0,128);});
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
$("performanceProfile").addEventListener("change",function(){state.performanceProfile=this.value;resetCandidates();state.scanStartedAt=performance.now();state.fastMissSince=state.scanStartedAt;state.decodeTimes=[];text("performanceStatus","프로필 변경 적용 중");});
$("cameraSelect").addEventListener("change",function(){
  state.selectedCameraId=this.value;
  if(!state.selectedCameraId)state.autoSelectedCameraId="";
  stopScanner(false).then(startScanner);
});
$("readerWrap").addEventListener("pointerup",async function(event){
  if(!state.scanning||!state.autoFocusEnabled||state.focusPending||event.isPrimary===false)return;
  var point=focusPointFromPointer(event);if(!point)return;
  showFocusPoint(point);
  var focused=await requestFocus(point);
  if(!focused)focused=await requestFocus();
  if(focused){
    setScannerStatus(stageLabel(state.stage)+" 터치 초점 적용 · 다중 프레임 검증","ready");
    setTimeout(function(){if(state.scanning)maintainContinuousFocus(true);},700);
  }else{
    await maintainContinuousFocus(true);
    text("qualityStatus","기기 기본 자동초점으로 중앙을 다시 맞춥니다.");$("qualityStatus").className="quality-status good";
  }
});
$("focusBtn").addEventListener("click",async function(){
  if(state.autoFocusEnabled){
    state.autoFocusEnabled=false;updateFocusControl(false,false);
    var disabled=await disableAutomaticFocus();
    text("qualityStatus",disabled?"자동 초점을 껐습니다.":"앱 자동초점 보정을 껐습니다.");$("qualityStatus").className="quality-status";
    setScannerStatus(stageLabel(state.stage)+" 인식 대기 · 자동초점 OFF · 다중 프레임 검증","ready");
    toast(disabled?"자동 초점을 껐습니다.":"앱의 자동초점 보정을 껐습니다.");
  }else{
    state.autoFocusEnabled=true;updateFocusControl(false,true);
    var focused=await requestFocus();if(focused)await waitMs(500);
    var continuous=await startAutoFocusMonitor();
    updateFocusControl(continuous||focused,false);
    setScannerStatus(stageLabel(state.stage)+" 인식 대기 · 자동초점 ON · 다중 프레임 검증","ready");
    toast(focused||continuous?"자동 초점을 켰습니다.":"기기 기본 자동초점을 사용합니다.");
  }
});
document.querySelectorAll("#quickZoom button").forEach(function(btn){btn.addEventListener("click",function(){
  if(!state.cameraCapabilities||!state.cameraCapabilities.track)return;var caps=state.cameraCapabilities.caps.zoom||{},v=Math.max(caps.min||1,Math.min(caps.max||1,Number(btn.dataset.zoom)));
  $("zoomSlider").value=v;text("zoomValue",v.toFixed(1)+"×");state.cameraCapabilities.track.applyConstraints({advanced:[{zoom:v}]}).catch(function(){});
});});
$("torchBtn").addEventListener("click",function(){
  if(!state.cameraCapabilities||!state.cameraCapabilities.track)return;
  state.torchOn=!state.torchOn;
  state.cameraCapabilities.track.applyConstraints({advanced:[{torch:state.torchOn}]}).then(function(){
    updateTorchControl();toast(state.torchOn?"카메라 조명을 켰습니다.":"카메라 조명을 껐습니다.");
  }).catch(function(){state.torchOn=false;updateTorchControl();toast("이 기기에서는 조명을 제어할 수 없습니다.");});
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
$("newRecordsTab").addEventListener("click",function(){showRecordPanel("new");});
$("relocationRecordsTab").addEventListener("click",function(){showRecordPanel("relocation");});
$("newPreviewBtn").addEventListener("click",function(){openRecordsPreview("신규 증설");});
$("relocationPreviewBtn").addEventListener("click",function(){openRecordsPreview("재배치");});
$("closeRecordsPreviewBtn").addEventListener("click",closeRecordsPreview);
$("previewBackBtn").addEventListener("click",closeRecordsPreview);
$("recordsPreviewModal").addEventListener("click",function(e){if(e.target===$("recordsPreviewModal"))closeRecordsPreview();});
$("previewCsvBtn").addEventListener("click",function(){exportXLSX(previewFilterType);});
$("previewShareBtn").addEventListener("click",function(){shareRecordText(previewFilterType);});
$("newCsvBtn").addEventListener("click",function(){exportXLSX("신규 증설");});
$("newShareBtn").addEventListener("click",function(){shareRecordText("신규 증설");});
$("relocationCsvBtn").addEventListener("click",function(){exportXLSX("재배치");});
$("relocationShareBtn").addEventListener("click",function(){shareRecordText("재배치");});

function environmentCheck(){
  var okSecure=location.protocol==="https:"||location.hostname==="localhost";
  var okCamera=!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia);
  if(okSecure&&okCamera){text("envStatus","HTTPS 및 카메라 API 사용 가능");$("envStatus").className="status ok";}
  else if(!okSecure){text("envStatus","HTTPS가 아니므로 카메라가 차단될 수 있습니다.");$("envStatus").className="status bad";}
  else{text("envStatus","현재 브라우저에서 카메라 API를 사용할 수 없습니다.");$("envStatus").className="status bad";}
  updateShareButtonLabels();
}
function hasUnsavedWork(){
  if(state.scanning||state.slot||state.rack||state.shelf)return true;
  var ids=state.workMode==="relocation"?
    ["beforeOffice","beforeRing","beforeSlot","beforeWavelength","relocationUnitCategory","relocationUnitName","unitBarcode","afterOffice","afterRing","afterSlot","afterWavelength","relocationMemo"]:
    ["ringName","officeName","wavelength","slotNumber","unitCategory","unitName","memo","manualCode"];
  return ids.some(function(id){var el=$(id);return el&&clean(el.value);});
}
function showUpdateAvailable(worker,remoteVersion){
  pendingServiceWorker=worker||pendingServiceWorker;
  var dirty=hasUnsavedWork();
  text("updateMessage",dirty?"입력 중인 내용이 있습니다. 저장한 뒤 업데이트하세요.":"버전 "+(remoteVersion||"최신")+"을 적용할 수 있습니다.");
  $("applyUpdateBtn").textContent=dirty?"저장 후 업데이트":"지금 업데이트";
  $("updateResetBtn").classList.toggle("hidden",!dirty);
  show("updateBanner");
}
async function resetInputsForUpdate(){
  if(!hasUnsavedWork()){showUpdateAvailable(pendingServiceWorker);return;}
  if(!confirm("입력 중인 내용을 모두 초기화하시겠습니까?\n이미 저장된 신규 증설·재배치 데이터와 XLSX 파일은 삭제되지 않습니다."))return;
  await stopScanner(true);
  if(state.workMode==="relocation"){
    clearRelocationForm();
  }else{
    state.ring="";state.office="";state.rack="";state.shelf="";state.slot="";
    state.skipRack=false;state.skipShelf=false;state.stage="rack";state.started=false;
    ["ringName","officeName","manualCode","slotCode","wavelength","slotNumber","unitCategory","memo"].forEach(function(id){if($(id))$(id).value="";});
    populateUnitNames();$("skipRack").checked=false;$("skipShelf").checked=false;
    hide("workflowSection");hide("slotSection");show("siteSection");show("startWorkBtn");hide("editWorkBtn");
  }
  saveLocal();updateUI();showUpdateAvailable(pendingServiceWorker);
  toast("입력 내용을 초기화했습니다. 이제 업데이트할 수 있습니다.");
}
function activateWaitingWorker(force){
  if(hasUnsavedWork()&&!force){showUpdateAvailable(pendingServiceWorker);toast("입력 내용을 먼저 저장하거나 초기화해 주세요.");return;}
  if(pendingServiceWorker){pendingServiceWorker.postMessage({type:"SKIP_WAITING"});return;}
  location.reload();
}
async function checkAppVersion(){
  if(!navigator.onLine)return;
  try{
    var response=await fetch("./version.json?t="+Date.now(),{cache:"no-store"});
    if(!response.ok)return;
    var remote=await response.json();
    if(remote.version&&remote.version!==APP_VERSION){
      var reg=await navigator.serviceWorker.getRegistration();
      if(reg){
        await reg.update();
        if(reg.waiting)showUpdateAvailable(reg.waiting,remote.version);
        else if(reg.installing){reg.installing.addEventListener("statechange",function(){if(this.state==="installed")showUpdateAvailable(this,remote.version);});}
        else showUpdateAvailable(null,remote.version);
      }else showUpdateAvailable(null,remote.version);
    }
  }catch(e){console.log("업데이트 확인 생략:",e&&e.message||e);}
}
function registerServiceWorker(){
  if(!("serviceWorker" in navigator))return;
  navigator.serviceWorker.addEventListener("controllerchange",function(){
    if(updateReloading)return;updateReloading=true;location.reload();
  });
  navigator.serviceWorker.register("./sw.js",{updateViaCache:"none"}).then(function(reg){
    if(reg.waiting)showUpdateAvailable(reg.waiting);
    reg.addEventListener("updatefound",function(){
      var worker=reg.installing;if(!worker)return;
      worker.addEventListener("statechange",function(){
        if(worker.state==="installed"&&navigator.serviceWorker.controller)showUpdateAvailable(worker);
      });
    });
    reg.update().catch(function(){});
    checkAppVersion();
  }).catch(console.error);
}
$("applyUpdateBtn").addEventListener("click",function(){activateWaitingWorker(false);});
$("updateResetBtn").addEventListener("click",resetInputsForUpdate);
$("dismissUpdateBtn").addEventListener("click",function(){hide("updateBanner");});
window.addEventListener("load",registerServiceWorker);
window.addEventListener("pageshow",function(){checkAppVersion();});
document.addEventListener("visibilitychange",function(){if(!document.hidden)checkAppVersion();});
setInterval(checkAppVersion,5*60*1000);
document.addEventListener("visibilitychange",function(){if(document.hidden)stopScanner(true);});
window.addEventListener("pagehide",function(){stopScanner(true);});

populateUnitNames();populateRelocationUnitNames();restoreLocal();state.workMode="";show("modeGateSection");environmentCheck();updateUI();
ensureScannerLibrary().catch(function(){});
})();
