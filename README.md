# 장소 아카이브

인스타 저장 장소 + 카카오맵 즐겨찾기를 모아 보는 개인용 정적 웹앱.

## 파일
- `index.html` / `style.css` / `app.js` — 앱 (빌드 과정 없음)
- `places.json` — 장소 데이터 (이 파일만 고치면 됨)

## 로컬에서 보기
`places.json`을 fetch로 읽기 때문에 index.html 더블클릭으로는 안 열려요.
```
python3 -m http.server
# → http://localhost:8000
```

## GitHub Pages 배포
1. 새 저장소에 4개 파일을 그대로 올림
2. Settings → Pages → Branch: `main` / `(root)` → Save
3. `https://<아이디>.github.io/<저장소>/` 로 접속

## 데이터 업데이트 흐름
1. 앱에서 장소 추가·수정·방문 체크 → 브라우저(localStorage)에 임시 저장
2. 상단 빨간 배지(또는 ⋯ → JSON 내보내기) → `places.json` 다운로드
3. 저장소의 `places.json`을 교체해 커밋
4. ⋯ → 브라우저 변경사항 초기화 (중복 방지)

## places.json 필드
| 필드 | 설명 |
|---|---|
| id | 인스타 게시물 코드(없으면 `local-…` 자동 생성) |
| name, region, sub_region, category | 필수/필터용 |
| tags | 문자열 배열 |
| memo | 저장한 이유 한 줄 |
| kakaomap_url | 비었거나 `...`이면 장소명 검색 링크로 대체 |
| instagram_url | 있을 때만 버튼 표시 |
| lat, lng | 있어야 지도 마커·길찾기 표시 |
| visited | true / false |
| added_at | YYYY-MM-DD |
