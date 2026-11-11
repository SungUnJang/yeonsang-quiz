/* =====================================================================
 *  🎵 연상퀴즈 사운드 (배경음악 + 효과음)
 *
 *  ✔ 음악 파일이 없어도 동작해요 → 브라우저가 직접 연주(Web Audio 합성)해요.
 *  ✔ 원하는 음악/효과음 파일로 바꾸고 싶으면 public/sounds/ 폴더에
 *    아래 이름으로 mp3 파일을 넣으면 그 파일이 우선 사용돼요. (없는 건 합성음)
 *
 *      bgm.mp3      배경음악 (반복 재생)
 *      correct.mp3  정답          wrong.mp3   오답 / 무응답
 *      tick.mp3     시계 째깍     timeup.mp3  시간 종료
 *      hint.mp3     힌트 등장     submit.mp3  정답 제출
 *      round.mp3    라운드 시작   double.mp3  두배 찬스
 *      final.mp3    최종 결과     click.mp3   버튼 클릭
 *
 *  ※ 휴대폰 브라우저 정책상, 화면을 한 번 터치해야 소리가 나기 시작해요.
 * ===================================================================== */
(() => {
  /* -----------------------------------------------------------------
   *  🎚️ 사운드 설정 ─ 여기 숫자만 바꾸면 돼요
   * ----------------------------------------------------------------- */
  const SOUND_CONFIG = {
    BGM_VOLUME: 0.30,     // 배경음악 크기 (0 ~ 1)
    SFX_VOLUME: 0.85,     // 효과음 크기   (0 ~ 1)
    BGM_TEMPO: 128,       // 배경음악 빠르기 (BPM, 클수록 빠름) ─ 합성 음악에만 적용
    TICK_FROM_SEC: 5,     // ⏱ 남은 시간이 몇 초 이하일 때 시계 소리를 낼지
    DUCK_ON_RESULT: 0.35, // 정답/오답 효과음이 나올 때 배경음악을 이만큼 줄임 (0~1, 1이면 안 줄임)
  };

  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null, master, bgmBus, sfxBus, noiseBuf = null;
  const files = {};            // sounds/ 폴더에서 불러온 파일 (AudioBuffer)
  const FILE_NAMES = ['bgm', 'correct', 'wrong', 'tick', 'timeup', 'hint', 'submit', 'round', 'double', 'final', 'click'];

  // 0 = 모두 켜짐, 1 = 배경음악만 끔, 2 = 모두 끔
  let muteLevel = Number(localStorage.getItem('yq_sound') || 0) % 3;
  let mode = 'calm';           // calm(로비·대기·정답공개) / tense(라운드 진행 중)

  /* ---------- 초기화 (첫 터치 때) ---------- */
  function init() {
    if (ctx || !AC) return;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {} // iOS 무음모드에서도 재생
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();     // 소리 깨짐 방지
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp); comp.connect(ctx.destination);
    bgmBus = ctx.createGain(); bgmBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.connect(master);
    applyVolumes();
    // 노이즈(드럼·째깍 소리 재료)
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    loadFiles();
    startBgm();
  }
  function unlock() {
    if (!AC) return;
    if (!ctx) init();
    if (ctx.state === 'suspended' && document.visibilityState === 'visible') ctx.resume().catch(() => {});
  }
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, unlock, { capture: true, passive: true }));

  // 휴대폰 화면이 꺼지거나 다른 앱으로 가면 멈추고, 돌아오면 다시 재생
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.visibilityState === 'hidden') ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  });

  function applyVolumes() {
    if (!ctx) return;
    const t = ctx.currentTime;
    bgmBus.gain.setTargetAtTime(muteLevel === 0 ? SOUND_CONFIG.BGM_VOLUME : 0, t, 0.08);
    sfxBus.gain.setTargetAtTime(muteLevel === 2 ? 0 : SOUND_CONFIG.SFX_VOLUME, t, 0.05);
  }

  async function loadFiles() {
    await Promise.all(FILE_NAMES.map(async (n) => {
      try {
        const r = await fetch(`sounds/${n}.mp3`);
        if (!r.ok) return;
        const ab = await r.arrayBuffer();
        files[n] = await new Promise((ok, no) => ctx.decodeAudioData(ab, ok, no));
      } catch (e) { /* 파일 없음 → 합성음 사용 */ }
    }));
    if (files.bgm) startBgm(true);
  }
  function playFile(name, when) {
    const s = ctx.createBufferSource();
    s.buffer = files[name]; s.connect(sfxBus); s.start(when);
  }

  /* ---------- 기본 악기 ---------- */
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);  // MIDI 번호 → 주파수

  function env(g, t, a, peak, d) {        // 볼륨 모양(어택 → 감쇠)
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function tone(out, t, freq, { type = 'sine', a = 0.005, d = 0.3, vol = 0.3, cutoff = 0, slideTo = 0, detune = 0 } = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.detune.value = detune;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + a + d);
    let node = o;
    if (cutoff) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(cutoff, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.25), t + a + d);
      o.connect(f); node = f;
    }
    node.connect(g); g.connect(out);
    env(g, t, a, vol, d);
    o.start(t); o.stop(t + a + d + 0.05);
  }
  function noise(out, t, { d = 0.1, vol = 0.2, type = 'highpass', freq = 6000, q = 0.7, sweepTo = 0 } = {}) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + d);
    s.connect(f); f.connect(g); g.connect(out);
    env(g, t, 0.002, vol, d);
    s.start(t, Math.random() * 0.5); s.stop(t + d + 0.05);
  }
  const kick = (out, t, vol = 0.9) => tone(out, t, 150, { a: 0.002, d: 0.28, vol, slideTo: 42 });
  const snare = (out, t, vol = 0.35) => { noise(out, t, { d: 0.16, vol, freq: 1600 }); tone(out, t, 210, { type: 'triangle', d: 0.08, vol: vol * 0.6 }); };
  const hat = (out, t, vol = 0.08, open = false) => noise(out, t, { d: open ? 0.12 : 0.035, vol, freq: 7500 });

  /* =================================================================
   *  🎼 배경음악 (합성) ─ 흥미진진한 A단조 퀴즈 루프
   *   calm  : 아르페지오 + 베이스 + 가벼운 하이햇 (로비/대기/정답공개)
   *   tense : 위에 + 킥·스네어·16비트 하이햇·멜로디 (라운드 진행 중)
   * ================================================================= */
  // 코드 진행 (4마디 반복) : Am → F → G → E
  const CHORDS = [
    { bass: 45, tones: [57, 60, 64] },  // Am
    { bass: 41, tones: [57, 60, 65] },  // F
    { bass: 43, tones: [55, 59, 62] },  // G
    { bass: 40, tones: [56, 59, 64] },  // E
  ];
  const ARP = [0, 1, 2, 3, 2, 1, 0, 1, 0, 1, 2, 3, 2, 3, 2, 1];   // 16분음표 아르페지오 순서
  // 진행 중일 때 나오는 짧은 멜로디 (마디별 [16분 위치, MIDI, 길이(16분)])
  const HOOK = [
    [[0, 76, 3], [3, 74, 1], [4, 72, 2], [6, 71, 2], [8, 72, 4], [12, 69, 4]],
    [[0, 72, 3], [3, 74, 1], [4, 76, 2], [6, 77, 2], [8, 76, 6]],
    [[0, 74, 3], [3, 72, 1], [4, 71, 2], [6, 67, 2], [8, 71, 4], [12, 74, 4]],
    [[0, 76, 2], [2, 75, 2], [4, 76, 2], [6, 80, 2], [8, 83, 8]],
  ];
  let bgmTimer = null, step = 0, nextTime = 0, bgmFileSrc = null;

  function startBgm(fileMode = false) {
    if (!ctx) return;
    if (fileMode || files.bgm) {                // 🎵 bgm.mp3 가 있으면 파일로 반복 재생
      clearInterval(bgmTimer); bgmTimer = null;
      if (bgmFileSrc) return;
      bgmFileSrc = ctx.createBufferSource();
      bgmFileSrc.buffer = files.bgm; bgmFileSrc.loop = true;
      bgmFileSrc.connect(bgmBus); bgmFileSrc.start();
      return;
    }
    if (bgmTimer) return;
    step = 0; nextTime = ctx.currentTime + 0.1;
    bgmTimer = setInterval(scheduler, 25);
  }
  function scheduler() {
    if (ctx.state !== 'running') return;
    if (nextTime < ctx.currentTime - 0.2) nextTime = ctx.currentTime + 0.05; // 멈췄다 돌아온 경우
    const sixteenth = 60 / SOUND_CONFIG.BGM_TEMPO / 4;
    while (nextTime < ctx.currentTime + 0.12) {
      playStep(step, nextTime, sixteenth);
      nextTime += sixteenth;
      step = (step + 1) % 64;
    }
  }
  function playStep(s, t, len) {
    const bar = Math.floor(s / 16), pos = s % 16, ch = CHORDS[bar];
    const tense = mode === 'tense';
    const out = bgmBus;
    // 아르페지오 (반짝이는 플럭)
    const tones = [...ch.tones, ch.tones[0] + 12];
    tone(out, t, hz(tones[ARP[pos]] + 12), { type: 'square', d: len * 1.6, vol: tense ? 0.07 : 0.055, cutoff: tense ? 3200 : 2200 });
    // 베이스
    if (tense ? pos % 2 === 0 : pos % 4 === 0) {
      const oct = tense && pos % 4 === 2 ? 12 : 0;
      tone(out, t, hz(ch.bass + oct), { type: 'sawtooth', d: len * (tense ? 1.8 : 3.6), vol: 0.22, cutoff: 700 });
    }
    // 패드 (마디 시작마다 은은한 화음)
    if (pos === 0) ch.tones.forEach((m, i) => tone(out, t, hz(m), { type: 'triangle', a: 0.25, d: len * 15, vol: 0.035, detune: i * 4 - 4 }));
    // 드럼
    if (tense) {
      if (pos % 4 === 0) kick(out, t, 0.75);
      if (pos === 4 || pos === 12) snare(out, t, 0.3);
      if (bar === 3 && pos >= 12) snare(out, t, 0.12 + (pos - 12) * 0.05);  // 4마디째 끝 필인
      hat(out, t, pos % 2 ? 0.035 : 0.06, pos % 4 === 2);
      // 멜로디
      HOOK[bar].forEach(([p, m, l]) => {
        if (p === pos) tone(out, t, hz(m), { type: 'triangle', a: 0.01, d: len * l * 0.95, vol: 0.13 });
      });
    } else if (pos % 4 === 2) {
      hat(out, t, 0.03);
    }
  }

  /* =================================================================
   *  🔔 효과음 (합성)
   * ================================================================= */
  const SYNTH = {
    click(t) { tone(sfxBus, t, 1100, { type: 'triangle', d: 0.06, vol: 0.18 }); },

    // ✨ 힌트 등장 : 반짝 하고 올라가는 마법 소리
    hint(t) {
      [88, 92, 95, 100].forEach((m, i) => tone(sfxBus, t + i * 0.045, hz(m), { type: 'sine', d: 0.35, vol: 0.12 }));
      noise(sfxBus, t, { d: 0.4, vol: 0.05, type: 'bandpass', freq: 5000, q: 2, sweepTo: 9000 });
    },

    // 📮 제출 : 뽁!
    submit(t) { tone(sfxBus, t, 520, { type: 'sine', d: 0.12, vol: 0.35, slideTo: 1250 }); },

    // 🎬 라운드 시작 : 휘익 + 빰-빠밤!
    round(t) {
      noise(sfxBus, t, { d: 0.55, vol: 0.14, type: 'bandpass', freq: 400, q: 1.2, sweepTo: 4000 });
      const brass = (tt, m, d) => { tone(sfxBus, tt, hz(m), { type: 'sawtooth', a: 0.02, d, vol: 0.16, cutoff: 2600 }); tone(sfxBus, tt, hz(m - 12), { type: 'square', a: 0.02, d, vol: 0.06, cutoff: 1500 }); };
      brass(t + 0.45, 67, 0.14); brass(t + 0.62, 67, 0.1); brass(t + 0.76, 72, 0.55);
      kick(sfxBus, t + 0.76, 0.6);
    },

    // 💗 두배 찬스 : 반짝이 상승 두 번 + 종소리
    double(t) {
      for (let r = 0; r < 2; r++) [72, 76, 79, 84, 88].forEach((m, i) => tone(sfxBus, t + r * 0.32 + i * 0.05, hz(m), { type: 'triangle', d: 0.3, vol: 0.12 }));
      [84, 88, 91].forEach((m) => tone(sfxBus, t + 0.7, hz(m), { type: 'sine', d: 1.1, vol: 0.12 }));
    },

    // ⭕ 정답 : 딩동댕~ (밝은 상승 + 화음)
    correct(t) {
      [72, 76, 79].forEach((m, i) => { tone(sfxBus, t + i * 0.11, hz(m), { type: 'triangle', d: 0.4, vol: 0.28 }); tone(sfxBus, t + i * 0.11, hz(m + 12), { type: 'sine', d: 0.3, vol: 0.08 }); });
      [84, 88, 91].forEach((m) => tone(sfxBus, t + 0.36, hz(m), { type: 'triangle', a: 0.01, d: 0.9, vol: 0.13 }));
      noise(sfxBus, t + 0.36, { d: 0.6, vol: 0.05, type: 'bandpass', freq: 8000, q: 3 });
    },

    // ❌ 오답 : 뿌-뿌우 (낮게 떨어지는 부저)
    wrong(t) {
      tone(sfxBus, t, hz(52), { type: 'square', a: 0.01, d: 0.2, vol: 0.2, cutoff: 1400 });
      tone(sfxBus, t, hz(53), { type: 'sawtooth', a: 0.01, d: 0.2, vol: 0.1, cutoff: 1400 });
      tone(sfxBus, t + 0.24, hz(48), { type: 'square', a: 0.01, d: 0.45, vol: 0.2, cutoff: 1200, slideTo: hz(44) });
      tone(sfxBus, t + 0.24, hz(49), { type: 'sawtooth', a: 0.01, d: 0.45, vol: 0.1, cutoff: 1200, slideTo: hz(45) });
    },

    // ⏱ 시계 째깍 (n = 남은 초, 홀/짝으로 째/깍, 마지막 1초는 더 높게)
    tick(t, n = 5) {
      const hi = n % 2 === 1;
      noise(sfxBus, t, { d: 0.025, vol: 0.32, type: 'bandpass', freq: hi ? 3800 : 2600, q: 4 });
      tone(sfxBus, t, n <= 1 ? 2400 : hi ? 1700 : 1300, { type: 'sine', d: 0.05, vol: 0.18 });
    },

    // ⏰ 시간 종료 : 땡~
    timeup(t) {
      tone(sfxBus, t, hz(81), { type: 'sine', d: 1.2, vol: 0.25 });
      tone(sfxBus, t, hz(81) * 2.76, { type: 'sine', d: 0.5, vol: 0.06 });
      tone(sfxBus, t, hz(69), { type: 'triangle', d: 0.9, vol: 0.12 });
    },

    // 🏆 최종 결과 : 팡파레
    final(t) {
      const n = (dt, m, d) => { tone(sfxBus, t + dt, hz(m), { type: 'sawtooth', a: 0.02, d, vol: 0.13, cutoff: 3000 }); tone(sfxBus, t + dt, hz(m + 12), { type: 'triangle', a: 0.02, d, vol: 0.07 }); };
      for (let i = 0; i < 6; i++) snare(sfxBus, t + i * 0.06, 0.08 + i * 0.03);
      n(0.4, 67, 0.12); n(0.55, 67, 0.12); n(0.7, 67, 0.12); n(0.85, 72, 0.5);
      n(1.4, 70, 0.3); n(1.7, 74, 0.3); n(2.0, 72, 0.25);
      [72, 76, 79, 84].forEach((m) => tone(sfxBus, t + 2.3, hz(m), { type: 'sawtooth', a: 0.03, d: 1.4, vol: 0.08, cutoff: 2800 }));
      kick(sfxBus, t + 0.85); kick(sfxBus, t + 2.3);
      noise(sfxBus, t + 2.3, { d: 1.2, vol: 0.08, freq: 6000 });
    },
  };

  /* ---------- 공개 함수 ---------- */
  function play(name, { delay = 0, n } = {}) {
    if (!ctx || ctx.state !== 'running' || muteLevel === 2) return;
    const t = ctx.currentTime + 0.01 + delay;
    if ((name === 'correct' || name === 'wrong' || name === 'final') && bgmBus && muteLevel === 0) {
      // 결과 효과음이 잘 들리도록 배경음악을 잠깐 줄임
      bgmBus.gain.setTargetAtTime(SOUND_CONFIG.BGM_VOLUME * SOUND_CONFIG.DUCK_ON_RESULT, t, 0.05);
      bgmBus.gain.setTargetAtTime(SOUND_CONFIG.BGM_VOLUME, t + (name === 'final' ? 3.5 : 1.2), 0.3);
    }
    if (files[name]) return playFile(name, t);
    if (SYNTH[name]) SYNTH[name](t, n);
  }
  function setMode(m) { mode = m === 'tense' ? 'tense' : 'calm'; }

  // 🔊 소리 버튼 : 모두 켜짐 → 배경음악 끔 → 모두 끔
  const ICONS = ['🔊', '🎵', '🔇'];
  const LABELS = ['소리 모두 켜짐', '배경음악 꺼짐 (효과음만)', '소리 모두 꺼짐'];
  function cycleMute() {
    muteLevel = (muteLevel + 1) % 3;
    localStorage.setItem('yq_sound', muteLevel);
    applyVolumes();
    updateBtn();
    return LABELS[muteLevel];
  }
  function updateBtn() {
    const b = document.getElementById('soundBtn');
    if (!b) return;
    b.textContent = ICONS[muteLevel];
    b.classList.toggle('bgm-off', muteLevel === 1);
    b.classList.toggle('muted', muteLevel === 2);
    b.title = LABELS[muteLevel];
  }
  document.addEventListener('DOMContentLoaded', updateBtn);
  updateBtn();

  window.SFX = { play, setMode, cycleMute, config: SOUND_CONFIG, tickFrom: () => SOUND_CONFIG.TICK_FROM_SEC };
})();
