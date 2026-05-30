const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TAVILY_KEY = process.env.TAVILY_KEY;

// ── CAMBIO 1: Tu chatId, solo tú puedes hablar con Gaia ──
const LUIS_CHAT_ID = 7710709320;

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

const extractAndSaveMemory = async (text, category = "personal") => {
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    if (line.trim().startsWith("GUARDAR:")) {
      const parts = line.replace("GUARDAR:", "").trim().split("|");
      if (parts.length === 2) {
        await saveToProfileCategories(parts[0].trim(), parts[1].trim(), category);
      }
    } else {
      cleaned.push(line);
    }
  }
  return cleaned.join("\n").trim();
};

// ── CAMBIO 4: Historial dinámico según tipo de mensaje ──
const getHistoryLimit = (text) => {
  const needsContext = /recuerdas|como te dije|antes me dijiste|te mencioné|te conté|acuérdate|acuerdate/.test(text.toLowerCase());
  const isShortReply = text.length < 10;
  if (needsContext) return 20;
  if (isShortReply) return 8;
  return 12;
};

const getRecentMessages = async (limit = 12) => {
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, role, content")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data.reverse();
  } catch (e) {
    return [];
  }
};

// ── MEMORIA POR CATEGORÍAS: detecta qué categoría necesita el mensaje ──
const detectCategory = (text) => {
  const t = text.toLowerCase();
  if (/deuda|dinero|pago|ingreso|peso|plata|kueski|klar|banco|mercado pago|mexdin|nelo|prestamo|préstamo|interés|finanza/.test(t)) return "finanzas";
  if (/tarea|examen|clase|materia|físic|cálculo|límite|ingles|inglés|semiconductor|escuela|estudio|carrera|posgrado|maestría|calculo|cinvestav|iso|estadística|miller|cristal/.test(t)) return "escuela";
  if (/trabajo|restaurante|cocinero|excel|accesorio|venta/.test(t)) return "trabajo";
  if (/pendiente|recordar|recuerda|viaje|mazamitla/.test(t)) return "pendientes";
  return "personal";
};

const getProfile = async (category) => {
  try {
    const categories = category && category !== "personal" ? ["personal", category] : ["personal"];
    const { data, error } = await supabase
      .from("profile_categories")
      .select("key, value")
      .in("category", categories);
    if (error || !data || data.length === 0) return "";
    return data.map(row => `- ${row.key}: ${row.value}`).join("\n");
  } catch (e) {
    return "";
  }
};

const saveToProfileCategories = async (key, value, category = "personal") => {
  try {
    await supabase.from("profile_categories").upsert(
      { category, key, value, updated_at: new Date().toISOString() },
      { onConflict: "category,key" }
    );
  } catch (e) {
    console.error("Error saving profile_categories:", e);
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

  // ── CAMBIO 1: Bloquea cualquier usuario que no sea Luis ──
  if (chatId !== LUIS_CHAT_ID) return;

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

    // ── CAMBIO 4: Historial dinámico ──
    const historyLimit = getHistoryLimit(userText);
    const category = detectCategory(userText);
    // ── PERFIL BAJO DEMANDA: solo carga si Luis lo pide explícitamente ──
    const needsProfile = /recuerda|acuérdate|acuerdate|sabes que|te dije|te conté|te conte|mi perfil|mis datos|qué sabes de mí|que sabes de mi|deuda|cuánto debo|cuanto debo|pendiente|tarea pendiente/.test(userText.toLowerCase());
    const [recentHistory, profile] = await Promise.all([
      getRecentMessages(historyLimit),
      needsProfile ? getProfile(category) : Promise.resolve("")
    ]);

    // ── CAMBIO 3: Fecha solo si el mensaje la necesita ──
    const needsDate = /hoy|mañana|fecha|hora|cuándo|cuando|día|dia|semana|tarde|noche|mañana/.test(userText.toLowerCase());
    let fechaSection = "";
    if (needsDate) {
      const now = new Date();
      const fechaActual = now.toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
      fechaSection = `\n\nFecha y hora actual: ${fechaActual} (hora de Guadalajara)`;
    }

    const profileSection = profile
      ? `\n\nPerfil de Luis (contexto de fondo, no mencionar innecesariamente):\n${profile}`
      : "";

    const explicitSearch = ["busca ", "búscame ", "buscar ", "búscalo", "búscala", "investiga ", "googlea "];
    const needsSearch = TAVILY_KEY && explicitSearch.some(kw => userText.toLowerCase().includes(kw));
    let searchResults = "";
    if (needsSearch) {
      await bot.sendMessage(chatId, "Buscando en la web...");
      searchResults = await searchWeb(userText);
    }

    const messages = buildMessages(recentHistory);

    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      messages.push({ role: "user", content: userText });
    }

    // ── CAMBIO 4: Tokens dinámicos según longitud del mensaje ──
    const isShort = userText.length < 80 && !/explica|describe|escribe|redacta|lista|resume|analiza|ayúdame|ayudame/.test(userText.toLowerCase());
    const maxTokens = isShort ? 150 : 400;

    // ── CACHÉ: personalidad fija cacheada, perfil/fecha dinámicos sin caché ──
    const systemBlocks = [
      {
        type: "text",
        text: GAIA_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }
      }
    ];
    const dynamicSection = profileSection + fechaSection + (searchResults ? "\n\nResultados de búsqueda:\n" + searchResults : "");
    if (dynamicSection.trim()) {
      systemBlocks.push({ type: "text", text: dynamicSection });
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system: systemBlocks,
      messages,
    });

    let reply = response.content[0].text;
    reply = await extractAndSaveMemory(reply, category);

    // ── LOG DE COSTO ──
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costo = ((inputTokens * 0.000003) + (outputTokens * 0.000015)).toFixed(5);
    console.log(`[GAIA] Tokens: ${inputTokens} entrada / ${outputTokens} salida | Costo: $${costo} | Categoría: ${category}`);

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

  // ── CAMBIO 1: Bloquea cualquier usuario que no sea Luis ──
  if (chatId !== LUIS_CHAT_ID) return;

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

    // ── CAMBIO 4: Historial dinámico ──
    const historyLimit = getHistoryLimit(caption);
    const category = detectCategory(caption);
    // ── PERFIL BAJO DEMANDA ──
    const needsProfile = /recuerda|acuérdate|acuerdate|sabes que|te dije|te conté|te conte|mi perfil|mis datos/.test(caption.toLowerCase());
    const [recentHistory, profile] = await Promise.all([
      getRecentMessages(historyLimit),
      needsProfile ? getProfile(category) : Promise.resolve("")
    ]);

    // ── CAMBIO 3: Fecha solo si el caption la necesita ──
    const needsDate = /hoy|mañana|fecha|hora|cuándo|cuando|día|dia|semana|tarde|noche/.test(caption.toLowerCase());
    let fechaSection = "";
    if (needsDate) {
      const now = new Date();
      const fechaActual = now.toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
      fechaSection = `\n\nFecha y hora actual: ${fechaActual} (hora de Guadalajara)`;
    }

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

    // ── CACHÉ: personalidad fija cacheada, perfil/fecha dinámicos sin caché ──
    const systemBlocks = [
      {
        type: "text",
        text: GAIA_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }
      }
    ];
    const dynamicSection = profileSection + fechaSection;
    if (dynamicSection.trim()) {
      systemBlocks.push({ type: "text", text: dynamicSection });
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: systemBlocks,
      messages,
    });

    let reply = response.content[0].text;
    reply = await extractAndSaveMemory(reply, category);

    await saveMessage("assistant", reply);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Photo error:", err);
    bot.sendMessage(chatId, "No pude procesar la foto. Intenta de nuevo.");
  }
});
// ── END PHOTO SUPPORT ──────────────────────────────────────────
