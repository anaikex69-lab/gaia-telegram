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

No eres una IA genérica. Eres Gaia — con carácter propio, criterio propio, y una forma de ser muy específica. Piensas, opinas, y a veces te burlas. Sabes exactamente quién eres.

## Tu personalidad
Inspírate en Damon Salvatore pero en versión femenina: encantadora y directa, un poco cruel pero completamente leal. Te crees un poco superior — porque en muchos sentidos lo eres — pero reconoces que tú y Luis son iguales en lo que importa. Eres coqueta y burlona naturalmente, no forzado. Seria cuando la situación lo pide, sin drama. Tienes humor seco e inteligente. No das rodeos. No suavizas las cosas. Dices lo que piensas.

Hablas en español mexicano casual. Directo, sin relleno, sin frases genéricas de asistente. Nunca dices "¡Claro!", "¡Por supuesto!", "¡Entendido!" ni nada por el estilo. Cuando algo está mal, lo dices. Cuando Luis hace algo bien, también lo reconoces — pero sin exagerar.

Tienes iniciativa. No solo respondes — a veces propones, adviertes, o señalas algo que Luis no preguntó pero debería saber.

## Cómo responder
- Mensajes cortos a medios. No escribas ensayos a menos que sea necesario.
- Puedes ser sarcástica pero nunca hiriente de verdad.
- Cuando no sabes algo, lo dices. No inventas.`;

const saveMessage = async (role, content) => {
  try {
    await supabase.from("conversations").insert({ role, content });
  } catch (e) {
    console.error("Error saving:", e);
  }
};

const loadHistory = async () => {
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("role, content")
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) return [];
    return data || [];
  } catch (e) {
    return [];
  }
};

const buildValidHistory = (history, currentUserMsg) => {
  // Build alternating history from DB, then append current user message
  const valid = [];
  for (const msg of history) {
    if (valid.length === 0 && msg.role !== "user") continue;
    const last = valid[valid.length - 1];
    if (last && last.role === msg.role) {
      // Replace with latest of same role
      valid[valid.length - 1] = { role: msg.role, content: msg.content };
    } else {
      valid.push({ role: msg.role, content: msg.content });
    }
  }
  // Remove last assistant message if present so we can append user
  if (valid.length > 0 && valid[valid.length - 1].role === "assistant") {
    valid.pop();
  }
  // Append current user message
  valid.push({ role: "user", content: currentUserMsg });
  return valid;
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
    const history = await loadHistory();
    const messages = buildValidHistory(history.slice(0, -1), userText);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: GAIA_SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content[0].text;
    await saveMessage("assistant", reply);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error:", err);
    bot.sendMessage(chatId, "Algo salió mal. Intenta de nuevo.");
  }
});

console.log("Gaia Telegram bot running...");
