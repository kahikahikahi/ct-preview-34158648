/* Café Turquoise shop tablet: orders, booking requests and sold-out switches.
   Plain JavaScript. Talks to Supabase with the publishable key; what staff can see and change
   is enforced in the database (RLS: logged-in user with app_metadata role "staff"). */
(function () {
  "use strict";

  var SUPABASE_URL = "https://nljzrxvfccxdcltbpava.supabase.co";
  var SUPABASE_KEY = "sb_publishable_aXCPQakkbNccpChsgDGfWw_4XqKNZ2H";
  var TZ = "Pacific/Auckland";
  var POLL_MS = 30000;
  var PREP_MINUTES = 20;
  var QUICK_MINUTES = [10, 15, 20, 30, 45];

  var AUTH_STORAGE_KEY = "ct-orders-auth";
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: window.localStorage,
      storageKey: AUTH_STORAGE_KEY
    }
  });

  var state = {
    session: null,
    started: false,
    tab: "current",
    expanded: {},
    detail: null,
    settingsView: "main",
    accepting: true,
    orders: [],
    bookings: [],
    dueCollected: [],
    dueHasMore: false,
    dueLoading: false,
    detailFrom: null,
    menu: [],
    groups: {},        // option group key -> name
    itemGroups: {},    // menu item id -> [group keys] (display order)
    loadedOnce: false,
    channel: null,
    live: false,
    lastOk: 0,
    seenBookings: loadSeen(),
    editing: null
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(c) { return "$" + (Number(c || 0) / 100).toFixed(2); }
  var timeFmt = new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
  function fmtTime(d) {
    if (!d) return "";
    return timeFmt.format(d instanceof Date ? d : new Date(d)).replace(/\s?([ap])\.?m\.?/i, " $1m").toLowerCase();
  }
  function nzParts(d) {
    var p = {};
    new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "longOffset" })
      .formatToParts(d || new Date()).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }
  function todayNZ() { var p = nzParts(); return p.year + "-" + p.month + "-" + p.day; }
  function startOfTodayISO() {
    var p = nzParts();
    var off = (p.timeZoneName || "GMT+13:00").replace("GMT", "") || "+00:00";
    if (!/^[+-]\d{2}:\d{2}$/.test(off)) off = "+13:00";
    return new Date(p.year + "-" + p.month + "-" + p.day + "T00:00:00" + off).toISOString();
  }
  function minsFromNow(d) { return Math.round((new Date(d).getTime() - Date.now()) / 60000); }
  function ago(d) {
    var m = -minsFromNow(d);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.floor(m / 60);
    return h + " h " + (m % 60) + " min ago";
  }
  function bookingTime(t) {
    var a = String(t || "").split(":"), h = parseInt(a[0], 10), m = a[1] || "00";
    if (isNaN(h)) return "";
    return (h % 12 || 12) + ":" + m + (h < 12 ? " am" : " pm");
  }
  function bookingDate(s) {
    if (s === todayNZ()) return "Today";
    var t = new Date(todayNZ() + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1);
    if (s === t.toISOString().slice(0, 10)) return "Tomorrow";
    return new Date(s + "T00:00:00Z").toLocaleDateString("en-NZ", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  }
  function nzOffsetFor(dateStr) {
    var probe = new Date((dateStr || todayNZ()) + "T12:00:00Z"), p = {};
    new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(probe).forEach(function (x) { p[x.type] = x.value; });
    var off = (p.timeZoneName || "GMT+13:00").replace("GMT", "") || "+13:00";
    if (!/^[+-]\d{2}:\d{2}$/.test(off)) off = "+13:00";
    return off;
  }
  function bookingDateTime(b) {
    var tm = String(b.booking_time || "00:00").slice(0, 8);
    if (tm.length === 5) tm += ":00";
    return new Date(b.booking_date + "T" + tm + nzOffsetFor(b.booking_date));
  }
  function dayShort(d) {
    if (!d) return "";
    var dt = d instanceof Date ? d : new Date(d);
    return new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, weekday: "short" }).format(dt).replace(/\./g, "").toUpperCase();
  }
  function bookingDayShort(b) {
    return new Date(b.booking_date + "T12:00:00Z").toLocaleDateString("en-NZ", { timeZone: "UTC", weekday: "short" }).replace(/\./g, "").toUpperCase();
  }
  function fmtStamp(d) {
    if (!d) return "";
    var dt = d instanceof Date ? d : new Date(d), p = {};
    new Intl.DateTimeFormat("en-NZ", {
      timeZone: TZ, weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: true
    }).formatToParts(dt).forEach(function (x) { p[x.type] = x.value; });
    var hour = p.hour || "";
    if (hour.length === 1) hour = "0" + hour;
    var ap = String(p.dayPeriod || "pm").replace(/[\s.]/g, "").toUpperCase();
    return p.weekday + " " + p.day + " " + p.month + " - " + hour + ":" + p.minute + ap;
  }
  function telHref(p) {
    var e164 = typeof ctParsePhone === "function" ? ctParsePhone(p) : null;
    return "tel:" + (e164 || String(p || "").replace(/[^\d+]/g, ""));
  }
  function displayPhone(p) {
    var shown = typeof ctFormatPhone === "function" ? ctFormatPhone(p) : "";
    return shown || String(p || "");
  }
  function loadSeen() { try { return JSON.parse(localStorage.getItem("ct-seen-bookings") || "[]"); } catch (e) { return []; } }
  function saveSeen() { try { localStorage.setItem("ct-seen-bookings", JSON.stringify(state.seenBookings.slice(-300))); } catch (e) {} }

  var toastTimer = null;
  function toast(msg, bad) {
    var t = $("toast");
    t.textContent = msg; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 6000 : 3000);
  }
  function errMsg(e) { return (e && e.message) ? e.message : "Something went wrong. Please try again."; }

  function show(screen) {
    ["login", "denied", "app"].forEach(function (s) { $("screen-" + s).hidden = s !== screen; });
    if (screen !== "app") showTakeover(false);
  }

  // ---------- sound (Web Audio, no files) ----------
  var audio = null, master = null, audioUnlockBound = false;
  function onAudioGesture() { unlockAudio(true); }
  function armSilentAudioUnlock() {
    if (audioUnlockBound) return;
    audioUnlockBound = true;
    document.addEventListener("pointerdown", onAudioGesture, true);
    document.addEventListener("keydown", onAudioGesture, true);
    document.addEventListener("touchstart", onAudioGesture, true);
  }
  function disarmSilentAudioUnlock() {
    if (!audioUnlockBound) return;
    audioUnlockBound = false;
    document.removeEventListener("pointerdown", onAudioGesture, true);
    document.removeEventListener("keydown", onAudioGesture, true);
    document.removeEventListener("touchstart", onAudioGesture, true);
  }
  function unlockAudio(fromGesture) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audio) {
      audio = new AC();
      var comp = audio.createDynamicsCompressor();
      master = audio.createGain(); master.gain.value = 1;
      master.connect(comp); comp.connect(audio.destination);
    }
    function after(ok) {
      if (ok && audio.state === "running") {
        disarmSilentAudioUnlock();
        if (fromGesture || ringKind) { ringKind = ""; updateRinging(); }
      } else {
        armSilentAudioUnlock();
      }
    }
    if (audio.state === "suspended") {
      var p = audio.resume();
      if (p && p.then) p.then(function () { after(true); }).catch(function () { after(false); });
      else after(audio.state === "running");
    } else {
      after(audio.state === "running");
    }
    tone(0, 440, 0.05, 0.001, "sine"); // silent blip to fully unlock on iOS/Android
  }
  function tone(at, freq, dur, vol, type) {
    if (!audio) return;
    var t = audio.currentTime + at, o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.setValueAtTime(vol, t + dur - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  function ringOrder() { // loud, phone-style double trill
    if (!audio) return;
    if (audio.state === "suspended") audio.resume();
    for (var b = 0; b < 2; b++) for (var i = 0; i < 8; i++) {
      tone(b * 1.0 + i * 0.09, i % 2 ? 1318 : 1046, 0.085, 0.7, "square");
    }
  }
  function chimeBooking() { // softer two-note chime
    if (!audio) return;
    if (audio.state === "suspended") audio.resume();
    tone(0, 784, 0.35, 0.35, "sine");
    tone(0.38, 1046, 0.55, 0.35, "sine");
  }

  var ringTimer = null, ringKind = "";
  function updateRinging() {
    var kind = "";
    if (newOrders().length) kind = "order";
    else if (unseenBookings().length) kind = "booking";
    if (!state.started) kind = "";
    if (kind === ringKind) return;
    clearInterval(ringTimer); ringTimer = null; ringKind = kind;
    if (kind === "order") { ringOrder(); ringTimer = setInterval(ringOrder, 3000); }
    else if (kind === "booking") { chimeBooking(); ringTimer = setInterval(chimeBooking, 8000); }
  }

  // ---------- keep the screen awake ----------
  var wakeLock = null;
  function requestWakeLock() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    navigator.wakeLock.request("screen").then(function (l) {
      wakeLock = l;
      l.addEventListener("release", function () { wakeLock = null; });
    }).catch(function () {});
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.started) {
      if (!wakeLock) requestWakeLock();
      if (audio && audio.state === "suspended") audio.resume();
      if (!state.live) subscribe();
      refresh();
    }
  });

  // ---------- data ----------
  function awaitingPayment(o) {
    return o.payment_method === "online" && o.payment_status === "unpaid";
  }
  function newOrders() {
    return state.orders.filter(function (o) { return o.status === "new" && !awaitingPayment(o); });
  }
  function orderDueAt(o) {
    if (o.ready_at) return new Date(o.ready_at);
    if (o.pickup_type === "later" && o.pickup_at) return new Date(o.pickup_at);
    if (o.created_at) return new Date(new Date(o.created_at).getTime() + PREP_MINUTES * 60000);
    return null;
  }
  function isDueNow(o) {
    if (o.status === "ready" || o.status === "collected") return true;
    if (o.status === "accepted" || o.status === "preparing") {
      var t = orderDueAt(o);
      return !!(t && t.getTime() <= Date.now());
    }
    return false;
  }
  function progressOrders() {
    return state.orders.filter(function (o) {
      return (o.status === "accepted" || o.status === "preparing") && !isDueNow(o);
    }).sort(function (a, b) {
      return (orderDueAt(a) || 0) - (orderDueAt(b) || 0);
    });
  }
  function liveDueOrders() {
    return state.orders.filter(isDueNow);
  }
  function pendingBookings() { return state.bookings.filter(function (b) { return b.status === "pending"; }); }
  function upcomingBookings() {
    var today = todayNZ();
    return state.bookings.filter(function (b) {
      return b.status === "accepted" && b.booking_date >= today;
    }).sort(function (a, b) {
      var da = (a.booking_date || "") + "T" + String(a.booking_time || "");
      var db = (b.booking_date || "") + "T" + String(b.booking_time || "");
      if (da < db) return -1;
      if (da > db) return 1;
      return 0;
    });
  }
  function unseenBookings() {
    return pendingBookings().filter(function (b) { return state.seenBookings.indexOf(b.id) < 0; });
  }

  var refreshing = null, refreshAgain = false;
  function refresh() {
    if (!state.session) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    var today = todayNZ();
    refreshing = Promise.all([
      sb.from("orders").select("*, order_items(*)")
        .in("status", ["new", "accepted", "preparing", "ready"])
        .order("created_at", { ascending: true }),
      sb.from("bookings").select("*")
        .or("status.eq.pending,and(status.eq.accepted,booking_date.gte." + today + ")")
        .order("booking_date", { ascending: true }).order("booking_time", { ascending: true }),
      sb.from("shop_settings").select("accepting_orders").eq("id", 1).maybeSingle()
    ]).then(function (r) {
      if (r[0].error) throw r[0].error;
      if (r[1].error) throw r[1].error;
      state.orders = r[0].data || [];
      state.bookings = r[1].data || [];
      if (!r[2].error && r[2].data) state.accepting = r[2].data.accepting_orders !== false;
      state.loadedOnce = true;
      state.lastOk = Date.now();
      noteReachOk();
      render();
    }).catch(function (e) {
      noteReachFailed();
      if (e && /JWT|token/i.test(e.message || "")) sb.auth.refreshSession();
    }).then(function () {
      refreshing = null;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    });
    return refreshing;
  }
  var refreshSoonTimer = null;
  function refreshSoon() { clearTimeout(refreshSoonTimer); refreshSoonTimer = setTimeout(refresh, 250); }

  function loadMenu() {
    return Promise.all([
      sb.from("menu_items").select("id,name,category,price_cents,option_groups,active,sort").order("sort"),
      sb.from("option_groups").select("key,name")
    ]).then(function (r) {
      if (r[0].error) throw r[0].error;
      state.menu = r[0].data || [];
      state.itemGroups = {};
      state.menu.forEach(function (m) { state.itemGroups[m.id] = m.option_groups || []; });
      state.groups = {};
      (r[1].data || []).forEach(function (g) { state.groups[g.key] = g.name; });
      renderMenu(); render();
    }).catch(function (e) { toast("Couldn't load the menu: " + errMsg(e), true); });
  }

  var subscribeRetry = null, reachFailedAt = 0, reachFailTimer = null;
  function subscribe() {
    if (state.channel) sb.removeChannel(state.channel);
    state.channel = sb.channel("shop-tablet")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, refreshSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, refreshSoon)
      .subscribe(function (status) {
        state.live = status === "SUBSCRIBED";
        setConn();
        if (state.live) {
          if (subscribeRetry) { clearTimeout(subscribeRetry); subscribeRetry = null; }
          refreshSoon();
        } else if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") && state.started && !subscribeRetry) {
          // Realtime dropped; polling keeps data fresh. Try the socket again shortly.
          subscribeRetry = setTimeout(function () {
            subscribeRetry = null;
            if (state.started && !state.live) subscribe();
          }, 2000);
        }
      });
  }
  function noteReachOk() {
    reachFailedAt = 0;
    if (reachFailTimer) { clearTimeout(reachFailTimer); reachFailTimer = null; }
  }
  function noteReachFailed() {
    if (!reachFailedAt) {
      reachFailedAt = Date.now();
      if (reachFailTimer) clearTimeout(reachFailTimer);
      reachFailTimer = setTimeout(function () { reachFailTimer = null; setConn(); }, 20000);
    }
    setConn();
  }
  function isUnreachable() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
    return !!(reachFailedAt && Date.now() - reachFailedAt >= 20000);
  }
  function setConn() {
    var c = $("conn");
    if (!c) return;
    // Show Live (or Not receiving orders) straight away, including while realtime is connecting.
    // "No internet" only after a real offline event or 20s of failed requests. No other status text.
    if (isUnreachable()) { c.className = "conn bad"; c.textContent = "No internet"; return; }
    if (!state.accepting) { c.className = "conn bad"; c.textContent = "Not receiving orders"; return; }
    c.className = "conn ok"; c.textContent = "OPEN";
  }

  // ---------- rendering ----------
  function optionLines(it) {
    var opts = it.options || {}, keys = Object.keys(opts), order = state.itemGroups[it.menu_item_id] || [];
    keys.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return keys.map(function (k) {
      var picks = Array.isArray(opts[k]) ? opts[k] : [], counts = {}, list = [];
      picks.forEach(function (p) { if (!(p in counts)) { counts[p] = 0; list.push(p); } counts[p]++; });
      if (!list.length) return "";
      var txt = list.map(function (p) { return esc(p) + (counts[p] > 1 ? " ×" + counts[p] : ""); }).join(", ");
      return '<div class="it-opt">' + esc(state.groups[k] || k) + ": " + txt + "</div>";
    }).join("");
  }

  function payText(o) {
    if (o.payment_method === "online") {
      return o.payment_status === "paid" ? '<span class="pay-paid">Paid online</span>'
        : "Pay online" + (o.payment_status === "failed" ? " (payment failed)" : o.payment_status === "unpaid" ? "" : ", not paid");
    }
    return o.payment_status === "paid" ? '<span class="pay-paid">Paid at counter</span>' : "Pay at counter";
  }

  var CHEVRON = '<svg class="chev" viewBox="0 0 24 24" width="52" height="52" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var TABLE_ICON = '<svg class="type-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6h18v2.4H3V6zm2.4 3.6h2.2V20H5.4V9.6zm13 0h2.2V20h-2.2V9.6zM9.2 9.6h5.6v2H9.2v-2z"/></svg>';
  var BAG_ICON = '<svg class="type-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 7V6a4 4 0 0 1 8 0v1h3v14H5V7h3zm2-1a2 2 0 0 1 4 0v1h-4V6z"/></svg>';
  var PEOPLE_ICON = '<svg class="people-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';
  var PHONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.8 3.5h3.1l.8 3.4-1.8 1.5a12.4 12.4 0 0 0 6.7 6.7l1.5-1.8 3.4.8v3.1c0 .8-.3 1.5-1.1 1.8A16.2 16.2 0 0 1 3.5 6.6c.3-.8 1-1.1 1.8-1.1z"/></svg>';
  var MAIL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M3.5 6h17v12h-17V6z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" d="M3.8 6.6L12 13.2 20.2 6.6"/></svg>';
  var BACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-8 7 8 7"/></svg>';
  var TICKS = '<svg class="ticks" viewBox="0 0 28 14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M1.6 7.4l3.8 3.8L13.2 2.4"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M11.6 7.4l3.8 3.8L23.2 2.4"/></svg>';

  function orderStatus(o) {
    if (o.status === "new") return { text: "New", kind: "new" };
    if (o.status === "ready") return { text: "Ready", kind: "ok" };
    if (o.status === "accepted" || o.status === "preparing") return { text: "Accepted", kind: "ok" };
    if (o.status === "collected") return { text: "Picked up", kind: "ok" };
    if (o.status === "cancelled") return { text: "Cancelled", kind: "bad" };
    return { text: o.status, kind: "" };
  }
  function bookingStatus(b) {
    if (b.status === "pending") return { text: "New", kind: "new" };
    if (b.status === "accepted") return { text: "Accepted", kind: "ok" };
    if (b.status === "declined") return { text: "Declined", kind: "bad" };
    return { text: b.status, kind: "" };
  }
  function statusHtml(st, cls) {
    if (!st) return "";
    var ticks = st.kind === "ok" ? TICKS : "";
    return '<span class="' + cls + (st.kind ? " " + st.kind : "") + '">' + ticks + esc(st.text) + "</span>";
  }
  function orderDay(o) {
    if (o.pickup_type === "later" && o.pickup_at) return dayShort(o.pickup_at);
    return "ASAP";
  }
  function weekdayShort(d) {
    var day = new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, weekday: "short" }).format(d instanceof Date ? d : new Date(d)).replace(/\./g, "");
    return day ? day.charAt(0).toUpperCase() + day.slice(1).toLowerCase() : "";
  }
  function isTodayNZ(d) {
    var p = nzParts(d instanceof Date ? d : new Date(d));
    return p.year + "-" + p.month + "-" + p.day === todayNZ();
  }
  function dueLabel(when) {
    if (!when) return "";
    var dt = when instanceof Date ? when : new Date(when);
    var time = fmtTime(dt);
    if (!time) return "";
    var p = {};
    new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" })
      .formatToParts(dt).forEach(function (x) { p[x.type] = x.value; });
    var wk = weekdayShort(dt) || (p.weekday || "");
    return "Due " + wk + " " + (p.day || "") + " " + (p.month || "") + ", " + time;
  }
  function orderDue(o) {
    var when = orderDueAt(o);
    return when ? dueLabel(when) : "";
  }
  function bookingDue(b) {
    return dueLabel(bookingDateTime(b));
  }

  function payShort(o) {
    if (o.payment_status === "paid") return { text: "Paid", paid: true };
    if (o.payment_method === "counter" && o.status === "collected") return { text: "Paid", paid: true };
    return { text: "Not paid", paid: false };
  }
  function dueLine(due, pay) {
    if (!due && !pay) return "";
    var html = '<span class="s-due">';
    if (due) {
      var cut = due.lastIndexOf(", ");
      if (cut > 0) html += '<span class="s-due-date">' + esc(due.slice(0, cut + 1)) + "</span> " +
        '<span class="s-due-time">' + esc(due.slice(cut + 2)) + "</span>";
      else html += '<span class="s-due-text">' + esc(due) + "</span>";
    }
    if (pay) html += (due ? " " : "") + '<span class="s-pay-bit">' + (due ? '<span class="s-pay-sep">· </span>' : "") +
      '<span class="s-pay' + (pay.paid ? " ok" : " bad") + '">' + esc(pay.text) + "</span></span>";
    return html + "</span>";
  }
  function summary(id, icon, day, name, st, rightHtml, due, acts, pay) {
    return '<div class="top"><button type="button" class="sum" data-act="expand" data-id="' + id + '">' +
      '<span class="s-icon">' + icon + '<span class="s-day">' + esc(day) + "</span></span>" +
      '<span class="s-mid"><span class="s-name">' + esc(name) + "</span>" +
      dueLine(due, pay) +
      statusHtml(st, "s-status") + "</span></button>" +
      '<button type="button" class="s-right" data-act="expand" data-id="' + id + '">' + rightHtml + "</button>" +
      (acts || '<button type="button" class="chev-btn" data-act="expand" data-id="' + id + '" aria-label="Show details">' + CHEVRON + "</button>") +
      "</div>";
  }

  function kv(label, valueHtml, extra) {
    return '<div class="kv' + (extra ? " " + extra : "") + '"><span class="kv-l">' + esc(label) + '</span><span class="kv-v">' + valueHtml + "</span></div>";
  }
  function customerBlock(name, phone, email) {
    return '<div class="cust"><div class="cust-name">' + esc(name) + "</div>" +
      (phone ? '<a class="cust-line" href="' + esc(telHref(phone)) + '">' + PHONE_ICON + "<span>" + esc(displayPhone(phone)) + "</span></a>" : "") +
      (email ? '<div class="cust-line">' + MAIL_ICON + "<span>" + esc(email) + "</span></div>" : "") +
      "</div>";
  }
  function statusBand(st) {
    if (!st) return "";
    var ticks = st.kind === "ok" ? TICKS : "";
    return '<div class="status-band ' + (st.kind || "") + '">' + ticks + esc(st.text) + "</div>";
  }
  function detailShell(title, pill, st, body, actions) {
    return '<div class="detail-screen"><div class="detail-head">' +
      '<button type="button" class="back-btn" data-act="back" aria-label="Back">' + BACK_ICON + "</button>" +
      '<div class="detail-titles"><h2>' + esc(title) + "</h2>" +
      '<span class="pill">' + esc(pill) + "</span></div></div>" +
      statusBand(st) +
      '<div class="detail-body">' + body + "</div>" +
      (actions ? '<div class="actions detail-actions">' + actions + "</div>" : "") +
      "</div>";
  }
  function noteHtml(label, text) {
    if (!text) return "";
    return '<div class="order-note">' + esc(label) + ": " + esc(text) + "</div>";
  }
  function itemList(o) {
    var items = (o.order_items || []).slice().sort(function (a, b) { return a.id - b.id; });
    return '<ul class="items">' + items.map(function (it) {
      return "<li><div class=\"it-top\"><span class=\"it-name\">" + it.qty + " × " + esc(it.name) +
        "</span><span class=\"it-price\">" + money(it.line_cents) + "</span></div>" + optionLines(it) +
        (it.note ? '<div class="it-note">Note: ' + esc(it.note) + "</div>" : "") + "</li>";
    }).join("") + "</ul>";
  }
  function acceptDecline(kind, id) {
    var d = kind === "booking" ? "bk-decline" : "decline";
    var a = kind === "booking" ? "bk-accept" : "accept";
    var o = kind === "order" ? findOrder(id) : null;
    var blockAccept = !!(o && o.payment_method === "online" && o.payment_status !== "paid");
    var html = '<div class="row-acts">' +
      '<button type="button" class="decide-btn decide-no" data-act="' + d + '" data-id="' + id + '" aria-label="Decline">Decline</button>';
    if (blockAccept) html += '<span class="decide-unpaid">Not paid</span>';
    else html += '<button type="button" class="decide-btn decide-yes" data-act="' + a + '" data-id="' + id + '" aria-label="Accept">Accept</button>';
    return html + "</div>";
  }

  function orderCard(o) {
    var acts = o.status === "new" ? acceptDecline("order", o.id) : "";
    return '<article class="card">' +
      summary(o.id, BAG_ICON, orderDay(o), o.customer_name, orderStatus(o), esc(money(o.total_cents)), orderDue(o), acts, payShort(o)) +
      "</article>";
  }

  function bookingCard(b) {
    var acts = b.status === "pending" ? acceptDecline("booking", b.id) : "";
    return '<article class="card">' +
      summary(b.id, TABLE_ICON, bookingDayShort(b), b.name, bookingStatus(b), esc(String(b.party_size)) + PEOPLE_ICON, bookingDue(b), acts) +
      "</article>";
  }

  function dueCard(o) {
    var when = orderDueAt(o) || o.updated_at || o.created_at;
    return '<article class="card">' +
      summary(o.id, BAG_ICON, dayShort(when) || orderDay(o), o.customer_name, orderStatus(o), esc(money(o.total_cents)), orderDue(o), "", payShort(o)) +
      "</article>";
  }

  function orderDetail(o) {
    var st = orderStatus(o);
    var body = kv("Placed on", esc(fmtStamp(o.created_at)));
    if (o.accepted_at) body += kv("Accepted on", esc(fmtStamp(o.accepted_at)));
    if (o.ready_at) body += kv("Ready at", esc(fmtStamp(o.ready_at)), "fulfill");
    else if (o.pickup_type === "later" && o.pickup_at) body += kv("Fulfillment", esc(fmtStamp(o.pickup_at)), "fulfill");
    else body += kv("Fulfillment", "ASAP", "fulfill");
    body += '<div class="rule"></div>' + customerBlock(o.customer_name, o.phone, o.email) +
      '<div class="rule"></div>' + itemList(o) + noteHtml("Order note", o.notes) +
      '<div class="totals"><span>Total</span><span>' + money(o.total_cents) + "</span></div>" +
      '<div class="pay-line"><span>Payment</span><span>' + payText(o) + "</span></div>";
    var actions = "";
    if (o.status === "new") {
      var blockAccept = o.payment_method === "online" && o.payment_status !== "paid";
      actions = '<div class="row-acts">';
      if (blockAccept) actions += '<span class="decide-unpaid">Not paid</span>';
      else actions += '<button type="button" class="decide-btn decide-yes" data-act="accept" data-id="' + o.id + '" aria-label="Accept">Accept</button>';
      if (canEditOrder(o)) actions += '<button type="button" class="decide-btn decide-edit" data-act="edit" data-id="' + o.id + '">Edit</button>';
      actions += '<button type="button" class="decide-btn decide-no" data-act="decline" data-id="' + o.id + '" aria-label="Decline">Decline</button></div>';
    }
    return detailShell("Pickup", "Pickup", st, body, actions);
  }

  function bookingDetail(b) {
    var st = bookingStatus(b);
    var ppl = b.party_size + (b.party_size === 1 ? " person" : " persons");
    var body = kv("Placed on", esc(fmtStamp(b.created_at)));
    if (b.status === "accepted" && b.decided_at) body += kv("Accepted on", esc(fmtStamp(b.decided_at)));
    body += kv("Fulfillment", esc(fmtStamp(bookingDateTime(b))), "fulfill") +
      '<div class="rule"></div>' + customerBlock(b.name, b.phone, b.email) +
      '<div class="rule"></div>' + kv("Guests", esc(String(b.party_size))) +
      noteHtml("Note", b.notes);
    var actions = "";
    if (b.status === "pending") {
      actions = acceptDecline("booking", b.id);
    }
    return detailShell(ppl, "Reservation", st, body, actions);
  }

  function fill(id, html, emptyText) {
    $(id).innerHTML = html || (emptyText ? '<div class="empty">' + emptyText + "</div>" : "");
  }


  function canEditOrder(o) {
    return !!(o && o.status === "new" && o.payment_status !== "paid");
  }
  function oldestNewOrder() {
    var nw = newOrders();
    return nw.length ? nw[0] : null;
  }
  function showTakeover(on) {
    var el = $("order-takeover");
    if (!el) return;
    el.hidden = !on;
    document.body.classList.toggle("has-takeover", !!on);
  }
  function startEdit(o) {
    state.editing = {
      items: (o.order_items || []).slice().sort(function (a, b) { return a.id - b.id; }).map(function (it) {
        return { id: it.id, name: it.name, qty: Number(it.qty) || 1, unit_cents: Number(it.unit_cents) || 0, note: it.note || "", options: it.options || {}, menu_item_id: it.menu_item_id };
      }),
      notes: o.notes || "",
      dirty: false
    };
  }
  function editTotal(d) {
    return (d.items || []).reduce(function (s, it) { return s + Number(it.qty) * Number(it.unit_cents || 0); }, 0);
  }
  function findEditItem(id) {
    var n = Number(id);
    return state.editing && state.editing.items.filter(function (it) { return Number(it.id) === n; })[0];
  }
  function orderEdit(o) {
    var d = state.editing;
    var body = '<ul class="items edit-items">' + d.items.map(function (it) {
      return '<li data-item="' + it.id + '"><div class="it-top"><span class="it-name">' + esc(it.name) +
        '</span><span class="it-price">' + money(it.qty * it.unit_cents) + "</span></div>" +
        optionLines(it) +
        '<div class="edit-qty" role="group" aria-label="Quantity">' +
          '<button type="button" class="edit-step" data-act="qty-down" data-id="' + it.id + '" aria-label="Fewer">−</button>' +
          '<span class="edit-n">' + it.qty + "</span>" +
          '<button type="button" class="edit-step" data-act="qty-up" data-id="' + it.id + '" aria-label="More">+</button>' +
          (d.items.length > 1 ? '<button type="button" class="edit-remove" data-act="qty-remove" data-id="' + it.id + '">Remove</button>' : "") +
        "</div>" +
        '<label class="edit-note-label">Note<textarea class="edit-note" data-act="item-note" data-id="' + it.id + '" rows="2" maxlength="200">' + esc(it.note) + "</textarea></label></li>";
    }).join("") + "</ul>" +
      '<label class="edit-note-label">Order note<textarea class="edit-note" id="edit-order-notes" data-act="order-note" rows="3" maxlength="500">' + esc(d.notes) + "</textarea></label>" +
      '<div class="totals"><span>Total</span><span>' + money(editTotal(d)) + "</span></div>";
    return '<div id="order-edit">' + detailShell("Edit order", "Pickup", null, body, "") + "</div>";
  }
  function paintEdit() {
    var o = findOrder(state.detail);
    var detailEl = $("order-detail"), listEl = $("orders-list");
    if (!o || !state.editing || !detailEl) return;
    $("pane-current").hidden = false;
    $("pane-settings").hidden = true;
    if (listEl) listEl.hidden = true;
    detailEl.hidden = false;
    detailEl.innerHTML = orderEdit(o);
    if (detailEl.parentNode) detailEl.parentNode.scrollTop = 0;
  }
  function saveEdit() {
    var d = state.editing, id = state.detail;
    if (!d) return Promise.resolve();
    if (!d.items.length) {
      toast("An order needs at least one item.", true);
      return Promise.reject(new Error("An order needs at least one item."));
    }
    if (!d.dirty) { state.editing = null; return Promise.resolve(); }
    return sb.rpc("edit_order", {
      p_order_id: id,
      p_items: d.items.map(function (it) { return { id: it.id, qty: it.qty, note: it.note || "" }; }),
      p_notes: d.notes || ""
    }).then(function (r) {
      if (r.error) throw r.error;
      state.editing = null;
      return refresh();
    });
  }

  function render() {
    var nw = newOrders(), pb = pendingBookings();
    if (state.loadedOnce) {
      var fresh = nw.map(function (o) { return { t: o.created_at, h: orderCard(o) }; })
        .concat(pb.map(function (b) { return { t: b.created_at, h: bookingCard(b) }; }))
        .sort(function (a, b) { return new Date(a.t) - new Date(b.t); });
      fill("list-new", fresh.map(function (x) { return x.h; }).join(""), "No new orders.");
      var prog = progressOrders(), booked = upcomingBookings();
      fill("list-progress", prog.map(orderCard).join(""), "");
      fill("list-booked", booked.map(bookingCard).join(""), "");
      $("list-progress").parentNode.hidden = !prog.length;
      $("list-booked").parentNode.hidden = !booked.length;
    }
    var n = nw.length + pb.length;
    document.title = (n ? "(" + n + ") " : "") + "Café Turquoise Orders";

    var detailEl = $("order-detail"), listEl = $("orders-list");
    var d = state.detail ? (findOrder(state.detail) || findBooking(state.detail)) : null;
    if (state.detail && !d) { state.detail = null; state.editing = null; }
    document.body.classList.remove("split");

    var oldest = oldestNewOrder();
    if (state.editing) {
      var ed = findOrder(state.detail);
      if (!ed || !canEditOrder(ed)) state.editing = null;
      else {
        showTakeover(false);
        $("pane-current").hidden = false;
        $("pane-settings").hidden = true;
        if (listEl) listEl.hidden = true;
        if (detailEl) detailEl.hidden = false;
        if (!$("order-edit") && !$("edit-order-notes")) paintEdit();
        renderSettings();
        setConn();
        updateRinging();
        return;
      }
    }

    // A new order that belongs on New takes over the whole screen until it is
    // opened, then accepted or declined. Oldest unhandled first.
    if (oldest && state.detail !== oldest.id) {
      state.editing = null;
      showTakeover(true);
      renderSettings();
      setConn();
      updateRinging();
      return;
    }
    showTakeover(false);

    if (state.detail && d) {
      $("pane-current").hidden = false;
      $("pane-settings").hidden = true;
      listEl.hidden = true;
      detailEl.hidden = false;
      detailEl.innerHTML = findOrder(state.detail) ? orderDetail(d) : bookingDetail(d);
      if (detailEl.parentNode) detailEl.parentNode.scrollTop = 0;
    } else if (listEl && detailEl) {
      ["current", "settings"].forEach(function (p) { $("pane-" + p).hidden = p !== state.tab; });
      listEl.hidden = false;
      detailEl.hidden = true;
      detailEl.innerHTML = "";
    }
    renderSettings();
    setConn();
    updateRinging();
  }

  function renderSettings() {
    $("settings-main").hidden = state.settingsView !== "main";
    $("settings-menu").hidden = state.settingsView !== "menu";
    $("settings-due").hidden = state.settingsView !== "due";
    var title = $("settings-title");
    if (title) title.hidden = state.settingsView !== "due";
    var more = $("due-more");
    if (more) more.hidden = !(state.settingsView === "due" && state.dueHasMore);
    if (state.settingsView === "due") {
      fill("list-due", dueList().map(dueCard).join(""), "No due orders.");
    }
    var b = $("stop-btn");
    b.className = "settings-row" + (state.accepting ? "" : " off");
    b.setAttribute("aria-checked", state.accepting ? "true" : "false");
  }

  function renderMenu() {
    var cats = [], byCat = {};
    state.menu.forEach(function (m) {
      if (!byCat[m.category]) { byCat[m.category] = []; cats.push(m.category); }
      byCat[m.category].push(m);
    });
    $("menu-list").innerHTML = cats.map(function (c) {
      return '<section class="menu-cat"><h2>' + esc(c.toLocaleUpperCase("tr-TR")) + "</h2>" + byCat[c].map(function (m) {
        return '<button type="button" class="menu-row' + (m.active ? "" : " off") + '" data-act="toggle" data-id="' + esc(m.id) +
          '" role="switch" aria-checked="' + (m.active ? "true" : "false") + '"><span class="m-name">' + esc(m.name) + "</span>" +
          (m.active ? "" : '<span class="m-state">Sold out</span>') + '<span class="switch"></span></button>';
      }).join("") + "</section>";
    }).join("");
  }

  function markSeen(id) {
    if (state.seenBookings.indexOf(id) < 0) { state.seenBookings.push(id); saveSeen(); }
  }

  function setTab(tab) {
    state.tab = tab;
    if (tab !== "current") { state.detail = null; state.detailFrom = null; }
    ["current", "settings"].forEach(function (p) { $("pane-" + p).hidden = p !== tab; });
    if (tab === "settings") { state.settingsView = "main"; refresh(); }
    render();
  }

  var DUE_PAGE = 50;
  function dueList() {
    var seen = {}, rows = [];
    liveDueOrders().concat(state.dueCollected).forEach(function (o) {
      if (seen[o.id]) return;
      seen[o.id] = true;
      rows.push(o);
    });
    rows.sort(function (a, b) {
      var da = orderDueAt(a), db = orderDueAt(b);
      return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
    });
    return rows;
  }
  function loadDue(append) {
    if (state.dueLoading) return;
    state.dueLoading = true;
    var from = append ? state.dueCollected.length : 0;
    return sb.from("orders").select("*, order_items(*)")
      .eq("status", "collected")
      .order("updated_at", { ascending: false })
      .range(from, from + DUE_PAGE - 1)
      .then(function (r) {
        state.dueLoading = false;
        if (r.error) throw r.error;
        var rows = r.data || [];
        state.dueCollected = append ? state.dueCollected.concat(rows) : rows;
        state.dueHasMore = rows.length === DUE_PAGE;
        render();
      }).catch(function (e) {
        state.dueLoading = false;
        toast(errMsg(e), true);
        render();
      });
  }
  function openDue() {
    state.settingsView = "due";
    state.detail = null;
    state.detailFrom = null;
    loadDue(false);
    render();
  }

  // ---------- modal ----------
  function openModal(html) { $("modal-box").classList.remove("is-form"); $("modal-box").innerHTML = html; $("modal").hidden = false; }
  function closeModal() { $("modal").hidden = true; $("modal-box").innerHTML = ""; numpad = null; confirmYes = null; }
  var numpad = null; // { order, mins: "25", showKeys: bool }

  function openAccept(o) {
    numpad = { order: o, mins: "", showKeys: o.pickup_type !== "later" };
    renderNumpad();
  }
  var ROW_CHEV = '<svg class="settings-chev" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>';
  function renderNumpad() {
    var o = numpad.order, n = parseInt(numpad.mins, 10), ok = n >= 1 && n <= 300;
    var pickupBit = o.pickup_type === "later" && o.pickup_at ? "Pickup " + fmtTime(o.pickup_at) : "ASAP";
    var html = '<div class="modal-body"><h3>Accept order</h3>' +
      '<p class="sub">' + esc(o.customer_name) + " · " + pickupBit + "</p>";
    if (o.pickup_type === "later" && !numpad.showKeys) {
      html += "</div>";
      html += '<button type="button" class="modal-row" data-np="keys"><span>Change time</span>' + ROW_CHEV + "</button>";
      html += '<div class="modal-actions"><button type="button" class="btn" data-np="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-go" data-np="later">Accept</button></div>';
      openModal(html); return;
    }
    if (ok) html += '<p class="sub">Ready at ' + fmtTime(new Date(Date.now() + n * 60000)) + "</p>";
    html += '<div class="np-display"><span class="np-mins">' + (numpad.mins || "0") + "</span><span class=\"np-unit\">min</span></div>";
    html += '<div class="np-keys">' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (k) {
      return '<button type="button" class="btn" data-np="key" data-v="' + k + '">' + k + "</button>";
    }).join("") + '<button type="button" class="btn" data-np="clear">Clear</button>' +
      '<button type="button" class="btn" data-np="key" data-v="0">0</button>' +
      '<button type="button" class="btn" data-np="back" aria-label="Delete">⌫</button></div></div>';
    html += '<div class="modal-actions"><button type="button" class="btn" data-np="cancel">Cancel</button>' +
      '<button type="button" class="btn btn-go" data-np="ok"' + (ok ? "" : " disabled") + ">Accept</button></div>";
    openModal(html);
  }

  function numpadClick(btn) {
    var a = btn.dataset.np, v = btn.dataset.v;
    if (a === "cancel") return closeModal();
    if (a === "keys") { numpad.showKeys = true; return renderNumpad(); }
    if (a === "key") { if (numpad.mins.length < 3) numpad.mins = (numpad.mins + v).replace(/^0+/, ""); return renderNumpad(); }
    if (a === "back") { numpad.mins = numpad.mins.slice(0, -1); return renderNumpad(); }
    if (a === "clear") { numpad.mins = ""; return renderNumpad(); }
    if (a === "ok" || a === "later") {
      var o = numpad.order, mins = a === "later" ? null : parseInt(numpad.mins, 10);
      btn.disabled = true;
      sb.rpc("accept_order", { p_order_id: o.id, p_minutes: mins }).then(function (r) {
        if (r.error) throw r.error;
        var row = r.data && r.data[0];
        closeModal();
        toast(o.customer_name + "'s order accepted" + (row && row.ready_at ? ", ready at " + fmtTime(row.ready_at) : ""));
        refresh();
      }).catch(function (e) { btn.disabled = false; toast(errMsg(e), true); refresh(); });
    }
  }

  function confirmBox(title, text, yes, onYes) {
    openModal('<div class="modal-body"><h3>' + esc(title) + '</h3><p class="sub">' + esc(text) + "</p></div>" +
      '<div class="modal-actions"><button type="button" class="btn" data-cf="no">Cancel</button>' +
      '<button type="button" class="btn btn-go" data-cf="yes">' + esc(yes) + "</button></div>");
    confirmYes = onYes;
  }
  var confirmYes = null;

  function hasCustomerEmail(email) {
    return !!(email && /.+@.+\..+/.test(String(email).trim()));
  }
  function openDecline(kind, row) {
    var isBk = kind === "booking";
    var name = isBk ? row.name : row.customer_name;
    var noun = isBk ? "booking" : "order";
    var note = "You can add an optional message. It is saved with the decline.";
    openModal('<div class="modal-body"><h3>Decline ' + noun + "</h3>" +
      '<p class="sub">' + esc(name) + "</p>" +
      '<p class="sub">' + esc(note) + "</p>" +
      '<label class="msg-label" for="decline-msg">Message (optional)</label>' +
      '<textarea id="decline-msg" class="msg-box" maxlength="500" rows="4"></textarea></div>' +
      '<div class="modal-actions"><button type="button" class="btn" data-dc="no">Cancel</button>' +
      '<button type="button" class="btn btn-go" data-dc="yes" data-kind="' + kind + '" data-id="' + row.id + '">Decline</button></div>');
    $("modal-box").classList.add("is-form");
    setTimeout(function () { var m = $("decline-msg"); if (m) m.focus(); }, 0);
  }
  function sendDecline(btn) {
    if (btn.dataset.dc === "no") return closeModal();
    var kind = btn.dataset.kind, id = btn.dataset.id;
    var msgEl = $("decline-msg");
    var msg = msgEl ? msgEl.value.trim() : "";
    var isBk = kind === "booking";
    var row = isBk ? findBooking(id) : findOrder(id);
    if (!row) return closeModal();
    btn.disabled = true;
    if (isBk) markSeen(id);
    var rpc = isBk ? "decline_booking" : "decline_order";
    var args = isBk ? { booking_id: id, message: msg } : { order_id: id, message: msg };
    sb.rpc(rpc, args).then(function (r) {
      if (r.error) throw r.error;
      var out = r.data && r.data[0];
      closeModal();
      toast(isBk ? "Booking declined" : "Order declined");
      refresh();
    }).catch(function (e) { btn.disabled = false; toast(errMsg(e), true); refresh(); });
  }

  function setAccepting(on) {
    var b = $("stop-btn"); b.disabled = true;
    sb.from("shop_settings").update({ accepting_orders: on }).eq("id", 1).select("accepting_orders").then(function (r) {
      b.disabled = false;
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error("Couldn't change the setting.");
      state.accepting = r.data[0].accepting_orders;
      render();
      toast(state.accepting ? "Receiving orders again" : "Stopped receiving orders");
    }).catch(function (e) { b.disabled = false; toast(errMsg(e), true); });
  }

  // ---------- actions ----------
  function setBookingStatus(b, to, okMsg) {
    return sb.from("bookings").update({ status: to }).eq("id", b.id).eq("status", "pending").select("id").then(function (r) {
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error("This booking was changed on another screen.");
      toast(okMsg); refresh();
    }).catch(function (e) { toast(errMsg(e), true); refresh(); });
  }
  function findOrder(id) {
    return state.orders.filter(function (o) { return o.id === id; })[0] ||
      state.dueCollected.filter(function (o) { return o.id === id; })[0];
  }
  function findBooking(id) { return state.bookings.filter(function (b) { return b.id === id; })[0]; }

  function toggleItem(btn) {
    var id = btn.dataset.id, m = state.menu.filter(function (x) { return x.id === id; })[0];
    if (!m || btn.classList.contains("busy")) return;
    var next = !m.active;
    btn.classList.add("busy");
    sb.from("menu_items").update({ active: next }).eq("id", id).select("id,active").then(function (r) {
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error("Couldn't change " + m.name + ".");
      m.active = r.data[0].active;
      renderMenu();
      toast(m.name + (m.active ? " is back on" : " is sold out"));
    }).catch(function (e) { btn.classList.remove("busy"); toast(errMsg(e), true); });
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest(".row-acts") && !e.target.closest("button")) {
      e.stopPropagation();
      return;
    }
    var t = e.target.closest ? e.target.closest("button, [data-act]") : null;
    if (!t) return;
    if (t.closest && t.closest(".row-acts")) e.stopPropagation();
    if (t.dataset.np && numpad) return numpadClick(t);
    if (t.dataset.dc) return sendDecline(t);
    if (t.dataset.cf) {
      var fn = confirmYes; confirmYes = null; closeModal();
      if (t.dataset.cf === "yes" && fn) fn();
      return;
    }
    if (t.id === "settings-btn") return setTab("settings");
    if (t.id === "settings-back-btn") {
      if (state.settingsView === "menu" || state.settingsView === "due") {
        state.settingsView = "main";
        return render();
      }
      return setTab("current");
    }
    if (t.id === "due-btn") return openDue();
    if (t.id === "due-more") return loadDue(true);
    if (t.id === "edit-menu-btn") { state.settingsView = "menu"; loadMenu(); return render(); }
    if (t.id === "stop-btn") {
      if (!state.accepting) return setAccepting(true);
      return confirmBox("Stop receiving orders?", "The website won't take new orders until you start again.",
        "Stop orders", function () { setAccepting(false); });
    }
    var act = t.dataset.act, id = t.dataset.id, o, b;
    if (act === "back") {
      if (state.editing) {
        return saveEdit().then(function () { render(); }).catch(function (e) { toast(errMsg(e), true); });
      }
      state.detail = null;
      if (state.detailFrom === "due") {
        state.detailFrom = null;
        state.tab = "settings";
        state.settingsView = "due";
      }
      return render();
    }
    if (act === "view-incoming") {
      var incoming = oldestNewOrder();
      if (incoming) {
        state.tab = "current";
        state.detail = incoming.id;
        state.detailFrom = null;
        state.editing = null;
      }
      return render();
    }
    if (act === "edit" && (o = findOrder(id))) {
      if (!canEditOrder(o)) return;
      startEdit(o);
      return render();
    }
    if ((act === "qty-up" || act === "qty-down" || act === "qty-remove") && state.editing) {
      var it = findEditItem(id);
      if (!it) return;
      if (act === "qty-up") { if (it.qty < 99) it.qty += 1; }
      else if (act === "qty-down") { if (it.qty > 1) it.qty -= 1; }
      else if (act === "qty-remove") {
        if (state.editing.items.length < 2) return toast("An order needs at least one item.", true);
        state.editing.items = state.editing.items.filter(function (x) { return Number(x.id) !== Number(it.id); });
      }
      state.editing.dirty = true;
      paintEdit();
      return;
    }
    if (act === "expand") {
      state.detailFrom = (state.tab === "settings" && state.settingsView === "due") ? "due" : null;
      state.detail = id;
      if (findBooking(id)) markSeen(id);
      return render();
    }
    if (act === "accept" && (o = findOrder(id))) {
      if (o.payment_method === "online" && o.payment_status !== "paid") return toast("This online order is not paid.", true);
      return openAccept(o);
    }
    if (act === "decline" && (o = findOrder(id))) return openDecline("order", o);
    if (act === "bk-accept" && (b = findBooking(id))) {
      markSeen(b.id); t.disabled = true;
      return sb.rpc("accept_booking", { booking_id: b.id }).then(function (r) {
        if (r.error) throw r.error;
        var out = r.data && r.data[0];
        toast("Booking for " + b.name + " accepted");
        refresh();
      }).catch(function (e) { t.disabled = false; toast(errMsg(e), true); refresh(); });
    }
    if (act === "bk-decline" && (b = findBooking(id))) return openDecline("booking", b);
    if (act === "toggle") return toggleItem(t);
  });
  $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) closeModal(); });
  document.addEventListener("input", function (e) {
    if (!state.editing || !e.target) return;
    var act = e.target.getAttribute("data-act");
    if (act === "item-note") {
      var it = findEditItem(e.target.getAttribute("data-id"));
      if (it) { it.note = e.target.value; state.editing.dirty = true; }
    }
    if (act === "order-note") { state.editing.notes = e.target.value; state.editing.dirty = true; }
  });
  window.addEventListener("resize", function () { if (state.started) render(); });

  // ---------- auth + start ----------
  function isStaff(session) {
    return !!(session && session.user && session.user.app_metadata && session.user.app_metadata.role === "staff");
  }

  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var err = $("login-error"), btn = $("login-btn");
    err.hidden = true; btn.disabled = true; btn.textContent = "Logging in…";
    sb.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-password").value }).then(function (r) {
      btn.disabled = false; btn.textContent = "Log in";
      if (r.error) {
        err.textContent = /invalid/i.test(r.error.message) ? "Wrong email or password." : r.error.message;
        err.hidden = false; return;
      }
      $("login-password").value = "";
      onSession(r.data.session);
    });
  });

  var pollTimer = null, clockTimer = null;
  function stopApp() {
    state.started = false;
    state.editing = null;
    showTakeover(false);
    clearInterval(pollTimer); clearInterval(clockTimer); updateRinging();
    if (subscribeRetry) { clearTimeout(subscribeRetry); subscribeRetry = null; }
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; state.live = false; }
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }

  function readStoredAuth() {
    try {
      var raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      var sess = data && (data.currentSession || data.session || data);
      if (sess && (sess.refresh_token || sess.access_token)) return sess;
    } catch (e) {}
    return null;
  }
  function hasStoredSession() {
    var s = state.session || readStoredAuth();
    return !!(s && (s.refresh_token || s.access_token));
  }
  function isTransientAuthError(err) {
    if (!err) return false;
    if (err.name === "AuthRetryableFetchError") return true;
    var status = err.status;
    if (status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) return true;
    var m = String(err.message || "").toLowerCase();
    return /failed to fetch|networkerror|network|offline|timeout|abort|load failed/.test(m);
  }

  function requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    } catch (e) {}
  }

  var authRetryTimer = null, authRetryMs = 2000, authRefreshing = null;
  function scheduleAuthRetry() {
    if (authRetryTimer || authRefreshing) return;
    authRetryTimer = setTimeout(function () {
      authRetryTimer = null;
      refreshAuth(true);
    }, authRetryMs);
    authRetryMs = Math.min(Math.round(authRetryMs * 2), 60000);
  }
  function sessionNeedsRefresh(session) {
    if (!session) return false;
    if (!session.expires_at) return true;
    return session.expires_at - Date.now() / 1000 < 60;
  }
  function refreshAuth(force) {
    var sess = state.session || readStoredAuth();
    if (!sess) return Promise.resolve();
    if (!force && !sessionNeedsRefresh(sess)) return Promise.resolve();
    if (authRefreshing) return authRefreshing;
    authRefreshing = sb.auth.refreshSession().then(function (r) {
      authRefreshing = null;
      if (r.data && r.data.session) {
        authRetryMs = 2000;
        state.session = r.data.session;
        return;
      }
      if (r.error && isTransientAuthError(r.error)) {
        scheduleAuthRetry();
        return;
      }
      if (!hasStoredSession()) {
        state.session = null;
        stopApp();
        show("login");
      }
    }).catch(function (e) {
      authRefreshing = null;
      if (isTransientAuthError(e) || hasStoredSession()) scheduleAuthRetry();
    });
    return authRefreshing;
  }

  function onSession(session) {
    if (session) {
      state.session = session;
      if (!isStaff(session)) {
        // role may have just been added: refresh the token once before saying no
        return sb.auth.refreshSession().then(function (r) {
          var s = r.data && r.data.session;
          if (isStaff(s)) { state.session = s; startApp(); }
          else if (r.error && isTransientAuthError(r.error)) {
            startApp();
            scheduleAuthRetry();
          }
          else show("denied");
        }).catch(function (e) {
          if (isTransientAuthError(e) || hasStoredSession()) {
            startApp();
            scheduleAuthRetry();
          } else show("denied");
        });
      }
      startApp();
      return;
    }
    if (hasStoredSession()) {
      if (!state.session) state.session = readStoredAuth();
      startApp();
      scheduleAuthRetry();
      return;
    }
    stopApp();
    show("login");
  }

  function startApp() {
    show("app");
    if (state.started) return;
    state.started = true;
    requestWakeLock();
    unlockAudio();
    setTab(state.tab);
    tick(); clockTimer = setInterval(tick, 15000);
    loadMenu();
    subscribe();
    refreshAuth(false);
    refresh();
    pollTimer = setInterval(function () { refresh(); }, POLL_MS);
  }
  function tick() { setConn(); if (state.started && state.loadedOnce) render(); }

  function onAppVisible() { refreshAuth(false); }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") onAppVisible();
  });
  window.addEventListener("focus", onAppVisible);
  window.addEventListener("offline", function () { setConn(); });
  window.addEventListener("online", function () {
    noteReachOk();
    setConn();
    refreshAuth(true);
    if (state.started) { subscribe(); refresh(); }
  });

  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "TOKEN_REFRESHED" && session) {
      state.session = session;
      if (state.started && !state.live) subscribe();
      return;
    }
    if (event === "SIGNED_IN" && session) {
      if (!state.session) onSession(session);
      else state.session = session;
      return;
    }
    if (event === "SIGNED_OUT") {
      if (hasStoredSession()) { scheduleAuthRetry(); return; }
      state.session = null;
      stopApp();
      show("login");
    }
  });

  requestPersistentStorage();
  sb.auth.getSession().then(function (r) {
    if (r.data && r.data.session) {
      onSession(r.data.session);
      refreshAuth(false);
      return;
    }
    if (isTransientAuthError(r.error) || readStoredAuth()) {
      var stored = readStoredAuth();
      if (stored) {
        onSession(stored);
        scheduleAuthRetry();
        return;
      }
    }
    onSession(null);
  }).catch(function () {
    var stored = readStoredAuth();
    if (stored) { onSession(stored); scheduleAuthRetry(); }
    else onSession(null);
  });
})();
