/* Desktop: start a text selection from a rough drag anywhere near the
   info lines (gaps, beside centred text, on the address or phone), and
   do not open those links when you release after a drag. A plain click
   still opens the link. Touch / coarse pointers are left alone. */
(function () {
  function isDesktop() {
    if (!window.matchMedia) return false;
    if (window.matchMedia("(pointer: coarse)").matches) return false;
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) return true;
    return window.matchMedia("(min-width: 961px)").matches && !(navigator.maxTouchPoints > 0);
  }
  function inInfo(el) {
    return el && el.closest ? el.closest(".s-info") : null;
  }
  function infoLink(el) {
    return el && el.closest ? el.closest(".s-info a.s-link, .s-info .s-btns a.btn") : null;
  }
  function rangeFromPoint(x, y) {
    var r, p;
    if (document.caretRangeFromPoint) {
      r = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      p = document.caretPositionFromPoint(x, y);
      if (!p || !p.offsetNode) return null;
      r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
    }
    if (!r || !r.startContainer) return null;
    if (!inInfo(r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement)) return null;
    return { node: r.startContainer, offset: r.startOffset };
  }
  function applySel(from, to) {
    if (!from || !to) return;
    var sel = window.getSelection();
    var range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      if (range.collapsed) {
        range.setStart(to.node, to.offset);
        range.setEnd(from.node, from.offset);
      }
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) {}
  }

  var startX = 0, startY = 0, startPos = null, tracking = false, moved = false;

  document.addEventListener("mousedown", function (e) {
    if (!isDesktop() || e.button !== 0) { tracking = false; return; }
    if (!inInfo(e.target)) { tracking = false; return; }
    startX = e.clientX;
    startY = e.clientY;
    startPos = rangeFromPoint(e.clientX, e.clientY);
    moved = false;
    tracking = !!startPos;
    /* Stop the browser starting a link drag or its own selection on the
       address/phone, which collapses the range when you release. */
    if (tracking && infoLink(e.target)) e.preventDefault();
  }, true);

  document.addEventListener("mousemove", function (e) {
    if (!tracking || !startPos) return;
    if (Math.abs(e.clientX - startX) <= 4 && Math.abs(e.clientY - startY) <= 4) return;
    moved = true;
    e.preventDefault();
    applySel(startPos, rangeFromPoint(e.clientX, e.clientY));
  }, true);

  function refreshSel(e) {
    if (!tracking || !moved || !startPos) return;
    applySel(startPos, rangeFromPoint(e.clientX, e.clientY));
  }
  document.addEventListener("mouseup", function (e) {
    if (!tracking || !moved) return;
    e.preventDefault();
    refreshSel(e);
    requestAnimationFrame(function () { refreshSel(e); });
  }, true);

  document.addEventListener("click", function (e) {
    if (!isDesktop()) return;
    if (!infoLink(e.target)) { tracking = false; moved = false; startPos = null; return; }
    var sel = window.getSelection && window.getSelection().toString();
    if (moved || (sel && sel.replace(/\s/g, "").length)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
    tracking = false;
    moved = false;
    startPos = null;
  }, true);
})();
