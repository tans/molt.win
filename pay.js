(() => {
  const statusEl = document.getElementById("order-status");
  const payBtn = document.getElementById("pay-button");
  const payPanel = document.querySelector(".pay-panel");
  const salePriceEl = document.getElementById("sale-price");
  const payFeeTipEl = document.getElementById("pay-fee-tip");

  if (!statusEl || !payBtn || !payPanel || !salePriceEl || !payFeeTipEl) {
    return;
  }

  const payBaseUrl = (payPanel.dataset.onepayBase || "https://pay.jisuhudong.com").replace(/\/$/, "");
  const basePriceFen = Number(payPanel.dataset.basePriceFen || 0);
  const productTitle = payPanel.dataset.productTitle || "虾壳小主机";
  const notifyUrl = (payPanel.dataset.notifyUrl || "").trim();
  const orderPrefix = (payPanel.dataset.orderPrefix || "XK").trim() || "XK";
  const serviceWechat = "tianshe00";
  const serviceWechatEls = Array.from(document.querySelectorAll("[data-service-wechat]"));

  if (!Number.isFinite(basePriceFen) || basePriceFen <= 0) {
    statusEl.textContent = "价格配置异常，请联系管理员。";
    payBtn.disabled = true;
    return;
  }

  const fenToYuan = (fen) => `¥${(fen / 100).toFixed(0)}`;

  const setStatus = (text) => {
    statusEl.textContent = text;
  };

  const setButtonState = (loading) => {
    payBtn.disabled = loading;
    payBtn.textContent = loading ? "正在创建订单..." : "下单并去支付";
  };

  const renderStaticState = () => {
    salePriceEl.textContent = fenToYuan(basePriceFen);
    payFeeTipEl.textContent = `当前支付金额：${fenToYuan(basePriceFen)}`;
    for (const el of serviceWechatEls) {
      el.textContent = serviceWechat;
    }
  };

  const createOutTradeNo = () => {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    return `${orderPrefix}${Date.now()}${randomSuffix}`;
  };

  const buildRedirectUrl = (outTradeNo) => {
    const rawBase = payPanel.dataset.redirectUrl || `${window.location.origin}${window.location.pathname}`;
    const redirect = new URL(rawBase, window.location.origin);
    redirect.searchParams.set("paid", "1");
    redirect.searchParams.set("otn", outTradeNo);
    return redirect.toString();
  };

  const queryPaidOrderByOutTradeNo = async (outTradeNo) => {
    const queryUrl = `${payBaseUrl}/api/query-order?outTradeNo=${encodeURIComponent(outTradeNo)}`;
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

  const syncPaidOrderIfNeeded = async () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("paid") !== "1") {
      return;
    }
    const outTradeNo = (params.get("otn") || "").trim();
    if (!outTradeNo) {
      setStatus(`已完成支付，24 小时内自动发货，如有疑问请联系微信客服 ${serviceWechat}。`);
      return;
    }
    setStatus("支付结果确认中...");
    const paidOrder = await queryPaidOrderByOutTradeNo(outTradeNo);
    if (!paidOrder) {
      setStatus(`支付已返回，如未自动发货请联系微信客服 ${serviceWechat}。`);
      return;
    }
    setStatus(`已完成支付，24 小时内自动发货，如有疑问请联系微信客服 ${serviceWechat}。`);
  };

  renderStaticState();

  payBtn.addEventListener("click", () => {
    if (!payBaseUrl) {
      setStatus("请先配置支付服务地址。");
      return;
    }

    setButtonState(true);
    setStatus("正在创建订单...");

    try {
      const outTradeNo = createOutTradeNo();
      const redirectUrl = buildRedirectUrl(outTradeNo);
      const params = new URLSearchParams({
        fee: String(basePriceFen),
        redirectUrl,
        title: productTitle,
        fields: "ship",
        outTradeNo,
      });
      if (notifyUrl) {
        params.set("notifyUrl", notifyUrl);
      }
      setStatus("正在跳转支付页...");
      window.location.href = `${payBaseUrl}/api/create-order?${params.toString()}`;
    } catch (error) {
      setStatus(`下单失败，请稍后重试或联系微信客服 ${serviceWechat}。`);
      setButtonState(false);
    }
  });

  syncPaidOrderIfNeeded().catch(() => {
    setStatus(`支付已返回，如未自动发货请联系微信客服 ${serviceWechat}。`);
  });
})();
