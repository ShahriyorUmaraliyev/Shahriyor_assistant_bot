# Shahriyor Assistant Bot

Google Cloud Run platformasida ishlovchi, Gemini AI va Redis xotira tizimi asosida tuzilgan shaxsiy Telegram yordamchi boti.

## Yangi Imkoniyatlar va Refaktorlar:
- **Long-lived User Client**: TelegramClient (GramJS) ulanishi har bir xabar uchun qayta yaratilmasdan, xotirada uzoq yashovchi keshlangan singleton sifatida optimallashtirildi.
- **Markdown validation**: Markdown formatidagi xabarlarni yuborishda parse xatolarining oldini olish uchun Markdown tokenlari balansini tekshiruvchi va tuzatuvchi `balanceMarkdown` funksiyasi qo'shildi.
- **Xavfsizlikni kuchaytirish**: Webhook va API eslatmalarni yuborish marshrutlari maxfiy kalit va ruxsat berilgan foydalanuvchilar tekshiruvi orqali himoyalandi.
