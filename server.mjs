import http from "node:http";
import https from "node:https";
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
      keepAlive: true,
    });
    console.log("[serpro] Agente mTLS com certificado e-CNPJ configurado.");
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

  const basic = Buffer.from(`${SERPRO_KEY}:${SERPRO_SECRET}`).toString("base64");
  const corpo = "grant_type=client_credentials";

  // Autenticação oficial mTLS SERPRO Integra Contador (gera access_token e jwt_token)
  const res = await requestHttpsComAgente(
    "https://autenticacao.sapi.serpro.gov.br/authenticate",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
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
    throw new Error(`Falha autenticação SERPRO (${res.status}): ${txt.slice(0, 300)}`);
  }

  const data = JSON.parse(txt);
  tokenCache = {
    accessToken: data.access_token,
    jwtToken: data.jwt_token,
    expiraEm: agora + (Number(data.expires_in) || 3600) * 1000,
  };
  return tokenCache;
}

async function emitirDasViaSerpro({ cnpj, ano,
