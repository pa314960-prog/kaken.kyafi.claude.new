/* 失ったライフをHUDの位置から割って消す。ゲームのライフ値は変更しない。 */
window.HitHeart = (function () {
  function clear() {
    document.querySelectorAll('.heart-break').forEach(function (effect) { effect.remove(); });
  }
  function play(pip) {
    if (!pip) return;
    var rect = pip.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var effect = document.createElement('span');
    effect.className = 'heart-break';
    effect.setAttribute('aria-hidden', 'true');
    effect.style.left = rect.left + 'px';
    effect.style.top = rect.top + 'px';
    effect.style.width = rect.width + 'px';
    effect.style.height = rect.height + 'px';
    ['left', 'right'].forEach(function (side) {
      var half = document.createElement('span');
      half.className = 'heart-break-half heart-break-' + side;
      var heart = document.createElement('span');
      heart.className = 'pip';
      half.appendChild(heart);effect.appendChild(half);
    });
    document.body.appendChild(effect);
    effect.addEventListener('animationend', function (event) {
      if (event.target === effect) effect.remove();
    });
    setTimeout(function () { effect.remove(); }, 900);
  }
  return { play: play, clear: clear };
})();
