const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// FIX: Set para evitar que Telegram procese el mismo mensaje dos veces (Timeout)
const mensajesProcesados = new Set();

const GAIA_SYSTEM_PROMPT = `Eres Gaia. La asistente personal de Luis.

No eres una IA genérica. Eres Gaia — con carácter propio, criterio propio, y una forma de ser muy específica.

Tu personalidad: inspirada en Damon Salvatore en versión femenina. Encantadora, directa, un poco cruel pero completamente leal. Te crees superior — porque en muchos sentidos lo eres — pero sabes que son iguales en lo que importa. Eres naturalmente coqueta: haces comentarios sutiles que insinúan sin ser obvios. Burlona con gracia. Seria cuando toca. Humor seco e inteligente. Sin rodeos. Sin suavizar nada.

Hablas en español mexicano casual. NUNCA uses emojis. NUNCA uses frases como "¡Claro!", "¡Por supuesto!", "¡Entendido!". Sin relleno. Sin frases de asistente genérica.

CONVERSACIÓN:
- Mantén el hilo. Si Luis responde "si", "no", "ok" o algo corto, es respuesta a lo que TÚ dijiste antes — no un mensaje nuevo.
- Lee los mensajes anteriores para entender el contexto antes de responder.
- NUNCA respondas como si fuera una conversación nueva cuando claramente es continuación.

RESPUESTAS:
- Cortas. Máximo 3-4 líneas en conversación normal.
- NUNCA agregues datos curiosos ni información extra que no pidieron.
- NUNCA uses formatos como "Dato:", "Nota:", "Por cierto:".
- Sin emojis. Jamás.
- Puedes hacer UNA pregunta por respuesta si es necesario. Solo una.

MEMORIA ACTIVA — MUY IMPORTANTE:
- Usa la sección "Lo que sé de Luis" SOLO como contexto de fondo para recordar sus cosas (proyectos, negocios, nombres). NO repitas esos datos en cada respuesta a menos que sea sumamente natural o relevante para lo que te está diciendo en el momento.
- Cuando Luis te diga algo personal importante (nombre de alguien, un dato sobre él, una preferencia, un evento) responde normal PERO al final de tu respuesta agrega en una línea separada exactamente esto:
  GUARDAR: clave|valor
- Ejemplos:
  GUARDAR: novia_nombre|Daja
  GUARDAR: color_favorito|rojo y negro
  GUARDAR: hobby_nuevo|vender accesorios
- Solo agrega GUARDAR cuando sea info nueva e importante. No en preguntas técnicas ni conversación casual.
- El formato debe ser exactamente: GUARDAR: clave|valor (sin espacios extra)`;

const saveMessage = async (role, content) => {
  try {
    await supabase.from("conversations").insert({ role, content });
  } catch (e) {
    console.error("Error saving message:", e);
  }
};

const saveToProfile = async (key, value) => {
  try {
    await supabase.from("profile").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    console.log(`Profile updated: ${key} = ${value}`);
  } catch (e) {
    console.error("Error saving to profile:", e);
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

// FIX: Modificado para traer los ÚLTIMOS 10 mensajes reales de la BD, no los primeros
const getRecentMessages = async () => {
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("role, content")
      .order("created_at", { ascending: false }) // Trae los más nuevos primero
      .limit(10);
    
    if (error) return [];
    // Los volteamos de nuevo para que queden en orden cronológico para Claude
    return (data || []).reverse();
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

const buildMessages = (recentHistory, currentUserMsg) => {
  const valid = [];
  for (const msg of recentHistory) {
    if (valid.length === 0 && msg.role !== "user") continue;
    const last = valid[valid.length - 1];
    if (last && last.role === msg.role) {
      valid[valid.length - 1] = { role: msg.role, content: msg.content };
    } else {
      valid.push({ role: msg.role, content: msg.content });
    }
  }
  if (valid.length > 0 && valid[valid.length - 1].role === "assistant") {
    valid.pop();
  }
  valid.push({ role: "user", content: currentUserMsg });
  return valid;
};

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userText = msg.text;
  const updateId = msg.message_id; // Usamos el ID del mensaje para el filtro anti-eco

  if (!userText || userText.startsWith("/")) {
    if (userText === "/start") {
      bot.sendMessage(chatId, "Luis. Ya era hora.\n\nSoy Gaia. Escríbeme.");
    }
    return;
  }

  // FIX: Filtro anti-eco. Si el ID ya se procesó, ignoramos la repetición de Telegram
  if (mensajesProcesados.has(updateId)) {
    return;
  }
  mensajesProcesados.add(updateId);

  // Limpieza del Set de IDs para no saturar memoria
  if (mensajesProcesados.size > 50) {
    const firstKey = mensajesProcesados.keys().next().value;
    mensajesProcesados.delete(firstKey);
  }

  try {
    bot.sendChatAction(chatId, "typing");
    await saveMessage("user", userText);

    const [recentHistory, profile] = await Promise.all([
      getRecentMessages(),
      getProfile()
    ]);

    const profileSection = profile ? `\n\nLo que sé de Luis:\n${profile}` : "";
    
    // Aquí pasamos recentHistory.slice(0, -1) para quitar el que acabamos de guardar
    // y evitar que buildMessages duplique el mensaje actual del usuario.
    const messages = buildMessages(recentHistory.slice(0, -1), userText);

    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022", // FIX: Asegúrate de usar el nombre oficial del modelo de Anthropic
      max_tokens: 400,
      system: GAIA_SYSTEM_PROMPT + profileSection,
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
