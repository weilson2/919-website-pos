const adminUrlParams = new URLSearchParams(window.location.search);
const adminEmbeddedMode = adminUrlParams.get("embed") === "1";
document.body.classList.toggle("embedded-mode", adminEmbeddedMode);

const adminState = {
  session: null,
  currency: "RM",
  page: "overview",
  businessDate: "",
  accountingFrom: "",
  accountingTo: "",
  accountingType: "",
  accountingSearch: "",
  cashDate: "",
  cashTab: "summary",
  rentFrom: "",
  rentTo: "",
  stockSearch: "",
  payrollMonth: "",
  payrollTab: "slips",
  staffRows: []
};

const pageMeta = {
  overview: ["ADMIN CONTROL CENTER", "Business overview", "Live control of today’s shop activity and management modules."],
  accounting: ["ACCOUNTING & PROFIT", "Accounting ledger", "Sales, refunds, income, expenses, payment mix, and profit in one reconciled view."],
  cash: ["PHYSICAL CASH CONTROL", "Cash center", "Opening float, cash entries, expected cash, actual count, and day closing."],
  rent: ["STALL RENTAL", "Rent and stalls", "Tenant status, collection, payment history, and void controls."],
  stock: ["INVENTORY CONTROL", "Stock and items", "Current stock, item settings, manual adjustments, and movement history."],
  sales: ["SALES CONTROL", "Sales and refunds", "Receipt history, payment methods, order details, and refunds."],
  payroll: ["PAYROLL", "Payroll and salary slips", "Employees, earnings, statutory deductions, salary payments, and printable payslips."],
  reports: ["REPORTING", "Reports and exports", "Daily performance, accountant workbook, stock movement, and rental exports."],
  staff: ["ACCESS CONTROL", "Staff and permissions", "Clearly assign Order Only, Cashier, or Remote Admin access."],
  setup: ["SHOP SETUP", "Menu and tables", "Product categories, dining tables, and operational configuration."],
  system: ["SYSTEM CONTROL", "System and audit", "Active database, backups, integrity, settings, and immutable activity history."]
};

const workspacePages = {
  admin: Object.keys(pageMeta),
  cashier: ["cash", "rent", "stock"]
};

const content = document.getElementById("adminContent");
const modal = document.getElementById("adminModal");
const modalBody = document.getElementById("adminModalBody");

const money = value => `${adminState.currency || "RM"} ${Number(value || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const initials = name => String(name || "ST").split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase();
const modeName = mode => ({ order: "Order Only", cashier: "Cashier", admin: "Admin" })[mode] || "Cashier";
const isoToday = () => adminState.businessDate || new Date().toISOString().slice(0, 10);
const monthStart = value => `${value.slice(0, 8)}01`;
const fieldValue = (form, name) => form.elements[name]?.value?.trim() ?? "";

function itemImageFields(row = null) {
  const current = row?.image_path
    ? `<img src="${escapeHtml(row.image_path)}" alt="${escapeHtml(row.name)}">`
    : `<span>PHOTO</span>`;
  return `<div class="form-field full item-photo-field"><span>Item photo (optional)</span><div class="item-photo-upload"><div class="item-photo-preview" id="itemPhotoPreview">${current}</div><div class="item-photo-controls"><input name="image_file" type="file" accept="image/jpeg,image/png,image/webp"><small>Choose a phone or computer photo. It will be resized automatically for fast item cards.</small>${row?.image_path?'<label class="checkbox-field"><input name="remove_image" type="checkbox"><span>Remove the current photo</span></label>':""}</div></div></div>`;
}

function bindItemImagePreview() {
  const input = document.querySelector('#adminActionForm input[name="image_file"]');
  const preview = document.getElementById("itemPhotoPreview");
  if (!input || !preview) return;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    preview.innerHTML = `<img src="${url}" alt="Selected item preview">`;
    preview.querySelector("img").addEventListener("load", () => URL.revokeObjectURL(url), { once:true });
  });
}

async function itemImageData(form) {
  const file = form.elements.image_file?.files?.[0];
  if (!file) return "";
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 20_000_000) throw new Error("Choose a photo smaller than 20 MB.");
  const bitmap = await createImageBitmap(file, { imageOrientation:"from-image" });
  const scale = Math.min(1, 900 / bitmap.width, 900 / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", .84);
}

function showToast(message, isError = false) {
  const toast = document.getElementById("adminToast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function loading(label = "Loading live database data…") {
  content.innerHTML = `<div class="page-loading"><span></span><p>${escapeHtml(label)}</p></div>`;
}

function pageError(error) {
  content.innerHTML = `<div class="content-card"><div class="empty-state"><strong>Unable to load this module</strong><p>${escapeHtml(error.message)}</p><button class="button secondary" id="retryPage" type="button">Try again</button></div></div>`;
  document.getElementById("retryPage")?.addEventListener("click", () => loadPage(adminState.page));
}

function kpiCard(label, value, note, tone = "", icon = "RM") {
  return `<article class="kpi-card ${tone}"><div class="kpi-head"><span>${escapeHtml(label)}</span><b class="kpi-icon">${escapeHtml(icon)}</b></div><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
}

function statusPill(label, tone) {
  return `<span class="status-pill ${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function openModal({ eyebrow = "ADMIN ACTION", title, body, onSubmit, submitLabel = "Save", submitClass = "primary", wide = false }) {
  modal.classList.toggle("wide", wide);
  document.getElementById("adminModalEyebrow").textContent = eyebrow;
  document.getElementById("adminModalTitle").textContent = title;
  modalBody.innerHTML = `<form id="adminActionForm">${body}<div class="dialog-actions"><button class="button secondary" type="button" data-modal-cancel>Cancel</button><button class="button ${submitClass}" type="submit">${escapeHtml(submitLabel)}</button></div></form>`;
  modalBody.querySelector("[data-modal-cancel]").addEventListener("click", () => modal.close());
  modalBody.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = "Saving…";
    try {
      await onSubmit(event.currentTarget);
      modal.close();
    } catch (error) {
      showToast(error.message, true);
      submit.disabled = false;
      submit.textContent = original;
    }
  });
  modal.showModal();
  setTimeout(() => modalBody.querySelector("input,select,textarea")?.focus(), 0);
}

function correctionRequestKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID().replaceAll("-", "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

async function openItemOptionsManager(itemRow) {
  modal.classList.add("wide");
  document.getElementById("adminModalEyebrow").textContent = "MENU OPTIONS";
  document.getElementById("adminModalTitle").textContent = `${itemRow.name} · variants and sets`;
  modalBody.innerHTML = '<div class="page-loading option-manager-loading"><span></span><p>Loading item options…</p></div>';
  if (!modal.open) modal.showModal();
  try {
    const data = await POSAuth.api(`/api/stock/items/${itemRow.id}/options`);
    const basePrice = Number(data.item.price || 0);
    const variantRows = data.variants.map(row => `<article class="option-editor-row" data-variant-row="${row.id}">
      <label class="option-field grow"><span>Variant name</span><input data-option-name value="${escapeHtml(row.variant_name)}" maxlength="60"></label>
      <label class="option-field"><span>Price adjustment</span><input data-option-adjustment type="number" step="0.01" value="${Number(row.price_adjustment).toFixed(2)}"></label>
      <span class="option-final-price"><small>FINAL PRICE</small><b data-final-price>${money(row.final_price)}</b></span>
      <div class="option-row-actions"><button class="button small secondary" data-save-variant="${row.id}" type="button">Save</button><button class="button small danger" data-delete-variant="${row.id}" type="button">Delete</button></div>
    </article>`).join("") || '<div class="option-empty">No variants yet. Add every selectable choice, including the regular option.</div>';
    const setRows = data.quantity_sets.map(row => `<article class="option-editor-row set-row" data-set-row="${row.id}">
      <label class="option-field"><span>Units in set</span><input data-set-quantity type="number" min="2" max="999" step="1" value="${Number(row.quantity)}"></label>
      <label class="option-field"><span>Set price</span><input data-set-price type="number" min="0.01" step="0.01" value="${Number(row.set_price).toFixed(2)}"></label>
      <span class="option-final-price"><small>CUSTOMER PAYS</small><b>${money(row.set_price)}</b></span>
      <div class="option-row-actions"><button class="button small secondary" data-save-set="${row.id}" type="button">Save</button><button class="button small danger" data-delete-set="${row.id}" type="button">Delete</button></div>
    </article>`).join("") || '<div class="option-empty">No quantity sets yet. Singles continue to use the normal item price.</div>';
    modalBody.innerHTML = `<div class="option-manager-intro"><span>BASE</span><div><strong>${escapeHtml(data.item.name)} · ${money(basePrice)}</strong><small>Variants use base price plus an adjustment. Quantity sets use one fixed selling price and deduct the full set quantity from tracked stock.</small></div></div>
      <div class="option-manager-grid">
        <section class="option-manager-card"><header><div><h3>Variants</h3><p>Examples: Hot +0.00, Ice +0.50, Large +1.00</p></div><span>${data.variants.length}</span></header><div class="option-list">${variantRows}</div>
          <div class="option-add-row"><label class="option-field grow"><span>New variant</span><input id="newVariantName" maxlength="60" placeholder="Example: Ice"></label><label class="option-field"><span>Adjustment</span><input id="newVariantAdjustment" type="number" step="0.01" value="0.00"></label><button class="button green" id="addItemVariant" type="button">＋ Add</button></div>
        </section>
        <section class="option-manager-card"><header><div><h3>Quantity sets</h3><p>Examples: 6 bottles or carton of 24</p></div><span>${data.quantity_sets.length}</span></header><div class="option-list">${setRows}</div>
          <div class="option-add-row"><label class="option-field"><span>Set quantity</span><input id="newSetQuantity" type="number" min="2" max="999" step="1" placeholder="24"></label><label class="option-field"><span>Fixed set price</span><input id="newSetPrice" type="number" min="0.01" step="0.01" placeholder="238.00"></label><button class="button green" id="addItemSet" type="button">＋ Add</button></div>
        </section>
      </div>
      <div class="option-manager-note"><b>How it appears in POS</b><span>The item card shows OPTIONS. Cashiers must choose a variant or set before adding it. Paid receipt history keeps the selected name and price even if the catalog changes later.</span></div>
      <div class="dialog-actions"><button class="button primary" id="closeItemOptions" type="button">Done</button></div>`;

    const runAction = async (button, task, success) => {
      const original = button.textContent; button.disabled = true; button.textContent = "Saving…";
      try { await task(); showToast(success); await openItemOptionsManager(itemRow); }
      catch (error) { showToast(error.message, true); if (button.isConnected) { button.disabled = false; button.textContent = original; } }
    };
    document.getElementById("closeItemOptions").addEventListener("click", () => modal.close());
    document.getElementById("addItemVariant").addEventListener("click", event => runAction(event.currentTarget, () => POSAuth.api(`/api/stock/items/${itemRow.id}/options`, {method:"POST",body:JSON.stringify({type:"variant",name:document.getElementById("newVariantName").value,price_adjustment:Number(document.getElementById("newVariantAdjustment").value)})}), "Variant added"));
    document.getElementById("addItemSet").addEventListener("click", event => runAction(event.currentTarget, () => POSAuth.api(`/api/stock/items/${itemRow.id}/options`, {method:"POST",body:JSON.stringify({type:"set",quantity:Number(document.getElementById("newSetQuantity").value),set_price:Number(document.getElementById("newSetPrice").value)})}), "Quantity set added"));
    modalBody.querySelectorAll("[data-option-adjustment]").forEach(input => input.addEventListener("input", () => {
      const output = input.closest("[data-variant-row]").querySelector("[data-final-price]");
      output.textContent = money(basePrice + Number(input.value || 0));
    }));
    modalBody.querySelectorAll("[data-save-variant]").forEach(button => button.addEventListener("click", () => { const row=button.closest("[data-variant-row]");runAction(button,()=>POSAuth.api(`/api/stock/variants/${button.dataset.saveVariant}`,{method:"PUT",body:JSON.stringify({name:row.querySelector("[data-option-name]").value,price_adjustment:Number(row.querySelector("[data-option-adjustment]").value)})}),"Variant updated"); }));
    modalBody.querySelectorAll("[data-delete-variant]").forEach(button => button.addEventListener("click", () => { const row=button.closest("[data-variant-row]"),name=row.querySelector("[data-option-name]").value;if(window.confirm(`Delete variant “${name}”? Historical paid receipts will remain unchanged.`))runAction(button,()=>POSAuth.api(`/api/stock/variants/${button.dataset.deleteVariant}`,{method:"DELETE",body:"{}"}),"Variant deleted"); }));
    modalBody.querySelectorAll("[data-save-set]").forEach(button => button.addEventListener("click", () => { const row=button.closest("[data-set-row]");runAction(button,()=>POSAuth.api(`/api/stock/sets/${button.dataset.saveSet}`,{method:"PUT",body:JSON.stringify({quantity:Number(row.querySelector("[data-set-quantity]").value),set_price:Number(row.querySelector("[data-set-price]").value)})}),"Quantity set updated"); }));
    modalBody.querySelectorAll("[data-delete-set]").forEach(button => button.addEventListener("click", () => { const row=button.closest("[data-set-row]"),quantity=row.querySelector("[data-set-quantity]").value;if(window.confirm(`Delete the set of ${quantity}? Historical paid receipts will remain unchanged.`))runAction(button,()=>POSAuth.api(`/api/stock/sets/${button.dataset.deleteSet}`,{method:"DELETE",body:"{}"}),"Quantity set deleted"); }));
  } catch (error) {
    modalBody.innerHTML = `<div class="empty-state"><strong>Unable to load item options</strong><p>${escapeHtml(error.message)}</p><button class="button secondary" id="retryItemOptions" type="button">Try again</button></div>`;
    document.getElementById("retryItemOptions").addEventListener("click", () => openItemOptionsManager(itemRow));
  }
}

async function downloadExport(path) {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${POSAuth.token()}` } });
  if (!response.ok) {
    let message = `Export failed (${response.status})`;
    try { message = (await response.json()).error || message; } catch (_) { /* no JSON */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "919-export.xlsx";
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
  showToast(`${filename} created`);
}

function setPageHeader(page) {
  const [eyebrow, title, description] = pageMeta[page];
  document.getElementById("pageEyebrow").textContent = eyebrow;
  document.getElementById("pageTitle").textContent = title;
  document.getElementById("pageDescription").textContent = description;
  document.querySelectorAll("[data-admin-page]").forEach(button => button.classList.toggle("active", button.dataset.adminPage === page));
}

async function loadOverview() {
  const data = await POSAuth.api("/api/admin/overview");
  const counts = data.counts; const cash = data.today_cash; const month = data.month;
  content.innerHTML = `
    <div class="page-toolbar"><div class="toolbar-copy"><h2>Today at a glance</h2><p>Business date ${escapeHtml(data.business_date)} · figures read directly from pos.db</p></div><div class="toolbar-actions"><button class="button secondary" data-refresh type="button">↻ Refresh</button><button class="button primary" data-go="accounting" type="button">Open Accounting</button></div></div>
    <div class="kpi-grid">
      ${kpiCard("Today net sales", money(cash.net_sales), `${counts.unpaid_orders} unpaid table orders`, "green", "SALE")}
      ${kpiCard("Expected cash", money(cash.expected_cash), `Opening ${money(cash.opening_cash)}`, "amber", "CASH")}
      ${kpiCard("Month net profit", money(month.net_profit), `${month.date_from} to ${month.date_to}`, month.net_profit >= 0 ? "purple" : "red", "P&L")}
      ${kpiCard("Needs attention", String(counts.low_stock + counts.overdue_tenants), `${counts.low_stock} stock · ${counts.overdue_tenants} rent`, "red", "!")}
    </div>
    <div class="content-grid">
      <section class="content-card"><div class="card-header"><div><h3>Management modules</h3><p>Every function from the Python Admin Panel is grouped by business task.</p></div></div><div class="card-body"><div class="module-grid">
        ${[
          ["accounting","RM","Accounting & profit","Ledger, totals, categories","#7052aa"],
          ["cash","▣","Cash center","Opening, entries, closing","#d98a1c"],
          ["rent","▤","Rent & stalls","Tenants, collect, void","#1e8a5b"],
          ["stock","□","Stock & items","Adjustments and products","#316bc6"],
          ["sales","▥","Sales & refunds","Receipts and corrections","#ca3d46"],
          ["payroll","PAY","Payroll & salary slips","Employees, pay and printing","#1e8a5b"],
          ["reports","↗","Reports & exports","Daily and accountant files","#314866"],
          ["staff","♙","Staff & access","Roles and staff PINs","#7052aa"],
          ["setup","⚙","Menu & tables","Categories and table setup","#1e8a5b"],
          ["system","✓","System & audit","Backup and integrity","#ca3d46"]
        ].map(([page,icon,title,note,color]) => `<button class="module-card" style="--tone:${color}" data-go="${page}" type="button"><span>${icon}</span><strong>${title}</strong><small>${note}</small></button>`).join("")}
      </div></div></section>
      <div>
        <section class="content-card"><div class="card-header"><div><h3>Operational status</h3><p>Live counts</p></div></div><div class="card-body metric-list">
          <div class="metric-row"><span><strong>Active products</strong><small>Menu items available</small></span><b>${counts.active_items}</b></div>
          <div class="metric-row"><span><strong>Active staff</strong><small>Can log into a workspace</small></span><b>${counts.active_staff}</b></div>
          <div class="metric-row"><span><strong>Tracked low stock</strong><small>At or below reorder level</small></span><b>${counts.low_stock}</b></div>
          <div class="metric-row"><span><strong>Overdue tenants</strong><small>Including no payment yet</small></span><b>${counts.overdue_tenants}</b></div>
        </div></section>
        <section class="content-card" style="margin-top:12px"><div class="card-header"><div><h3>Recent system activity</h3><p>Newest audit entries</p></div></div><div class="card-body audit-list">
          ${data.recent_audit.map(row => `<div class="audit-row"><span>${escapeHtml(row.action.slice(0,2))}</span><span><strong>${escapeHtml(row.action)}</strong><small>${escapeHtml(row.details)}</small></span><time>${escapeHtml(row.user)}</time></div>`).join("") || '<div class="empty-state">No audit records</div>'}
        </div></section>
      </div>
    </div>`;
  content.querySelector("[data-refresh]").addEventListener("click", () => loadPage("overview"));
  content.querySelectorAll("[data-go]").forEach(button => button.addEventListener("click", () => loadPage(button.dataset.go)));
}

async function loadAccounting() {
  adminState.accountingFrom ||= monthStart(isoToday()); adminState.accountingTo ||= isoToday();
  const params = new URLSearchParams({
    from: adminState.accountingFrom,
    to: adminState.accountingTo,
    type: adminState.accountingType,
    search: adminState.accountingSearch
  });
  const [summary, transactions, categories, foc] = await Promise.all([
    POSAuth.api(`/api/accounting/summary?${params}`),
    POSAuth.api(`/api/accounting/transactions?${params}`),
    POSAuth.api("/api/accounting/categories"),
    POSAuth.api(`/api/accounting/foc?${params}`)
  ]);
  content.innerHTML = `
    <div class="page-toolbar"><div class="toolbar-copy"><h2>Profit center and financial ledger</h2><p>Refunds are separated from operating expenses to prevent double counting.</p></div><div class="toolbar-actions"><button class="button green" id="addLedgerRow" type="button">＋ Add transaction</button><button class="button secondary" id="manageFlowCategories" type="button">Categories</button><button class="button primary" id="accountantExport" type="button">Export accountant XLSX</button></div></div>
    <div class="filter-bar"><label class="filter-field"><span>FROM</span><input id="accountingFrom" type="date" value="${summary.date_from}"></label><label class="filter-field"><span>TO</span><input id="accountingTo" type="date" value="${summary.date_to}"></label><label class="filter-field"><span>TYPE</span><select id="accountingType"><option value="" ${adminState.accountingType ? "" : "selected"}>All</option><option ${adminState.accountingType === "Income" ? "selected" : ""}>Income</option><option ${adminState.accountingType === "Expense" ? "selected" : ""}>Expense</option></select></label><label class="filter-field search"><span>SEARCH LEDGER</span><input id="accountingSearch" type="search" value="${escapeHtml(adminState.accountingSearch)}" placeholder="Source, supplier, notes, staff…"></label><button class="button blue" id="applyAccountingFilter" type="button">Apply</button></div>
    <div class="kpi-grid">${kpiCard("Net sales", money(summary.net_sales), `Gross ${money(summary.gross_sales)} · Refunds ${money(summary.refunds)}`, "green", "SALE")}${kpiCard("Other income", money(summary.other_income), `Total income ${money(summary.total_income)}`, "purple", "+")}${kpiCard("Operating expenses", money(summary.operating_expenses), "Refunds excluded", "red", "−")}${kpiCard("Net profit", money(summary.net_profit), `${summary.ledger_rows} ledger entries`, summary.net_profit >= 0 ? "amber" : "red", "P&L")}${kpiCard("FOC replacements", `${summary.foc_units} items`, `${money(summary.foc_retail_value)} normal retail · not revenue`, "amber", "FOC")}</div>
    <div class="content-grid">
      <section class="content-card"><div class="card-header"><div><h3>Unified cashflow ledger</h3><p>Income and expense transactions for the selected period</p></div><span class="status-pill info">${transactions.count} rows</span></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Type</th><th>Source</th><th>Supplier / Ref</th><th>Payment</th><th>Staff</th><th>Notes</th><th style="text-align:right">Amount</th><th></th></tr></thead><tbody>
        ${transactions.rows.map(row => `<tr><td>${escapeHtml(row.date)}</td><td>${statusPill(row.type,row.type.toLowerCase())}</td><td class="cell-title"><strong>${escapeHtml(row.source)}</strong><small>#${row.id}${row.reference_id ? ` · Ref ${row.reference_id}` : ""}</small></td><td>${escapeHtml(row.supplier || "—")}</td><td>${escapeHtml(row.payment_method || "—")}</td><td>${escapeHtml(row.recorded_by || "—")}</td><td>${escapeHtml(row.notes || "—")}</td><td class="money">${money(row.amount)}</td><td class="actions"><button class="button small secondary" data-edit-ledger="${row.id}" type="button">Edit</button></td></tr>`).join("") || '<tr><td colspan="9" class="empty-state">No transactions in this period</td></tr>'}
      </tbody></table></div></div></section>
      <aside class="content-card"><div class="card-header"><div><h3>Payment breakdown</h3><p>Net sales after refunds</p></div></div><div class="card-body metric-list"><div class="metric-row"><span><strong>Cash</strong><small>Physical payment</small></span><b>${money(summary.cash_sales)}</b></div><div class="metric-row"><span><strong>QR</strong><small>Digital payment</small></span><b>${money(summary.qr_sales)}</b></div><div class="metric-row"><span><strong>Card</strong><small>Card terminal</small></span><b>${money(summary.card_sales)}</b></div><div class="metric-row"><span><strong>Total net sales</strong><small>All methods</small></span><b>${money(summary.net_sales)}</b></div></div></aside>
    </div>
    <section class="content-card" style="margin-top:12px"><div class="card-header"><div><h3>FOC replacement register</h3><p>Zero-charge replacements are excluded from sales and cashflow. Stock is deducted separately; normal retail value is shown only for management review.</p></div><span class="status-pill warning">${foc.units} items · ${money(foc.normal_value)}</span></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Business date</th><th>Sale / Table</th><th>Item</th><th>Qty</th><th>Stock qty</th><th>Reason</th><th>Authorized by</th><th style="text-align:right">Normal retail</th></tr></thead><tbody>${foc.rows.map(row => `<tr><td>${escapeHtml(row.business_date)}<br><small>${escapeHtml(row.datetime)}</small></td><td class="cell-title"><strong>#${row.sale_id}</strong><small>Table ${escapeHtml(row.table_code || "—")} · Order #${row.order_id || "—"}</small></td><td class="cell-title"><strong>${escapeHtml(row.display_name)}</strong><small>${escapeHtml(row.category || "—")}</small></td><td>${row.quantity}</td><td>${row.stock_quantity}</td><td>${escapeHtml(row.reason)}</td><td class="cell-title"><strong>${escapeHtml(row.authorized_by)}</strong><small>Ordered by ${escapeHtml(row.ordered_by || "—")}</small></td><td class="money">${money(row.normal_value)}</td></tr>`).join("") || '<tr><td colspan="8" class="empty-state">No FOC replacements in this period</td></tr>'}</tbody></table></div></div></section>`;

  const openTransactionForm = (row = null) => {
    const type = row?.type || "Expense";
    const categoryOptions = categories.rows.map(cat => `<option data-type="${cat.type}" value="${escapeHtml(cat.name)}" ${cat.name === row?.source ? "selected" : ""}>${escapeHtml(cat.name)} · ${cat.type}</option>`).join("");
    openModal({ title: row ? `Edit ledger #${row.id}` : "Add income or expense", eyebrow: "UNIFIED CASHFLOW", submitLabel: row ? "Update transaction" : "Save transaction", body: `<div class="form-grid">
      <label class="form-field"><span>Type</span><select name="type"><option ${type === "Expense" ? "selected" : ""}>Expense</option><option ${type === "Income" ? "selected" : ""}>Income</option></select></label>
      <label class="form-field"><span>Category / Source</span><select name="source">${categoryOptions}</select></label>
      <label class="form-field"><span>Amount (RM)</span><input name="amount" type="number" min="0.01" step="0.01" value="${row?.amount ?? ""}" required></label>
      <label class="form-field"><span>Payment method</span><select name="payment_method">${["CASH","QR","CARD","BANK"].map(method => `<option ${method === row?.payment_method ? "selected" : ""}>${method}</option>`).join("")}</select></label>
      <label class="form-field"><span>Date</span><input name="date" type="date" value="${row?.date || isoToday()}" required></label>
      <label class="form-field"><span>Supplier / Company</span><input name="supplier" value="${escapeHtml(row?.supplier || "")}" placeholder="Optional"></label>
      <label class="form-field full"><span>Notes</span><textarea name="notes" placeholder="Reason or description">${escapeHtml(row?.notes || "")}</textarea></label>
      ${row ? '<label class="form-field full"><span>Delete reason (only used by Delete)</span><input name="delete_reason" placeholder="Required before deleting a financial record"></label>' : ""}
      </div>${row ? '<div class="dialog-actions" style="justify-content:flex-start;border:0;margin:4px 0 0;padding:0"><button class="button danger" type="button" id="deleteLedgerRow">Delete transaction</button></div>' : ""}`, onSubmit: async form => {
        const payload = { type: fieldValue(form,"type"), source: fieldValue(form,"source"), amount: Number(fieldValue(form,"amount")), payment_method: fieldValue(form,"payment_method"), date: fieldValue(form,"date"), supplier: fieldValue(form,"supplier"), notes: fieldValue(form,"notes") };
        await POSAuth.api(row ? `/api/accounting/transactions/${row.id}` : "/api/accounting/transactions", { method: row ? "PUT" : "POST", body: JSON.stringify(payload) });
        showToast(row ? "Transaction updated" : "Transaction added"); await loadPage("accounting");
      }});
    if (row) document.getElementById("deleteLedgerRow").addEventListener("click", async () => {
      const form = document.getElementById("adminActionForm"); const reason = fieldValue(form,"delete_reason");
      try { await POSAuth.api(`/api/accounting/transactions/${row.id}`, { method:"DELETE", body:JSON.stringify({reason}) }); modal.close(); showToast("Transaction deleted with audit reason"); await loadPage("accounting"); } catch(error){ showToast(error.message,true); }
    });
  };
  document.getElementById("addLedgerRow").addEventListener("click", () => openTransactionForm());
  content.querySelectorAll("[data-edit-ledger]").forEach(button => button.addEventListener("click", () => openTransactionForm(transactions.rows.find(row => row.id === Number(button.dataset.editLedger)))));
  document.getElementById("applyAccountingFilter").addEventListener("click", async () => {
    adminState.accountingFrom = document.getElementById("accountingFrom").value;
    adminState.accountingTo = document.getElementById("accountingTo").value;
    adminState.accountingType = document.getElementById("accountingType").value;
    adminState.accountingSearch = document.getElementById("accountingSearch").value.trim();
    await loadPage("accounting");
  });
  document.getElementById("accountantExport").addEventListener("click", () => downloadExport(`/api/exports/accountant?month=${adminState.accountingTo.slice(0,7)}`).catch(error => showToast(error.message,true)));
  document.getElementById("manageFlowCategories").addEventListener("click", () => {
    openModal({
      title:"Cashflow categories",
      eyebrow:"ACCOUNTING SETUP",
      submitLabel:"Add category",
      body:`<div class="form-grid"><label class="form-field"><span>Type</span><select name="type"><option>Expense</option><option>Income</option></select></label><label class="form-field"><span>New category name</span><input name="name" required></label></div><div class="category-manager">${categories.rows.map(row=>`<div class="metric-row"><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.type)}</small></span><button class="button small secondary" data-edit-flow-category="${row.id}" type="button">Edit</button></div>`).join("") || '<div class="empty-state">No categories yet</div>'}</div>`,
      onSubmit:async form=>{await POSAuth.api("/api/accounting/categories",{method:"POST",body:JSON.stringify({type:fieldValue(form,"type"),name:fieldValue(form,"name")})});showToast("Category added");await loadPage("accounting");}
    });
    document.querySelectorAll("[data-edit-flow-category]").forEach(button=>button.addEventListener("click",()=>{
      const row=categories.rows.find(item=>item.id===Number(button.dataset.editFlowCategory));
      openModal({
        title:`Edit ${row.name}`,
        eyebrow:"ACCOUNTING CATEGORY",
        submitLabel:"Update category",
        body:`<div class="form-grid"><label class="form-field"><span>Type</span><select name="type"><option ${row.type==="Expense"?"selected":""}>Expense</option><option ${row.type==="Income"?"selected":""}>Income</option></select></label><label class="form-field"><span>Category name</span><input name="name" value="${escapeHtml(row.name)}" required></label><label class="form-field full"><span>Deletion reason (only used by Delete)</span><textarea name="delete_reason" placeholder="Required before deleting"></textarea></label></div><div class="dialog-actions" style="justify-content:flex-start;border:0;margin:4px 0 0;padding:0"><button class="button danger" type="button" id="deleteFlowCategory">Delete category</button></div>`,
        onSubmit:async form=>{await POSAuth.api(`/api/accounting/categories/${row.id}`,{method:"PUT",body:JSON.stringify({type:fieldValue(form,"type"),name:fieldValue(form,"name")})});showToast("Category updated");await loadPage("accounting");}
      });
      document.getElementById("deleteFlowCategory").addEventListener("click",async()=>{const form=document.getElementById("adminActionForm");try{await POSAuth.api(`/api/accounting/categories/${row.id}`,{method:"DELETE",body:JSON.stringify({reason:fieldValue(form,"delete_reason")})});modal.close();showToast("Category deleted with audit reason");await loadPage("accounting");}catch(error){showToast(error.message,true)}});
    }));
  });
}

async function loadCash() {
  adminState.cashDate ||= isoToday();
  const [summary, entries, categories] = await Promise.all([POSAuth.api(`/api/cash/summary?date=${adminState.cashDate}`), POSAuth.api(`/api/cash/entries?date=${adminState.cashDate}`), POSAuth.api("/api/accounting/categories")]);
  const closing = summary.closing;
  const adminAccess = adminState.session.mode === "admin";
  const canSetOpening = !summary.opened_at || adminAccess;
  const canClose = !closing || adminAccess;
  const entryRows = type => entries.rows.filter(row=>!type||String(row.type).toLowerCase()===type.toLowerCase());
  const entryTable = (rows, emptyText) => `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>Type</th><th>Category</th><th>Supplier / Ref</th><th>Notes</th><th>Staff</th><th style="text-align:right">Amount</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${escapeHtml((row.datetime||"").slice(11,16))}</td><td>${statusPill(row.type,row.type)}</td><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.supplier||"—")}</td><td>${escapeHtml(row.description||"—")}</td><td>${escapeHtml(row.recorded_by||"—")}</td><td class="money">${money(row.amount)}</td></tr>`).join("")||`<tr><td colspan="7" class="empty-state">${escapeHtml(emptyText)}</td></tr>`}</tbody></table></div>`;
  const tabs = [{id:"summary",label:"📊 Cash Summary"},{id:"entries",label:"💸 Other Income & Expense"},{id:"close",label:"🌙 End of Day"}];
  let tabContent = "";

  if (adminState.cashTab === "entries") {
    tabContent = `<div class="cash-action-grid">
      <section class="cash-entry-card expense"><span>EXPENSE</span><h3>Record money taken from the drawer</h3><p>Supplier purchases, utilities, wages, repairs, packaging, transport, or another approved expense.</p><strong>${money(entryRows("expense").reduce((sum,row)=>sum+Number(row.amount||0),0))} today</strong><button class="button danger" id="addCashExpense" type="button">＋ Add expense</button></section>
      <section class="cash-entry-card income"><span>OTHER INCOME</span><h3>Record non-sale cash received</h3><p>Rental and POS sales are automatic. Use this only for other cash received at the counter.</p><strong>${money(entryRows("income").reduce((sum,row)=>sum+Number(row.amount||0),0))} today</strong><button class="button blue" id="addCashIncome" type="button">＋ Add income</button></section>
    </div><section class="content-card"><div class="card-header"><div><h3>Manual cash entry history</h3><p>All entries for ${escapeHtml(summary.date)}. Sales and rent are stored automatically in the unified cashflow ledger.</p></div></div><div class="card-body flush">${entryTable(entries.rows,"No manual entries for this business date")}</div></section>`;
  } else if (adminState.cashTab === "close") {
    tabContent = `<div class="content-grid cash-close-grid"><section class="content-card"><div class="card-header"><div><h3>End of day cash check</h3><p>Count the physical notes and coins, then compare them with the calculated drawer value.</p></div>${closing?statusPill("Closed","paid"):statusPill("Open","warning")}</div><div class="card-body"><div class="cash-equation"><span><small>OPENING</small><strong>${money(summary.opening_cash)}</strong></span><b>＋</b><span><small>CASH SALES</small><strong>${money(summary.pos_cash)}</strong></span><b>＋</b><span><small>OTHER INCOME</small><strong>${money(summary.other_income)}</strong></span><b>−</b><span><small>EXPENSES</small><strong>${money(summary.expenses)}</strong></span><b>＝</b><span class="result"><small>EXPECTED</small><strong>${money(summary.expected_cash)}</strong></span></div><button class="button primary cash-primary-action" id="closeCashDay" type="button" ${canClose?"":"disabled"}>${closing?(adminAccess?"Count and close again":"Day already closed"):"Count and close business day"}</button></div></section><aside class="content-card"><div class="card-header"><div><h3>Latest closing record</h3><p>${closing?escapeHtml(closing.closed_at||""):"No closing recorded"}</p></div></div><div class="card-body metric-list">${closing?`<div class="metric-row"><span><strong>Counted by</strong><small>${escapeHtml(closing.notes||"No notes")}</small></span><b>${escapeHtml(closing.cashier||"—")}</b></div><div class="metric-row"><span><strong>Expected</strong><small>Ledger calculation</small></span><b>${money(closing.expected_cash)}</b></div><div class="metric-row"><span><strong>Actual</strong><small>Physical count</small></span><b>${money(closing.actual_cash)}</b></div><div class="metric-row"><span><strong>Difference</strong><small>${Math.abs(Number(closing.difference||0))<.01?"Balanced":Number(closing.difference)>0?"Over":"Short"}</small></span><b>${money(closing.difference)}</b></div>`:'<div class="empty-state">Complete the cash count at the end of the business day.</div>'}</div></aside></div>`;
  } else {
    adminState.cashTab = "summary";
    tabContent = `<div class="cash-expected-banner"><span><small>EXPECTED CASH IN DRAWER</small><strong>${money(summary.expected_cash)}</strong></span><p>Opening ${money(summary.opening_cash)} + Cash sales ${money(summary.pos_cash)} + Other income ${money(summary.other_income)} − Expenses ${money(summary.expenses)}</p></div><div class="content-grid"><section class="content-card"><div class="card-header"><div><h3>Today’s cash activity</h3><p>Quick view of manual entries recorded for this business date.</p></div><button class="button small secondary" data-cash-tab="entries" type="button">Open Expense / Income →</button></div><div class="card-body flush">${entryTable(entries.rows.slice(0,12),"No manual entries yet")}</div></section><aside><section class="content-card"><div class="card-header"><div><h3>Opening cash</h3><p>${summary.opened_at?`Registered ${escapeHtml(summary.opened_at)}`:"Register before trading"}</p></div></div><div class="card-body"><div class="metric-list"><div class="metric-row"><span><strong>Current opening</strong><small>${escapeHtml(summary.opened_by||"Not registered")}</small></span><b>${money(summary.opening_cash)}</b></div></div><button class="button amber cash-primary-action" id="setOpening" type="button" ${canSetOpening?"":"disabled"}>${summary.opened_at?(adminAccess?"Replace opening cash":"Opening locked") : "Set opening cash"}</button>${summary.opened_at&&!adminAccess?'<p class="form-hint" style="margin-top:8px">Open Admin remotely if this opening must be corrected.</p>':""}</div></section><section class="content-card" style="margin-top:12px"><div class="card-header"><div><h3>Shift status</h3><p>${closing?`Closed by ${escapeHtml(closing.cashier||"—")}`:"Business day still open"}</p></div></div><div class="card-body"><div class="metric-list"><div class="metric-row"><span><strong>Cash sales</strong><small>QR total ${money(summary.qr_total)} (rent ${money(summary.qr_rent)}) is excluded from drawer</small></span><b>${money(summary.pos_cash)}</b></div><div class="metric-row"><span><strong>Expected balance</strong><small>${closing?`Actual ${money(closing.actual_cash)}`:"Awaiting close"}</small></span><b>${money(summary.expected_cash)}</b></div></div><button class="button secondary cash-primary-action" data-cash-tab="close" type="button">Go to Close Day →</button></div></section></aside></div>`;
  }

  content.innerHTML = `
    <div class="page-toolbar"><div class="toolbar-copy"><h2>Physical cash reconciliation</h2><p>Expected cash = Opening + Cash Sales + Other Income − Expenses.</p></div><div class="toolbar-actions"><label class="filter-field"><span>BUSINESS DATE</span><input id="cashDate" type="date" value="${summary.date}"></label><button class="button secondary" id="refreshCash" type="button">Refresh</button></div></div>
    <div class="permission-banner"><span>C</span><div><strong>${adminAccess?"Remote Admin cash control":"Cashier quick cash panel"}</strong><small>Cashiers may set the first opening, record entries, and close the day. Replacing an opening or re-closing a day requires the separate Admin workspace.</small></div></div>
    <div class="kpi-grid">${kpiCard("Opening cash",money(summary.opening_cash),summary.opened_by?`Set by ${summary.opened_by}`:"Not set","amber","OPEN")}${kpiCard("Cash sales",money(summary.pos_cash),`QR sales ${money(summary.qr_sales)} · QR rent ${money(summary.qr_rent)} · QR total ${money(summary.qr_total)}`,"green","SALE")}${kpiCard("Other income",money(summary.other_income),`Expenses ${money(summary.expenses)}`,"purple","+/−")}${kpiCard("Expected cash",money(summary.expected_cash),closing?`Closed · Actual ${money(closing.actual_cash)}`:"Not closed","blue","BOX")}</div>
    <nav class="module-tabs" aria-label="Cash functions">${tabs.map(tab=>`<button class="${adminState.cashTab===tab.id?"active":""}" data-cash-tab="${tab.id}" type="button">${tab.label}</button>`).join("")}</nav>${tabContent}`;
  const categoryOptions = type => {const options=categories.rows.filter(row=>row.type===type).map(row=>`<option>${escapeHtml(row.name)}</option>`).join("");return options||`<option>${type==="Expense"?"Other Expense":"Other Income"}</option>`;};
  const openEntry = type => openModal({ title:`Add ${type.toLowerCase()}`, eyebrow:"CASH ENTRY", submitLabel:`Save ${type.toLowerCase()}`, submitClass:type==="Expense"?"danger":"blue", body:`<div class="form-grid"><label class="form-field"><span>Amount (RM)</span><input name="amount" type="number" step="0.01" min="0.01" required></label><label class="form-field"><span>Category</span><select name="category">${categoryOptions(type)}</select></label><label class="form-field"><span>Supplier / Payer</span><input name="supplier" placeholder="Optional"></label><label class="form-field full"><span>Notes</span><textarea name="notes"></textarea></label></div>`, onSubmit:async form=>{await POSAuth.api("/api/cash/entry",{method:"POST",body:JSON.stringify({type,amount:Number(fieldValue(form,"amount")),category:fieldValue(form,"category"),supplier:fieldValue(form,"supplier"),notes:fieldValue(form,"notes"),date:adminState.cashDate})});showToast(`${type} recorded`);await loadPage("cash");} });
  content.querySelectorAll("[data-cash-tab]").forEach(button=>button.addEventListener("click",()=>{adminState.cashTab=button.dataset.cashTab;loadPage("cash")}));
  document.getElementById("addCashExpense")?.addEventListener("click",()=>openEntry("Expense")); document.getElementById("addCashIncome")?.addEventListener("click",()=>openEntry("Income"));
  if(canSetOpening)document.getElementById("setOpening")?.addEventListener("click",()=>openModal({title:"Set opening cash",eyebrow:"CASH OPENING",submitLabel:"Save opening",submitClass:"amber",body:`<div class="form-grid"><label class="form-field full"><span>Opening amount (RM)</span><input name="amount" type="number" step="0.01" min="0" value="${summary.opening_cash||""}" required></label></div><p class="form-hint">Replacing an existing opening is restricted to the Admin workspace.</p>`,onSubmit:async form=>{await POSAuth.api("/api/cash/opening",{method:"POST",body:JSON.stringify({amount:Number(fieldValue(form,"amount")),date:adminState.cashDate})});showToast("Opening cash saved");await loadPage("cash");}}));
  if(canClose)document.getElementById("closeCashDay")?.addEventListener("click",()=>openModal({title:"Confirm counted cash",eyebrow:"END OF DAY",submitLabel:"Close business day",body:`<div class="form-grid"><label class="form-field"><span>Expected cash</span><input value="${money(summary.expected_cash)}" disabled></label><label class="form-field"><span>Actual counted cash (RM)</span><input name="actual_cash" type="number" step="0.01" required></label><label class="form-field full"><span>Closing notes</span><textarea name="notes" placeholder="Optional variance explanation"></textarea></label></div>`,onSubmit:async form=>{await POSAuth.api("/api/cash/close",{method:"POST",body:JSON.stringify({actual_cash:Number(fieldValue(form,"actual_cash")),notes:fieldValue(form,"notes"),date:adminState.cashDate})});showToast("Business day closed and audited");await loadPage("cash");}}));
  document.getElementById("refreshCash").addEventListener("click",()=>{adminState.cashDate=document.getElementById("cashDate").value;loadPage("cash")});
}

async function loadRent() {
  const adminAccess = adminState.session.mode === "admin";
  adminState.rentFrom ||= monthStart(isoToday()); adminState.rentTo ||= isoToday();
  const [tenants,payments] = await Promise.all([POSAuth.api("/api/rent/tenants"),POSAuth.api(`/api/rent/payments?from=${adminState.rentFrom}&to=${adminState.rentTo}`)]);
  const active=tenants.rows.filter(row=>row.active), overdue=active.filter(row=>row.status.code==="overdue"), due=active.filter(row=>row.status.code==="due"), periodTotal=payments.rows.filter(row=>!row.voided).reduce((sum,row)=>sum+Number(row.amount||0),0);
  content.innerHTML=`<div class="page-toolbar"><div class="toolbar-copy"><h2>Tenant and rental control</h2><p>Every collection links the rent payment to the unified cashflow ledger.</p></div><div class="toolbar-actions">${adminAccess?'<button class="button green" id="addTenant" type="button">＋ Add tenant</button><button class="button secondary" id="syncRentDates" type="button">↻ Sync dates</button><button class="button secondary" id="rentExport" type="button">Export rent XLSX</button>':''}</div></div>
    <div class="kpi-grid">${kpiCard("Active tenants",String(active.length),`${tenants.rows.length-active.length} inactive`,"green","TEN")}${kpiCard("Overdue",String(overdue.length),"Including no payment yet","red","!")}${kpiCard("Due soon",String(due.length),"Today or within 3 days","amber","DUE")}${kpiCard("Period collections",money(periodTotal),`${adminState.rentFrom} to ${adminState.rentTo}`,"purple","RM")}</div>
    <section class="content-card"><div class="card-header"><div><h3>Stalls and tenants</h3><p>Collecting rent requires a Cashier or Admin session; tenant setup and voiding require Admin.</p></div></div><div class="card-body"><div class="tenant-grid">${tenants.rows.map(row=>`<article class="tenant-card ${row.status.code}"><div class="tenant-head"><span><strong>Stall ${escapeHtml(row.stall_no||"—")} · ${escapeHtml(row.name)}</strong><small>${escapeHtml(row.rental_type)} rent</small></span>${statusPill(row.status.label,row.status.code)}</div><div class="tenant-meta"><span><small>RATE</small><strong>${money(row.daily_rate)} / ${row.rental_type==="Monthly"?"month":"day"}</strong></span><span><small>PAID UNTIL</small><strong>${escapeHtml(row.paid_until_date||"Never")}</strong></span></div><div class="tenant-actions"><button class="button small green" data-collect-rent="${row.id}" type="button">Collect</button>${adminAccess?`<button class="button small secondary" data-edit-tenant="${row.id}" type="button">Edit</button><button class="button small danger" data-delete-tenant="${row.id}" type="button">Delete</button>`:""}</div></article>`).join("")||'<div class="empty-state">No tenants configured</div>'}</div></div></section>
    <section class="content-card" style="margin-top:12px"><div class="card-header"><div><h3>Rental payment history</h3><p>Voided payments remain visible for audit.</p></div><div class="card-actions"><label class="filter-field"><span>FROM</span><input id="rentFrom" type="date" value="${adminState.rentFrom}"></label><label class="filter-field"><span>TO</span><input id="rentTo" type="date" value="${adminState.rentTo}"></label><button class="button small secondary" id="filterRent" type="button">Apply</button></div></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Tenant</th><th>Stall</th><th>Units</th><th>Rate</th><th>Staff</th><th>Status</th><th style="text-align:right">Amount</th><th></th></tr></thead><tbody>${payments.rows.map(row=>`<tr><td>${escapeHtml(row.pay_date)}</td><td class="cell-title"><strong>${escapeHtml(row.tenant_name)}</strong><small>#${row.id}</small></td><td>${escapeHtml(row.stall_no||"—")}</td><td>${row.days}</td><td>${money(row.rate)}</td><td>${escapeHtml(row.recorded_by||"—")}</td><td>${statusPill(row.voided?"Voided":"Paid",row.voided?"inactive":"paid")}</td><td class="money">${money(row.amount)}</td><td class="actions">${adminAccess&&!row.voided?`<button class="button small danger" data-void-rent="${row.id}" type="button">Void</button>`:""}</td></tr>`).join("")||'<tr><td colspan="9" class="empty-state">No payments in this period</td></tr>'}</tbody></table></div></div></section>`;
  const tenantForm=(row=null)=>openModal({title:row?`Edit ${row.name}`:"Add tenant",eyebrow:"STALL MANAGEMENT",submitLabel:row?"Update tenant":"Add tenant",body:`<div class="form-grid"><label class="form-field"><span>Tenant name</span><input name="name" value="${escapeHtml(row?.name||"")}" required></label><label class="form-field"><span>Stall number</span><input name="stall_no" value="${escapeHtml(row?.stall_no||"")}"></label><label class="form-field"><span>Rental type</span><select name="rental_type"><option ${row?.rental_type!=="Monthly"?"selected":""}>Daily</option><option ${row?.rental_type==="Monthly"?"selected":""}>Monthly</option></select></label><label class="form-field"><span>Rate (RM)</span><input name="daily_rate" type="number" min="0" step="0.01" value="${row?.daily_rate??0}" required></label><label class="form-field"><span>Start date</span><input name="start_date" type="date" value="${row?.start_date||isoToday()}"></label>${row?`<label class="form-field"><span>Status</span><select name="active"><option value="1" ${row.active?"selected":""}>Active</option><option value="0" ${row.active?"":"selected"}>Inactive</option></select></label>`:""}<label class="form-field full"><span>Notes</span><textarea name="notes">${escapeHtml(row?.notes||"")}</textarea></label></div>`,onSubmit:async form=>{const payload={name:fieldValue(form,"name"),stall_no:fieldValue(form,"stall_no"),rental_type:fieldValue(form,"rental_type"),daily_rate:Number(fieldValue(form,"daily_rate")),start_date:fieldValue(form,"start_date"),notes:fieldValue(form,"notes")};if(row)payload.active=Number(fieldValue(form,"active"));await POSAuth.api(row?`/api/rent/tenants/${row.id}`:"/api/rent/tenants",{method:row?"PUT":"POST",body:JSON.stringify(payload)});showToast(row?"Tenant updated":"Tenant added");await loadPage("rent");}});
  document.getElementById("addTenant")?.addEventListener("click",()=>tenantForm()); content.querySelectorAll("[data-edit-tenant]").forEach(button=>button.addEventListener("click",()=>tenantForm(tenants.rows.find(row=>row.id===Number(button.dataset.editTenant)))));
  content.querySelectorAll("[data-delete-tenant]").forEach(button=>button.addEventListener("click",()=>{const row=tenants.rows.find(item=>item.id===Number(button.dataset.deleteTenant));openModal({title:`Delete ${row.name}`,eyebrow:"PERMANENT TENANT CHANGE",submitLabel:"Delete tenant",submitClass:"danger",body:`<p class="form-hint" style="margin-bottom:12px">The tenant record will be removed. Existing payment history remains available for audit and reports.</p><label class="form-field"><span>Deletion reason</span><textarea name="reason" required></textarea></label>`,onSubmit:async form=>{await POSAuth.api(`/api/rent/tenants/${row.id}`,{method:"DELETE",body:JSON.stringify({reason:fieldValue(form,"reason")})});showToast("Tenant deleted; payment history kept");await loadPage("rent");}})}));
  content.querySelectorAll("[data-collect-rent]").forEach(button=>button.addEventListener("click",()=>{const row=tenants.rows.find(item=>item.id===Number(button.dataset.collectRent));openModal({title:`Collect rent · ${row.name}`,eyebrow:"RENT COLLECTION",submitLabel:"Confirm collection",submitClass:"green",body:`<div class="form-grid"><label class="form-field"><span>${row.rental_type==="Monthly"?"Months":"Days"}</span><input name="units" type="number" min="1" step="${row.rental_type==="Monthly"?1:.5}" value="1" required></label><label class="form-field"><span>Rate</span><input value="${money(row.daily_rate)} / ${row.rental_type==="Monthly"?"month":"day"}" disabled></label><label class="form-field"><span>Receiving staff PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" required></label><label class="form-field full"><span>Notes</span><textarea name="notes"></textarea></label></div><p class="form-hint">This PIN records who physically received the rental payment. It does not change the active workspace.</p>`,onSubmit:async form=>{const result=await POSAuth.api("/api/rent/collect",{method:"POST",body:JSON.stringify({tenant_id:row.id,units:Number(fieldValue(form,"units")),pin:fieldValue(form,"pin"),notes:fieldValue(form,"notes")})});showToast(`Collected ${money(result.amount)} by ${result.received_by} · paid until ${result.paid_until}`);await loadPage("rent");}})}));
  content.querySelectorAll("[data-void-rent]").forEach(button=>button.addEventListener("click",()=>openModal({title:`Void rent payment #${button.dataset.voidRent}`,eyebrow:"ADMIN APPROVAL",submitLabel:"Void payment",submitClass:"danger",body:`<label class="form-field"><span>Void reason</span><textarea name="reason" required placeholder="Required for audit"></textarea></label>`,onSubmit:async form=>{await POSAuth.api(`/api/rent/payments/${button.dataset.voidRent}/void`,{method:"POST",body:JSON.stringify({reason:fieldValue(form,"reason")})});showToast("Rental payment voided and cashflow reversed");await loadPage("rent");}})));
  document.getElementById("syncRentDates")?.addEventListener("click",()=>openModal({title:"Synchronize rent dates",eyebrow:"RENT DATA MAINTENANCE",submitLabel:"Recalculate all dates",body:`<p class="form-hint">Paid-until dates will be rebuilt from each tenant’s start date and every non-voided payment. Use this after importing or correcting historical rental data.</p><label class="form-field" style="margin-top:12px"><span>Type SYNC to continue</span><input name="confirmation" required></label>`,onSubmit:async form=>{if(fieldValue(form,"confirmation")!=="SYNC")throw new Error("Type SYNC exactly to continue.");const result=await POSAuth.api("/api/rent/sync",{method:"POST",body:"{}"});showToast(`${result.updated} rent dates synchronized`);await loadPage("rent");}}));
  document.getElementById("filterRent").addEventListener("click",()=>{adminState.rentFrom=document.getElementById("rentFrom").value;adminState.rentTo=document.getElementById("rentTo").value;loadPage("rent")}); document.getElementById("rentExport")?.addEventListener("click",()=>downloadExport("/api/exports/rent").catch(error=>showToast(error.message,true)));
}

async function loadStock() {
  const adminAccess = adminState.session.mode === "admin";
  const [items,movements,categories] = await Promise.all([POSAuth.api(`/api/stock/items?search=${encodeURIComponent(adminState.stockSearch)}`),POSAuth.api("/api/stock/movements"),adminAccess?POSAuth.api("/api/catalog/categories"):Promise.resolve({rows:[]})]);
  const active=items.rows.filter(row=>row.active), tracked=active.filter(row=>row.track_stock), low=tracked.filter(row=>row.status==="low"), out=tracked.filter(row=>row.status==="out");
  content.innerHTML=`<div class="page-toolbar"><div class="toolbar-copy"><h2>Inventory and item management</h2><p>Current balance is fast; stock_movements explains every tracked change.</p></div><div class="toolbar-actions">${adminAccess?'<button class="button green" id="addStockItem" type="button">＋ Add item</button><button class="button secondary" id="stockExport" type="button">Export stock XLSX</button>':''}</div></div>
    <div class="permission-banner"><span>S</span><div><strong>${adminAccess?"Stock changes are enabled in this Admin workspace":"Cashier Stock is view-only"}</strong><small>${adminAccess?"Every manual change needs a quantity and reason, updates items.stock, inserts a stock movement, and writes an audit record in one transaction.":"Open an Admin workspace to adjust balances or edit product settings."}</small></div></div>
    <div class="kpi-grid">${kpiCard("Active items",String(active.length),`${tracked.length} tracked`,"green","ITEM")}${kpiCard("Healthy tracked",String(tracked.length-low.length-out.length),"Above reorder level","purple","OK")}${kpiCard("Low stock",String(low.length),"At or below reorder level","amber","LOW")}${kpiCard("Out of stock",String(out.length),"Cannot be deducted","red","OUT")}</div>
    <section class="content-card"><div class="card-header"><div><h3>Products and current stock</h3><p>${adminAccess?"Edit photos and prices, then use Options for variants and quantity-set pricing.":"Live balances and reorder status."}</p></div><div class="card-actions"><label class="filter-field"><span>SEARCH</span><input id="stockSearch" type="search" value="${escapeHtml(adminState.stockSearch)}" placeholder="Product name"></label><button class="button small secondary" id="applyStockSearch" type="button">Search</button></div></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Tracking</th><th>Stock</th><th>Reorder</th><th>Status</th><th></th></tr></thead><tbody>${items.rows.map(row=>`<tr><td><div class="item-table-cell"><span class="item-table-photo">${row.image_path?`<img src="${escapeHtml(row.image_path)}" alt="">`:"IMG"}</span><span class="cell-title"><strong>${escapeHtml(row.name)}</strong><small>#${row.id}${row.barcode?` · ${escapeHtml(row.barcode)}`:""}</small></span></div></td><td>${escapeHtml(row.category)}</td><td>${money(row.price)}</td><td>${row.track_stock?"Tracked":"No tracking"}</td><td>${row.track_stock?row.stock:"—"}</td><td>${row.track_stock?row.low_stock_threshold:"—"}</td><td>${statusPill(row.active?(row.track_stock?row.status:"Active"):"Inactive",row.active?(row.track_stock?row.status:"active"):"inactive")}</td><td class="actions">${adminAccess&&row.active&&row.track_stock?`<button class="button small amber" data-adjust-stock="${row.id}" type="button">Adjust</button>`:""} ${adminAccess?`<button class="button small blue" data-item-options="${row.id}" type="button">Options</button> <button class="button small secondary" data-edit-item="${row.id}" type="button">Edit</button>`:""}</td></tr>`).join("")}</tbody></table></div></div></section>
    <section class="content-card" style="margin-top:12px"><div class="card-header"><div><h3>Recent stock movements</h3><p>Latest 500 ledger entries</p></div></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Date & time</th><th>Item</th><th>Source</th><th>Staff</th><th>Reason</th><th>Before</th><th>Delta</th><th>After</th></tr></thead><tbody>${movements.rows.slice(0,100).map(row=>`<tr><td>${escapeHtml(row.datetime)}</td><td>${escapeHtml(row.item_name)}</td><td>${escapeHtml(row.source_type)}</td><td>${escapeHtml(row.recorded_by||"—")}</td><td>${escapeHtml(row.notes||"—")}</td><td>${row.stock_before}</td><td><strong style="color:${row.quantity_delta>=0?"#1e8a5b":"#ca3d46"}">${row.quantity_delta>=0?"+":""}${row.quantity_delta}</strong></td><td>${row.stock_after}</td></tr>`).join("")||'<tr><td colspan="8" class="empty-state">No stock movements</td></tr>'}</tbody></table></div></div></section>`;
  document.getElementById("addStockItem")?.addEventListener("click",()=>{
    openModal({title:"Add product item",eyebrow:"ITEM MANAGEMENT",submitLabel:"Add item",submitClass:"green",body:`<div class="form-grid"><label class="form-field"><span>Name</span><input name="name" required></label><label class="form-field"><span>Price (RM)</span><input name="price" type="number" min="0" step="0.01" required></label><label class="form-field"><span>Category</span><select name="category">${categories.rows.filter(row=>row.active).map(row=>`<option>${escapeHtml(row.name)}</option>`).join("")}</select></label><label class="form-field"><span>Track stock</span><select name="track_stock"><option value="0">No</option><option value="1">Yes</option></select></label><label class="form-field"><span>Opening stock</span><input name="stock" type="number" min="0" step="1" value="0"></label><label class="form-field"><span>Low-stock threshold</span><input name="low_stock_threshold" type="number" min="0" step="1" value="5"></label><label class="form-field full"><span>Barcode</span><input name="barcode" placeholder="Optional"></label>${itemImageFields()}</div>`,onSubmit:async form=>{await POSAuth.api("/api/stock/items",{method:"POST",body:JSON.stringify({name:fieldValue(form,"name"),price:Number(fieldValue(form,"price")),category:fieldValue(form,"category"),track_stock:Number(fieldValue(form,"track_stock")),stock:Number(fieldValue(form,"stock")),low_stock_threshold:Number(fieldValue(form,"low_stock_threshold")),barcode:fieldValue(form,"barcode"),image_data:await itemImageData(form)})});showToast("Item added");await loadPage("stock");}});
    bindItemImagePreview();
  });
  content.querySelectorAll("[data-item-options]").forEach(button=>button.addEventListener("click",()=>openItemOptionsManager(items.rows.find(item=>item.id===Number(button.dataset.itemOptions)))));
  content.querySelectorAll("[data-adjust-stock]").forEach(button=>button.addEventListener("click",()=>{const row=items.rows.find(item=>item.id===Number(button.dataset.adjustStock));openModal({title:`Adjust ${row.name}`,eyebrow:"STOCK MOVEMENT",submitLabel:"Apply adjustment",submitClass:"amber",body:`<div class="form-grid"><label class="form-field"><span>Current stock</span><input value="${row.stock}" disabled></label><label class="form-field"><span>Quantity change</span><input name="delta" type="number" step="1" placeholder="Example: 10 or -3" required></label><label class="form-field full"><span>Reason</span><textarea name="note" required placeholder="Delivery, spoilage, count correction…"></textarea></label></div>`,onSubmit:async form=>{const result=await POSAuth.api("/api/stock/adjust",{method:"POST",body:JSON.stringify({item_id:row.id,delta:Number(fieldValue(form,"delta")),note:fieldValue(form,"note")})});showToast(`${row.name}: ${result.before} → ${result.after}`);await loadPage("stock");}})}));
  content.querySelectorAll("[data-edit-item]").forEach(button=>button.addEventListener("click",()=>{
    const row=items.rows.find(item=>item.id===Number(button.dataset.editItem));
    openModal({title:`Edit ${row.name}`,eyebrow:"ITEM MANAGEMENT",submitLabel:"Update item",body:`<div class="form-grid"><label class="form-field"><span>Name</span><input name="name" value="${escapeHtml(row.name)}" required></label><label class="form-field"><span>Price (RM)</span><input name="price" type="number" step="0.01" min="0" value="${row.price}" required></label><label class="form-field"><span>Category</span><input name="category" value="${escapeHtml(row.category)}" required></label><label class="form-field"><span>Low-stock threshold</span><input name="low_stock_threshold" type="number" min="0" step="1" value="${row.low_stock_threshold}"></label><label class="form-field"><span>Track stock</span><select name="track_stock"><option value="1" ${row.track_stock?"selected":""}>Yes</option><option value="0" ${row.track_stock?"":"selected"}>No</option></select></label><label class="form-field"><span>Status</span><select name="active"><option value="1" ${row.active?"selected":""}>Active</option><option value="0" ${row.active?"":"selected"}>Inactive</option></select></label><label class="form-field full"><span>Barcode</span><input name="barcode" value="${escapeHtml(row.barcode||"")}"></label>${itemImageFields(row)}</div>`,onSubmit:async form=>{await POSAuth.api(`/api/stock/items/${row.id}`,{method:"PUT",body:JSON.stringify({name:fieldValue(form,"name"),price:Number(fieldValue(form,"price")),category:fieldValue(form,"category"),low_stock_threshold:Number(fieldValue(form,"low_stock_threshold")),track_stock:Number(fieldValue(form,"track_stock")),active:Number(fieldValue(form,"active")),barcode:fieldValue(form,"barcode"),image_data:await itemImageData(form),remove_image:Boolean(form.elements.remove_image?.checked)})});showToast("Item updated");await loadPage("stock");}});
    bindItemImagePreview();
  }));
  document.getElementById("applyStockSearch").addEventListener("click",()=>{adminState.stockSearch=document.getElementById("stockSearch").value;loadPage("stock")}); document.getElementById("stockSearch").addEventListener("keydown",event=>{if(event.key==="Enter"){adminState.stockSearch=event.currentTarget.value;loadPage("stock")}}); document.getElementById("stockExport")?.addEventListener("click",()=>downloadExport("/api/exports/stock").catch(error=>showToast(error.message,true)));
}

async function openSaleCorrection(saleRow, saleItems, refundRows) {
  const catalog = await POSAuth.api("/api/stock/items");
  const variantsByItem = new Map();
  const setsByItem = new Map();
  (catalog.variants || []).forEach(row => {
    const itemId = Number(row.item_id);
    if (!variantsByItem.has(itemId)) variantsByItem.set(itemId, []);
    variantsByItem.get(itemId).push(row);
  });
  (catalog.quantity_sets || []).forEach(row => {
    const itemId = Number(row.item_id);
    if (!setsByItem.has(itemId)) setsByItem.set(itemId, []);
    setsByItem.get(itemId).push(row);
  });

  const sellOptions = [];
  (catalog.rows || []).filter(item => Number(item.active)).forEach(item => {
    const itemId = Number(item.id);
    const itemVariants = variantsByItem.get(itemId) || [];
    const itemSets = setsByItem.get(itemId) || [];
    if (!itemVariants.length) {
      sellOptions.push({ product_id:itemId, variant_code:null, label:item.name, detail:"Single", price:Number(item.price), stock_multiplier:1, stock:item.track_stock?Number(item.stock):null });
    }
    itemVariants.forEach(variant => sellOptions.push({
      product_id:itemId,
      variant_code:`variant-${variant.id}`,
      label:`${item.name} (${variant.variant_name})`,
      detail:"Variant",
      price:Number(item.price) + Number(variant.price_adjustment || 0),
      stock_multiplier:1,
      stock:item.track_stock?Number(item.stock):null
    }));
    itemSets.forEach(set => sellOptions.push({
      product_id:itemId,
      variant_code:`set-${set.id}`,
      label:`${item.name} · Set of ${set.quantity}`,
      detail:`Deducts ${set.quantity} from stock`,
      price:Number(set.set_price),
      stock_multiplier:Number(set.quantity),
      stock:item.track_stock?Number(item.stock):null
    }));
  });

  const soldByName = new Map();
  saleItems.forEach(item => {
    const name = String(item[0] || "").trim();
    if (!name || name.startsWith("[FOC] ") || Number(item[1] || 0) <= 0) return;
    const current = soldByName.get(name) || { name, price:Number(item[1] || 0), sold:0, category:String(item[3] || "") };
    current.sold += Number(item[2] || 0);
    soldByName.set(name, current);
  });
  const alreadyRefunded = new Map();
  refundRows.filter(row => Number(row.sale_id) === Number(saleRow.id)).forEach(row => {
    let items = [];
    try { items = JSON.parse(row.items || "[]"); } catch (_) { items = []; }
    items.forEach(item => {
      const name = String(item?.[0] || "").trim();
      if (name) alreadyRefunded.set(name, (alreadyRefunded.get(name) || 0) + Number(item?.[2] || 0));
    });
  });
  const refundableLines = [...soldByName.values()].map(line => ({ ...line, available:Math.max(0, line.sold - (alreadyRefunded.get(line.name) || 0)) })).filter(line => line.available > 0);
  const additions = [];
  const requestKey = correctionRequestKey();

  openModal({
    title:`Correct paid receipt #${saleRow.id}`,
    eyebrow:"CONTROLLED PAID-ORDER CORRECTION",
    submitLabel:"Save audited correction",
    submitClass:"danger",
    wide:true,
    body:`<div class="correction-lock-banner"><span>LOCKED</span><div><strong>The original paid receipt will not be edited.</strong><small>This action creates a linked refund and/or a separate adjustment receipt. The audit trail records the Admin, reason, money, and stock movement.</small></div></div>
      <div class="correction-workspace">
        <section class="correction-panel refund-side"><header><div><span>STEP 1 · OPTIONAL</span><h3>Refund wrong items</h3><p>Choose only items that must be removed from the original sale.</p></div><b id="correctionRefundHeading">${money(0)}</b></header>
          <div class="refund-item-list correction-refund-list">${refundableLines.map((line,index)=>`<label class="refund-line selectable"><input name="refund_${index}" type="checkbox"><span><strong>${escapeHtml(line.name)}</strong><small>${money(line.price)} each · ${line.available} refundable of ${line.sold}</small></span><input name="refund_qty_${index}" type="number" min="1" max="${line.available}" value="1" disabled><strong data-correction-refund-line>${money(0)}</strong></label>`).join("") || '<div class="option-empty">This receipt has no remaining refundable items.</div>'}</div>
          <label class="checkbox-field correction-stock-return"><input name="return_to_stock" type="checkbox" checked><span>Return selected tracked items to stock</span></label>
        </section>
        <section class="correction-panel charge-side"><header><div><span>STEP 2 · OPTIONAL</span><h3>Add missing or replacement items</h3><p>Current catalog prices and stock rules apply to the new receipt.</p></div><b id="correctionChargeHeading">${money(0)}</b></header>
          <div class="correction-add-control"><label class="form-field"><span>Item / variant / set</span><select id="correctionAddOption">${sellOptions.map((option,index)=>`<option value="${index}">${escapeHtml(option.label)} · ${money(option.price)}${option.stock===null?"":` · stock ${option.stock}`}</option>`).join("")}</select></label><label class="form-field compact"><span>Qty</span><input id="correctionAddQty" type="number" min="1" max="999" value="1"></label><button class="button green" id="correctionAddButton" type="button" ${sellOptions.length?"":"disabled"}>＋ Add</button></div>
          <div class="correction-added-list" id="correctionAddedList"><div class="option-empty">No additional items selected.</div></div>
        </section>
      </div>
      <div class="correction-summary"><div><small>REFUND TO CUSTOMER</small><strong id="correctionRefundTotal">${money(0)}</strong></div><i>and</i><div><small>NEW ADDITIONAL CHARGE</small><strong id="correctionChargeTotal">${money(0)}</strong></div><span id="correctionNetSummary">No money change selected</span></div>
      <div class="correction-approval">
        <label class="form-field full"><span>Correction reason</span><textarea name="reason" maxlength="300" placeholder="Example: Cashier selected carton instead of one bottle" required></textarea></label>
        <div class="form-grid correction-payment-fields" id="correctionPaymentFields" hidden><label class="form-field"><span>Payment for additional receipt</span><select name="payment"><option>CASH</option><option>QR</option><option>CARD</option></select></label><label class="form-field" id="correctionCashField"><span>Cash received for additional receipt</span><input name="cash_received" type="number" min="0" step="0.01" value="0.00"></label></div>
        <div class="form-grid"><label class="form-field"><span>Admin PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" required></label><div class="correction-audit-note"><b>What will be saved</b><span>Original receipt #${saleRow.id}, linked record IDs, reason, Admin identity, payment method, refund, charge, and stock movements.</span></div></div>
      </div>`,
    onSubmit:async form => {
      const refundItems = refundableLines.flatMap((line,index) => form.elements[`refund_${index}`]?.checked ? [{ name:line.name, qty:Number(form.elements[`refund_qty_${index}`].value) }] : []);
      const additionPayload = additions.map(line => ({ product_id:line.option.product_id, variant_code:line.option.variant_code, quantity:line.quantity }));
      if (!refundItems.length && !additionPayload.length) throw new Error("Choose at least one item to refund or add.");
      const payment = fieldValue(form,"payment") || "CASH";
      const result = await POSAuth.api(`/api/sales/${saleRow.id}/correct`, { method:"POST", body:JSON.stringify({
        idempotency_key:requestKey,
        reason:fieldValue(form,"reason"),
        pin:fieldValue(form,"pin"),
        refund_items:refundItems,
        return_to_stock:Boolean(form.elements.return_to_stock?.checked),
        additions:additionPayload,
        payment,
        cash_received:payment === "CASH" ? Number(fieldValue(form,"cash_received") || 0) : undefined
      }) });
      const parts = [];
      if (Number(result.refund_amount)) parts.push(`refund ${money(result.refund_amount)}`);
      if (Number(result.charge_amount)) parts.push(`new receipt #${result.correction_sale_id} ${money(result.charge_amount)}`);
      showToast(`Correction saved by ${result.processed_by}: ${parts.join(" · ")}`);
      await loadPage("sales");
    }
  });

  const form = document.getElementById("adminActionForm");
  const addedList = document.getElementById("correctionAddedList");
  const paymentFields = document.getElementById("correctionPaymentFields");
  const cashField = document.getElementById("correctionCashField");
  const cashInput = form.elements.cash_received;
  const renderAdditions = () => {
    addedList.innerHTML = additions.length ? additions.map((line,index)=>`<div class="correction-added-line"><span><strong>${escapeHtml(line.option.label)}</strong><small>${escapeHtml(line.option.detail)} · ${money(line.option.price)} each</small></span><input data-added-qty="${index}" type="number" min="1" max="999" value="${line.quantity}"><b>${money(line.option.price * line.quantity)}</b><button data-remove-added="${index}" type="button" aria-label="Remove ${escapeHtml(line.option.label)}">×</button></div>`).join("") : '<div class="option-empty">No additional items selected.</div>';
    addedList.querySelectorAll("[data-added-qty]").forEach(input => input.addEventListener("input", () => { additions[Number(input.dataset.addedQty)].quantity=Math.max(1,Math.min(999,Number(input.value||1)));updateSummary();renderAdditions(); }));
    addedList.querySelectorAll("[data-remove-added]").forEach(button => button.addEventListener("click", () => { additions.splice(Number(button.dataset.removeAdded),1);renderAdditions();updateSummary(); }));
  };
  const updateSummary = () => {
    let refundTotal = 0;
    refundableLines.forEach((line,index) => {
      const checked = Boolean(form.elements[`refund_${index}`]?.checked);
      const quantity = Math.max(1, Math.min(line.available, Number(form.elements[`refund_qty_${index}`]?.value || 1)));
      refundTotal += checked ? line.price * quantity : 0;
      const output = form.querySelectorAll("[data-correction-refund-line]")[index];
      if (output) output.textContent = money(checked ? line.price * quantity : 0);
    });
    const chargeTotal = additions.reduce((sum,line)=>sum + line.option.price * line.quantity,0);
    document.getElementById("correctionRefundHeading").textContent = money(refundTotal);
    document.getElementById("correctionChargeHeading").textContent = money(chargeTotal);
    document.getElementById("correctionRefundTotal").textContent = money(refundTotal);
    document.getElementById("correctionChargeTotal").textContent = money(chargeTotal);
    const net = chargeTotal - refundTotal;
    document.getElementById("correctionNetSummary").textContent = !refundTotal && !chargeTotal ? "No money change selected" : net > .005 ? `Net customer pays ${money(net)}` : net < -.005 ? `Net refund to customer ${money(Math.abs(net))}` : "Refund and charge balance";
    paymentFields.hidden = chargeTotal < .005;
    cashField.hidden = form.elements.payment.value !== "CASH";
    if (chargeTotal > .005 && cashInput.dataset.manual !== "1") cashInput.value = chargeTotal.toFixed(2);
  };
  form.querySelectorAll('[name^="refund_"]').forEach(input => input.addEventListener("input", () => {
    if (input.type === "checkbox") form.elements[input.name.replace("refund_","refund_qty_")].disabled = !input.checked;
    updateSummary();
  }));
  document.getElementById("correctionAddButton").addEventListener("click", () => {
    const option = sellOptions[Number(document.getElementById("correctionAddOption").value)];
    const quantity = Math.max(1, Math.min(999, Number(document.getElementById("correctionAddQty").value || 1)));
    if (!option) return;
    const existing = additions.find(line => line.option.product_id === option.product_id && line.option.variant_code === option.variant_code);
    if (existing) existing.quantity = Math.min(999, existing.quantity + quantity); else additions.push({ option, quantity });
    renderAdditions(); updateSummary();
  });
  form.elements.payment.addEventListener("change", updateSummary);
  cashInput.addEventListener("input", () => { cashInput.dataset.manual = "1"; });
  renderAdditions(); updateSummary();
}

async function loadSales() {
  const [sales,refunds]=await Promise.all([POSAuth.api("/api/sales"),POSAuth.api("/api/refunds")]);
  const salesTotal=sales.rows.slice(0,100).reduce((sum,row)=>sum+Number(row.total||0),0), refundTotal=refunds.rows.reduce((sum,row)=>sum+Number(row.refund_amount||0),0);
  const refundedBySale=refunds.rows.reduce((result,row)=>{result[row.sale_id]=(result[row.sale_id]||0)+Number(row.refund_amount||0);return result;},{});
  const adjustmentsByOriginal=sales.rows.reduce((result,row)=>{if(row.amended_from)(result[row.amended_from]||=[]).push(row);return result;},{});
  const parseItems=row=>{try{const parsed=JSON.parse(row.items||"[]");return Array.isArray(parsed)?parsed:[]}catch(_){return[]}};
  content.innerHTML=`<div class="page-toolbar"><div class="toolbar-copy"><h2>Sales history and corrections</h2><p>Recent receipts, payment attribution, amended orders, and refunds.</p></div></div><div class="kpi-grid">${kpiCard("Loaded sales",String(sales.rows.length),"Newest receipts","green","SALE")}${kpiCard("Loaded sales value",money(salesTotal),"Visible receipt rows","purple","RM")}${kpiCard("Refund records",String(refunds.rows.length),"Newest refund rows","red","REF")}${kpiCard("Refund value",money(refundTotal),"All loaded refunds","amber","−")}</div>
    <section class="content-card"><div class="card-header"><div><h3>Recent sales</h3><p>Paid receipts stay immutable. Corrections create linked refunds and adjustment receipts with a full audit trail.</p></div></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Receipt</th><th>Date & time</th><th>Table</th><th>Payment</th><th>Cashier</th><th>Status</th><th style="text-align:right">Total</th><th></th></tr></thead><tbody>${sales.rows.map(row=>{const refunded=refundedBySale[row.id]||0,remaining=Math.max(0,Number(row.total||0)-refunded),children=adjustmentsByOriginal[row.id]||[],isChild=Boolean(row.amended_from),legacyAmended=Number(row.amended||0)===1,isFoc=String(row.payment||"").toUpperCase()==="FOC";let stateHtml;if(isFoc)stateHtml=statusPill("FOC · no charge","warning");else if(isChild)stateHtml=statusPill(`Adjustment of #${row.amended_from}`,"info");else if(legacyAmended)stateHtml=statusPill("Legacy amended","warning");else if(remaining<.01&&refunded)stateHtml=statusPill("Refunded","inactive");else if(children.length)stateHtml=statusPill(`Corrected · ${children.length} linked`,"warning");else if(refunded)stateHtml=statusPill(`Part refund ${money(refunded)}`,"warning");else stateHtml=statusPill("Paid","paid");return`<tr><td class="cell-title"><strong>#${row.id}</strong>${isChild?`<small>Original #${row.amended_from}</small>`:children.length?`<small>${children.map(child=>`#${child.id}`).join(", ")} linked</small>`:""}</td><td>${escapeHtml(row.datetime)}</td><td>${escapeHtml(row.table_code||"—")}</td><td>${statusPill(row.payment||"CASH","info")}</td><td>${escapeHtml(row.cashier||"—")}</td><td>${stateHtml}</td><td class="money">${money(row.total)}</td><td class="actions"><button class="button small secondary" data-view-sale="${row.id}" type="button">View</button> ${isFoc?"":`<button class="button small amber" data-change-payment="${row.id}" type="button">Payment</button> ${!isChild&&!legacyAmended?`<button class="button small blue" data-correct-sale="${row.id}" type="button">Correct</button>`:""} ${!legacyAmended&&remaining>.005?`<button class="button small danger" data-refund-sale="${row.id}" type="button">Refund</button>`:""}`}</td></tr>`}).join("")}</tbody></table></div></div></section>
    <section class="content-card" style="margin-top:12px"><div class="card-header"><div><h3>Refund history</h3><p>Refunds remain separate from operating expenses in accounting.</p></div></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Refund</th><th>Sale</th><th>Date</th><th>Payment</th><th>Processed by</th><th>Reason</th><th style="text-align:right">Amount</th></tr></thead><tbody>${refunds.rows.map(row=>`<tr><td>#${row.id}</td><td>#${row.sale_id}</td><td>${escapeHtml(row.datetime)}</td><td>${escapeHtml(row.payment_method||"—")}</td><td>${escapeHtml(row.processed_by||"—")}</td><td>${escapeHtml(row.reason||"—")}</td><td class="money">${money(row.refund_amount)}</td></tr>`).join("")||'<tr><td colspan="7" class="empty-state">No refunds</td></tr>'}</tbody></table></div></div></section>`;
  content.querySelectorAll("[data-view-sale]").forEach(button=>button.addEventListener("click",()=>{const row=sales.rows.find(item=>item.id===Number(button.dataset.viewSale)),items=parseItems(row),listPrices=JSON.parse(row.category_list_prices || "{}");openModal({title:`Receipt #${row.id}`,eyebrow:"SALE DETAILS",submitLabel:"Close",body:`<div class="metric-list"><div class="metric-row"><span><strong>Payment</strong><small>${escapeHtml(row.cashier||"—")} · Table ${escapeHtml(row.table_code||"—")}</small></span><b>${escapeHtml(row.payment||"—")}</b></div><div class="metric-row"><span><strong>Total</strong><small>Discount ${money(row.discount)} · Tax ${money(row.tax)}</small></span><b>${money(row.total)}</b></div>${refundedBySale[row.id]?`<div class="metric-row"><span><strong>Refunded</strong><small>Remaining ${money(Number(row.total)-refundedBySale[row.id])}</small></span><b>${money(refundedBySale[row.id])}</b></div>`:""}</div><div class="refund-item-list" style="margin-top:14px">${items.map(item=>`<div class="refund-line"><span><strong>${escapeHtml(item[0])}</strong><small>${escapeHtml(item[3]||"")} · ${!String(item[0]).startsWith("[FOC] ") && Object.hasOwn(listPrices, item[3]) ? `List ${money(listPrices[item[3]])}` : money(item[1])} each</small></span><b>× ${item[2]}</b><strong>${money(Number(item[1])*Number(item[2]))}</strong></div>`).join("")||'<div class="empty-state">No readable items</div>'}</div>`,onSubmit:async()=>{}})}));
  content.querySelectorAll("[data-change-payment]").forEach(button=>button.addEventListener("click",()=>{const row=sales.rows.find(item=>item.id===Number(button.dataset.changePayment));openModal({title:`Correct payment · Receipt #${row.id}`,eyebrow:"PAYMENT CORRECTION",submitLabel:"Update payment",submitClass:"amber",body:`<div class="form-grid"><label class="form-field"><span>Current method</span><input value="${escapeHtml(row.payment||"CASH")}" disabled></label><label class="form-field"><span>Correct method</span><select name="payment"><option ${row.payment==="CASH"?"selected":""}>CASH</option><option ${row.payment==="QR"?"selected":""}>QR</option><option ${row.payment==="CARD"?"selected":""}>CARD</option></select></label><label class="form-field full"><span>Admin PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" required></label></div><p class="form-hint">The sale, daily payment totals, cashflow, and audit record update together.</p>`,onSubmit:async form=>{const result=await POSAuth.api(`/api/sales/${row.id}/payment`,{method:"POST",body:JSON.stringify({payment:fieldValue(form,"payment"),pin:fieldValue(form,"pin")})});showToast(`Payment changed to ${result.payment} by ${result.changed_by}`);await loadPage("sales");}})}));
  content.querySelectorAll("[data-correct-sale]").forEach(button=>button.addEventListener("click",async()=>{const row=sales.rows.find(item=>item.id===Number(button.dataset.correctSale));try{await openSaleCorrection(row,parseItems(row),refunds.rows)}catch(error){showToast(error.message,true)}}));
  content.querySelectorAll("[data-refund-sale]").forEach(button=>button.addEventListener("click",()=>{const row=sales.rows.find(item=>item.id===Number(button.dataset.refundSale)),items=parseItems(row).filter(item=>!String(item[0]||"").startsWith("[FOC] ")&&Number(item[1]||0)>0);openModal({title:`Refund receipt #${row.id}`,eyebrow:"REFUND MANAGEMENT",submitLabel:"Process refund",submitClass:"danger",body:`<p class="form-hint" style="margin-bottom:10px">Select only the quantities being returned. FOC replacements are audit records and cannot create a cash refund.</p><div class="refund-item-list">${items.map((item,index)=>`<label class="refund-line selectable"><input name="include_${index}" type="checkbox" checked><span><strong>${escapeHtml(item[0])}</strong><small>${money(item[1])} each · sold ${item[2]}</small></span><input name="qty_${index}" type="number" min="1" max="${Number(item[2])}" value="${Number(item[2])}"><strong data-refund-line-total>${money(Number(item[1])*Number(item[2]))}</strong></label>`).join("")}</div><div class="refund-total-preview"><span>Selected refund</span><strong id="refundPreviewTotal">RM 0.00</strong></div><div class="form-grid"><label class="form-field"><span>Reason</span><select name="reason"><option>Customer Unsatisfied</option><option>Wrong Order</option><option>Food Quality Issue</option><option>Duplicate Charge</option><option>Customer Cancelled</option><option>Other</option></select></label><label class="form-field"><span>Admin PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" required></label><label class="checkbox-field full"><input name="return_to_stock" type="checkbox" checked><span>Return tracked sellable items to stock</span></label></div>`,onSubmit:async form=>{const selected=items.flatMap((item,index)=>form.elements[`include_${index}`].checked?[{name:String(item[0]),qty:Number(form.elements[`qty_${index}`].value)}]:[]);const result=await POSAuth.api("/api/refunds",{method:"POST",body:JSON.stringify({sale_id:row.id,items:selected,reason:fieldValue(form,"reason"),pin:fieldValue(form,"pin"),return_to_stock:form.elements.return_to_stock.checked})});showToast(`Refunded ${money(result.amount)} by ${result.processed_by}`);await loadPage("sales");}});const form=document.getElementById("adminActionForm"),update=()=>{let total=0;items.forEach((item,index)=>{const enabled=form.elements[`include_${index}`].checked,qty=Math.max(0,Number(form.elements[`qty_${index}`].value||0));total+=enabled?Number(item[1])*qty:0;form.querySelectorAll("[data-refund-line-total]")[index].textContent=money(enabled?Number(item[1])*qty:0)});document.getElementById("refundPreviewTotal").textContent=money(total)};form.querySelectorAll('input[type="checkbox"],input[type="number"]').forEach(input=>input.addEventListener("input",update));update();}));
}

function payrollPeriodBounds(month) {
  const [year, monthNumber] = String(month || isoToday().slice(0,7)).split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return { start:`${year}-${String(monthNumber).padStart(2,"0")}-01`, end:`${year}-${String(monthNumber).padStart(2,"0")}-${String(lastDay).padStart(2,"0")}` };
}

function maskedPayrollValue(value) {
  const text = String(value || "").trim();
  return text ? `${"•".repeat(Math.max(4, text.length - 4))}${text.slice(-4)}` : "—";
}

function payrollStatus(status) {
  return statusPill(status, status === "PAID" ? "paid" : status === "DRAFT" ? "warning" : "inactive");
}

function payrollComplianceStatus(employee) {
  const compliance=employee?.compliance||{status:"BLOCKED",blockers:["Compliance details have not been checked."],warnings:[]};
  return {status:compliance.status||"BLOCKED",blockers:compliance.blockers||[],warnings:compliance.warnings||[]};
}

function payrollComplianceText(employee) {
  const compliance=payrollComplianceStatus(employee), messages=[...compliance.blockers,...compliance.warnings];
  return messages.length?messages.join(" "):"Identity, EPF treatment, and required documents are ready for payroll review.";
}

function payrollPaymentRecordLabel(mode) {
  return ({POSTED:"New expense",LINKED:"Linked expense",HISTORICAL:"Historical · no posting",UNRECORDED:"Not paid"})[mode]||"Not paid";
}

function openPayrollEmployeeForm(row = null) {
  openModal({
    title:row ? `Edit ${row.full_name}` : "Add payroll employee",
    eyebrow:"PAYROLL EMPLOYEE",
    submitLabel:row ? "Update employee" : "Add employee",
    wide:true,
    body:`<div class="payroll-form-section"><header><span>IDENTITY</span><div><h3>Employee details</h3><p>Payroll employees are separate from POS login accounts, so kitchen and support staff do not need system access.</p></div></header><div class="form-grid payroll-form-grid">
      <label class="form-field"><span>Employee code</span><input name="employee_code" maxlength="30" value="${escapeHtml(row?.employee_code||"")}" placeholder="EMP-001" required></label>
      <label class="form-field"><span>Full name</span><input name="full_name" maxlength="100" value="${escapeHtml(row?.full_name||"")}" required></label>
      <label class="form-field"><span>Employment type</span><select name="employment_type"><option value="FULL_TIME" ${(row?.employment_type||"FULL_TIME")==="FULL_TIME"?"selected":""}>Full-time employee</option><option value="PART_TIME" ${row?.employment_type==="PART_TIME"?"selected":""}>Part-time employee</option><option value="TEMPORARY" ${row?.employment_type==="TEMPORARY"?"selected":""}>Temporary employee</option><option value="PROBATIONARY" ${row?.employment_type==="PROBATIONARY"?"selected":""}>Probationary employee</option></select></label>
      <label class="form-field"><span>Citizenship</span><select name="citizenship_status"><option value="MALAYSIAN" ${(row?.citizenship_status||"MALAYSIAN")==="MALAYSIAN"?"selected":""}>Malaysian</option><option value="NON_MALAYSIAN" ${row?.citizenship_status==="NON_MALAYSIAN"?"selected":""}>Non-Malaysian</option></select></label>
      <label class="form-field"><span>MyKad / identification</span><input name="identification_no" maxlength="40" value="${escapeHtml(row?.identification_no||"")}"></label>
      <label class="form-field"><span>Nationality</span><input name="nationality" maxlength="80" value="${escapeHtml(row?.nationality||"")}" placeholder="Malaysia"></label>
      <label class="form-field"><span>Start date</span><input name="start_date" type="date" value="${escapeHtml(row?.start_date||"")}"></label>
      <label class="form-field"><span>Designation</span><input name="designation" maxlength="80" value="${escapeHtml(row?.designation||"")}" placeholder="Cashier"></label>
      <label class="form-field"><span>Department</span><input name="department" maxlength="80" value="${escapeHtml(row?.department||"")}" placeholder="Front of house"></label>
      <label class="form-field"><span>Default basic salary</span><input name="default_basic_salary" type="number" min="0" step="0.01" value="${Number(row?.default_basic_salary||0).toFixed(2)}"></label>
      ${row?`<label class="form-field"><span>Status</span><select name="active"><option value="1" ${row.active?"selected":""}>Active</option><option value="0" ${row.active?"":"selected"}>Inactive</option></select></label>`:""}
    </div></div>
    <div class="payroll-form-section"><header><span>DOCUMENTS</span><div><h3>Foreign-worker document control</h3><p>For non-Malaysian employees, a valid passport and work pass are required before a new salary payment can be recorded.</p></div></header><div class="form-grid payroll-form-grid"><label class="form-field"><span>Passport number</span><input name="passport_no" maxlength="60" value="${escapeHtml(row?.passport_no||"")}"></label><label class="form-field"><span>Passport expiry</span><input name="passport_expiry" type="date" value="${escapeHtml(row?.passport_expiry||"")}"></label><label class="form-field"><span>Work-pass number</span><input name="work_pass_no" maxlength="80" value="${escapeHtml(row?.work_pass_no||"")}"></label><label class="form-field"><span>Work-pass expiry</span><input name="work_pass_expiry" type="date" value="${escapeHtml(row?.work_pass_expiry||"")}"></label></div></div>
    <div class="payroll-form-section"><header><span>STATUTORY</span><div><h3>Contribution treatment and references</h3><p>Part-time, temporary, and probationary employees are generally EPF-liable. “Exempt” requires a documented official or professional basis.</p></div></header><div class="form-grid payroll-form-grid"><label class="form-field"><span>EPF treatment</span><select name="epf_treatment"><option value="REQUIRED" ${(row?.epf_treatment||"REQUIRED")==="REQUIRED"?"selected":""}>Required / contributing</option><option value="PENDING_REVIEW" ${row?.epf_treatment==="PENDING_REVIEW"?"selected":""}>Pending verification</option><option value="EXEMPT_WITH_BASIS" ${row?.epf_treatment==="EXEMPT_WITH_BASIS"?"selected":""}>Exempt with documented basis</option></select></label><label class="form-field"><span>EPF / KWSP number</span><input name="epf_no" maxlength="40" value="${escapeHtml(row?.epf_no||"")}"></label><label class="form-field"><span>SOCSO / PERKESO number</span><input name="socso_no" maxlength="40" value="${escapeHtml(row?.socso_no||"")}"></label><label class="form-field"><span>Income tax number</span><input name="tax_no" maxlength="40" value="${escapeHtml(row?.tax_no||"")}"></label><label class="form-field full"><span>Statutory basis / accountant note</span><textarea name="statutory_basis" maxlength="500" placeholder="Required when EPF treatment is marked exempt">${escapeHtml(row?.statutory_basis||"")}</textarea></label></div></div>
    <div class="payroll-form-section"><header><span>PAYMENT</span><div><h3>Bank and notes</h3><p>Sensitive values are masked in the employee list and visible only inside Admin actions and the employee’s slip.</p></div></header><div class="form-grid payroll-form-grid"><label class="form-field"><span>Bank name</span><input name="bank_name" maxlength="80" value="${escapeHtml(row?.bank_name||"")}"></label><label class="form-field"><span>Bank account</span><input name="bank_account" maxlength="60" value="${escapeHtml(row?.bank_account||"")}"></label><label class="form-field full"><span>Internal notes</span><textarea name="notes" maxlength="500">${escapeHtml(row?.notes||"")}</textarea></label></div></div>`,
    onSubmit:async form => {
      const payload = Object.fromEntries(["employee_code","full_name","identification_no","employment_type","citizenship_status","nationality","passport_no","passport_expiry","work_pass_no","work_pass_expiry","epf_treatment","statutory_basis","designation","department","epf_no","socso_no","tax_no","bank_name","bank_account","start_date","notes"].map(name=>[name,fieldValue(form,name)]));
      payload.default_basic_salary = Number(fieldValue(form,"default_basic_salary")||0);
      if (row) payload.active = Number(fieldValue(form,"active"));
      await POSAuth.api(row?`/api/payroll/employees/${row.id}`:"/api/payroll/employees", {method:row?"PUT":"POST",body:JSON.stringify(payload)});
      showToast(row?"Payroll employee updated":"Payroll employee added");
      await loadPage("payroll");
    }
  });
}

function openSalarySlipForm(employees, row = null) {
  if (!employees.length) { showToast("Add an active payroll employee first.", true); return; }
  const bounds = payrollPeriodBounds(adminState.payrollMonth || isoToday().slice(0,7));
  const selectedEmployee = employees.find(employee=>employee.id===Number(row?.employee_id)) || employees[0];
  const selectedCompliance = payrollComplianceStatus(selectedEmployee);
  const amount = name => Number(row?.[name] || 0).toFixed(2);
  const dayValue = name => Number(row?.[name] || 0);
  openModal({
    title:row ? `Edit ${row.slip_no}` : "Create salary slip",
    eyebrow:"SALARY SLIP DRAFT",
    submitLabel:row ? "Update draft" : "Create draft",
    wide:true,
    body:`<div class="payroll-compliance-banner"><span>MANUAL</span><div><strong>Confirm statutory amounts against the official employer portals.</strong><small>The system calculates gross pay, total deductions, and net pay. It does not assume one EPF/SOCSO/EIS rate for every employee.</small></div></div>
      <div class="payroll-compliance-banner employee-check ${selectedCompliance.status.toLowerCase()}" id="payrollEmployeeCompliance"><span id="payrollComplianceCode">${escapeHtml(selectedCompliance.status)}</span><div><strong id="payrollComplianceTitle">Employee payroll readiness</strong><small id="payrollComplianceMessage">${escapeHtml(payrollComplianceText(selectedEmployee))}</small></div></div>
      <div class="payroll-form-section"><header><span>PAY PERIOD</span><div><h3>Employee and dates</h3><p>One non-void slip is allowed per employee and exact pay period.</p></div></header><div class="form-grid payroll-form-grid">
        <label class="form-field full"><span>Employee</span><select name="employee_id" ${row?"disabled":""}>${employees.map(employee=>`<option value="${employee.id}" ${employee.id===selectedEmployee.id?"selected":""}>${escapeHtml(employee.employee_code)} · ${escapeHtml(employee.full_name)} · ${escapeHtml(payrollComplianceStatus(employee).status)} · default ${money(employee.default_basic_salary)}</option>`).join("")}</select></label>
        <label class="form-field"><span>Period start</span><input name="period_start" type="date" value="${escapeHtml(row?.period_start||bounds.start)}" required></label>
        <label class="form-field"><span>Period end</span><input name="period_end" type="date" value="${escapeHtml(row?.period_end||bounds.end)}" required></label>
        <label class="form-field"><span>Expected pay date</span><input name="pay_date" type="date" value="${escapeHtml(row?.pay_date||bounds.end)}" required></label>
        <label class="form-field"><span>Basic salary</span><input name="basic_salary" data-payroll-money type="number" min="0" step="0.01" value="${row?amount("basic_salary"):Number(selectedEmployee.default_basic_salary||0).toFixed(2)}" required></label>
        <label class="form-field"><span>Worked days</span><input name="worked_days" type="number" min="0" step="0.5" value="${dayValue("worked_days")}"></label>
        <label class="form-field"><span>Paid leave days</span><input name="paid_leave_days" type="number" min="0" step="0.5" value="${dayValue("paid_leave_days")}"></label>
        <label class="form-field"><span>Unpaid leave days</span><input name="unpaid_leave_days" type="number" min="0" step="0.5" value="${dayValue("unpaid_leave_days")}"></label>
        <label class="form-field"><span>Overtime hours</span><input name="overtime_hours" type="number" min="0" step="0.25" value="${dayValue("overtime_hours")}"></label>
      </div></div>
      <div class="payroll-entry-columns">
        <section class="payroll-form-section earnings"><header><span>EARNINGS</span><div><h3>Additional earnings</h3><p>Amounts added to basic salary.</p></div></header><div class="form-grid payroll-form-grid compact">
          <label class="form-field"><span>Overtime pay</span><input name="overtime_pay" data-payroll-money type="number" min="0" step="0.01" value="${amount("overtime_pay")}"></label>
          <label class="form-field"><span>Rest-day pay</span><input name="rest_day_pay" data-payroll-money type="number" min="0" step="0.01" value="${amount("rest_day_pay")}"></label>
          <label class="form-field"><span>Public-holiday pay</span><input name="public_holiday_pay" data-payroll-money type="number" min="0" step="0.01" value="${amount("public_holiday_pay")}"></label>
          <label class="form-field"><span>Allowances</span><input name="allowances" data-payroll-money type="number" min="0" step="0.01" value="${amount("allowances")}"></label>
          <label class="form-field"><span>Bonus</span><input name="bonus" data-payroll-money type="number" min="0" step="0.01" value="${amount("bonus")}"></label>
          <label class="form-field"><span>Commission</span><input name="commission" data-payroll-money type="number" min="0" step="0.01" value="${amount("commission")}"></label>
          <label class="form-field"><span>Other earnings</span><input name="other_earnings" data-payroll-money type="number" min="0" step="0.01" value="${amount("other_earnings")}"></label>
          <label class="form-field"><span>Other earnings label</span><input name="other_earnings_note" maxlength="100" value="${escapeHtml(row?.other_earnings_note||"")}" placeholder="Meal allowance"></label>
        </div></section>
        <section class="payroll-form-section deductions"><header><span>DEDUCTIONS</span><div><h3>Employee deductions</h3><p>Amounts deducted from gross pay.</p></div></header><div class="form-grid payroll-form-grid compact">
          <label class="form-field"><span>Employee EPF</span><input name="employee_epf" data-payroll-deduction type="number" min="0" step="0.01" value="${amount("employee_epf")}"></label>
          <label class="form-field"><span>Employee SOCSO</span><input name="employee_socso" data-payroll-deduction type="number" min="0" step="0.01" value="${amount("employee_socso")}"></label>
          <label class="form-field"><span>Employee EIS</span><input name="employee_eis" data-payroll-deduction type="number" min="0" step="0.01" value="${amount("employee_eis")}"></label>
          <label class="form-field"><span>PCB / tax</span><input name="pcb" data-payroll-deduction type="number" min="0" step="0.01" value="${amount("pcb")}"></label>
          <label class="form-field"><span>Salary advance</span><input name="advance" data-payroll-deduction type="number" min="0" step="0.01" value="${amount("advance")}"></label>
          <label class="form-field"><span>Unpaid-leave deduction</span><input name="unpaid_leave_deduction" data-payroll-deduction type="number" min="0" step="0.01" value="${amount("unpaid_leave_deduction")}"></label>
          <label class="form-field"><span>Other deductions</span><input name="other_deductions" data-payroll-deduction type="number" min="0" step="0.01" value="${amount("other_deductions")}"></label>
          <label class="form-field"><span>Other deduction label</span><input name="other_deductions_note" maxlength="100" value="${escapeHtml(row?.other_deductions_note||"")}" placeholder="Uniform"></label>
          <label class="form-field full"><span>Reason for zero EPF share</span><textarea name="epf_zero_reason" maxlength="300" placeholder="Required if an employee marked EPF required has zero employee or employer EPF">${escapeHtml(row?.epf_zero_reason||"")}</textarea></label>
        </div></section>
      </div>
      <div class="payroll-form-section employer"><header><span>EMPLOYER SHARE</span><div><h3>Employer statutory contributions</h3><p>Shown on the salary slip for reference; these do not reduce employee net pay.</p></div></header><div class="form-grid payroll-form-grid thirds"><label class="form-field"><span>Employer EPF</span><input name="employer_epf" type="number" min="0" step="0.01" value="${amount("employer_epf")}"></label><label class="form-field"><span>Employer SOCSO</span><input name="employer_socso" type="number" min="0" step="0.01" value="${amount("employer_socso")}"></label><label class="form-field"><span>Employer EIS</span><input name="employer_eis" type="number" min="0" step="0.01" value="${amount("employer_eis")}"></label><label class="form-field full"><span>Salary notes</span><textarea name="notes" maxlength="500">${escapeHtml(row?.notes||"")}</textarea></label></div></div>
      <div class="payroll-live-total"><div><small>GROSS PAY</small><strong id="payrollGrossPreview">${money(0)}</strong></div><i>−</i><div><small>DEDUCTIONS</small><strong id="payrollDeductionPreview">${money(0)}</strong></div><i>=</i><div class="net"><small>NET PAY</small><strong id="payrollNetPreview">${money(0)}</strong></div></div>`,
    onSubmit:async form => {
      const names=["period_start","period_end","pay_date","worked_days","paid_leave_days","unpaid_leave_days","basic_salary","overtime_hours","overtime_pay","rest_day_pay","public_holiday_pay","allowances","bonus","commission","other_earnings","other_earnings_note","employee_epf","employee_socso","employee_eis","pcb","advance","unpaid_leave_deduction","other_deductions","other_deductions_note","employer_epf","employer_socso","employer_eis","epf_zero_reason","notes"];
      const payload=Object.fromEntries(names.map(name=>[name,form.elements[name].type==="number"?Number(form.elements[name].value||0):form.elements[name].value.trim()]));
      if (!row) payload.employee_id=Number(form.elements.employee_id.value);
      await POSAuth.api(row?`/api/payroll/slips/${row.id}`:"/api/payroll/slips",{method:row?"PUT":"POST",body:JSON.stringify(payload)});
      showToast(row?"Salary-slip draft updated":"Salary-slip draft created");
      await loadPage("payroll");
    }
  });
  const form=document.getElementById("adminActionForm");
  const earningNames=["basic_salary","overtime_pay","rest_day_pay","public_holiday_pay","allowances","bonus","commission","other_earnings"];
  const deductionNames=["employee_epf","employee_socso","employee_eis","pcb","advance","unpaid_leave_deduction","other_deductions"];
  const update=()=>{const gross=earningNames.reduce((sum,name)=>sum+Number(form.elements[name].value||0),0),deductions=deductionNames.reduce((sum,name)=>sum+Number(form.elements[name].value||0),0);document.getElementById("payrollGrossPreview").textContent=money(gross);document.getElementById("payrollDeductionPreview").textContent=money(deductions);document.getElementById("payrollNetPreview").textContent=money(gross-deductions);document.getElementById("payrollNetPreview").closest(".net").classList.toggle("negative",gross-deductions<0)};
  form.querySelectorAll('input[type="number"]').forEach(input=>input.addEventListener("input",update));
  if (!row) form.elements.employee_id.addEventListener("change",()=>{const employee=employees.find(item=>item.id===Number(form.elements.employee_id.value)),compliance=payrollComplianceStatus(employee),banner=document.getElementById("payrollEmployeeCompliance");form.elements.basic_salary.value=Number(employee?.default_basic_salary||0).toFixed(2);banner.className=`payroll-compliance-banner employee-check ${compliance.status.toLowerCase()}`;document.getElementById("payrollComplianceCode").textContent=compliance.status;document.getElementById("payrollComplianceMessage").textContent=payrollComplianceText(employee);update()});
  update();
}

async function openSalarySlipPreview(slipId) {
  const data=await POSAuth.api(`/api/payroll/slips/${slipId}`), slip=data.slip, employee=data.employee, settings=data.settings, compliance=data.compliance||{};
  const earningRows=[
    ["Basic salary",slip.basic_salary],[`Overtime pay${Number(slip.overtime_hours)?` · ${slip.overtime_hours} hours`:""}`,slip.overtime_pay],["Rest-day pay",slip.rest_day_pay],["Public-holiday pay",slip.public_holiday_pay],["Allowances",slip.allowances],["Bonus",slip.bonus],["Commission",slip.commission],[slip.other_earnings_note||"Other earnings",slip.other_earnings]
  ].filter(([,value],index)=>index===0||Number(value)>0);
  const deductionRows=[["Employee EPF / KWSP",slip.employee_epf],["Employee SOCSO / PERKESO",slip.employee_socso],["Employee EIS",slip.employee_eis],["PCB / income tax",slip.pcb],["Salary advance",slip.advance],["Unpaid leave",slip.unpaid_leave_deduction],[slip.other_deductions_note||"Other deductions",slip.other_deductions]].filter(([,value])=>Number(value)>0);
  const employerRows=[["Employer EPF",slip.employer_epf],["Employer SOCSO",slip.employer_socso],["Employer EIS",slip.employer_eis]];
  modal.classList.add("wide");
  document.getElementById("adminModalEyebrow").textContent="SALARY SLIP PREVIEW";
  document.getElementById("adminModalTitle").textContent=`${slip.slip_no} · ${employee.full_name}`;
  modalBody.innerHTML=`<article class="salary-slip-sheet ${String(slip.status).toLowerCase()}">
    <div class="salary-slip-watermark">${escapeHtml(slip.status)}</div>
    <header class="salary-slip-header"><div class="salary-employer"><span>919</span><div><h2>${escapeHtml(settings.shop_name||"919 Restaurant")}</h2><p>${escapeHtml(settings.business_address||"Business address not configured")}</p><small>${settings.business_registration_no?`Registration: ${escapeHtml(settings.business_registration_no)}`:""}</small></div></div><div class="salary-slip-title"><small>SALARY SLIP</small><strong>${escapeHtml(slip.slip_no)}</strong><b>${payrollStatus(slip.status)}</b></div></header>
    <section class="salary-slip-meta"><div><small>EMPLOYEE</small><strong>${escapeHtml(employee.full_name)}</strong><span>${escapeHtml(employee.employee_code)} · ${escapeHtml(employee.designation||"No designation")}</span></div><div><small>PAY PERIOD</small><strong>${escapeHtml(slip.period_start)} — ${escapeHtml(slip.period_end)}</strong><span>Pay date ${escapeHtml(slip.pay_date)}</span></div><div><small>EMPLOYMENT</small><strong>${escapeHtml(String(employee.employment_type||"FULL_TIME").replaceAll("_"," "))}</strong><span>${escapeHtml(String(employee.citizenship_status||"MALAYSIAN").replaceAll("_"," "))} · ID ${escapeHtml(employee.identification_no||employee.passport_no||"—")}</span></div></section>
    <section class="salary-reference-grid"><span><small>EPF / KWSP NO.</small><b>${escapeHtml(employee.epf_no||"—")}</b></span><span><small>SOCSO / PERKESO NO.</small><b>${escapeHtml(employee.socso_no||"—")}</b></span><span><small>TAX NO.</small><b>${escapeHtml(employee.tax_no||"—")}</b></span><span><small>BANK</small><b>${escapeHtml(employee.bank_name||"—")} ${escapeHtml(employee.bank_account||"")}</b></span></section>
    <section class="salary-work-summary"><span><small>WORKED DAYS</small><b>${Number(slip.worked_days||0).toFixed(1)}</b></span><span><small>PAID LEAVE</small><b>${Number(slip.paid_leave_days||0).toFixed(1)}</b></span><span><small>UNPAID LEAVE</small><b>${Number(slip.unpaid_leave_days||0).toFixed(1)}</b></span><span><small>OVERTIME HOURS</small><b>${Number(slip.overtime_hours||0).toFixed(2)}</b></span></section>
    <div class="salary-money-columns"><section><header><h3>Earnings</h3><span>${money(slip.gross_pay)}</span></header>${earningRows.map(([label,value])=>`<div><span>${escapeHtml(label)}</span><b>${money(value)}</b></div>`).join("")}</section><section><header><h3>Deductions</h3><span>${money(slip.total_deductions)}</span></header>${deductionRows.map(([label,value])=>`<div><span>${escapeHtml(label)}</span><b>${money(value)}</b></div>`).join("")||'<div><span>No deductions</span><b>RM 0.00</b></div>'}</section></div>
    <section class="salary-net-banner"><span><small>GROSS PAY</small><b>${money(slip.gross_pay)}</b></span><i>−</i><span><small>TOTAL DEDUCTIONS</small><b>${money(slip.total_deductions)}</b></span><i>=</i><span class="net"><small>NET PAY</small><b>${money(slip.net_pay)}</b></span></section>
    <section class="salary-employer-contributions"><header><h3>Employer contributions</h3><p>Employer share · not deducted from net pay</p></header>${employerRows.map(([label,value])=>`<span><small>${label}</small><b>${money(value)}</b></span>`).join("")}</section>
    ${slip.epf_zero_reason?`<section class="salary-notes"><small>ZERO EPF EXPLANATION</small><p>${escapeHtml(slip.epf_zero_reason)}</p></section>`:""}
    ${slip.compliance_override_reason?`<section class="salary-notes"><small>HISTORICAL COMPLIANCE NOTE</small><p>${escapeHtml(slip.compliance_override_reason)}</p></section>`:""}
    ${compliance.status&&compliance.status!=="READY"?`<section class="salary-notes"><small>COMPLIANCE STATUS · ${escapeHtml(compliance.status)}</small><p>${escapeHtml([...(compliance.blockers||[]),...(compliance.warnings||[])].join(" "))}</p></section>`:""}
    ${slip.notes?`<section class="salary-notes"><small>NOTES</small><p>${escapeHtml(slip.notes)}</p></section>`:""}
    <footer class="salary-slip-footer"><div><small>PAYMENT</small><strong>${escapeHtml(slip.payment_method||"Not paid")} · ${escapeHtml(payrollPaymentRecordLabel(slip.payment_record_mode))}</strong><span>${slip.payment_reference?`${escapeHtml(slip.payment_reference)} · `:""}${slip.paid_by?`Recorded by ${escapeHtml(slip.paid_by)}`:"Draft · payment not recorded"}</span></div><div class="signature"><span></span><small>Employer / authorised signature</small></div><div class="signature"><span></span><small>Employee acknowledgement</small></div></footer>
    ${slip.status==="VOID"?`<div class="salary-void-reason">VOID: ${escapeHtml(slip.void_reason||"No reason recorded")} · ${escapeHtml(slip.voided_by||"")}</div>`:""}
  </article><div class="salary-preview-notice"><b>Print or Save as PDF</b><span>Use the browser print dialog. Choose your printer, or select “Save as PDF”. Paid and void slips are immutable records.</span></div><div class="dialog-actions"><button class="button secondary" id="closeSalaryPreview" type="button">Close</button><button class="button primary" id="printSalarySlip" type="button">▤ Print / Save PDF</button></div>`;
  if (!modal.open) modal.showModal();
  document.getElementById("closeSalaryPreview").addEventListener("click",()=>modal.close());
  document.getElementById("printSalarySlip").addEventListener("click",()=>{const finish=()=>document.body.classList.remove("printing-salary");document.body.classList.add("printing-salary");window.addEventListener("afterprint",finish,{once:true});window.print();setTimeout(finish,2000)});
}

function openSalaryPaymentForm(row, employee) {
  const compliance=payrollComplianceStatus(employee), hasBlockers=compliance.blockers.length>0;
  openModal({
    title:`Mark ${row.slip_no} paid`,
    eyebrow:"SALARY PAYMENT",
    submitLabel:`Record ${money(row.net_pay)} payment`,
    submitClass:"green",
    wide:true,
    body:`<div class="payroll-payment-summary"><span>NET SALARY</span><strong>${money(row.net_pay)}</strong><small>${escapeHtml(row.full_name)} · ${escapeHtml(row.period_start)} to ${escapeHtml(row.period_end)}</small></div>
      <div class="payroll-compliance-banner employee-check ${compliance.status.toLowerCase()}"><span>${escapeHtml(compliance.status)}</span><div><strong>Employee payroll readiness</strong><small>${escapeHtml(payrollComplianceText(employee))}</small></div></div>
      <div class="form-grid"><label class="form-field full"><span>How should Accounting be handled?</span><select name="record_mode"><option value="POSTED">Post a new Salary Payment expense now</option><option value="LINKED">Link an expense already recorded in Accounting</option><option value="HISTORICAL">Historical payment only · do not post another expense</option></select></label>
      <label class="form-field"><span>Actual payment date</span><input name="pay_date" type="date" max="${isoToday()}" value="${escapeHtml(row.pay_date&&row.pay_date<=isoToday()?row.pay_date:isoToday())}" required></label><label class="form-field"><span>Payment method</span><select name="payment_method"><option>BANK</option><option>CASH</option></select></label>
      <label class="form-field full" id="existingSalaryExpenseField" hidden><span>Existing Accounting expense ID</span><input name="existing_cashflow_id" type="number" min="1" step="1" placeholder="Example: 21042"></label>
      <label class="form-field full" id="salaryPaymentReferenceField"><span>Bank / voucher reference</span><input name="payment_reference" maxlength="300" placeholder="Optional transfer reference"></label>
      <label class="form-field full" id="historicalComplianceField" hidden><span>Historical compliance note</span><textarea name="compliance_override_reason" maxlength="500" placeholder="Explain why this past payment is being recorded despite incomplete employee documents or EPF review"></textarea></label>
      <label class="form-field full"><span>Admin PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" required></label></div>
      <p class="form-hint" id="salaryPaymentModeHint">A new Salary Payment expense will be posted. Use this only when the payment has actually happened and is not already in Accounting.</p>`,
    onSubmit:async form=>{
      const payload={
        pay_date:fieldValue(form,"pay_date"),payment_method:fieldValue(form,"payment_method"),
        record_mode:fieldValue(form,"record_mode"),payment_reference:fieldValue(form,"payment_reference"),
        compliance_override_reason:fieldValue(form,"compliance_override_reason"),pin:fieldValue(form,"pin"),
        existing_cashflow_id:Number(fieldValue(form,"existing_cashflow_id")||0),
      };
      const result=await POSAuth.api(`/api/payroll/slips/${row.id}/pay`,{method:"POST",body:JSON.stringify(payload)});
      showToast(`${row.slip_no} recorded by ${result.paid_by} · ${payrollPaymentRecordLabel(result.record_mode)}`);
      await loadPage("payroll");
    }
  });
  const form=document.getElementById("adminActionForm"), mode=form.elements.record_mode;
  const updateMode=()=>{
    const value=mode.value,linked=value==="LINKED",historical=value==="HISTORICAL";
    document.getElementById("existingSalaryExpenseField").hidden=!linked;
    document.getElementById("historicalComplianceField").hidden=!historical;
    form.elements.existing_cashflow_id.required=linked;
    form.elements.payment_reference.required=historical;
    form.elements.compliance_override_reason.required=historical&&hasBlockers;
    document.getElementById("salaryPaymentModeHint").textContent=linked
      ?"No new expense will be created. The selected Expense row must match the net salary exactly and will remain in Accounting if this slip is later voided."
      :historical
        ?"This creates an immutable payroll record without posting another expense. Use it only for a payment made before this payroll module or already represented by an aggregate legacy entry."
        :"A new Salary Payment expense will be posted. Use this only when the payment has actually happened and is not already in Accounting.";
  };
  mode.addEventListener("change",updateMode);updateMode();
}

async function loadPayroll() {
  adminState.payrollMonth ||= isoToday().slice(0,7);
  const [employeesData,slipsData,settingsData]=await Promise.all([POSAuth.api("/api/payroll/employees"),POSAuth.api(`/api/payroll/slips?month=${encodeURIComponent(adminState.payrollMonth)}`),POSAuth.api("/api/system/settings")]);
  const employees=employeesData.rows, activeEmployees=employees.filter(row=>row.active), blockedEmployees=activeEmployees.filter(row=>payrollComplianceStatus(row).status==="BLOCKED"), slips=slipsData.rows, summary=slipsData.summary, settings=settingsData.settings;
  const slipsTable=`<section class="content-card"><div class="card-header"><div><h3>${escapeHtml(adminState.payrollMonth)} salary slips</h3><p>Drafts can be edited. Paid slips are locked with their employee, employer, compliance, and payment snapshots.</p></div><span class="status-pill info">${slips.length} slips</span></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Slip</th><th>Employee</th><th>Period</th><th>Status</th><th>Payment</th><th style="text-align:right">Gross</th><th style="text-align:right">Deductions</th><th style="text-align:right">Net pay</th><th></th></tr></thead><tbody>${slips.map(row=>`<tr><td class="cell-title"><strong>${escapeHtml(row.slip_no)}</strong><small>Created ${escapeHtml(row.created_at.slice(0,10))}</small></td><td class="cell-title"><strong>${escapeHtml(row.full_name)}</strong><small>${escapeHtml(row.employee_code)} · ${escapeHtml(row.designation||"—")}</small></td><td>${escapeHtml(row.period_start)}<br>${escapeHtml(row.period_end)}</td><td>${payrollStatus(row.status)}</td><td class="cell-title"><strong>${escapeHtml(row.payment_method||"—")}</strong><small>${escapeHtml(payrollPaymentRecordLabel(row.payment_record_mode))}${row.cashflow_id?` · Accounting #${row.cashflow_id}`:""}</small></td><td class="money">${money(row.gross_pay)}</td><td class="money">${money(row.total_deductions)}</td><td class="money">${money(row.net_pay)}</td><td class="actions"><button class="button small secondary" data-view-payroll="${row.id}" type="button">View</button> ${row.status==="DRAFT"?`<button class="button small amber" data-edit-payroll="${row.id}" type="button">Edit</button> <button class="button small green" data-pay-payroll="${row.id}" type="button">Record payment</button>`:""} ${row.status!=="VOID"?`<button class="button small danger" data-void-payroll="${row.id}" type="button">Void</button>`:""}</td></tr>`).join("")||'<tr><td colspan="9" class="empty-state">No salary slips for this month. Create a draft when payroll is ready.</td></tr>'}</tbody></table></div></div></section>`;
  const employeesTable=`<section class="content-card"><div class="card-header"><div><h3>Payroll employees</h3><p>Only employees belong here. Genuine contractors are recorded as Accounting expenses with invoices or vouchers.</p></div><span class="status-pill info">${employees.length} employees</span></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Employee</th><th>Role</th><th>Compliance</th><th>Identifiers</th><th>Bank</th><th style="text-align:right">Default basic</th><th>Last paid period</th><th>Status</th><th></th></tr></thead><tbody>${employees.map(row=>`<tr><td class="cell-title"><strong>${escapeHtml(row.full_name)}</strong><small>${escapeHtml(row.employee_code)} · started ${escapeHtml(row.start_date||"—")}</small></td><td class="cell-title"><strong>${escapeHtml(row.designation||"—")}</strong><small>${escapeHtml(String(row.employment_type||"FULL_TIME").replaceAll("_"," "))} · ${escapeHtml(row.department||"—")}</small></td><td class="cell-title"><strong>${statusPill(payrollComplianceStatus(row).status,payrollComplianceStatus(row).status==="READY"?"active":payrollComplianceStatus(row).status==="REVIEW"?"warning":"inactive")}</strong><small title="${escapeHtml(payrollComplianceText(row))}">${escapeHtml(String(row.epf_treatment||"PENDING_REVIEW").replaceAll("_"," "))}</small></td><td class="cell-title"><strong>EPF ${maskedPayrollValue(row.epf_no)}</strong><small>ID ${maskedPayrollValue(row.identification_no||row.passport_no)}</small></td><td class="cell-title"><strong>${escapeHtml(row.bank_name||"—")}</strong><small>${maskedPayrollValue(row.bank_account)}</small></td><td class="money">${money(row.default_basic_salary)}</td><td>${escapeHtml(row.last_paid_period||"—")}</td><td>${statusPill(row.active?"Active":"Inactive",row.active?"active":"inactive")}</td><td class="actions"><button class="button small secondary" data-edit-payroll-employee="${row.id}" type="button">Edit</button></td></tr>`).join("")||'<tr><td colspan="9" class="empty-state">No payroll employees yet.</td></tr>'}</tbody></table></div></div></section>`;
  content.innerHTML=`<div class="page-toolbar"><div class="toolbar-copy"><h2>Payroll and salary slips</h2><p>Manual statutory inputs, server-calculated totals, immutable paid slips, and linked salary-payment expenses.</p></div><div class="toolbar-actions"><label class="filter-field payroll-month-field"><span>PAYROLL MONTH</span><input id="payrollMonth" type="month" value="${escapeHtml(adminState.payrollMonth)}"></label><button class="button secondary" id="payrollSetup" type="button">Payroll setup</button><button class="button secondary" id="addPayrollEmployee" type="button">＋ Employee</button><button class="button green" id="newSalarySlip" type="button" ${activeEmployees.length?"":"disabled"}>＋ Salary slip</button></div></div>
    <div class="payroll-compliance-banner page-banner"><span>CHECK</span><div><strong>This generator records approved figures and evidence; it does not decide whether a worker is exempt.</strong><small>Part-time status or a worker’s preference does not by itself remove EPF obligations. New foreign-worker payments require recorded valid passport and work-pass details. Confirm all statutory amounts with current official tables or your accountant.</small></div></div>
    <div class="kpi-grid">${kpiCard("Active employees",String(activeEmployees.length),`${blockedEmployees.length} blocked for review`,blockedEmployees.length?"amber":"green","STAFF")}${kpiCard("Draft slips",String(summary.draft_count),adminState.payrollMonth,"amber","DRAFT")}${kpiCard("Paid net salary",money(summary.paid_net),`${summary.paid_count} paid slips`,"purple","NET")}${kpiCard("Current gross pay",money(summary.gross_pay),"Excludes void slips","blue","GROSS")}</div>
    <nav class="module-tabs payroll-tabs"><button class="${adminState.payrollTab==="slips"?"active":""}" data-payroll-tab="slips" type="button">Salary slips</button><button class="${adminState.payrollTab==="employees"?"active":""}" data-payroll-tab="employees" type="button">Employees</button></nav>${adminState.payrollTab==="employees"?employeesTable:slipsTable}`;
  document.getElementById("payrollMonth").addEventListener("change",event=>{adminState.payrollMonth=event.currentTarget.value;loadPage("payroll")});
  content.querySelectorAll("[data-payroll-tab]").forEach(button=>button.addEventListener("click",()=>{adminState.payrollTab=button.dataset.payrollTab;loadPage("payroll")}));
  document.getElementById("addPayrollEmployee").addEventListener("click",()=>openPayrollEmployeeForm());
  document.getElementById("newSalarySlip").addEventListener("click",()=>openSalarySlipForm(activeEmployees));
  document.getElementById("payrollSetup").addEventListener("click",()=>openModal({title:"Payroll employer details",eyebrow:"PAYROLL SETUP",submitLabel:"Save payroll setup",body:`<div class="form-grid"><label class="form-field full"><span>Business name</span><input value="${escapeHtml(settings.shop_name||"")}" disabled></label><label class="form-field"><span>Business registration number</span><input name="business_registration_no" maxlength="80" value="${escapeHtml(settings.business_registration_no||"")}"></label><label class="form-field"><span>Employer EPF number</span><input name="employer_epf_no" maxlength="80" value="${escapeHtml(settings.employer_epf_no||"")}"></label><label class="form-field"><span>Employer SOCSO number</span><input name="employer_socso_no" maxlength="80" value="${escapeHtml(settings.employer_socso_no||"")}"></label><label class="form-field full"><span>Business address</span><textarea name="business_address" maxlength="300">${escapeHtml(settings.business_address||"")}</textarea></label></div><p class="form-hint">These details appear on every salary slip. Change the business name under System & Audit settings.</p>`,onSubmit:async form=>{const names=["business_registration_no","employer_epf_no","employer_socso_no","business_address"],values=Object.fromEntries(names.map(name=>[name,fieldValue(form,name)]));await POSAuth.api("/api/system/settings",{method:"PUT",body:JSON.stringify({settings:values})});showToast("Payroll setup saved");await loadPage("payroll")}}));
  content.querySelectorAll("[data-edit-payroll-employee]").forEach(button=>button.addEventListener("click",()=>openPayrollEmployeeForm(employees.find(row=>row.id===Number(button.dataset.editPayrollEmployee)))));
  content.querySelectorAll("[data-view-payroll]").forEach(button=>button.addEventListener("click",()=>openSalarySlipPreview(Number(button.dataset.viewPayroll)).catch(error=>showToast(error.message,true))));
  content.querySelectorAll("[data-edit-payroll]").forEach(button=>button.addEventListener("click",()=>openSalarySlipForm(employees,slips.find(row=>row.id===Number(button.dataset.editPayroll)))));
  content.querySelectorAll("[data-pay-payroll]").forEach(button=>button.addEventListener("click",()=>{const row=slips.find(item=>item.id===Number(button.dataset.payPayroll)),employee=employees.find(item=>item.id===Number(row.employee_id));openSalaryPaymentForm(row,employee)}));
  content.querySelectorAll("[data-void-payroll]").forEach(button=>button.addEventListener("click",()=>{const row=slips.find(item=>item.id===Number(button.dataset.voidPayroll)),voidCopy=row.status!=="PAID"?"This draft will be cancelled.":row.payment_record_mode==="POSTED"?"The Salary Payment expense created by Payroll will be reversed.":row.payment_record_mode==="LINKED"?"The existing linked Accounting expense will stay in Accounting; only this payroll link is removed.":"This historical payroll record has no linked expense to reverse.";openModal({title:`Void ${row.slip_no}`,eyebrow:"PAYROLL REVERSAL",submitLabel:"Void salary slip",submitClass:"danger",body:`<div class="correction-lock-banner"><span>${escapeHtml(row.status)}</span><div><strong>${escapeHtml(voidCopy)}</strong><small>The slip remains visible as VOID with the reason and Admin identity. It is never silently deleted.</small></div></div><div class="form-grid"><label class="form-field full"><span>Void reason</span><textarea name="reason" maxlength="300" required></textarea></label><label class="form-field full"><span>Admin PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" required></label></div>`,onSubmit:async form=>{const result=await POSAuth.api(`/api/payroll/slips/${row.id}/void`,{method:"POST",body:JSON.stringify({reason:fieldValue(form,"reason"),pin:fieldValue(form,"pin")})});showToast(`${row.slip_no} voided by ${result.voided_by}`);await loadPage("payroll")}})}));
}

async function loadReports() {
  const daily=await POSAuth.api("/api/reports/daily?days=30");
  content.innerHTML=`<div class="page-toolbar"><div class="toolbar-copy"><h2>Reports and export center</h2><p>Generated files include their report period and generation time.</p></div></div>
    <div class="module-grid" style="margin-bottom:13px"><button class="module-card" style="--tone:#7052aa" id="exportAccountant" type="button"><span>XLSX</span><strong>Accountant workbook</strong><small>Monthly summary and unified income/expense ledger</small></button><button class="module-card" style="--tone:#316bc6" id="exportStock" type="button"><span>XLSX</span><strong>Stock workbook</strong><small>Current stock and movement history</small></button><button class="module-card" style="--tone:#1e8a5b" id="exportRent" type="button"><span>XLSX</span><strong>Rental workbook</strong><small>Tenant status and all rental payments</small></button></div>
    <section class="content-card"><div class="card-header"><div><h3>Last 30 daily summaries</h3><p>${daily.from} to ${daily.to}</p></div></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Transactions</th><th>Cash</th><th>QR</th><th>Card</th><th>Discount</th><th style="text-align:right">Total sales</th></tr></thead><tbody>${daily.rows.map(row=>`<tr><td>${escapeHtml(row.date)}</td><td>${row.transaction_count}</td><td>${money(row.cash_total)}</td><td>${money(row.qr_total)}</td><td>${money(row.card_total)}</td><td>${money(row.total_discount)}</td><td class="money">${money(row.total_sales)}</td></tr>`).join("")||'<tr><td colspan="7" class="empty-state">No daily summaries</td></tr>'}</tbody></table></div></div></section>`;
  document.getElementById("exportAccountant").addEventListener("click",()=>openModal({title:"Export accountant workbook",eyebrow:"MONTHLY EXPORT",submitLabel:"Create XLSX",body:`<label class="form-field"><span>Report month</span><input name="month" type="month" value="${isoToday().slice(0,7)}" required></label>`,onSubmit:async form=>downloadExport(`/api/exports/accountant?month=${fieldValue(form,"month")}`)})); document.getElementById("exportStock").addEventListener("click",()=>downloadExport("/api/exports/stock").catch(error=>showToast(error.message,true))); document.getElementById("exportRent").addEventListener("click",()=>downloadExport("/api/exports/rent").catch(error=>showToast(error.message,true)));
}

async function loadStaff() {
  const data=await POSAuth.api("/api/staff"); adminState.staffRows=data.rows;
  content.innerHTML=`<div class="page-toolbar"><div class="toolbar-copy"><h2>Staff roles and workspace access</h2><p>The role defines the highest workspace a person can open.</p></div><div class="toolbar-actions"><button class="button green" id="addStaff" type="button">＋ Add staff</button></div></div>
    <div class="permission-banner"><span>R</span><div><strong>Workspace login and payment identity are different controls</strong><small>The login chooses what the station can do. The short payment PIN only identifies who physically received money. Remote Admin has no table or order-taking screen.</small></div></div>
    <section class="content-card" style="margin-bottom:12px"><div class="card-header"><div><h3>Role permission guide</h3><p>Backend APIs enforce these boundaries.</p></div></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Version</th><th>Tables & orders</th><th>Take sale payment</th><th>Cash & Rent</th><th>Stock</th><th>Accounting</th><th>Staff & System</th></tr></thead><tbody><tr><td>${statusPill("Order Only","info")}</td><td>Yes</td><td>No</td><td>No</td><td>No</td><td>No</td><td>No</td></tr><tr><td>${statusPill("Cashier","active")}</td><td>Yes</td><td>Yes</td><td>Yes</td><td>View only</td><td>No</td><td>No</td></tr><tr><td>${statusPill("Remote Admin","admin")}</td><td>No</td><td>No</td><td>Manage</td><td>Full</td><td>Full</td><td>Full</td></tr></tbody></table></div></div></section>
    <section class="content-card"><div class="card-header"><div><h3>Staff accounts</h3><p>PIN values are never displayed after saving.</p></div><span class="status-pill info">${data.rows.length} accounts</span></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Staff ID</th><th>Name</th><th>Role</th><th>Allowed workspaces</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>${data.rows.map(row=>`<tr><td>${escapeHtml(row.staff_id)}</td><td class="cell-title"><strong>${escapeHtml(row.name)}</strong><small>Database ID ${row.id}</small></td><td>${statusPill(row.role,row.role)}</td><td>${row.role==="admin"?"Admin only":row.role==="order"?"Order only":"Order · Cashier"}</td><td>${statusPill(row.active?"Active":"Inactive",row.active?"active":"inactive")}</td><td>${escapeHtml(row.created_at||"—")}</td><td class="actions"><button class="button small secondary" data-edit-staff="${row.id}" type="button">Edit</button></td></tr>`).join("")}</tbody></table></div></div></section>`;
  const staffForm=(row=null)=>{openModal({title:row?`Edit ${row.name}`:"Add staff account",eyebrow:"ACCESS CONTROL",submitLabel:row?"Update staff":"Add staff",body:`<div class="form-grid">${row?`<label class="form-field"><span>Staff ID</span><input value="${escapeHtml(row.staff_id)}" disabled></label>`:`<label class="form-field"><span>Staff ID</span><input name="staff_id" required></label>`}<label class="form-field"><span>Name</span><input name="name" value="${escapeHtml(row?.name||"")}" required></label><label class="form-field"><span>${row?"New PIN (leave blank to keep)":"Short PIN"}</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" ${row?"":"required"}></label><label class="form-field"><span>Role</span><select name="role">${data.roles.map(role=>`<option ${role===row?.role?"selected":""}>${role}</option>`).join("")}</select></label>${row?`<label class="form-field"><span>Status</span><select name="active"><option value="1" ${row.active?"selected":""}>Active</option><option value="0" ${row.active?"":"selected"}>Inactive</option></select></label>`:""}${row&&row.staff_id!=="ADMIN"?'<label class="form-field full"><span>Deletion reason (only used by Delete)</span><textarea name="delete_reason" placeholder="Required before permanently deleting this account"></textarea></label>':""}</div><p class="form-hint">Active staff PINs must be unique because PIN-only identification must resolve to one person.</p>${row&&row.staff_id!=="ADMIN"?'<div class="dialog-actions" style="justify-content:flex-start;border:0;margin:8px 0 0;padding:0"><button class="button danger" id="deleteStaffAccount" type="button">Delete staff account</button></div>':""}`,onSubmit:async form=>{const payload={name:fieldValue(form,"name"),pin:fieldValue(form,"pin"),role:fieldValue(form,"role")};if(row){if(!payload.pin)delete payload.pin;payload.active=Number(fieldValue(form,"active"));}else payload.staff_id=fieldValue(form,"staff_id");await POSAuth.api(row?`/api/staff/${row.id}`:"/api/staff",{method:row?"PUT":"POST",body:JSON.stringify(payload)});showToast(row?"Staff updated":"Staff added");await loadPage("staff");}});if(row&&row.staff_id!=="ADMIN")document.getElementById("deleteStaffAccount").addEventListener("click",async()=>{const form=document.getElementById("adminActionForm"),reason=fieldValue(form,"delete_reason");try{await POSAuth.api(`/api/staff/${row.id}`,{method:"DELETE",body:JSON.stringify({reason})});modal.close();showToast("Staff account deleted with audit reason");await loadPage("staff");}catch(error){showToast(error.message,true)}});};
  document.getElementById("addStaff").addEventListener("click",()=>staffForm()); content.querySelectorAll("[data-edit-staff]").forEach(button=>button.addEventListener("click",()=>staffForm(data.rows.find(row=>row.id===Number(button.dataset.editStaff)))));
}

async function loadSetup() {
  const [categories,tables]=await Promise.all([POSAuth.api("/api/catalog/categories"),POSAuth.api("/api/catalog/tables")]);
  content.innerHTML=`<div class="page-toolbar"><div class="toolbar-copy"><h2>Menu categories and dining tables</h2><p>Remote Admin configures these records but never opens the table or order-taking screen.</p></div></div><div class="content-grid"><section class="content-card"><div class="card-header"><div><h3>Product categories</h3><p>Order, icon, colour, active and accountant export rules</p></div><button class="button small green" id="addProductCategory" type="button">＋ Add category</button></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Order</th><th>Category</th><th>Colour</th><th>Export</th><th>Status</th><th></th></tr></thead><tbody>${categories.rows.map(row=>`<tr><td>${row.sort_order}</td><td class="cell-title"><strong>${escapeHtml(row.icon||"")} ${escapeHtml(row.name)}</strong><small>ID ${row.id}</small></td><td><span style="display:inline-block;width:12px;height:12px;background:${escapeHtml(row.color||"#ccc")};border-radius:4px;vertical-align:middle"></span> ${escapeHtml(row.color||"—")}</td><td>${row.exclude_export?"Excluded":"Included"}</td><td>${statusPill(row.active?"Active":"Inactive",row.active?"active":"inactive")}</td><td class="actions"><button class="button small secondary" data-edit-category="${row.id}" type="button">Edit</button></td></tr>`).join("")}</tbody></table></div></div></section><section class="content-card"><div class="card-header"><div><h3>Dining tables</h3><p>Active table codes and ordering priority</p></div><button class="button small green" id="addDiningTable" type="button">＋ Add table</button></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Order</th><th>Table code</th><th>Status</th><th></th></tr></thead><tbody>${tables.rows.map(row=>`<tr><td>${row.sort_order}</td><td class="cell-title"><strong>${escapeHtml(row.table_code)}</strong><small>ID ${row.id}</small></td><td>${statusPill(row.active?"Active":"Inactive",row.active?"active":"inactive")}</td><td class="actions"><button class="button small secondary" data-edit-table="${row.id}" type="button">Edit</button></td></tr>`).join("")}</tbody></table></div></div></section></div>`;
  const categoryForm=(row=null)=>openModal({title:row?`Edit ${row.name}`:"Add product category",eyebrow:"CATEGORY MANAGEMENT",submitLabel:row?"Update category":"Add category",body:`<div class="form-grid"><label class="form-field"><span>Name</span><input name="name" value="${escapeHtml(row?.name||"")}" required></label><label class="form-field"><span>Icon / emoji</span><input name="icon" value="${escapeHtml(row?.icon||"📦")}"></label><label class="form-field"><span>Colour</span><input name="color" type="color" value="${escapeHtml(row?.color||"#475569")}"></label><label class="form-field"><span>Sort order</span><input name="sort_order" type="number" step="1" value="${row?.sort_order??10}" required></label><label class="form-field"><span>Status</span><select name="active"><option value="1" ${row?.active!==0?"selected":""}>Active</option><option value="0" ${row?.active===0?"selected":""}>Inactive</option></select></label><label class="form-field"><span>Accountant export</span><select name="exclude_export"><option value="0" ${!row?.exclude_export?"selected":""}>Include</option><option value="1" ${row?.exclude_export?"selected":""}>Exclude</option></select></label><label class="checkbox-field full"><input name="show_list_price" type="checkbox" ${row?.show_list_price?"checked":""}><span>Show ${money(categories.list_price)} per item as list price</span></label></div><p class="form-hint">Checkout uses prices from Item Management.</p>${row?'<p class="form-hint">Renaming a category also updates existing item category labels.</p>':""}`,onSubmit:async form=>{await POSAuth.api(row?`/api/catalog/categories/${row.id}`:"/api/catalog/categories",{method:row?"PUT":"POST",body:JSON.stringify({name:fieldValue(form,"name"),icon:fieldValue(form,"icon"),color:fieldValue(form,"color"),sort_order:Number(fieldValue(form,"sort_order")),active:Number(fieldValue(form,"active")),exclude_export:Number(fieldValue(form,"exclude_export")),show_list_price:form.elements.show_list_price.checked})});showToast(row?"Category updated":"Category added");await loadPage("setup");}});
  const tableForm=(row=null)=>openModal({title:row?`Edit table ${row.table_code}`:"Add dining table",eyebrow:"TABLE MAINTENANCE",submitLabel:row?"Update table":"Add table",body:`<div class="form-grid"><label class="form-field"><span>Table code</span><input name="table_code" maxlength="12" value="${escapeHtml(row?.table_code||"")}" required></label><label class="form-field"><span>Sort order</span><input name="sort_order" type="number" step="1" value="${row?.sort_order??tables.rows.length+1}" required></label>${row?`<label class="form-field full"><span>Status</span><select name="active"><option value="1" ${row.active?"selected":""}>Active</option><option value="0" ${row.active?"":"selected"}>Inactive</option></select></label>`:""}</div><p class="form-hint">Inactive tables remain in history but disappear from new order selection.</p>`,onSubmit:async form=>{const payload={table_code:fieldValue(form,"table_code"),sort_order:Number(fieldValue(form,"sort_order"))};if(row)payload.active=Number(fieldValue(form,"active"));await POSAuth.api(row?`/api/catalog/tables/${row.id}`:"/api/catalog/tables",{method:row?"PUT":"POST",body:JSON.stringify(payload)});showToast(row?"Table updated":"Table added");await loadPage("setup");}});
  document.getElementById("addProductCategory").addEventListener("click",()=>categoryForm());content.querySelectorAll("[data-edit-category]").forEach(button=>button.addEventListener("click",()=>categoryForm(categories.rows.find(row=>row.id===Number(button.dataset.editCategory)))));
  document.getElementById("addDiningTable").addEventListener("click",()=>tableForm());content.querySelectorAll("[data-edit-table]").forEach(button=>button.addEventListener("click",()=>tableForm(tables.rows.find(row=>row.id===Number(button.dataset.editTable)))));
}

async function loadSystem() {
  const [status,settings,audit]=await Promise.all([POSAuth.api("/api/system/status"),POSAuth.api("/api/system/settings"),POSAuth.api("/api/system/audit?limit=300")]); const s=settings.settings;
  content.innerHTML=`<div class="page-toolbar"><div class="toolbar-copy"><h2>Database, backup, settings, and audit</h2><p>The exact active database path is always visible here.</p></div><div class="toolbar-actions"><button class="button green" id="backupNow" type="button">Backup now</button><button class="button secondary" id="editSettings" type="button">Edit settings</button></div></div><div class="kpi-grid">${kpiCard("Database integrity",String(status.integrity).toUpperCase(),"SQLite quick_check","green","DB")}${kpiCard("Database size",`${(status.database_size/1024/1024).toFixed(1)} MB`,`${status.table_count} tables · ${status.journal_mode}`,"purple","SIZE")}${kpiCard("Web schema",`Version ${status.schema_version}`,"Safe migration metadata","amber","VER")}${kpiCard("Active unpaid orders",String(status.active_orders),"Persisted across restart","blue","ORD")}</div>
    <div class="content-grid"><section class="content-card"><div class="card-header"><div><h3>System identity</h3><p>Use this to confirm which installation is open.</p></div></div><div class="card-body metric-list"><div class="metric-row"><span><strong>Active database</strong><small>${escapeHtml(status.database_path)}</small></span><b>${status.integrity}</b></div><div class="metric-row"><span><strong>Backup directory</strong><small>${escapeHtml(status.backup_directory)}</small></span><b>${settings.settings.backup_retention_days||30} days</b></div><div class="metric-row"><span><strong>Latest verified backup</strong><small>${escapeHtml(status.latest_backup_at||"No backup timestamp")}</small></span><b>${escapeHtml(status.latest_backup||"None")}</b></div><div class="metric-row"><span><strong>Item photo archive</strong><small>Created beside a database backup when product photos exist</small></span><b>${escapeHtml(status.latest_backup_images||"No photos in latest backup")}</b></div><div class="metric-row"><span><strong>Shop</strong><small>${escapeHtml(s.currency||"RM")} · Business day ${escapeHtml(s.business_day_start||"06:00")}</small></span><b>${escapeHtml(s.shop_name||"919")}</b></div><div class="metric-row"><span><strong>Language</strong><small>Default interface preference</small></span><b>${escapeHtml(s.language||"en")}</b></div></div></section><section class="content-card"><div class="card-header"><div><h3>Backup policy</h3><p>Backups use SQLite’s consistent online backup operation.</p></div></div><div class="card-body"><p class="form-hint">${status.automatic_backups?"A verified startup backup is created when the newest automatic backup is older than the configured interval.":"Automatic backups are disabled by server configuration."} Product photos are archived beside each database backup when photos exist. Manual backups are recorded in the audit log.</p><button class="button green" id="backupNowCard" type="button" style="width:100%;margin-top:12px">Create verified backup now</button></div></section></div>
    <section class="content-card" style="margin-top:12px"><div class="card-header"><div><h3>Audit log</h3><p>Login, finance, rent, stock, staff, settings, and backup actions</p></div><span class="status-pill info">Newest ${audit.rows.length}</span></div><div class="card-body flush"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>ID</th><th>Timestamp</th><th>Action</th><th>User</th><th>Details</th></tr></thead><tbody>${audit.rows.map(row=>`<tr><td>${row.id}</td><td>${escapeHtml(row.timestamp)}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.user||"—")}</td><td>${escapeHtml(row.details||"—")}</td></tr>`).join("")}</tbody></table></div></div></section>`;
  const doBackup=async()=>{try{const result=await POSAuth.api("/api/system/backup",{method:"POST",body:"{}"});showToast(`Backup created${result.item_images_path?" with item photos":""}: ${result.path}`);await loadPage("system");}catch(error){showToast(error.message,true)}}; document.getElementById("backupNow").addEventListener("click",doBackup);document.getElementById("backupNowCard").addEventListener("click",doBackup);
  document.getElementById("editSettings").addEventListener("click",()=>openModal({title:"System settings",eyebrow:"ADMIN SETTINGS",submitLabel:"Save settings",body:`<div class="form-grid"><label class="form-field"><span>Shop name</span><input name="shop_name" value="${escapeHtml(s.shop_name||"")}"></label><label class="form-field"><span>Currency</span><input name="currency" value="${escapeHtml(s.currency||"RM")}"></label><label class="form-field"><span>Business day start</span><input name="business_day_start" type="time" value="${escapeHtml(s.business_day_start||"06:00")}"></label><label class="form-field"><span>Language</span><select name="language"><option value="en" ${s.language==="en"?"selected":""}>English</option><option value="zh" ${s.language==="zh"?"selected":""}>Chinese</option><option value="both" ${s.language==="both"?"selected":""}>Both</option></select></label><label class="form-field"><span>Backup retention days</span><input name="backup_retention_days" type="number" min="1" value="${escapeHtml(s.backup_retention_days||"30")}"></label><label class="form-field full"><span>Receipt footer</span><textarea name="receipt_footer">${escapeHtml(s.receipt_footer||"")}</textarea></label></div>`,onSubmit:async form=>{const names=["shop_name","currency","business_day_start","language","backup_retention_days","receipt_footer"];const values=Object.fromEntries(names.map(name=>[name,fieldValue(form,name)]));await POSAuth.api("/api/system/settings",{method:"PUT",body:JSON.stringify({settings:values})});showToast("Settings updated");await loadPage("system");}}));
}

const loaders = { overview:loadOverview, accounting:loadAccounting, cash:loadCash, rent:loadRent, stock:loadStock, sales:loadSales, payroll:loadPayroll, reports:loadReports, staff:loadStaff, setup:loadSetup, system:loadSystem };

async function loadPage(page) {
  const allowedPages = workspacePages[adminState.session?.mode] || [];
  if (!allowedPages.includes(page)) {
    page = allowedPages[0] || "cash";
    history.replaceState(null, "", `/admin?page=${page}`);
  }
  adminState.page = page; setPageHeader(page); loading(); closeMobileMenu();
  try { await loaders[page](); }
  catch (error) { pageError(error); }
  finally {
    if (adminEmbeddedMode && window.parent !== window) {
      window.parent.postMessage({ type:"919-cashier-tool-ready", page }, window.location.origin);
    }
  }
}

function openMobileMenu() { document.getElementById("adminSidebar").classList.add("open"); document.getElementById("sidebarBackdrop").classList.add("open"); }
function closeMobileMenu() { document.getElementById("adminSidebar").classList.remove("open"); document.getElementById("sidebarBackdrop").classList.remove("open"); }

document.querySelectorAll("[data-admin-page]").forEach(button=>button.addEventListener("click",()=>loadPage(button.dataset.adminPage)));
document.getElementById("mobileMenuButton").addEventListener("click",openMobileMenu); document.getElementById("sidebarBackdrop").addEventListener("click",closeMobileMenu); document.getElementById("adminModalClose").addEventListener("click",()=>modal.close());
document.getElementById("adminLogout").addEventListener("click",()=>POSAuth.logout());
document.getElementById("returnToPos").addEventListener("click",()=>{if(adminState.session?.mode==="cashier")window.location.href="/pos";else POSAuth.switchMode("cashier").catch(error=>showToast(error.message,true));});
document.getElementById("sessionPerson").addEventListener("click",()=>{const mode=adminState.session?.mode||"cashier";openModal({title:`Active ${modeName(mode)} session`,eyebrow:"WORKSPACE IDENTITY",submitLabel:"Close",body:`<div class="metric-list"><div class="metric-row"><span><strong>Logged in staff</strong><small>${escapeHtml(adminState.session?.staff_id||"")}</small></span><b>${escapeHtml(adminState.session?.name||"")}</b></div><div class="metric-row"><span><strong>Role</strong><small>Maximum permission</small></span><b>${escapeHtml(adminState.session?.role||"")}</b></div><div class="metric-row"><span><strong>Workspace</strong><small>Current station mode</small></span><b>${escapeHtml(modeName(mode).toUpperCase())}</b></div></div><p class="form-hint" style="margin-top:14px">The workspace controls available tools. The payment PIN records who received a checkout and does not silently change this session.</p>`,onSubmit:async()=>{}})});

(async()=>{
  const session=await POSAuth.requireSession(["cashier","admin"]); if(!session)return;
  adminState.session=session;
  const allowedPages=workspacePages[session.mode]||[];
  document.querySelectorAll("[data-admin-page]").forEach(button=>{button.hidden=!allowedPages.includes(button.dataset.adminPage)});
  document.querySelectorAll(".admin-nav .nav-section").forEach(section=>{let next=section.nextElementSibling,hasVisible=false;while(next&&!next.classList.contains("nav-section")){if(next.matches("[data-admin-page]")&&!next.hidden)hasVisible=true;next=next.nextElementSibling;}section.hidden=!hasVisible;});
  const identity=document.getElementById("managementWorkspaceIdentity");identity.classList.toggle("admin-mode",session.mode==="admin");identity.classList.toggle("cashier-mode",session.mode==="cashier");
  document.getElementById("returnToPos").hidden=session.mode==="admin";
  document.getElementById("managementModeLetter").textContent=session.mode==="admin"?"A":"C";document.getElementById("managementModeLabel").textContent=session.mode==="admin"?"Admin · Full access":"Cashier · Cash, rent, stock view";
  document.getElementById("sessionName").textContent=session.name;document.getElementById("sessionRole").textContent=`${session.role.toUpperCase()} · ${modeName(session.mode).toUpperCase()}`;document.getElementById("sessionAvatar").textContent=initials(session.name);
  try{const status=await POSAuth.api("/api/public/status");adminState.businessDate=status.business_date;adminState.currency=status.currency||"RM";document.getElementById("adminShopName").textContent=status.shop_name||"919 Restaurant";document.title=`${status.shop_name||"919 Restaurant"} · Admin`;document.getElementById("adminBusinessDate").textContent=new Date(`${status.business_date}T12:00:00`).toLocaleDateString("en-MY",{day:"2-digit",month:"short",year:"numeric"});}catch(_){adminState.businessDate=new Date().toISOString().slice(0,10)}
  document.body.classList.remove("session-loading");
  const initialPage=adminUrlParams.get("page");await loadPage(loaders[initialPage]&&allowedPages.includes(initialPage)?initialPage:allowedPages[0]);
})();
