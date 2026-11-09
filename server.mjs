import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import crypto from "node:crypto";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT) || 3000;
const AUTH_TOKEN = process.env.ROBO_DAS_TOKEN;
if (!AUTH_TOKEN) {
  console.error("ERRO: defina a variável ROBO_DAS_TOKEN!");
  process.exit(1);
}

const SERPRO_KEY = process.env.SERPRO_CONSUMER_KEY;
const SERPRO_SECRET = process.env.SERPRO_CONSUMER_SECRET;
const SERPRO_CNPJ = (process.env.SERPRO_CNPJ || "").replace(/\D/g, "");
const SERPRO_CERT_B64 = process.env.SERPRO_CERT_BASE64;
const SERPRO_CERT_PASS = process.env.SERPRO_CERT_SENHA;

let serproHttpsAgent = null;
if (SERPRO_CERT_B64) {
  try {
    const pfxBuffer = Buffer.from(SERPRO_CERT_B64, "base64");
    serproHttpsAgent = new https.Agent({
      pfx: pfxBuffer,
      passphrase: SERPRO_CERT_PASS || "",
      rejectUnauthorized: true,
    });
    console.log("[serpro] Agente mTLS com certificado e-CNPJ configurado.");
  } catch (err) {
    console.error("[serpro] Falha ao carregar certificado mTLS:", err.message);
  }
}

let serproTokenCache = { token: null, expiraEm: 0 };

async function obterTokenSerpro() {
  if (!SERPRO_KEY || !SERPRO_SECRET) {
    throw new Error("Credenciais do SERPRO não configuradas.");
  }
  const agora = Date.now();
  if (serproTokenCache.token && serproTokenCache.expiraEm > agora + 60_000) {
    return serproTokenCache.token;
  }
  const basic = Buffer.from(`${SERPRO_KEY}:${SERPRO_SECRET}`).toString("base64");
  const corpo = new URLSearchParams({ grant_type: "client_credentials" }).toString();

  const res = await fetch("https://gateway.apiserpro.serpro.gov.br/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: corpo,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Falha OAuth SERPRO (${res.status}): ${txt}`);
  }
  const data = await res.json();
  serproTokenCache = {
    token: data.access_token,
    expiraEm: agora + (Number(data.expires_in) || 3600) * 1000,
  };
  return serproTokenCache.token;
}

function requestHttpsComAgente(urlStr, options, bodyData) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      url,
      {
        ...options,
        agent: serproHttpsAgent,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        });
      }
    );
    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function emitirDasViaSerpro({ cnpj, ano, mes }) {
  if (!SERPRO_KEY || !serproHttpsAgent) {
    return null;
  }
  const token = await obterTokenSerpro();
  const cnpjContribuinte = String(cnpj).replace(/\D/g, "");
  const cnpjContratante = SERPRO_CNPJ || cnpjContribuinte;
  const mesFormatado = String(mes).padStart(2, "0");
  const periodoApuracao = `${ano}${mesFormatado}`;

  const payload = JSON.stringify({
    contratante: { numero: cnpjContratante, tipo: 2 },
    autorTransmissao: { numero: cnpjContratante, tipo: 2 },
    contribuinte: { numero: cnpjContribuinte, tipo: 2 },
    pedidoDados: {
      idSistema: "PGMEI",
      idServico: "GERARDASPDF21",
      versaoSistema: "1.0",
      dados: JSON.stringify({
        periodoApuracao,
      }),
    },
  });

  const resposta = await requestHttpsComAgente(
    "https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/Consultar",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    payload
  );

  if (resposta.status < 200 || resposta.status >= 300) {
    const txt = resposta.body.toString("utf8");
    throw new Error(`SERPRO retornou HTTP ${resposta.status}: ${txt.slice(0, 300)}`);
  }

  const json = JSON.parse(resposta.body.toString("utf8"));
  let dadosRetorno = json?.respostaDados?.dados;
  if (typeof dadosRetorno === "string") {
    try {
      dadosRetorno = JSON.parse(dadosRetorno);
    } catch {
      // mantém como string
    }
  }

  const pdfBase64 =
    dadosRetorno?.pdf ||
    dadosRetorno?.documentoPdf ||
    dadosRetorno?.arquivoPdf ||
    json?.pdf;

  const codigoBarras =
    dadosRetorno?.codigoBarras ||
    dadosRetorno?.linhaDigitavel ||
    dadosRetorno?.numeroCodigoBarras ||
    null;

  if (!pdfBase64) {
    const msg = dadosRetorno?.mensagens?.[0]?.texto || dadosRetorno?.mensagem || JSON.stringify(dadosRetorno).slice(0, 200);
    throw new Error(`SERPRO não retornou o PDF: ${msg}`);
  }

  return { pdfBase64, codigoBarras, provedor: "serpro" };
}

async function emitirDasViaPlaywright({ cnpj, ano, mes }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto("https://www8.receita.fazenda.gov.br/simplesnacional/aplicacoes/atspo/pgmei.app/identificacao", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const temCaptcha = (await page.$(".h-captcha, iframe[src*='hcaptcha']")) !== null;
    if (temCaptcha) {
      throw new Error("A Receita pediu verificação humana. Use o botão 'Gerar guia oficial'.");
    }

    await page.fill("#cnpj", cnpj.replace(/\D/g, ""));
    await page.click("button[type='submit'], #btnContinuar");
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 });

    const linkGerar = await page.$("a[href*='gerar'], a:has-text('Emitir Guia')");
    if (!linkGerar) {
      throw new Error("Não foi possível acessar a tela de emissão do DAS.");
    }
    await linkGerar.click();
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 });

    await page.selectOption("select#ano, select[name*='ano']", String(ano));
    await page.click("button:has-text('OK'), button[type='submit']");
    await page.waitForTimeout(2000);

    const linhaMes = await page.$(`tr:has-text('${String(mes).padStart(2, "0")}/${ano}')`);
    if (!linhaMes) {
      throw new Error(`Competência ${mes}/${ano} não encontrada.`);
    }

    const checkbox = await linhaMes.$("input[type='checkbox']");
    if (checkbox) await checkbox.check();

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20000 }),
      page.click("button:has-text('Gerar DAS'), button:has-text('Emitir')"),
    ]);

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const pdfBuffer = Buffer.concat(chunks);

    return {
      pdfBase64: pdfBuffer.toString("base64"),
      codigoBarras: null,
      provedor: "playwright",
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: true,
        status: "online",
        serproAtivo: Boolean(SERPRO_KEY && serproHttpsAgent),
      })
    );
  }

  if (req.method === "POST" && url.pathname === "/emitir") {
    const authHeader = req.headers["authorization"] || "";
    const tokenEnviado = authHeader.replace(/^Bearer\s+/i, "");
    if (tokenEnviado !== AUTH_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, erro: "Não autorizado" }));
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { cnpj, ano, mes } = JSON.parse(body || "{}");
        if (!cnpj || !ano || !mes) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, erro: "CNPJ, ano e mês são obrigatórios" }));
        }

        console.log(`[emitir] Iniciando emissão DAS para CNPJ ${cnpj}, competência ${mes}/${ano}...`);

        let resultado = null;
        if (SERPRO_KEY && serproHttpsAgent) {
          try {
            console.log("[emitir] Tentando emissão via SERPRO Integra Contador...");
            resultado = await emitirDasViaSerpro({ cnpj, ano, mes });
            console.log("[emitir] Sucesso via SERPRO!");
          } catch (serproErr) {
            console.warn("[emitir] SERPRO falhou, tentando fallback navegador:", serproErr.message);
          }
        }

        if (!resultado) {
          resultado = await emitirDasViaPlaywright({ cnpj, ano, mes });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, ...resultado }));
      } catch (err) {
        console.error("[emitir] Erro geral:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ erro: "Não encontrado" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Robô DAS rodando na porta ${PORT} (0.0.0.0)`);
  console.log(`SERPRO Integra Contador: ${SERPRO_KEY && serproHttpsAgent ? "HABILITADO" : "NÃO CONFIGURADO"}`);
});
