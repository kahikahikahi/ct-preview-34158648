/* Phone helpers for Café Turquoise. Uses libphonenumber-js (min metadata).
   Default country is NZ: local numbers are parsed as New Zealand;
   numbers starting with + are validated for that country.
   Min metadata can lag on newer ranges (NZ 020). If the library rejects a
   well-formed 020/021/022/027/028/029 or NZ landline, a tight fallback still
   accepts it. Spaces, dashes, and +64 forms are normalised. */
(function (root) {
  function lib() {
    return root.libphonenumber || null;
  }
  function parse(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    var L = lib();
    var fn = L && (L.parsePhoneNumberFromString || L.parsePhoneNumber);
    if (!fn) return null;
    try {
      return fn(s, "NZ") || null;
    } catch (err) {
      return null;
    }
  }
  /* NZ mobile NSN 8–10: 2 + 0/1/2/7/8/9 + 6–8 digits (8–9 digits after 02, plus
     shorter historic 021). Landline: area 3,4,6,7,9 + 7-digit local. */
  function nzFallback(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    var n = s.replace(/[ \t\-\.\(\)]/g, "");
    if (/^00[1-9]/.test(n)) n = "+" + n.slice(2);
    var rest = null;
    if (/^\+64/.test(n)) rest = n.slice(3);
    else if (/^64[2-9]/.test(n)) rest = n.slice(2);
    else if (/^0[2-9]/.test(n)) rest = n.slice(1);
    else if (/^2[012789]\d{6,8}$/.test(n) || /^[34679]\d{7}$/.test(n)) rest = n;
    if (!rest) return null;
    if (!/^(2[012789]\d{6,8}|[34679]\d{7})$/.test(rest)) return null;
    return "+64" + rest;
  }
  root.ctParsePhone = function (raw) {
    var ph = parse(raw);
    if (ph && typeof ph.isValid === "function" && ph.isValid() && ph.number) {
      if (ph.number.indexOf("+642") === 0 && !/^\+642[012789]\d{6,8}$/.test(ph.number)) return null;
      return ph.number;
    }
    return nzFallback(raw);
  };
  root.ctFormatPhone = function (raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    var ph = parse(s);
    if (ph && typeof ph.isValid === "function" && ph.isValid()) {
      if (ph.country === "NZ" && typeof ph.formatNational === "function") return ph.formatNational();
      if (typeof ph.formatInternational === "function") return ph.formatInternational();
      return ph.number || s;
    }
    var e164 = nzFallback(s);
    if (!e164) return s;
    if (e164.indexOf("+64") === 0) {
      var rest = e164.slice(3);
      if (rest.charAt(0) === "2") return "0" + rest;
      return "0" + rest.charAt(0) + " " + rest.slice(1, 4) + " " + rest.slice(4);
    }
    return e164;
  };
  root.ctRevealField = function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    try {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (err) {
      el.scrollIntoView(true);
    }
    try {
      el.focus({ preventScroll: true });
    } catch (err2) {
      try { el.focus(); } catch (err3) {}
    }
  };
})(typeof window !== "undefined" ? window : this);
