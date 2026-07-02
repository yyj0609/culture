# CultureZero 진행 기록

기획서: [CultureZero_기획서.md](CultureZero_기획서.md) · 작업 가이드라인: [CLAUDE.md](CLAUDE.md)

**라이브 URL**: https://yyj0609.github.io/culture/
**GitHub 레포**: https://github.com/yyj0609/culture

---

## 완료된 작업

### 1. 외교부 공공데이터 API 조사 (6개 중 5개 연동, 1개 제외)
공공데이터포털(data.go.kr) 서비스키로 실제 호출해서 응답 구조를 확인함.

| API | 상태 | 비고 |
|---|---|---|
| `TravelWarningServiceV3` (여행경보) | ✅ 연동 | HTTPS만 됨. `iso_code`(3자리)가 마스터 키 |
| `AccidentService` (사건사고 예방정보) | ✅ 연동 | ISO코드 없음 → 한글 국가명으로 조인(197/198, 마카오 제외) |
| `CountryFlagService2` (국기 이미지) | ✅ 연동 | `country_iso_alp2`(2자리) → pycountry로 3자리 변환 |
| `LocalContactService2` (현지연락처) | ✅ 연동 | 위와 동일 변환 |
| `CountryNoticeService` (공지사항) | ✅ 연동, 현재 0건 | 공지 없을 때 0404.go.kr 목록으로 폴백 |
| `CountrySafetyService3` (안전공지) | ❌ 제외 | "Unexpected errors" 응답, MVP 스코프 외 합의 |

**ISO 코드 매핑**: TravelWarningServiceV3(197개국)을 마스터로, pycountry로 ISO2↔ISO3 변환. 코소보(`XK`→`XKX`) 수동 매핑, EU 깃발 제외.
**국가 좌표**: `mledoze/countries`(공개 데이터셋)에서 197개국 위경도를 collect_data.py 정적 테이블로 내장.

### 2. 여행경보 단계 로직
- API 실데이터로 필드 매핑 확정: attention="여행유의", control="여행자제", limita="철수권고", ban_yna="여행금지"
- `_partial` 필드 누락 버그 수정 (일부지역만 경보인 나라가 "없음"으로 잘못 표시되던 문제)
- **national_level**: 전국 단위 단계(폴리곤 색 기준) / **alert_level**: 전체 최고 단계(배지·리스트 기준) 분리
- 5단계 색상: 없음(초록)/여행유의(남색)/여행자제(노랑)/철수권고(주황)/여행금지(빨강). 특별여행주의보는 MVP 제외 합의.
- 197개국 분포: 없음 51 / 여행유의 42 / 여행자제 32 / 철수권고 47 / 여행금지 25

### 3. 데이터 처리 결정사항
- **HTML 렌더링**: local_contact_html / accident_info_html을 구조화 파싱 대신 원본 HTML 렌더링 (긴급연락처 전화번호 파싱 오류 방지). `html.parser` 기반 새니타이저 적용 (style/class 제거, truncated HTML 안전 처리).
- **HTML truncation 버그**: 러시아·헝가리 연락처 HTML이 API에서 중간에 잘려서 왔음 → 새니타이저가 안전하게 처리.
- **국기 이미지 경로**: `public/images/{ISO3}.{ext}` 형식, 초기 `public/` 누락 버그 패치 완료.

### 4. culture_ai 필드 (Gemini `gemini-flash-lite-latest`)
- **etiquette**: 문화·예절 (3~4문장)
- **local_laws**: 현지 법률·경범죄·주의사항 (2~3문장) — 초기 `business_tip`에서 변경, 197개국 재생성 완료
- **phrases**: 유용한 현지어 표현 5개
- 캐싱: 기존 값 있으면 건너뜀. 브라우저 캐시 무효화: `?v=YYYYMMDD` 날짜 쿼리 파라미터.

### 5. 데이터 수집 스크립트 (`collect_data.py`)
- `.env`에서 `PUBLIC_DATA_SERVICE_KEY`, `GOOGLE_API_KEY` 로드 (키 하드코딩 없음)
- 5개 API 전체 1회 호출 후 ISO 기준 조인 (API 호출 최소화)
- 국기 이미지·world_borders.geojson·culture_ai 모두 캐싱 (이미 있으면 스킵)
- 세계 국경선 GeoJSON: Natural Earth 50m (196개국, `public/data/world_borders.geojson`)

### 6. 프론트엔드 (`index.html`, `style.css`, `main.js`)
GlobalRecruit과 톤 통일, 메인 컬러 `#1E8E6E`(초록). Vanilla JS + Leaflet, 프레임워크 없음.

- **화면 1(메인)**: 검색창(자동완성) + 전체/즐겨찾기 탭 + 인기국가 칩 + 지도/리스트 토글
  - 지도: 반투명 choropleth (national_level 기준 폴리곤 색) + 일부지역 경보 `!` 아이콘
  - 범례 클릭 → 경보 단계별 필터 (국가 수 배지 표시)
  - 팝업: 클릭 시 미리보기(일부지역 경보 요약 + 문화 한줄 팁 lazy-load)
  - 즐겨찾기: localStorage, 탭 필터, 하트 버튼
- **화면 2(로딩)**: 단계별 체크리스트 연출
- **화면 3(결과)**: 국기+국가명+경보 배지+즐겨찾기 하트, 카드 6개 (외교부 데이터/AI 생성 배지 구분), 하단 공지사항 링크·공유·PDF 저장
- URL 딥링크(`?country=ISO3`) 지원
- 카드 구성: 🛡️ 사건사고 예방정보 / 🚦 여행경보 상세 / 📞 긴급 연락처 / 🤝 문화·예절 / ⚖️ 현지 법률 및 주의사항 / 💬 유용한 현지 표현

### 7. GitHub Pages 배포 완료
- **라이브**: https://yyj0609.github.io/culture/
- **GitHub Actions** (`.github/workflows/data_pipeline.yml`): 매일 KST 02:00 자동 실행, Secrets에서 두 키 주입
- GitHub Secrets: `PUBLIC_DATA_SERVICE_KEY`, `GOOGLE_API_KEY` 등록 완료
- `requirements.txt`: `requests`, `python-dotenv`, `pycountry`

---

## 참고 사항
- 로컬 데이터 재수집: `cd 문화 && python3 collect_data.py`
- 로컬 서버: `cd 문화 && python3 -m http.server 8765` → http://localhost:8765
- `.env`는 `.gitignore`에 포함되어 커밋되지 않음. GitHub Actions는 Secrets로 대체.
- 레포 이름 변경(culture → CultureZero) 원하면: GitHub → Settings → General → Repository name
