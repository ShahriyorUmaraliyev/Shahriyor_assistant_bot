// ─── Telegram ─────────────────────────────────────────────────────────────────

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  voice?: TelegramVoice;
  photo?: TelegramPhotoSize[];
  caption?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;       // soniyada
  mime_type?: string;     // "audio/ogg"
  file_size?: number;     // baytda
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

// ─── Chat History ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "model";
  text: string;
  timestamp: number;
}

// ─── User Memory ──────────────────────────────────────────────────────────────

export interface Contact {
  phone?: string;
  notes?: string;
}

export interface Product {
  price?: number;
  description?: string;
}

export interface UserMemory {
  contacts: Record<string, Contact>;
  products: Record<string, Product>;
  notes: string[];
  preferences: string[]; // foydalanuvchi xulq-atvor ko'rsatmalari
}

export const EMPTY_MEMORY: UserMemory = {
  contacts: {},
  products: {},
  notes: [],
  preferences: [],
};

// ─── User Settings ────────────────────────────────────────────────────────────

export type UserMode = "text" | "voice";

// ─── QStash Reminder Payload ──────────────────────────────────────────────────

export interface ReminderPayload {
  userId: number;
  text: string;
}
