
(function(){
"use strict";

var APP_VERSION="3.0.0";
var RECORD_KEY="rss_records_v3";
var CONFIG_KEY="rss_config_v3";
var LIB_URLS=[
  "https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js",
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"
];

var state={
  started:false, ring:"", office:"", skipRack:false, skipShelf:false,
  rack:"", shelf:"", slot:"", stage:"rack", records:[],
  scanner:null, scanning:false, pending:null,
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

function loadScript(url){
  return new Promise(function(resolve,reject){
    var s=document.createElement("script");
    s.src=url;s.async=true;s.onload=resolve;s.onerror=reject;
    document.head.appendChild(s);
  });
}
function ensureScannerLibrary(){
  if(window.Html5Qrcode)return Promise.resolve();
  var i=0;
  function next(){
    if(i>=LIB_URLS.length)return Promise.reject(new Error("스캐너 라이브러리 로드 실패"));
    return loadScript(LIB_URLS[i++]).catch(next);
  }
  return next();
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
  value=clean(value);if(!value){toast("빈 값은 반영할 수 없습니다.");return;}
  state.pending={value:value,format:format||"알 수 없음",manual:!!manual,stage:state.stage};
  text("confirmStageText",stageLabel(state.stage)+" 값이 맞는지 실제 라벨과 비교하세요.");
  text("detectedValue",value);
  text("detectedFormat","인식 형식: "+state.pending.format+(manual?" · 수동 입력":" · 1회 인식 후 즉시 정지"));
  $("confirmDialog").showModal();
}
function acceptPending(){
  var p=state.pending;if(!p)return;
  if(p.stage==="rack"){
    state.rack=p.value;state.shelf=state.skipShelf?"":state.shelf;state.slot="";
    setStage(state.skipShelf?"slot":"shelf");
  }else if(p.stage==="shelf"){
    state.shelf=p.value;state.slot="";setStage("slot");
  }else{
    state.slot=p.value;$("slotCode").value=p.value;show("slotSection");
    window.setTimeout(function(){$("wavelength").focus();},150);
  }
  state.pending=null;saveLocal();updateUI();vibrate();toast("확인된 값을 반영했습니다.");
}
function cancelSlot(){
  state.slot="";$("slotCode").value="";$("wavelength").value="";$("slotNumber").value="";$("unitName").value="";$("memo").value="";
  hide("slotSection");setStage("slot");
}
function saveSlot(){
  var slotNo=clean($("slotNumber").value);
  if(!state.slot){toast("Slot 코드를 먼저 등록하세요.");return;}
  if(!/^\d{3}$/.test(slotNo)){toast("Slot Number는 숫자 3자리여야 합니다.");return;}
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
  var now=Date.now(),value=clean(decodedText);
  if(!value||state.scanLocked)return;

  /* 동일 프레임 또는 브라우저 콜백 중복만 차단한다.
     사용자가 같은 라벨을 여러 번 스캔하도록 요구하지 않는다. */
  if(value===state.lastDecodedValue && now-state.lastDecodedAt<1500)return;

  state.scanLocked=true;
  state.lastDecodedValue=value;
  state.lastDecodedAt=now;

  var fmt="Barcode/QR";
  try{fmt=decodedResult.result.format.formatName||fmt;}catch(e){}

  text("stageNotice",stageLabel(state.stage)+" 인식 완료 · 확인 화면으로 이동합니다.");
  stopScanner().then(function(){
    applyCode(value,fmt,false);
    window.setTimeout(function(){state.scanLocked=false;},600);
  });
}
function startScanner(){
  if(state.scanning)return;
  ensureScannerLibrary().then(function(){
    show("readerWrap");hide("scanBtn");show("stopBtn");
    state.scanner=state.scanner||new Html5Qrcode("reader");
    var formats=[
      Html5QrcodeSupportedFormats.QR_CODE,Html5QrcodeSupportedFormats.CODE_128,
      Html5QrcodeSupportedFormats.CODE_39,Html5QrcodeSupportedFormats.CODE_93,
      Html5QrcodeSupportedFormats.EAN_13,Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A,Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.ITF,Html5QrcodeSupportedFormats.CODABAR,
      Html5QrcodeSupportedFormats.DATA_MATRIX,Html5QrcodeSupportedFormats.PDF_417,
      Html5QrcodeSupportedFormats.AZTEC
    ];
    var cfg={fps:18,formatsToSupport:formats,disableFlip:false,rememberLastUsedCamera:true,
      qrbox:function(w,h){return{width:Math.floor(w*.84),height:Math.max(130,Math.floor(h*.34))};},
      aspectRatio:1.7777778};
    return state.scanner.start({facingMode:{exact:"environment"}},cfg,onScan,function(){})
      .catch(function(){return state.scanner.start({facingMode:"environment"},cfg,onScan,function(){});});
  }).then(function(){
    state.scanning=true;text("stageNotice",stageLabel(state.stage)+" 스캔 중 · 코드 하나를 중앙 가이드 안에 맞춰 주세요.");
  }).catch(function(err){
    state.scanning=false;hide("readerWrap");show("scanBtn");hide("stopBtn");
    toast("카메라 시작 실패: 권한과 HTTPS 접속을 확인하세요.");
    console.error(err);
  });
}
function stopScanner(){
  if(!state.scanner||!state.scanning){hide("readerWrap");show("scanBtn");hide("stopBtn");return Promise.resolve();}
  return state.scanner.stop().catch(function(){}).then(function(){
    state.scanning=false;hide("readerWrap");show("scanBtn");hide("stopBtn");
    text("stageNotice",stageLabel(state.stage)+" 바코드 또는 QR 코드를 스캔하세요.");
  });
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
    ["다이얼로그",typeof $("confirmDialog").showModal==="function"],
    ["필수 화면 요소",["ringName","officeName","scanBtn","saveSlotBtn","csvBtn","recordBody"].every(function(id){return !!$(id);})],
    ["스캐너 라이브러리",!!window.Html5Qrcode]
  ];
  $("testResults").innerHTML=tests.map(function(t){
    return "<div class='test-line'><span>"+esc(t[0])+"</span><strong class='"+(t[1]?"pass":"fail")+"'>"+(t[1]?"PASS":"FAIL")+"</strong></div>";
  }).join("");
}

$("startWorkBtn").addEventListener("click",startWork);
$("editWorkBtn").addEventListener("click",editWork);
$("scanBtn").addEventListener("click",startScanner);
$("stopBtn").addEventListener("click",stopScanner);
$("manualBtn").addEventListener("click",function(){var v=clean($("manualCode").value);if(!v){toast("수동값을 입력하세요.");return;}applyCode(v,"수동 입력",true);});
$("acceptBtn").addEventListener("click",function(){$("confirmDialog").close();acceptPending();$("manualCode").value="";});
$("rejectBtn").addEventListener("click",function(){$("confirmDialog").close();state.pending=null;toast("취소했습니다.");});
$("rescanRackBtn").addEventListener("click",function(){stopScanner();state.rack="";state.shelf=state.skipShelf?"":"";state.slot="";hide("slotSection");setStage("rack");saveLocal();});
$("rescanShelfBtn").addEventListener("click",function(){stopScanner();state.shelf="";state.slot="";hide("slotSection");setStage("shelf");saveLocal();});
$("slotNumber").addEventListener("input",function(){this.value=this.value.replace(/\D/g,"").slice(0,3);});
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
document.addEventListener("visibilitychange",function(){if(document.hidden)stopScanner();});
window.addEventListener("pagehide",stopScanner);

restoreLocal();environmentCheck();updateUI();
ensureScannerLibrary().catch(function(){});
})();
