let products = [];
let categories = [{ name: "All", icon: "⌂", color: "#314866" }];
let tables = [];
let productVariants = {};

const translations = {
  en: {
    pointOfSale: "Point of Sale", currentTable: "Current table", table: "Table", businessDate: "Business date",
    cashier: "Cashier", owner: "Owner", categories: "Categories", mainTables: "Main Tables", liveStock: "Live stock",
    recentTables: "Recent tables", viewAll: "View all", currentOrder: "CURRENT ORDER", order: "Order",
    item: "Item", qty: "Qty", amount: "Amount", addOrderNote: "Add order note", subtotal: "Subtotal",
    discount: "Discount", total: "TOTAL", clear: "Clear", hold: "Hold", printBill: "Print bill", orderActions: "ORDER ACTIONS", takePayment: "TAKE PAYMENT", payWith: "PAY WITH", cash: "CASH",
    tableLayout: "TABLE LAYOUT", selectTableStart: "Select a table to start an order", tableHomeHint: "Free tables start a new order. Unpaid tables resume their existing bill.",
    refresh: "Refresh", newOrder: "New order", available: "Free", unpaidOrders: "Unpaid tables", unpaidTotal: "Unpaid total",
    mainDining: "Main dining area", unpaid: "Unpaid", needsAttention: "NEEDS ATTENTION", viewHeldOrders: "View all unpaid tables", businessDay: "Business day",
    chooseOption: "CHOOSE AN OPTION", variantHint: "Select the size or packaging before adding this product.", quantity: "QUANTITY", howMany: "How many?", lineTotal: "LINE TOTAL", addToOrder: "Add to order"
  },
  zh: {
    pointOfSale: "收银系统", currentTable: "当前桌号", table: "桌号", businessDate: "营业日期",
    cashier: "收银员", owner: "老板", categories: "商品分类", mainTables: "主桌位", liveStock: "实时库存",
    recentTables: "近期桌位", viewAll: "查看全部", currentOrder: "当前订单", order: "订单",
    item: "商品", qty: "数量", amount: "金额", addOrderNote: "添加订单备注", subtotal: "小计",
    discount: "折扣", total: "总额", clear: "清空", hold: "挂单", printBill: "打印账单", orderActions: "订单操作", takePayment: "收款", payWith: "付款方式", cash: "现金",
    tableLayout: "桌位布局", selectTableStart: "选择桌位开始点单", tableHomeHint: "空桌开启新订单；未结桌位继续现有账单。",
    refresh: "刷新", newOrder: "新订单", available: "空桌", unpaidOrders: "未结桌位", unpaidTotal: "未结总额",
    mainDining: "主用餐区", unpaid: "未结", needsAttention: "需要处理", viewHeldOrders: "查看所有未结桌位", businessDay: "营业日",
    chooseOption: "选择选项", variantHint: "添加商品前请选择规格或包装。", quantity: "数量", howMany: "需要几个？", lineTotal: "小计", addToOrder: "加入订单"
  }
};

const state = {
  category: "All",
  search: "",
  table: "15",
  orderId: null,
  orderVersion: 0,
  orderNumber: "NEW",
  orderUpdatedAt: "",
  orderNote: "",
  orderDirty: false,
  localRevision: 0,
  language: "en",
  discount: 0,
  variantProductId: null,
  selectedVariantCode: null,
  variantQuantity: 1,
  focSourceKey: null,
  currentStaff: null,
  sessionMode: "cashier",
  sessionModes: ["cashier"],
  paymentStaff: null,
  paymentAuthorization: null,
  pendingPaymentMethod: null,
  checkoutKey: null,
  lastReceipt: null,
  settings: { shop_name:"919 Restaurant", currency:"RM", business_day_start:"06:00", receipt_footer:"Thank you" },
  businessDate: "",
  cart: []
};

const money = value => `${state.settings.currency || "RM"} ${Number(value || 0).toFixed(2)}`;
const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const setText = (id, value) => {
  const element = byId(id);
  if (element) element.textContent = value;
};

function applyShopSettings() {
  const shopName = state.settings.shop_name || "919 Restaurant";
  const currency = state.settings.currency || "RM";
  setText("posShopName", shopName);
  setText("checkBillShopName", shopName.toUpperCase());
  setText("paidReceiptShopName", shopName.toUpperCase());
  setText("paidReceiptFooter", state.settings.receipt_footer || "Thank you");
  ["totalCurrencyIcon", "cashPaymentCurrency", "cashReceivedCurrency", "discountCurrency"].forEach(id => setText(id, currency));
  const match = /^(\d{2}):(\d{2})$/.exec(state.settings.business_day_start || "06:00");
  if (match) {
    const startMinutes = Number(match[1]) * 60 + Number(match[2]);
    const endMinutes = (startMinutes + 24 * 60 - 1) % (24 * 60);
    const end = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
    setText("businessWindowLabel", `${match[0]} today - ${end} ${startMinutes ? "tomorrow" : "today"}`);
  }
  document.title = `${shopName} POS`;
}

function activeTable() {
  return tables.find(table => table.id === state.table);
}

function copyCart(cart = []) {
  return cart.map(line => ({ ...line }));
}

function loadTableOrder(tableId) {
  const table = tables.find(item => item.id === tableId);
  if (!table) return;
  state.orderId = table.orderId || null;
  state.orderVersion = table.orderVersion || 0;
  state.orderNumber = table.orderNumber || "NEW";
  state.orderUpdatedAt = table.orderUpdatedAt || "";
  state.orderNote = table.note || "";
  state.cart = copyCart(table.cart || []);
  state.discount = table.discount || 0;
  state.orderDirty = false;
  setText("orderNumber", state.orderNumber === "NEW" ? "NEW" : `#${state.orderNumber}`);
  updateOrderNoteButton();
  updateOrderSaveStatus("saved");
}

function syncActiveTableOrder() {
  const table = activeTable();
  if (!table) return;
  const total = Math.max(0, cartSubtotal() - state.discount);
  table.cart = copyCart(state.cart);
  table.discount = state.discount;
  table.total = total;
  table.status = state.cart.length ? "unpaid" : "free";
  table.orderId = state.orderId;
  table.orderVersion = state.orderVersion;
  table.orderNumber = state.orderNumber;
  table.orderUpdatedAt = state.orderUpdatedAt;
  table.note = state.orderNote;
  setText("orderNumber", state.orderNumber === "NEW" ? "NEW" : `#${state.orderNumber}`);
}

let orderSaveTimer = null;
let activeOrderSave = null;

function updateOrderSaveStatus(status, detail = "") {
  const element = byId("orderSaveStatus");
  if (!element) return;
  const labels = { saved:"Saved", saving:"Saving…", unsaved:"Unsaved", error:"Not saved" };
  element.className = `order-save-status ${status}`;
  element.textContent = detail || labels[status] || status;
}

function updateOrderNoteButton() {
  const label = byId("orderNoteLabel");
  if (!label) return;
  label.textContent = state.orderNote ? state.orderNote : translations[state.language]?.addOrderNote || "Add order note";
  byId("addNoteButton")?.classList.toggle("has-note", Boolean(state.orderNote));
}

function markOrderDirty() {
  state.orderDirty = true;
  state.localRevision += 1;
  updateOrderSaveStatus("unsaved");
  clearTimeout(orderSaveTimer);
  orderSaveTimer = setTimeout(() => persistCurrentOrder().catch(() => {}), 350);
}

function currentOrderPayload() {
  return {
    table_code: state.table,
    expected_version: state.orderVersion,
    discount: state.discount,
    note: state.orderNote,
    items: state.cart.map(line => ({
      product_id: line.productId,
      quantity: line.qty,
      variant_code: line.variantCode || null,
      is_foc: Boolean(line.isFoc),
      foc_reason: line.isFoc ? line.focReason : null
    }))
  };
}

function applySavedOrder(order, replaceCart = false, updateCurrent = true) {
  const table = tables.find(item => normalizedTable(item.id) === normalizedTable(order.table_code));
  if (!table) return;
  if (String(order.status || "HELD").toUpperCase() !== "HELD") {
    Object.assign(table, {
      status:"free", total:0, orderId:null, orderVersion:0, orderNumber:null,
      orderUpdatedAt:String(order.updated_at || ""), note:"", discount:0, cart:[]
    });
    if (updateCurrent && normalizedTable(state.table) === normalizedTable(table.id)) {
      resetCurrentOrderState();
      renderTableHome();
      renderTableDialog();
    }
    return;
  }
  table.orderId = order.id;
  table.orderVersion = order.version;
  table.orderNumber = order.order_number;
  table.orderUpdatedAt = order.updated_at;
  table.note = order.note || "";
  table.discount = Number(order.discount || 0);
  table.total = Number(order.total || 0);
  table.status = order.status === "HELD" ? "unpaid" : "free";
  table.cart = (order.items || []).map(line => ({
    key: line.line_key,
    productId: Number(line.product_id),
    qty: Number(line.quantity),
    variantCode: line.variant_code || null,
    variantName: line.variant_name || null,
    price: Number(line.unit_price),
    displayName: line.display_name || line.item_name,
    isFoc: Boolean(line.is_foc),
    focReason: line.foc_reason || null
  }));
  if (!updateCurrent || normalizedTable(state.table) !== normalizedTable(table.id)) return;
  state.orderId = order.id;
  state.orderVersion = order.version;
  state.orderNumber = order.order_number;
  state.orderUpdatedAt = order.updated_at;
  if (replaceCart) {
    state.cart = copyCart(table.cart);
    state.orderNote = table.note;
    state.discount = table.discount;
    state.orderDirty = false;
    renderCart(false);
    updateOrderNoteButton();
  }
  syncActiveTableOrder();
}

async function persistCurrentOrder({ force = false } = {}) {
  clearTimeout(orderSaveTimer);
  if (activeOrderSave) {
    await activeOrderSave;
    if (force && state.orderDirty) return persistCurrentOrder({ force:true });
    return state.orderId;
  }
  if (!state.orderDirty) return state.orderId;
  const revision = state.localRevision;
  const orderIdAtStart = state.orderId;
  const payload = currentOrderPayload();
  updateOrderSaveStatus("saving");
  activeOrderSave = (async () => {
    try {
      if (!payload.items.length) {
        if (orderIdAtStart) {
          await POSAuth.api(`/api/pos/orders/${orderIdAtStart}/cancel`, {
            method:"POST",
            body:JSON.stringify({ expected_version:payload.expected_version, reason:"All order items removed" })
          });
        }
        if (state.localRevision === revision) {
          state.orderId = null;
          state.orderVersion = 0;
          state.orderNumber = "NEW";
          state.orderUpdatedAt = "";
          state.orderDirty = false;
          syncActiveTableOrder();
          updateOrderSaveStatus("saved", "Empty · not saved");
        }
        return null;
      }
      const result = await POSAuth.api(orderIdAtStart ? `/api/pos/orders/${orderIdAtStart}` : "/api/pos/orders", {
        method:orderIdAtStart ? "PUT" : "POST",
        body:JSON.stringify(payload)
      });
      applySavedOrder(result.order, false);
      if (state.localRevision === revision) {
        state.orderDirty = false;
        updateOrderSaveStatus("saved");
      } else {
        updateOrderSaveStatus("unsaved");
      }
      renderRecentTables();
      return result.order.id;
    } catch (error) {
      if (error.status === 409 && error.payload?.current_order) {
        applySavedOrder(error.payload.current_order, true);
        state.orderDirty = false;
        showToast("This table changed on another device. The latest saved order was loaded.");
      } else {
        updateOrderSaveStatus("error");
        showToast(`Order not saved: ${error.message}`);
      }
      throw error;
    } finally {
      activeOrderSave = null;
      if (state.orderDirty && state.localRevision !== revision) {
        clearTimeout(orderSaveTimer);
        orderSaveTimer = setTimeout(() => persistCurrentOrder().catch(() => {}), 250);
      }
    }
  })();
  const result = await activeOrderSave;
  if (force && state.orderDirty) return persistCurrentOrder({ force:true });
  return result;
}

async function flushCurrentOrder() {
  clearTimeout(orderSaveTimer);
  if (state.orderDirty) await persistCurrentOrder({ force:true });
  else if (activeOrderSave) await activeOrderSave;
  return state.orderId;
}

const normalizedName = value => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const normalizedTable = value => String(value || "").replace(/^0+(?=\d)/, "");

async function loadLiveCatalog() {
  try {
    await flushCurrentOrder();
    const catalog = await POSAuth.api("/api/pos/catalog");
    const orderData = await POSAuth.api("/api/pos/orders");
    state.businessDate = String(orderData.business_date || "");
    startClock();
    state.settings = { ...state.settings, ...(catalog.settings || {}) };
    applyShopSettings();
    const liveProducts = catalog.items.map(row => ({
      id: Number(row.id),
      name: String(row.name),
      category: String(row.category || "Other"),
      price: Number(row.price || 0),
      listPrice: row.list_unit_price ?? null,
      stock: row.track_stock ? Number(row.stock || 0) : null,
      trackStock: Boolean(row.track_stock),
      imagePath: row.image_path || "",
      variants: false
    }));

    const liveVariants = {};
    const itemById = new Map(liveProducts.map(item => [item.id, item]));
    (catalog.variants || []).forEach(row => {
      const item = itemById.get(Number(row.item_id));
      if (!item) return;
      (liveVariants[item.id] ||= []).push({
        code: `variant-${row.id}`,
        name: String(row.variant_name),
        detail: `${row.variant_name} option`,
        price: Number(item.price) + Number(row.price_adjustment || 0)
      });
    });
    (catalog.quantity_sets || []).forEach(row => {
      const item = itemById.get(Number(row.item_id));
      if (!item) return;
      const options = (liveVariants[item.id] ||= []);
      if (!options.length) options.push({ code:"single", name:"Single", detail:"1 item", price:Number(item.price) });
      options.push({ code:`set-${row.id}`, name:`Set of ${row.quantity}`, detail:`${row.quantity} items`, price:Number(row.set_price || 0) });
    });
    liveProducts.forEach(item => { item.variants = Boolean(liveVariants[item.id]?.length); });

    const categoryRows = catalog.categories.filter(row => liveProducts.some(item => item.category === row.name));
    categories = [{ name:"All", icon:"⌂", color:"#314866" }, ...categoryRows.map(row => ({
      name:String(row.name), icon:String(row.icon || "📦"), color:String(row.color || "#64748B")
    }))];
    products = liveProducts;
    productVariants = liveVariants;

    tables = catalog.tables.map(row => ({
      id:String(row.table_code), status:"free", total:0, orderId:null, orderVersion:0,
      orderNumber:null, orderUpdatedAt:"", note:"", discount:0, cart:[]
    }));
    (orderData.orders || []).forEach(order => applySavedOrder(order, false, false));
    const selected = tables.find(table => normalizedTable(table.id) === normalizedTable(state.table)) || tables[0];
    if (selected) {
      state.table = selected.id;
      loadTableOrder(selected.id);
      setText("activeTable", selected.id);
      setText("orderTable", selected.id);
    }
    return true;
  } catch (error) {
    console.error("Live POS data unavailable", error);
    products = [];
    categories = [{ name:"All", icon:"⌂", color:"#314866" }];
    tables = [];
    state.cart = [];
    updateOrderSaveStatus("error", "Database unavailable");
    showToast(`Live POS unavailable: ${error.message}`);
    return false;
  }
}

function renderCategories() {
  const list = byId("categoryList");
  setText("categoryCount", Math.max(0, categories.length - 1));
  list.innerHTML = categories.map(category => {
    const count = category.name === "All" ? products.length : products.filter(product => product.category === category.name).length;
    return `<button class="category-button ${state.category === category.name ? "active" : ""}" data-category="${escapeHtml(category.name)}" type="button">
      <span class="category-icon">${escapeHtml(category.icon)}</span><span class="category-name">${escapeHtml(category.name)}</span><span class="category-count">${count}</span>
    </button>`;
  }).join("");

  list.querySelectorAll("[data-category]").forEach(button => button.addEventListener("click", () => {
    state.category = button.dataset.category;
    renderCategories();
    renderProducts();
  }));
}

function filteredProducts() {
  const query = state.search.toLowerCase();
  return products.filter(product =>
    (state.category === "All" || product.category === state.category) && product.name.toLowerCase().includes(query)
  );
}

function renderProducts() {
  const visible = filteredProducts();
  byId("productTitle").textContent = state.category === "All" ? "All products" : state.category;
  byId("productSubtitle").textContent = `${visible.length} products · tap to add to order`;
  const grid = byId("productGrid");
  grid.innerHTML = visible.map(product => {
    const category = categories.find(item => item.name === product.category) || { color:"#64748B", icon:"📦" };
    const low = product.stock !== null && product.stock > 0 && product.stock <= 6;
    const out = product.stock === 0;
    const stockText = product.stock === null ? "No tracking" : out ? "OUT" : `Stock ${product.stock}`;
    return `<button class="product-card ${low ? "low" : ""} ${out ? "out" : ""}" data-product-id="${product.id}" style="--category-color:${category.color}" type="button" ${out ? "disabled" : ""}>
      ${product.variants ? '<span class="variant-mark">OPTIONS</span>' : ""}
      <div class="product-card-main"><span class="product-image">${product.imagePath?`<img src="${escapeHtml(product.imagePath)}" alt="" loading="lazy">`:`<b>${escapeHtml(category.icon || "📦")}</b>`}</span><h3>${escapeHtml(product.name)}</h3></div>
      <div class="product-meta"><span class="product-price">${product.listPrice == null ? money(product.price) : `List ${money(product.listPrice)}`}</span><span class="stock-badge ${low ? "low" : ""} ${out ? "out" : ""}">${stockText}</span></div>
    </button>`;
  }).join("") || '<div class="empty-cart"><div><span>⌕</span><p>No products found</p></div></div>';

  grid.querySelectorAll("[data-product-id]").forEach(button => button.addEventListener("click", () => {
    const productId = Number(button.dataset.productId);
    const product = products.find(item => item.id === productId);
    if (product.variants) openVariantDialog(productId);
    else addProduct(productId);
  }));
}

function addProduct(productId, variant = null, quantity = 1) {
  const key = variant ? `${productId}-${variant.code}` : String(productId);
  const line = state.cart.find(item => item.key === key && !item.isFoc);
  if (line) line.qty += 1;
  else state.cart.push({
    key,
    productId,
    qty: quantity,
    variantCode: variant?.code || null,
    variantName: variant?.name || null,
    price: variant?.price ?? null
  });
  if (line && quantity > 1) line.qty += quantity - 1;
  markOrderDirty();
  renderCart();
  const product = products.find(item => item.id === productId);
  showToast(`${product.name}${variant ? ` · ${variant.name}` : ""} added to Table ${state.table}`);
}

function updateQuantity(key, delta) {
  const line = state.cart.find(item => item.key === key);
  if (!line) return;
  line.qty += delta;
  if (line.qty <= 0) state.cart = state.cart.filter(item => item.key !== key);
  markOrderDirty();
  renderCart();
}

function cartSubtotal() {
  return state.cart.reduce((sum, line) => {
    if (line.isFoc) return sum;
    const product = products.find(item => item.id === line.productId);
    return sum + (line.price ?? product?.price ?? 0) * line.qty;
  }, 0);
}

function unitPriceLabel(price, listPrice, isFoc, focLabel) {
  if (isFoc) return `Normal ${money(price)} · ${focLabel}`;
  return listPrice == null ? `${money(price)} each` : `List ${money(listPrice)} each`;
}

function renderCart() {
  const list = byId("cartList");
  if (!state.cart.length) {
    list.innerHTML = '<div class="empty-cart"><div><span>▣</span><p>Tap a product to start this order</p></div></div>';
  } else {
    list.innerHTML = state.cart.map(line => {
      const product = products.find(item => item.id === line.productId);
      const price = line.price ?? product?.price ?? 0;
      const name = product?.name || line.displayName || "Unavailable item";
      const displayPrice = line.isFoc ? 0 : price;
      return `<div class="cart-row ${line.isFoc ? "foc-row" : ""}">
        <div class="cart-item"><h3>${line.isFoc ? '<span class="foc-badge">FOC</span>' : ""}${escapeHtml(name)}${line.variantName ? ` · ${escapeHtml(line.variantName)}` : ""}</h3><p>${unitPriceLabel(price, product?.listPrice, line.isFoc, `customer pays ${money(0)}`)}</p>${line.isFoc ? `<p class="foc-reason">${escapeHtml(line.focReason || "Reason required")}</p>` : ""}</div>
        <div class="quantity-control"><button data-qty="-1" data-key="${line.key}" type="button">−</button><b>${line.qty}</b><button data-qty="1" data-key="${line.key}" type="button">＋</button></div>
        <div class="cart-amount">${line.isFoc ? "FOC" : money(displayPrice * line.qty)}<div class="cart-line-actions"><button class="foc-item-action" data-foc-line="${line.key}" type="button">${line.isFoc ? "Edit FOC" : "+ FOC replacement"}</button><button class="remove-item" data-remove="${line.key}" type="button">Remove</button></div></div>
      </div>`;
    }).join("");
  }

  list.querySelectorAll("[data-qty]").forEach(button => button.addEventListener("click", () => updateQuantity(button.dataset.key, Number(button.dataset.qty))));
  list.querySelectorAll("[data-remove]").forEach(button => button.addEventListener("click", () => {
    state.cart = state.cart.filter(item => item.key !== button.dataset.remove);
    markOrderDirty();
    renderCart();
  }));
  list.querySelectorAll("[data-foc-line]").forEach(button => button.addEventListener("click", () => openFocDialog(button.dataset.focLine)));

  const subtotal = cartSubtotal();
  byId("subtotalValue").textContent = money(subtotal);
  byId("totalValue").textContent = money(Math.max(0, subtotal - state.discount));
  updateDiscountButton();
  syncActiveTableOrder();
  renderRecentTables();
}

function renderRecentTables() {
  const recent = tables.filter(table => table.status === "unpaid").slice(0, 5);
  byId("recentTables").innerHTML = recent.map(table => `<button class="recent-table ${table.status}" data-table="${table.id}" type="button">
    <span><strong>Table ${table.id}</strong><small>Unpaid bill</small></span>
    <span class="table-total">${money(table.total || 0)}</span>
  </button>`).join("");
  byId("recentTables").querySelectorAll("[data-table]").forEach(button => button.addEventListener("click", () => selectTable(button.dataset.table)));
}

function renderTableHome() {
  const available = tables.filter(table => table.status === "free").length;
  const unpaid = tables.filter(table => table.status === "unpaid");
  byId("availableCount").textContent = available;
  byId("unpaidCount").textContent = unpaid.length;
  setText("heldCount", unpaid.length);
  byId("heldTotal").textContent = money(unpaid.reduce((sum, table) => sum + (table.total || 0), 0));
  setText("mainTableSummary", `${unpaid.length} unpaid · ${available} free`);

  byId("homeTableGrid").innerHTML = tables.map(table => {
    const selected = table.id === state.table;
    const statusLabel = table.status === "free" ? "Free" : "Unpaid";
    const detail = table.status === "free" ? "Start new order" : `${money(table.total || 0)} · tap to resume`;
    return `<button class="home-table-card ${table.status} ${selected ? "selected" : ""}" data-home-table="${table.id}" type="button" aria-current="${selected ? "true" : "false"}">
      <div class="home-table-card-header"><span class="home-table-number">${table.id}</span><span class="home-status">${statusLabel}</span></div>
      <div class="home-table-detail"><strong>Table ${table.id}</strong><small>${detail}</small></div><span class="table-open-arrow">${selected ? "✓" : "→"}</span>
    </button>`;
  }).join("");
  byId("homeTableGrid").querySelectorAll("[data-home-table]").forEach(button => button.addEventListener("click", () => { void enterPos(button.dataset.homeTable); }));

  byId("heldOrderList").innerHTML = unpaid.map(table => `<button class="held-order-row" data-held-table="${table.id}" type="button">
    <span class="held-table-number">${table.id}</span><span><strong>Table ${table.id}</strong><small>Unpaid bill · tap to resume</small></span><b class="held-order-total">${money(table.total || 0)}</b>
  </button>`).join("");
  byId("heldOrderList").querySelectorAll("[data-held-table]").forEach(button => button.addEventListener("click", () => { void enterPos(button.dataset.heldTable); }));
}

function showTableHome() {
  byId("posWorkspace").classList.add("hidden");
  byId("tableHome").classList.remove("hidden");
  renderTableHome();
}

async function enterPos(tableId) {
  if (!(await selectTable(tableId, false))) return false;
  byId("tableHome").classList.add("hidden");
  byId("posWorkspace").classList.remove("hidden");
  showToast(`Table ${tableId} opened`);
  return true;
}

function renderTableDialog() {
  byId("tableGrid").innerHTML = tables.map(table => `<button class="table-card ${table.status} ${table.id === state.table ? "selected" : ""}" data-table-select="${table.id}" type="button">
    <strong>Table ${table.id}</strong><small>${table.status === "free" ? "Free" : `Unpaid · ${money(table.total || 0)}`}</small>
  </button>`).join("");
  byId("tableGrid").querySelectorAll("[data-table-select]").forEach(button => button.addEventListener("click", async () => {
    if (await selectTable(button.dataset.tableSelect)) byId("tableDialog").close();
  }));
}

async function selectTable(tableId, notify = true) {
  try {
    await flushCurrentOrder();
  } catch (_) {
    showToast("Save this order before switching tables");
    return false;
  }
  syncActiveTableOrder();
  const target = tables.find(table => normalizedTable(table.id) === normalizedTable(tableId));
  if (!target) {
    showToast("That table is no longer available");
    return false;
  }
  state.table = target.id;
  loadTableOrder(target.id);
  byId("activeTable").textContent = target.id;
  byId("orderTable").textContent = target.id;
  renderCart();
  renderTableDialog();
  renderTableHome();
  if (notify) showToast(`Table ${target.id} selected`);
  return true;
}

function showTableDialog() {
  renderTableDialog();
  byId("tableDialog").showModal();
}

function openVariantDialog(productId) {
  const product = products.find(item => item.id === productId);
  const options = productVariants[productId] || [{ code: "standard", name: "Standard", detail: "Default option", price: product.price }];
  state.variantProductId = productId;
  state.selectedVariantCode = options[0].code;
  state.variantQuantity = 1;
  byId("variantProductName").textContent = product.name;
  renderVariantOptions();
  byId("variantDialog").showModal();
}

function selectedVariant() {
  return (productVariants[state.variantProductId] || []).find(option => option.code === state.selectedVariantCode);
}

function renderVariantOptions() {
  const options = productVariants[state.variantProductId] || [];
  byId("variantOptions").innerHTML = options.map(option => `<button class="variant-option ${option.code === state.selectedVariantCode ? "selected" : ""}" data-variant="${option.code}" type="button">
    <span><strong>${option.name}</strong><small>${option.detail}</small></span><span class="variant-price-wrap"><b>${money(option.price)}</b><i class="variant-check">✓</i></span>
  </button>`).join("");
  byId("variantOptions").querySelectorAll("[data-variant]").forEach(button => button.addEventListener("click", () => {
    state.selectedVariantCode = button.dataset.variant;
    renderVariantOptions();
  }));
  byId("variantQuantity").textContent = state.variantQuantity;
  const variant = selectedVariant();
  byId("variantTotal").textContent = money((variant?.price || 0) * state.variantQuantity);
}

function changeVariantQuantity(delta) {
  state.variantQuantity = Math.max(1, Math.min(99, state.variantQuantity + delta));
  renderVariantOptions();
}

function addSelectedVariant() {
  const variant = selectedVariant();
  if (!variant) return;
  addProduct(state.variantProductId, variant, state.variantQuantity);
  byId("variantDialog").close();
}

async function openBillPreview() {
  if (!state.cart.length) return showToast("Add at least one product before printing a bill");
  try {
    await flushCurrentOrder();
  } catch (_) {
    return showToast("The order must be saved before printing its bill");
  }

  const subtotal = cartSubtotal();
  const total = Math.max(0, subtotal - state.discount);
  const printedAt = new Date();

  byId("receiptTable").textContent = `Table ${state.table}`;
  setText("receiptOrder", `Order #${state.orderNumber}`);
  byId("receiptDate").textContent = printedAt.toLocaleString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  byId("receiptItems").innerHTML = state.cart.map(line => {
    const product = products.find(item => item.id === line.productId);
    const price = line.price ?? product?.price ?? 0;
    const name = `${product?.name || line.displayName || "Unavailable item"}${line.variantName ? ` · ${line.variantName}` : ""}`;
    return `<div class="receipt-item ${line.isFoc ? "foc" : ""}">
      <span><strong>${line.isFoc ? "[FOC] " : ""}${escapeHtml(name)}</strong><small>${unitPriceLabel(price, product?.listPrice, line.isFoc, "no charge")}</small>${line.isFoc ? `<small class="foc-receipt-note">${escapeHtml(line.focReason || "")}</small>` : ""}</span>
      <b>${line.qty}</b>
      <strong>${line.isFoc ? "FOC" : money(price * line.qty)}</strong>
    </div>`;
  }).join("");
  byId("receiptSubtotal").textContent = money(subtotal);
  byId("receiptDiscount").textContent = `- ${money(state.discount)}`;
  byId("receiptTotal").textContent = money(total);
  byId("billDialog").showModal();
}

function printCheckBill() {
  document.body.classList.remove("printing-paid-receipt");
  window.print();
  showToast(`Check bill printed · Table ${state.table} · payment still pending`);
}

function openOrderNoteDialog() {
  const input = byId("orderNoteInput");
  input.value = state.orderNote;
  setText("orderNoteCount", `${input.value.length} / 500`);
  byId("orderNoteDialog").showModal();
  setTimeout(() => input.focus(), 0);
}

function saveOrderNote() {
  state.orderNote = byId("orderNoteInput").value.trim();
  updateOrderNoteButton();
  markOrderDirty();
  syncActiveTableOrder();
  byId("orderNoteDialog").close();
  showToast(state.orderNote ? "Order note saved" : "Order note removed");
}

function updateDiscountButton() {
  const button = byId("discountButton");
  if (!button) return;
  button.textContent = state.discount > 0 ? `- ${money(state.discount)} · Edit` : "Add";
}

function openDiscountDialog() {
  const subtotal = cartSubtotal();
  if (!subtotal) return showToast("Add an item before applying a discount");
  setText("discountSubtotal", money(subtotal));
  byId("discountInput").value = Number(state.discount || 0).toFixed(2);
  setText("discountError", "");
  byId("discountDialog").showModal();
  setTimeout(() => { byId("discountInput").focus(); byId("discountInput").select(); }, 0);
}

function saveDiscount() {
  const raw = String(byId("discountInput").value || "").trim();
  const value = Number(raw);
  const subtotal = cartSubtotal();
  if (!Number.isFinite(value) || value < 0) {
    setText("discountError", "Enter a valid discount amount of RM 0.00 or more.");
    return;
  }
  if (value > subtotal) {
    setText("discountError", `Discount cannot be more than ${money(subtotal)}.`);
    return;
  }
  state.discount = Math.round(value * 100) / 100;
  markOrderDirty();
  renderCart();
  byId("discountDialog").close();
  showToast(state.discount ? `${money(state.discount)} discount applied` : "Discount removed");
}

function focReasonParts(reason = "") {
  const options = Array.from(byId("focReason").options).map(option => option.value);
  const preset = options.find(value => value !== "Other" && (reason === value || reason.startsWith(`${value}: `)));
  if (!preset) return { preset:"Other", details:reason };
  return { preset, details:reason === preset ? "" : reason.slice(preset.length + 2) };
}

function openFocDialog(lineKey) {
  const line = state.cart.find(item => item.key === lineKey);
  if (!line) return;
  const product = products.find(item => item.id === line.productId);
  const price = line.price ?? product?.price ?? 0;
  const name = `${product?.name || line.displayName || "Unavailable item"}${line.variantName ? ` · ${line.variantName}` : ""}`;
  const parts = focReasonParts(line.isFoc ? line.focReason : "Replacement — not fresh / spoiled");
  state.focSourceKey = lineKey;
  setText("focTitle", line.isFoc ? "Edit FOC replacement" : "Add FOC replacement");
  setText("focItemName", name);
  setText("focNormalPrice", `Normal price ${money(price)} · customer pays ${money(0)}`);
  byId("focQuantity").value = line.isFoc ? line.qty : 1;
  byId("focReason").value = parts.preset;
  byId("focDetails").value = parts.details;
  setText("focError", "");
  setText("saveFocReplacement", line.isFoc ? "Update FOC replacement" : "Add FOC replacement");
  byId("focDialog").showModal();
  setTimeout(() => byId("focReason").focus(), 0);
}

function saveFocReplacement() {
  const source = state.cart.find(item => item.key === state.focSourceKey);
  if (!source) return byId("focDialog").close();
  const quantity = Number(byId("focQuantity").value);
  const preset = String(byId("focReason").value || "").trim();
  const details = String(byId("focDetails").value || "").trim();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    setText("focError", "Enter a replacement quantity from 1 to 99.");
    return;
  }
  if (!preset || (preset === "Other" && details.length < 3)) {
    setText("focError", "Enter a clear reason for this FOC replacement.");
    return;
  }
  const reason = preset === "Other" ? details : `${preset}${details ? `: ${details}` : ""}`;
  if (reason.length > 300) {
    setText("focError", "The FOC reason must be 300 characters or fewer.");
    return;
  }
  if (source.isFoc) {
    source.qty = quantity;
    source.focReason = reason;
  } else {
    const product = products.find(item => item.id === source.productId);
    state.cart.push({
      ...source,
      key:`${source.key}-foc-${Date.now().toString(36)}`,
      qty:quantity,
      price:source.price ?? product?.price ?? 0,
      isFoc:true,
      focReason:reason
    });
  }
  state.checkoutKey = null;
  state.paymentAuthorization = null;
  markOrderDirty();
  renderCart();
  byId("focDialog").close();
  showToast(`${quantity} FOC replacement${quantity === 1 ? "" : "s"} added · ${reason}`);
}

function resetCurrentOrderState() {
  clearTimeout(orderSaveTimer);
  state.orderId = null;
  state.orderVersion = 0;
  state.orderNumber = "NEW";
  state.orderUpdatedAt = "";
  state.orderNote = "";
  state.orderDirty = false;
  state.cart = [];
  state.discount = 0;
  state.paymentStaff = null;
  state.paymentAuthorization = null;
  state.pendingPaymentMethod = null;
  state.checkoutKey = null;
  state.focSourceKey = null;
  updateOrderNoteButton();
  updateOrderSaveStatus("saved", "Empty · not saved");
  renderCart();
}

async function clearCurrentOrder() {
  if (!state.cart.length && !state.orderId) return showToast("This order is already empty");
  if (!window.confirm(`Clear all items from Table ${state.table}? This cannot be undone.`)) return;
  const button = byId("clearButton");
  button.disabled = true;
  try {
    await flushCurrentOrder();
    if (state.orderId) {
      await POSAuth.api(`/api/pos/orders/${state.orderId}/cancel`, {
        method:"POST",
        body:JSON.stringify({ expected_version:state.orderVersion, reason:"Cleared by cashier" })
      });
    }
    resetCurrentOrderState();
    renderTableHome();
    renderTableDialog();
    showToast(`Table ${state.table} order cleared`);
  } catch (error) {
    if (error.status === 409 && error.payload?.current_order) applySavedOrder(error.payload.current_order, true);
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function holdCurrentOrder() {
  if (!state.cart.length) return showToast("Add at least one product before holding an order");
  const button = byId("holdButton");
  button.disabled = true;
  try {
    await flushCurrentOrder();
    const result = await POSAuth.api(`/api/pos/orders/${state.orderId}/hold`, {
      method:"POST",
      body:JSON.stringify({ expected_version:state.orderVersion })
    });
    applySavedOrder(result.order, false);
    if (window.confirm(state.language === "zh" ? "订单已挂单。是否打印未付款单据？" : "Order held. Print unpaid receipt?")) {
      await openBillPreview();
      printCheckBill();
    }
    showTableHome();
    showToast(`Table ${state.table} saved as unpaid`);
  } catch (error) {
    if (error.status === 409 && error.payload?.current_order) applySavedOrder(error.payload.current_order, true);
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function updateStaffHeader(staff) {
  if (!staff) return;
  setText("activeStaffAvatar", staff.initials);
  setText("activeStaffName", staff.name);
  const roleKey = staff.role.toLowerCase();
  setText("activeStaffRole", translations[state.language]?.[roleKey] || staff.role);
}

function clearPinError() {
  const input = byId("staffPinInput");
  input.removeAttribute("aria-invalid");
  setText("staffPinError", "");
}

async function requestPayment(method) {
  if (!state.cart.length) return showToast("Add at least one product first");
  if (state.sessionMode === "order") return showToast("Order Only workspace cannot receive payment");

  try {
    await flushCurrentOrder();
  } catch (_) {
    return showToast("The order must be saved before payment");
  }
  if (!state.orderId) return showToast("The saved order could not be found");

  const total = Math.max(0, cartSubtotal() - state.discount);
  const focOnly = state.cart.length > 0 && state.cart.every(line => line.isFoc);
  const checkoutMethod = focOnly ? "FOC" : method;
  state.pendingPaymentMethod = checkoutMethod;
  state.paymentStaff = null;
  state.paymentAuthorization = null;
  state.checkoutKey = null;
  setText("pinPaymentMethod", focOnly ? "FOC APPROVAL" : `${method.toUpperCase()} PAYMENT`);
  setText("pinPaymentContext", `Table ${state.table} · Order #${state.orderNumber}`);
  setText("pinPaymentTotal", money(total));
  setText("cashierPinTitle", focOnly ? "Who approved this FOC replacement?" : "Who received this payment?");
  const pinCopy = byId("cashierPinDialog").querySelector(".pin-copy");
  if (pinCopy) pinCopy.textContent = focOnly ? "Enter your cashier PIN. Your verified name and the FOC reason will be saved in the audit record." : "Enter your short cashier PIN. The verified name will be saved with this sale.";
  setText("verifyStaffPin", focOnly ? "Continue to FOC confirmation" : "Continue to payment");
  byId("staffPinInput").value = "";
  clearPinError();
  byId("cashierPinDialog").showModal();
  setTimeout(() => byId("staffPinInput").focus(), 0);
}

async function verifyStaffPin() {
  const input = byId("staffPinInput");
  byId("verifyStaffPin").disabled = true;
  try {
    const result = await POSAuth.api("/api/auth/payment-identity", {
      method: "POST",
      body: JSON.stringify({
        pin: input.value,
        order_id: state.orderId,
        payment: String(state.pendingPaymentMethod || "").toUpperCase()
      })
    });
    const staff = {
      staffId: result.staff.staff_id,
      name: result.staff.name,
      role: result.staff.role,
      initials: result.staff.initials
    };
    state.paymentStaff = staff;
    state.paymentAuthorization = result.payment_token;
    byId("cashierPinDialog").close();
    openPayment(state.pendingPaymentMethod, staff);
  } catch (error) {
    input.value = "";
    input.setAttribute("aria-invalid", "true");
    setText("staffPinError", error.message);
    input.focus();
  } finally {
    byId("verifyStaffPin").disabled = false;
  }
}

function updatePinValue(action, digit = "") {
  const input = byId("staffPinInput");
  if (action === "clear") input.value = "";
  else if (action === "backspace") input.value = input.value.slice(0, -1);
  else if (input.value.length < input.maxLength) input.value += digit;
  clearPinError();
  input.focus();
}

function openPayment(method, staff = state.paymentStaff) {
  if (!staff) return requestPayment(method);
  const total = Math.max(0, cartSubtotal() - state.discount);
  const isCash = method === "Cash";
  const isFoc = method === "FOC";
  byId("paymentDialog").classList.toggle("qr-mode", !isCash && !isFoc);
  byId("paymentDialog").classList.toggle("foc-mode", isFoc);
  byId("paymentIcon").textContent = isCash ? state.settings.currency || "RM" : isFoc ? "FOC" : "▦";
  byId("paymentIcon").style.background = isCash ? "#1e8a5b" : isFoc ? "#b66b16" : "#316bc6";
  byId("paymentEyebrow").textContent = isFoc ? "FOC APPROVAL" : `${method.toUpperCase()} PAYMENT`;
  byId("paymentTitle").textContent = isCash ? `Collect ${money(total)}` : isFoc ? "Confirm zero-charge replacement" : `Confirm ${money(total)}`;
  byId("paymentCopy").textContent = isCash ? "Enter the cash received to calculate change." : isFoc ? "The customer pays RM 0.00. Confirm that the reason and replacement quantity are correct." : "Check your QR terminal or bank notification before marking this order as paid.";
  byId("cashReceivedGroup").hidden = !isCash;
  byId("changeRow").hidden = !isCash;
  byId("qrConfirmPanel").hidden = isCash;
  byId("confirmPayment").dataset.method = method;
  byId("confirmPayment").textContent = isCash ? "Confirm cash payment" : isFoc ? "Issue FOC replacement" : "QR payment received";
  byId("paymentSafety").textContent = isCash ? "Confirm only after cash has been collected." : isFoc ? "This deducts stock and writes a permanent FOC audit record." : "No cash amount or change is needed for QR payment.";
  setText("paymentNoAmountTitle", isFoc ? "No customer payment" : "No amount entry needed");
  setText("paymentNoAmountCopy", isFoc ? "The replacement will be recorded at RM 0.00 with its normal retail value shown separately." : "Verify the payment notification, then confirm below.");
  setText("paymentStaffLabel", isFoc ? "FOC APPROVED BY" : "PAYMENT RECEIVED BY");
  setText("paymentCashierAvatar", staff.initials);
  setText("paymentCashierName", staff.name);
  setText("paymentCashierId", staff.staffId);
  byId("cashReceived").value = Math.ceil(total / 10) * 10 || total;
  updateChange();
  byId("paymentDialog").showModal();
}

function updateChange() {
  const total = Math.max(0, cartSubtotal() - state.discount);
  const received = Number(byId("cashReceived").value) || 0;
  byId("changeValue").textContent = money(Math.max(0, received - total));
}

function checkoutRequestKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `checkout_${Date.now().toString(36)}_${random}`.padEnd(24, "0");
}

async function completePayment() {
  const method = byId("confirmPayment").dataset.method;
  const total = Math.max(0, cartSubtotal() - state.discount);
  const cashier = state.paymentStaff;
  if (!cashier) return showToast("Cashier identification is required before payment");
  if (method === "Cash" && (Number(byId("cashReceived").value) || 0) < total) return showToast("Cash received is less than the total");
  if (!state.orderId || !state.paymentAuthorization) return showToast("Payment approval expired. Enter the cashier PIN again.");

  const button = byId("confirmPayment");
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Saving payment…";
  state.checkoutKey ||= checkoutRequestKey();
  try {
    const result = await POSAuth.api(`/api/pos/orders/${state.orderId}/checkout`, {
      method:"POST",
      body:JSON.stringify({
        expected_version:state.orderVersion,
        payment:String(method).toUpperCase(),
        cash_received:method === "Cash" ? Number(byId("cashReceived").value || 0) : null,
        payment_token:state.paymentAuthorization,
        idempotency_key:state.checkoutKey
      })
    });
    state.lastReceipt = result;
    byId("paymentDialog").close();
    resetCurrentOrderState();
    await loadLiveCatalog();
    renderCategories();
    renderProducts();
    renderCart();
    renderRecentTables();
    renderTableDialog();
    renderTableHome();
    showTableHome();
    showPaidReceipt(result);
    showToast(`Payment saved by ${result.cashier.name} · ${result.payment} · ${money(result.total)} · Receipt #${result.receipt_number}`);
  } catch (error) {
    if (error.status === 409 && error.payload?.current_order) {
      applySavedOrder(error.payload.current_order, true);
      byId("paymentDialog").close();
    } else if (error.status === 409) {
      byId("paymentDialog").close();
      state.orderDirty = false;
      await loadLiveCatalog();
      renderCategories();
      renderProducts();
      renderCart();
      renderRecentTables();
      renderTableDialog();
      renderTableHome();
      showTableHome();
    }
    if (error.status === 401 || error.status === 403) {
      state.paymentAuthorization = null;
      byId("paymentDialog").close();
    }
    showToast(`Payment not completed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function paidReceiptItems(receipt) {
  const items = Array.isArray(receipt.items) ? receipt.items : Array.isArray(receipt.parsed_items) ? receipt.parsed_items : [];
  return items.map(item => ({
    name:item.display_name || item.item_name || "Item",
    price:Number(item.unit_price || 0),
    listPrice:item.list_unit_price ?? null,
    quantity:Number(item.quantity || 0),
    isFoc:Boolean(item.is_foc),
    focReason:item.foc_reason || null
  }));
}

function showPaidReceipt(receipt) {
  const saleId = receipt.sale_id ?? receipt.id ?? receipt.receipt_number;
  const tableCode = receipt.table_code || "—";
  const payment = String(receipt.payment || "").toUpperCase();
  const cashierName = typeof receipt.cashier === "object" ? receipt.cashier.name : receipt.cashier;
  const discount = Number(receipt.discount || 0);
  const tax = Number(receipt.tax || 0);
  const total = Number(receipt.total || 0);
  const subtotal = Number(receipt.subtotal ?? (total + discount - tax));
  const items = paidReceiptItems(receipt);
  setText("paidReceiptTable", `Table ${tableCode}`);
  setText("paidReceiptNumber", `Receipt #${saleId}`);
  setText("paidReceiptDate", savedOrderDate(receipt.datetime));
  setText("paidReceiptMethod", `Payment ${payment || "—"}`);
  setText("paidReceiptCashier", `Cashier ${cashierName || "—"}`);
  setText("paidReceiptTitle", payment === "FOC" ? "FOC replacement record" : "Paid receipt");
  setText("paidReceiptKind", payment === "FOC" ? "FOC replacement record" : "Payment receipt");
  setText("paidReceiptStatus", payment === "FOC" ? "NO CHARGE" : "PAID");
  byId("paidPrintReceipt").querySelector(".receipt-header")?.classList.toggle("foc", payment === "FOC");
  byId("paidReceiptItems").innerHTML = items.map(item => `<div class="receipt-item ${item.isFoc ? "foc" : ""}"><span><strong>${item.isFoc ? "[FOC] " : ""}${escapeHtml(item.name)}</strong><small>${unitPriceLabel(item.price, item.listPrice, item.isFoc, "no charge")}</small>${item.isFoc && item.focReason ? `<small class="foc-receipt-note">${escapeHtml(item.focReason)}</small>` : ""}</span><b>${item.quantity}</b><strong>${item.isFoc ? "FOC" : money(item.price * item.quantity)}</strong></div>`).join("");
  setText("paidReceiptSubtotal", money(subtotal));
  setText("paidReceiptDiscount", `- ${money(discount)}`);
  setText("paidReceiptTotal", money(total));
  const hasTender = payment === "CASH" && receipt.cash_received !== null && receipt.cash_received !== undefined;
  byId("paidReceiptTenderRow").hidden = !hasTender;
  byId("paidReceiptChangeRow").hidden = !hasTender;
  if (hasTender) {
    setText("paidReceiptTender", money(receipt.cash_received));
    setText("paidReceiptChange", money(receipt.change));
  }
  const note = String(receipt.note || "").trim();
  byId("paidReceiptNote").hidden = !note;
  byId("paidReceiptNote").textContent = note ? `Order note: ${note}` : "";
  const dialog = byId("paidReceiptDialog");
  if (!dialog.open) dialog.showModal();
}

async function openReceiptById(saleId) {
  if (byId("simpleDialog").open) byId("simpleDialog").close();
  try {
    const result = await POSAuth.api(`/api/sales/${saleId}`);
    showPaidReceipt(result.sale);
  } catch (error) {
    showToast(`Receipt could not be opened: ${error.message}`);
  }
}

function printPaidReceipt() {
  document.body.classList.add("printing-paid-receipt");
  window.print();
  showToast("Paid receipt sent to the printer");
}

function toggleOwnerDrawer(force) {
  const drawer = byId("ownerDrawer");
  const next = typeof force === "boolean" ? force : !drawer.classList.contains("open");
  drawer.classList.toggle("open", next);
  byId("drawerBackdrop").classList.toggle("open", next);
  drawer.setAttribute("aria-hidden", String(!next));
  byId("ownerButton").setAttribute("aria-expanded", String(next));
  if (next) setTimeout(() => byId("closeOwnerDrawer").focus(), 0);
}

function renderWorkspaceDrawer() {
  const isCashier = state.sessionMode === "cashier";
  setText("workspaceDrawerEyebrow", isCashier ? "CASHIER WORKSPACE" : "ORDER-ONLY WORKSPACE");
  setText("workspaceDrawerTitle", `${state.currentStaff.name}'s tools`);
  setText("workspaceDrawerCopy", isCashier
    ? "Review saved receipts or open Cash, Rent, and Stock. These tools stay available here on laptop and tablet screens."
    : "This workspace can create and hold orders, but it cannot receive money or open cashier records.");
  setText("drawerSessionLabel", `${state.currentStaff.name} · ${state.currentStaff.staffId}`);

  const actions = isCashier ? [
    ["recent-orders", "▤", "Recent orders", "Saved receipts and payment details"],
    ["cash", "RM", "Cash center", "Income, expenses, float and closing"],
    ["rent", "⌂", "Rent & stalls", "Due rent, collection and history"],
    ["stock", "□", "Stock", "Live balances and low-stock status"]
  ] : [];
  if (state.sessionModes.includes(isCashier ? "order" : "cashier")) {
    actions.push([isCashier ? "switch-order" : "switch-cashier", "⇄", isCashier ? "Order Only" : "Cashier mode", isCashier ? "Take orders without payment access" : "Return to payment and cashier tools"]);
  }
  byId("workspaceMenu").innerHTML = actions.map(([action, icon, title, copy]) => `<button data-workspace-action="${action}" type="button"><span>${icon}</span><b>${title}</b><small>${copy}</small></button>`).join("");
}

function savedOrderItems(row) {
  try {
    const items = JSON.parse(row.items || "[]");
    if (!Array.isArray(items) || !items.length) return "No item details saved";
    const listPrices = JSON.parse(row.category_list_prices || "{}");
    return items.slice(0, 5).map(item => {
      const name = String(item[0] || "Item");
      const listPrice = !name.startsWith("[FOC] ") && Object.hasOwn(listPrices, item[3])
        ? ` (List ${money(listPrices[item[3]])} each)` : "";
      return `${escapeHtml(name)} × ${Number(item[2] || 0)}${listPrice}`;
    }).join(" · ") + (items.length > 5 ? ` · +${items.length - 5} more` : "");
  } catch (_) {
    return "Item details unavailable";
  }
}

function savedOrderDate(value) {
  const parsed = new Date(String(value || "").replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return escapeHtml(value || "Date unavailable");
  return parsed.toLocaleString("en-MY", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function showRecentOrders() {
  toggleOwnerDrawer(false);
  setText("simpleDialogEyebrow", "PAYMENT HISTORY");
  setText("simpleDialogTitle", "Recent orders");
  const body = byId("simpleDialogBody");
  body.classList.add("sales-audit-module");
  body.innerHTML = '<div class="module-loading">Loading saved receipts…</div>';
  byId("simpleDialog").showModal();
  try {
    const result = await POSAuth.api("/api/sales");
    const rows = result.rows.slice(0, 20);
    body.innerHTML = rows.length ? `<div class="audit-intro"><span>SAVED RECEIPTS · POS.DB</span><strong>Latest ${rows.length} order${rows.length === 1 ? "" : "s"}</strong></div>
      <div class="saved-order-list">${rows.map(row => {
        const method = escapeHtml(String(row.payment || "CASH").toUpperCase());
        const methodClass = method.toLowerCase().replace(/[^a-z0-9_-]/g, "");
        return `<article class="saved-order-card"><div class="saved-order-summary"><span class="audit-method ${methodClass}">${method}</span><span><strong>Receipt #${Number(row.id)} · Table ${escapeHtml(row.table_code || "—")}</strong><small>${savedOrderDate(row.datetime)} · ${escapeHtml(row.cashier || "Cashier not recorded")}</small></span><b>${money(Number(row.total || 0))}</b></div><p class="saved-order-items">${savedOrderItems(row)}</p><div class="saved-order-actions"><button type="button" data-receipt-id="${Number(row.id)}">View / reprint receipt</button></div></article>`;
      }).join("")}</div><p class="saved-order-note">Completed receipts are read directly from the database and can be reprinted at any time.</p>`
      : '<div class="placeholder-icon">▤</div><h3>No saved receipts yet.</h3><p>Completed database sales will appear here.</p>';
    body.querySelectorAll("[data-receipt-id]").forEach(button => button.addEventListener("click", () => { void openReceiptById(button.dataset.receiptId); }));
  } catch (error) {
    body.innerHTML = `<div class="placeholder-icon">!</div><h3>Could not load recent orders.</h3><p>${escapeHtml(error.message)}</p>`;
  }
}

function showUnpaidTables() {
  const unpaid = tables.filter(table => table.status === "unpaid");
  setText("simpleDialogEyebrow", "UNPAID ORDERS");
  setText("simpleDialogTitle", `${unpaid.length} table${unpaid.length === 1 ? "" : "s"} need payment`);
  const body = byId("simpleDialogBody");
  body.classList.add("sales-audit-module");
  body.innerHTML = unpaid.length ? `<div class="unpaid-dialog-list">${unpaid.map(table => `<button type="button" data-open-unpaid-table="${escapeHtml(table.id)}"><span>${escapeHtml(table.id)}</span><b>Table ${escapeHtml(table.id)}<small>Order #${escapeHtml(table.orderNumber || "—")}</small></b><strong>${money(table.total)}</strong><i>→</i></button>`).join("")}</div>` : '<div class="placeholder-icon">✓</div><h3>All tables are free.</h3><p>There are no unpaid orders right now.</p>';
  body.querySelectorAll("[data-open-unpaid-table]").forEach(button => button.addEventListener("click", async () => {
    byId("simpleDialog").close();
    await enterPos(button.dataset.openUnpaidTable);
  }));
  byId("simpleDialog").showModal();
}

const cashierToolMeta = {
  cash: { title:"Cash Center", label:"cash" },
  rent: { title:"Rent & Stalls", label:"rent" },
  stock: { title:"Stock View", label:"stock" }
};

function setCashierToolLoading(loading) {
  byId("cashierToolLoading").hidden = !loading;
}

async function openCashierTool(page) {
  const meta = cashierToolMeta[page];
  if (!meta || state.sessionMode !== "cashier") return;

  const dialog = byId("cashierToolDialog");
  const frame = byId("cashierToolFrame");
  const isSameOpenTool = dialog.open && dialog.dataset.toolPage === page && frame.getAttribute("src") !== "about:blank";
  toggleOwnerDrawer(false);
  if (isSameOpenTool) return;

  dialog.dataset.toolPage = page;
  setText("cashierToolTitle", meta.title);
  frame.title = `${meta.title} cashier window`;
  document.querySelectorAll("[data-cashier-tool-tab]").forEach(button => {
    const active = button.dataset.cashierToolTab === page;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  setCashierToolLoading(true);
  if (!dialog.open) dialog.showModal();

  try {
    await flushCurrentOrder();
    if (!dialog.open || dialog.dataset.toolPage !== page) return;
    frame.src = `/admin?page=${encodeURIComponent(page)}&embed=1`;
  } catch (error) {
    if (dialog.open) dialog.close();
    showToast(`Could not open ${meta.label}: ${error.message}`);
  }
}

async function refreshAfterCashierTool() {
  if (state.sessionMode !== "cashier") return;
  const loaded = await loadLiveCatalog();
  if (!loaded) return;
  renderCategories();
  renderProducts();
  renderCart();
  renderRecentTables();
  renderTableDialog();
  renderTableHome();
  await loadRentReminder();
}

function handleWorkspaceAction(action) {
  if (action === "recent-orders") return showRecentOrders();
  if (["cash", "rent", "stock"].includes(action)) {
    void openCashierTool(action);
    return;
  }
  if (action === "switch-order" || action === "switch-cashier") {
    toggleOwnerDrawer(false);
    POSAuth.switchMode(action === "switch-order" ? "order" : "cashier").catch(error => showToast(error.message));
  }
}

function configureWorkspace(session) {
  state.sessionMode = session.mode;
  state.sessionModes = Array.isArray(session.modes) ? session.modes : [session.mode];
  state.currentStaff = {
    staffId: session.staff_id,
    name: session.name,
    role: session.role === "admin" ? "Owner" : session.role === "order" ? "Order Only" : "Cashier",
    initials: session.name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "ST"
  };
  updateStaffHeader(state.currentStaff);

  const badge = byId("workspaceModeBadge");
  const modeLabels = { order: ["O", "ORDER ONLY"], cashier: ["C", "CASHIER"], admin: ["A", "ADMIN"] };
  const [letter, label] = modeLabels[session.mode];
  badge.className = `workspace-mode-badge ${session.mode}`;
  badge.innerHTML = `<span>${letter}</span><b>${label}</b>`;

  const orderOnly = session.mode === "order";
  document.querySelector(".payment-label").hidden = orderOnly;
  document.querySelector(".payment-action-grid").hidden = orderOnly;
  document.querySelectorAll("[data-tool-page]").forEach(button => { button.hidden = orderOnly; });
  renderWorkspaceDrawer();
}

async function loadRentReminder() {
  const reminder = byId("rentReminder");
  if (state.sessionMode !== "cashier") { reminder.hidden = true; return; }
  try {
    const data = await POSAuth.api("/api/rent/tenants");
    const attention = data.rows.filter(row => row.active && ["overdue", "due"].includes(row.status?.code));
    if (!attention.length) { reminder.hidden = true; return; }
    const overdue = attention.filter(row => row.status.code === "overdue").length;
    const names = attention.slice(0, 2).map(row => `Stall ${row.stall_no || "?"}`).join(", ");
    byId("rentReminderTitle").textContent = overdue ? `${overdue} overdue rent ${overdue === 1 ? "account" : "accounts"}` : `${attention.length} rent payment ${attention.length === 1 ? "is" : "are"} due soon`;
    byId("rentReminderDetail").textContent = `${names}${attention.length > 2 ? ` +${attention.length - 2} more` : ""} · tap to collect`;
    reminder.hidden = false;
  } catch (_) {
    reminder.hidden = true;
  }
}

function applyLanguage() {
  const dictionary = translations[state.language];
  document.querySelectorAll("[data-i18n]").forEach(element => {
    const value = dictionary[element.dataset.i18n];
    if (value) element.textContent = value;
  });
  byId("languageButton").textContent = state.language === "en" ? "中文" : "EN";
  updateStaffHeader(state.currentStaff);
  updateOrderNoteButton();
  updateDiscountButton();
}

let toastTimer;
function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function bindEvents() {
  window.addEventListener("beforeunload", event => {
    if (!state.orderDirty && !activeOrderSave) return;
    event.preventDefault();
    event.returnValue = "";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.orderDirty) void flushCurrentOrder().catch(() => {});
  });
  byId("productSearch").addEventListener("input", event => { state.search = event.target.value; renderProducts(); });
  byId("refreshProducts").addEventListener("click", async () => {
    await loadLiveCatalog();
    renderCategories();
    renderProducts();
    renderCart();
    renderRecentTables();
    byId("refreshTime").textContent = `updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    showToast("Products and stock refreshed");
  });
  ["tableButton", "mainTablesButton", "viewAllTables"].forEach(id => byId(id).addEventListener("click", async () => {
    try { await flushCurrentOrder(); showTableHome(); }
    catch (_) { showToast("The order must be saved before leaving this table"); }
  }));
  byId("refreshTablesButton").addEventListener("click", async () => { await loadLiveCatalog(); renderTableHome(); renderTableDialog(); showToast("40-table layout refreshed"); });
  byId("newOrderButton").addEventListener("click", () => {
    const firstFree = tables.find(table => table.status === "free");
    if (firstFree) void enterPos(firstFree.id);
    else showToast("No available table for a new order");
  });
  byId("viewHeldButton").addEventListener("click", showUnpaidTables);
  document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  document.querySelectorAll("[data-payment]").forEach(button => button.addEventListener("click", () => { void requestPayment(button.dataset.payment); }));
  byId("staffPinInput").addEventListener("input", event => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
    clearPinError();
  });
  byId("verifyStaffPin").addEventListener("click", verifyStaffPin);
  document.querySelectorAll("[data-pin-digit]").forEach(button => button.addEventListener("click", () => updatePinValue("digit", button.dataset.pinDigit)));
  document.querySelectorAll("[data-pin-action]").forEach(button => button.addEventListener("click", () => updatePinValue(button.dataset.pinAction)));
  byId("cashReceived").addEventListener("input", updateChange);
  byId("confirmPayment").addEventListener("click", () => { void completePayment(); });
  byId("variantMinus").addEventListener("click", () => changeVariantQuantity(-1));
  byId("variantPlus").addEventListener("click", () => changeVariantQuantity(1));
  byId("addVariantButton").addEventListener("click", addSelectedVariant);
  byId("clearButton").addEventListener("click", () => { void clearCurrentOrder(); });
  byId("holdButton").addEventListener("click", () => { void holdCurrentOrder(); });
  byId("printBillButton").addEventListener("click", () => { void openBillPreview(); });
  byId("confirmPrintBill").addEventListener("click", printCheckBill);
  byId("printPaidReceipt").addEventListener("click", printPaidReceipt);
  byId("discountButton").addEventListener("click", openDiscountDialog);
  byId("saveDiscount").addEventListener("click", saveDiscount);
  byId("discountInput").addEventListener("input", () => setText("discountError", ""));
  document.querySelectorAll("[data-discount-amount]").forEach(button => button.addEventListener("click", () => {
    byId("discountInput").value = Number(button.dataset.discountAmount).toFixed(2);
    setText("discountError", "");
  }));
  byId("saveFocReplacement").addEventListener("click", saveFocReplacement);
  ["focQuantity", "focReason", "focDetails"].forEach(id => byId(id).addEventListener("input", () => setText("focError", "")));
  byId("addNoteButton").addEventListener("click", openOrderNoteDialog);
  byId("saveOrderNote").addEventListener("click", saveOrderNote);
  byId("clearOrderNote").addEventListener("click", () => {
    byId("orderNoteInput").value = "";
    setText("orderNoteCount", "0 / 500");
  });
  byId("orderNoteInput").addEventListener("input", event => setText("orderNoteCount", `${event.target.value.length} / 500`));
  byId("ownerButton").addEventListener("click", () => {
    if (state.sessionMode === "admin") window.location.href = "/admin";
    else toggleOwnerDrawer();
  });
  byId("closeOwnerDrawer").addEventListener("click", () => toggleOwnerDrawer(false));
  byId("drawerBackdrop").addEventListener("click", () => toggleOwnerDrawer(false));
  byId("workspaceMenu").addEventListener("click", event => {
    const button = event.target.closest("[data-workspace-action]");
    if (button) handleWorkspaceAction(button.dataset.workspaceAction);
  });
  byId("drawerLogout").addEventListener("click", () => POSAuth.logout());
  document.querySelectorAll("[data-tool-page]").forEach(button => button.addEventListener("click", () => { void openCashierTool(button.dataset.toolPage); }));
  document.querySelectorAll("[data-cashier-tool-tab]").forEach(button => button.addEventListener("click", () => { void openCashierTool(button.dataset.cashierToolTab); }));
  byId("cashierToolDialog").addEventListener("close", () => {
    const frame = byId("cashierToolFrame");
    frame.src = "about:blank";
    delete byId("cashierToolDialog").dataset.toolPage;
    setCashierToolLoading(true);
    void refreshAfterCashierTool();
  });
  window.addEventListener("message", event => {
    const frame = byId("cashierToolFrame");
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === "919-cashier-tool-ready" && event.data.page === byId("cashierToolDialog").dataset.toolPage) {
      setCashierToolLoading(false);
    }
  });
  byId("languageButton").addEventListener("click", () => { state.language = state.language === "en" ? "zh" : "en"; applyLanguage(); });
  document.addEventListener("keydown", event => {
    if (byId("cashierPinDialog").open && event.key === "Enter") { event.preventDefault(); verifyStaffPin(); return; }
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "F1") { event.preventDefault(); void requestPayment("Cash"); }
    if (event.key === "F2") { event.preventDefault(); byId("productSearch").focus(); }
    if (event.key === "F3") { event.preventDefault(); void openBillPreview(); }
    if (event.key === "F4") { event.preventDefault(); void requestPayment("QR"); }
    if (event.key === "Escape") toggleOwnerDrawer(false);
  });
}

function startClock() {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(state.businessDate)
    ? new Date(`${state.businessDate}T12:00:00`)
    : new Date();
  byId("businessDate").textContent = parsed.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

async function initializeApp() {
  const session = await POSAuth.requireSession(["order", "cashier"]);
  if (!session) return;
  configureWorkspace(session);
  await loadLiveCatalog();
  renderCategories();
  renderProducts();
  renderCart();
  renderRecentTables();
  renderTableDialog();
  renderTableHome();
  bindEvents();
  applyLanguage();
  startClock();
  await loadRentReminder();
  document.body.classList.remove("session-loading");

  window.addEventListener("afterprint", () => document.body.classList.remove("printing-paid-receipt"));
}

initializeApp();
