/**
 * Bu fayl endi ishlatilmaydi.
 * Eslatmalar tizimi Upstash QStash orqali boshqariladi → /api/remind
 * @deprecated
 */
export default function handler() {
  return new Response("Deprecated. See /api/remind", { status: 410 });
}
