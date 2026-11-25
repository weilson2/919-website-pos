const modeNames = { order: "Order Only", cashier: "Cashier", admin: "Admin" };
let selectedMode = "cashier";
let adminPasswordRequired = false;

const pinInput = document.getElementById("loginPin");
const errorLabel = document.getElementById("loginError");
const loginButton = document.getElementById("loginButton");
const adminPassword = document.getElementById("adminPassword");

function updateAdminPasswordField() {
  document.getElementById("adminPasswordGroup").hidden = !(selectedMode === "admin" && adminPasswordRequired);
}

function setMode(mode) {
  selectedMode = mode;
  document.querySelectorAll("[data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
  document.getElementById("selectedModeLabel").textContent = `${modeNames[mode].toUpperCase()} WORKSPACE`;
  loginButton.textContent = `Open ${modeNames[mode]}`;
  errorLabel.textContent = "";
  updateAdminPasswordField();
  pinInput.focus();
}

async function login() {
  const pin = pinInput.value.trim();
  if (!pin) { errorLabel.textContent = "Enter your staff PIN."; pinInput.focus(); return; }
  loginButton.disabled = true;
  loginButton.textContent = "Checking…";
  errorLabel.textContent = "";
  try {
    if (selectedMode === "admin" && adminPasswordRequired && !adminPassword.value) {
      errorLabel.textContent = "Enter the Admin password.";
      adminPassword.focus();
      loginButton.disabled = false;
      loginButton.textContent = `Open ${modeNames[selectedMode]}`;
      return;
    }
    const result = await POSAuth.api("/api/auth/login", { method: "POST", body: JSON.stringify({ pin, mode: selectedMode, password: adminPassword.value }) });
    POSAuth.save(result.token, result.session);
    window.location.href = selectedMode === "admin" ? "/admin" : "/pos";
  } catch (error) {
    pinInput.value = "";
    adminPassword.value = "";
    errorLabel.textContent = error.message;
    pinInput.focus();
    loginButton.disabled = false;
    loginButton.textContent = `Open ${modeNames[selectedMode]}`;
  }
}

document.querySelectorAll("[data-mode]").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
pinInput.addEventListener("input", () => { pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 8); errorLabel.textContent = ""; });
pinInput.addEventListener("keydown", event => { if (event.key === "Enter") login(); });
adminPassword.addEventListener("keydown", event => { if (event.key === "Enter") login(); });
adminPassword.addEventListener("input", () => { errorLabel.textContent = ""; });
loginButton.addEventListener("click", login);
document.querySelectorAll("[data-digit]").forEach(button => button.addEventListener("click", () => { if (pinInput.value.length < 8) pinInput.value += button.dataset.digit; pinInput.focus(); }));
document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => { pinInput.value = button.dataset.action === "clear" ? "" : pinInput.value.slice(0, -1); errorLabel.textContent = ""; pinInput.focus(); }));

(async () => {
  try {
    const status = await POSAuth.api("/api/public/status");
    adminPasswordRequired = Boolean(status.admin_password_required);
    updateAdminPasswordField();
    document.getElementById("loginShopName").textContent = status.shop_name || "919 Restaurant";
    document.title = `${status.shop_name || "919 Restaurant"} · Choose Workspace`;
    document.getElementById("databaseLabel").textContent = `${status.database} · local system`;
    document.getElementById("loginBusinessDate").textContent = new Date(`${status.business_date}T12:00:00`).toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
  } catch (error) {
    document.getElementById("databaseLabel").textContent = "Database connection unavailable";
    errorLabel.textContent = error.message;
  }
  const existing = POSAuth.session();
  if (existing?.mode) setMode(existing.mode);
  pinInput.focus();
})();
