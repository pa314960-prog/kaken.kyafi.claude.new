/* ============================================================
   キャッフィーの琵琶湖サバイバル ― 効果音
   ------------------------------------------------------------
   環境音は穏やかな湖のWAVを繰り返し再生し、効果音はWeb Audio APIで合成します。

   ブラウザの制限で、AudioContext は「ユーザーが何かを操作した後」
   でないと音を出せません。そのため unlock() を最初のクリックや
   キー操作のときに呼びます。
   ============================================================ */

window.Sound = (function () {
  'use strict';

  var ctx = null;
  var master = null;
  var ambientGain = null;
  var ambientSource = null;
  var ready = false;

  /* ----------------------------------------------------------
     初期化（最初のユーザー操作のときに呼ぶ）
     ---------------------------------------------------------- */
  function unlock() {
    if (ready) {
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      buildAmbient();
      ready = true;
    } catch (e) {
      ctx = null;
    }
  }

  /* ----------------------------------------------------------
     環境音（湖のさざ波）
       試聴音①を使用。つなぎ目をクロスフェードして連続再生します。
     ---------------------------------------------------------- */
  function buildAmbient() {
    ambientGain = ctx.createGain();
    ambientGain.gain.value = 0;
    ambientGain.connect(master);
    var audioBytes = window.OFFLINE_CALM_LAKE
      ? Promise.resolve(Uint8Array.from(atob(window.OFFLINE_CALM_LAKE), function (c) { return c.charCodeAt(0); }).buffer)
      : fetch('assets/audio/calm-lake.wav').then(function (response) {
          if (!response.ok) throw new Error('Wave audio: ' + response.status);
          return response.arrayBuffer();
        });
    audioBytes
      .then(function (bytes) { return ctx.decodeAudioData(bytes); })
      .then(function (decoded) {
        // Remove the audition fade and crossfade the seam for a continuous loop.
        var trim = Math.round(decoded.sampleRate * 0.75);
        var overlap = Math.round(decoded.sampleRate * 0.5);
        var size = decoded.length - trim * 2;
        var length = size - overlap;
        var buffer = ctx.createBuffer(decoded.numberOfChannels, length, decoded.sampleRate);
        for (var channel = 0; channel < decoded.numberOfChannels; channel++) {
          var source = decoded.getChannelData(channel).subarray(trim, decoded.length - trim);
          var target = buffer.getChannelData(channel);
          target.set(source.subarray(overlap, size - overlap));
          for (var i = 0; i < overlap; i++) {
            var mix = i / (overlap - 1);
            target[length - overlap + i] = source[size - overlap + i] * (1 - mix) + source[i] * mix;
          }
        }
        ambientSource = ctx.createBufferSource();
        ambientSource.buffer = buffer;
        ambientSource.loop = true;
        // Match the audition's loudness while preserving game/result volume changes.
        var waveLevel = ctx.createGain();
        waveLevel.gain.value = 4;
        ambientSource.connect(waveLevel);
        waveLevel.connect(ambientGain);
        ambientSource.start();
        document.body.dataset.waveAudio = 'ready';
      })
      .catch(function (error) {
        document.body.dataset.waveAudio = 'error';
        console.error(error);
      });
  }

  function setAmbient(level, seconds) {
    if (!ready || !ambientGain) return;
    var t = ctx.currentTime;
    ambientGain.gain.cancelScheduledValues(t);
    ambientGain.gain.setValueAtTime(ambientGain.gain.value, t);
    ambientGain.gain.linearRampToValueAtTime(level, t + (seconds || 0.8));
  }

  /* ----------------------------------------------------------
     音を作る道具
     ---------------------------------------------------------- */
  function tone(opts) {
    if (!ready) return;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.toFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.toFreq), t0 + opts.dur);

    var peak = opts.gain === undefined ? 0.25 : opts.gain;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.03, opts.dur * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);

    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.05);
  }

  function noiseBurst(opts) {
    if (!ready) return;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var dur = opts.dur || 0.3;
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;

    var filt = ctx.createBiquadFilter();
    filt.type = opts.filterType || 'lowpass';
    filt.frequency.setValueAtTime(opts.freq || 900, t0);
    if (opts.toFreq) filt.frequency.exponentialRampToValueAtTime(Math.max(40, opts.toFreq), t0 + dur);

    var gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain === undefined ? 0.3 : opts.gain, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filt);
    filt.connect(gain);
    gain.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /* ----------------------------------------------------------
     ゲームで使う音
     ---------------------------------------------------------- */
  var api = {
    unlock: unlock,

    /* ボタンのクリック */
    click: function () {
      tone({ type: 'triangle', freq: 620, toFreq: 880, dur: 0.09, gain: 0.14 });
    },

    /* キャリブレーション完了 */
    ready: function () {
      tone({ type: 'sine', freq: 660, dur: 0.16, gain: 0.2 });
      tone({ type: 'sine', freq: 990, dur: 0.22, gain: 0.16, delay: 0.12 });
    },

    /* カウントダウンの「3・2・1」 */
    beep: function () {
      tone({ type: 'square', freq: 520, dur: 0.14, gain: 0.13 });
    },

    /* 「GO!」 */
    go: function () {
      tone({ type: 'square', freq: 780, dur: 0.10, gain: 0.16 });
      tone({ type: 'square', freq: 1170, dur: 0.28, gain: 0.16, delay: 0.09 });
      setAmbient(0.16, 1.2);
    },

    /* 残り10秒から秒ごとに通知。最後の3秒は高い二連音にする。 */
    timeWarning: function (seconds) {
      if (seconds === 10) {
        tone({ type: 'triangle', freq: 660, dur: 0.12, gain: 0.15 });
        tone({ type: 'triangle', freq: 880, dur: 0.16, gain: 0.15, delay: 0.14 });
      } else if (seconds <= 3) {
        tone({ type: 'triangle', freq: 990, dur: 0.09, gain: 0.16 });
        tone({ type: 'triangle', freq: 990, dur: 0.09, gain: 0.16, delay: 0.13 });
      } else {
        tone({ type: 'triangle', freq: 660, dur: 0.10, gain: 0.13 });
      }
    },

    /* アイテム（エビ）を取った */
    pickup: function () {
      tone({ type: 'triangle', freq: 880, dur: 0.08, gain: 0.13 });
      tone({ type: 'triangle', freq: 1320, dur: 0.10, gain: 0.12, delay: 0.07 });
      tone({ type: 'triangle', freq: 1760, dur: 0.16, gain: 0.10, delay: 0.14 });
    },

    /* ライフが回復した */
    heal: function () {
      tone({ type: 'sine', freq: 520, toFreq: 780, dur: 0.20, gain: 0.16 });
      tone({ type: 'sine', freq: 1040, dur: 0.30, gain: 0.12, delay: 0.10 });
    },

    /* 障害物をよけた */
    dodge: function () {
      tone({ type: 'sine', freq: 1250, toFreq: 1750, dur: 0.10, gain: 0.075 });
      noiseBurst({ dur: 0.16, freq: 2400, toFreq: 700, gain: 0.05, filterType: 'bandpass' });
    },

    /* 被弾（水しぶき＋低い衝撃音） */
    hit: function () {
      noiseBurst({ dur: 0.42, freq: 1600, toFreq: 160, gain: 0.36 });
      tone({ type: 'sawtooth', freq: 190, toFreq: 60, dur: 0.34, gain: 0.24 });
    },

    /* 時間切れで生き残った */
    clear: function () {
      var notes = [523, 659, 784, 1047];
      for (var i = 0; i < notes.length; i++) {
        tone({ type: 'triangle', freq: notes[i], dur: 0.34, gain: 0.18, delay: i * 0.13 });
      }
      setAmbient(0.05, 1.5);
    },

    /* ライフ切れ */
    gameover: function () {
      var notes = [523, 415, 330, 247];
      for (var i = 0; i < notes.length; i++) {
        tone({ type: 'triangle', freq: notes[i], dur: 0.4, gain: 0.18, delay: i * 0.15 });
      }
      setAmbient(0.05, 1.5);
    },

    /* 自己最高記録の更新 */
    record: function () {
      var notes = [784, 988, 1319];
      for (var i = 0; i < notes.length; i++) {
        tone({ type: 'sine', freq: notes[i], dur: 0.5, gain: 0.16, delay: 0.5 + i * 0.11 });
      }
    },

    /* 環境音の大きさ（0で無音） */
    ambient: setAmbient,
  };

  return api;
})();
