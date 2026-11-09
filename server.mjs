import http from "node:http";
import https from "node:https";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT) || 8080;
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
      keepAlive: true,
    });
    console.log("[serpro] Agente mTLS com certificado e-CNPJ configurado com sucesso.");
  } catch (err) {
    console.error("[serpro] Falha ao carregar certificado mTLS:", err.message);
  }
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
    req.on("timeout", () => req.destroy(new Error("Timeout na requisição SERPRO")));
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

let tokenCache = null;

async function obterTokenSerpro() {
  if (!SERPRO_KEY || !SERPRO_SECRET || !serproHttpsAgent) {
    throw new Error("Credenciais ou certificado mTLS do SERPRO não configurados.");
  }
  const agora = Date.now();
  if (tokenCache && tokenCache.expiraEm > agora + 60_000) {
    return tokenCache;
  }

  const basic = Buffer.from(SERPRO_KEY + ":" + SERPRO_SECRET).toString("base64");
  const corpo = "grant_type=client_credentials";

  const res = await requestHttpsComAgente(
    "https://autenticacao.sapi.serpro.gov.br/authenticate",
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + basic,
        "Role-Type": "TERCEIROS",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(corpo),
      },
    },
    corpo
  );

  const txt = res.body.toString("utf8");
  if (res.status !== 200) {
    console.error("[serpro auth]", res.status, txt);
    throw new Error("Falha autenticação SERPRO (" + res.status + "): " + txt.slice(0, 300));
  }

  const data = JSON.parse(txt);
  tokenCache = {
    accessToken: data.access_token,
    jwtToken: data.jwt_token,
    expiraEm: agora + (Number(data.expires_in) || 3600) * 1000,
  };
  return tokenCache;
}

async function emitirDasViaSerpro({ cnpj, ano, mes }) {
  if (!SERPRO_KEY || !serproHttpsAgent) {
    return null;
  }
  const { accessToken, jwtToken } = await obterTokenSerpro();
  const cnpjContribuinte = String(cnpj).replace(/\D/g, "");
  const cnpjContratante = SERPRO_CNPJ || cnpjContribuinte;
  const mesFormatado = String(mes).padStart(2, "0");
  const periodoApuracao = ano + mesFormatado;

  const envelope = {
    contratante: { numero: cnpjContratante, tipo: 2 },
    autorPedidoDados: { numero: cnpjContratante, tipo: 2 },
    contribuinte: { numero: cnpjContribuinte, tipo: 2 },
    pedidoDados: {
      idSistema: "PGMEI",
      idServico: "GERARDASPDF21",
      versaoSistema: "1.0",
      dados: JSON.stringify({
        periodoApuracao,
      }),
    },
  };

  const payload = JSON.stringify(envelope);

  const headersSerpro = {
    Authorization: "Bearer " + accessToken,
    jwt_token: jwtToken,
    "jwt-token": jwtToken,
    "Role-Type": "TERCEIROS",
    "Content-Type": "application/json",
    Accept: "application/json",
    "Content-Length": Buffer.byteLength(payload),
  };

  let resposta = await requestHttpsComAgente(
    "https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/Emitir",
    { method: "POST", headers: headersSerpro },
    payload
  );

  if (resposta.status === 404 || resposta.status === 405) {
    resposta = await requestHttpsComAgente(
      "https://gateway.apiserpro.serpro.gov.br/integra-contador/v1/Consultar",
      { method: "POST", headers: headersSerpro },
      payload
    );
  }

  const rawTxt = resposta.body.toString("utf8");
  console.log("[serpro status]: HTTP " + resposta.status);
  try {
    const parsed = JSON.parse(rawTxt);
    console.log("[serpro resposta]:", JSON.stringify(parsed.mensagens || parsed, null, 2));
  } catch {
    console.log("[serpro raw]:", rawTxt);
  }

  if (resposta.status < 200 || resposta.status >= 300) {
    throw new Error("SERPRO HTTP " + resposta.status + ": " + rawTxt.slice(0, 300));
  }

  const json = JSON.parse(rawTxt);
  let dadosRetorno = json?.respostaDados?.dados || json?.dados;
  if (typeof dadosRetorno === "string") {
    try {
      dadosRetorno = JSON.parse(dadosRetorno);
    } catch {}
  }

  const dasItem = Array.isArray(dadosRetorno) ? dadosRetorno[0] : dadosRetorno;
  const pdfBase64 =
    dasItem?.pdf ||
    dasItem?.documentoPdf ||
    dasItem?.arquivoPdf ||
    json?.pdf;

  const detalhamento = Array.isArray(dasItem?.detalhamento) ? dasItem.detalhamento[0] : dasItem?.detalhamento;
  const codigoBarras =
    dasItem?.codigoBarras ||
    detalhamento?.codigoDeBarras ||
    dasItem?.linhaDigitavel ||
    null;

  const valor = detalhamento?.valores?.total || dasItem?.valorTotal || null;

  if (!pdfBase64) {
    const msg =
      json?.mensagens?.map((m) => m.texto).join("; ") ||
      dasItem?.mensagens?.[0]?.texto ||
      dasItem?.mensagem ||
      "Guia não retornou PDF.";
    throw new Error("SERPRO: " + msg);
  }

  return {
    pdf_base64: pdfBase64,
    codigo_barras: codigoBarras,
    valor,
    fonte: "serpro"
  };
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

    const linhaMes = await page.$("tr:has-text('" + String(mes).padStart(2, "0") + "/" + ano + "')");
    if (!linhaMes) {
      throw new Error("Competência " + mes + "/" + ano + " não encontrada.");
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
    const codigoBarras = pdfBuffer.toString("latin1").match(/\d{11}\s?\d\s?\d{11}\s?\d\s?\d{11}\s?\d\s?\d{11}\s?\d/)?.[0];

    return {
      pdf_base64: pdfBuffer.toString("base64"),
      codigo_barras: codigoBarras,
      valor: undefined,
      fonte: "pgmei",
    };
  } finally {
    await browser.close();
  }
}

const server = http.createServer(async (req, res) => {
  const send = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (req.method === "GET" && req.url === "/health") {
    return send(200, {
      ok: true,
      status: "online",
      serproAtivo: Boolean(SERPRO_KEY && SERPRO_CERT_B64),
    });
  }

  if (req.method !== "POST" || req.url !== "/emitir") {
    return send(404, { ok: false, erro: "Rota não encontrada" });
  }

  if (AUTH_TOKEN) {
    const auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + AUTH_TOKEN) {
      return send(401, { ok: false, erro: "Token inválido" });
    }
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const { cnpj, ano, mes } = JSON.parse(body || "{}");
      if (!cnpj || !ano || !mes) {
        return send(400, { ok: false, erro: "Parâmetros obrigatórios: cnpj, ano, mes" });
      }

      console.log("[emitir] Solicitado DAS para CNPJ " + cnpj + " - " + mes + "/" + ano);

      if (SERPRO_KEY && SERPRO_CERT_B64) {
        try {
          console.log("[emitir] Tentando via SERPRO Integra Contador...");
          const resultadoSerpro = await emitirDasViaSerpro({ cnpj, ano, mes });
          if (resultadoSerpro?.pdf_base64) {
            console.log("[emitir] Sucesso via SERPRO!");
            return send(200, { ok: true, ...resultadoSerpro });
          }
        } catch (errSerpro) {
          console.error("[emitir] Falha no SERPRO:", errSerpro.message);
          console.log("[emitir] Tentando fallback via navegador...");
        }
      }

      const resultadoNavegador = await emitirDasViaPlaywright({ cnpj, ano, mes });
      return send(200, { ok: true, ...resultadoNavegador });
    } catch (err) {
      console.error("[emitir] Erro final:", err.message);
      return send(500, { ok: false, erro: err.message });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Robô do DAS rodando em 0.0.0.0:" + PORT);
});
