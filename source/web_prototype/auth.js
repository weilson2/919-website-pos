(function () {
  const TOKEN_KEY = "919_pos_session_token";
  const SESSION_KEY = "919_pos_session";

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  function session() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); }
    catch (_) { return null; }
  }

  function save(authToken, sessionData) {
    sessionStorage.setItem(TOKEN_KEY, authToken);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
  }

  function update(sessionData) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
  }

  function clear() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    const response = await fetch(path, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (response.status === 401 && path !== "/api/auth/login") {
      clear();
      window.location.href = "/?reason=session-expired";
      throw new Error("Session expired");
    }
    if (!response.ok) {
      const error = new Error(payload?.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function requireSession(allowedModes) {
    if (!token()) {
      window.location.replace("/");
      return null;
    }
    try {
      const result = await api("/api/auth/me");
      update(result.session);
      if (allowedModes && !allowedModes.includes(result.session.mode)) {
        window.location.replace(result.session.mode === "admin" ? "/admin" : "/pos");
        return null;
      }
      return result.session;
    } catch (_) {
      return null;
    }
  }

  async function switchMode(mode) {
    const result = await api("/api/auth/switch-mode", { method: "POST", body: JSON.stringify({ mode }) });
    update(result.session);
    window.location.href = mode === "admin" ? "/admin" : "/pos";
  }

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); }
    catch (_) { /* The local session still needs clearing. */ }
    clear();
    window.location.href = "/";
  }

  window.POSAuth = { api, clear, logout, requireSession, save, session, switchMode, token, update };
})();
