(() => {
  const statusEl = document.getElementById("order-status");
  const payBtn = document.getElementById("pay-button");
  const payPanel = document.querySelector(".pay-panel");
  const salePriceEl = document.getElementById("sale-price");
  const payFeeTipEl = document.getElementById("pay-fee-tip");
  const promoInputEl = document.getElementById("promo-code");
  const promoApplyBtn = document.getElementById("apply-promo-button");
  const promoCodeTipEl = document.getElementById("promo-code-tip");

  if (!statusEl || !payBtn || !payPanel || !salePriceEl || !payFeeTipEl) {
    return;
  }

  const onepayBaseUrl = (payPanel.dataset.onepayBase || "https://onepay.minapp.xin").replace(/\/$/, "");
  const kvBaseUrl = "https://kv.minapp.xin";
  const kvPrefix = "xiake";
  const refStorageKey = "xiake_ref_code";
  const basePriceFen = Number(payPanel.dataset.basePriceFen || 0);
  const productTitle = payPanel.dataset.productTitle || "虾壳 2.0 小主机";
  const notifyUrl = (payPanel.dataset.notifyUrl || "").trim();
  const orderPrefix = (payPanel.dataset.orderPrefix || "XK").trim() || "XK";
  const defaultServiceWechat = "tianshe00";
  const serviceWechatEls = Array.from(document.querySelectorAll("[data-service-wechat]"));
  const proPromoDiscountFen = 2000;

  if (!Number.isFinite(basePriceFen) || basePriceFen <= 0) {
    statusEl.textContent = "价格配置异常，请联系管理员。";
    payBtn.disabled = true;
    return;
  }

  let activeRef = null;
  let refReadyPromise = null;
  let activeServiceWechat = defaultServiceWechat;

  const setStatus = (text) => {
    statusEl.textContent = text;
  };

  const setButtonState = (loading) => {
    payBtn.disabled = loading;
    payBtn.textContent = loading ? "正在创建订单..." : "下单并去支付";
  };

  const sanitizeWechat = (raw) => String(raw || "").trim().replace(/\s+/g, "");

  const fenToYuan = (fen) => `¥${(fen / 100).toFixed(0)}`;

  const setPromoTip = (text, isError = false) => {
    if (!promoCodeTipEl) {
      return;
    }
    promoCodeTipEl.textContent = text;
    promoCodeTipEl.classList.toggle("text-error", isError);
    promoCodeTipEl.classList.toggle("text-base-content/60", !isError);
  };

  const normalizeLevel = (level) => (level === "pro" ? "pro" : "normal");
  const isProSkuByFee = (feeFen) => Number(feeFen) >= 100000;
  const getRebateFenByLevelAndFee = (level, feeFen) => {
    const normalizedLevel = normalizeLevel(level);
    if (normalizedLevel === "pro") {
      return isProSkuByFee(feeFen) ? 22000 : 15000;
    }
    return isProSkuByFee(feeFen) ? 2000 : 1000;
  };

  const createRefContext = (refCode, owner = null) => {
    const level = normalizeLevel(owner?.level);
    return {
      refCode,
      ownerPhone: owner?.phone || "",
      ownerWechat: sanitizeWechat(owner?.wechat || ""),
      level,
      rebateFen: getRebateFenByLevelAndFee(level, basePriceFen),
      hasOwner: Boolean(owner?.phone),
    };
  };

  const getPromoDiscountFen = () => {
    if (activeRef?.hasOwner && activeRef.level === "pro") {
      return proPromoDiscountFen;
    }
    return 0;
  };

  const getPayFeeFen = () => Math.max(basePriceFen - getPromoDiscountFen(), 0);

  const renderServiceWechat = () => {
    for (const el of serviceWechatEls) {
      el.textContent = activeServiceWechat;
    }
  };

  const sanitizeRefCode = (raw) => {
    if (!raw) {
      return null;
    }
    const code = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    return code.length >= 2 && code.length <= 24 ? code : null;
  };

  const getRefCodeFromUrl = () => {
    const searchParams = new URLSearchParams(window.location.search);
    const keys = ["ref", "refCode", "rcode", "invite", "code"];
    for (const key of keys) {
      const value = sanitizeRefCode(searchParams.get(key));
      if (value) {
        return value;
      }
    }
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    if (hash) {
      const hashParams = new URLSearchParams(hash);
      for (const key of keys) {
        const value = sanitizeRefCode(hashParams.get(key));
        if (value) {
          return value;
        }
      }
    }
    return null;
  };

  const kvUrl = (key) => `${kvBaseUrl}/kv/${encodeURIComponent(key)}`;

  const kvGetText = async (key) => {
    const response = await fetch(kvUrl(key));
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`KV GET failed: ${response.status}`);
    }
    return (await response.text()).trim();
  };

  const kvGetJson = async (key) => {
    const raw = await kvGetText(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  };

  const kvPutJson = async (key, payload) => {
    const response = await fetch(kvUrl(key), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`KV PUT failed: ${response.status}`);
    }
  };

  const kvPushLine = async (key, payload) => {
    const response = await fetch(`${kvUrl(key)}/push`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: `${JSON.stringify(payload)}\n`,
    });
    if (!response.ok) {
      throw new Error(`KV PUSH failed: ${response.status}`);
    }
  };

  const parseTimestamp = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  };

  const queryPaidOrderByOutTradeNo = async (outTradeNo) => {
    const queryUrl = `${onepayBaseUrl}/api/query-order?outTradeNo=${encodeURIComponent(outTradeNo)}`;
    const response = await fetch(queryUrl);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    if (Array.isArray(data.orders) && data.orders.length > 0) {
      return data.orders[0];
    }
    if (data.order && typeof data.order === "object") {
      return data.order;
    }
    return null;
  };

  const createOutTradeNo = (refCode) => {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    return `${orderPrefix}${Date.now()}${randomSuffix}${refCode ? `R${refCode}` : ""}`;
  };

  const buildRedirectUrl = (outTradeNo) => {
    const rawBase = payPanel.dataset.redirectUrl || `${window.location.origin}${window.location.pathname}`;
    const redirect = new URL(rawBase, window.location.origin);
    redirect.searchParams.set("paid", "1");
    redirect.searchParams.set("otn", outTradeNo);
    return redirect.toString();
  };

  const resolveServiceWechat = () => activeRef?.ownerWechat || defaultServiceWechat;

  const renderPromoState = () => {
    if (!promoCodeTipEl) {
      return;
    }
    if (activeRef?.hasOwner && activeRef.level === "pro") {
      setPromoTip("已识别为高级推荐人，优惠 20 元。");
      return;
    }
    if (activeRef?.hasOwner) {
      setPromoTip("已识别推荐人类型，当前无优惠。");
      return;
    }
    setPromoTip("");
  };

  const renderPriceState = () => {
    const discountFen = getPromoDiscountFen();
    const payFeeFen = getPayFeeFen();
    salePriceEl.textContent = fenToYuan(payFeeFen);
    if (discountFen > 0) {
      payFeeTipEl.textContent = `当前支付金额：${fenToYuan(payFeeFen)}（已优惠 ${fenToYuan(discountFen)}）`;
      return;
    }
    payFeeTipEl.textContent = `当前支付金额：${fenToYuan(payFeeFen)}`;
  };

  const applyActiveRef = (nextRef) => {
    activeRef = nextRef;
    activeServiceWechat = resolveServiceWechat();
    renderServiceWechat();
    renderPriceState();
    renderPromoState();
  };

  const setPromoApplyState = (loading) => {
    if (promoApplyBtn) {
      promoApplyBtn.disabled = loading;
      promoApplyBtn.textContent = loading ? "校验中..." : "应用";
    }
  };

  const resolveRefInfo = async (refCode) => {
    const ownerPhone = await kvGetText(`${kvPrefix}:ref:code:${refCode}`);
    if (!ownerPhone) {
      return null;
    }
    const owner = await kvGetJson(`${kvPrefix}:ref:user:${ownerPhone}`);
    return createRefContext(refCode, {
      phone: ownerPhone,
      level: owner?.level,
      wechat: owner?.wechat,
    });
  };

  const applyPromoCode = async () => {
    if (!promoInputEl) {
      return true;
    }
    const promoCode = sanitizeRefCode(promoInputEl.value);
    if (!promoCode) {
      applyActiveRef(null);
      localStorage.removeItem(refStorageKey);
      return true;
    }
    if (activeRef?.refCode === promoCode && activeRef?.hasOwner) {
      renderPromoState();
      return true;
    }
    setPromoApplyState(true);
    try {
      const resolved = await resolveRefInfo(promoCode);
      if (!resolved) {
        setPromoTip("优惠码无效，请检查后重试。", true);
        return false;
      }
      promoInputEl.value = resolved.refCode;
      applyActiveRef(resolved);
      localStorage.setItem(refStorageKey, resolved.refCode);
      return true;
    } catch (error) {
      applyActiveRef(createRefContext(promoCode));
      localStorage.setItem(refStorageKey, promoCode);
      setPromoTip("优惠码校验失败，请稍后重试。", true);
      return true;
    } finally {
      setPromoApplyState(false);
    }
  };

  const initRefCode = async () => {
    const fromUrl = getRefCodeFromUrl();
    const fromStorage = sanitizeRefCode(localStorage.getItem(refStorageKey));
    const initialRefCode = fromUrl || fromStorage;
    if (!initialRefCode) {
      applyActiveRef(null);
      return;
    }
    if (promoInputEl) {
      promoInputEl.value = initialRefCode;
    }
    applyActiveRef(createRefContext(initialRefCode));
    localStorage.setItem(refStorageKey, initialRefCode);
    try {
      const resolved = await resolveRefInfo(initialRefCode);
      if (resolved) {
        applyActiveRef(resolved);
      } else {
        applyActiveRef(null);
        if (promoInputEl) {
          promoInputEl.value = "";
        }
        localStorage.removeItem(refStorageKey);
        setPromoTip("优惠码无效，请检查后重试。", true);
      }
    } catch (error) {
      // 无网络时保持推荐码归属草稿，不阻断下单。
      setPromoTip("网络异常，优惠码暂不可用。", true);
    }
  };

  const syncPaidOrderIfNeeded = async () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("paid") !== "1") {
      return;
    }
    if (refReadyPromise) {
      try {
        await refReadyPromise;
      } catch (error) {
        // 推荐信息读取失败时保持默认客服微信。
      }
    }
    const outTradeNo = (params.get("otn") || "").trim();
    if (!outTradeNo) {
      setStatus(`已完成支付，24 小时内自动发货，如有疑问请联系微信客服 ${activeServiceWechat}。`);
      return;
    }
    setStatus("支付结果确认中...");
    const paidOrder = await queryPaidOrderByOutTradeNo(outTradeNo);
    if (!paidOrder) {
      setStatus(`支付已返回，如未自动发货请联系微信客服 ${activeServiceWechat}。`);
      return;
    }
    const detailKey = `${kvPrefix}:ref:order:${outTradeNo}`;
    const existing = await kvGetJson(detailKey);
    if (existing) {
      existing.payStatus = "paid";
      existing.paidAt = parseTimestamp(paidOrder.paidAt || paidOrder.updatedAt || paidOrder.createdAt) || Date.now();
      existing.onepayOrderId = paidOrder.id || paidOrder._id || "";
      await kvPutJson(detailKey, existing);
    }
    setStatus(`已完成支付，24 小时内自动发货，如有疑问请联系微信客服 ${activeServiceWechat}。`);
  };

  renderPriceState();
  renderServiceWechat();
  renderPromoState();
  refReadyPromise = initRefCode();

  if (promoApplyBtn && promoInputEl) {
    promoApplyBtn.addEventListener("click", async () => {
      const ok = await applyPromoCode();
      if (ok) {
        setStatus("优惠码已更新。");
      }
    });
    promoInputEl.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      await applyPromoCode();
    });
    promoInputEl.addEventListener("input", () => {
      if (promoCodeTipEl && !promoInputEl.value.trim()) {
        renderPromoState();
      }
    });
  }

  payBtn.addEventListener("click", async () => {
    if (!onepayBaseUrl) {
      setStatus("请先配置支付服务地址。");
      return;
    }

    setButtonState(true);
    setStatus("正在创建订单...");

    try {
      if (refReadyPromise) {
        await refReadyPromise;
      }
      if (promoInputEl) {
        const promoOk = await applyPromoCode();
        if (!promoOk) {
          setStatus("优惠码无效，请检查后重试。");
          setButtonState(false);
          return;
        }
      }
      const feeFen = getPayFeeFen();
      const outTradeNo = createOutTradeNo(activeRef?.refCode || "");
      const redirectUrl = buildRedirectUrl(outTradeNo);
      if (activeRef?.hasOwner) {
        const referralOrder = {
          outTradeNo,
          refCode: activeRef.refCode,
          refPhone: activeRef.ownerPhone,
          refLevel: activeRef.level,
          rebateFen: activeRef.rebateFen,
          feeFen,
          originFeeFen: basePriceFen,
          promoDiscountFen: basePriceFen - feeFen,
          createdAt: Date.now(),
          payStatus: "created",
        };
        await kvPushLine(`${kvPrefix}:ref:orders:${activeRef.refCode}`, referralOrder);
        await kvPutJson(`${kvPrefix}:ref:order:${outTradeNo}`, referralOrder);
      }
      const params = new URLSearchParams({
        fee: String(feeFen),
        redirectUrl,
        title: productTitle,
        fields: "ship",
        outTradeNo,
      });
      if (notifyUrl) {
        params.set("notifyUrl", notifyUrl);
      }
      const targetUrl = `${onepayBaseUrl}/api/create-order?${params.toString()}`;
      setStatus("正在跳转支付页...");
      window.location.href = targetUrl;
    } catch (error) {
      setStatus(`下单失败，请稍后重试或联系微信客服 ${activeServiceWechat}。`);
      setButtonState(false);
    }
  });

  syncPaidOrderIfNeeded().catch(() => {
    setStatus(`支付已返回，如未自动发货请联系微信客服 ${activeServiceWechat}。`);
  });
})();
