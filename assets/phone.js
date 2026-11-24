/* Phone helpers for Café Turquoise. Uses libphonenumber-js (min metadata).
   Default country is NZ: local numbers are parsed as New Zealand;
   numbers starting with + are validated for that country. */
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
  root.ctParsePhone = function (raw) {
    var ph = parse(raw);
    if (!ph || typeof ph.isValid !== "function" || !ph.isValid()) return null;
    return ph.number;
  };
  root.ctFormatPhone = function (raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    var ph = parse(s);
    if (!ph || typeof ph.isValid !== "function" || !ph.isValid()) return s;
    if (ph.country === "NZ" && typeof ph.formatNational === "function") return ph.formatNational();
    if (typeof ph.formatInternational === "function") return ph.formatInternational();
    return ph.number || s;
  };
})(typeof window !== "undefined" ? window : this);
