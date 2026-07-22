# v7 Test Report

## Completed

- JavaScript syntax validation with `node --check`: PASS
- HTML element / JavaScript ID reference consistency: PASS
- Legacy html5-qrcode reference removal: PASS
- ZXing-C++ WASM pinned loader configuration: PASS
- MicroQRCode and RMQRCode format inclusion: PASS
- AllLinear and AllReadable format inclusion: PASS
- Small-code crop/upscale pipeline: PASS
- Contrast and binary preprocessing pipeline: PASS
- Still-photo decoder route: PASS
- CSV-only output controls: PASS
- Service worker cache version bump: PASS

## Not executable in this build environment

Physical iPhone/Android camera recognition could not be measured because no mobile camera device or 5 mm printed specimen is connected. Final acceptance testing must be performed on the target phones over the deployed HTTPS GitHub Pages URL.
