// ─── 데이터 경로 ──────────────────────────────────
// v= 쿼리스트링으로 매일 업데이트되는 데이터 파일의 브라우저 캐시를 날짜 단위로 무효화
const _today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const COUNTRIES_URL = `./public/data/countries.json?v=${_today}`;
const COUNTRY_DETAIL_URL = iso => `./public/data/countries/${iso}.json?v=${_today}`;
const WORLD_BORDERS_URL = './public/data/world_borders.geojson'; // 국경선은 변하지 않으니 캐시 유지

// 한국인 여행자 기준 인기 국가 (ISO3)
const POPULAR_ISO = ['JPN', 'USA', 'FRA', 'GBR', 'THA', 'VNM', 'CHN', 'AUS', 'DEU', 'ITA'];

const FAV_KEY = 'cz_favorites';

const ALERT_COLORS = {
  '없음': '#3B7D2E',
  '여행유의': '#2E5B9D',
  '여행자제': '#C77700',
  '철수권고': '#D45500',
  '여행금지': '#C0392B',
};
const LEVEL_RANK = { '없음': 0, '여행유의': 1, '여행자제': 2, '철수권고': 3, '여행금지': 4 };

// autoPan: false — setContent 후 Leaflet 내장 _adjustPan이 pan 애니메이션 중간에 충돌하므로
// panForPopup()으로 직접 제어한다
const POPUP_OPTIONS = { autoPan: false };

// 면적이 넓거나 극지방까지 걸쳐있는 국가는 클릭 지점에 따라 팝업이 지도 경계 밖(고위도)으로
// 밀려나 잘리므로, 클릭 위치 대신 고정 좌표에 팝업을 연다.
// 기본값은 centroid(c.lat/c.lng)이며, 최대 축소(zoom 2) 기준으로 여전히 위쪽이 잘리는
// 국가는 아래 표에서 더 낮은 위도로 개별 보정한다.
const FIXED_POPUP_ISO = new Set(['RUS', 'CAN', 'NOR', 'USA']);
const FIXED_POPUP_ANCHOR = {
  RUS: [52.3, 104.3], // 이르쿠츠크 — 러시아 영토 내에서 centroid(60,100)보다 남쪽인 지점
};

function panForPopup(popup) {
  if (!popup || !mapInstance) return;
  requestAnimationFrame(() => {
    const el = popup._container;
    if (!el) return;
    const pr = el.getBoundingClientRect();
    const mr = mapInstance.getContainer().getBoundingClientRect();
    const pad = 15;
    let dx = 0, dy = 0;
    if (pr.top < mr.top + pad)           dy = pr.top - mr.top - pad;
    else if (pr.bottom > mr.bottom - pad)  dy = pr.bottom - mr.bottom + pad;
    if (pr.left < mr.left + pad)          dx = pr.left - mr.left - pad;
    else if (pr.right > mr.right - pad)    dx = pr.right - mr.right + pad;
    if (dx || dy) mapInstance.panBy([dx, dy], { animate: true, duration: 0.35 });
  });
}

// ─── 상태 ────────────────────────────────────────
let ALL_COUNTRIES = [];
let WORLD_BORDERS = null;
let currentView = 'map';
let currentTab = 'all';
let currentAlertFilter = null; // null = 전체, 또는 '없음'/'여행유의'/... 중 하나
let mapInstance = null;
let geoLayer = null;
let markerLayerGroup = null;
let partialIconGroup = null;
let currentDetail = null;
let favorites = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
const detailCache = {}; // iso -> full country detail JSON, populated lazily for map popups

// ─── 유틸 ────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function findCountry(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return ALL_COUNTRIES.filter(c =>
    c.country_kr.toLowerCase().includes(q) ||
    c.country_en.toLowerCase().includes(q) ||
    c.iso_code.toLowerCase() === q
  ).slice(0, 8);
}

// ─── 즐겨찾기 ────────────────────────────────────
function isFav(iso) { return favorites.includes(iso); }

function toggleFav(iso, e) {
  if (e) e.stopPropagation();
  const idx = favorites.indexOf(iso);
  if (idx === -1) favorites.push(iso);
  else favorites.splice(idx, 1);
  localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  showToast(idx === -1 ? '❤️ 즐겨찾기에 추가했어요' : '즐겨찾기에서 제거했어요');
  updateFavCount();
  if (currentView === 'map') renderMap(); else renderList();
  renderChips();
}

function toggleFavCurrent() {
  if (!currentDetail) return;
  toggleFav(currentDetail.iso_code);
  document.getElementById('resultFavBtn').textContent = isFav(currentDetail.iso_code) ? '❤️' : '🤍';
}

function updateFavCount() {
  document.getElementById('favCount').textContent = favorites.length;
}

function getFilteredCountries() {
  let base = currentTab === 'fav' ? ALL_COUNTRIES.filter(c => isFav(c.iso_code)) : ALL_COUNTRIES;
  if (currentAlertFilter) {
    base = base.filter(c => (c.national_level || c.alert_level || '없음') === currentAlertFilter);
  }
  return base;
}

// ─── 화면 전환 ───────────────────────────────────
function showScreen(name) {
  document.getElementById('screenHome').style.display = name === 'home' ? '' : 'none';
  document.getElementById('screenLoading').style.display = name === 'loading' ? '' : 'none';
  document.getElementById('screenResult').style.display = name === 'result' ? '' : 'none';
}

function goHome() {
  showScreen('home');
  document.getElementById('searchInput').value = '';
  document.getElementById('searchSuggest').style.display = 'none';
  history.replaceState(null, '', location.pathname);
}

// ─── 검색 ────────────────────────────────────────
function renderSuggestions(query) {
  const box = document.getElementById('searchSuggest');
  const matches = findCountry(query);
  if (!query.trim()) { box.style.display = 'none'; return; }
  if (matches.length === 0) {
    box.innerHTML = '<div class="suggest-empty">검색 결과가 없어요</div>';
  } else {
    box.innerHTML = matches.map(c => `
      <div class="suggest-item" onclick="selectCountry('${c.iso_code}')">
        <img class="suggest-flag" src="${c.flag_image || ''}" alt="" onerror="this.style.visibility='hidden'" />
        <span>${c.country_kr} <span style="color:#aaa;">(${c.country_en})</span></span>
      </div>`).join('');
  }
  box.style.display = 'block';
}

document.getElementById('searchInput').addEventListener('input', e => {
  const v = e.target.value;
  document.getElementById('searchClear').style.display = v ? 'block' : 'none';
  renderSuggestions(v);
});

document.getElementById('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const matches = findCountry(e.target.value);
    if (matches.length > 0) selectCountry(matches[0].iso_code);
  }
});

document.getElementById('searchClear').addEventListener('click', () => {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClear').style.display = 'none';
  document.getElementById('searchSuggest').style.display = 'none';
});

document.addEventListener('click', e => {
  const wrap = document.querySelector('.search-wrap-hero');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('searchSuggest').style.display = 'none';
  }
});

// ─── 인기 국가 / 즐겨찾기 칩 ─────────────────────
function renderChips() {
  const box = document.getElementById('popularChips');
  const title = document.getElementById('chipSectionTitle');

  if (currentTab === 'fav') {
    title.textContent = '즐겨찾기한 국가';
    const chips = ALL_COUNTRIES.filter(c => isFav(c.iso_code));
    box.innerHTML = chips.length
      ? chips.map(chipHTML).join('')
      : `<p class="brief-empty">아직 즐겨찾기한 국가가 없어요. 결과 화면에서 🤍를 눌러 추가해보세요.</p>`;
    return;
  }

  title.textContent = '인기 국가';
  const chips = POPULAR_ISO.map(iso => ALL_COUNTRIES.find(c => c.iso_code === iso)).filter(Boolean);
  box.innerHTML = chips.map(chipHTML).join('');
}

function chipHTML(c) {
  return `
    <div class="chip" onclick="selectCountry('${c.iso_code}')">
      <img src="${c.flag_image || ''}" alt="" onerror="this.style.visibility='hidden'" />
      <span>${c.country_kr}</span>
    </div>`;
}

// ─── 지도(반투명 choropleth) ─────────────────────
async function ensureWorldBorders() {
  if (WORLD_BORDERS) return WORLD_BORDERS;
  const res = await fetch(WORLD_BORDERS_URL);
  WORLD_BORDERS = await res.json();
  return WORLD_BORDERS;
}

async function fetchDetailCached(iso) {
  if (detailCache[iso]) return detailCache[iso];
  const res = await fetch(COUNTRY_DETAIL_URL(iso));
  const detail = await res.json();
  detailCache[iso] = detail;
  return detail;
}

function popupHTML(c, extra) {
  const fav = isFav(c.iso_code);
  // extra=undefined → 로딩 중, extra='' → 내용 없음(섹션 숨김), extra=문자열 → 표시
  const extraSection = extra === undefined
    ? `<div class="map-popup-extra"><p class="brief-empty">불러오는 중...</p></div>`
    : (extra ? `<div class="map-popup-extra">${extra}</div>` : '');
  return `
    <div class="map-popup">
      <div class="map-popup-head">
        <img src="${c.flag_image || ''}" alt="" onerror="this.style.visibility='hidden'" />
        <span class="map-popup-name">${c.country_kr}</span>
        <span style="margin-left:auto;cursor:pointer;" onclick="toggleFav('${c.iso_code}', event)">${fav ? '❤️' : '🤍'}</span>
      </div>
      <span class="alert-badge alert-${c.national_level || c.alert_level}">${c.national_level || c.alert_level}</span>
      ${extraSection}
      <button class="map-popup-btn" onclick="selectCountry('${c.iso_code}')">자세히 보기 →</button>
    </div>`;
}

function buildPopupExtra(detail) {
  const partials = (detail.travel_alert?.regions || []).filter(r => r.partial);
  const partialHTML = partials.length
    ? `<p class="map-popup-line">⚠️ ${partials.slice(0, 2).map(r => `${r.area || '일부 지역'}: ${r.level}`).join(' / ')}${partials.length > 2 ? ' 외' : ''}</p>`
    : '';
  const etiquette = detail.culture_ai?.etiquette || '';
  const tip = etiquette ? etiquette.split('.')[0] + (etiquette.includes('.') ? '.' : '') : '';
  const tipHTML = tip ? `<p class="map-popup-line">🤝 ${tip}</p>` : '';
  return partialHTML + tipHTML;
}

async function renderMap() {
  if (!mapInstance) {
    mapInstance = L.map('map', { minZoom: 2, maxBoundsViscosity: 1.0, worldCopyJump: false })
      .setView([20, 10], 2);
    mapInstance.setMaxBounds([[-85, -180], [85, 180]]);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      noWrap: true,
    }).addTo(mapInstance);
    markerLayerGroup = L.layerGroup().addTo(mapInstance);
    partialIconGroup = L.layerGroup().addTo(mapInstance);
  } else {
    if (geoLayer) { mapInstance.removeLayer(geoLayer); geoLayer = null; }
    markerLayerGroup.clearLayers();
    partialIconGroup.clearLayers();
  }

  const filtered = getFilteredCountries();
  const byIso = Object.fromEntries(filtered.map(c => [c.iso_code, c]));


  const borders = await ensureWorldBorders();
  const coveredIso = new Set();

  geoLayer = L.geoJSON(borders, {
    filter: feature => !!byIso[feature.properties.iso_code],
    style: feature => {
      const c = byIso[feature.properties.iso_code];
      coveredIso.add(feature.properties.iso_code);
      return {
        fillColor: ALERT_COLORS[c.national_level || c.alert_level] || ALERT_COLORS['없음'],
        fillOpacity: 0.55,
        color: '#fff',
        weight: 1,
      };
    },
    onEachFeature: (feature, layer) => {
      const c = byIso[feature.properties.iso_code];
      if (!c) return;
      layer.bindPopup(popupHTML(c), POPUP_OPTIONS);
      if (FIXED_POPUP_ISO.has(c.iso_code)) {
        layer.off('click');
        layer.on('click', () => layer.openPopup(FIXED_POPUP_ANCHOR[c.iso_code] || [c.lat, c.lng]));
      }
      layer.on('popupopen', async () => {
        const popup = layer.getPopup();
        panForPopup(popup);
        try {
          const detail = await fetchDetailCached(c.iso_code);
          popup?.setContent(popupHTML(c, buildPopupExtra(detail)));
          panForPopup(popup);
        } catch {
          popup?.setContent(popupHTML(c, ''));
          panForPopup(popup);
        }
      });
      layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.8 }));
      layer.on('mouseout', () => layer.setStyle({ fillOpacity: 0.55 }));
    },
  }).addTo(mapInstance);


  // 전국 단위로는 안전(또는 낮은 단계)하지만 일부 지역에 더 높은 경보가 있는 국가는
  // 폴리곤 색만으로는 드러나지 않으므로, 센트로이드에 별도 경고 아이콘을 얹어 표시
  // (코소보 등 GeoJSON 미수록 국가는 이미 alert_level 기준 원 마커로 표시되므로 제외)
  filtered.forEach(c => {
    if (!coveredIso.has(c.iso_code)) return;
    if (!c.partial_level || !c.lat && !c.lng) return;
    const nationalRank = LEVEL_RANK[c.national_level || c.alert_level] || 0;
    const partialRank = LEVEL_RANK[c.partial_level] || 0;
    if (partialRank <= nationalRank) return;
    const color = ALERT_COLORS[c.partial_level] || ALERT_COLORS['여행자제'];
    const icon = L.divIcon({
      html: `<div style="background:${color};color:#fff;width:16px;height:16px;border-radius:4px;
        display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;
        border:1.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);transform:translate(10px,-10px);">!</div>`,
      className: '', iconSize: [16, 16], iconAnchor: [8, 8],
    });
    const m = L.marker([c.lat, c.lng], { icon, zIndexOffset: 500 }).bindPopup(popupHTML(c), POPUP_OPTIONS).addTo(partialIconGroup);
    m.on('popupopen', async () => {
      const popup = m.getPopup();
      panForPopup(popup);
      try {
        const detail = await fetchDetailCached(c.iso_code);
        popup?.setContent(popupHTML(c, buildPopupExtra(detail)));
        panForPopup(popup);
      } catch {
        popup?.setContent(popupHTML(c, ''));
        panForPopup(popup);
      }
    });
  });

  setTimeout(() => mapInstance.invalidateSize(), 100);
}

function renderLegend() {
  const box = document.getElementById('mapLegend');
  const counts = {};
  ALL_COUNTRIES.forEach(c => {
    const mapLevel = c.national_level || c.alert_level || '없음';
    counts[mapLevel] = (counts[mapLevel] || 0) + 1;
  });

  box.innerHTML = Object.entries(ALERT_COLORS).map(([level, color]) => {
    const active = currentAlertFilter === level;
    const count = counts[level] || 0;
    return `
      <div class="legend-item legend-filter${active ? ' legend-active' : ''}"
           onclick="toggleAlertFilter('${level}')" title="${level} 국가만 보기">
        <span class="legend-dot" style="background:${color};"></span>
        ${level}
        <span class="legend-count">${count}</span>
      </div>`;
  }).join('') + `
    <div class="legend-item" style="opacity:.7;cursor:default;">
      <span class="legend-dot" style="background:#D45500;border-radius:3px;width:9px;height:9px;line-height:9px;text-align:center;display:inline-flex;align-items:center;justify-content:center;font-size:8px;color:#fff;">!</span>
      일부 지역만 경보
    </div>`;
}

function toggleAlertFilter(level) {
  currentAlertFilter = currentAlertFilter === level ? null : level;
  renderLegend();
  if (currentView === 'map') renderMap(); else renderList();
  renderChips();
}

function renderList() {
  const box = document.getElementById('listView');
  const filtered = getFilteredCountries();
  box.innerHTML = filtered.length ? filtered.map(c => `
    <div class="country-card" onclick="selectCountry('${c.iso_code}')">
      <button class="country-card-fav" onclick="toggleFav('${c.iso_code}', event)">${isFav(c.iso_code) ? '❤️' : '🤍'}</button>
      <img src="${c.flag_image || ''}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
      <div>
        <p class="country-card-name">${c.country_kr}</p>
        <span class="alert-badge alert-${c.alert_level}">${c.alert_level}</span>
      </div>
    </div>`).join('') : `<p class="brief-empty">아직 즐겨찾기한 국가가 없어요.</p>`;
}

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    document.getElementById('mapView').style.display = currentView === 'map' ? '' : 'none';
    document.getElementById('listView').style.display = currentView === 'list' ? 'grid' : 'none';
    if (currentView === 'map') renderMap(); else renderList();
  });
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    renderChips();
    if (currentView === 'map') renderMap(); else renderList();
  });
});

// ─── 국가 선택 → 브리핑 로딩 ─────────────────────
async function selectCountry(iso) {
  showScreen('loading');
  document.querySelectorAll('.loading-steps li').forEach(li => li.classList.remove('done'));
  history.replaceState(null, '', `?country=${iso}`);

  try {
    const res = await fetch(COUNTRY_DETAIL_URL(iso));
    if (!res.ok) throw new Error('not found');
    const detail = await res.json();
    currentDetail = detail;

    // 단계별 진행 표시(연출용)
    const steps = ['alert', 'accident', 'contact', 'culture'];
    for (const step of steps) {
      await new Promise(r => setTimeout(r, 120));
      const li = document.querySelector(`.loading-steps li[data-step="${step}"]`);
      if (li) li.classList.add('done');
    }
    await new Promise(r => setTimeout(r, 150));

    renderResult(detail);
    showScreen('result');
  } catch (err) {
    console.error('브리핑 로딩 실패:', err);
    showToast('해당 국가 정보를 불러오지 못했어요');
    showScreen('home');
  }
}

// ─── 결과 화면 렌더링 ────────────────────────────
function renderResult(d) {
  document.getElementById('resultFlag').src = d.flag_image || '';
  document.getElementById('resultCountryName').textContent = d.country_kr;
  document.getElementById('resultFavBtn').textContent = isFav(d.iso_code) ? '❤️' : '🤍';

  const level = d.travel_alert?.level || '없음';
  const badge = document.getElementById('resultAlertBadge');
  badge.textContent = `여행경보: ${level}`;
  badge.className = `alert-badge alert-${level}`;

  document.getElementById('noticeLink').href = d.notice_url || 'https://www.0404.go.kr/ntnSafetyInfo/list';

  const regions = d.travel_alert?.regions || [];
  const nationalLevel = d.travel_alert?.national_level || '없음';
  const nationalNote = nationalLevel !== level
    ? `<p class="map-popup-line" style="margin-bottom:8px;">ℹ️ 국가 전역 기준은 <strong>${nationalLevel}</strong>이며, 위 배지는 아래 일부 지역에 적용된 가장 높은 단계(${level})를 표시한 거예요.</p>`
    : '';
  const regionsHTML = regions.length
    ? nationalNote + `<div class="alert-region-list">${regions.map(r => `
        <div class="alert-region-item">
          <span class="alert-badge alert-${r.level}">${r.level}</span>
          <span class="alert-region-area">${r.area || '전 지역'}${r.partial ? ' (일부)' : ''}</span>
        </div>`).join('')}</div>`
    : `<p class="brief-empty">현재 발령된 여행경보가 없어요.</p>`;

  const ai = d.culture_ai;
  const phrasesHTML = ai?.phrases?.length
    ? `<ul class="phrase-list">${ai.phrases.map(p => `<li>${p}</li>`).join('')}</ul>`
    : `<p class="brief-empty">준비 중이에요.</p>`;

  const cards = [
    {
      icon: '🛡️', title: '사건사고 예방정보', source: 'official',
      body: d.accident_info_html || '<p class="brief-empty">등록된 정보가 없어요.</p>',
    },
    {
      icon: '🚦', title: '여행경보 단계 상세', source: 'official',
      body: regionsHTML,
    },
    {
      icon: '📞', title: '긴급 연락처', source: 'official',
      body: d.local_contact_html || '<p class="brief-empty">등록된 정보가 없어요.</p>',
    },
    {
      icon: '🤝', title: '문화·예절', source: 'ai',
      body: ai?.etiquette ? `<p>${ai.etiquette}</p>` : '<p class="brief-empty">준비 중이에요.</p>',
    },
    {
      icon: '⚖️', title: '현지 법률 및 주의사항', source: 'ai',
      body: ai?.local_laws ? `<p>${ai.local_laws}</p>` : '<p class="brief-empty">준비 중이에요.</p>',
    },
    {
      icon: '💬', title: '유용한 현지 표현', source: 'ai',
      body: phrasesHTML,
    },
  ];

  document.getElementById('resultCards').innerHTML = cards.map(c => `
    <div class="brief-card">
      <div class="brief-card-head">
        <span class="brief-card-title">${c.icon} ${c.title}</span>
        <span class="source-badge source-${c.source}">${c.source === 'official' ? '외교부 데이터' : 'AI 생성'}</span>
      </div>
      <div class="brief-card-body">${c.body}</div>
    </div>`).join('');
}

// ─── 공유 ────────────────────────────────────────
function shareResult() {
  if (!currentDetail) return;
  const url = `${location.href.split('?')[0]}?country=${currentDetail.iso_code}`;
  navigator.clipboard.writeText(url).catch(() => {});
  showToast('🔗 링크가 복사되었어요');
}

// ─── 데이터 로딩 ─────────────────────────────────
async function loadData() {
  try {
    const res = await fetch(COUNTRIES_URL);
    ALL_COUNTRIES = await res.json();
  } catch (err) {
    console.error('국가 목록 로딩 실패:', err);
    showToast('데이터를 불러오지 못했어요');
    return;
  }

  updateFavCount();
  renderChips();
  renderLegend();
  renderMap();
  renderList();

  const params = new URLSearchParams(location.search);
  const iso = params.get('country');
  if (iso && ALL_COUNTRIES.some(c => c.iso_code === iso)) {
    selectCountry(iso);
  }
}

loadData();
