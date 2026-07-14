// ==UserScript==
// @name         iGo 耗材自動加購
// @namespace    zy-embryo-lab
// @version      0.9
// @description  從 GAS 取待送清單，自動登入 iGo 並加入購物車，停在結帳頁讓 ZY 自行確認
// @author       ZY
// @match        https://tp-igo.e-stork.com.tw/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  // ══════════════════════════════════════════════════
  // ▌ 設定區（只需修改這裡）
  // ══════════════════════════════════════════════════

  // 請領部門（固定填這個，不用每次手動選）
  const IGO_DEPT = "懷九中心";

  // GAS Web App 網址
  const GAS_URL = "https://script.google.com/macros/s/AKfycbwdoAng6aOcufhV9E_OmrBTDbOV28R_1HMsIg3WKyocHWew0o5LYCX6fQdaJs5kDGXj/exec";

  // ══════════════════════════════════════════════════
  // ▌ 依目前 URL 決定執行哪段流程
  // ══════════════════════════════════════════════════
  const path = location.pathname;

  // 若有上次未確認的缺貨報告，重新顯示（任何頁面都適用）
  const lastSkipped = GM_getValue("igo_last_skipped", "");
  if (lastSkipped) {
    try { showSkippedReport(JSON.parse(lastSkipped), true); } catch (e) { GM_deleteValue("igo_last_skipped"); }
  }

  if (path === "/login") {
    doLogin();
  } else if (path === "/staff/cart") {
    doAddItems();
  } else if (path === "/staff/cart/show") {
    doCartShow();
  }

  // ══════════════════════════════════════════════════
  // ▌ 流程 1：登入頁
  // ══════════════════════════════════════════════════
  async function doLogin() {
    log("登入頁：從 GAS 載入待送清單…");

    // 從 GAS 取待送清單並暫存（不自動填帳密，讓使用者自己輸入）
    try {
      const order = await fetchGAS("pending-order");
      if (!order.items || !order.items.length) {
        showBanner("⚠️ 待送清單是空的，請先從 order.html 送出訂單", "orange");
        return;
      }
      GM_setValue("igo_order",   JSON.stringify(order));
      GM_setValue("igo_index",   0);
      GM_setValue("igo_filling", true);
      GM_setValue("igo_skipped", "[]");
      GM_setValue("igo_receipt", "[]");
      showBanner(`✅ 待送清單已載入（共 ${order.items.length} 項），請輸入帳號密碼登入`, "green");
      log(`取得 ${order.items.length} 項，等待使用者登入`);
    } catch (e) {
      showBanner("⚠️ 無法取得待送清單：" + e.message, "red");
      return;
    }

    // 若已登入（無帳號欄位），直接前往商品頁
    try {
      await waitFor("#username", 2000);
    } catch {
      log("已登入狀態，直接前往商品頁");
      location.href = "/staff/cart";
    }
  }

  // ══════════════════════════════════════════════════
  // ▌ 流程 2：品項清單頁 - 逐一搜尋並加入領料車
  // ══════════════════════════════════════════════════
  async function doAddItems() {
    if (!GM_getValue("igo_filling", false)) {
      // 已登入直接跳到此頁（跳過 /login），嘗試從 GAS 撈清單
      log("igo_filling 為 false，嘗試從 GAS 載入待送清單…");
      try {
        const order = await fetchGAS("pending-order");
        if (!order.items || !order.items.length) return; // 沒有待送清單，不干預
        GM_setValue("igo_order",   JSON.stringify(order));
        GM_setValue("igo_index",   0);
        GM_setValue("igo_filling", true);
        GM_setValue("igo_skipped", "[]");
        GM_setValue("igo_receipt", "[]");
        showBanner(`✅ 待送清單已載入（共 ${order.items.length} 項），開始自動加購…`, "green");
      } catch (e) {
        return; // 無法連到 GAS，不干預
      }
    }

    const order  = JSON.parse(GM_getValue("igo_order", "{}"));
    const items  = order.items || [];
    let   idx    = Number(GM_getValue("igo_index", 0));

    if (idx >= items.length) {
      // 全部加完，儲存到貨核點清單到 GAS
      const receipt = JSON.parse(GM_getValue("igo_receipt", "[]"));
      if (receipt.length > 0) {
        GM_xmlhttpRequest({
          method:  "POST",
          url:     GAS_URL,
          data:    JSON.stringify({ action: "save-receipt", date: order.date || "", items: receipt }),
          headers: { "Content-Type": "application/json" },
        });
      }
      GM_deleteValue("igo_receipt");
      // 前往領料車確認頁
      GM_setValue("igo_filling",   false);
      GM_setValue("igo_completed", true);
      clearGasPendingOrder();
      showBanner(`✅ 全 ${items.length} 項處理完畢！正在前往領料車…`, "green");
      await sleep(1500);
      location.href = "/staff/cart/show";
      return;
    }

    const item = items[idx];
    showProgress(idx, items.length, item.name);
    log(`[${idx + 1}/${items.length}] 處理：${item.igoName}，數量 ${item.qty}`);

    // 等頁面品項列表載入
    try {
      await waitFor("div#shuffle-container", 8000);
    } catch {
      showBanner("⚠️ 等待品項列表逾時", "red"); return;
    }

    // 搜尋
    const searchInput = document.querySelector("div#shuffle-container input[type='text']")
                     || document.querySelector("div.input-group input[type='text']");
    if (!searchInput) { showBanner("⚠️ 找不到搜尋欄", "red"); return; }

    fill(searchInput, "");
    await sleep(200);
    fill(searchInput, item.igoName); // 只用主品名搜尋
    searchInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(800); // 等 Shuffle.js 過濾

    // 找到符合的卡片（副品名用來從搜尋結果中鎖定正確的那張）
    const card = findMatchingCard(item.igoName, item.igoSubName);
    if (!card) {
      addSkipped(item.name, "找不到品項卡片");
      await sleep(400);
      GM_setValue("igo_index", idx + 1);
      doAddItems();
      return;
    }

    // 點卡片的加入按鈕（Bootstrap modal trigger）
    const trigger = card.querySelector("[data-bs-toggle='modal']")
                 || card.querySelector("a[href*='cart']")
                 || card.querySelector(".btn:not(.disabled)");
    if (!trigger) {
      addSkipped(item.name, "找不到加入按鈕");
      await sleep(400);
      GM_setValue("igo_index", idx + 1);
      doAddItems();
      return;
    }

    trigger.click();
    log("已點加入按鈕，等待 Modal 出現…");

    // 等 modal 出現並填數量
    try {
      await waitFor("form#add-to-cart input[name='quantity']", 5000);
    } catch {
      addSkipped(item.name, "Modal 未出現");
      await sleep(400);
      GM_setValue("igo_index", idx + 1);
      doAddItems();
      return;
    }

    const qtyInput = document.querySelector("form#add-to-cart input[name='quantity']");
    await sleep(400); // 等 max 屬性載入完畢
    // 讀取 iGo 現有庫存（max 屬性）
    const maxStock = qtyInput.max !== "" ? Number(qtyInput.max) : null;
    const needQty  = item.qty;
    const unit     = item.unit || "";

    let fillQty = needQty;
    if (maxStock !== null && maxStock < needQty) {
      if (maxStock === 0) {
        // 完全無庫存：仍嘗試送出需求量（讓 iGo 處理），記錄警告
        addSkipped(item.name, `缺 ${needQty} ${unit}`);
      } else {
        // 部分庫存：填入現有最大量，記錄缺口
        fillQty = maxStock;
        addSkipped(item.name, `缺 ${needQty - maxStock} ${unit}`);
      }
    }

    fill(qtyInput, String(fillQty));
    await sleep(300);

    // 確認送出
    const submitBtn = document.querySelector("form#add-to-cart button[type='submit']");
    if (submitBtn) {
      submitBtn.click();
      log(`已送出 ${item.igoName} × ${fillQty} ${unit}`);
      // 記錄實際加入購物車的量
      const receiptList = JSON.parse(GM_getValue("igo_receipt", "[]"));
      receiptList.push({ id: item.id, name: item.name, qty: fillQty, unit });
      GM_setValue("igo_receipt", JSON.stringify(receiptList));
    }

    await sleep(1200); // 等 modal 關閉 / 卡片更新

    // 繼續下一項
    GM_setValue("igo_index", idx + 1);
    doAddItems();
  }

  function addSkipped(name, reason) {
    const list = JSON.parse(GM_getValue("igo_skipped", "[]"));
    list.push({ name, reason });
    GM_setValue("igo_skipped", JSON.stringify(list));
    log(`跳過：${name}（${reason}）`);
  }

  // ══════════════════════════════════════════════════
  // ▌ 流程 3：領料車確認頁 - 自動填部門，停手等結帳
  // ══════════════════════════════════════════════════
  async function doCartShow() {
    if (!GM_getValue("igo_completed", false)) {
      // 不是從自動流程過來的，不干預
      return;
    }
    GM_deleteValue("igo_completed");

    log("領料車確認頁：自動填部門");
    await sleep(800);

    // Select2 部門欄位：直接設底層 select 的值並觸發 change
    try {
      const deptSelect = document.querySelector("select[id*='department'], select[name*='department']");
      if (deptSelect) {
        // 找到「懷九中心」option
        for (const opt of deptSelect.options) {
          if (opt.text.includes(IGO_DEPT)) {
            deptSelect.value = opt.value;
            deptSelect.dispatchEvent(new Event("change", { bubbles: true }));
            log(`部門已設為：${opt.text}`);
            break;
          }
        }
      } else {
        // Select2 輸入型（可自行輸入）
        const select2Input = document.querySelector(".select2-search__field, input.select2-input");
        if (select2Input) {
          fill(select2Input, IGO_DEPT);
          select2Input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
          await sleep(500);
          // 點選第一個結果
          const option = document.querySelector(".select2-results__option");
          if (option) option.click();
        }
      }
    } catch (e) {
      log("部門自動填寫失敗：" + e.message);
    }

    // 顯示摘要報告
    const skipped = JSON.parse(GM_getValue("igo_skipped", "[]"));
    GM_deleteValue("igo_skipped");

    if (skipped.length === 0) {
      GM_deleteValue("igo_last_skipped");
      showBanner("✅ 自動流程完成！所有品項已加入，請確認數量後按「建立領料單」", "green");
    } else {
      GM_setValue("igo_last_skipped", JSON.stringify(skipped));
      showBanner("✅ 自動流程完成！有品項需要注意，請看下方報告", "orange");
      showSkippedReport(skipped);
    }
  }

  function showSkippedReport(skipped, isRestore) {
    const panel = document.createElement("div");
    Object.assign(panel.style, {
      position: "fixed", bottom: "20px", left: "20px", zIndex: "99999",
      background: "#1c1c1e", color: "#fff", borderRadius: "12px",
      padding: "16px 20px", fontSize: "13px", boxShadow: "0 4px 20px rgba(0,0,0,.5)",
      maxWidth: "380px", maxHeight: "60vh", overflowY: "auto",
    });

    const rows = skipped.map(s => `<div style="border-left:3px solid #ff453a;padding-left:10px;margin-bottom:8px">
        <div style="font-weight:700">🚫 ${s.name}</div>
        <div style="font-size:11px;color:#aaa;margin-top:2px">${s.reason}</div>
      </div>`).join("");

    const title = isRestore ? `⚠️ 上次缺貨報告（共 ${skipped.length} 項）` : `⚠️ 以下 ${skipped.length} 項需注意`;
    const copyText = skipped.map(s => `${s.name}：${s.reason}`).join("\n");
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-size:14px;font-weight:700;color:#ff9500">${title}</span>
        <button id="igo-close-btn" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:0 0 0 12px">✕</button>
      </div>
      ${rows}
      <button id="igo-copy-btn" style="margin-top:12px;width:100%;padding:8px;background:#ff9500;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:700;cursor:pointer">📋 複製通知採購訊息</button>
      <button id="igo-confirm-btn" style="margin-top:8px;width:100%;padding:8px;background:#444;border:none;border-radius:8px;color:#ccc;font-size:13px;cursor:pointer">已確認，不再顯示</button>
    `;
    document.body.appendChild(panel);

    panel.querySelector("#igo-close-btn").addEventListener("click", () => panel.remove());

    panel.querySelector("#igo-copy-btn").addEventListener("click", () => {
      navigator.clipboard.writeText(copyText).then(() => {
        const btn = panel.querySelector("#igo-copy-btn");
        if (btn) { btn.textContent = "✅ 已複製！"; setTimeout(() => { if (btn) btn.textContent = "📋 複製通知採購訊息"; }, 2000); }
      });
    });

    panel.querySelector("#igo-confirm-btn").addEventListener("click", () => {
      GM_deleteValue("igo_last_skipped");
      panel.remove();
    });
  }

  // ══════════════════════════════════════════════════
  // ▌ 找到符合 iGoName 的商品卡片
  // ══════════════════════════════════════════════════
  function findMatchingCard(igoName, igoSubName) {
    // 找所有可見的品項卡片容器
    const candidates = [...document.querySelectorAll(
      "div#shuffle-container .col, div#shuffle-container .card-wrapper, div.row > div.col"
    )].filter(el => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
    });

    log(`可見卡片數：${candidates.length}，搜尋品名：${igoName}，副品名：${igoSubName}`);

    // 有副品名（尺寸/型號）→ 主品名 + 副品名雙重比對
    if (igoSubName) {
      for (const card of candidates) {
        const text = card.textContent.replace(/\s+/g, " ").trim();
        if (text.includes(igoName) && text.includes(igoSubName)) return card;
      }
    }

    // 無副品名 或 上面沒找到 → 只比對主品名
    for (const card of candidates) {
      const text = card.textContent.replace(/\s+/g, " ").trim();
      if (text.includes(igoName)) return card;
    }

    // 搜尋後只剩一張卡片 → 直接取
    if (candidates.length === 1) return candidates[0];

    return null;
  }

  // ══════════════════════════════════════════════════
  // ▌ 工具函式
  // ══════════════════════════════════════════════════

  function waitFor(selector, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }
      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error("Timeout: " + selector)); }, timeout);
    });
  }

  function fill(selectorOrEl, value) {
    const el = typeof selectorOrEl === "string"
      ? document.querySelector(selectorOrEl) : selectorOrEl;
    if (!el) { log("找不到元素：" + selectorOrEl); return; }
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value"
    )?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function click(selector) {
    const el = document.querySelector(selector);
    if (!el) { log("找不到按鈕：" + selector); return; }
    el.click();
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function fetchGAS(action) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url:    `${GAS_URL}?action=${action}`,
        onload: (res) => {
          try { resolve(JSON.parse(res.responseText)); }
          catch (e) { reject(new Error("JSON parse error: " + res.responseText.slice(0, 100))); }
        },
        onerror: (e) => reject(new Error("網路錯誤")),
      });
    });
  }

  function clearGasPendingOrder() {
    GM_xmlhttpRequest({
      method:  "POST",
      url:     GAS_URL,
      data:    JSON.stringify({ action: "clear-pending-order" }),
      headers: { "Content-Type": "application/json" },
    });
  }

  var bannerEl = null;
  function showBanner(msg, color = "green") {
    if (bannerEl) bannerEl.remove();
    bannerEl = document.createElement("div");
    bannerEl.textContent = msg;
    const colors = { green: "#34c759", orange: "#ff9500", red: "#ff3b30" };
    Object.assign(bannerEl.style, {
      position: "fixed", top: "0", left: "0", right: "0", zIndex: "99999",
      background: colors[color] || color, color: "#fff",
      textAlign: "center", padding: "14px 20px",
      fontSize: "15px", fontWeight: "bold", boxShadow: "0 2px 8px rgba(0,0,0,.3)",
    });
    document.body.prepend(bannerEl);
    if (color === "green") setTimeout(() => bannerEl?.remove(), 5000);
  }

  var progressEl = null;
  function showProgress(idx, total, name) {
    if (!progressEl) {
      progressEl = document.createElement("div");
      Object.assign(progressEl.style, {
        position: "fixed", bottom: "20px", right: "20px", zIndex: "99999",
        background: "#1c1c1e", color: "#fff", borderRadius: "12px",
        padding: "12px 18px", fontSize: "13px", boxShadow: "0 4px 16px rgba(0,0,0,.4)",
        maxWidth: "260px",
      });
      document.body.appendChild(progressEl);
    }
    progressEl.innerHTML = `
      <div style="font-size:11px;color:#aaa;margin-bottom:4px">自動加入中…</div>
      <div style="font-weight:700">${idx + 1} / ${total}</div>
      <div style="font-size:12px;color:#ddd;margin-top:2px">${name}</div>
    `;
  }

  function log(msg) { console.log("[iGo Auto]", msg); }
})();
