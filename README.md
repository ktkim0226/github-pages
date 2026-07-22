# Rack / Shelf / Slot Scanner v9

GitHub Pages에서 실행되는 모바일 바코드·QR 스캐너입니다.

## v9 핵심 수정

- ZXing-C++ WebAssembly 초기화를 한 번만 수행하고 실제 WASM 로딩 완료까지 대기
- 자동/소형 모드에서 `formats: []`를 사용해 ZXing이 지원하는 모든 형식을 검색
- BarcodeDetector 지원 브라우저에서는 네이티브 엔진을 보조로 병행
- ZXing-C++ 엔진은 QR, Micro QR, rMQR, Data Matrix, Aztec, PDF417 계열과 주요 1D 바코드를 검색
- 전체 화면, 중앙 영역, 소형 영역, 1D 가로 스트립을 순환 분석
- 원본, 대비 강화, 자동 이진화, 반전 영상을 순환 분석
- `tryHarder`, `tryRotate`, `tryInvert`, `tryDenoise`, `tryDownscale` 적용
- 1D 바코드의 `minLineCount`를 1로 낮춰 작은 라벨 탐지 강화
- 실시간 분석 영역과 누적 시도 횟수, 디코더 오류를 스캐너 화면에 표시
- 서비스 워커 캐시를 v9로 변경하여 이전 v8 JavaScript가 남는 문제 방지

## 배포 방법

1. ZIP의 내용물을 GitHub 저장소 최상위에 업로드합니다.
2. `index.html`, `app.js`, `styles.css`, `sw.js`가 저장소 루트에 있어야 합니다.
3. 저장소의 `Settings → Pages`에서 `Deploy from a branch`, `main`, `/ (root)`를 선택합니다.
4. 배포 후 `https://계정명.github.io/저장소명/?v=9`로 접속합니다.

## 기존 v8을 사용했던 휴대폰

기존 서비스 워커가 남아 있으면 다음 중 하나를 수행합니다.

- 주소 뒤에 `?v=9`를 붙여 접속 후 페이지를 두 번 새로고침
- iPhone: 설정 → Safari → 고급 → 웹사이트 데이터에서 해당 GitHub Pages 사이트 삭제
- Android Chrome: 사이트 설정 → 저장된 데이터 삭제

스캐너 상태 문구에 `시도 1`, `시도 2`처럼 숫자가 증가하면 디코딩 루프가 정상 실행 중입니다. `디코더 오류:`가 표시되면 해당 문구를 확인할 수 있습니다.

## 엔진 자체 테스트

배포 후 아래 주소를 열 수 있습니다.

`https://계정명.github.io/저장소명/ENGINE_SELF_TEST.html`

QR, Code 128, EAN-13 테스트 이미지를 ZXing-WASM으로 읽고 PASS/FAIL 결과를 표시합니다. 이 페이지는 카메라가 아니라 디코더 엔진과 WASM 로딩을 검증합니다.

## 유의사항

- 카메라는 HTTPS에서만 실행됩니다. GitHub Pages는 HTTPS를 제공합니다.
- ZXing JavaScript와 WASM은 최초 실행 시 jsDelivr CDN에서 로드됩니다.
- 회사망에서 CDN이 차단되면 엔진이 로드되지 않을 수 있습니다.
- Micro QR 및 5mm 바코드의 실제 성공률은 카메라 초점 거리, 인쇄 품질, 코드의 모듈 폭과 조명에 영향을 받습니다.
