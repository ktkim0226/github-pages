
(function(){
"use strict";

var APP_VERSION="5.0.0";
var RECORD_KEY="rss_records_v3";
var CONFIG_KEY="rss_config_v3";

var state={
  started:false, ring:"", office:"", skipRack:false, skipShelf:false,
  rack:"", shelf:"", slot:"", stage:"rack", records:[],
  scanner:null, scanning:false, scanMode:"auto", torchOn:false, cameraCapabilities:null,
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
  if(state.scanMode==="barcode"){
    return [
      Html5QrcodeSupportedFormats.CODE_128,Html5QrcodeSupportedFormats.CODE_39,
      Html5QrcodeSupportedFormats.CODE_93,Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,Html5QrcodeSupportedFormats.ITF,
      Html5QrcodeSupportedFormats.CODABAR
    ];
  }
  if(state.scanMode==="qr"){
    return [
      Html5QrcodeSupportedFormats.QR_CODE,Html5QrcodeSupportedFormats.DATA_MATRIX,
      Html5QrcodeSupportedFormats.AZTEC,Html5QrcodeSupportedFormats.PDF_417
    ];
  }
  return undefined; /* 미지정 시 라이브러리가 지원하는 전체 형식을 검사 */
}
function scanRegion(width,height){
  if(state.scanMode==="barcode"){
    return {width:Math.floor(width*.94),height:Math.max(120,Math.floor(height*.28))};
  }
  if(state.scanMode==="qr"){
    var side=Math.floor(Math.min(width*.86,height*.66));
    return {width:side,height:side};
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
      :"코드 하나를 화면 중앙에 크게 맞춰 주세요.");
}
function setupCameraControls(){
  hide("torchBtn");hide("zoomWrap");
  state.cameraCapabilities=null;
  try{
    var caps=state.scanner.getRunningTrackCameraCapabilities();
    state.cameraCapabilities=caps;
    if(caps && caps.torchFeature && caps.torchFeature().isSupported()){
      show("torchBtn");
      $("torchBtn").textContent="조명 켜기";
    }
    if(caps && caps.zoomFeature && caps.zoomFeature().isSupported()){
      var z=caps.zoomFeature();
      $("zoomSlider").min=z.min();
      $("zoomSlider").max=z.max();
      $("zoomSlider").step=z.step()||0.1;
      $("zoomSlider").value=z.value();
      text("zoomValue",Number(z.value()).toFixed(1)+"×");
      show("zoomWrap");
    }
  }catch(e){console.warn("카메라 부가기능 미지원",e);}
}

function ensureScannerLibrary(){
  if(window.Html5Qrcode && window.Html5QrcodeSupportedFormats){
    return Promise.resolve();
  }
  return Promise.reject(new Error("스캐너 라이브러리를 불러오지 못했습니다."));
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
  $("rescanRackBtn").disabled=state.skipRack;
  $("rescanShelfBtn").disabled=state.skipShelf;
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
  var value=clean(decodedText);
  if(!value||state.scanLocked)return;

  state.scanLocked=true;
  var fmt="Barcode/QR";
  try{fmt=decodedResult.result.format.formatName||fmt;}catch(e){}

  setScannerStatus(stageLabel(state.stage)+" 인식 완료","success");
  stopScanner().then(function(){
    applyCode(value,fmt,false);
    window.setTimeout(function(){state.scanLocked=false;},500);
  });
}
function startScanner(){
  if(state.scanning)return;
  openScannerModal();
  updateModeUI();
  setScannerStatus("카메라 권한을 요청하고 있습니다.");

  ensureScannerLibrary().then(function(){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      throw new Error("카메라 API 미지원");
    }

    state.scanner=state.scanner||new Html5Qrcode("reader",{
      verbose:false,
      experimentalFeatures:{useBarCodeDetectorIfSupported:true}
    });

    var config={
      fps:15,
      disableFlip:false,
      qrbox:scanRegion,
      aspectRatio:window.innerWidth>window.innerHeight?1.7777778:1.3333333,
      videoConstraints:{
        facingMode:{ideal:"environment"},
        width:{ideal:1920},
        height:{ideal:1080},
        focusMode:{ideal:"continuous"}
      }
    };
    var formats=activeFormats();
    if(formats)config.formatsToSupport=formats;

    return Html5Qrcode.getCameras().then(function(cameras){
      if(!cameras||!cameras.length)throw new Error("카메라 없음");
      var rear=cameras.find(function(c){return /back|rear|environment|후면/i.test(c.label||"");});
      var selected=(rear||cameras[cameras.length-1]).id;
      return state.scanner.start(selected,config,onScan,function(){});
    }).catch(function(firstError){
      console.warn("카메라 ID 실행 실패, 후면 조건으로 재시도",firstError);
      return state.scanner.start({facingMode:{ideal:"environment"}},config,onScan,function(){});
    });
  }).then(function(){
    state.scanning=true;
    state.scanLocked=false;
    setScannerStatus(stageLabel(state.stage)+" 인식 대기 중","ready");
    setupCameraControls();
  }).catch(function(err){
    console.error(err);
    state.scanning=false;
    setScannerStatus("카메라를 실행하지 못했습니다. HTTPS와 카메라 권한을 확인하세요.","error");
  });
}
function stopScanner(closeModal){
  var done=function(){
    state.scanning=false;
    state.scanLocked=false;
    hide("torchBtn");hide("zoomWrap");
    if(closeModal!==false)closeScannerModal();
  };
  if(!state.scanner||!state.scanning){done();return Promise.resolve();}
  return state.scanner.stop().catch(function(e){console.warn(e);}).then(done);
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
function exportJSON(){
  download("rack_shelf_slot_backup.json",JSON.stringify({version:APP_VERSION,records:state.records},null,2),"application/json");
}
function importJSON(file){
  var reader=new FileReader();
  reader.onload=function(){
    try{
      var data=JSON.parse(reader.result),arr=Array.isArray(data)?data:data.records;
      if(!Array.isArray(arr))throw new Error();
      if(!confirm(arr.length+"건을 현재 데이터에 추가하시겠습니까?"))return;
      state.records=state.records.concat(arr);saveLocal();renderRecords();toast("복원했습니다.");
    }catch(e){toast("올바른 백업 JSON 파일이 아닙니다.");}
  };
  reader.readAsText(file);
}
function runSelfTest(){
  var tests=[
    ["HTTPS 보안 연결",location.protocol==="https:"||location.hostname==="localhost"],
    ["카메라 API",!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)],
    ["로컬 저장소",(function(){try{localStorage.setItem("_rss_t","1");localStorage.removeItem("_rss_t");return true;}catch(e){return false;}})()],
    ["파일 다운로드",typeof Blob!=="undefined"&&typeof URL.createObjectURL==="function"],
        ["필수 화면 요소",["ringName","officeName","scanBtn","saveSlotBtn","csvBtn","recordBody"].every(function(id){return !!$(id);})],
    ["스캐너 라이브러리",!!window.Html5Qrcode && !!window.Html5QrcodeSupportedFormats]
  ];
  $("testResults").innerHTML=tests.map(function(t){
    return "<div class='test-line'><span>"+esc(t[0])+"</span><strong class='"+(t[1]?"pass":"fail")+"'>"+(t[1]?"PASS":"FAIL")+"</strong></div>";
  }).join("");
}

$("startWorkBtn").addEventListener("click",startWork);
$("editWorkBtn").addEventListener("click",editWork);
$("scanBtn").addEventListener("click",startScanner);
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
  if(!state.scanner)return;
  state.torchOn=!state.torchOn;
  state.scanner.applyVideoConstraints({advanced:[{torch:state.torchOn}]}).then(function(){
    $("torchBtn").textContent=state.torchOn?"조명 끄기":"조명 켜기";
  }).catch(function(){state.torchOn=false;toast("이 기기에서는 조명을 제어할 수 없습니다.");});
});
$("zoomSlider").addEventListener("input",function(){
  var value=Number(this.value);
  text("zoomValue",value.toFixed(1)+"×");
  if(state.scanner){
    state.scanner.applyVideoConstraints({advanced:[{zoom:value}]}).catch(function(){});
  }
});
$("manualBtn").addEventListener("click",function(){
  var v=clean($("manualCode").value).toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(!v){toast("영문 대문자와 숫자만 입력하세요.");return;}
  applyCode(v,"수동 입력",true);
  $("manualCode").value="";
});
$("rescanRackBtn").addEventListener("click",function(){stopScanner();state.rack="";state.shelf=state.skipShelf?"":"";state.slot="";hide("slotSection");setStage("rack");saveLocal();});
$("rescanShelfBtn").addEventListener("click",function(){stopScanner();state.shelf="";state.slot="";hide("slotSection");setStage("shelf");saveLocal();});
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
$("jsonBtn").addEventListener("click",exportJSON);
$("jsonImport").addEventListener("change",function(){if(this.files[0])importJSON(this.files[0]);this.value="";});
$("clearBtn").addEventListener("click",function(){if(confirm("저장된 모든 데이터를 삭제하시겠습니까?")){state.records=[];saveLocal();renderRecords();toast("전체 데이터를 삭제했습니다.");}});
$("selfTestBtn").addEventListener("click",function(){ensureScannerLibrary().catch(function(){}).then(runSelfTest);});

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
