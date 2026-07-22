# v9 테스트 결과

- js_syntax: PASS
- app_version_v9: PASS
- service_worker_cache_v9: PASS
- zxing_init_awaited: PASS
- all_formats_auto: PASS
- native_barcode_detector: PASS
- multi_regions: PASS
- multi_preprocessing: PASS
- zxing_accuracy_options: PASS
- self_test_page: PASS
- fixtures_present: PASS
- qr_fixture_verified_opencv: PASS

## 테스트 범위

JavaScript 문법, 서비스 워커 캐시 버전, 엔진 초기화, 포맷 설정, 분석 영역 및 전처리 순환 로직을 정적으로 검사했습니다. QR fixture는 OpenCV로 실제 디코딩하여 `RACK-A01`을 확인했습니다. Code128/EAN13 fixture는 배포 후 `ENGINE_SELF_TEST.html`에서 ZXing-WASM으로 테스트하도록 포함했습니다. 이 실행 환경에서는 모바일 카메라 물리 테스트와 외부 CDN WASM 실행을 완료하지 못했습니다.
