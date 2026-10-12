/* 指定されたキャラクターの範囲と、描画した障害物・アイテムの不透明部分を比較。 */
window.OutlineCollision = (function () {
  'use strict';
  var a = document.createElement('canvas');
  var b = document.createElement('canvas');
  var ac = a.getContext('2d', { willReadFrequently: true });
  var bc = b.getContext('2d', { willReadFrequently: true });
  var characterMasks = new WeakMap();

  // 画像の色に関係なく、指定された赤線の内側全体を判定にする。
  function markedRegion(img) {
    if (characterMasks.has(img)) return characterMasks.get(img);
    var mask = document.createElement('canvas');
    mask.width = img.naturalWidth;
    mask.height = img.naturalHeight;
    var context = mask.getContext('2d');
    context.fillStyle = '#fff';
    context.beginPath();
    window.CharacterHitRegion.forEach(function (point, index) {
      if (index === 0) context.moveTo(point[0] * mask.width, point[1] * mask.height);
      else context.lineTo(point[0] * mask.width, point[1] * mask.height);
    });
    context.closePath();
    context.fill();
    characterMasks.set(img, mask);
    return mask;
  }

  function overlaps(first, second, scale) {
    if (!first || !second) return null;
    scale = scale || 1;
    var left = Math.floor(Math.max(first.x, second.x) * scale);
    var top = Math.floor(Math.max(first.y, second.y) * scale);
    var right = Math.ceil(Math.min(first.x + first.w, second.x + second.w) * scale);
    var bottom = Math.ceil(Math.min(first.y + first.h, second.y + second.h) * scale);
    if (right <= left || bottom <= top) return false;
    var w = right - left, h = bottom - top;
    [a, b].forEach(function (canvas) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    });
    function paint(context, sprite) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, w, h);
      context.setTransform(scale, 0, 0, scale, -left, -top);
      context.drawImage(sprite.img, sprite.x, sprite.y, sprite.w, sprite.h);
      return context.getImageData(0, 0, w, h).data;
    }
    var ap = paint(ac, first), bp = paint(bc, second);
    for (var i = 3; i < ap.length; i += 4) {
      if (ap[i] > 0 && bp[i] > 0) return true;
    }
    return false;
  }
  return { overlaps: overlaps, markedRegion: markedRegion };
})();
