import type { UserMemory } from "./types";
import { EMPTY_MEMORY } from "./types";
import { getRedis } from "./redis";

const memoryKey = (userId: number) => `memory:${userId}`;

export async function getMemory(userId: number): Promise<UserMemory> {
  return (
    (await getRedis().get<UserMemory>(memoryKey(userId))) ?? {
      ...EMPTY_MEMORY,
      contacts: {},
      products: {},
      notes: [],
    }
  );
}

export async function saveMemory(
  userId: number,
  memory: UserMemory
): Promise<void> {
  await getRedis().set(memoryKey(userId), memory);
}

export async function patchMemory(
  userId: number,
  patch: {
    contacts?: Record<string, { phone?: string; notes?: string }>;
    products?: Record<string, { price?: number; description?: string }>;
    note?: string;
  }
): Promise<void> {
  const memory = await getMemory(userId);

  if (patch.contacts) {
    for (const [name, data] of Object.entries(patch.contacts)) {
      memory.contacts[name] = { ...memory.contacts[name], ...data };
    }
  }
  if (patch.products) {
    for (const [name, data] of Object.entries(patch.products)) {
      memory.products[name] = { ...memory.products[name], ...data };
    }
  }
  if (patch.note) {
    memory.notes.push(patch.note);
    if (memory.notes.length > 50) memory.notes.shift(); // keep max 50 notes
  }

  await saveMemory(userId, memory);
}
