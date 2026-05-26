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

MEMORIA ACTIVA:
- Si Luis te dice algo nuevo e importante sobre él guárdalo al final de tu respuesta:
  GUARDAR: clave|valor
- Solo cuando sea info NUEVA que no está ya en su perfil.
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
    // Fetch last 16 descending, then reverse to get chronological order
    const { data, error } = await supabase
      .from("conversations")
      .select("id, role, content")
      .order("created_at", { ascending: false })
      .limit(16);
    if (error || !data) return [];
    // Reverse so oldest is first (chronological)
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
  // Build a clean alternating user/assistant array
  // History is already in chronological order
  const result = [];
  for (const msg of history) {
    if (result.length === 0 && msg.role !== "user") continue;
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      // Same role consecutive — merge into previous
      last.content += "\n" + msg.content;
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  // Must end with user message (last item is current user msg)
  if (result.length > 0 && result[result.length - 1].role === "assistant") {
    result.pop();
  }
  return result;
};

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userText = msg.text;

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

    const profileSection = profile
      ? `\n\nPerfil de Luis (contexto de fondo, no mencionar innecesariamente):\n${profile}`
      : "";

    const messages = buildMessages(recentHistory);

    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      messages.push({ role: "user", content: userText });
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
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
