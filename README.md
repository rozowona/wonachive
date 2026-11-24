# wonachive

인스타 저장 장소 + 카카오맵 즐겨찾기를 모아 보는 개인용 정적 웹앱.

## 파일
| 파일 | 역할 |
|---|---|
| `index.html` / `style.css` / `app.js` | 앱 (빌드 과정 없음) |
| `config.js` | 카카오 키·구글 시트 URL 넣는 곳 |
| `places.json` | 시트를 연결하기 전 데이터 (시트 연결 후엔 처음 옮길 때만 사용) |
| `apps-script.gs` | 구글 시트에 붙여 넣을 코드 (GitHub에는 없어도 됨) |
| `SETUP.md` | 카카오·구글 시트 설정 안내 |

## 기능
- 카드 목록 + 지도, 지역·카테고리·방문 여부 필터, 검색
- 카카오 장소 검색으로 주소·좌표·링크 자동 입력 (`config.js`에 카카오 키 필요)
- 구글 시트 동기화: 어느 기기에서든 같은 목록 (`config.js`에 시트 URL + 기기별 비밀번호)
- 📍 가까운 순 정렬과 거리 표시
- 방문 기록: 날짜·별점·한 줄 후기, 최근 방문순·별점순 정렬

## 데이터 저장 방식
- **시트 연결 전**: 바꾼 내용은 브라우저에 저장 → 배지(⋯ → JSON 내보내기)로 `places.json` 받아 저장소에 교체
- **시트 연결 후**: 바꾸면 바로 구글 시트에 저장. 실패한 변경은 "저장 대기"로 남아 배지를 누르면 다시 보냄

## 로컬에서 보기
```
python3 -m http.server
# → http://localhost:8000
```

## 데이터 필드
| 필드 | 설명 |
|---|---|
| id | 인스타 게시물 코드 / `kakao-장소번호` / `local-…` 자동 생성 |
| name, region, sub_region, category | 이름·필터용 |
| address | 주소. 카드에 표시, 좌표 찾기·카카오맵 검색에 사용 |
| tags | 태그 (JSON은 배열, 시트는 쉼표로 구분) |
| memo | 저장한 이유 한 줄 |
| kakaomap_url | 비었거나 `...`이면 장소명 검색 링크로 대체 |
| instagram_url | 있을 때만 버튼 표시 |
| lat, lng | 있어야 지도·길찾기·가까운 순에 표시 |
| visited | true / false |
| added_at | 추가한 날 (YYYY-MM-DD) |
| visited_at | 방문한 날 (YYYY-MM-DD) |
| rating | 별점 1~5 |
| review | 한 줄 후기 |
