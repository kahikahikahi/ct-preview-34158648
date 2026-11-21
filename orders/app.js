/* Cafe Turquoise shop tablet: orders, booking requests and sold-out switches.
   Plain JavaScript. Talks to Supabase with the publishable key; what staff can see and change
   is enforced in the database (RLS: logged-in user with app_metadata role "staff"). */
(function () {
  "use strict";

  var SUPABASE_URL = "https://nljzrxvfccxdcltbpava.supabase.co";
  var SUPABASE_KEY = "sb_publishable_aXCPQakkbNccpChsgDGfWw_4XqKNZ2H";
  var TZ = "Pacific/Auckland";
  var POLL_MS = 30000;
  var QUICK_MINUTES = [10, 15, 20, 30, 45];

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "ct-orders-auth" }
  });

  var state = {
    session: null,
    started: false,
    tab: "orders",
    orders: [],
    bookings: [],
    menu: [],
    groups: {},        // option group key -> name
    itemGroups: {},    // menu item id -> [group keys] (display order)
    loadedOnce: false,
    channel: null,
    live: false,
    lastOk: 0,
    seenBookings: loadSeen()
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
  function telHref(p) { return "tel:" + String(p || "").replace(/[^\d+]/g, ""); }
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
    ["login", "denied", "start", "app"].forEach(function (s) { $("screen-" + s).hidden = s !== screen; });
  }

  // ---------- sound (Web Audio, no files) ----------
  var audio = null, master = null;
  function unlockAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audio) {
      audio = new AC();
      var comp = audio.createDynamicsCompressor();
      master = audio.createGain(); master.gain.value = 1;
      master.connect(comp); comp.connect(audio.destination);
    }
    if (audio.state === "suspended") audio.resume();
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
      refresh();
    }
  });

  // ---------- data ----------
  function newOrders() { return state.orders.filter(function (o) { return o.status === "new"; }); }
  function progressOrders() {
    return state.orders.filter(function (o) { return o.status === "accepted" || o.status === "preparing" || o.status === "ready"; })
      .sort(function (a, b) { return new Date(a.ready_at || a.pickup_at || a.created_at) - new Date(b.ready_at || b.pickup_at || b.created_at); });
  }
  function doneOrders() {
    var start = new Date(startOfTodayISO());
    return state.orders.filter(function (o) {
      return (o.status === "collected" || o.status === "cancelled") && new Date(o.created_at) >= start;
    }).sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); });
  }
  function pendingBookings() { return state.bookings.filter(function (b) { return b.status === "pending"; }); }
  function upcomingBookings() { return state.bookings.filter(function (b) { return b.status === "accepted"; }); }
  function unseenBookings() {
    return pendingBookings().filter(function (b) { return state.seenBookings.indexOf(b.id) < 0; });
  }

  var refreshing = null, refreshAgain = false;
  function refresh() {
    if (!state.session) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    var start = startOfTodayISO(), today = todayNZ();
    refreshing = Promise.all([
      sb.from("orders").select("*, order_items(*)")
        .or("status.in.(new,accepted,preparing,ready),created_at.gte." + start)
        .order("created_at", { ascending: true }),
      sb.from("bookings").select("*")
        .or("status.eq.pending,and(status.eq.accepted,booking_date.gte." + today + ")")
        .order("booking_date", { ascending: true }).order("booking_time", { ascending: true })
    ]).then(function (r) {
      if (r[0].error) throw r[0].error;
      if (r[1].error) throw r[1].error;
      state.orders = r[0].data || [];
      state.bookings = r[1].data || [];
      state.loadedOnce = true;
      state.lastOk = Date.now();
      render();
    }).catch(function (e) {
      setConn();
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

  function subscribe() {
    if (state.channel) sb.removeChannel(state.channel);
    state.channel = sb.channel("shop-tablet")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, refreshSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, refreshSoon)
      .subscribe(function (status) {
        state.live = status === "SUBSCRIBED";
        setConn();
        if (state.live) refreshSoon();
      });
  }
  function setConn() {
    var c = $("conn"), fresh = Date.now() - state.lastOk < POLL_MS * 2 + 5000;
    if (state.live && fresh) { c.className = "conn ok"; c.textContent = "Live"; }
    else if (fresh) { c.className = "conn"; c.textContent = "Checking every 30 s"; }
    else { c.className = "conn bad"; c.textContent = "Offline, retrying"; }
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
      return '<div class="it-opt"><b>' + esc(state.groups[k] || k) + ":</b> " + txt + "</div>";
    }).join("");
  }

  function pickupHtml(o) {
    if (o.status !== "new" && o.ready_at) {
      var m = minsFromNow(o.ready_at), rel = "";
      if (o.status !== "ready") rel = m > 0 ? " (in " + m + " min)" : m === 0 ? " (now)" : " (" + (-m) + " min late)";
      return '<div class="pickup">Ready at <span class="when">' + fmtTime(o.ready_at) + "</span>" + rel +
        (o.pickup_type === "later" && fmtTime(o.pickup_at) !== fmtTime(o.ready_at) ? " · customer chose " + fmtTime(o.pickup_at) : "") + "</div>";
    }
    if (o.pickup_type === "later") return '<div class="pickup">Later: <span class="when">' + fmtTime(o.pickup_at) + "</span></div>";
    return '<div class="pickup"><span class="when">As soon as possible</span></div>';
  }

  function payHtml(o) {
    if (o.payment_method === "online") {
      return o.payment_status === "paid" ? '<span class="pay-paid">Paid online</span>'
        : '<span class="pay-unpaid">Online, not paid' + (o.payment_status === "failed" ? " (payment failed)" : "") + "</span>";
    }
    return o.payment_status === "paid" ? '<span class="pay-paid">Paid at counter</span>' : '<span class="pay-unpaid">Pay at counter</span>';
  }

  function orderCard(o) {
    var items = (o.order_items || []).slice().sort(function (a, b) { return a.id - b.id; });
    var head = '<div class="card-head"><span class="ref">' + esc(o.ref) + "</span>" +
      (o.status === "new" ? '<span class="badge badge-new">New</span>' : "") +
      (o.status === "ready" ? '<span class="badge badge-ready">Ready for pickup</span>' : "") +
      '<span class="placed">' + fmtTime(o.created_at) + ", " + ago(o.created_at) + "</span></div>";
    var who = '<div class="who">' + esc(o.customer_name) +
      (o.phone ? '<a href="' + esc(telHref(o.phone)) + '">' + esc(o.phone) + "</a>" : "") + "</div>";
    var list = '<ul class="items">' + items.map(function (it) {
      return '<li><div class="it-name"><span class="it-qty">' + it.qty + "×</span>" + esc(it.name) +
        '<span class="it-price">' + money(it.line_cents) + "</span></div>" + optionLines(it) +
        (it.note ? '<div class="it-note">Note: ' + esc(it.note) + "</div>" : "") + "</li>";
    }).join("") + "</ul>";
    var note = o.notes ? '<div class="order-note">Order note: ' + esc(o.notes) + "</div>" : "";
    var totals = '<div class="totals"><span class="total">' + money(o.total_cents) + "</span>" + payHtml(o) + "</div>";
    var actions = "";
    if (o.status === "new") {
      actions = '<button type="button" class="btn" data-act="decline" data-id="' + o.id + '">Decline</button>' +
        '<button type="button" class="btn btn-go" data-act="accept" data-id="' + o.id + '">Accept</button>';
    } else if (o.status === "accepted" || o.status === "preparing") {
      actions = '<button type="button" class="btn btn-dark" data-act="ready" data-id="' + o.id + '">Ready</button>';
    } else if (o.status === "ready") {
      actions = '<button type="button" class="btn btn-dark" data-act="collected" data-id="' + o.id + '">Picked up</button>';
    }
    return '<article class="card' + (o.status === "new" ? " is-new" : "") + '">' + head + pickupHtml(o) + who + list + note + totals +
      (actions ? '<div class="actions">' + actions + "</div>" : "") + "</article>";
  }

  function bookingCard(b) {
    var head = '<div class="card-head"><span class="ref">' + esc(b.ref) + "</span>" +
      (b.status === "pending" ? '<span class="badge badge-new">Request</span>' : '<span class="badge badge-line">Booked</span>') +
      '<span class="placed">Sent ' + ago(b.created_at) + "</span></div>";
    var when = '<div class="bk-when">' + esc(bookingDate(b.booking_date)) + ", " + bookingTime(b.booking_time) +
      " · " + b.party_size + (b.party_size === 1 ? " person" : " people") + "</div>";
    var who = '<div class="who"><b>' + esc(b.name) + "</b></div>" +
      '<div class="contact">Phone: ' + (b.phone ? '<a href="' + esc(telHref(b.phone)) + '">' + esc(b.phone) + "</a>" : "not given") + "</div>" +
      (b.email ? '<div class="contact">Email: ' + esc(b.email) + "</div>" : "");
    var note = b.notes ? '<div class="order-note">Note: ' + esc(b.notes) + "</div>" : "";
    var actions = b.status === "pending"
      ? '<div class="actions"><button type="button" class="btn" data-act="bk-decline" data-id="' + b.id + '">Decline</button>' +
        '<button type="button" class="btn btn-go" data-act="bk-accept" data-id="' + b.id + '">Accept</button></div>' : "";
    return '<article class="card' + (b.status === "pending" ? " is-new" : "") + '">' + head + when + who + note + actions + "</article>";
  }

  function doneRow(o) {
    var items = (o.order_items || []).map(function (it) { return it.qty + "× " + it.name; }).join(", ");
    var st = o.status === "cancelled" ? '<span class="st-declined">Declined</span>' : "Picked up " + fmtTime(o.updated_at);
    return '<div class="row"><span class="ref">' + esc(o.ref) + "</span><span>" + esc(o.customer_name) + " · " + fmtTime(o.created_at) +
      "</span><span>" + money(o.total_cents) + "</span><span>" + st + '</span><span class="sub">' + esc(items) + "</span></div>";
  }

  function fill(id, arr, fn, emptyText) {
    $(id).innerHTML = arr.length ? arr.map(fn).join("") : '<div class="empty">' + emptyText + "</div>";
  }

  function render() {
    if (state.tab === "bookings") markBookingsSeen();
    var nw = newOrders(), pb = pendingBookings();
    if (state.loadedOnce) {
      fill("list-new", nw, orderCard, "No new orders.");
      fill("list-progress", progressOrders(), orderCard, "Nothing cooking.");
      fill("list-bk-pending", pb, bookingCard, "No booking requests.");
      fill("list-bk-upcoming", upcomingBookings(), bookingCard, "No upcoming bookings.");
      fill("list-done", doneOrders(), doneRow, "No finished orders yet today.");
    }
    var co = $("count-orders"); co.hidden = !nw.length; co.textContent = nw.length;
    var cb = $("count-bookings"); cb.hidden = !pb.length; cb.textContent = pb.length;
    var bar = $("alert-bar"), ub = unseenBookings();
    if (nw.length && state.tab !== "orders") {
      bar.hidden = false; bar.className = "alert-bar"; bar.dataset.go = "orders";
      bar.textContent = (nw.length === 1 ? "New order " + nw[0].ref : nw.length + " new orders") + ". Tap to see.";
    } else if (ub.length && state.tab !== "bookings") {
      bar.hidden = false; bar.className = "alert-bar soft"; bar.dataset.go = "bookings";
      bar.textContent = (ub.length === 1 ? "New booking request" : ub.length + " new booking requests") + ". Tap to see.";
    } else bar.hidden = true;
    document.title = (nw.length ? "(" + nw.length + ") " : "") + "Cafe Turquoise Orders";
    setConn();
    updateRinging();
  }

  function renderMenu() {
    var cats = [], byCat = {};
    state.menu.forEach(function (m) {
      if (!byCat[m.category]) { byCat[m.category] = []; cats.push(m.category); }
      byCat[m.category].push(m);
    });
    $("menu-list").innerHTML = cats.map(function (c) {
      return '<section class="menu-cat"><h2>' + esc(c) + "</h2>" + byCat[c].map(function (m) {
        return '<button type="button" class="menu-row' + (m.active ? "" : " off") + '" data-act="toggle" data-id="' + esc(m.id) +
          '" role="switch" aria-checked="' + (m.active ? "true" : "false") + '"><span class="m-name">' + esc(m.name) + "</span>" +
          (m.active ? "" : '<span class="m-state">Sold out</span>') + '<span class="switch"></span></button>';
      }).join("") + "</section>";
    }).join("");
  }

  function markBookingsSeen() {
    var changed = false;
    pendingBookings().forEach(function (b) {
      if (state.seenBookings.indexOf(b.id) < 0) { state.seenBookings.push(b.id); changed = true; }
    });
    if (changed) saveSeen();
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t.dataset.tab === tab); });
    ["orders", "bookings", "done", "menu"].forEach(function (p) { $("pane-" + p).hidden = p !== tab; });
    if (tab === "menu") loadMenu();
    render();
  }

  // ---------- modal ----------
  function openModal(html) { $("modal-box").innerHTML = html; $("modal").hidden = false; }
  function closeModal() { $("modal").hidden = true; $("modal-box").innerHTML = ""; numpad = null; }
  var numpad = null; // { order, mins: "25", showKeys: bool }

  function openAccept(o) {
    numpad = { order: o, mins: "", showKeys: o.pickup_type !== "later" };
    renderNumpad();
  }
  function renderNumpad() {
    var o = numpad.order, n = parseInt(numpad.mins, 10), ok = n >= 1 && n <= 300;
    var html = "<h3>Accept " + esc(o.ref) + "</h3>";
    if (o.pickup_type === "later" && !numpad.showKeys) {
      html += '<p class="sub">' + esc(o.customer_name) + " chose pickup at <b>" + fmtTime(o.pickup_at) + "</b>.</p>" +
        '<div class="modal-actions"><button type="button" class="btn" data-np="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-go" data-np="later">Accept for ' + fmtTime(o.pickup_at) + "</button></div>" +
        '<button type="button" class="link-btn" data-np="keys">Change time</button>';
      $("modal-box").innerHTML = html; $("modal").hidden = false; return;
    }
    html += '<p class="sub">' + (o.pickup_type === "later" ? "Customer chose " + fmtTime(o.pickup_at) + ". " : "") + "How many minutes until it's ready?</p>";
    html += '<div class="np-display"><span class="np-mins">' + (numpad.mins || "0") + "<small>min</small></span>" +
      '<span class="np-ready">' + (ok ? "Ready at " + fmtTime(new Date(Date.now() + n * 60000)) : "&nbsp;") + "</span></div>";
    html += '<div class="np-quick">' + QUICK_MINUTES.map(function (q) {
      return '<button type="button" class="btn" data-np="set" data-v="' + q + '">' + q + "</button>";
    }).join("") + "</div>";
    html += '<div class="np-keys">' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (k) {
      return '<button type="button" class="btn" data-np="key" data-v="' + k + '">' + k + "</button>";
    }).join("") + '<button type="button" class="btn" data-np="clear">Clear</button>' +
      '<button type="button" class="btn" data-np="key" data-v="0">0</button>' +
      '<button type="button" class="btn" data-np="back" aria-label="Delete">⌫</button></div>';
    html += '<div class="modal-actions"><button type="button" class="btn" data-np="cancel">Cancel</button>' +
      '<button type="button" class="btn btn-go" data-np="ok"' + (ok ? "" : " disabled") + ">" +
      (ok ? "Accept, ready at " + fmtTime(new Date(Date.now() + n * 60000)) : "Accept") + "</button></div>";
    $("modal-box").innerHTML = html; $("modal").hidden = false;
  }

  function numpadClick(btn) {
    var a = btn.dataset.np, v = btn.dataset.v;
    if (a === "cancel") return closeModal();
    if (a === "keys") { numpad.showKeys = true; return renderNumpad(); }
    if (a === "key") { if (numpad.mins.length < 3) numpad.mins = (numpad.mins + v).replace(/^0+/, ""); return renderNumpad(); }
    if (a === "set") { numpad.mins = String(v); return renderNumpad(); }
    if (a === "back") { numpad.mins = numpad.mins.slice(0, -1); return renderNumpad(); }
    if (a === "clear") { numpad.mins = ""; return renderNumpad(); }
    if (a === "ok" || a === "later") {
      var o = numpad.order, mins = a === "later" ? null : parseInt(numpad.mins, 10);
      btn.disabled = true;
      sb.rpc("accept_order", { p_order_id: o.id, p_minutes: mins }).then(function (r) {
        if (r.error) throw r.error;
        var row = r.data && r.data[0];
        closeModal();
        toast(o.ref + " accepted" + (row && row.ready_at ? ", ready at " + fmtTime(row.ready_at) : ""));
        refresh();
      }).catch(function (e) { btn.disabled = false; toast(errMsg(e), true); refresh(); });
    }
  }

  function confirmBox(title, text, yes, onYes) {
    openModal("<h3>" + esc(title) + '</h3><p class="sub">' + esc(text) + "</p>" +
      '<div class="modal-actions"><button type="button" class="btn" data-cf="no">Keep it</button>' +
      '<button type="button" class="btn btn-stop" data-cf="yes">' + esc(yes) + "</button></div>");
    confirmYes = onYes;
  }
  var confirmYes = null;

  // ---------- actions ----------
  function setOrderStatus(o, from, to, okMsg) {
    return sb.from("orders").update({ status: to }).eq("id", o.id).eq("status", from).select("id").then(function (r) {
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error("This order was changed on another screen.");
      toast(okMsg); refresh();
    }).catch(function (e) { toast(errMsg(e), true); refresh(); });
  }
  function setBookingStatus(b, to, okMsg) {
    return sb.from("bookings").update({ status: to }).eq("id", b.id).eq("status", "pending").select("id").then(function (r) {
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error("This booking was changed on another screen.");
      toast(okMsg); refresh();
    }).catch(function (e) { toast(errMsg(e), true); refresh(); });
  }
  function findOrder(id) { return state.orders.filter(function (o) { return o.id === id; })[0]; }
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
    var t = e.target.closest ? e.target.closest("button, [data-act]") : null;
    if (!t) return;
    if (t.dataset.np && numpad) return numpadClick(t);
    if (t.dataset.cf) {
      var fn = confirmYes; confirmYes = null; closeModal();
      if (t.dataset.cf === "yes" && fn) fn();
      return;
    }
    if (t.dataset.tab) return setTab(t.dataset.tab);
    if (t.id === "alert-bar") return setTab(t.dataset.go || "orders");
    if (t.dataset.action === "signout") return signOut();
    var act = t.dataset.act, id = t.dataset.id, o, b;
    if (act === "accept" && (o = findOrder(id))) return openAccept(o);
    if (act === "decline" && (o = findOrder(id))) {
      return confirmBox("Decline " + o.ref + "?", "Please phone " + o.customer_name + (o.phone ? " on " + o.phone : "") + " to let them know.",
        "Yes, decline", function () { setOrderStatus(o, "new", "cancelled", o.ref + " declined"); });
    }
    if (act === "ready" && (o = findOrder(id))) { t.disabled = true; return setOrderStatus(o, o.status, "ready", o.ref + " is ready"); }
    if (act === "collected" && (o = findOrder(id))) { t.disabled = true; return setOrderStatus(o, "ready", "collected", o.ref + " picked up"); }
    if (act === "bk-accept" && (b = findBooking(id))) { t.disabled = true; return setBookingStatus(b, "accepted", b.ref + " accepted"); }
    if (act === "bk-decline" && (b = findBooking(id))) {
      return confirmBox("Decline " + b.ref + "?", "Please phone " + b.name + " on " + b.phone + " to let them know.",
        "Yes, decline", function () { setBookingStatus(b, "declined", b.ref + " declined"); });
    }
    if (act === "toggle") return toggleItem(t);
  });
  $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) closeModal(); });

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

  function signOut() {
    stopApp();
    sb.auth.signOut().finally(function () { state.session = null; show("login"); });
  }

  var pollTimer = null, clockTimer = null;
  function stopApp() {
    state.started = false;
    clearInterval(pollTimer); clearInterval(clockTimer); updateRinging();
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }

  function onSession(session) {
    state.session = session;
    if (!session) { stopApp(); return show("login"); }
    if (!isStaff(session)) {
      // role may have just been added: refresh the token once before saying no
      return sb.auth.refreshSession().then(function (r) {
        var s = r.data && r.data.session;
        if (isStaff(s)) { state.session = s; show(state.started ? "app" : "start"); }
        else show("denied");
      });
    }
    show(state.started ? "app" : "start");
  }

  $("start-btn").addEventListener("click", function () {
    unlockAudio();
    requestWakeLock();
    state.started = true;
    show("app");
    setTab(state.tab);
    tick(); clockTimer = setInterval(tick, 15000);
    loadMenu();
    subscribe();
    refresh();
    pollTimer = setInterval(function () { refresh(); }, POLL_MS);
  });
  function tick() { $("clock").textContent = fmtTime(new Date()); setConn(); }

  window.addEventListener("online", function () { if (state.started) { subscribe(); refresh(); } });

  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "SIGNED_OUT") { state.session = null; stopApp(); show("login"); }
    else if (event === "TOKEN_REFRESHED" && session) state.session = session;
  });
  sb.auth.getSession().then(function (r) { onSession(r.data.session); });
})();
