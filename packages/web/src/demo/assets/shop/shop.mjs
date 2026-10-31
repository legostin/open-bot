// A made-up water delivery shop for the demo's browser chapter: one page per step of ordering water, in each locale.
// scripts/render-shop.mjs renders them into the frames the live view shows (static/frames/<locale>/<page>.jpg) and
// records where the parts the person points at are (map.json, in 0…1 of the picture).

export const PAGES = ["home", "catalogue", "product", "product2", "cart", "done"];

const TEXT = {
  en: {
    brand: "AquaDrop",
    domain: "aquadrop.example",
    tagline: "Spring water to your door in two hours",
    nav: ["Catalogue", "Delivery", "Subscriptions", "Help"],
    cart: "Cart",
    heroCta: "Open the catalogue",
    heroNote: "Lisbon and around · every day 8:00–22:00",
    catalogue: "Catalogue",
    items: [
      ["Water 19 L", "€4.90", "Spring water in a returnable bottle"],
      ["Water 5 L × 4", "€6.40", "For the kitchen and travels"],
      ["Water 0.5 L × 24", "€7.20", "Still, in glass"],
      ["Dispenser", "€39.00", "Cold and room temperature"],
    ],
    product: "Water 19 L",
    productLong: "Spring water from Serra da Estrela, bottled the day before delivery. The bottle is returnable: we take the empty one when we bring the full.",
    price: "€4.90",
    qty: "Quantity",
    add: "Add to cart",
    cartTitle: "Your cart",
    line: "Water 19 L × 2",
    lineSum: "€9.80",
    deposit: "Bottle deposit (returning 2)",
    depositSum: "€0.00",
    slot: "Delivery today, 16:00–18:00",
    address: "Rua das Flores 12, 3rd floor",
    total: "Total",
    totalSum: "€9.80",
    order: "Place order",
    doneTitle: "Order #4182 is placed",
    doneText: "The courier arrives today between 16:00 and 18:00. We’ll text you half an hour before.",
  },
  ru: {
    brand: "Капля",
    domain: "kaplya.example",
    tagline: "Горная вода к двери за два часа",
    nav: ["Каталог", "Доставка", "Подписка", "Помощь"],
    cart: "Корзина",
    heroCta: "Открыть каталог",
    heroNote: "Алматы и пригород · каждый день 8:00–22:00",
    catalogue: "Каталог",
    items: [
      ["Вода 19 л", "1 450 ₸", "Горная вода в возвратной бутыли"],
      ["Вода 5 л × 4", "2 100 ₸", "Для кухни и поездок"],
      ["Вода 0,5 л × 24", "2 900 ₸", "Негазированная, в стекле"],
      ["Кулер", "24 900 ₸", "Холодная и комнатная"],
    ],
    product: "Вода 19 л",
    productLong: "Горная вода из ущелья Алатау, разлита накануне доставки. Бутыль возвратная: пустую заберём, когда привезём полную.",
    price: "1 450 ₸",
    qty: "Количество",
    add: "В корзину",
    cartTitle: "Корзина",
    line: "Вода 19 л × 2",
    lineSum: "2 900 ₸",
    deposit: "Залог за бутыли (возвращаете 2)",
    depositSum: "0 ₸",
    slot: "Доставка сегодня, 16:00–18:00",
    address: "ул. Желтоксан, 115, кв. 34",
    total: "Итого",
    totalSum: "2 900 ₸",
    order: "Оформить заказ",
    doneTitle: "Заказ № 4182 оформлен",
    doneText: "Курьер приедет сегодня с 16:00 до 18:00. Напишем за полчаса.",
  },
};

export function domainOf(locale) {
  return TEXT[locale].domain;
}

/** The page's title, as the browser's tab shows it. */
export function titleOf(locale, page) {
  const t = TEXT[locale];
  return { home: `${t.brand} — ${t.tagline}`, catalogue: `${t.catalogue} · ${t.brand}`, product: `${t.product} · ${t.brand}`, product2: `${t.product} · ${t.brand}`, cart: `${t.cartTitle} · ${t.brand}`, done: `${t.doneTitle} · ${t.brand}` }[page];
}

export function pathOf(page) {
  return { home: "/", catalogue: "/catalogue", product: "/catalogue/water-19", product2: "/catalogue/water-19", cart: "/cart", done: "/order/4182" }[page];
}

const BOTTLE = (w, accent = "#38bdf8") => `<svg viewBox="0 0 120 200" width="${w}" aria-hidden="true">
  <rect x="44" y="6" width="32" height="18" rx="5" fill="#0f3d5a"/>
  <path d="M40 24h40v14c0 6 26 16 26 40v96c0 12-8 20-20 20H34c-12 0-20-8-20-20V78c0-24 26-34 26-40z" fill="${accent}" opacity=".22"/>
  <path d="M40 24h40v14c0 6 26 16 26 40v96c0 12-8 20-20 20H34c-12 0-20-8-20-20V78c0-24 26-34 26-40z" fill="none" stroke="#0f3d5a" stroke-width="5"/>
  <path d="M20 112h80v62c0 9-6 15-15 15H35c-9 0-15-6-15-15z" fill="${accent}" opacity=".55"/>
  <path d="M26 96h68M26 150h68" stroke="#0f3d5a" stroke-width="4" opacity=".35"/>
</svg>`;

export function render(locale, page) {
  const t = TEXT[locale];
  const head = `<header class="top">
    <div class="logo"><span class="drop"></span>${t.brand}</div>
    <nav>${t.nav.map((n, i) => `<a ${i === 0 ? 'data-demo="nav-catalogue"' : ""}>${n}</a>`).join("")}</nav>
    <a class="cartlink">${t.cart}${page === "cart" || page === "done" ? "" : page === "product2" ? " · 0" : ""}</a>
  </header>`;
  let body = "";
  if (page === "home")
    body = `<section class="hero">
      <div><h1>${t.tagline}</h1><p>${t.heroNote}</p><a class="btn" data-demo="hero-cta">${t.heroCta}</a></div>
      <div class="hero-art">${BOTTLE(190)}${BOTTLE(150, "#7dd3fc")}</div>
    </section>
    <section class="strip">${t.items.slice(0, 3).map(([n, p]) => `<div class="mini"><b>${n}</b><span>${p}</span></div>`).join("")}</section>`;
  if (page === "catalogue")
    body = `<h2 class="h2">${t.catalogue}</h2><section class="grid">${t.items
      .map(([n, p, d], i) => `<article class="card" ${i === 0 ? 'data-demo="item-19"' : ""}><div class="art">${BOTTLE(i === 3 ? 90 : 110, ["#38bdf8", "#7dd3fc", "#a5f3fc", "#94a3b8"][i])}</div><b>${n}</b><span class="muted">${d}</span><span class="price">${p}</span></article>`)
      .join("")}</section>`;
  if (page === "product" || page === "product2")
    body = `<section class="product">
      <div class="big-art">${BOTTLE(240)}</div>
      <div class="info"><h2>${t.product}</h2><p class="muted">${t.productLong}</p><div class="price big">${t.price}</div>
        <label class="qty-label">${t.qty}</label>
        <div class="qty"><span>−</span><span class="field${page === "product2" ? " focus" : ""}" data-demo="qty">${page === "product2" ? "2" : "1"}</span><span>+</span></div>
        <a class="btn" data-demo="add">${t.add}</a></div>
    </section>`;
  if (page === "cart")
    body = `<section class="cart"><h2>${t.cartTitle}</h2>
      <div class="row"><span>${t.line}</span><b>${t.lineSum}</b></div>
      <div class="row muted"><span>${t.deposit}</span><span>${t.depositSum}</span></div>
      <div class="row muted"><span>${t.slot}</span><span></span></div>
      <div class="row muted"><span>${t.address}</span><span></span></div>
      <div class="row total" data-demo="total"><span>${t.total}</span><b>${t.totalSum}</b></div>
      <a class="btn wide" data-demo="order">${t.order}</a></section>`;
  if (page === "done")
    body = `<section class="done"><div class="tick">✓</div><h2>${t.doneTitle}</h2><p class="muted">${t.doneText}</p></section>`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1280px; height: 800px; overflow: hidden; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #0f2a3a; background: #f3f9fc; }
    a { color: inherit; text-decoration: none; }
    .top { display: flex; align-items: center; gap: 40px; padding: 22px 56px; background: #fff; box-shadow: 0 1px 0 #dbe9f1; }
    .logo { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 26px; letter-spacing: -0.02em; color: #0369a1; }
    .drop { width: 22px; height: 22px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); background: linear-gradient(135deg, #38bdf8, #0369a1); }
    nav { display: flex; gap: 28px; font-size: 17px; color: #335466; }
    nav a { padding: 6px 2px; }
    .cartlink { margin-left: auto; font-weight: 600; padding: 10px 18px; border-radius: 999px; background: #e0f2fe; color: #0369a1; }
    .hero { display: grid; grid-template-columns: 1.1fr 1fr; align-items: center; gap: 40px; padding: 70px 56px 40px; }
    h1 { font-size: 52px; line-height: 1.05; letter-spacing: -0.03em; max-width: 560px; }
    .hero p { margin: 18px 0 30px; font-size: 19px; color: #4b6b7c; }
    .hero-art { display: flex; align-items: flex-end; justify-content: center; gap: 10px; height: 320px; border-radius: 32px; background: radial-gradient(circle at 50% 70%, #bae6fd, #e0f2fe 70%); }
    .btn { display: inline-block; padding: 16px 30px; border-radius: 14px; background: #0284c7; color: #fff; font-weight: 700; font-size: 18px; box-shadow: 0 8px 20px -8px #0284c7; }
    .btn.wide { display: block; text-align: center; margin-top: 26px; }
    .strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; padding: 0 56px; }
    .mini { display: flex; justify-content: space-between; padding: 20px 24px; border-radius: 18px; background: #fff; font-size: 17px; box-shadow: 0 1px 0 #dbe9f1; }
    .h2 { font-size: 34px; letter-spacing: -0.02em; padding: 40px 56px 22px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; padding: 0 56px; }
    .card { display: flex; flex-direction: column; gap: 8px; padding: 18px; border-radius: 22px; background: #fff; box-shadow: 0 1px 0 #dbe9f1, 0 14px 30px -24px #0f2a3a; font-size: 17px; }
    .card .art { display: grid; place-items: center; height: 200px; border-radius: 16px; background: #eef7fc; }
    .muted { color: #5d7a8a; font-size: 15px; }
    .price { font-weight: 800; font-size: 22px; color: #0369a1; }
    .price.big { font-size: 34px; margin: 18px 0 22px; }
    .product { display: grid; grid-template-columns: 1fr 1.1fr; gap: 56px; padding: 50px 56px; }
    .big-art { display: grid; place-items: center; height: 560px; border-radius: 32px; background: radial-gradient(circle at 50% 65%, #bae6fd, #e0f2fe 70%); }
    .info h2 { font-size: 44px; letter-spacing: -0.02em; margin-bottom: 14px; }
    .info p { font-size: 18px; line-height: 1.5; max-width: 520px; }
    .qty-label { display: block; font-size: 15px; color: #5d7a8a; margin-bottom: 8px; }
    .qty { display: inline-flex; align-items: center; gap: 0; border-radius: 14px; background: #fff; box-shadow: 0 0 0 2px #cfe3ee; margin-bottom: 26px; font-size: 22px; }
    .qty span { padding: 12px 22px; }
    .qty .field { min-width: 70px; text-align: center; font-weight: 700; border-left: 2px solid #cfe3ee; border-right: 2px solid #cfe3ee; }
    .qty .field.focus { box-shadow: inset 0 0 0 3px #38bdf8; border-radius: 4px; }
    .info .btn { display: block; width: 360px; text-align: center; }
    .cart { margin: 40px auto; width: 720px; padding: 34px 40px; border-radius: 26px; background: #fff; box-shadow: 0 1px 0 #dbe9f1, 0 24px 50px -36px #0f2a3a; }
    .cart h2 { font-size: 32px; margin-bottom: 18px; }
    .row { display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #e6f0f5; font-size: 19px; }
    .row.muted { font-size: 16px; }
    .row.total { font-size: 26px; border-bottom: 0; padding-top: 20px; }
    .done { margin: 110px auto; width: 640px; text-align: center; }
    .tick { width: 96px; height: 96px; margin: 0 auto 26px; border-radius: 50%; display: grid; place-items: center; font-size: 52px; color: #fff; background: #16a34a; }
    .done h2 { font-size: 38px; margin-bottom: 14px; }
    .done p { font-size: 19px; line-height: 1.5; }
  </style></head><body>${head}${body}</body></html>`;
}
