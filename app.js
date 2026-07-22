
(function(){
"use strict";

var APP_VERSION="8.0.0";
var RECORD_KEY="rss_records_v3";
var CONFIG_KEY="rss_config_v3";

var state={
  started:false, ring:"", office:"", skipRack:false, skipShelf:false,
  rack:"", shelf:"", slot:"", stage:"rack", records:[],
  scanner:null, stream:null, scanning:false, scanMode:"auto", torchOn:false, cameraCapabilities:null, editingStage:null,
  decodeBusy:false, animationId:0, frameIndex:0, lastDecodeAt:0,
  scanLocked:false, lastDecodedValue:"", lastDecodedAt:0
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
function activeFormats(){
  if(state.scanMode==="barcode")return ["AllLinear"];
  if(state.scanMode==="qr")return ["QRCode","MicroQRCode","RMQRCode","DataMatrix","Aztec","PDF417"];
  if(state.scanMode==="small")return ["AllReadable"];
  return ["AllReadable"];
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
  hide("torchBtn");hide("zoomWrap");state.cameraCapabilities=null;
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
      text("zoomValue",Number(initial).toFixed(1)+"×");show("zoomWrap");
      if(initial!==(settings.zoom||min))track.applyConstraints({advanced:[{zoom:initial}]}).catch(function(){});
    }
  }catch(e){console.warn("카메라 제어 미지원",e);}
}

function ensureScannerLibrary(){
  if(window.ZXingWASM && typeof window.ZXingWASM.readBarcodes==="function"){
    try{
      window.ZXingWASM.prepareZXingModule({
        overrides:{
          locateFile:function(path,prefix){
            if(path.endsWith(".wasm")){
              return "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.2/dist/reader/zxing_reader.wasm";
            }
            return prefix+path;
          }
        }
      });
    }catch(e){console.warn("ZXing WASM prepare",e);}
    return Promise.resolve();
  }
  return Promise.reject(new Error("ZXing-C++ WASM 라이브러리를 불러오지 못했습니다. 인터넷 연결 또는 CDN 차단 여부를 확인하세요."));
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
    html+="<tr><td>"+(i+1)+"</td><td>"+esc(r.ring)+"</td><td>"+esc(r.office)+"</td><td>"+esc(r.rack)+"</td><td>"+esc(r.shelf)+"</td><td>"+esc(r.slot)+"</td><td>"+esc(r.wavelength)+"</td><td>"+esc(r.slotNumber)+"</td><td>"+esc(r.unitName)+"</td><td>"+esc(r.memo)+"</td><td>"+esc(r.createdAt)+"</td><td><button class='delete-row' data-index='"+i+"' type='button'>삭제</button></td></tr>";
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
  state.slot="";$("slotCode").value="";$("wavelength").value="";$("slotNumber").value="";$("unitName").value="";$("memo").value="";
  hide("slotSection");setStage("slot");
}
function saveSlot(){
  var slotNo=clean($("slotNumber").value);
  if(!state.slot){toast("Slot 코드를 먼저 등록하세요.");return;}
  if(!/^[0-9A-F][0-9]{2}$/.test(slotNo)){toast("Slot Number는 첫 글자 0~9 또는 A~F, 뒤 두 자리는 숫자여야 합니다.");return;}
  state.records.push({
    id:String(Date.now())+"-"+Math.random().toString(16).slice(2),
    ring:state.ring,office:state.office,
    rack:state.skipRack?"생략":state.rack,
    shelf:state.skipShelf?"생략":state.shelf,
    slot:state.slot,wavelength:clean($("wavelength").value),
    slotNumber:slotNo,unitName:clean($("unitName").value),
    memo:clean($("memo").value),createdAt:new Date().toLocaleString()
  });
  cancelSlot();saveLocal();renderRecords();toast("저장했습니다. 다음 Slot을 스캔하세요.");
}

function onScan(decodedText,decodedResult){
  var value=clean(decodedText);if(!value||state.scanLocked)return;
  state.scanLocked=true;
  var fmt=(decodedResult&&decodedResult.format)||"Barcode/QR";
  setScannerStatus(stageLabel(state.stage)+" 인식 완료 · "+fmt,"success");
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
    ["ringName","officeName","manualCode","slotCode","wavelength","slotNumber","unitName","memo"].forEach(function(id){
      if($(id))$(id).value="";
    });
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
    var direct=await window.ZXingWASM.readBarcodes(file,{formats:activeFormats(),tryHarder:true,tryRotate:true,tryInvert:true,tryDownscale:false,maxNumberOfSymbols:1});
    if(direct&&direct.length)return direct[0];
    var bmp=await createImageBitmap(file),max=3200,scale=Math.min(1,max/Math.max(bmp.width,bmp.height));
    var c=$("scanCanvas"),ctx=c.getContext("2d",{willReadFrequently:true});c.width=Math.floor(bmp.width*scale);c.height=Math.floor(bmp.height*scale);
    ctx.drawImage(bmp,0,0,c.width,c.height);bmp.close&&bmp.close();
    var img=ctx.getImageData(0,0,c.width,c.height);return await decodeImageData(img);
  }).then(function(result){
    if(!result||!result.text)throw new Error("not found");
    return stopScanner(true).then(function(){applyCode(result.text,result.format||"ZXing-C++ 사진",false);});
  }).catch(function(err){console.error(err);setScannerStatus("사진에서 코드를 찾지 못했습니다.","error");toast("사진에서 코드를 인식하지 못했습니다.");})
  .finally(function(){$("photoScanInput").value="";});
}
function getCropRect(video){
  var vw=video.videoWidth,vh=video.videoHeight;
  var ratio=state.scanMode==="small"?0.42:state.scanMode==="barcode"?0.82:state.scanMode==="qr"?0.68:0.82;
  var heightRatio=state.scanMode==="barcode"?0.30:state.scanMode==="small"?0.42:state.scanMode==="qr"?0.72:0.66;
  var w=Math.floor(vw*ratio),h=Math.floor(vh*heightRatio);
  return {x:Math.floor((vw-w)/2),y:Math.floor((vh-h)/2),w:w,h:h};
}
function frameToImageData(video,variant){
  var rect=getCropRect(video),canvas=$("scanCanvas"),ctx=canvas.getContext("2d",{willReadFrequently:true});
  var scale=state.scanMode==="small"?Math.min(4,1800/rect.w):Math.min(2.2,1600/rect.w);
  scale=Math.max(1.25,scale);
  var tw=Math.max(320,Math.floor(rect.w*scale)),th=Math.max(220,Math.floor(rect.h*scale));
  canvas.width=tw;canvas.height=th;ctx.imageSmoothingEnabled=false;
  ctx.drawImage(video,rect.x,rect.y,rect.w,rect.h,0,0,tw,th);
  var image=ctx.getImageData(0,0,tw,th);
  if(variant===1||variant===2){
    var d=image.data;
    for(var i=0;i<d.length;i+=4){
      var g=Math.round(d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114);
      if(variant===1)g=Math.max(0,Math.min(255,(g-128)*1.65+128));
      else g=g>145?255:0;
      d[i]=d[i+1]=d[i+2]=g;
    }
  }
  return image;
}
async function decodeImageData(imageData){
  var options={
    formats:activeFormats(),tryHarder:true,tryRotate:true,tryInvert:true,
    tryDownscale:false,maxNumberOfSymbols:1,returnErrors:false
  };
  var results=await window.ZXingWASM.readBarcodes(imageData,options);
  return results&&results.length?results[0]:null;
}
async function decodeFrame(){
  if(!state.scanning||state.decodeBusy||state.scanLocked)return;
  var video=$("scannerVideo");
  if(!video.videoWidth||video.readyState<2)return;
  var now=performance.now(),interval=state.scanMode==="small"?120:180;
  if(now-state.lastDecodeAt<interval)return;
  state.lastDecodeAt=now;state.decodeBusy=true;
  try{
    var variant=state.frameIndex++%3;
    var result=await decodeImageData(frameToImageData(video,variant));
    if(result&&result.text)onScan(result.text,result);
  }catch(e){console.debug("decode miss",e);}
  finally{state.decodeBusy=false;}
}
function scanningLoop(){
  if(!state.scanning)return;
  decodeFrame();state.animationId=requestAnimationFrame(scanningLoop);
}
function chooseRearCamera(devices){
  var videos=devices.filter(function(d){return d.kind==="videoinput";});
  var rear=videos.find(function(d){return /back|rear|environment|후면|후방/i.test(d.label||"");});
  return rear||videos[videos.length-1]||null;
}
function startScanner(){
  if(state.scanning)return;
  openScannerModal();updateModeUI();setScannerStatus("ZXing-C++ WASM 엔진을 준비하고 있습니다.");
  ensureScannerLibrary().then(async function(){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error("카메라 API 미지원");
    var permission=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
    permission.getTracks().forEach(function(t){t.stop();});
    var devices=await navigator.mediaDevices.enumerateDevices();var rear=chooseRearCamera(devices);
    var constraints={audio:false,video:{
      deviceId:rear?{exact:rear.deviceId}:undefined,facingMode:rear?undefined:{ideal:"environment"},
      width:{ideal:3840,min:1280},height:{ideal:2160,min:720},
      frameRate:{ideal:30,min:15},focusMode:{ideal:"continuous"}
    }};
    state.stream=await navigator.mediaDevices.getUserMedia(constraints);
    var video=$("scannerVideo");video.srcObject=state.stream;await video.play();
    state.scanning=true;state.scanLocked=false;state.decodeBusy=false;state.frameIndex=0;
    setScannerStatus(stageLabel(state.stage)+" 인식 대기 중 · ZXing-C++","ready");
    setupCameraControls();scanningLoop();
  }).catch(function(err){console.error(err);state.scanning=false;setScannerStatus("카메라 또는 WASM 엔진을 실행하지 못했습니다.","error");});
}
function stopScanner(closeModal){
  if(state.animationId)cancelAnimationFrame(state.animationId);
  state.animationId=0;state.scanning=false;state.decodeBusy=false;state.scanLocked=false;
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
  var heads=["No","링명","국사명","Rack","Shelf","Slot","Wavelength","Slot Number","유니트명","비고","등록시각"];
  var lines=[heads.map(csvEscape).join(",")];
  state.records.forEach(function(r,i){
    lines.push([i+1,r.ring,r.office,r.rack,r.shelf,r.slot,r.wavelength,r.slotNumber,r.unitName,r.memo,r.createdAt].map(csvEscape).join(","));
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
    state.scanMode=next;
    updateModeUI();
    setScannerStatus("스캔 모드를 변경하고 카메라를 다시 시작합니다.");
    stopScanner(false).then(startScanner);
  });
});
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

restoreLocal();environmentCheck();updateUI();
ensureScannerLibrary().catch(function(){});
})();
