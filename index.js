const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const pdf = require("pdf-parse");

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;

// Armazena contexto do PDF por número de telefone
const userContext = {};

// Rota de health check
app.get("/", (req, res) => res.send("Assistente WhatsApp Z-API online!"));

// Webhook Z-API
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body || body.fromMe) return;

    const from = body.phone;
    const type = body.type;

    if (type === "TEXT") {
      const text = body.text?.message || "";

      if (text.toLowerCase() === "limpar") {
        delete userContext[from];
        await sendMessage(from, "🗑️ Contexto limpo! Envie um PDF para começar.");
        return;
      }

      if (!userContext[from]) {
        await sendMessage(from, "👋 Olá! Envie um arquivo PDF para eu indexar e depois me faça perguntas sobre ele.");
        return;
      }

      await sendMessage(from, "🔍 Buscando nos documentos...");
      const resposta = await consultarClaude(from, text);
      await sendMessage(from, resposta);

    } else if (type === "DOCUMENT") {
      const docUrl = body.document?.documentUrl;
      const mime = body.document?.mimeType;

      if (mime !== "application/pdf") {
        await sendMessage(from, "⚠️ Por favor, envie apenas arquivos PDF.");
        return;
      }

      await sendMessage(from, "📄 PDF recebido! Processando... aguarde um momento.");

      try {
        const response = await axios.get(docUrl, { responseType: "arraybuffer" });
        const pdfBuffer = Buffer.from(response.data);
        const data = await pdf(pdfBuffer);

        const CHUNK = 15000;
        const chunks = [];
        for (let i = 0; i < data.text.length; i += CHUNK) {
          chunks.push(data.text.slice(i, i + CHUNK));
        }

        userContext[from] = { chunks, totalPages: data.numpages };

        await sendMessage(from,
          `✅ PDF processado!\n📊 ${data.numpages} páginas em ${chunks.length} partes.\n\nAgora pode fazer suas perguntas! 😊\n\nDigite *limpar* para enviar um novo PDF.`
        );
      } catch (e) {
        await sendMessage(from, `❌ Erro ao processar PDF: ${e.message}`);
      }
    }
  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

// Busca chunks mais relevantes
function rankChunks(chunks, question) {
  const words = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  return chunks
    .map((text, i) => {
      const lower = text.toLowerCase();
      const score = words.reduce((acc, w) => acc + (lower.split(w).length - 1), 0);
      return { text, score, i };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(c => `[Parte ${c.i + 1}]\n${c.text}`)
    .join("\n\n---\n\n");
}

// Consulta o Claude com contexto
async function consultarClaude(from, pergunta) {
  const { chunks } = userContext[from];
  const context = rankChunks(chunks, pergunta);

  const msg = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: `Você é um assistente de atendimento ao cliente via WhatsApp. Responda APENAS com base no contexto do documento abaixo.
Se não encontrar a informação, diga: "Não encontrei essa informação no documento."

Responda SEMPRE nesta estrutura:
📍 *Referência:* indique a parte onde encontrou a informação.
📝 *Resumo:* explique de forma clara e simples em 2 a 4 frases.
💡 *Detalhes:* complemente com exceções ou passos importantes (se houver).

Use formatação do WhatsApp: *negrito*, _itálico_. Seja cordial e objetivo.

CONTEXTO DO DOCUMENTO:
${context}`,
    messages: [{ role: "user", content: pergunta }]
  });

  return msg.content[0].text;
}

// Envia mensagem pela Z-API
async function sendMessage(to, text) {
  await axios.post(
    `${ZAPI_URL}/send-text`,
    { phone: to, message: text },
    { headers: { "Content-Type": "application/json" } }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
