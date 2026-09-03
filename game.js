/* ============================================================
   キャッフィーの琵琶湖サバイバル ― ゲーム世界と描画
   ------------------------------------------------------------
   このファイルは「湖の風景・障害物・キャラクター」を <canvas> に
   描き、当たり判定とスコアを管理します。
   カメラや姿勢推定、画面遷移は main.js の担当です。

   奥行きの表現には本物の透視投影を使っています。
   障害物や波は (x, z) というワールド座標を持ち、project() で
   画面座標に変換されます。奥から手前へ一定の速度で近づくため、
   見た目の加速感は遠近法から自然に生まれます。
   ============================================================ */

window.Game = (function () {
  'use strict';

  /* ----------------------------------------------------------
     調整用パラメータ
     ---------------------------------------------------------- */
  var CONFIG = {
    /* --- 見え方（すべて画面サイズに対する比率なので解像度に依存しない） --- */
    focalRatio: 0.66,         // 焦点距離 = 画面高さ × この値。大きいほど望遠になる
    horizonRatio: 0.34,       // 水平線の高さ（画面高さに対する比率）
    playerScreenRatio: 0.82,  // キャラクターの足元が来る画面上の位置
    playerZ: 7,               // キャラクターの奥行き（ワールド単位）
    cameraFollow: 0.30,       // カメラがキャラクターを追う割合（0で固定カメラ）

    /* --- 航路 --- */
    laneCount: 5,
    laneHalfWidth: 5.0,       // 航路の半分の幅（ワールド単位）
    spawnZ: 100,              // 障害物が現れる奥行き
    despawnZ: 2.5,            // これより手前に来た障害物は消す

    /* --- キャラクター --- */
    characterImage: 'assets/character.gif',
    characterWorldHeight: 2.0, // キャラクターの高さ（ワールド単位）
    hitHalfWidth: 0.95,        // 当たり判定の半幅（ワールド単位）
    bobAmplitude: 0.07,        // 水面に浮かぶ上下の揺れ（ワールド単位・平行移動のみ）
    bobHz: 0.8,

    /* --- 動き --- */
    moveStiffness: 11.0,      // 追従バネの強さ
    moveDamping: 1.0,         // 減衰比（1.0で臨界減衰＝行き過ぎなし）
    moveMaxSpeed: 60,         // 最大移動速度（ワールド単位/秒）
    physicsStep: 1 / 120,     // 物理演算の固定ステップ

    /* --- 湖の演出 --- */
    waveRows: 30,
    waveSpan: 130,
    buoySpacing: 15,
    buoyCount: 11,

    /* --- アイテム --- */
    itemFirstDelay: 4.0,      // 最初のアイテムが出るまでの秒数
    itemInterval: 6.0,        // アイテムの出現間隔（秒）
    itemJitter: 2.0,          // 出現間隔のばらつき（秒）
    itemHalfWidth: 1.10,      // 取得判定の半幅（ワールド単位）
    heartChance: 0.28,        // ライフ回復アイテムが出る割合

    /* --- スコア --- */
    scorePerSecond: 10,
    scorePerDodge: 25,
    scorePerShell: 120,

    /* --- コンボ --- */
    comboPerStep: 5,          // これだけ続けてよけるごとに倍率が上がる
    comboStepBonus: 0.5,      // 1段階あたりの倍率の増分
    comboMaxMultiplier: 3.0,  // 倍率の上限

    invincibleSeconds: 1.2,
  };

  /* 難易度プリセット */
  var DIFFICULTY = {
    easy:   { label: 'やさしい',   lives: 5, speed: 26, spawnStart: 1.9,  spawnMin: 1.05, ramp: 70, timeLimit: 90, hitScale: 0.85 },
    normal: { label: 'ふつう',     lives: 3, speed: 34, spawnStart: 1.5,  spawnMin: 0.70, ramp: 60, timeLimit: 90, hitScale: 1.00 },
    hard:   { label: 'むずかしい', lives: 2, speed: 46, spawnStart: 1.15, spawnMin: 0.48, ramp: 45, timeLimit: 90, hitScale: 1.10 },
  };

  var OBSTACLE_KINDS = ['net', 'hook', 'wire'];

  /* ----------------------------------------------------------
     内部状態
     ---------------------------------------------------------- */
  var canvas = null, ctx = null;
  var W = 0, H = 0, dpr = 1;
  var cx = 0, horizonY = 0, focal = 0, camH = 0;

  var diffKey = 'normal';
  var D = DIFFICULTY.normal;

  var charX = 0;        // キャラクターのワールドX
  var charTargetX = 0;  // 目標X
  var charVelX = 0;     // 速度（ワールド単位/秒）
  var camX = 0;         // カメラのX

  var obstacles = [];
  var items = [];
  var particles = [];  // 画面座標で動く小さな粒（演出のみ）
  var floaters = [];   // 「+50」のように浮き上がる文字（演出のみ）
  var buoys = [];
  var waveScroll = 0;
  var clock = 0;        // 演出用の累積時間

  var playing = false;
  var elapsed = 0;
  var lives = 3;
  var dodged = 0;
  var score = 0;
  var scoreAcc = 0;    // 小数を保ったスコア（表示は切り捨て）
  var combo = 0;
  var bestCombo = 0;
  var invincible = 0;
  var hitFlash = 0;
  var spawnTimer = 0;
  var itemTimer = 0;

  var listeners = {};

  /* キャラクター画像（読み込めなければ代替図形で継続） */
  var charImg = new Image();
  var charImgReady = false;
  charImg.onload = function () { charImgReady = true; };
  charImg.onerror = function () { charImgReady = false; };
  charImg.src = CONFIG.characterImage;

  /* ----------------------------------------------------------
     小さな道具
     ---------------------------------------------------------- */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function on(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); }
  function emit(name, payload) {
    var arr = listeners[name];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) arr[i](payload);
  }
  /* 画面の基準座標系に戻す（高解像度対応の倍率を含む） */
  function base() { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }

  /* ----------------------------------------------------------
     画面サイズ
     ---------------------------------------------------------- */
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    cx = W / 2;
    horizonY = H * CONFIG.horizonRatio;
    focal = H * CONFIG.focalRatio;
    // キャラクターの足元がちょうど playerScreenRatio の高さに来るカメラ高さ
    camH = (CONFIG.playerScreenRatio - CONFIG.horizonRatio) * CONFIG.playerZ / CONFIG.focalRatio;
    base();
  }

  /* ----------------------------------------------------------
     透視投影
       ワールド座標 (x, z) が画面のどこに来るかを求める。
       s は「そこにある1ワールド単位が何ピクセルになるか」。
     ---------------------------------------------------------- */
  function project(x, z) {
    var s = focal / Math.max(z, 0.4);
    return { x: cx + (x - camX) * s, y: horizonY + camH * s, s: s };
  }

  function laneX(i) {
    var w = (CONFIG.laneHalfWidth * 2) / CONFIG.laneCount;
    return -CONFIG.laneHalfWidth + w * (i + 0.5);
  }

  /* ----------------------------------------------------------
     初期化・リセット
     ---------------------------------------------------------- */
  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    resetBuoys();
    resetRun();
  }

  function resetBuoys() {
    buoys = [];
    for (var i = 0; i < CONFIG.buoyCount; i++) buoys.push(4 + i * CONFIG.buoySpacing);
  }

  function setDifficulty(key) {
    if (!DIFFICULTY[key]) return;
    diffKey = key;
    D = DIFFICULTY[key];
  }

  function resetRun() {
    charX = 0;
    charTargetX = 0;
    charVelX = 0;
    camX = 0;
    obstacles = [];
    items = [];
    particles = [];
    floaters = [];
    elapsed = 0;
    lives = D.lives;
    dodged = 0;
    score = 0;
    scoreAcc = 0;
    combo = 0;
    bestCombo = 0;
    invincible = 0;
    hitFlash = 0;
    spawnTimer = D.spawnStart;
    itemTimer = CONFIG.itemFirstDelay;
    playing = false;
  }

  function start() {
    resetRun();
    playing = true;
  }

  function stop() { playing = false; }

  /* ----------------------------------------------------------
     入力
       nx: -1(左端) 〜 +1(右端)
     ---------------------------------------------------------- */
  function setInput(nx) {
    charTargetX = clamp(nx, -1, 1) * CONFIG.laneHalfWidth;
  }

  /* ----------------------------------------------------------
     更新
     ---------------------------------------------------------- */
  function update(dt) {
    clock += dt;

    var speed = playing ? D.speed : D.speed * 0.35; // 待機中はゆっくり流す
    waveScroll += speed * dt;

    // ブイを流す
    for (var b = 0; b < buoys.length; b++) {
      buoys[b] -= speed * dt;
      if (buoys[b] < CONFIG.despawnZ) buoys[b] += CONFIG.buoyCount * CONFIG.buoySpacing;
    }

    moveCharacter(dt);

    if (!playing) return;

    elapsed += dt;
    if (invincible > 0) invincible = Math.max(0, invincible - dt);
    if (hitFlash > 0) hitFlash = Math.max(0, hitFlash - dt);

    // 障害物の出現
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnObstacle();
      spawnTimer = currentSpawnInterval();
    }

    // アイテムの出現
    itemTimer -= dt;
    if (itemTimer <= 0) {
      spawnItem();
      itemTimer = CONFIG.itemInterval + (Math.random() - 0.5) * 2 * CONFIG.itemJitter;
    }

    // 障害物を手前へ動かし、通過した瞬間に判定する
    var hitHalf = CONFIG.hitHalfWidth * D.hitScale;
    for (var i = 0; i < obstacles.length; i++) {
      var ob = obstacles[i];
      ob.z -= speed * dt;
      if (!ob.resolved && ob.z <= CONFIG.playerZ) {
        ob.resolved = true;
        if (Math.abs(ob.x - charX) < hitHalf) {
          if (invincible <= 0) {
            lives -= 1;
            invincible = CONFIG.invincibleSeconds;
            hitFlash = 0.3;
            combo = 0;                       // コンボは被弾で途切れる
            burst(charX, CONFIG.playerZ, 18, '#ff6b6b');
            emit('hit', { lives: lives, combo: combo });
          }
        } else {
          dodged += 1;
          combo += 1;
          if (combo > bestCombo) bestCombo = combo;
          var gain = Math.round(CONFIG.scorePerDodge * multiplier());
          scoreAcc += gain;
          popText(ob.x, ob.z, '+' + gain, '#eaf6ff');
          burst(ob.x, ob.z, 7, '#9fe8ff');
          emit('dodge', { dodged: dodged, combo: combo, multiplier: multiplier() });
        }
      }
    }
    obstacles = obstacles.filter(function (o) { return o.z > CONFIG.despawnZ; });

    // アイテムを手前へ動かし、通過した瞬間に取得判定する
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      it.z -= speed * dt;
      if (!it.resolved && it.z <= CONFIG.playerZ) {
        it.resolved = true;
        if (Math.abs(it.x - charX) < CONFIG.itemHalfWidth) {
          it.taken = true;
          if (it.kind === 'heart') {
            if (lives < D.lives) lives += 1;
            popText(it.x, it.z, 'LIFE+1', '#ffb3c7');
            burst(it.x, it.z, 16, '#ffb3c7');
            emit('item', { kind: 'heart', lives: lives });
          } else {
            var pts = Math.round(CONFIG.scorePerShell * multiplier());
            scoreAcc += pts;
            popText(it.x, it.z, '+' + pts, '#ffd98a');
            burst(it.x, it.z, 16, '#ffd98a');
            emit('item', { kind: 'shell', points: pts });
          }
        }
      }
    }
    items = items.filter(function (o) { return o.z > CONFIG.despawnZ && !o.taken; });

    scoreAcc += CONFIG.scorePerSecond * dt;
    score = Math.floor(scoreAcc);
    updateEffects(dt);

    if (lives <= 0) {
      playing = false;
      emit('gameover', { reason: 'life' });
    } else if (elapsed >= D.timeLimit) {
      playing = false;
      emit('gameover', { reason: 'time' });
    }
  }

  /* 臨界減衰バネでキャラクターを目標位置へ滑らかに近づける。
     固定ステップで積分するので、低いフレームレートでも振動しない。 */
  function moveCharacter(dt) {
    var k = CONFIG.moveStiffness * CONFIG.moveStiffness;
    var c = 2 * CONFIG.moveDamping * CONFIG.moveStiffness;
    var remain = dt;
    while (remain > 0) {
      var h = Math.min(CONFIG.physicsStep, remain);
      var a = (charTargetX - charX) * k - charVelX * c;
      charVelX = clamp(charVelX + a * h, -CONFIG.moveMaxSpeed, CONFIG.moveMaxSpeed);
      charX += charVelX * h;
      remain -= h;
    }
    charX = clamp(charX, -CONFIG.laneHalfWidth, CONFIG.laneHalfWidth);
    // カメラはキャラクターを控えめに追う（動いている感じが出る）
    camX += (charX * CONFIG.cameraFollow - camX) * (1 - Math.exp(-6 * dt));
  }

  function currentSpawnInterval() {
    var p = Math.min(1, elapsed / D.ramp);
    return D.spawnStart + (D.spawnMin - D.spawnStart) * p;
  }

  function spawnObstacle() {
    var lane = Math.floor(Math.random() * CONFIG.laneCount);
    // たまに隣り合う2レーンをふさぐ（単調さを避ける）
    obstacles.push({
      x: laneX(lane),
      z: CONFIG.spawnZ,
      kind: OBSTACLE_KINDS[Math.floor(Math.random() * OBSTACLE_KINDS.length)],
      seed: Math.random() * Math.PI * 2,
      resolved: false,
    });
    if (elapsed > D.ramp * 0.5 && Math.random() < 0.22) {
      var other = (lane + 1 + Math.floor(Math.random() * (CONFIG.laneCount - 1))) % CONFIG.laneCount;
      obstacles.push({
        x: laneX(other),
        z: CONFIG.spawnZ + 2,
        kind: OBSTACLE_KINDS[Math.floor(Math.random() * OBSTACLE_KINDS.length)],
        seed: Math.random() * Math.PI * 2,
        resolved: false,
      });
    }
  }

  function spawnItem() {
    var lane = Math.floor(Math.random() * CONFIG.laneCount);
    var wantHeart = lives < D.lives && Math.random() < CONFIG.heartChance;
    items.push({
      x: laneX(lane),
      z: CONFIG.spawnZ,
      kind: wantHeart ? 'heart' : 'shell',
      seed: Math.random() * Math.PI * 2,
      resolved: false,
      taken: false,
    });
  }

  /* 現在のスコア倍率（コンボが伸びるほど上がる） */
  function multiplier() {
    var steps = Math.floor(combo / CONFIG.comboPerStep);
    return Math.min(CONFIG.comboMaxMultiplier, 1 + steps * CONFIG.comboStepBonus);
  }

  /* ----------------------------------------------------------
     演出（粒とポップ文字）
       どちらもゲーム進行には影響しない。画面座標で動かす。
     ---------------------------------------------------------- */
  function burst(x, z, count, color) {
    var p = project(x, z - 0.5);
    for (var i = 0; i < count; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = (40 + Math.random() * 150) * Math.min(2, p.s / 40 + 0.6);
      particles.push({
        x: p.x, y: p.y - p.s * 0.9,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        life: 0.45 + Math.random() * 0.35,
        age: 0,
        r: 1.5 + Math.random() * 2.5,
        color: color,
      });
    }
    if (particles.length > 240) particles.splice(0, particles.length - 240);
  }

  function popText(x, z, text, color) {
    var p = project(x, z - 0.5);
    floaters.push({ x: p.x, y: p.y - p.s * 1.4, text: text, color: color, life: 0.9, age: 0 });
    if (floaters.length > 12) floaters.shift();
  }

  function updateEffects(dt) {
    var i;
    for (i = particles.length - 1; i >= 0; i--) {
      var q = particles[i];
      q.age += dt;
      if (q.age >= q.life) { particles.splice(i, 1); continue; }
      q.vy += 420 * dt;          // ゆるい重力
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
    for (i = floaters.length - 1; i >= 0; i--) {
      var f = floaters[i];
      f.age += dt;
      if (f.age >= f.life) { floaters.splice(i, 1); continue; }
      f.y -= 46 * dt;
    }
  }

  /* ==========================================================
     ここから描画
     ========================================================== */

  function drawSky() {
    var g = ctx.createLinearGradient(0, 0, 0, horizonY);
    g.addColorStop(0.00, '#2e86bd');
    g.addColorStop(0.48, '#84c9e9');
    g.addColorStop(0.86, '#cfeaf6');
    g.addColorStop(1.00, '#f0f7fa');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizonY + 1);
  }

  function sunPos() {
    return { x: W * 0.76, y: horizonY * 0.36, r: Math.max(22, Math.min(W, H) * 0.030) };
  }

  function drawSun() {
    var s = sunPos();
    var glow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 6);
    glow.addColorStop(0.00, 'rgba(255,247,216,0.92)');
    glow.addColorStop(0.22, 'rgba(255,236,182,0.42)');
    glow.addColorStop(1.00, 'rgba(255,236,182,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fffaea';
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  }

  function drawClouds() {
    var list = [
      { x: 0.08, y: 0.30, s: 1.00, v: 0.0016 },
      { x: 0.38, y: 0.15, s: 0.70, v: 0.0023 },
      { x: 0.63, y: 0.42, s: 1.14, v: 0.0013 },
      { x: 0.88, y: 0.22, s: 0.62, v: 0.0028 },
    ];
    ctx.save();
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var px = (((c.x + clock * c.v) % 1.3) - 0.15) * W;
      var py = horizonY * c.y;
      var r = Math.max(13, W * 0.030) * c.s;
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.beginPath();
      ctx.arc(px - r * 0.95, py + r * 0.20, r * 0.60, 0, Math.PI * 2);
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.arc(px + r * 1.00, py + r * 0.24, r * 0.68, 0, Math.PI * 2);
      ctx.arc(px + r * 0.34, py + r * 0.42, r * 0.74, 0, Math.PI * 2);
      ctx.fill();
      // 雲の下側をほんのり影に
      ctx.fillStyle = 'rgba(186,214,232,0.55)';
      ctx.beginPath();
      ctx.ellipse(px + r * 0.1, py + r * 0.52, r * 1.25, r * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* 遠景の山並み（比良山地・比叡山をイメージしたシルエット） */
  function drawRidge(height, color, seed, offset) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, horizonY + 2);
    for (var x = 0; x <= W; x += 6) {
      var t = (x + offset) * 0.001;
      var n = Math.sin(t * 3.2 + seed) * 0.50 +
              Math.sin(t * 7.1 + seed * 2.1) * 0.30 +
              Math.sin(t * 15.1 + seed * 3.3) * 0.20;
      ctx.lineTo(x, horizonY + 2 - height * (0.52 + 0.48 * n));
    }
    ctx.lineTo(W, horizonY + 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* 沖島をイメージした島影 */
  function drawIsland(px, w, h, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(px - w / 2, horizonY + 1);
    ctx.quadraticCurveTo(px - w * 0.16, horizonY + 1 - h, px, horizonY + 1 - h * 0.88);
    ctx.quadraticCurveTo(px + w * 0.20, horizonY + 1 - h * 1.06, px + w / 2, horizonY + 1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawLake() {
    var g = ctx.createLinearGradient(0, horizonY, 0, H);
    g.addColorStop(0.00, '#6ec9e0');
    g.addColorStop(0.10, '#3ba3cb');
    g.addColorStop(0.38, '#176a97');
    g.addColorStop(1.00, '#04202f');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizonY, W, H - horizonY);
  }

  /* 太陽の光が湖面に伸びる道 */
  function drawSunGlitter() {
    var s = sunPos();
    ctx.save();
    var g = ctx.createLinearGradient(0, horizonY, 0, H);
    g.addColorStop(0.00, 'rgba(255,244,204,0.36)');
    g.addColorStop(0.55, 'rgba(255,238,180,0.10)');
    g.addColorStop(1.00, 'rgba(255,238,180,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(s.x - W * 0.018, horizonY);
    ctx.lineTo(s.x + W * 0.018, horizonY);
    ctx.lineTo(s.x + W * 0.20, H);
    ctx.lineTo(s.x - W * 0.20, H);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* 波。ワールドの奥行き z を持たせ、奥から手前へ流す。
     遠近法で自然に間隔が広がり、振幅も大きくなる。 */
  function drawWaves() {
    var span = CONFIG.waveSpan, count = CONFIG.waveRows;
    var rows = [];
    for (var i = 0; i < count; i++) {
      var raw = (i * (span / count) + waveScroll) % span;
      rows.push(((raw + span) % span) + 2.5);
    }
    rows.sort(function (a, b) { return b - a; }); // 奥から手前の順に描く

    ctx.save();
    ctx.lineCap = 'round';
    for (var r = 0; r < rows.length; r++) {
      var z = rows[r];
      var p = project(0, z);
      if (p.y > H + 80 || p.y < horizonY) continue;
      var alpha = Math.min(0.34, 0.02 + p.s / focal * 2.6);
      var amp = Math.min(18, 0.09 * p.s);
      ctx.strokeStyle = 'rgba(214,244,255,' + alpha.toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, Math.min(3.4, 0.012 * p.s));
      ctx.beginPath();
      for (var x = -40; x <= W + 40; x += 22) {
        var wob = Math.sin(x * 0.010 + z * 0.6 + clock * 1.6) * amp;
        if (x === -40) ctx.moveTo(x, p.y + wob); else ctx.lineTo(x, p.y + wob);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* 航路の左右の縁（ワールドの直線は画面上でも直線になる） */
  function drawChannel() {
    var farZ = CONFIG.spawnZ * 0.75, nearZ = CONFIG.despawnZ;
    ctx.save();
    for (var side = -1; side <= 1; side += 2) {
      var a = project(side * CONFIG.laneHalfWidth, farZ);
      var b = project(side * CONFIG.laneHalfWidth, nearZ);
      var g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0.00, 'rgba(234,248,255,0)');
      g.addColorStop(0.45, 'rgba(234,248,255,0.14)');
      g.addColorStop(1.00, 'rgba(234,248,255,0.40)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  /* レーンの目安線（プレイ中だけ薄く表示） */
  function drawLaneGuides() {
    var farZ = CONFIG.spawnZ * 0.55, nearZ = CONFIG.despawnZ;
    var w = (CONFIG.laneHalfWidth * 2) / CONFIG.laneCount;
    ctx.save();
    for (var i = 1; i < CONFIG.laneCount; i++) {
      var x = -CONFIG.laneHalfWidth + w * i;
      var a = project(x, farZ), b = project(x, nearZ);
      var g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0.00, 'rgba(255,255,255,0)');
      g.addColorStop(1.00, 'rgba(255,255,255,0.16)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  /* 航路の縁に浮かぶブイ。速度感を出す目印になる */
  function drawBuoys() {
    ctx.save();
    for (var i = 0; i < buoys.length; i++) {
      var z = buoys[i];
      for (var side = -1; side <= 1; side += 2) {
        var p = project(side * CONFIG.laneHalfWidth, z);
        if (p.y < horizonY || p.y > H + 40) continue;
        var r = clamp(0.16 * p.s, 1.2, 16);
        var bob = Math.sin(clock * 1.8 + z * 0.4) * r * 0.35;
        ctx.globalAlpha = clamp(z / 10, 0, 1) * Math.min(1, 40 / z);
        // 本体
        ctx.fillStyle = '#ff8a4c';
        ctx.beginPath(); ctx.arc(p.x, p.y - r * 0.7 + bob, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath(); ctx.arc(p.x - r * 0.3, p.y - r * 1.0 + bob, r * 0.32, 0, Math.PI * 2); ctx.fill();
        // 水面の映り込み
        ctx.fillStyle = 'rgba(255,138,76,0.35)';
        ctx.beginPath(); ctx.ellipse(p.x, p.y + r * 0.35, r * 1.1, r * 0.32, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* ----------------------------------------------------------
     障害物
       図形は「1ワールド単位 = 1」の座標で描き、
       ctx.scale(s, s) で遠近に合わせて拡大する。
     ---------------------------------------------------------- */
  function drawObstacles() {
    var sorted = obstacles.slice().sort(function (a, b) { return b.z - a.z; });
    for (var i = 0; i < sorted.length; i++) {
      var ob = sorted[i];
      var p = project(ob.x, ob.z);
      if (p.y < horizonY - 20 || p.y > H + 200) continue;

      var alpha = clamp((CONFIG.spawnZ - ob.z) / 30, 0, 1);
      var sway = Math.sin(clock * 2.0 + ob.seed) * 0.06;

      ctx.save();
      ctx.globalAlpha = alpha;
      // 水面より少し上に浮かせる
      ctx.translate(p.x + sway * p.s, p.y - 0.95 * p.s);
      ctx.scale(p.s, p.s);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (ob.kind === 'net') drawNet();
      else if (ob.kind === 'hook') drawHook();
      else drawWire();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /* ----------------------------------------------------------
     アイテム（シジミ＝得点、ハート＝ライフ回復）
     ---------------------------------------------------------- */
  function drawItems() {
    var sorted = items.slice().sort(function (a, b) { return b.z - a.z; });
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      var p = project(it.x, it.z);
      if (p.y < horizonY - 20 || p.y > H + 200) continue;

      var alpha = clamp((CONFIG.spawnZ - it.z) / 30, 0, 1);
      var bob = Math.sin(clock * 2.4 + it.seed) * 0.12;
      var glow = 0.55 + 0.45 * Math.sin(clock * 5 + it.seed);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y - (1.0 + bob) * p.s);
      ctx.scale(p.s, p.s);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // 後光
      var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.85);
      var tint = it.kind === 'heart' ? '255,140,180' : '255,214,120';
      g.addColorStop(0, 'rgba(' + tint + ',' + (0.45 * glow).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + tint + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, 0.85, 0, Math.PI * 2); ctx.fill();

      if (it.kind === 'heart') drawHeartIcon();
      else drawShellIcon();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawShellIcon() {
    ctx.fillStyle = '#ffd98a';
    ctx.strokeStyle = 'rgba(120,74,20,0.75)';
    ctx.lineWidth = 0.045;
    ctx.beginPath();
    ctx.moveTo(-0.42, 0.10);
    ctx.quadraticCurveTo(-0.34, -0.44, 0, -0.44);
    ctx.quadraticCurveTo(0.34, -0.44, 0.42, 0.10);
    ctx.quadraticCurveTo(0, 0.34, -0.42, 0.10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 0.028;
    for (var i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 0.11, -0.36);
      ctx.lineTo(i * 0.19, 0.16);
      ctx.stroke();
    }
  }

  function drawHeartIcon() {
    ctx.fillStyle = '#ff7fa6';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 0.045;
    ctx.beginPath();
    ctx.moveTo(0, 0.36);
    ctx.bezierCurveTo(-0.62, -0.10, -0.34, -0.56, 0, -0.24);
    ctx.bezierCurveTo(0.34, -0.56, 0.62, -0.10, 0, 0.36);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  /* 粒とポップ文字（画面座標のまま描く） */
  function drawEffects() {
    var i;
    base();
    for (i = 0; i < particles.length; i++) {
      var q = particles[i];
      var t = 1 - q.age / q.life;
      ctx.globalAlpha = Math.max(0, t);
      ctx.fillStyle = q.color;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.r * (0.4 + t * 0.9), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < floaters.length; i++) {
      var f = floaters[i];
      var k = 1 - f.age / f.life;
      ctx.globalAlpha = Math.max(0, Math.min(1, k * 1.6));
      ctx.font = '700 ' + Math.round(Math.max(16, H * 0.032)) + 'px system-ui, sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(3,20,34,0.7)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawNet() {
    var s = 0.95; // 半径（ワールド単位）
    ctx.strokeStyle = 'rgba(238,247,252,0.95)';
    ctx.lineWidth = 0.055;
    ctx.strokeRect(-s, -s, s * 2, s * 2);
    ctx.lineWidth = 0.035;
    ctx.strokeStyle = 'rgba(214,236,247,0.8)';
    var n = 4;
    for (var i = 1; i < n; i++) {
      var d = -s + (s * 2 / n) * i;
      ctx.beginPath(); ctx.moveTo(d, -s); ctx.lineTo(d, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s, d); ctx.lineTo(s, d); ctx.stroke();
    }
    // 浮き
    ctx.fillStyle = '#ffd07a';
    for (var k = -1; k <= 1; k++) {
      ctx.beginPath(); ctx.arc(k * s * 0.7, -s, 0.075, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawHook() {
    ctx.strokeStyle = 'rgba(244,250,255,0.95)';
    ctx.lineWidth = 0.075;
    ctx.beginPath();
    ctx.moveTo(0, -1.15);
    ctx.lineTo(0, 0.15);
    ctx.arc(-0.19, 0.15, 0.42, 0, Math.PI * 1.35, false);
    ctx.stroke();
    // 針先
    ctx.beginPath();
    ctx.moveTo(-0.30, -0.14);
    ctx.lineTo(-0.13, -0.36);
    ctx.stroke();
    // 糸
    ctx.strokeStyle = 'rgba(220,240,252,0.5)';
    ctx.lineWidth = 0.022;
    ctx.beginPath(); ctx.moveTo(0, -1.15); ctx.lineTo(0, -2.4); ctx.stroke();
    // 疑似餌
    ctx.fillStyle = '#ff8a4c';
    ctx.beginPath(); ctx.arc(0, -0.32, 0.10, 0, Math.PI * 2); ctx.fill();
  }

  function drawWire() {
    ctx.strokeStyle = 'rgba(232,244,252,0.92)';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.moveTo(-0.95, -1.0); ctx.lineTo(-0.95, 1.0);
    ctx.moveTo(0.95, -1.0);  ctx.lineTo(0.95, 1.0);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(214,236,247,0.7)';
    ctx.lineWidth = 0.028;
    for (var i = -2; i <= 2; i++) {
      var y = i * 0.36;
      ctx.beginPath();
      ctx.moveTo(-0.95, y);
      ctx.quadraticCurveTo(0, y + 0.10, 0.95, y);
      ctx.stroke();
    }
  }

  /* ----------------------------------------------------------
     キャラクター描画
     許可される変換：平行移動(translate) / 縦横比を保った拡大縮小(scale(s,s)) / 表示非表示(フェード)
     禁止：回転・傾き・左右反転・非均等スケール・色変更・部分切り出し・パーツ分割・重ね描画
     ---------------------------------------------------------- */
  function drawCharacter() {
    // カメラ映像などの変換が絶対に影響しないよう、描画直前に基準座標系へ戻す
    base();

    var p = project(charX, CONFIG.playerZ);
    var bob = Math.sin(clock * Math.PI * 2 * CONFIG.bobHz) * CONFIG.bobAmplitude * p.s;
    var px = p.x;
    var py = p.y + bob;

    // 被弾直後は点滅（フェードのみ。色も形も変えない）
    var alpha = 1;
    if (invincible > 0) alpha = (Math.floor(invincible * 12) % 2 === 0) ? 0.35 : 1;

    if (charImgReady && charImg.naturalHeight) {
      var iw = charImg.naturalWidth, ih = charImg.naturalHeight;
      var k = (CONFIG.characterWorldHeight * p.s) / ih; // 縦横比を保った単一スケール値
      ctx.save();
      ctx.globalAlpha = alpha;
      // translate → 均一 scale(k, k) の順のみを使用
      ctx.translate(px - (iw * k) / 2, py - ih * k);
      ctx.scale(k, k);
      ctx.drawImage(charImg, 0, 0, iw, ih);
      ctx.restore();
    } else {
      drawCharacterFallback(px, py, CONFIG.characterWorldHeight * p.s, alpha);
    }
  }

  /* 画像が読み込めない場合の代替図形（ナマズ風のシルエット）
     ※ translate と 均一scale のみで配置し、回転や反転は一切行わない */
  function drawCharacterFallback(x, y, h, alpha) {
    var k = h / 200;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.fillStyle = '#2f7fb0';
    ctx.strokeStyle = '#123a52';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, -180);
    ctx.quadraticCurveTo(70, -140, 70, -60);
    ctx.quadraticCurveTo(70, 20, 0, 20);
    ctx.quadraticCurveTo(-70, 20, -70, -60);
    ctx.quadraticCurveTo(-70, -140, 0, -180);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#0d2636';
    ctx.beginPath();
    ctx.arc(-24, -120, 9, 0, Math.PI * 2);
    ctx.arc(24, -120, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* 被弾の演出は画面のふちだけを赤くする。
     キャラクター本体やその周囲の余白には一切重ねない。 */
  function drawHitVignette() {
    if (hitFlash <= 0) return;
    var a = (hitFlash / 0.3) * 0.55;
    var inner = Math.max(Math.min(W, H) * 0.52, CONFIG.characterWorldHeight * (focal / CONFIG.playerZ) * 1.5);
    ctx.save();
    ctx.globalAlpha = a;
    var g = ctx.createRadialGradient(W / 2, H / 2, inner, W / 2, H / 2, Math.max(W, H) * 0.78);
    g.addColorStop(0, 'rgba(255,40,40,0)');
    g.addColorStop(1, 'rgba(255,30,30,0.92)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /* ----------------------------------------------------------
     1フレーム分の描画
     ---------------------------------------------------------- */
  function render(opts) {
    opts = opts || {};
    base();
    ctx.clearRect(0, 0, W, H);

    drawSky();
    drawSun();
    drawClouds();
    drawRidge(horizonY * 0.50, '#a6c8d8', 1.7, 0);
    drawRidge(horizonY * 0.34, '#6b96b0', 4.2, 120);
    drawRidge(horizonY * 0.20, '#456f8c', 9.1, 260);
    drawIsland(W * 0.23, Math.max(70, W * 0.10), Math.max(10, horizonY * 0.10), '#3c6884');
    drawIsland(W * 0.60, Math.max(40, W * 0.05), Math.max(6, horizonY * 0.055), '#40708c');

    drawLake();
    drawSunGlitter();
    drawWaves();
    drawChannel();
    if (opts.showLanes) drawLaneGuides();
    drawBuoys();

    if (opts.showObstacles !== false) { drawObstacles(); drawItems(); }

    // 手前を少し暗くしてキャラクターを引き立てる
    var g = ctx.createLinearGradient(0, H * 0.66, 0, H);
    g.addColorStop(0, 'rgba(3,20,34,0)');
    g.addColorStop(1, 'rgba(3,20,34,0.40)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.66, W, H * 0.34);

    if (opts.showCharacter !== false) drawCharacter();

    base();
    drawEffects();
    drawHitVignette();
  }

  /* ----------------------------------------------------------
     外から使うもの
     ---------------------------------------------------------- */
  function getStats() {
    return {
      score: score,
      lives: lives,
      maxLives: D.lives,
      dodged: dodged,
      combo: combo,
      bestCombo: bestCombo,
      multiplier: multiplier(),
      elapsed: elapsed,
      remain: Math.max(0, Math.ceil(D.timeLimit - elapsed)),
      timeLimit: D.timeLimit,
      difficulty: diffKey,
      difficultyLabel: D.label,
      playing: playing,
    };
  }

  return {
    CONFIG: CONFIG,
    DIFFICULTY: DIFFICULTY,
    init: init,
    resize: resize,
    setDifficulty: setDifficulty,
    resetRun: resetRun,
    start: start,
    stop: stop,
    setInput: setInput,
    update: update,
    render: render,
    getStats: getStats,
    on: on,
  };
})();
