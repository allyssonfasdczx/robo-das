// Robô do DAS-MEI — roda FORA do app (Railway/Render/VPS com Node 20 + Playwright).
// 1º caminho: API oficial SERPRO Integra Contador (PGMEI GERARDASPDF21) — sem CAPTCHA.
//    Exige mTLS com o e-CNPJ da Otmizee, por isso fica aqui (o app na borda não faz mTLS).
//    Variáveis: SERPRO_CONSUMER_KEY, SERPRO_CONSUMER_SECRET, SERPRO_CNPJ (contratante),
//    SERPRO_CERT_BASE64 (arquivo .pfx em base64), SERPRO_CERT_SENHA.
// 2º caminho (fallback): navegador no PGMEI. Não contorna CAPTCHA.
// Também: ROBO_DAS_TOKEN (mesmo valor salvo no OtmizeeMEI), PORT.
import http from "node:http";
import https from "node:https";
import { chromium } from "playwright";
import jsQR from "jsqr";
import jpeg from "jpeg-js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Lê a linha digitável (texto da guia) e o PIX copia-e-cola (QR Code em JPEG dentro do PDF).
async function lerGuia(buf) {
  let linha, pix;
  try {
    const doc = await getDocument({ data: new Uint8Array(buf), disableFontFace: true, verbosity: 0 }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    const txt = tc.items.map((i) => i.str).join(" ").replace(/\s+/g, " ");
    linha = txt.match(/8\d{10} ?\d ?\d{11} ?\d ?\d{11} ?\d ?\d{11} ?\d/)?.[0];
  } catch (e) { console.error("linha", e.message); }
  try {
    const s = buf.toString("latin1");
    let i = 0;
    while (!pix && (i = s.indexOf("\xFF\xD8\xFF", i)) !== -1) {
      const e = s.indexOf("\xFF\xD9", i);
      if (e === -1) break;
      const img = jpeg.decode(buf.subarray(i, e + 2), { useTArray: true, formatAsRGBA: true });
      const q = jsQR(img.data, img.width, img.height);
      if (q?.data?.startsWith("000201")) pix = q.data;
      i = e;
    }
  } catch (e) { console.error("pix", e.message); }
  return { linha, pix };
}

const TOKEN = process.env.ROBO_DAS_TOKEN;
const PGMEI = "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao";
if (!TOKEN) throw new Error("Defina ROBO_DAS_TOKEN");

// ---------------- SERPRO Integra Contador ----------------
const S = {
  key: process.env.SERPRO_CONSUMER_KEY,
  secret: process.env.SERPRO_CONSUMER_SECRET,
  cnpj: (process.env.SERPRO_CNPJ || "").replace(/\D/g, ""),
  pfx: process.env.SERPRO_CERT_BASE64,
  senha: process.env.SERPRO_CERT_SENHA,
};
const serproAtivo = () => !!(S.key && S.secret && S.cnpj.length === 14 && S.pfx);
let agent;
const getAgent = () => (agent ??= new https.Agent({ pfx: Buffer.from(S.pfx, "base64"), passphrase: S.senha, keepAlive: true }));

function req(url, { method = "POST", headers = {}, body, mtls = false } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers, agent: mtls ? getAgent() : undefined, timeout: 60000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

let tokenCache = null; // { access, jwt, exp }
async function serproToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache;
  const r = await req("https://autenticacao.sapi.serpro.gov.br/authenticate", {
    mtls: true,
    headers: {
      Authorization: "Basic " + Buffer.from(`${S.key}:${S.secret}`).toString("base64"),
      "Role-Type": "TERCEIROS",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (r.status !== 200) throw new Error(`SERPRO auth ${r.status}: ${r.text.slice(0, 300)}`);
  const j = JSON.parse(r.text);
  tokenCache = { access: j.access_token, jwt: j.jwt_token, exp: Date.now() + (Number(j.expires_in) || 2000) * 1000 };
  return tokenCache;
}

async function emitirSerpro({ cnpj, ano, mes }) {
  const t = await serproToken();
  const body = JSON.stringify({
    contratante: { numero: S.cnpj, tipo: 2 },
    autorPedidoDados: { numero: S.cnpj, tipo: 2 },
    contribuinte: { numero: cnpj, tipo: 2 },
    pedidoDados: { idSistema: "PGMEI", idServico: "GERARDASPDF21", versaoSistema: "1.0", dados: JSON.stringify({ periodoApuracao: `${ano}${mes}` }) },
  });
  const r = await req("https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/Emitir", {
    headers: { Authorization: `Bearer ${t.access}`, jwt_token: t.jwt, "Content-Type": "application/json", accept: "application/json" },
    body,
  });
  let j = {};
  try { j = JSON.parse(r.text); } catch {}
  if (r.status !== 200) {
    const msg = (j.mensagens || []).map((m) => m.texto).join("; ");
    console.error("SERPRO emitir", r.status, r.text.slice(0, 500));
    return { ok: false, erro: msg || "A Receita não gerou a guia agora. Tente novamente.", definitivo: r.status < 500 };
  }
  const das = (typeof j.dados === "string" ? JSON.parse(j.dados) : j.dados)?.[0] ?? {};
  const det = Array.isArray(das.detalhamento) ? das.detalhamento[0] : das.detalhamento ?? {};
  const codigo = Array.isArray(det.codigoDeBarras) ? det.codigoDeBarras.join(" ") : det.codigoDeBarras;
  if (!das.pdf) return { ok: false, erro: "Esta competência não está disponível (pode já estar paga).", definitivo: true };
  const lido = await lerGuia(Buffer.from(das.pdf, "base64"));
  return { ok: true, fonte: "serpro", pdf_base64: das.pdf, codigo_barras: codigo || lido.linha, pix: lido.pix, valor: det.valores?.total };
}

// ---------------- Fallback: navegador no PGMEI ----------------
let browser;
const getBrowser = async () => (browser ??= await chromium.launch({ headless: true }));

async function emitirNavegador({ cnpj, ano, mes }) {
  const ctx = await (await getBrowser()).newContext({ acceptDownloads: true, locale: "pt-BR" });
  const page = await ctx.newPage();
  try {
    await page.goto(PGMEI, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.fill("#cnpj", cnpj);
    await page.click("#continuar");
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    if (await page.locator("iframe[src*='hcaptcha'], iframe[src*='recaptcha']").count())
      return { ok: false, erro: "A Receita pediu verificação humana. Use o botão 'Gerar guia oficial'." };
    if (!/emissao|Emissao/.test(page.url())) await page.click("a[href*='/emissao']");
    await page.waitForSelector("select#anoCalendarioSelect, select[name='ano']", { timeout: 20000 });
    await page.selectOption("select#anoCalendarioSelect, select[name='ano']", ano);
    await page.click("button[type='submit']:has-text('Ok'), button:has-text('Ok')");
    const box = page.locator(`input[type='checkbox'][value='${ano}${mes}']`);
    if (!(await box.count())) return { ok: false, erro: "Esta competência não está disponível (pode já estar paga)." };
    await box.check();
    await page.click("#btnEmitirDas");
    const valor = (await page.locator("text=/R\\$\\s*[\\d.,]+/").first().textContent().catch(() => null)) ?? undefined;
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      page.click("a:has-text('Imprimir/Visualizar PDF'), a[href*='imprimir']"),
    ]);
    const chunks = [];
    for await (const c of await download.createReadStream()) chunks.push(c);
    const pdf = Buffer.concat(chunks);
    const codigo = pdf.toString("latin1").match(/\d{11}\s?\d\s?\d{11}\s?\d\s?\d{11}\s?\d\s?\d{11}\s?\d/)?.[0];
    const lido = await lerGuia(pdf);
    return { ok: true, fonte: "pgmei", pdf_base64: pdf.toString("base64"), codigo_barras: lido.linha || codigo, pix: lido.pix, valor };
  } catch (e) {
    console.error(e);
    return { ok: false, erro: "O site da Receita mudou ou está fora do ar. Tente mais tarde." };
  } finally {
    await ctx.close();
  }
}

async function emitir(p) {
  if (serproAtivo()) {
    try {
      const r = await emitirSerpro(p);
      if (r.ok || r.definitivo) return r;
    } catch (e) { console.error("SERPRO", e.message); }
  }
  return emitirNavegador(p);
}

const PORT = Number(process.env.PORT) || 3000;
http.createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  try {
    if (req.url === "/health") return send(200, { ok: true, status: "online", serpro: serproAtivo() });
    if (req.method !== "POST" || req.url !== "/emitir") return send(404, { ok: false });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { ok: false, erro: "Não autorizado" });
    let body = "";
    for await (const c of req) body += c;
    const { cnpj, ano, mes } = JSON.parse(body || "{}");
    if (!/^\d{14}$/.test(cnpj ?? "") || !/^\d{4}$/.test(ano ?? "") || !/^\d{2}$/.test(mes ?? ""))
      return send(400, { ok: false, erro: "Dados inválidos" });
    send(200, await emitir({ cnpj, ano, mes }));
  } catch (e) {
    console.error(e);
    send(500, { ok: false, erro: "Erro interno do robô." });
  }
}).listen(PORT, "0.0.0.0", () => console.log(`Robô do DAS ouvindo em 0.0.0.0:${PORT}`));
