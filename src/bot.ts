import { Telegraf } from 'telegraf';
import { config } from 'dotenv';
import { Scheduler } from './scheduler';
import { addUser, updateUserResponse } from './db';

// Загружаем переменные окружения
config();

// Создаем экземпляр бота
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');

// Создаем планировщик
const scheduler = new Scheduler(bot);

// Обработка команды /start
bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.from?.username || 'unknown';
  
  // Добавляем пользователя в базу
  addUser(chatId, username);
  
  // Добавляем пользователя в планировщик
  scheduler.addUser(chatId);
  
  await ctx.reply(
    'Привет! Я буду отправлять тебе ежедневные сообщения с картинками в 19:30. ' +
    'Если ты не ответишь, я напомню тебе через 1.5 часа!'
  );
});

// Обработка текстовых сообщений
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const responseTime = new Date().toISOString();
  
  // Обновляем время ответа пользователя
  updateUserResponse(chatId, responseTime);
  
  // Очищаем напоминание
  scheduler.clearReminder(chatId);
  
  await ctx.reply('Спасибо за ответ! 😊');
});

// Запускаем бота
bot.launch().then(() => {
  console.log('Бот запущен!');
  // Запускаем планировщик
  scheduler.startDailySchedule();
}).catch((err) => {
  console.error('Ошибка при запуске бота:', err);
});

// Обработка завершения работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM')); 