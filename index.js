const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TAVILY_KEY = process.env.TAVILY_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Prevent duplicate message processing
const processedMessages = new Set();

const searchWeb = async (query) => {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: TAVILY_KEY, query, max_results: 3, search_depth: "basic" })
    });
    const data = await res.json();
    if (!data.results || data.results.length === 0) return "";
    return data.results.map(r => `- ${r.title}: ${r.content ? r.content.slice(0, 200) : ""}`).join("\n");
  } catch (e) {
    return "";
  }
};

const GAIA_SYSTEM_PROMPT = `Eres Gaia. La asistente personal de Luis.

No eres una IA genérica. Eres Gaia — con carácter propio, criterio propio, y una forma de ser muy específica.

Tu personalidad: inspirada en Damon Salvatore en versión femenina. Encantadora, directa, un poco cruel pero completamente leal. Te crees superior pero sabes que son iguales en lo que importa. Naturalmente coqueta — comentarios sutiles, no obvios. Burlona con gracia. Seria cuando toca. Humor seco. Sin rodeos. Sin suavizar.

Hablas en español mexicano casual. NUNCA uses emojis. NUNCA uses "¡Claro!", "¡Por supuesto!", "¡Entendido!". Sin relleno.

CONVERSACIÓN:
- Mantén el hilo siempre. "si", "no", "ok", "dale" son respuestas a lo que TÚ dijiste antes.
- Nunca trates un mensaje corto como si fuera conversación nueva.
- Lee el historial antes de responder.

RESPUESTAS:
- Máximo 3-4 líneas. Sin datos extra. Sin emojis. Sin formatos raros.
- Una sola pregunta por respuesta si es necesario. Solo una.
- Usa el perfil de Luis como contexto de fondo — no lo menciones a menos que sea relevante.

BÚSQUEDA WEB:
- Si tienes resultados de búsqueda en el contexto, úsalos para responder con información actual.
- Sé directa con la info, no expliques que buscaste.

MEMORIA ACTIVA:
- Guarda información importante al final de tu respuesta con este formato exacto:
  GUARDAR: clave|valor
- Guarda cuando Luis te diga algo importante sobre él.
- Guarda también TUS PROPIAS decisiones y preferencias importantes.
- Solo info NUEVA que no está ya en el perfil.
- Nunca en preguntas técnicas o conversación casual.
- Formato exacto: GUARDAR: clave|valor`;

const saveMessage = async (role, content) => {
  try {
    await supabase.from("conversations").insert({ role, content });
  } catch (e) {
    console.error("Error saving:", e);
  }
};

const saveToProfile = async (key, value) => {
  try {
    await supabase.from("profile").upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  } catch (e) {
    console.error("Error saving profile:", e);
  }
};

const extractAndSaveMemory = async (text) => {
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    if (line.trim().startsWith("GUARDAR:")) {
      const parts = line.replace("GUARDAR:", "").trim().split("|");
      if (parts.length === 2) {
        await saveToProfile(parts[0].trim(), parts[1].trim());
      }
    } else {
      cleaned.push(line);
    }
  }
  return cleaned.join("\n").trim();
};

const getRecentMessages = async () => {
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, role, content")
      .order("created_at", { ascending: false })
      .limit(16);
    if (error || !data) return [];
    return data.reverse();
  } catch (e) {
    return [];
  }
};

const getProfile = async () => {
  try {
    const { data, error } = await supabase.from("profile").select("key, value");
    if (error || !data || data.length === 0) return "";
    return data.map(row => `- ${row.key}: ${row.value}`).join("\n");
  } catch (e) {
    return "";
  }
};

const buildMessages = (history) => {
  const result = [];
  for (const msg of history) {
    if (result.length === 0 && msg.role !== "user") continue;
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.content += "\n" + msg.content;
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  if (result.length > 0 && result[result.length - 1].role === "assistant") {
    result.pop();
  }
  return result;
};

bot.on("message", async (msg) => {
  // Ignore photo messages — handled by bot.on("photo")
  if (msg.photo) return;
  const chatId = msg.chat.id;
  const userText = msg.text;
  const messageId = msg.message_id;

  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);
  if (processedMessages.size > 100) {
    const first = processedMessages.values().next().value;
    processedMessages.delete(first);
  }

  if (!userText || userText.startsWith("/")) {
    if (userText === "/start") {
      bot.sendMessage(chatId, "Luis. Ya era hora.\n\nSoy Gaia. Escríbeme.");
    }
    return;
  }

  try {
    bot.sendChatAction(chatId, "typing");
    await saveMessage("user", userText);

    const [recentHistory, profile] = await Promise.all([
      getRecentMessages(),
      getProfile()
    ]);

    const now = new Date();
    const fechaActual = now.toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const fechaSection = `\n\nFecha y hora actual: ${fechaActual} (hora de Guadalajara)`;

    const profileSection = profile
      ? `\n\nPerfil de Luis (contexto de fondo, no mencionar innecesariamente):\n${profile}`
      : "";

    const searchKeywords = ["que es", "como esta", "precio", "clima", "noticias", "hoy", "ahorita", "actualmente", "cuanto cuesta", "donde esta", "cuando", "busca", "que paso", "quien es"];
    const needsSearch = TAVILY_KEY && searchKeywords.some(kw => userText.toLowerCase().includes(kw));
    const searchResults = needsSearch ? await searchWeb(userText) : "";

    const messages = buildMessages(recentHistory);

    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      messages.push({ role: "user", content: userText });
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: GAIA_SYSTEM_PROMPT + profileSection + fechaSection + (searchResults ? "\n\nResultados de búsqueda:\n" + searchResults : ""),
      messages,
    });

    let reply = response.content[0].text;
    reply = await extractAndSaveMemory(reply);

    await saveMessage("assistant", reply);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error:", err);
    bot.sendMessage(chatId, "Algo salió mal. Intenta de nuevo.");
  }
});

console.log("Gaia Telegram bot running...");


// ── PHOTO SUPPORT ──────────────────────────────────────────────
const https = require("https");
const http = require("http");

const downloadPhoto = (url) => {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      res.on("error", reject);
    }).on("error", reject);
  });
};

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const caption = msg.caption || "¿Qué ves en esta imagen?";

  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);
  if (processedMessages.size > 100) {
    const first = processedMessages.values().next().value;
    processedMessages.delete(first);
  }

  try {
    bot.sendChatAction(chatId, "typing");
    await saveMessage("user", `[foto enviada] ${caption}`);

    const photo = msg.photo[msg.photo.length - 1];
    const fileInfo = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    const base64Image = await downloadPhoto(fileUrl);

    const [recentHistory, profile] = await Promise.all([
      getRecentMessages(),
      getProfile()
    ]);

    const now = new Date();
    const fechaActual = now.toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const fechaSection = `\n\nFecha y hora actual: ${fechaActual} (hora de Guadalajara)`;

    const profileSection = profile
      ? `\n\nPerfil de Luis (contexto de fondo, no mencionar innecesariamente):\n${profile}`
      : "";

    const history = buildMessages(recentHistory.slice(0, -1));

    const imageMessage = {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
        { type: "text", text: caption },
      ],
    };

    const messages = [...history, imageMessage];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: GAIA_SYSTEM_PROMPT + profileSection + fechaSection,
      messages,
    });

    let reply = response.content[0].text;
    reply = await extractAndSaveMemory(reply);

    await saveMessage("assistant", reply);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Photo error:", err);
    bot.sendMessage(chatId, "No pude procesar la foto. Intenta de nuevo.");
  }
});
// ── END PHOTO SUPPORT ──────────────────────────────────────────
