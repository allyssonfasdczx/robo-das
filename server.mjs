import http from "node:http";
import { chromium } from "playwright";

const TOKEN = process.env.ROBO_DAS_TOKEN;
const PGMEI = "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao";
if (!TOKEN) throw new Error("Defina ROBO_DAS_TOKEN");

const PORT = Number(process.env.PORT) || 3000;

let browser;
const getBrowser = async () => (browser ??= await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] }));

async function emitir({ cnpj, ano, mes }) {
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
    return { ok: true, pdf_base64: pdf.toString("base64"), codigo_barras: codigo, valor };
  } catch (e) {
    console.error(e);
    return { ok: false, erro: "O site da Receita mudou ou está fora do ar. Tente mais tarde." };
  } finally {
    await ctx.close();
  }
}

const server = http.createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (req.url === "/health") return send(200, { ok: true, status: "online" });
  if (req.method !== "POST" || req.url !== "/emitir") return send(404, { ok: false });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { ok: false, erro: "Não autorizado" });
  let body = "";
  for await (const c of req) body += c;
  const { cnpj, ano, mes } = JSON.parse(body || "{}");
  if (!/^\d{14}$/.test(cnpj ?? "") || !/^\d{4}$/.test(ano ?? "") || !/^\d{2}$/.test(mes ?? ""))
    return send(400, { ok: false, erro: "Dados inválidos" });
  send(200, await emitir({ cnpj, ano, mes }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Robô do DAS ouvindo em 0.0.0.0:${PORT}`);
});
