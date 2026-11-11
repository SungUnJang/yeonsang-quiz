/* =====================================================================
 *  연상퀴즈 클라이언트
 *  ※ 힌트 간격(4초)·제한시간 등 게임 규칙은 server.js 상단 CONFIG 에서 바꿉니다.
 * ===================================================================== */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  /* ---------- 내 고유 ID (재접속용, 브라우저에 저장) ---------- */
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  let playerId = localStorage.getItem('yq_pid');
  if (!playerId) { playerId = uuid(); localStorage.setItem('yq_pid', playerId); }

  const socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 3000 });

  let state = null;
  let clockOffset = 0; // 서버시간 - 내 시간
  let rooms = [];
  let pendingRoomId = null;
  const now = () => Date.now() + clockOffset;

  /* ---------- 화면 전환 ---------- */
  function show(id) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }
  const current = () => ($('.screen.active') || {}).id;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function openModal(id) { $(id).classList.add('show'); }
  $$('.modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.hasAttribute('data-close')) m.classList.remove('show');
    })
  );

  /* ---------- 반짝이 ---------- */
  (function sparkles() {
    const box = $('#sparkles');
    for (let i = 0; i < 28; i++) {
      const s = document.createElement('i');
      s.style.left = Math.random() * 100 + '%';
      s.style.top = Math.random() * 100 + '%';
      s.style.setProperty('--d', 2 + Math.random() * 4 + 's');
      s.style.animationDelay = -Math.random() * 5 + 's';
      box.appendChild(s);
    }
  })();

  /* =====================================================================
   *  1. 시작 화면
   * ===================================================================== */
  const titleImg = $('#titleImg');
  const setImgMode = () => $('#titleWrap').classList.add('img-mode');
  if (titleImg.complete && titleImg.naturalWidth) setImgMode();
  titleImg.addEventListener('load', setImgMode);
  titleImg.addEventListener('error', () => $('#titleWrap').classList.remove('img-mode'));

  $$('.tbtn').forEach((b) =>
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'start') { show('screen-rooms'); socket.emit('getRooms'); }
      if (act === 'help') openModal('#helpModal');
      if (act === 'exit') { openModal('#byeModal'); try { window.close(); } catch (e) {} }
    })
  );

  /* =====================================================================
   *  2. 퀴즈방 목록
   * ===================================================================== */
  const nick = $('#nickname');
  nick.value = localStorage.getItem('yq_name') || '';
  nick.addEventListener('input', () => localStorage.setItem('yq_name', nick.value.trim()));
  $('#btnRoomsBack').onclick = () => show('screen-title');

  function myName() {
    const n = nick.value.trim();
    if (!n) { toast('닉네임을 먼저 입력해주세요!'); nick.focus(); return null; }
    localStorage.setItem('yq_name', n);
    return n;
  }

  function renderRooms() {
    const grid = $('#roomGrid');
    const myRoom = state ? state.roomId : null;
    grid.innerHTML = rooms
      .map((r, i) => {
        let cls = 'closed', st = '🔒 미개설';
        if (r.open) {
          if (r.phase === 'waiting') { cls = 'waiting'; st = `입장 가능 ${r.count}/${r.max}`; }
          else if (r.phase === 'finished') { cls = 'playing'; st = `게임 종료 ${r.count}/${r.max}`; }
          else { cls = 'playing'; st = `${r.round}라운드 진행 중`; }
        }
        return `<div class="room-card ${cls} ${myRoom === r.id ? 'mine' : ''}" data-id="${r.id}" style="--i:${i}">
          <div class="num">${r.id}</div><div class="lbl">번 퀴즈방</div>
          <div class="st">${st}</div>
          <div class="names">${r.open ? esc(r.names.join(', ')) : ''}</div></div>`;
      })
      .join('');
    grid.querySelectorAll('.room-card').forEach((c) => (c.onclick = () => clickRoom(Number(c.dataset.id))));
  }

  function clickRoom(id) {
    const r = rooms.find((x) => x.id === id);
    if (!r) return;
    const name = myName();
    if (!name) return;
    if (!r.open) {
      pendingRoomId = id;
      $('#pwTitle').textContent = `${id}번 퀴즈방 개설`;
      $('#pwInput').value = '';
      openModal('#pwModal');
      setTimeout(() => $('#pwInput').focus(), 100);
      return;
    }
    socket.emit('joinRoom', { roomId: id, name }, (res) => {
      if (!res.ok) return toast(res.msg || '입장할 수 없어요.');
      show('screen-game');
    });
  }

  $('#pwForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = myName();
    if (!name || !pendingRoomId) return;
    socket.emit('createRoom', { roomId: pendingRoomId, password: $('#pwInput').value, name }, (res) => {
      if (!res.ok) return toast(res.msg || '개설 실패');
      $('#pwModal').classList.remove('show');
      toast(`${pendingRoomId}번 퀴즈방이 개설됐어요! ✨`);
      show('screen-game');
    });
  });

  /* =====================================================================
   *  3. 게임 화면
   * ===================================================================== */
  // ---- 캐릭터(뒷모습) SVG : 슬롯 0~4 ----
  const SKIN = '#f6d3bd';
  function charSVG(slot) {
    const robe = `
      <path d="M10 134 Q12 98 40 90 L80 90 Q108 98 110 134 Z" fill="#2a2150"/>
      <path d="M10 134 Q12 98 40 90 L80 90 Q108 98 110 134" fill="none" stroke="#7d6bd6" stroke-width="2" opacity=".6"/>
      <path d="M32 92 Q60 112 88 92 Q86 106 60 114 Q34 106 32 92Z" fill="#3a2f72"/>`;
    const scarf = (c1, c2) => `
      <path d="M36 86 Q60 98 84 86 L85 95 Q60 107 35 95Z" fill="${c1}"/>
      <path d="M44 90 L46 99 M56 93 L57 102 M68 93 L67 102 M78 90 L76 99" stroke="${c2}" stroke-width="3"/>`;
    const ears = `<ellipse cx="24" cy="58" rx="6" ry="8" fill="${SKIN}"/><ellipse cx="96" cy="58" rx="6" ry="8" fill="${SKIN}"/>`;
    const head = (c) => `<circle cx="60" cy="52" r="36" fill="${c}"/>`;
    const strands = (c) => `<path d="M60 20 Q48 50 42 84 M60 20 Q72 50 78 84 M60 20 Q58 52 60 88 M60 20 Q36 40 28 70 M60 20 Q84 40 92 70" stroke="${c}" stroke-width="2.2" fill="none" opacity=".55" stroke-linecap="round"/>`;
    const rim = `<circle cx="60" cy="52" r="35" fill="none" stroke="rgba(210,190,255,.55)" stroke-width="2"/>`;
    let inner = '';
    switch (slot) {
      case 0: // 검은 머리 + 파란 목도리
        inner = robe + scarf('#2f4fa8', '#7fa2ff') + ears + head('#2b2233') +
          `<path d="M26 40 L30 16 L42 28 L50 8 L60 22 L70 6 L78 26 L90 14 L94 40Z" fill="#2b2233"/>` +
          strands('#141018') + rim;
        break;
      case 1: // 긴 갈색 머리 + 보라 리본
        inner = robe + scarf('#5b3fa8', '#a58cff') + ears + head('#4b2c2e') +
          `<path d="M24 52 Q14 104 22 132 L98 132 Q106 104 96 52Z" fill="#4b2c2e"/>` +
          `<path d="M40 70 Q36 100 38 130 M60 80 Q60 104 60 132 M80 70 Q84 100 82 130" stroke="#2e1a1c" stroke-width="2.4" fill="none" opacity=".6"/>` +
          strands('#2e1a1c') +
          `<path d="M60 40 L34 26 Q28 40 34 54 Z" fill="#6c4fc4" stroke="#3b2a7a" stroke-width="2"/>` +
          `<path d="M60 40 L86 26 Q92 40 86 54 Z" fill="#6c4fc4" stroke="#3b2a7a" stroke-width="2"/>` +
          `<path d="M56 44 L48 64 M64 44 L72 64" stroke="#6c4fc4" stroke-width="5" stroke-linecap="round"/>` +
          `<circle cx="60" cy="40" r="7" fill="#8a6ae0" stroke="#3b2a7a" stroke-width="2"/>` + rim;
        break;
      case 2: // 하얀 곱슬 머리
        inner = robe + scarf('#2a6f8a', '#7fe3ff') + ears + head('#ecebf6') +
          [[30, 32, 13], [44, 20, 14], [60, 15, 14], [76, 20, 14], [90, 32, 13], [25, 50, 11], [95, 50, 11], [60, 26, 10]]
            .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#ecebf6"/>`).join('') +
          `<path d="M40 30 Q46 40 42 52 M60 26 Q64 40 58 56 M80 30 Q74 42 78 54 M50 60 Q54 72 50 82 M70 60 Q66 72 70 82" stroke="#bdbbd6" stroke-width="2.4" fill="none" stroke-linecap="round"/>` +
          `<circle cx="60" cy="52" r="35" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="2"/>`;
        break;
      case 3: // 마법사 모자
        inner = robe + scarf('#4a3a8a', '#9d8cff') + ears + head('#2b2233') + strands('#141018') +
          `<path d="M30 34 L56 -6 Q66 -14 74 -4 L100 2 Q86 4 84 12 L90 34Z" fill="#2c2552"/>` +
          `<path d="M56 -6 Q66 -14 74 -4" stroke="#6a5bd0" stroke-width="2" fill="none"/>` +
          `<circle cx="101" cy="3" r="4" fill="#8a7ae0"/>` +
          `<path d="M33 26 L88 26 L90 34 L31 34Z" fill="#7a4fd0"/>` +
          `<rect x="52" y="24" width="14" height="12" rx="2" fill="none" stroke="#f3c95b" stroke-width="3"/>` +
          `<ellipse cx="60" cy="36" rx="56" ry="11" fill="#231d45"/>` +
          `<ellipse cx="60" cy="34" rx="56" ry="10" fill="#2c2552" stroke="#5a4bb0" stroke-width="1.5"/>`;
        break;
      default: // 금발
        inner = robe + scarf('#8a5a2a', '#ffcf8a') + ears + head('#e8c38e') +
          `<path d="M26 42 Q28 22 40 24 Q44 10 56 16 Q62 4 72 14 Q84 10 86 24 Q96 26 94 42Z" fill="#e8c38e"/>` +
          strands('#b98d55') +
          `<path d="M54 16 Q58 6 64 10" stroke="#e8c38e" stroke-width="4" fill="none" stroke-linecap="round"/>` +
          `<circle cx="60" cy="52" r="35" fill="none" stroke="rgba(255,235,190,.6)" stroke-width="2"/>`;
    }
    return `<svg viewBox="0 -14 120 148" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  }
  /* ---- 캐릭터 뒷모습 이미지 ----
   *  public/images/char1.png ~ char5.png 를 넣으면 SVG 대신 그 이미지가 사용됩니다.
   *  (자리 순서: char1=1번 자리 ... char5=5번 자리 / .png .webp .jpg .jpeg 모두 가능)
   *  ✔ 흰색 배경 이미지여도 괜찮아요 → 바깥쪽 흰 배경을 자동으로 투명하게 지우고,
   *    여백도 자동으로 잘라내서 5명 크기를 똑같이 맞춰요.
   *  이미지가 없으면 위의 charSVG() 그림이 대신 나와요. */
  const CHAR_EXTS = ['png', 'webp', 'jpg', 'jpeg', 'PNG', 'JPG'];
  const charSrc = [];          // 자리별 최종 이미지(dataURL)
  const WHITE_CUT = 228;       // 이 값보다 밝은 바깥쪽 흰색을 배경으로 판단 (0~255)

  function loadImg(src) {
    return new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = src; });
  }
  async function loadCharFile(n) {
    for (const ext of CHAR_EXTS) {
      try { return await loadImg(`images/char${n}.${ext}`); } catch (e) { /* 다음 확장자 시도 */ }
    }
    return null;
  }
  // 바깥 테두리와 연결된 흰 배경만 지움 (캐릭터 안쪽의 흰 머리 등은 외곽선 덕분에 그대로 남음)
  function cutBackground(im) {
    const MAX = 640;
    const k = Math.min(1, MAX / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.round(im.naturalWidth * k), h = Math.round(im.naturalHeight * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d'); cx.drawImage(im, 0, 0, w, h);
    let data;
    try { data = cx.getImageData(0, 0, w, h); } catch (e) { return { cv, box: [0, 0, 1, 1] }; }
    const d = data.data, seen = new Uint8Array(w * h), stack = [];
    const isBg = (i) => { const o = i * 4; return d[o + 3] < 30 || (Math.min(d[o], d[o + 1], d[o + 2]) > WHITE_CUT && Math.max(d[o], d[o + 1], d[o + 2]) - Math.min(d[o], d[o + 1], d[o + 2]) < 28); };
    const push = (x, y) => { const i = y * w + x; if (!seen[i] && isBg(i)) { seen[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      d[i * 4 + 3] = 0;
      if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
    }
    // 가장자리 흰 테두리(번짐)를 부드럽게
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (seen[i]) continue;
      if (seen[i - 1] || seen[i + 1] || seen[i - w] || seen[i + w]) {
        const o = i * 4, lum = (d[o] + d[o + 1] + d[o + 2]) / 3;
        if (lum > 170) d[o + 3] = Math.round(255 * (255 - lum) / 85);
      }
    }
    cx.putImageData(data, 0, 0);
    // 캐릭터가 차지하는 영역(비율) 계산
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 <= x0) return { cv, box: [0, 0, 1, 1] };
    return { cv, box: [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h] };
  }
  (async function prepareChars() {
    const res = await Promise.all([1, 2, 3, 4, 5].map(async (n) => {
      const im = await loadCharFile(n);
      return im ? cutBackground(im) : null;
    }));
    const ok = res.filter(Boolean);
    if (!ok.length) return;
    // 5장 모두 같은 영역으로 잘라야 캐릭터끼리 크기·바닥선이 맞아요
    const u = ok.reduce((a, r) => [Math.min(a[0], r.box[0]), Math.min(a[1], r.box[1]), Math.max(a[2], r.box[2]), Math.max(a[3], r.box[3])], [1, 1, 0, 0]);
    res.forEach((r, i) => {
      if (!r) return;
      const { cv } = r;
      const sx = u[0] * cv.width, sy = u[1] * cv.height, sw = (u[2] - u[0]) * cv.width, sh = (u[3] - u[1]) * cv.height;
      const out = document.createElement('canvas'); out.width = Math.round(sw); out.height = Math.round(sh);
      out.getContext('2d').drawImage(cv, sx, sy, sw, sh, 0, 0, out.width, out.height);
      charSrc[i] = out.toDataURL('image/png');
    });
    const first = res.find(Boolean).cv;
    const ar = ((u[2] - u[0]) * first.width) / ((u[3] - u[1]) * first.height);
    document.documentElement.style.setProperty('--char-ar', Math.max(0.5, Math.min(1.4, ar)).toFixed(3));
    lastCharsHtml = '';
    if (state) renderChars();
  })();
  function charArt(slot) {
    return charSrc[slot] ? `<img class="char-img" src="${charSrc[slot]}" alt="" draggable="false" />` : charSVG(slot);
  }

  const O_SVG = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="36" fill="none" stroke="#fff" stroke-width="16"/><circle cx="50" cy="50" r="36" fill="none" stroke="#3ec9ff" stroke-width="10"/></svg>`;
  const X_SVG = `<svg viewBox="0 0 100 100"><path d="M20 20 L80 80 M80 20 L20 80" stroke="#fff" stroke-width="20" stroke-linecap="round"/><path d="M20 20 L80 80 M80 20 L20 80" stroke="#ff3d63" stroke-width="12" stroke-linecap="round"/></svg>`;

  // ---- 힌트 버블 위치 (x%, y%, 큰버블여부) ----
  // 힌트 6개 배치
  const POS_WIDE = [[50, 42, 1], [24, 30], [76, 30], [12, 68], [88, 68], [50, 84]];
  const POS_TALL = [[50, 17, 1], [24, 40], [76, 40], [24, 64], [76, 64], [50, 84]];
  const RING_ROT = [-10, 14, -16, 18, -14, 10];
  const isTall = () => window.innerWidth / window.innerHeight < 1;

  function placeBubble(el, i) {
    const list = isTall() ? POS_TALL : POS_WIDE;
    const p = list[i % list.length];
    el.style.setProperty('--x', p[0] + '%');
    el.style.setProperty('--y', p[1] + '%');
    el.classList.toggle('big', !!p[2]);
  }
  window.addEventListener('resize', () => $$('#bubbles .bubble').forEach((b, i) => placeBubble(b, i)));

  function wordFont(word) {
    const len = [...word].length;
    const k = len <= 2 ? 0.3 : len === 3 ? 0.27 : len === 4 ? 0.24 : len === 5 ? 0.21 : len <= 7 ? 0.18 : 0.15;
    return `calc(var(--size) * ${k})`;
  }

  function renderBubbles() {
    const box = $('#bubbles');
    const key = state.roomId + '-' + state.round;
    if (box.dataset.key !== key) { box.innerHTML = ''; box.dataset.key = key; }
    const hints = state.phase === 'waiting' ? [] : state.hints;
    const have = box.children.length;
    for (let i = have; i < hints.length; i++) {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.style.setProperty('--rot', RING_ROT[i % RING_ROT.length] + 'deg');
      b.style.setProperty('--delay', -i * 0.7 + 's');
      // 동그란 구슬 대신 몽글몽글한 마법 안개 + 반짝이 (번호 없이 단어만)
      b.innerHTML = `<span class="mist"></span><span class="mist m2"></span>
        <span class="spark s1">✦</span><span class="spark s2">✧</span><span class="spark s3">✦</span>
        <span class="word" style="--fs:${wordFont(hints[i])}">${esc(hints[i])}</span>`;
      placeBubble(b, i);
      box.appendChild(b);
    }
    box.style.opacity = state.phase === 'reveal' ? '0.3' : '1';
  }

  let lastCharsHtml = '';
  function renderChars() {
    const players = state.players;
    const top = Math.max(0, ...players.map((p) => p.score));
    const reveal = state.phase === 'reveal';
    const isHost = state.hostId === state.me;
    let html = '';
    for (let s = 0; s < state.config.maxPlayers; s++) {
      const p = players.find((x) => x.slot === s);
      if (!p) {
        html += `<div class="char empty" data-slot="${s}"><div class="avatar">${charArt(s)}</div>
          <div class="plate"><div class="nm">빈 자리</div><div class="sc">-</div></div></div>`;
        continue;
      }
      const me = p.id === state.me;
      let speech = '', mark = '', gain = '';
      if (state.phase === 'playing' && p.submitted) {
        speech = `<div class="speech sent">${me ? esc(p.answer) : '제출 완료!'}</div>`;
      }
      if (reveal) {
        speech = p.answer ? `<div class="speech">${esc(p.answer)}</div>` : `<div class="speech none">무응답</div>`;
        mark = `<div class="mark ${p.correct ? 'o' : 'x'}">${p.correct ? O_SVG : X_SVG}</div>`;
        if (p.gained > 0) gain = `<div class="gain ${p.double ? 'dbl' : ''}">+${p.gained}</div>`;
      }
      // ✨ 두배 찬스 대상 : 캐릭터 뒤에 x2
      const x2 = p.double && state.phase !== 'waiting' && state.phase !== 'finished' ? '<div class="x2">x2</div>' : '';
      // 👢 방장에게만 보이는 내보내기 버튼
      const kick = isHost && !me ? `<button class="kick-btn" data-kick="${esc(p.id)}" data-name="${esc(p.name)}" title="내보내기">✕</button>` : '';
      const badge = top > 0 && p.score === top ? '👑' : '⭐';
      html += `<div class="char ${me ? 'me' : ''} ${p.connected ? '' : 'off'} ${x2 ? 'double' : ''}" data-slot="${s}">
        ${speech}${kick}
        <div class="avatar">${x2}${charArt(s)}${mark}${gain}${p.connected ? '' : '<span class="off-tag">연결 끊김</span>'}</div>
        <div class="plate"><span class="badge">${badge}</span>${p.id === state.hostId ? '<span class="host">방장</span>' : ''}
          <div class="nm">${esc(p.name)}${me ? ' (나)' : ''}</div><div class="sc">${p.score}</div></div></div>`;
    }
    if (html !== lastCharsHtml) { $('#chars').innerHTML = html; lastCharsHtml = html; }
  }

  let lastRoundKey = '';
  function renderGame() {
    if (!state) return;
    const ph = state.phase;
    const me = state.players.find((p) => p.id === state.me);
    const isHost = state.hostId === state.me;

    $('#hudRound').textContent = `${Math.max(1, state.round)} / ${state.totalRounds}`;
    if (ph === 'waiting') { $('#hudTopic').textContent = '대기 중'; $('#hudLen').textContent = ''; }
    else if (ph === 'finished') { $('#hudTopic').textContent = '게임 종료'; $('#hudLen').textContent = ''; }
    else { $('#hudTopic').textContent = state.topic; $('#hudLen').textContent = `(${state.length}글자)`; }

    // 패널
    $('#waitPanel').style.display = ph === 'waiting' ? 'block' : 'none';
    $('#readyBanner').style.display = ph === 'ready' ? 'block' : 'none';
    $('#answerBanner').style.display = ph === 'reveal' ? 'block' : 'none';
    $('#finalPanel').style.display = ph === 'finished' ? 'block' : 'none';

    if (ph === 'waiting') {
      $('#waitTitle').textContent = `${state.roomId}번 퀴즈방 대기실`;
      $('#waitCount').textContent = `참가자 ${state.players.length} / ${state.config.maxPlayers}`;
      $('#waitMsg').textContent = isHost ? '모두 모이면 게임을 시작하세요!' : '방장이 게임을 시작하면 시작돼요!';
      $('#btnStart').style.display = isHost ? '' : 'none';
      $('#btnClose').style.display = isHost ? '' : 'none';
    }
    if (ph === 'ready') {
      const rt = $('#readyText');
      if (rt.textContent !== `ROUND ${state.round}`) {
        rt.textContent = `ROUND ${state.round}`;
        rt.style.animation = 'none'; void rt.offsetWidth; rt.style.animation = '';
      }
      // ✨ 두배 찬스 문구
      const dc = $('#doubleChance');
      const dNames = state.players.filter((p) => p.double).map((p) => p.name);
      dc.style.display = dNames.length ? 'block' : 'none';
      $('#doubleNames').textContent = dNames.join(' · ');
    }
    if (ph === 'reveal') $('#answerText').textContent = state.answer;
    if (ph === 'finished') {
      const sorted = [...state.players].sort((a, b) => b.score - a.score);
      const medals = ['🥇', '🥈', '🥉', '4', '5'];
      let rank = 0, prev = null;
      $('#finalList').innerHTML = sorted.map((p, i) => {
        if (p.score !== prev) { rank = i; prev = p.score; }
        return `<li class="${rank === 0 ? 'first' : ''}"><span class="medal">${medals[rank]}</span>
          <span class="nm">${esc(p.name)}${p.id === state.me ? ' (나)' : ''}</span><span class="sc">${p.score}점</span></li>`;
      }).join('');
      $('#btnRestart').style.display = isHost ? '' : 'none';
    }

    // 답 입력창
    const form = $('#answerForm');
    const input = $('#answerInput');
    const btn = $('#answerBtn');
    const roundKey = state.roomId + '-' + state.round;
    if (roundKey !== lastRoundKey) { input.value = ''; lastRoundKey = roundKey; }
    form.classList.toggle('hidden', ph === 'waiting' || ph === 'finished');
    const submitted = me && me.submitted;
    const canType = ph === 'playing' && !submitted;
    input.disabled = !canType;
    btn.disabled = !canType;
    if (submitted) input.value = me.answer || input.value;
    input.placeholder = ph === 'ready' ? '곧 힌트가 나와요!' : ph === 'reveal' ? '정답 공개 중…' : '정답을 입력하세요 (라운드당 1번!)';

    renderBubbles();
    renderChars();
    tickClock();
  }

  // 타이머 (0.2초마다 갱신)
  function tickClock() {
    if (!state) return;
    const t = $('#hudTimer');
    let sec = state.config.roundTime;
    if (state.phase === 'playing') sec = Math.max(0, Math.ceil((state.endsAt - now()) / 1000));
    else if (state.phase === 'reveal' || state.phase === 'finished') sec = 0;
    t.textContent = sec;
    $('.hud-timer').classList.toggle('danger', state.phase === 'playing' && sec <= 10);
    if (state.phase === 'reveal') {
      const n = Math.max(0, Math.ceil((state.revealEndsAt - now()) / 1000));
      $('#nextText').textContent = state.round >= state.totalRounds ? `최종 결과까지 ${n}초` : `다음 라운드까지 ${n}초`;
    }
  }
  setInterval(tickClock, 200);

  // ---- 버튼 ----
  $('#answerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#answerInput').value.trim();
    if (!text) return;
    socket.emit('submit', { text }, (res) => {
      if (!res.ok) return toast(res.msg || '제출 실패');
      toast('제출 완료! 결과를 기다려주세요 ✨');
    });
  });
  // 👢 내보내기 (방장)
  $('#chars').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kick]');
    if (!b) return;
    if (!confirm(`${b.dataset.name} 님을 내보낼까요?\n(내보낸 플레이어는 이 방에 다시 들어올 수 없어요)`)) return;
    socket.emit('kick', { targetId: b.dataset.kick }, (r) => {
      if (r.ok) toast(`${r.name} 님을 내보냈어요.`);
      else if (r.msg) toast(r.msg);
    });
  });

  $('#btnStart').onclick = () => socket.emit('startGame', {}, (r) => !r.ok && r.msg && toast(r.msg));
  $('#btnRestart').onclick = () => socket.emit('restart', {}, (r) => !r.ok && r.msg && toast(r.msg));
  $('#btnClose').onclick = () => {
    if (!confirm('퀴즈방을 닫을까요? 모든 참가자가 나가게 돼요.')) return;
    socket.emit('closeRoom', {}, (r) => { if (r.ok) leaveToRooms(); else if (r.msg) toast(r.msg); });
  };
  function doLeave() {
    const playing = state && ['ready', 'playing', 'reveal'].includes(state.phase);
    if (playing && !confirm('게임 중에 나가면 점수가 사라져요. 나갈까요?')) return;
    socket.emit('leave', {}, () => leaveToRooms());
  }
  $('#btnLeave').onclick = doLeave;
  $('#btnFinalLeave').onclick = doLeave;

  function leaveToRooms() {
    state = null;
    lastCharsHtml = '';
    $('#bubbles').innerHTML = '';
    $('#bubbles').dataset.key = '';
    show('screen-rooms');
    socket.emit('getRooms');
  }

  /* =====================================================================
   *  소켓 & 재접속 처리
   * ===================================================================== */
  function hello() {
    socket.emit('hello', { playerId }, (res) => {
      if (res && res.ok && !res.inRoom && current() === 'screen-game') {
        toast(res.kickedFrom ? '방장이 퀴즈방에서 내보냈어요.' : '방이 사라졌어요. 목록으로 돌아갑니다.');
        leaveToRooms();
      }
    });
  }
  socket.on('connect', () => { $('#netBadge').classList.remove('show'); hello(); });
  socket.on('disconnect', () => { if (current() === 'screen-game') $('#netBadge').classList.add('show'); });

  socket.on('state', (s) => {
    clockOffset = s.serverNow - Date.now();
    state = s;
    if (current() !== 'screen-game') show('screen-game'); // 재접속 시 바로 게임화면으로
    renderGame();
  });
  socket.on('rooms', (list) => { rooms = list; renderRooms(); });
  socket.on('kicked', () => { toast('방장이 퀴즈방에서 내보냈어요.'); leaveToRooms(); });
  socket.on('roomClosed', () => { toast('방장이 퀴즈방을 닫았어요.'); leaveToRooms(); });

  // 휴대폰 화면을 다시 켰을 때 즉시 재접속/동기화
  function wake() {
    if (document.visibilityState !== 'visible') return;
    if (!socket.connected) socket.connect();
    else hello();
  }
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('online', wake);

  // Render 무료 서버 잠듦 방지용 (페이지가 열려있는 동안 4분마다 신호)
  setInterval(() => fetch('/health').catch(() => {}), 4 * 60 * 1000);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
