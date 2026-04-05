const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const pdf = require("pdf-parse");

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "meu_token_secreto";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;

// Armazena contexto do PDF por número de telefone
const userContext = {};

// Webhook de verificação do Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recebe mensagens do WhatsApp
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    if (!messages?.length) return;

    const msg = messages[0];
    const from = msg.from;
    const type = msg.type;

    if (type === "text") {
      const text = msg.text.body;

      // Comando para limpar contexto
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

    } else if (type === "document") {
      const docId = msg.document.id;
      const mime = msg.document.mime_type;

      if (mime !== "application/pdf") {
        await sendMessage(from, "⚠️ Por favor, envie apenas arquivos PDF.");
        return;
      }

      await sendMessage(from, "📄 PDF recebido! Processando... aguarde um momento.");

      try {
        // Baixa o PDF do WhatsApp
        const mediaUrl = await getMediaUrl(docId);
        const pdfBuffer = await downloadMedia(mediaUrl);

        // Extrai texto do PDF
        const data = await pdf(pdfBuffer);
        const totalChars = data.text.length;
        const CHUNK = 15000;
        const chunks = [];

        for (let i = 0; i < data.text.length; i += CHUNK) {
          chunks.push(data.text.slice(i, i + CHUNK));
        }

        userContext[from] = { chunks, totalPages: data.numpages };

        await sendMessage(from,
          `✅ PDF processado com sucesso!\n📊 ${data.numpages} páginas divididas em ${chunks.length} partes.\n\nAgora pode fazer suas perguntas! 😊\n\nDigite *limpar* para enviar um novo PDF.`
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

// Envia mensagem pelo WhatsApp
async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

// Obtém URL do arquivo de mídia
async function getMediaUrl(mediaId) {
  const res = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
  return res.data.url;
}

// Baixa o arquivo de mídia
async function downloadMedia(url) {
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer"
  });
  return Buffer.from(res.data);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
