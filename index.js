const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TAVILY_KEY = process.env.TAVILY_KEY;
const LUIS_CHAT_ID = 7710709320;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const processedMessages = new Set();

const stats = {
  totalMensajes: 0, totalTokensEntrada: 0, totalTokensSalida: 0,
  costoTotal: 0, inicio: new Date(), porHora: []
};

const registrarUso = (inputTokens, outputTokens, costo) => {
  stats.totalMensajes++;
  stats.totalTokensEntrada += inputTokens;
  stats.totalTokensSalida += outputTokens;
  stats.costoTotal += parseFloat(costo);
  stats.porHora.push({ ts: Date.now(), tokens: inputTokens + outputTokens, costo: parseFloat(costo) });
  stats.porHora = stats.porHora.filter(e => e.ts > Date.now() - 3600000);
};

const getStats = () => {
  const horaTokens = stats.porHora.reduce((a, e) => a + e.tokens, 0);
  const horaCosto = stats.porHora.reduce((a, e) => a + e.costo, 0).toFixed(5);
  const diasActivo = ((Date.now() - stats.inicio) / 86400000).toFixed(1);
  return `Stats (hace ${diasActivo} días):\n- Mensajes: ${stats.totalMensajes}\n- Tokens entrada: ${stats.totalTokensEntrada.toLocaleString()}\n- Tokens salida: ${stats.totalTokensSalida.toLocaleString()}\n- Costo total: $${stats.costoTotal.toFixed(5)} USD\n\nÚltima hora:\n- Mensajes: ${stats.porHora.length}\n- Tokens: ${horaTokens.toLocaleString()}\n- Costo: $${horaCosto} USD`;
};

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
  } catch (e) { return ""; }
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

DOCUMENTOS:
- Cuando recibas contenido de un archivo, analízalo y responde lo que Luis necesite.
- Si es tarea o examen, ayuda directamente. Si son datos, interprétalos.

MEMORIA ACTIVA:
- Guarda información importante al final de tu respuesta:
  GUARDAR: clave|valor
- Solo info NUEVA. Nunca en preguntas técnicas o conversación casual.
- Formato exacto: GUARDAR: clave|valor`;

const saveMessage = async (role, content) => {
  try { await supabase.from("conversations").insert({ role, content }); }
  catch (e) { console.error("Error saving:", e); }
};

const saveToProfileCategories = async (key, value, category = "personal") => {
  try {
    await supabase.from("profile_categories").upsert(
      { category, key, value, updated_at: new Date().toISOString() },
      { onConflict: "category,key" }
    );
  } catch (e) { console.error("Error saving profile:", e); }
};

const extractAndSaveMemory = async (text, category = "personal") => {
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    if (line.trim().startsWith("GUARDAR:")) {
      const parts = line.replace("GUARDAR:", "").trim().split("|");
      if (parts.length === 2) await saveToProfileCategories(parts[0].trim(), parts[1].trim(), category);
    } else { cleaned.push(line); }
  }
  return cleaned.join("\n").trim();
};

const getHistoryLimit = (text) => {
  if (/recuerdas|como te dije|antes me dijiste|te mencioné|te conté|acuérdate/.test(text.toLowerCase())) return 20;
  if (text.length < 10) return 8;
  return 12;
};

const getRecentMessages = async (limit = 12) => {
  try {
    const { data, error } = await supabase
      .from("conversations").select("id, role, content")
      .order("created_at", { ascending: false }).limit(limit);
    if (error || !data) return [];
    return data.reverse();
  } catch (e) { return []; }
};

const detectCategory = (text) => {
  const t = text.toLowerCase();
  if (/deuda|dinero|pago|ingreso|kueski|klar|banco|mercado pago|mexdin|nelo|prestamo|préstamo|finanza/.test(t)) return "finanzas";
  if (/tarea|examen|clase|materia|físic|cálculo|ingles|semiconductor|escuela|estudio|carrera|calculo|estadística|miller|cristal/.test(t)) return "escuela";
  if (/trabajo|restaurante|cocinero|accesorio|venta/.test(t)) return "trabajo";
  if (/pendiente|recordar|recuerda|viaje|mazamitla/.test(t)) return "pendientes";
  return "personal";
};

const getProfile = async (category) => {
  try {
    const categories = category && category !== "personal" ? ["personal", category] : ["personal"];
    const { data, error } = await supabase.from("profile_categories").select("key, value").in("category", categories);
    if (error || !data || data.length === 0) return "";
    return data.map(row => `- ${row.key}: ${row.value}`).join("\n");
  } catch (e) { return ""; }
};

const buildMessages = (history) => {
  const result = [];
  for (const msg of history) {
    if (result.length === 0 && msg.role !== "user") continue;
    const last = result[result.length - 1];
    if (last && last.role === msg.role) { last.content += "\n" + msg.content; }
    else { result.push({ role: msg.role, content: msg.content }); }
  }
  if (result.length > 0 && result[result.length - 1].role === "assistant") result.pop();
  return result;
};

const https = require("https");
const http = require("http");

const downloadFile = (url) => {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
};

const extractTextFromBuffer = async (buffer, mimeType, fileName) => {
  const ext = fileName.split(".").pop().toLowerCase();
  if (["txt", "csv", "js", "py", "json", "md", "html", "css", "ts"].includes(ext)) {
    return buffer.toString("utf-8").slice(0, 8000);
  }
  if (ext === "pdf" || mimeType === "application/pdf") {
    try {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buffer);
      return data.text.slice(0, 6000);
    } catch (e) { return "No se pudo leer el PDF."; }
  }
  if (["xlsx", "xls"].includes(ext)) {
    try {
      const XLSX = require("xlsx");
      const workbook = XLSX.read(buffer, { type: "buffer" });
      let result = "";
      workbook.SheetNames.forEach(name => {
        result += `[Hoja: ${name}]\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}\n\n`;
      });
      return result.slice(0, 8000);
    } catch (e) { return "No se pudo leer el Excel."; }
  }
  if (["docx", "doc"].includes(ext)) {
    try {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result.value.slice(0, 8000);
    } catch (e) { return "No se pudo leer el Word."; }
  }
  return `Archivo: ${fileName}. Tipo no soportado. Manda foto si es documento visual.`;
};

const callClaude = async (systemBlocks, messages, maxTokens = 300) => {
  return await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: systemBlocks,
    messages,
  });
};

// ── HANDLER DE TEXTO ──
bot.on("message", async (msg) => {
  if (msg.photo || msg.document) return;
  const chatId = msg.chat.id;
  const userText = msg.text;
  const messageId = msg.message_id;
  if (chatId !== LUIS_CHAT_ID) return;
  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);
  if (processedMessages.size > 100) processedMessages.delete(processedMessages.values().next().value);

  if (!userText || userText.startsWith("/")) {
    if (userText === "/start") bot.sendMessage(chatId, "Luis. Ya era hora.\n\nSoy Gaia. Escríbeme.");
    if (userText === "/stats") bot.sendMessage(chatId, getStats());
    if (userText === "/reset") {
      await supabase.from("conversations").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      bot.sendMessage(chatId, "Historial borrado. El perfil sigue intacto.");
    }
    return;
  }

  try {
    bot.sendChatAction(chatId, "typing");
    await saveMessage("user", userText);

    const historyLimit = getHistoryLimit(userText);
    const category = detectCategory(userText);
    const needsProfile = /recuerda|acuérdate|sabes que|te dije|te conté|mis datos|qué sabes|deuda|cuánto debo|pendiente/.test(userText.toLowerCase());
    const [recentHistory, profile] = await Promise.all([
      getRecentMessages(historyLimit),
      needsProfile ? getProfile(category) : Promise.resolve("")
    ]);

    const needsDate = /hoy|mañana|fecha|hora|cuándo|cuando|día|dia|semana|tarde|noche/.test(userText.toLowerCase());
    let fechaSection = "";
    if (needsDate) {
      const now = new Date();
      fechaSection = `\n\nFecha y hora actual: ${now.toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })} (hora de Guadalajara)`;
    }

    const profileSection = profile ? `\n\nPerfil de Luis:\n${profile}` : "";
    const needsSearch = TAVILY_KEY && ["busca ", "búscame ", "buscar ", "búscalo", "búscala", "investiga ", "googlea "].some(kw => userText.toLowerCase().includes(kw));
    let searchResults = "";
    if (needsSearch) {
      await bot.sendMessage(chatId, "Buscando en la web...");
      searchResults = await searchWeb(userText);
    }

    const messages = buildMessages(recentHistory);
    if (messages.length === 0 || messages[messages.length - 1].role !== "user") messages.push({ role: "user", content: userText });

    const isShort = userText.length < 80 && !/explica|describe|escribe|redacta|lista|resume|analiza|ayúdame|ayudame/.test(userText.toLowerCase());
    const maxTokens = isShort ? 300 : 400;

    const systemBlocks = [{ type: "text", text: GAIA_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
    const dynamicSection = profileSection + fechaSection + (searchResults ? "\n\nResultados de búsqueda:\n" + searchResults : "");
    if (dynamicSection.trim()) systemBlocks.push({ type: "text", text: dynamicSection });

    const response = await callClaude(systemBlocks, messages, maxTokens);
    let reply = response.content[0].text;
    reply = await extractAndSaveMemory(reply, category);

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costo = ((inputTokens * 0.000003) + (outputTokens * 0.000015)).toFixed(5);
    console.log(`[GAIA] ${inputTokens}in/${outputTokens}out | $${costo} | ${category}`);
    registrarUso(inputTokens, outputTokens, costo);

    await saveMessage("assistant", reply);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error:", err);
    bot.sendMessage(chatId, "Algo salió mal. Intenta de nuevo.");
  }
});

// ── HANDLER DE DOCUMENTOS ──
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  if (chatId !== LUIS_CHAT_ID) return;
  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);
  if (processedMessages.size > 100) processedMessages.delete(processedMessages.values().next().value);

  const doc = msg.document;
  const caption = msg.caption || "Analiza este archivo y dime qué contiene.";
  const fileName = doc.file_name || "archivo";

  if (doc.file_size > 20 * 1024 * 1024) {
    bot.sendMessage(chatId, "Archivo muy grande. Máximo 20MB.");
    return;
  }

  try {
    bot.sendChatAction(chatId, "typing");
    await bot.sendMessage(chatId, `Leyendo ${fileName}...`);

    const fileInfo = await bot.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    const buffer = await downloadFile(fileUrl);
    const extractedText = await extractTextFromBuffer(buffer, doc.mime_type || "", fileName);

    await saveMessage("user", `[archivo: ${fileName}] ${caption}`);

    const category = detectCategory(caption + " " + fileName);
    const [recentHistory, profile] = await Promise.all([
      getRecentMessages(12),
      getProfile(category)
    ]);

    const profileSection = profile ? `\n\nPerfil de Luis:\n${profile}` : "";
    const history = buildMessages(recentHistory.slice(0, -1));
    const docMessage = { role: "user", content: `${caption}\n\n[Contenido de ${fileName}]:\n${extractedText}` };
    const messages = [...history, docMessage];

    const systemBlocks = [{ type: "text", text: GAIA_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
    if (profileSection.trim()) systemBlocks.push({ type: "text", text: profileSection });

    const response = await callClaude(systemBlocks, messages, 600);
    let reply = response.content[0].text;
    reply = await extractAndSaveMemory(reply, category);

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costo = ((inputTokens * 0.000003) + (outputTokens * 0.000015)).toFixed(5);
    console.log(`[GAIA-DOC] ${fileName} | ${inputTokens}in/${outputTokens}out | $${costo}`);
    registrarUso(inputTokens, outputTokens, costo);

    await saveMessage("assistant", reply);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Document error:", err);
    bot.sendMessage(chatId, "No pude leer el archivo. Intenta de nuevo.");
  }
});

// ── HANDLER DE FOTOS ──
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const caption = msg.caption || "¿Qué ves en esta imagen?";
  if (chatId !== LUIS_CHAT_ID) return;
  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);
  if (processedMessages.size > 100) processedMessages.delete(processedMessages.values().next().value);

  try {
    bot.sendChatAction(chatId, "typing");
    await saveMessage("user", `[foto] ${caption}`);

    const photo = msg.photo[msg.photo.length - 1];
    const fileInfo = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    const buffer = await downloadFile(fileUrl);
    const base64Image = buffer.toString("base64");

    const historyLimit = getHistoryLimit(caption);
    const category = detectCategory(caption);
    const needsProfile = /recuerda|sabes que|te dije|mis datos/.test(caption.toLowerCase());
    const [recentHistory, profile] = await Promise.all([
      getRecentMessages(historyLimit),
      needsProfile ? getProfile(category) : Promise.resolve("")
    ]);

    const needsDate = /hoy|mañana|fecha|hora|cuándo|cuando|día|dia/.test(caption.toLowerCase());
    let fechaSection = "";
    if (needsDate) {
      const now = new Date();
      fechaSection = `\n\nFecha y hora actual: ${now.toLocaleString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })} (hora de Guadalajara)`;
    }

    const profileSection = profile ? `\n\nPerfil de Luis:\n${profile}` : "";
    const history = buildMessages(recentHistory.slice(0, -1));
    const imageMessage = {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
        { type: "text", text: caption }
      ]
    };
    const messages = [...history, imageMessage];

    const systemBlocks = [{ type: "text", text: GAIA_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
    const dynamicSection = profileSection + fechaSection;
    if (dynamicSection.trim()) systemBlocks.push({ type: "text", text: dynamicSection });

    const response = await callClaude(systemBlocks, messages, 400);
    let reply = response.content[0].text;
    reply = await extractAndSaveMemory(reply, category);

    await saveMessage("assistant", reply);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Photo error:", err);
    bot.sendMessage(chatId, "No pude procesar la foto. Intenta de nuevo.");
  }
});

console.log("Gaia Telegram bot running...");
