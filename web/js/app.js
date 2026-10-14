import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// player_map.json 좌표([-1, 1], y가 가장 좁은 축) → 월드 단위. 가로로 넓고 세로로 얇은 원반
const SCALE_XZ = 36;
const SCALE_Y = 6;
const PER_RING = 2;             // 한 궤도를 나눠 쓰는 최대 개수 (같은 궤도에선 같은 속도라 서로 부딪히지 않는다)
// 같은 궤도의 둘은 원래 좌표의 각도 차를 따르되, 부딪히지 않는 최소 각도 ~ 아래 최대 각도 사이로 둔다 (정반대편 방지)
const PAIR_MAX_MEMBER = THREE.MathUtils.degToRad(110);
const PAIR_MAX_GROUP = THREE.MathUtils.degToRad(130);
const GROUP_PAIR_CLEAR = 6;      // 같은 궤도 두 무리 사이에 (두 무리 폭 외에) 더 두는 여유
const MEMBER_CLEAR = 1.6;       // 같은 궤도 구성원끼리 최소 거리
const OUTER_GROW = 0.2;         // 바깥 궤도로 한 칸 나갈 때마다 무리 크기를 키우는 비율
const MIN_ORBIT = 2.8;          // 무리의 작은 별과 첫 구성원 궤도 사이 반지름
const MEMBER_GAP = 0.8;         // 구성원 궤도끼리 최소 반지름 간격
const MEMBER_SPREAD = 2.3;      // 무리 중심과의 원래 거리 d → 궤도 반지름 MIN_ORBIT + MEMBER_SPREAD·√d
const AMBIG_SPREAD = 4;         // 소속이 애매할수록(ambiguity 0.35→1) 더해지는 궤도 반지름 (최대값)
const MIN_GROUP_ORBIT = 2;      // 중앙 별과 첫 무리 궤도 사이 여유 (첫 무리 폭과 별도)
const GROUP_GAP = 1.2;          // 이웃한 무리 궤도 사이 평균 여유 (각 무리의 폭과 별도)
const GROUP_PACK = 0.85;        // 이웃 궤도와 띄울 때 무리 폭을 반영하는 비율 (1이면 폭만큼 완전히 띄움)
const GROUP_GAP_CONTRAST = 2;   // 원래 중앙과의 거리 차이를 간격에 나눠 줄 때의 대비 (클수록 간격이 들쭉날쭉)
const GROUP_TILT = 10;          // 무리 궤도의 최대 기울기(도)
const MEMBER_TILT = 22;         // 구성원 궤도의 최대 기울기(도)
const GROUP_ECC = 0.12;         // 무리 궤도의 최대 이심률 (0이면 원)
const MEMBER_ECC = 0.15;        // 구성원 궤도의 최대 이심률
// 케플러처럼 바깥 궤도일수록 느리게: 주기 = T0 × (반지름 / R0)^1.5
const GROUP_PERIOD = { T0: 520, R0: 20 };
const MEMBER_PERIOD = { T0: 48, R0: 4.5 };
const FOCUS_MIN_DIST = 6;       // 선택 시 최소 카메라 거리
const FOCUS_MAX_DIST = 24;      // 닮은 사람이 멀리 흩어져 있어도 나 자신이 작아지지 않게
const OVERVIEW = new THREE.Vector3(0, 25, 62);   // buildGroups()에서 가장 바깥 궤도에 맞춰 다시 정한다
const STAR_TINTS = ['#fff1d6', '#e6efff', '#ffe6c7', '#eee6ff', '#e8fff4', '#fff0f0', '#f3f7e0'];
const FLY_SECONDS = 1.4;        // 카메라 이동 시간

const COLORS = {
  base: new THREE.Color('#cfdcff'),
  me: new THREE.Color('#ffd27a'),
  near: new THREE.Color('#7fd8ff'),
  far: new THREE.Color('#c79bff'),
  단짝: new THREE.Color('#9be3a5'),
  라이벌: new THREE.Color('#ffb36b'),
};
const REL_ORDER = ['단짝', '라이벌'];
const REL_VAR = { 단짝: 'pal', 라이벌: 'rival' };
const REL_DESC = {
  단짝: '가장 많이 동탁한 사람',
  라이벌: '동탁한 판에서 순위 우열이 5:5로 팽팽',
};

// 특징별 [높을 때, 낮을 때] 문장
const TRAIT_TEXT = {
  r1: ['톱을 자주 잡아요', '톱이 드문 편이에요'],
  r2: ['2착이 많아요', '2착이 적어요'],
  r3: ['3착이 많아요', '3착이 적어요'],
  r4: ['라스가 잦은 편이에요', '라스를 잘 피해요'],
  score_std: ['점수 기복이 커요', '점수가 안정적이에요'],
  big_win_rate: ['5만점 넘는 대톱이 잦아요', '대톱은 드문 편이에요'],
  tobi_rate: ['토비가 잦은 편이에요', '좀처럼 토비당하지 않아요'],
  flat_rate: ['원점 부근(2~3만점)에서 마무리할 때가 많아요', '원점 부근에서 끝나는 판이 적어요'],
  win_margin: ['톱일 땐 점수 차를 크게 벌려요', '톱이어도 점수 차가 크지 않아요'],
  loss_floor: ['라스여도 점수를 지켜요', '라스일 땐 크게 무너져요'],
  streak_top2: ['연대를 길게 이어가요', '연대가 길게 이어지진 않아요'],
  recovery: ['라스 다음 판에 잘 회복해요', '라스 다음 판에도 고전해요'],
  trend: ['갈수록 순위가 오르고 있어요', '순위가 주춤한 흐름이에요'],
  time_day: ['낮(12~17시)에 자주 쳐요', '낮에는 잘 안 쳐요'],
  time_evening: ['저녁(17~22시)에 자주 쳐요', '저녁엔 잘 안 쳐요'],
  time_night: ['밤늦게~오전에 자주 쳐요', '심야엔 잘 안 쳐요'],
  weekend_rate: ['주말에 자주 쳐요', '주로 평일에 쳐요'],
  run_freq: ['앉으면 반장전을 여러 판 이어서 쳐요', '한두 판 치고 일어나는 편이에요'],
  avg_run_len: ['이어서 칠 땐 길게 쳐요', '이어 쳐도 짧게 끝내요'],
  max_run: ['한 번에 아주 오래 친 적이 있어요', '몰아서 치진 않아요'],
  partner_diversity: ['여러 사람과 두루 동탁해요', '늘 치던 사람들과 동탁해요'],
  top1_share: ['특정 한 사람과 유독 자주 동탁해요', '한 사람에게 쏠리지 않아요'],
  top3_share: ['자주 동탁하는 멤버가 정해져 있어요', '동탁 멤버가 고정돼 있지 않아요'],
  top5_share: ['단골 동탁 멤버 비중이 높아요', '단골 동탁 멤버 비중이 낮아요'],
  opp_strength: ['강한 상대와 자주 동탁해요', '비교적 순한 상대들과 동탁해요'],
};
const RANK_NAMES = ['톱', '2착', '3착', '라스'];
const GROUP_NAMES = { rank: '착순', score: '점수', flow: '흐름', life: '대국 습관', social: '동탁' };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const signed = (x, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

let data, players, byName;
let focus = null;    // 내가 고른 사람
let target = null;   // 비교 대상
let renderer, labelRenderer, scene, system, camera, controls, clock;
let core, myOrbit = null;
const groups = new Map();   // cluster id → { obj, star, orbit, ring }
let glowTexture;
const links = [];    // { line, a, b, dashed }
const fly = { active: false, start: 0, fromPos: new THREE.Vector3(), fromTarget: new THREE.Vector3(), follow: null, toOverview: false };

init().catch((err) => {
  console.error(err);
  $('#loading').textContent = '데이터를 불러오지 못했어요.';
});

async function init() {
  // ?data=player_map_k12 처럼 다른 데이터 파일로 비교해 볼 수 있다
  const dataName = (new URLSearchParams(location.search).get('data') || 'player_map').replace(/[^\w-]/g, '');
  const res = await fetch(`data/${dataName}.json`, { cache: 'no-cache' });
  data = await res.json();
  players = data.players;
  byName = new Map(players.map((p) => [p.name, p]));
  for (const p of players) p.vec = styleVector(p);

  const m = data.method;
  $('#subtitle').textContent = `${m.period[0]} ~ ${m.period[1]} · ${m.total_games.toLocaleString()}판 · ${players.length}명`;
  $('#help-meta').textContent =
    `${m.min_games_core}판 이상 ${players.filter((p) => p.core).length}명으로 지도를 만들고, ` +
    `${m.min_games_projected}~${m.min_games_core - 1}판인 사람은 그 위에 얹었어요. 마지막 갱신 ${data.generated_at.slice(0, 10)}`;
  $('#player-list').innerHTML = [...players]
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    .map((p) => `<option value="${esc(p.name)}">`).join('');

  setupScene();
  buildPlayers();
  // 첫 프레임 전에도 월드 좌표가 있어야 주소(#name=)로 바로 열 때 카메라 거리를 잴 수 있다
  updateBodies(0);
  bindUI();
  animate();
  $('#loading').classList.add('hide');
  setTimeout(() => $('#loading').remove(), 600);

  const fromHash = decodeURIComponent((location.hash.match(/name=([^&]+)/) || [])[1] || '');
  if (fromHash && byName.has(fromHash)) setFocus(byName.get(fromHash));
}

/* ---------------- 장면 ---------------- */

function setupScene() {
  const host = $('#scene');
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor('#04060d');
  host.appendChild(renderer.domElement);

  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(innerWidth, innerHeight);
  Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
  host.appendChild(labelRenderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2('#04060d', 0.0045);
  camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1000);
  camera.position.copy(OVERVIEW);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2;
  controls.maxDistance = 170;
  controls.enablePan = false;
  controls.addEventListener('start', () => { fly.active = false; });

  glowTexture = makeGlowTexture();
  core = makeCore();
  scene.add(core);
  // 무리의 작은 별은 중앙 별을, 플레이어는 자기 무리의 작은 별을 각자 기울어진 궤도로 돈다
  system = new THREE.Group();
  scene.add(system);
  clock = new THREE.Clock();
  addEventListener('resize', onResize);
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.42, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeDust(n, rMin, rMax, opacity) {
  // 배경 먼지: 깊이감만 주는 장식. 반지름 rMin~rMax 사이 구 껍질에 흩뿌린다
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = rMin + Math.random() * (rMax - rMin);
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: '#8fa3d6', size: 1.6, sizeAttenuation: false, transparent: true, opacity, depthWrite: false, fog: false });
  return new THREE.Points(geo, mat);
}

function makeStar(layers) {
  // 빛 스프라이트를 겹친 별 (장식, 클릭 대상 아님)
  const g = new THREE.Group();
  for (const [color, size, opacity] of layers) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sp.scale.setScalar(size);
    sp.userData.base = size;
    g.add(sp);
  }
  return g;
}

function makeCore() {
  return makeStar([['#fff6e0', 3.2, 1], ['#ffd58a', 10, 0.28], ['#ffb35c', 28, 0.07]]);
}

function pulse(star, t, phase = 0) {
  for (const c of star.children) c.scale.setScalar(c.userData.base * (1 + 0.04 * Math.sin(t * 1.3 + phase)));
}

function seededRandom(seed) {
  // 이름으로 정해지는 난수: 새로고침해도 궤도 기울기가 바뀌지 않게
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function makeOrbit(radius, startDir, maxTiltDeg, period, seed, maxEcc = 0) {
  // 부모 별을 한 초점으로 하는 살짝 찌그러진 타원. 평면은 세로축에서 살짝 기울어져 있다
  const rand = seededRandom(seed);
  const tilt = THREE.MathUtils.degToRad(maxTiltDeg * (0.25 + 0.75 * rand()));
  const az = rand() * Math.PI * 2;
  const n = new THREE.Vector3(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az));
  const a = startDir.clone().addScaledVector(n, -startDir.dot(n));
  if (a.lengthSq() < 1e-6) a.set(1, 0, 0).addScaledVector(n, -n.x);
  a.normalize();
  const b = new THREE.Vector3().crossVectors(n, a).normalize();
  const T = period.T0 * Math.pow(radius / period.R0, 1.5);
  // 장축 방향 p(궤도 평면 안에서 임의 각도)와 그에 수직인 q
  const ecc = maxEcc * (0.4 + 0.6 * rand());
  const w = rand() * Math.PI * 2;
  const p = a.clone().multiplyScalar(Math.cos(w)).addScaledVector(b, Math.sin(w));
  const q = new THREE.Vector3().crossVectors(n, p).normalize();
  return { radius, a, b, p, q, ecc, omega: (Math.PI * 2) / T, phase: 0 };
}

const _c = new THREE.Vector3();

function ellipsePoint(o, ang, out) {
  // 반지름 radius인 원 위의 점을 장축(p) 기준 타원으로 바꾸고, 초점이 중심에 오도록 민다
  _c.copy(o.a).multiplyScalar(Math.cos(ang) * o.radius).addScaledVector(o.b, Math.sin(ang) * o.radius);
  const x = _c.dot(o.p), y = _c.dot(o.q);
  return out.copy(o.p).multiplyScalar(x - o.ecc * o.radius).addScaledVector(o.q, y * Math.sqrt(1 - o.ecc * o.ecc));
}

function orbitPoint(o, t, out) {
  return ellipsePoint(o, o.omega * t + o.phase, out);
}

function makeOrbitLine(o, color, opacity) {
  const n = 192;
  const pts = new Float32Array((n + 1) * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    ellipsePoint(o, (i / n) * Math.PI * 2, v);
    pts.set([v.x, v.y, v.z], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}

function rebuildMyOrbit() {
  // 선택한 사람이 자기 무리의 작은 별을 도는 궤도 하나만. 선택한 사람이 바뀔 때만 새로 만든다
  if (myOrbit) { myOrbit.parent.remove(myOrbit); myOrbit.geometry.dispose(); myOrbit.material.dispose(); myOrbit = null; }
  for (const g of groups.values()) g.ring.material.opacity = focus ? 0.03 : 0.07;
  if (!focus) return;
  focus.group.ring.material.opacity = 0.12;
  myOrbit = makeOrbitLine(focus.orbit, COLORS.me, 0.3);
  focus.group.obj.add(myOrbit);
}

function splitRings(items) {
  // 안쪽부터 차례로 PER_RING개 이하씩, 궤도마다 개수가 고르게 나뉘도록 묶는다
  const k = Math.ceil(items.length / PER_RING);
  const base = Math.floor(items.length / k), extra = items.length % k;
  const rings = [];
  let i = 0;
  for (let j = 0; j < k; j++) {
    const size = base + (j < extra ? 1 : 0);
    rings.push(items.slice(i, i + size));
    i += size;
  }
  return rings;
}

function safeAngle(chord, radius) {
  // 반지름 radius인 원 위에서 두 점 사이 거리가 chord 이상이 되는 최소 각도
  return 2 * Math.asin(Math.min(1, chord / (2 * radius)));
}

function pairPhase(orbit, dir, minAngle, maxAngle) {
  // 두 번째 대상의 위상: 원래 방향의 궤도 위 각도를 따르되 [minAngle, maxAngle]로 제한
  const ang = Math.atan2(dir.dot(orbit.b), dir.dot(orbit.a));
  const mag = THREE.MathUtils.clamp(Math.abs(ang), minAngle, Math.max(minAngle, maxAngle));
  return (ang < 0 ? -1 : 1) * mag;
}

const unit = (v) => (v.lengthSq() > 1e-6 ? v.clone().normalize() : new THREE.Vector3(1, 0, 0));

function buildGroups() {
  // 같은 군집끼리 작은 별 하나를 중심으로 모은다. 군집 이름은 붙이지 않는다
  const raw = new Map(players.map((p) => [p, new THREE.Vector3(p.xyz[0] * SCALE_XZ, p.xyz[1] * SCALE_Y, p.xyz[2] * SCALE_XZ)]));
  const list = [...new Set(players.map((p) => p.cluster))].map((id) => {
    const members = players.filter((p) => p.cluster === id);
    const center = new THREE.Vector3();
    for (const m of members) center.add(raw.get(m));
    return { id, members, center: center.divideScalar(members.length) };
  });

  // 무리 궤도 배정을 먼저 정한다: 원래 중앙에서 가까운 순서로 2무리씩. 바깥 궤도의 무리일수록 크게
  list.sort((x, y) => x.center.length() - y.center.length());
  const groupRings = splitRings(list);
  groupRings.forEach((ring, j) => ring.forEach((item) => { item.scale = 1 + OUTER_GROW * j; }));

  for (const item of list) {
    // 구성원 궤도: 원하는 반지름이 작은 순서로 2명씩 한 궤도에 태운다.
    // 원하는 반지름 = 무리 중심과의 원래 거리(√로 완만하게) + 소속이 애매할수록 더 바깥으로.
    // 실제 반지름은 그 궤도 둘의 평균을 따르되, 안쪽 궤도와는 최소 간격을 둔다
    const sc = item.scale;
    const locals = item.members.map((m) => {
      const local = raw.get(m).clone().sub(item.center);
      const amb = THREE.MathUtils.clamp(((m.ambiguity ?? 0) - 0.35) / 0.65, 0, 1);
      return [m, local, MIN_ORBIT + MEMBER_SPREAD * Math.sqrt(local.length()) + AMBIG_SPREAD * Math.pow(amb, 1.5)];
    }).sort((x, y) => x[2] - y[2]);
    let r = 0;
    splitRings(locals).forEach((ring, j) => {
      const want = ring.reduce((sum, x) => sum + x[2], 0) / ring.length;
      r = Math.max(sc * want, r ? r + sc * MEMBER_GAP : sc * MIN_ORBIT);
      const orbit = makeOrbit(r, unit(ring[0][1]), MEMBER_TILT, MEMBER_PERIOD, `${item.id}-ring-${j}`, MEMBER_ECC);
      ring[0][0].orbit = orbit;
      if (ring[1]) {
        const minA = safeAngle(sc * MEMBER_CLEAR, r);
        ring[1][0].orbit = { ...orbit, phase: pairPhase(orbit, unit(ring[1][1]), minA, PAIR_MAX_MEMBER) };
      }
    });
    item.extent = r;
  }

  // 무리 궤도 반지름: 안쪽 궤도와 폭이 겹치지 않게 쌓는다. 궤도 사이 여유는 평균 GROUP_GAP을 유지하되,
  // 원래 좌표에서 중앙과의 거리 차이가 큰 곳은 넓게, 작은 곳은 좁게 나눠 일정하지 않게 한다.
  // 같은 궤도의 두 무리는 최대 각도 안에서도 충분히 떨어질 만큼 반지름을 확보한다
  const dists = groupRings.map((ring) => ring.reduce((sum, item) => sum + item.center.length(), 0) / ring.length);
  const steps = dists.slice(1).map((d, j) => Math.pow(Math.max(0.05, d - dists[j]), GROUP_GAP_CONTRAST));
  const meanStep = steps.reduce((a, b) => a + b, 0) / (steps.length || 1);
  let prevR = 0, prevExt = 0;
  groupRings.forEach((ring, j) => {
    const ext = Math.max(...ring.map((item) => item.extent));
    const pairChord = ring.length > 1 ? ring[0].extent + ring[1].extent + GROUP_PAIR_CLEAR : 0;
    const gap = j ? GROUP_GAP * steps[j - 1] / meanStep : 0;
    const stacked = prevR ? prevR + GROUP_PACK * (prevExt + ext) + gap : MIN_GROUP_ORBIT + GROUP_PACK * ext;
    const R = Math.max(stacked, pairChord / (2 * Math.sin(PAIR_MAX_GROUP / 2)));
    prevR = R;
    prevExt = ext;

    const orbit = makeOrbit(R, unit(ring[0].center), GROUP_TILT, GROUP_PERIOD, `group-ring-${j}`, GROUP_ECC);
    const line = makeOrbitLine(orbit, new THREE.Color('#8fa3d6'), 0.07);
    system.add(line);

    ring.forEach((item, i) => {
      const obj = new THREE.Group();     // 위치만 궤도를 따라가고 회전하지 않는다
      system.add(obj);
      const tint = STAR_TINTS[item.id % STAR_TINTS.length];
      const sc = item.scale;
      const star = makeStar([[tint, 1.5 * sc, 0.95], [tint, 4.6 * sc, 0.22], [tint, 12 * sc, 0.05]]);
      obj.add(star);
      const phase = i === 0 ? 0 : pairPhase(orbit, unit(item.center), safeAngle(pairChord, R), PAIR_MAX_GROUP);
      const g = { obj, star, orbit: { ...orbit, phase }, ring: line, phase: item.id * 1.7 };
      groups.set(item.id, g);
      for (const m of item.members) m.group = g;
    });
  });

  // 처음 화면이 가장 바깥 무리까지 담도록 카메라 거리와 줌 한계를 맞춘다
  const outer = (prevR + prevExt) * (1 + GROUP_ECC);   // 타원이라 가장 먼 지점(원일점)까지
  OVERVIEW.set(0, outer * 0.55, outer * 1.45);
  camera.position.copy(OVERVIEW);
  controls.maxDistance = outer * 3;
  // 먼지는 대부분 카메라보다 훨씬 뒤에 두고, 원반 근처엔 옅게 조금만 남긴다
  scene.add(makeDust(1600, outer * 2.2, outer * 5, 0.5));
  scene.add(makeDust(220, outer * 0.8, outer * 2.2, 0.3));
  scene.fog.density = 0.16 / outer;
}

function updateBodies(t) {
  for (const g of groups.values()) orbitPoint(g.orbit, t, g.obj.position);
  for (const p of players) {
    orbitPoint(p.orbit, t, p.pos);
    p.sprite.position.copy(p.pos);
    p.halo.position.copy(p.pos);
  }
  system.updateMatrixWorld(true);
  for (const p of players) p.world.setFromMatrixPosition(p.sprite.matrixWorld);
}

function buildPlayers() {
  buildGroups();
  for (const p of players) {
    p.pos = new THREE.Vector3();   // 무리의 작은 별 기준 좌표
    p.world = new THREE.Vector3(); // 화면(월드) 좌표

    const sk = p.skill.pct;
    p.size = (0.38 + 0.22 * Math.log2(p.games / 10)) * (p.core ? 1 : 0.8);
    p.baseOpacity = p.core ? 0.55 + 0.45 * sk : 0.32;

    p.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture, color: COLORS.base.clone(), transparent: true, opacity: p.baseOpacity,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    p.sprite.scale.setScalar(p.size);
    p.sprite.userData.player = p;

    // 실력이 높을수록 넓고 밝은 후광
    p.halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture, color: COLORS.base.clone(), transparent: true,
      opacity: p.core ? 0.04 + 0.2 * sk * sk : 0.03, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    p.halo.scale.setScalar(p.size * (2 + 1.6 * sk));
    p.haloBase = p.halo.material.opacity;

    const el = document.createElement('div');
    el.className = 'label' + (p.core ? '' : ' faint');
    el.textContent = p.name;
    p.labelEl = el;
    p.label = new CSS2DObject(el);
    p.label.position.set(0, 0.45, 0);   // 스프라이트 크기 기준, 빛 위쪽에 이름
    p.sprite.add(p.label);

    p.group.obj.add(p.halo, p.sprite);
  }
}

/* ---------------- 상호작용 ---------------- */

function bindUI() {
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#search-input').value.trim();
    if (!q) return;
    const p = byName.get(q) || players.find((x) => x.name.includes(q));
    if (p) { setFocus(p); $('#search-input').blur(); }
    else $('#search-input').setCustomValidity('찾는 이름이 없어요 (10판 이상만 표시돼요)'), $('#search-input').reportValidity();
  });
  $('#search-input').addEventListener('input', (e) => e.target.setCustomValidity(''));
  $('#panel-close').addEventListener('click', () => setFocus(null));
  $('#help-btn').addEventListener('click', () => $('#help').showModal());

  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown', (e) => down.set(e.clientX, e.clientY));
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;   // 드래그는 무시
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(players.map((p) => p.sprite))[0];
    const p = hit?.object.userData.player;
    if (!p) { setTarget(null); return; }
    if (!focus) setFocus(p);
    else if (p === focus) setTarget(null);
    else setTarget(p);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(players.map((p) => p.sprite))[0];
    renderer.domElement.style.cursor = hit ? 'pointer' : '';
  });

  // 패널·비교 카드 안의 이름 버튼
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-person]');
    if (!btn) return;
    const p = byName.get(btn.dataset.person);
    if (!p) return;
    if (btn.dataset.action === 'focus') setFocus(p);
    else setTarget(p);
  });
}

function setFocus(p) {
  focus = p;
  target = null;
  $('#intro').classList.add('hide');
  $('#compare').hidden = true;
  history.replaceState(null, '', p ? `#name=${encodeURIComponent(p.name)}` : location.pathname);
  if (p) {
    $('#search-input').value = p.name;
    renderPanel(p);
    $('#panel').hidden = false;
    $('#panel').scrollTop = 0;
    flyTo(p);
  } else {
    $('#panel').hidden = true;
    $('#intro').classList.remove('hide');
    flyTo(null);
  }
  updateViewOffset();
  rebuildMyOrbit();
  rebuildLinks();
  updateHighlight();
}

function setTarget(p) {
  if (!focus) return;
  target = p;
  if (p) {
    renderCompare(focus, p);
    $('#compare').hidden = false;
  } else {
    $('#compare').hidden = true;
  }
  rebuildLinks();
  updateHighlight();
}

function flyTo(p) {
  fly.active = true;
  fly.start = performance.now();
  fly.fromPos.copy(camera.position);
  fly.fromTarget.copy(controls.target);
  fly.follow = p;
  if (p) {
    // 가까운 3명이 모두 화면에 들어오는 거리 (좁은 화면이면 가로 시야 기준)
    const reach = Math.max(...p.similar.map((s) => byName.get(s.name).world.distanceTo(p.world)), 1);
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const fit = Math.min(Math.tan(halfFov), Math.tan(halfFov) * camera.aspect * (innerWidth > 760 ? 0.75 : 1));
    fly.dist = THREE.MathUtils.clamp((reach * 1.25) / fit + reach, FOCUS_MIN_DIST, FOCUS_MAX_DIST);
  }
}

function updateViewOffset() {
  // 패널에 가려지지 않도록 화면 중심을 옮긴다 (데스크톱: 왼쪽, 모바일: 위쪽)
  const w = innerWidth, h = innerHeight;
  if (!focus) camera.clearViewOffset();
  else if (w <= 760) camera.setViewOffset(w, h, 0, h * 0.22, w, h);
  else camera.setViewOffset(w, h, 190, 0, w, h);
  camera.updateProjectionMatrix();
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  updateViewOffset();
}

/* ---------------- 강조와 연결선 ---------------- */

function roleOf(p) {
  if (!focus) return null;
  if (p === focus) return 'me';
  if (p === target) return 'target';
  if (focus.similar.some((s) => s.name === p.name)) return 'near';
  if (focus.opposite.name === p.name) return 'far';
  const rel = focus.relations.find((r) => r.name === p.name && r.labels.length);
  if (rel) return [...rel.labels].sort((x, y) => REL_ORDER.indexOf(x) - REL_ORDER.indexOf(y))[0];
  return null;
}

function updateHighlight() {
  for (const p of players) {
    const role = roleOf(p);
    const mat = p.sprite.material;
    let color = COLORS.base, opacity = p.baseOpacity, scale = p.size;
    if (focus && !role) opacity *= 0.3;
    if (role === 'me') { color = COLORS.me; opacity = 1; scale = p.size * 1.5; }
    else if (role === 'near') { color = COLORS.near; opacity = 1; }
    else if (role === 'far') { color = COLORS.far; opacity = 0.95; }
    else if (role === 'target') { color = COLORS.base; opacity = 1; scale = p.size * 1.3; }
    else if (COLORS[role]) { color = COLORS[role]; opacity = 0.95; }
    mat.color.copy(color);
    mat.opacity = opacity;
    p.sprite.scale.setScalar(scale);
    p.halo.material.color.copy(color);
    p.halo.material.opacity = focus && !role ? p.haloBase * 0.3 : p.haloBase;

    const cls = { me: 'me', near: 'near', far: 'far', target: 'target' }[role] || (role ? 'rel' : '');
    p.labelEl.className = 'label' + (p.core ? '' : ' faint') + (cls ? ` ${cls}` : '') + (focus && !role ? ' dim' : '');
  }
}

function rebuildLinks() {
  for (const l of links) { scene.remove(l.line); l.line.geometry.dispose(); l.line.material.dispose(); }
  links.length = 0;
  if (!focus) return;

  const add = (other, color, opts = {}) => {
    const b = byName.get(other);
    if (!b) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const mat = opts.dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity: opts.opacity ?? 0.6, dashSize: 0.5, gapSize: 0.4, depthWrite: false })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity: opts.opacity ?? 0.6, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    scene.add(line);
    links.push({ line, a: focus, b, dashed: !!opts.dashed });
  };

  for (const s of focus.similar) add(s.name, COLORS.near, { opacity: 0.55 });
  add(focus.opposite.name, COLORS.far, { dashed: true, opacity: 0.35 });
  for (const r of focus.relations) {
    if (r.labels.length && r.name !== target?.name) add(r.name, COLORS[r.labels[0]], { opacity: 0.4 });
  }
  if (target) add(target.name, new THREE.Color('#ffffff'), { opacity: 0.7 });
}

const _a = new THREE.Vector3();

function updateLinks() {
  for (const l of links) {
    l.line.geometry.attributes.position.array.set([l.a.world.x, l.a.world.y, l.a.world.z, l.b.world.x, l.b.world.y, l.b.world.z]);
    l.line.geometry.attributes.position.needsUpdate = true;
    l.line.geometry.computeBoundingSphere();
    if (l.dashed) l.line.computeLineDistances();
  }
}

/* ---------------- 루프 ---------------- */

const _goalPos = new THREE.Vector3(), _goalTarget = new THREE.Vector3(), _dir = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  pulse(core, t);
  for (const g of groups.values()) pulse(g.star, t, g.phase);
  updateBodies(t);
  updateLinks();

  if (fly.active) {
    const k = Math.min(1, (performance.now() - fly.start) / (FLY_SECONDS * 1000));
    const e = 1 - Math.pow(1 - k, 3);
    if (fly.follow) {
      _goalTarget.copy(fly.follow.world);
      _dir.subVectors(fly.fromPos, fly.fromTarget).normalize();
      _goalPos.copy(_goalTarget).addScaledVector(_dir, fly.dist);
    } else {
      _goalTarget.set(0, 0, 0);
      _goalPos.copy(OVERVIEW);
    }
    controls.target.lerpVectors(fly.fromTarget, _goalTarget, e);
    camera.position.lerpVectors(fly.fromPos, _goalPos, e);
    if (k >= 1) fly.active = false;
  } else if (focus) {
    // 선택한 사람이 공전하는 만큼 시점도 따라간다
    const delta = _a.subVectors(focus.world, controls.target);
    controls.target.add(delta);
    camera.position.add(delta);
  }

  controls.update(dt);
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

/* ---------------- 패널 ---------------- */

function styleVector(p) {
  const out = [];
  for (const [g, cols] of Object.entries(data.feature_groups)) {
    const w = data.method.weights[g] / Math.sqrt(cols.length);
    for (const c of cols) out.push((p.z[c] || 0) * w);
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
}

function orbitPhrase(sim) {
  if (sim >= 0.5) return '아주 가까운 궤도';
  if (sim >= 0.25) return '가까운 궤도';
  if (sim >= -0.1) return '조금 떨어진 궤도';
  if (sim >= -0.4) return '먼 궤도';
  return '정반대편 궤도';
}

function traitText(key, z) {
  const [hi, lo] = TRAIT_TEXT[key] || [data.feature_labels[key] + ' 높음', data.feature_labels[key] + ' 낮음'];
  return z >= 0 ? hi : lo;
}

function personBtn(name, sub, color, extraHtml = '') {
  const p = byName.get(name);
  return `<button class="person" type="button" data-person="${esc(name)}">
    <span class="dot" style="background:${color}"></span>
    <span class="who">${esc(name)}${p && !p.core ? ' <span class="badge">관측 중</span>' : ''}${extraHtml}</span>
    <span class="sub">${sub}</span>
  </button>`;
}

function renderPanel(p) {
  const s = p.stats;
  const n = p.games;
  const rc = s.rank_counts;
  const rankColors = ['#ffd27a', '#9be3a5', '#7aa8ff', '#ff7a8a'];

  const near = p.similar.map((x) =>
    personBtn(x.name, orbitPhrase(x.sim), 'var(--near)')).join('');
  const far = personBtn(p.opposite.name, '정반대편 궤도', 'var(--far)');

  // 관계 태그(단짝·라이벌)가 붙은 사람만 순서대로 보여준다
  const relRows = p.relations.filter((r) => r.labels.length)
    .sort((a, b) => REL_ORDER.indexOf(a.labels[0]) - REL_ORDER.indexOf(b.labels[0]));
  const rels = relRows.map((r) => {
    const labels = [...r.labels].sort((a, b) => REL_ORDER.indexOf(a) - REL_ORDER.indexOf(b));
    const tags = labels.map((l) => ` <span class="tag ${l}" title="${REL_DESC[l]}">${l}</span>`).join('');
    return personBtn(r.name, `동탁 ${r.co}판 · 내가 위 ${pct(r.win_rate)}`, `var(--${REL_VAR[labels[0]]})`, tags);
  }).join('');

  const chips = [
    ...p.traits.high.map((k) => `<span class="chip up">${traitText(k, 1)}</span>`),
    ...p.traits.low.map((k) => `<span class="chip down">${traitText(k, -1)}</span>`),
  ].join('') || '<span class="muted">두드러지게 튀는 지표 없이 고르게 퍼져 있어요</span>';

  const profile = Object.entries(data.feature_groups).map(([g, cols]) => `
    <div class="feat-group"><h4>${GROUP_NAMES[g]}</h4>
      ${cols.map((c) => featRow(c, p)).join('')}
    </div>`).join('');

  const partners = p.partners.map((x) => `${esc(x.name)} ${x.co}`).join(' · ');

  $('#panel-body').innerHTML = `
    <h2 class="p-name">${esc(p.name)}${p.core ? '' : '<span class="badge">관측 중</span>'}</h2>
    <p class="p-meta">${n}판 · 평균 순위 ${s.avg_rank.toFixed(2)} · 평균 ${signed(p.skill.avg_pt)}pt · ${s.first_game.slice(2).replaceAll('-', '.')}부터</p>
    ${p.core ? '' : `<p class="note">아직 ${n}판이라 위치가 흔들릴 수 있어요. 20판이 넘으면 지도에 정식으로 반영돼요.</p>`}

    <div class="section"><h3>가까운 궤도의 사람들</h3>${near}${far}</div>
    ${rels ? `<div class="section"><h3>실제 대국에서의 관계</h3>${rels}</div>` : ''}
    <div class="section"><h3>두드러진 점</h3><div class="traits">${chips}</div></div>

    <div class="section"><h3>착순 분포</h3>
      <div class="rank-bar">${rc.map((c, i) => `<span style="width:${(c / n) * 100}%;background:${rankColors[i]}"></span>`).join('')}</div>
      <div class="rank-legend">${rc.map((c, i) => `<span>${RANK_NAMES[i]} ${pct(c / n)}</span>`).join('')}</div>
    </div>

    <div class="section"><h3>자주 동탁한 사람</h3><p class="muted" style="margin:0">${partners}</p></div>

    <div class="section">
      <details class="profile"><summary>성향 지표 전체 보기 (평균 대비)</summary>${profile}</details>
    </div>
  `;
}

function featValue(key, v) {
  if (key === 'score_std' || key === 'win_margin' || key === 'loss_floor') return Math.round(v).toLocaleString();
  if (key === 'recovery') return (-v).toFixed(2) + '위';
  if (key === 'trend') return signed(v, 2);
  if (key === 'avg_run_len' || key === 'max_run') return v.toFixed(1);
  if (key === 'opp_strength') return signed(v, 2);
  if (key === 'partner_diversity') return v.toFixed(2);
  return pct(v);
}

function featRow(key, p) {
  const z = Math.max(-2.5, Math.min(2.5, p.z[key]));
  const w = (Math.abs(z) / 2.5) * 50;
  const left = z >= 0 ? 50 : 50 - w;
  const color = z >= 0 ? 'var(--pos)' : 'var(--neg)';
  return `<div class="feat-row" title="${esc(traitText(key, p.z[key]))} (z ${signed(p.z[key], 2)})">
    <span class="lbl">${esc(data.feature_labels[key])}</span>
    <span class="zbar"><i style="left:${left}%;width:${w}%;background:${color}"></i></span>
    <span class="val">${featValue(key, p.features[key])}</span>
  </div>`;
}

function renderCompare(me, other) {
  const sim = cosine(me.vec, other.vec);
  const ranked = players.filter((x) => x !== me).map((x) => [x, cosine(me.vec, x.vec)]).sort((a, b) => b[1] - a[1]);
  const order = ranked.findIndex(([x]) => x === other) + 1;

  const keys = Object.keys(data.feature_labels);
  const shared = keys
    .filter((k) => Math.sign(me.z[k]) === Math.sign(other.z[k]) && Math.abs(me.z[k]) >= 0.6 && Math.abs(other.z[k]) >= 0.6)
    .sort((a, b) => Math.min(Math.abs(other.z[b]), Math.abs(me.z[b])) - Math.min(Math.abs(other.z[a]), Math.abs(me.z[a])))
    .slice(0, 2);
  const diff = keys
    .filter((k) => Math.sign(me.z[k]) !== Math.sign(other.z[k]))
    .sort((a, b) => Math.abs(me.z[b] - other.z[b]) - Math.abs(me.z[a] - other.z[a]))
    .slice(0, 2);

  const rel = me.relations.find((r) => r.name === other.name);
  let h2h = '<p class="muted">동탁한 판이 3판 미만이에요.</p>';
  if (rel) {
    const tags = rel.labels.map((l) => `<span class="tag ${l}" title="${REL_DESC[l]}">${l}</span>`).join('');
    h2h = `<p>${tags}동탁 <b>${rel.co}판</b> · 같은 판에서 내가 위였던 적 <b>${pct(rel.win_rate)}</b></p>`;
  }

  $('#compare').innerHTML = `
    <h3>${esc(me.name)} ↔ ${esc(other.name)}</h3>
    <p class="orbit-line">${orbitPhrase(sim)} · 나와 닮은 순서 ${order}번째 / ${ranked.length}명</p>
    ${h2h}
    ${shared.length ? `<p><span class="muted">둘 다</span> ${shared.map((k) => traitText(k, me.z[k])).join(', ')}</p>` : ''}
    ${diff.map((k) => `<p><span class="muted">나는</span> ${traitText(k, me.z[k])}<br><span class="muted">${esc(other.name)}님은</span> ${traitText(k, other.z[k])}</p>`).join('')}
    <div class="actions">
      <button type="button" data-person="${esc(other.name)}" data-action="focus">${esc(other.name)} 기준으로 보기</button>
    </div>
  `;
}
